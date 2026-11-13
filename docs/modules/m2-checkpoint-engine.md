# 模块文档：M2 检查点引擎

第二版，2026-11-13。第一版之后吸收评审 r1（`docs/reviews/architecture-v5/r1-review.md`）：关卡与接受绑定候选提交；调用结果按调用 id 隔离，写调用重开前等待旧调用结束；副作用结果与状态转移同一次原子写入；上游待确认成为接受的前置条件；一个关卡只有一个原因；新增「重新打开」。

依据：`docs/product-target.md`（R1–R5、R7、R11、R12、R15、R17、R19、R20、R27）与 `docs/functional-architecture.md` 第六版（决定 A10–A13）。本文给出单个检查点的完整「状态 × 事件」转移表、关卡走向、副作用目录和恢复规则。实现与单元测试以本文的表为准；表外的组合一律视为「事件被忽略」并记录诊断日志。

## 1. 范围

| 本模块负责 | 不负责 |
| --- | --- |
| 单个检查点的状态转移（纯函数） | 提示词拼装、会话键、权限映射（M3） |
| 项目级进度：依赖、清单展开、打回与重新打开的影响范围（纯函数） | 影子仓库的 git 调用细节（M4） |
| 副作用的定义、发件箱、幂等执行与重启重放 | 关卡首屏的渲染（M12、M13） |
| 关卡的产生与决定的校验 | 租约的获取与释放（M6，由调用副作用内部完成） |

文件：`desktop/src/project-room/checkpoint-transitions.cjs`、`project-progress.cjs`、`effect-runner.cjs`、`checkpoint-engine.cjs`。

## 2. 实例里与转移有关的字段

| 字段 | 含义 |
| --- | --- |
| `state` | 见第 3 节 |
| `seq` | 转移序号，每次转移加 1；副作用 id = `<实例 id>:<seq>:<序号>` |
| `round` | 已发起的评审轮数 |
| `roundsSinceHuman` | 自上一次人的输入（关卡决定或插话）以来的评审轮数；轮数上限按它判断 |
| `continuations` | 当前主笔会话的续跑次数；人的输入后归零 |
| `sessionGeneration` | 主笔会话代数。重入（打回、重新打开、过期后重开、换人接替）时加 1，会话键为 `project:<projectId>:cp:<checkpointId>:seat:<seatId>:<kind>:g<n>` |
| `candidate` | 当前候选提交：最近一次送审快照的提交号。本轮评审、关卡和接受都绑定它 |
| `rounds[]` | 每轮：候选提交、`rebuttal`（是否驳回轮）、各评审席位的结论与评审文件路径 |
| `activeInvocations` | 进行中的调用：副作用 id → 角色（主笔 / 草稿 / 评审）、席位、轮次、会话代数、是否可写、是否已请求取消 |
| `pendingStart` | 等可写调用全部结束后要发起的下一次调用（第 5.2 节） |
| `drafts` | 并行草稿：每个草稿席位的结果（ready / question / 失败 / 未返回） |
| `interjections[]` | 插话：内容、状态（排队 / 已交付） |
| `gate` | 待决关卡或 `null`：id、唯一的原因、绑定的候选提交、首屏内容 |
| `effects[]` | 发件箱 |

## 3. 状态

| 状态 | 含义 | 是否有进行中的调用 |
| --- | --- | --- |
| `pending` | 依赖还没有全部接受 | 否 |
| `checking` | 漂移检查中（R11） | 否（只有 git 副作用） |
| `drafting` | 并行草稿进行中 | 是，多个 |
| `leading` | 主笔这一轮进行中 | 是 |
| `submitted` | 主笔交回 `ready`，正在做送审快照与比较 | 否（只有 git 副作用） |
| `reviewing` | 评审进行中 | 是，每位评审一个 |
| `gate` | 等人；`gate` 字段非空 | 否（可能有正在结束的已取消调用，见 5.2） |
| `accepting` | 接受的副作用正在执行 | 否 |
| `accepted` | 已接受 | 否 |
| `stale` | 上游被打回或重新打开，等待上游重新接受 | 可能有正在结束的已取消调用 |

`accepted` 状态下也可以挂一个待决关卡（需求或架构文档的新版本，第 6 节），这时 `state` 保持 `accepted`，`gate` 非空。

## 4. 事件与结果的消费

### 4.1 事件

| 事件 | 来源 | 载荷 |
| --- | --- | --- |
| `DEPS_READY` | 项目级进度 | — |
| `INVOCATION_ENDED` | 调用副作用 | 副作用 id、角色、席位、轮次、会话代数；结果：`marker`（主笔与草稿为 `ready` / `question` / `continue` / 缺失；评审为 `pass` / `revise` / `needs-human` / 缺失）、`failed`（附失败分类）或 `cancelled` |
| `EFFECT_RESULT` | 其他副作用 | 副作用 id、类型、结果。具体结果见第 9 节，例如漂移检查给出 `clean` 或漂移文件列表；送审比较给出 `bodyChanged`、`newResponse`、`manifestValid`；候选核对给出 `intact` |
| `GATE_DECIDED` | 人（经 M5 校验） | 关卡 id、走向、意见、打回目标、漂移时选定的版本、是否提交到用户 git |
| `REOPEN` | 人（经 M5 校验） | 理由。只对 `accepted` 实例有效 |
| `INTERJECT` | 人 | 内容 |
| `STOP_AND_DELIVER` | 人 | — |
| `UPSTREAM_REOPENED` | 项目级进度（打回或重新打开） | 被重开的上游 |
| `UPSTREAM_GATE_CHANGED` | 项目级进度 | 某个读取过的上游的「文档新版本」关卡出现或被决定 |
| `ACCEPTED_DOC_CHANGED` | 已接受文档检测副作用 | 文件、新快照提交号、`changes.md` 头部是否齐全 |
| `RESTORED` | 启动恢复 | 发件箱里「已开始」但没有被消费的副作用 |

### 4.2 结果的隔离

- `INVOCATION_ENDED` 只有在它的副作用 id 仍在 `activeInvocations` 里时才被处理，处理后从中移除。轮次与会话代数也必须与记录一致，否则按「被忽略」处理并记录诊断日志。这样被取消的旧评审即使在新一轮里才返回，也不会被当成新一轮的结果。
- 被取消的调用仍会产生一次 `INVOCATION_ENDED`（结果通常是 `cancelled`，也可能在取消生效前已正常结束）。它的作用只有一个：把这次调用从 `activeInvocations` 中移除。它带回的标记或结论一律丢弃。
- M3 保证 `INVOCATION_ENDED` 在调用的进程已经退出、租约已经释放之后才发出。因此「`activeInvocations` 中没有可写调用」就等于「这个实例没有在写的进程」。

### 4.3 结果与转移同一次落盘

副作用执行器不单独把副作用标记为「完成」。副作用的结果作为事件送进转移函数；转移函数在同一个新实例里把这个副作用标记为已消费，并追加新的副作用；这个新实例一次原子写入项目状态文件。

崩溃发生在执行之后、落盘之前时，这个副作用在文件里仍是「待执行」或「已开始」。重启后按第 10 节处理：可以重放的副作用重新执行一遍，得到同样的结果后再消费；不能重放的调用按 R20 的规则处理。不存在「已完成但结果丢失」的状态。

唯一单独落盘的标记是「已开始」：调用和用户仓库提交在执行前先写这个标记，重启时据此判断（第 10 节）。

## 5. 转移表

记号：`→ X` 表示进入状态 X；`fx:` 是写进发件箱的副作用；`gate(原因)` 表示进入 `gate` 状态并产生关卡。下表中的调用结束事件都已经通过了 4.2 的隔离检查。

### 5.1 主表

| 当前状态 | 事件 / 条件 | 结果 |
| --- | --- | --- |
| `pending` | `DEPS_READY` | `→ checking`；fx: 漂移检查 |
| `checking` | 漂移检查 clean，有并行草稿定义 | `→ drafting`；fx: 每个草稿席位做调用前快照并调用 |
| `checking` | 漂移检查 clean，无草稿 | `→ leading`；fx: 调用前快照、调用主笔 |
| `checking` | 漂移检查发现差异 | `gate(漂移)` |
| `drafting` | 草稿 `continue`，未到续跑上限 | 留在 `drafting`；fx: 在同一会话续跑这个席位 |
| `drafting` | 草稿其他结果，仍有草稿在运行 | 留在 `drafting`，记下这个席位的结果 |
| `drafting` | 最后一个草稿结束，全部 `ready` | `→ leading`；fx: 调用前快照、调用主笔（输入包含全部草稿路径） |
| `drafting` | 最后一个草稿结束，有 `question`、缺失标记、续跑上限或失败 | `gate(草稿问题)`，列出相关席位 |
| `leading` | 主笔 `ready` | `→ submitted`；fx: 调用后快照与越界判断、送审快照、送审比较 |
| `leading` | 主笔 `continue`，未到续跑上限 | 留在 `leading`；`continuations + 1`；fx: 同一会话续跑 |
| `leading` | 主笔 `continue`，到达上限 | `gate(续跑上限)`；fx: 调用后快照与越界判断 |
| `leading` | 主笔 `question` | `gate(问题)`；fx: 调用后快照与越界判断 |
| `leading` | 主笔标记缺失 | `gate(标记缺失)`；fx: 调用后快照与越界判断 |
| `leading` | 主笔 `failed` | `gate(失败)`；fx: 调用后快照与越界判断 |
| `submitted` | 送审快照完成 | `candidate` 记为这次快照的提交号 |
| `submitted` | 有排队的插话 | `→ leading`，交付插话（第 7 节），不发起评审 |
| `submitted` | `manifestValid = false` | `gate(清单无效)` |
| `submitted` | 首轮，或 `bodyChanged` | `→ reviewing`；`round + 1`，`roundsSinceHuman + 1`；fx: 并行调用各评审席位，提示词写明候选提交号 |
| `submitted` | 正文未变，`newResponse` | `→ reviewing`，本轮标为驳回轮；`round + 1`，`roundsSinceHuman + 1`；fx: 调用评审（提示词说明正文未改、主笔驳回） |
| `submitted` | 正文未变，无新回应 | `gate(产物未变)` |
| `reviewing` | 某位评审 `needs-human`、缺失或 `failed` | `gate(需要人 / 评审失败)`；fx: 取消本轮其余评审（只读，不必等待结束）；fx: 写入已返回的评审文件 |
| `reviewing` | 某位评审返回，仍有评审未返回 | 留在 `reviewing`；fx: 写入这份评审文件 |
| `reviewing` | 最后一位返回，存在 `revise`，驳回轮 | `gate(驳回未获接受)`；`revise` 在驳回轮里按 `needs-human` 处理 |
| `reviewing` | 最后一位返回，存在 `revise`，普通轮，有排队插话 | `→ leading`，交付插话与评审文件 |
| `reviewing` | 最后一位返回，存在 `revise`，普通轮，`roundsSinceHuman` 到达上限 | `gate(轮数上限)` |
| `reviewing` | 最后一位返回，存在 `revise`，普通轮，未到上限 | `→ leading`；fx: 调用前快照、在同一会话调用主笔，输入加上本轮评审文件 |
| `reviewing` | 最后一位返回，全部 `pass` | 留在 `reviewing`；fx: 候选核对（工作目录的目标文件是否仍等于 `candidate`） |
| `reviewing` | 候选核对完成，有排队插话 | 作废这次 `pass`，`→ leading`，交付插话 |
| `reviewing` | 候选核对完成，硬关卡 | `gate(硬关卡通过)` |
| `reviewing` | 候选核对完成，软关卡，存在第 8 节的任一条件 | `gate(硬关卡通过)`，首屏列出原因 |
| `reviewing` | 候选核对完成，软关卡，无第 8 节的条件 | `→ accepting`；fx: 第 9 节的接受副作用 |
| `gate` | `GATE_DECIDED` | 见第 6 节 |
| `accepting` | 接受提交完成 | `→ accepted`；记下 `ArtifactVersion`（提交号来自 `candidate`）；通知项目级进度 |
| `accepted` | `ACCEPTED_DOC_CHANGED`，需求或功能架构文档 | 保持 `accepted`，产生 `gate(文档新版本)`；已有同原因的待决关卡时，用新快照刷新它，不另开 |
| `accepted` | `ACCEPTED_DOC_CHANGED`，其他文档 | 保持 `accepted`；fx: 把新快照记为 `ArtifactVersion`（来源：实施中调整）；变更进入下一个关卡的摘要 |
| `accepted` | `REOPEN` | 待决关卡（如有）作废并记入决策；`sessionGeneration + 1`，`→ checking`，理由作为主笔输入；项目级进度向依赖它的实例发 `UPSTREAM_REOPENED` |
| `pending`、`checking`、`submitted`、`gate`、`accepted` | `UPSTREAM_REOPENED` | `→ stale`；待决关卡作废并记入决策（原因：上游重开） |
| `drafting`、`leading`、`reviewing` | `UPSTREAM_REOPENED` | `→ stale`；fx: 取消进行中的调用（已取消的调用仍留在 `activeInvocations`，直到它的结束事件到达） |
| `accepting` | `UPSTREAM_REOPENED` | 记下标记；接受提交完成后直接 `→ stale` |
| `stale` | `DEPS_READY`，`activeInvocations` 中没有可写调用 | `sessionGeneration + 1`，`→ checking`；主笔输入包含上游的变化与决策记录 |
| `stale` | `DEPS_READY`，仍有可写调用在结束中 | 记下 `pendingStart`；最后一个可写调用结束时再执行上一行 |
| 任意 | `RESTORED` | 见第 10 节 |
| 任意 | `UPSTREAM_GATE_CHANGED` | 只刷新关卡首屏的「上游待确认」信号与接受按钮的可用性，不改变状态 |

### 5.2 取消与重开写调用

一个实例同一时刻只能有一个可写调用在运行。凡是要发起新的可写调用（主笔或可写草稿）、而 `activeInvocations` 中还有已请求取消、尚未结束的可写调用时，引擎不立即发起，而是把要发起的调用记进 `pendingStart`。最后一个可写调用的 `INVOCATION_ENDED` 到达时，再发起 `pendingStart`。

只读的评审调用不受这条限制：取消后可以立即进入下一个状态，晚到的结果由 4.2 的隔离规则丢弃。

## 6. 关卡：原因与走向

**一个关卡只有一个原因，不合并。** 按第 5 节的表，每个原因都产生在没有其他待决关卡的时刻：

- 进入 `gate` 状态的转移，都从没有关卡的状态出发。
- `accepted` 上的「文档新版本」关卡只有一种原因；再出现新版本时刷新这个关卡，而不是新增。
- 「恢复」只来自已开始的可写调用，而实例处于 `gate` 时没有正在运行的可写调用。
- 越界条目、上游待确认、候选被改动是关卡上的信号或接受的前置条件，不是关卡原因。

如果实现中出现了第二个原因（违反上述不变量），引擎拒绝这次转移，记录诊断日志，保留原有关卡。测试覆盖这条不变量。

| 原因 | `continue`（继续改，意见必填） | `accept`（接受） | `reject-upstream`（打回） |
| --- | --- | --- | --- |
| 文档新版本（在 `accepted` 实例上） | 等同 `REOPEN`，意见作为理由 | 新版本生效：fx 记 `ArtifactVersion`（来源：实施中调整），通知读取过它的下游，不标过期 | 打回到所选上游 |
| 漂移 | 不可用 | 必须选定版本：选工作目录版本 → fx 把它记为上游的新 `ArtifactVersion`（来源：漂移确认）；选已接受版本 → fx 从影子仓库恢复这些文件。然后回到 `checking` | 可用 |
| 失败 | 重试：`→ leading`；席位若已换 Agent，`sessionGeneration + 1` | 把当前文件当作送审：`→ submitted` | 可用 |
| 恢复（第 10 节） | 在同一会话续跑：`→ leading` | 把当前文件当作送审：`→ submitted` | 可用 |
| 问题、草稿问题 | 意见作为回答：`→ leading` 或 `→ drafting`（只重跑相关席位），同一会话 | 不可用 | 可用 |
| 续跑上限、标记缺失 | `continuations` 归零，`→ leading`，同一会话 | 把当前文件当作送审：`→ submitted` | 可用 |
| 清单无效 | `→ leading`，意见交给主笔 | 不可用（清单必须通过校验才能展开后续检查点） | 可用 |
| 需要人、评审失败、驳回未获接受、轮数上限、产物未变、硬关卡通过 | `→ leading`，同一会话；输入加上意见和本轮全部评审文件 | `→ accepting`，接受的是 `candidate`；没有全体 `pass` 时记为「接受现状」 | 可用 |

### 6.1 接受的前置条件

M5 收到接受决定时先在 main 里校验，转移函数再校验一次；任一条件不满足，决定被拒绝，关卡保持待决，界面说明原因。

1. 关卡仍是待决状态，关卡 id 与提交的一致。
2. **本检查点读取过的上游没有待决的「文档新版本」关卡。** 不提供强制接受：先处理上游的关卡，这个关卡的接受按钮随后自动可用（`UPSTREAM_GATE_CHANGED`）。
3. 对绑定了候选提交的原因：接受的是 `candidate`，而不是工作目录的当前内容。如果工作目录里的目标文件已经不等于 `candidate`（例如项目内另一个群聊改了它），M5 先把差异告诉人，人可以：
   - 仍然接受候选版本。工作目录里的改动不进入这次接受，下游开始前的漂移检查会把它作为漂移交给人。
   - 选「以当前文件重新送审」，这是 `continue` 的一个变体：意见可以为空，不调用主笔，直接 `→ submitted`，以当前文件做新的送审快照并重新评审，算人的输入。

### 6.2 所有走向的共同规则

- 关卡上的任何决定都算人的输入：`roundsSinceHuman`、`continuations` 归零，排队的插话随意见一并交付。
- 决定记入 `decisions.md`（fx：追加决策）：走向、意见、关卡原因、候选提交号、引用的评审文件。
- 打回：renderer 在提交前调用 `project:previewReject(projectId, checkpointId, upstreamId)`，项目级进度返回会被标为过期的实例，以及会被取消的进行中调用；提交后，目标上游按 `REOPEN` 处理（意见作为理由），依赖它的实例（包括本实例）收到 `UPSTREAM_REOPENED`。

### 6.3 重新打开

已接受的检查点（包括最终评审）可以由人直接重新打开，不需要等后续关卡：renderer 调用 `project:previewReopen(projectId, checkpointId)` 展示影响预览，再提交 `project:reopen(projectId, checkpointId, reason)`，理由必填。之后的处理与打回相同，这是对需求里「任何关卡都可以打回」的补充：没有后续关卡时，也有入口可以回到上游。

## 7. 插话

| 当前状态 | `INTERJECT` | `STOP_AND_DELIVER` |
| --- | --- | --- |
| `leading`、`drafting` | 排队；下一次调用主笔时交付 | fx: 取消当前调用；把「交付插话」记进 `pendingStart`，按 5.2 等旧调用结束后在同一会话发起 |
| `submitted` | 排队；按第 5 节，不发起评审，直接 `→ leading` 交付 | 同左 |
| `reviewing` | 排队；本轮评审照常结束，除 `needs-human` 外一律 `→ leading` 交付，本轮 `pass` 作废 | fx: 取消本轮评审；立即 `→ leading` 交付（评审只读，不必等待） |
| `gate` | 不接受；renderer 把文字作为关卡意见 | 不接受 |
| `pending`、`checking` | 排队；第一次调用主笔时交付 | 不接受 |
| `accepting`、`accepted`、`stale` | 不接受；界面提供「重新打开」入口 | 不接受 |

插话和关卡意见都按目标实例 id 提交（M13 第 6 节）。目标实例的状态已经变化、这类输入不再被接受时，main 拒绝提交并返回原因，renderer 保留用户写下的文字，不自动改投其他目标。

交付插话也算人的输入：`roundsSinceHuman`、`continuations` 归零。

## 8. 阻止自动接受的条件

软关卡的全体 `pass` 在下面任一条件成立时转为硬关卡，首屏列出原因：

- 有未处理的越界条目（M6）。越界条目不打断流程，只阻止自动接受。条目存在项目级列表里；人在任何一个关卡上处理（接受即保留这些改动），所有引用它的实例同时视为已处理。
- 本检查点读取过的某个上游有待决的「文档新版本」关卡。这一条同时是人工接受的前置条件（6.1）。
- 候选核对发现工作目录的目标文件已经不等于 `candidate`。
- 这一轮期间检测到其他已接受文档的变化，但 `changes.md` 头部缺失。

## 9. 副作用目录

| 副作用 | 做什么 | 幂等方式 | 结果 |
| --- | --- | --- | --- |
| `drift-check` | 对每个上游的已接受提交做 `git diff --quiet -- <文件>` | 只读，可重放 | `clean` 或漂移文件列表 |
| `snapshot` | 调用前、调用后、送审快照（M4） | 引用 `refs/meldwork/effects/<id>` | 提交号 |
| `evaluate-submission` | 与上一轮送审快照比较目标文件；检查 `r<n>-response.md` 是否存在且在本次快照里有变化；校验清单 | 只读，可重放 | `bodyChanged`、`newResponse`、`manifestValid` |
| `verify-candidate` | 工作目录的目标文件是否仍等于 `candidate` | 只读，可重放 | `intact` |
| `invoke-lead`、`invoke-draft`、`invoke-reviewer` | 经 M3 调用 | 开始前标记「已开始」；运行 id 由副作用 id 得出 | `INVOCATION_ENDED` |
| `cancel-invocation` | 用现有停止机制结束调用 | 调用已结束时无操作 | 无（结束由原调用的 `INVOCATION_ENDED` 体现） |
| `write-review-file` | 平台把评审者的最终回答写入 `meldwork/reviews/<检查点>/r<n>-<席位>.md` | 覆盖写同样的内容；这个路径只有平台写，不申请租约 | — |
| `detect-accepted-changes` | 每次可写调用结束后，比较各已接受文档与工作目录 | 只读，可重放 | `ACCEPTED_DOC_CHANGED`（发给文档所属的实例） |
| `append-decision`、`stamp-changes` | 追加 `decisions.md`；给 `changes.md` 头部补 `to=` | 隐藏标记 `<!-- meldwork:<副作用 id> -->` | — |
| `accept-commit` | 影子仓库的接受提交。树以 `candidate` 为基础，再叠加平台管理的记录文件（本检查点的评审与回应文件、`decisions.md`、`changes.md`）的当前内容；不读工作目录里的目标文件 | 引用 `refs/meldwork/effects/<id>` | 提交号 |
| `restore-files` | 从影子仓库的已接受提交恢复指定文件到工作目录 | 恢复成同样的内容 | — |
| `user-git-commit` | 提交到用户仓库，规则见架构 M4 | 至多一次（见架构 M2） | 成功，或跳过并附原因 |
| `drop-snapshot-refs` | 关卡决定后删除前后快照引用 | 引用不存在时无操作 | — |
| `notify` | 系统通知 | 尽力而为，不重放 | — |

接受时副作用的顺序：`append-decision` → `stamp-changes` → `accept-commit` → `user-git-commit`（如勾选）→ `drop-snapshot-refs` → `notify`。`decisions.md` 先写，才能进入同一次接受提交。

## 10. 重启恢复

启动时，引擎读取每个项目的状态文件，对每个实例：

1. 发件箱里「待执行」的副作用按顺序重放（`notify` 除外），结果按 4.3 消费。
2. 「已开始」的调用副作用：原进程已经不存在，从 `activeInvocations` 中移除。
   - 只读调用（评审、只读草稿）：以新的副作用 id 重新发起，归入原轮次。
   - 可写调用（主笔、可写草稿）：不重放，产生 `gate(恢复)`，首屏说明中断时间和当时的调用。
   - 已请求取消的调用：直接移除；如果有 `pendingStart`，按 5.2 发起。
3. 「已开始」的 `user-git-commit`：按架构 M2 的尾注规则核对。
4. 待决关卡原样保留。
5. 状态文件的模式版本低于当前版本时先迁移；迁移失败的项目只读打开，并在界面上说明。

## 11. 测试要求

- 转移表穷举：对每个状态 × 每个事件生成用例，表里的组合断言结果状态与副作用列表，表外的组合断言「忽略」。
- 不变量（性质测试）：
  - 任何时刻每个实例最多一个待决关卡、一个原因；最多一个进行中的可写调用。
  - 只有全体 `pass` 或人的 `accept` 能进入 `accepting`；已接受版本的提交树中，目标文件等于 `candidate`。
  - 上游有待决的「文档新版本」关卡时，下游不能进入 `accepting`。
  - 正文未变时，不可能连续两轮都送审（驳回轮之后只能 `pass` 或进关卡）。
  - 不经过人的输入，`roundsSinceHuman` 不超过轮数上限、`continuations` 不超过续跑上限。
  - 副作用 id 不在 `activeInvocations` 中的 `INVOCATION_ENDED` 不改变状态。
- 时序：取消评审后立即开始新一轮，再让旧评审返回，断言新一轮不受影响；取消主笔后旧进程延迟结束，断言新的主笔调用在它结束之后才发起。
- 发件箱：在每个副作用执行前后、以及结果落盘前注入崩溃，重启后断言影子仓库、项目状态、`decisions.md` 三者一致，没有实例停在 `submitted` 或 `accepting`，用户仓库至多一次提交。

## 12. 留给其他模块文档的问题

- 驳回轮评审者提示词的具体措辞（M3）。
- 快照的时长与体积上限（M4）。
- 关卡首屏的字段与布局（M5、M13）。
