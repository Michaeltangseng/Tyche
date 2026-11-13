# 功能架构：项目室

初稿第四版，2026-11-13（第三版吸收一轮外部评审；第四版补入席位侧写和关卡的三种走向，并修正 `changes.md` 头部、软关卡接受顺序、评审会话保存、Claude/Codex 的当前通道）。依据：`docs/product-target.md`（需求定稿，条目编号 R1–R30）与源码核实。本文回答「由哪些模块组成、各管什么、怎么接到现有代码上、改哪些现有边界」。每个模块后面有一份模块文档；分期交付写在实施计划里。

## 1. 总体结构

```
┌────────────────────────── Renderer（Vue） ──────────────────────────┐
│ 侧边栏：项目室 ▸ 群聊      群聊头部：成员头像 / 席位配置            │
│ 检查点进度   关卡面板      目录树 / 预览 / diff     完整轨迹面板    │
└───────────────┬───────────── preload：窄 IPC ──────────────────────┘
                │ project:* / workdir:* / trace:* / 现有 local-workspace:*
┌───────────────┴──────────────── Main ───────────────────────────────┐
│ M2 检查点引擎（XState 状态机） ── M1 项目室存储                     │
│   │        │            │                                           │
│   │        │            └─ M5 关卡（复用 Human Gate 存储）          │
│   │        └─ M4 产物与版本（影子 git 仓库、diff、过期传播、记录文件）│
│   └─ M3 席位调用适配 ── 现有 invokeAgent ── ACP（优先）/ print 回退  │
│                  └─ M6 写入协调（复用调度器租约）                    │
│ M7 完整轨迹（轨迹存储 + 分页）   M8 工作目录浏览   M9 组队   M10 用量 │
└──────────────────────────────────────────────────────────────────────┘
```

核心思路：

- 项目室是 main 进程里的一层新协调器，目录 `desktop/src/project-room/`。它不扩展 `LocalWorkspaceAutoRunner`（V2/V3/V4 的执行器），只通过现有的单 Agent 调用入口 `LocalWorkspace.invokeAgent`（`desktop/src/workspace/local-workspace.cjs:2895`）驱动 Agent。Agent 的进程、会话恢复、事件、Run Ledger、失败分类全部沿用现有链路。
- 状态机只读四类输入：主笔与评审的结尾标记、人的关卡走向（继续改 / 接受 / 打回）及其自由文本、相对影子仓库某次提交的 `git diff`、已确认的检查点清单（R2）。它不调用模型，不解析自由文本，也不另算一份内容哈希。
- 文件是 Agent 之间唯一的共享真源（R9）；完整轨迹只给人看（R21）。

## 2. 关键架构决定

| # | 决定 | 理由 | 替代方案及放弃原因 |
| --- | --- | --- | --- |
| A1 | 项目室作为独立协调器，经 `invokeAgent` 调用 Agent | 复用调用链约 1,400 行的成熟逻辑；不碰 V4 执行器（约 8,000 行） | 扩展自动讨论执行器：耦合 V4 回执与阶段，违背 agent for agent |
| A2 | 轻量项目元数据放 `meldwork-workspace.json`，引擎状态放独立私有存储 | 工作区文件每次保存整体重写；引擎状态和版本记录会持续增长 | 全放工作区文件：写放大；全放私有存储：侧边栏快照要跨两个来源拼装 |
| A3 | 原生会话键加入「项目、检查点、席位」 | 同种 Agent 多席位需要独立会话（R16）；新检查点要新会话（R10） | 每个席位一个合成群聊：污染侧边栏与消息存储 |
| A4 | 已接受版本 = 影子 git 仓库中的提交（参考 Cline checkpoints）：仓库放在应用私有区，通过 `core.worktree` 指向项目工作目录 | 快照、diff、删除识别、忽略规则、大文件全部由 git 提供；不碰用户的 `.git`（R25）；非 git 目录同样可用 | 自研哈希清单 + 内容寻址快照 + diff 库：重复造 git；写用户的 `.git` 或 `refs/meldwork/*`：违背 R25 |
| A5 | 写入协调 = 按目标文件的建议性租约 + 轮后变更检测 | CLI 沙箱以整个工作目录为单位，无法在进程层面限制到单个文件；能做到的诚实保证是「排队 + 事后发现越界并叫人」 | 为每个席位复制工作树：Agent 失去完整上下文，违背 agent for agent |
| A6 | 关卡复用 Human Gate 存储，增加「项目检查点」作为拥有者，不用内存等待者 | 现有存储、确定性 ID、选项与决定校验都可用；决定经已有的孤儿决定路径回调引擎即可跨重启 | 新建关卡存储：重复约 700 行 |
| A7 | 完整轨迹走独立通道：main 写入经脱敏的追加日志，renderer 分页拉取 | 现有摘要通道带多层截断，且被 Run Ledger 与证据胶囊依赖；另开通道不破坏它们 | 直接放宽现有通道的上限：会撑大 Run Ledger 与消息存储 |
| A8 | 结尾标记沿用现有回执语法 `[[MELDWORK_…:{json}]]`，新建独立解析模块 | 流式隐藏（`answer-marker-filter.cjs`）可直接复用；不扩展 V4 白名单，避免与 V4 耦合 | 扩展 `collaboration-receipt.cjs` 的 V4 阶段：把项目室绑进 V4 记录 |
| A9 | Agent 接入以 ACP 为主通道，现有 print/exec 适配作为回退。Claude 与 Codex 在实测通过之前，主通道仍是现有的 print / exec | ACP 的工具调用事件自带结构化完整内容（M7）；每次工具调用都经客户端审批，权限可以在一处统一实现（M3）；进程常驻，可在一轮中取消，适合长时间运行（R20）；Meldwork 已有成熟的 ACP 运行器 | 为每个 CLI 分别补完整轨迹映射和权限参数：工作量随 Agent 数量增长 |
| A10 | 单个检查点内部用 XState v5 状态机；项目级进度是 M1 里的检查点实例加依赖，每个实例运行一个 actor | 检查点内部的图是固定的，适合状态机；模块文档和里程碑的数量来自运行时确认的清单，不适合预先展开成一张静态大图。XState 为 MIT、零依赖，提供 CommonJS 构建（`dist/xstate.cjs.js`），主进程可以直接 `require` | 手写转移表：要自己做持久化、校验和可视化；LangGraph.js：为 LLM 图设计，恢复时节点重跑、依赖较重；Temporal：需要服务进程，违背本地优先；Bernstein 等编排器：细粒度任务图，违背 agent for agent |

## 3. 模块

### M1 项目室存储

管什么：项目实体、席位、playbook 实例、检查点进度、产物版本索引、决策与插话队列。（R16、R19、R23）

- 工作区文件新增 `projects: [{ id, name, workdir, createdAt, updatedAt }]`；群聊新增可选的 `projectId`。需要修改的白名单：`local-workspace-state.cjs:224-244` 加载路径、`local-workspace-message-records.cjs` 的 `emptyState` 与 `normalizeLoadedGroup`、`createGroup`、`workspaceSnapshot`（`local-workspace-state.cjs:428-456`）、renderer 的 `desktop-snapshot.js:367-376`。版本号升到 4，加载时接受 1–4。
- 引擎状态存 `meldwork-private/projects/<projectId>.json`，按 `human-gate-store.cjs` 的模式实现：单文件、经 `atomicWritePrivateFile` 原子写入、`0600`、有大小上限。
- 产物快照存进 M4 的影子 git 仓库，引擎状态只保存提交号。
- 一个工作目录只对应一个项目室：创建时按真实路径（realpath）判重（R23）。
- 删除项目室：删除引擎状态、影子 git 仓库和轨迹文件，其群聊变为普通群聊或一并删除（由用户选择）；不删除工作目录里的文件。
- 默认 playbook 以数据形式内置：需求文档里的九个检查点、默认软硬关卡（需求、架构、实施计划、每个里程碑、最终评审为硬关卡）、评审轮数上限 3、续跑上限。每个默认角色带一份侧写，不是空的。

主要记录（字段在模块文档里定）：

| 记录 | 要点 |
| --- | --- |
| Project | id、名称、工作目录、文档根目录（默认 `meldwork/`）、席位列表、playbook 实例、主流程群聊 id |
| Seat | id、角色名、职责、Agent 种类、侧写、能力集合（读 / 写草稿区 / 写工作目录 / 运行命令）、参与的检查点。侧写与席位一起保存，带版本，可回退（R16、R29）。更换 Agent 种类不改侧写。同一种 Agent 的两个席位各有一份侧写 |
| Playbook | id、版本、检查点定义列表；可保存为模板（R17、R29）。默认侧写改写自 BMAD-METHOD 的角色人设，平台立场提示词和文档模板改写自 BMAD-METHOD 与 Spec Kit（均为 MIT；不使用 BMAD 商标）。立场提示词只管流程，侧写原样叠加上去 |
| CheckpointDef | key、类型（访谈 / 调研 / 文档 / 就绪检查 / 里程碑 / 最终评审 / 复盘）、目标文件、主笔席位、评审席位、并行草稿席位、关卡软硬、评审轮数上限、续跑次数上限、是否产出清单、依赖的上游检查点 |
| CheckpointInstance | 状态、轮次、续跑次数、主笔会话键、评审文件列表、当前关卡、已接受版本、读取过的上游版本、过期标记。这是跨版本可恢复的记录，XState 快照只是它的缓存 |
| ArtifactVersion | 影子仓库提交号、涉及的文件、接受时间、来源（关卡 / 软关卡 / 实施中调整）、对应决策 |
| Decision | 决定、理由、谁定的、引用的评审文件；同时追加到 `decisions.md` |
| Interjection | 内容、目标检查点、状态（排队 / 已交付） |

### M2 检查点引擎

管什么：按 playbook 推进检查点，决定下一步谁做什么、何时叫人。（R1–R5、R12、R15、R19、R20）

- 由三部分组成（决定 A10）：
  - `checkpoint-machine.cjs`：用 XState v5 定义单个检查点的状态机（下图）。它只描述状态、守卫与动作名称，不直接调用 Agent，单元测试覆盖每条转移。
  - `project-progress.cjs`：项目级进度，不是状态机，而是 M1 里的检查点实例加依赖关系。它决定哪些实例可以开始；清单确认后新增实例；每个运行中的实例对应一个 actor。
  - `checkpoint-engine.cjs`：执行动作（调用 M3、开 M5 关卡、写 M4 版本），把结果作为事件送回对应的 actor。
- 持久化分主次：`CheckpointInstance`（M1）是唯一的权威记录，每次转移后写入。XState 的持久化快照与状态机定义绑定，只在同一个应用版本内用于加速恢复；应用升级后，按 `CheckpointInstance` 重建 actor。
- 进行中的 Agent 调用不属于状态机快照。重启恢复时，处于「调用中」状态的检查点按 R20 处理：只读调用重新发起，可写调用转为关卡。
- 同一项目室同一时刻可以有多个检查点在运行（并行模块文档），但每个检查点内部严格串行。

检查点状态：

```
pending → drafting（并行草稿，可选）→ leading → reviewing ─┬─ pass ─ 软关卡 → accepted
                                        ↑                   ├─ pass ─ 硬关卡 → gate
                                        └──── revise ───────┤
                                                            └─ needs-human / 上限 / 产物未变 → gate
gate ─ 接受 → accepted ─（上游被打回）→ stale → leading
     ─ 继续改 → leading
     ─ 打回（指定上游）→ 该上游重新 leading，其下游标为 stale
leading ─ question → gate（问题）─ 回答 → leading（同一会话）
        ─ continue → leading（同一会话，续跑次数 +1，到上限 → gate）
        ─ 失败 → gate（失败：重试 / 换人接替）
```

事件来源：主笔结尾标记、评审结尾标记、Agent 调用失败、人的关卡选择、人的插话、已接受的需求或架构文档出现新版本、工作目录与已接受版本不一致（R11）。

其他规则：

- 评审轮次：每个评审席位一次独立调用。多位评审时，任一 `needs-human` 即进入关卡，同一轮里还在运行的评审调用被停止，晚到的结论丢弃；全部 `pass` 才算通过；其余情况按 `revise`。
- 产物未变：评审给 `revise` 后，主笔交回 `ready`，但对上一轮送审时的影子快照做 `git diff --quiet -- <目标文件>`，没有差异 → 关卡（R5）。比较范围只包括目标文件。
- 检查点清单（R4）：主笔把清单写成 `meldwork/checklists/<检查点>.json`；引擎按模式校验，校验失败按需要人处理；人在硬关卡上接受后生成后续检查点实例。
- 打回（R15）：从关卡上选择一个上游检查点；引擎计算依赖于它的已接受检查点，先在关卡上展示影响预览，确认后标为过期。过期检查点在上游重新接受后依次重新进入 `leading`，主笔的输入包括上游的变化和决策记录。
- 实施中调整文档（R12）：每次主笔或其他群聊的调用结束后，M4 检测已接受文档是否变化。变化即形成新版本。
  - `changes.md` 的每条记录有一行机器可读的头部。主笔写文件时只写路径和上一份已接受提交，例如 `- [path=docs/requirements.md from=<上一份已接受提交>]`，说明文字写在下面。上一份提交号由平台放进提示词。M4 形成新版本时把 `to=<新提交>` 补进这一行。平台只核对这个路径有一条新的头部。
  - 需求文档或功能架构发生变化：无论记录是否齐全，立即开关卡；记录缺失时在关卡上标出。
  - 其他文档发生变化：列入下一个关卡的摘要；记录缺失时一并标出，不单独开关卡。
- 插话（R17）：主笔一轮进行中时排队，下次调用主笔时放进提示词；人选择「停止并交付」时，用现有的停止机制结束当前一轮后立即调用。接受检查点之前（包括软关卡的自动接受），引擎先检查插话队列：有未交付的插话，则作废这一轮的 `pass`，把插话交给主笔，回到 `leading`。
- 重启（R20）：引擎状态持久化。重启时，未结束的只读调用重新发起；可写入的调用一律转为关卡，由人决定是否续跑，与现有 Run Ledger 规则一致。

### M3 席位调用适配

管什么：把「席位 + 检查点 + 输入」变成一次 `invokeAgent` 调用，并把结果变成引擎事件。（R2、R8、R10、R16、R20）

- 提示词由四层拼成：平台立场（评审立场、结尾标记约定）+ 席位侧写 + 检查点输入（目标文件、已接受上游版本、上一轮评审与回应文件、排队的插话、变更通知）+ 语言约定。侧写原样放入，平台不解析。
- 新增调用策略 `sessionPolicy: 'project-room'`。现有路径都不满足项目室：`isolated` / `frozen` 收下固定提示词，但强制只读（`local-workspace-agent-invocation.cjs:287`）；`v4: true` 可写，但会在提示词后附加 `RESPONSE_SCOPE_INSTRUCTION` 与工作偏好（`invocation-prompt.cjs`）。新策略的规则：
  - 提示词原样发送，不附加任何后缀。
  - 权限按席位能力决定，可以写入。
  - 使用调用者给出的会话键（见下）。
  - 与现有路径一样必须带合法的 `contextPackId`（`:98-115`，缺失抛 `LOCAL_RUN_ISOLATED_CONTEXT_INVALID`）。每次调用前，M3 用现有的 Context Pack 存储捕获这一次的输入（提示词、上游版本的提交号），这也是每次调用的可追溯记录。
- 结尾标记：新模块 `signal-markers.cjs`，语法与现有回执一致，例如 `[[MELDWORK_CHECKPOINT:{"signal":"ready"}]]`、`[[MELDWORK_REVIEW:{"verdict":"pass"}]]`。复用 `answer-marker-filter.cjs` 在流式输出时隐藏。缺失或无法解析 → 需要人。
- 会话（决定 A3）：
  - 主笔：键为 `project:<projectId>:cp:<checkpointId>:seat:<seatId>:<kind>`。同一检查点内的 `revise` 与 `continue` 恢复这个会话；新检查点用新键，也就是新会话。
  - 评审者：每轮一个新会话，避免被上一轮的立场锚定。`project-room` 策略下，评审调用不把会话号写入 `sessions`，要在 `onSessionRef` 和结束时的 `session.complete` 两处都跳过。现有的跳过条件只覆盖代码审查类 Agent 和 `isolated`（`local-workspace-agent-invocation.cjs:385`、`:964`、`:1371`）。Claude、Codex 做评审者不会走到那里。
  - 需要修改的位置：`resolveSessionState`（`local-workspace-context.cjs:437`）目前总是用群聊级的键，要让项目室调用使用传入的键；`sessionKey()` 的超长哈希回退（`local-workspace-context.cjs:357-371`）只包含群聊、任务和 Agent 种类，要把项目、检查点和席位也纳入哈希，否则两个席位会撞到同一个键。`canonicalConversationSessionKey`（`local-workspace.cjs:2701`）只归并 `group:task:<id>:kind` 形式的键，不影响项目室的键。
- 接入通道（决定 A9）：

| Agent | 主通道 | 来源 | 现状 |
| --- | --- | --- | --- |
| Claude | print / exec | 现有 `claude` CLI | ACP 适配器 `@agentclientprotocol/claude-agent-acp`（Apache-2.0）待实测是否沿用本机登录；通过前不切换 |
| Codex | print / exec | 现有 `codex` CLI | ACP 适配器 `@agentclientprotocol/codex-acp`（Apache-2.0）待实测；通过前不切换 |
| Gemini | ACP | 原生 `gemini --acp` | 现为 print；改为原生 ACP |
| Qwen | ACP | 原生 `qwen --acp` | 现为 print；改为原生 ACP |
| Pi | ACP | 社区适配器 `pi-acp`（版本 0.0.x，较早期） | 现为 print；实测后再切换，不稳定则保留 print |
| DeepSeek、Hermes、Kimi、MiMo、OpenCode | ACP | 已在用 | 不变 |
| OpenClaw | ACP（每轮起停） | 已在用 | 不变 |
| WorkBuddy、ZCode 等 | print / exec | 无 ACP | 保留现有适配作为回退 |

  - 适配器是外部 npm 包，由安装器按固定包名安装，与现有的安装器策略一致；版本固定，升级经过测试。
  - 每种 Agent 记录能力：完整轨迹、`read-exec`、一轮中取消、用量。席位配置界面按能力提示，例如某个回退通道的 Agent 无法提供完整工具输出。
- 能力到权限的映射：现在只有 `read-only` 与 `workspace-write` 两种模式（`agent-runtime-contract.cjs:31`）。新增第三种模式 `read-exec`（能运行命令、不改文件），需要修改运行时约定和调度器的模式校验（`run-scheduler.cjs:143`）。
  - ACP 通道：在自动审批策略（`agent-permission-policy.cjs`）中实现：批准读取与执行类工具，拒绝编辑与写入类工具。一处实现，所有 ACP Agent 生效。
  - 回退通道：逐个 CLI 设置参数。例如 Claude 的 print 模式可以用 `--disallowedTools Edit Write` 加 `--allowedTools` 放行读取与命令（注意不能在禁止列表里写任何 Bash 规则，否则整个 Bash 被移除）。
  - 不能表达的组合，在席位配置界面提示，不静默降级或放宽（R16）。
- 「写草稿区」能力在 CLI 层就是 `workspace-write`，限制由 M6 的轮后检测保证。
- 看门狗：调用上下文新增 `watchdog` 选项（读取位置 `local-workspace-agent-invocation.cjs:636`）。项目室的主笔调用使用「提醒不中止」策略：无活动超时只发提醒事件和系统通知，由人停止或继续；`cli-adapters.cjs:396-399` 的 2 小时硬上限也改为可按调用覆盖（R20）。
- 评审文件：评审者保持只读；它这一轮的最终回答由平台写入 `meldwork/reviews/<检查点>/r<轮次>-<席位>.md`（R9）。主笔的回应由主笔自己写入 `r<轮次>-response.md`，作为它目标文件的一部分。

### M4 产物与版本

管什么：快照、哈希、diff、漂移检查、过期传播所需的依赖、`decisions.md` 与 `changes.md`。（R10–R15、R25）

- 影子 git 仓库（决定 A4，参考 Cline 的 checkpoints 实现）：
  - 每个项目室一个仓库，放在 `meldwork-private/projects/<projectId>/shadow.git`，设置 `core.worktree` 为项目工作目录。用户自己的 `.git` 不受影响。
  - 已接受版本：接受时在影子仓库提交，提交说明记录检查点与决策。文档类检查点提交目标文件，以及这个检查点的评审文件、回应文件、`decisions.md`、`changes.md`；里程碑提交整个工作目录。
  - 轮后检测（M6 使用）：文档类检查点只对声明的目标文件和 `meldwork/` 目录做前后快照；里程碑和项目内群聊的可写调用对整个工作目录做前后快照，单次快照超过时长或体积上限时，跳过检测并在关卡上说明，不阻塞流程。上限在模块文档中定。前后快照的提交不写入 `ArtifactVersion`。已接受版本只认接受时记下的提交号。
  - 必须写死的不变量（保护用户的仓库，R25）：
    - 影子仓库的每一次 git 调用都显式带上 `--git-dir=<影子仓库>` 与 `--work-tree=<项目工作目录>`，由封装函数生成参数。写入用户自己的仓库走另一个入口，见下。其他代码不得直接调用 git。
    - 不执行任何钩子（`-c core.hooksPath=/dev/null`）；提交身份用 `-c user.name=… -c user.email=…` 传入，不读也不改用户的全局 git 配置。
    - 排除规则写在影子仓库的 `info/exclude`（默认 `.git`、`node_modules` 以及用户仓库中的 Git LFS 模式），同时读取工作目录的 `.gitignore`，但不修改它。
    - 以固定参数调用 `git` 可执行文件，不经过 shell。
    - 本机没有 `git` 时，创建项目室失败并说明原因。
- diff：影子仓库的 `git diff` 生成统一 diff，main 解析后交给 renderer；renderer 用 `@git-diff-view/vue`（MIT）展示。
- 用户自己仓库的提交（R25）使用用户自己的 `.git`，不带影子仓库的 `--git-dir`。只在人接受时勾选「同时提交到 git」，且工作目录本身是 git 仓库时出现。只 `git add` 本次接受的路径，然后提交，不执行 `git add .`。
- 漂移检查（R11）：检查点开始前，对上游已接受提交做 `git diff --quiet -- <文件>`。工作目录里的文件有差异 → 关卡，人决定以哪一版为准。
- 记录文件：`decisions.md` 由平台追加（来源是关卡上的走向和自由文本）；`changes.md` 由修改文档的 Agent 写头部和说明，平台补上新提交号，并只核对头部。
- 依赖：每个检查点实例记录它读取过的上游版本，打回时据此计算影响范围。

### M5 关卡

管什么：项目室的所有等人时刻：硬关卡、问题、失败、漂移、需求或架构新版本、打回确认。（R5、R6、R15、R27、R28）

- 存储（决定 A6）：在 `human-gate-records.cjs` 中增加拥有者字段 `{ ownerKind: 'project-checkpoint', projectId, checkpointId }`；有拥有者时 `runId`、`agentRunId` 可以为空。现有的运行类关卡不变。
- 不使用内存等待者：引擎直接创建记录；人的决定经现有的孤儿决定回调（`human-gate-coordinator.cjs` 的 `onOrphanDecision`）交给引擎。重启时 `reconcileOrphans` 会把无法恢复的待决关卡系统拒绝（`human-gate-coordinator.cjs:288-297`），因此 `canResume`（`local-workspace.cjs:1504`）对拥有者为项目检查点、且 M1 中对应实例仍在等待的关卡返回 `true`。
- 内容放置：记录的 `summary` 最长 500 字（`human-gate-records.cjs:44`），只放一行标题；首屏正文（评审者摘要、驳回、改动文件、批量摘要）放在 `requestRef` 指向的请求内容里。
- 人的意见是自由文本，不是一排固定按钮。现有记录只允许 `input` 类型携带 `decision.response`（`human-gate-records.cjs:81-85`）。项目关卡放开这一限制，让 `decision` 类型携带这段文字。走向只有三个选项 id：`continue`（继续改）、`accept`（接受）、`reject-upstream`（打回，并指定上游检查点）。写了意见又没有点接受时，走向是继续改。没有 `pass` 时点接受，就是接受现状，记入 `decisions.md`。「再给几轮」「换评审者」「裁决驳回」都落在这三种走向里，不另设按钮。接受时可以勾选「同时提交到 git」。
- 快照：项目关卡不依赖运行即可发布到 renderer。需要修改 `local-workspace-state.cjs:410-416` 与 `desktop-snapshot.js:349-375` 的过滤。
- 首屏内容（R6）：评审者摘要（评审文件开头的几行）、是否有驳回、改动的文件和 diff 统计、轮次、用时、软关卡批量摘要，加上意见输入框和三种走向。漂移关卡额外让人选定以哪一版为准。
- 通知（R28）：扩展 `shell/main-run-notifications.cjs`，新增项目关卡通知，点击后打开对应项目室。

### M6 写入协调

管什么：同一文件同一时刻只有一位写入者，跨群聊生效。（R7、R23）

- 租约键（决定 A5）：项目室内的可写调用不再使用按会话的键（`local-workspace-agent-invocation.cjs:278-282`），而是按目标：
  - 文档检查点：每个目标文件一个键，例如 `project:<id>:file:<相对路径>`。
  - 草稿：每个席位自己的草稿目录一个键。
  - 里程碑和项目内群聊的可写调用：整个工作目录一个键 `project:<id>:workdir`，与所有文件键互斥。
- 需要给调度器（`run-scheduler.cjs`）增加原子地同时获取多个键的能力，以及「工作目录键与文件键互斥」的层级关系。现在的键只是不透明字符串（`:22-26`），单键可以直接使用。
- 防止死锁：一次调用在开始前一次性申请它需要的全部键，运行中不追加。持有文件键的调用不能再去申请工作目录键；工作目录键要等所有文件键释放后才能获得，持有工作目录键时，文件键等待。
- 轮后检测：可写调用结束后，M4 用影子仓库比较这一轮前后的提交；改动了声明目标之外的文件 → 在关卡上列出越界的文件，由人处理。这是建议性租约的兜底，也是对「写草稿区」能力的实际保证。

### M7 完整轨迹

管什么：Agent 每一步完整可见；群聊的「运行详情」与项目室共用。（R21）

- 现状：内容在六处以上被裁剪或替换。命令一律变成 `command`（`cli-runtime-summaries.cjs:92-94`）；工具参数只剩长度和字段数（`:66-90`）；工具输出只剩行数和字节数（`:109-137`）；Codex 与 ACP 的命令显示为 `[operation hidden]`，ACP 的思考文本被丢弃（`cli-runtime-event-mappers.cjs:41-42, 442-474`）；路径与命令被改写，并有 2000/4000 字符上限（`cli-runtime-event-sanitizer.cjs:51-58, 251-259`）；harness 再截一次（`run-harness-normalization.cjs:100-119`、`run-harness.cjs:1-2`）。
- 新通道（决定 A7）：
  - ACP 通道（决定 A9）：`tool_call`、`tool_call_update`、`agent_thought_chunk` 等事件本身带有完整内容，在 ACP 运行器中统一取得，不需要为每种 Agent 写映射。Claude 与 Codex 在 ACP 实测通过之前不在此列，仍用回退通道。Meldwork 现有的 ACP 映射会丢弃思考文本、隐藏命令（`cli-runtime-event-mappers.cjs:442-474`），完整通道绕开这些处理。
  - 回退通道：在解码回调处（`cli-adapters.cjs:300-314`，映射之前）以及原始输出处（`:402-408`）取得完整内容，由各 CLI 的映射器另外产出完整字段。
  - 展示方式参考 Nimbalyst（MIT，同为 Electron）对 Claude、Codex 会话的工具调用展示。
  - 完整内容只经过密钥脱敏（`redactChildSecrets` 与 `security/secret-redaction.cjs` 的 `redactSecrets`），不做路径和命令改写，然后写入 `meldwork-private/traces/<runId>/<agentRunId>.jsonl`（追加写，`0600`）。
  - 实时事件只推送「有新内容」的通知和一个小窗口；renderer 通过新 IPC `trace:page(runId, agentRunId, cursor)` 分页读取。
  - 现有摘要通道、Run Ledger、证据胶囊保持不变，继续服务现有功能。
- 保留与上限：暂不设置（需求 R21）；删除会话时一并删除它的轨迹文件。
- 边界变更：`architecture.md` Trust Boundaries 第 6 条、Local Data 表格需要改写。可执行文件路径同样原样显示（第 6 节）。

### M8 工作目录浏览

管什么：目录树、文件预览、相对已接受版本的 diff。（R22）

- 现在没有任何文件读取或目录列举的 IPC。新增 `workdir:list(projectId, relPath)`、`workdir:read(projectId, relPath)`、`workdir:diff(projectId, relPath, against)`，通过 `registerTrustedHandle` 注册。
- 路径限制：只接受项目工作目录内的相对路径；解析真实路径后必须仍在工作目录内（拒绝指向外部的符号链接）；单次读取有大小上限，二进制文件只返回元信息。
- 目录变化：main 侧可以监听工作目录变化并推送「树已变化」，或由 renderer 在每次调用结束后刷新。取舍在模块文档里定。

### M9 组队

管什么：用户输入需求后给出团队草案与裁剪过的 playbook。（R18）

- 当前版本：组队由人工完成。新建项目室时，用户从默认 playbook 或已保存的模板出发，手动指定每个席位的 Agent、侧写和能力；现有的确定性路由（`desktop/src/agents/agent-routing.cjs`）只用来给出默认的 Agent 建议。
- 自动组队占位：保留「组队席位」接口（输入需求文本，输出结构化团队草案，经 M2 校验后交人确认），但不实现。jev 等快速模型的接入方式以后再定，到时按 provider-agnostic 原则经本机 CLI 接入。

### M10 用量

管什么：每个检查点显示用量。（R28）

- 现状：`recordReplyUsage`（`invocation-budget.cjs:17-34`）在回复带有 `outputTokens`、`costMicros` 时按上报值记录，否则按文本长度估算。缺的是从各 CLI 取得上报值。
- 来源按优先级：ACP 的 `usage_update` 事件（如 Gemini）；否则参考 ccusage（MIT）的做法，按原生会话号读取 CLI 自己写在本地的日志（例如 `~/.claude/projects/**/*.jsonl`、`~/.codex/sessions/`），取得 token 数。
- 读取 `~/.claude`、`~/.codex` 等目录时只提取用量字段，不把会话内容送进 renderer。
- 费用按公开价格估算，界面标明「估算」。拿不到 token 数的 Agent 显示「不可用」。

### M11 现有群聊模式

管什么：单次回答、并发回复、顺序讨论、自动讨论的去留。（R24）

- 规模：自动讨论执行器家族（`local-workspace-auto-runner*.cjs`，16 个文件）约 7,900 行；`orchestration-v4-records.cjs` 约 2,800 行；消息提交 `local-workspace-message-submission.cjs` 约 1,900 行。
- 架构层面的约束：项目室不依赖这些执行器；保留下来的模式与项目室共用席位配置（M1）和完整轨迹（M7）。
- 模块文档要回答：并发回复和顺序讨论能否用项目室的原语（并行草稿、写作者与评审往复）重建；V2/V3/V4 的旧记录如何只读兼容；退役哪些代码。在模块文档定稿前，现有模式保持运行、不做改动。

### M12 界面

管什么：所有项目室的界面。（R6、R22）

| 组件 | 内容 | 现有基础 |
| --- | --- | --- |
| 侧边栏 | 项目室为一级，下列群聊；普通会话保持现状 | `WorkspaceSidebar.vue` |
| 群聊头部 | 成员头像；点击打开席位配置弹层（角色、侧写、Agent、能力、增删席位） | `ConversationHeader.vue` |
| 检查点进度 | 当前检查点、主笔、轮次、在等谁、过期标记 | 新组件 |
| 关卡面板 | 首屏摘要、意见输入框、三种走向、打回时选择上游并展示影响预览 | 现有关卡按钮在 `ConversationTimelineView.vue:613-655` |
| 目录树面板 | 可折叠；预览；diff（`@git-diff-view/vue`） | 新组件 |
| 完整轨迹面板 | 按步骤展示、分页加载、原始输出视图 | `RunTracePanel.vue`、`useRunTracePanel.js` |
| playbook 与模板编辑 | 检查点、软硬关卡、轮数上限 | 新组件 |

- 状态管理沿用现有的 composable 模式（`frontend/src/composables/`），新增 `useProjectRoom.js`、`useWorkdirTree.js`。
- 文案进入 `frontend/src/locales/zh.js` 与 `en.js`；新弹层使用 `useOverlayLifecycle.js` 处理 Escape 与背景滚动。
- 项目室的主流程在一个自动创建的「主流程」群聊里展示：主笔与评审的回复、关卡卡片都作为这个群聊的消息出现；其他群聊是普通的项目内群聊。

## 4. 主要流程

### 一个文档检查点

1. M2 检查前置条件：上游已接受、漂移检查通过（M4）。
2. 如果定义了并行草稿：M3 并行调用各草稿席位（每人一个草稿目录键），全部 `ready` 后进入主笔。
3. M6 获取目标文件的租约；M3 调用主笔（检查点会话）。
4. 主笔结束：M6 释放租约；M4 对上一轮快照做 `git diff`。`ready` → 5；`question` → M5，人的回答作为继续改的意见，回到 3；`continue` → 续跑次数加 1，未到上限回到 3，到上限进入 M5。
5. M3 调用各评审者（只读、新会话，不保存会话号）；平台写入评审文件。
6. M2 汇总结论。兑现任何 `pass` 之前先看插话队列：有未交付的插话，作废 `pass`，把插话交给主笔，回到 3。队列为空时，`revise` → 回到 3（输入加上评审文件）；`pass` 且软关卡 → 接受；`pass` 且硬关卡 → M5；`needs-human`、到达上限、产物未变 → M5。
7. 接受：M4 把这次提交写入 `ArtifactVersion`，追加 `decisions.md`；人若勾选，再提交到用户自己的仓库。M2 推进到下一个检查点，或者在清单确认后生成后续检查点。

### 实施中的文档调整

主笔在里程碑中修改了已接受的 `requirements.md` → 这一轮结束后，M4 对已接受提交做 `git diff` 发现该文件有变化 → 形成新版本并核对 `changes.md` 头部 → 因为是需求文档，M2 立即开关卡 → 人接受（版本生效，其他席位下次调用时收到变更通知），或者打回到需求检查点。

### 项目内的群聊

用户在第二个群聊里讨论某个技术问题 → 调用沿用现有的群聊路径，额外注入「项目室已接受文档清单 + 自上次以来的变化」→ 该 Agent 若改了文档，按「实施中的文档调整」处理；可写调用使用 `project:<id>:workdir` 键，与主流程的写入互斥。

## 5. 对现有代码的修改清单

| 位置 | 修改 | 风险 | 模块 |
| --- | --- | --- | --- |
| `local-workspace-state.cjs`、`local-workspace-message-records.cjs`、`desktop-snapshot.js` | 白名单加入 `projects`、`projectId`；版本升到 4 | 低；旧版本文件照常加载 | M1 |
| `local-workspace-context.cjs` 的 `resolveSessionState`、`sessionKey` | 使用调用者给出的键；哈希回退纳入项目、检查点、席位 | 中；会话迁移逻辑要有测试 | M3 |
| `local-workspace-agent-invocation.cjs`、`invocation-prompt.cjs` | 新调用策略 `project-room`：原样送入侧写、按席位权限、调用者给出的会话键、必须带 Context Pack；评审调用不写入 `sessions` | 中 | M3 |
| `agent-runtime-contract.cjs`、`run-scheduler.cjs`、`agent-permission-policy.cjs`、`cli-invocations.cjs` | 新增 `read-exec` 模式：ACP 在审批策略中实现，回退通道逐个 CLI 设置 | 中 | M3 |
| `cli-invocations.cjs`、`agent-installer.cjs`、`cli-acp-runner.cjs` | Gemini、Qwen 切换到原生 ACP；Claude、Codex、Pi 实测通过后切换；安装器加入适配器包。桌面端已依赖 `@agentclientprotocol/sdk` 0.23.0，适配器若要求更高版本需一并升级 | 高；先做实测里程碑，保留回退 | M3 |
| `local-workspace-agent-invocation.cjs:636`、`cli-adapters.cjs:396` | 按调用设置看门狗与硬上限 | 低；默认值不变 | M3 |
| `local-workspace-agent-invocation.cjs:278` | 允许调用者指定租约键 | 低 | M6 |
| `run-scheduler.cjs` | 原子获取多个键；工作目录键与文件键互斥 | 中 | M6 |
| `human-gate-records.cjs`、`local-workspace.cjs` 的 `canResume`、`local-workspace-state.cjs:410` | 拥有者字段；项目关卡允许附言；`canResume` 识别项目关卡；项目关卡不随运行发布 | 中 | M5 |
| `cli-runtime-event-mappers.cjs`、`cli-adapters.cjs`、新的轨迹存储 | 完整内容通道 | 中；不改动现有摘要通道 | M7 |
| `main-run-notifications.cjs` | 关卡通知 | 低 | M5 |
| 新的用量读取模块 | 读取 ACP 用量事件或 CLI 本地日志 | 低 | M10 |
| `preload.cjs`、`shell/main-ipc.cjs` | 新增 `project:*`、`workdir:*`、`trace:*` IPC | 中；每个方法都要做输入校验 | M1、M7、M8 |

新增依赖：`xstate`（MIT）、`@git-diff-view/vue`（MIT）、ACP 适配器 `@agentclientprotocol/claude-agent-acp`、`@agentclientprotocol/codex-acp`（Apache-2.0，由安装器安装）、可选 `pi-acp`。引入前逐个核对 LICENSE 与维护状态。

新增目录：`desktop/src/project-room/`（M1–M6、M9）、`desktop/src/runs/trace-store.cjs`（M7）、`desktop/src/shell/project-ipc.cjs`、`desktop/src/shell/workdir-ipc.cjs`（M8）。每个新模块在 `desktop/test/` 下有同名测试（node 测试脚本）；前端测试用 vitest，放在 `frontend/src/__tests__/meldwork/`。

## 6. 信任边界与产品边界的变更

| 现有规则 | 变更 | 依据 |
| --- | --- | --- |
| `architecture.md` Trust Boundaries 1：renderer 不得任意读取文件 | renderer 可以读取项目工作目录内的文件，由 main 校验路径并限制大小 | R22；工作目录本来就是用户选定的、界面可见的路径 |
| Trust Boundaries 6：命令、原始输出、工具负载不进入 renderer | 进入 renderer，只做密钥脱敏 | R21，用户裁决 |
| `AGENTS.md`：不得向 renderer 暴露可执行文件路径 | 完整轨迹中的可执行文件路径原样显示；修改 `AGENTS.md` 的这一条，限定为「轨迹显示以外，renderer 不接收可执行文件路径，也不能据此启动进程」 | R21；用户裁决 2026-11-13 |
| `architecture.md` Reliability：写入租约按会话划分，会话之间互不等待 | 项目室内改为按文件和工作目录划分；项目外的会话保持原样 | R7、R23 |
| `architecture.md` Known Risks：共用文件夹的写入不协调 | 项目室内已协调；项目外仍不协调 | R23 |
| Local Data 表格 | 新增项目室状态文件、影子 git 仓库、轨迹文件 | M1、M4、M7 |
| `architecture.md` Known Risks：新增 | 密钥脱敏只能替换已知的密钥值；Agent 读出的文件内容中的其他密钥（例如 `.env`）会原样显示在轨迹中。用户已接受 | R21 |
| `architecture.md` Known Risks：安装器使用可变的上游包 | 新增的 ACP 适配器包同样适用；固定版本 | A9 |

不变的边界：Agent 执行仍在 main；不引入服务器；不执行 Agent 写出的命令（验收命令由具备 `read-exec` 或写入能力的席位在自己的 CLI 沙箱中执行）；密钥只经系统安全存储；写入仍需显式开启（R26）。

## 7. 需求覆盖

| 需求 | 模块 |
| --- | --- |
| R1 检查点循环 | M2、M3 |
| R2 机器信号 | M3（标记）、M2 |
| R3 默认 playbook | M1、M2、M12 |
| R4 检查点清单 | M2 |
| R5 何时叫人 | M2、M5 |
| R6 关卡首屏 | M5、M12 |
| R7 并行与写入者 | M2、M6 |
| R8 评审立场与防不收敛 | M3（提示词）、M2（上限、产物未变） |
| R9 评审文件为真源 | M3 |
| R10 快照与新会话 | M4、M3 |
| R11 漂移检查 | M4、M2 |
| R12 实施中调整文档 | M4、M2、M3（变更通知） |
| R13 追踪链 | 默认 playbook 的提示词与就绪检查检查点（M2 定义）；平台不解析追踪关系 |
| R14 决策记录 | M4、M5 |
| R15 打回与级联 | M2、M4 |
| R16 席位 | M1、M3、M12 |
| R17 用户介入 | M1（模板）、M2（插话）、M12 |
| R18 组队 | M9 |
| R19 状态机与持久化 | M2、M1 |
| R20 长时间执行 | M3（看门狗）、M2（续跑、重启） |
| R21 完整轨迹 | M7、M12 |
| R22 界面 | M12、M8 |
| R23 项目室与群聊 | M1、M6 |
| R24 现有群聊模式 | M11 |
| R25 不碰用户的 git，提交由人选择 | M4（影子仓库）、M5 |
| R26 产品边界 | 第 6 节 |
| R27 主笔失败与接替 | M2、M5 |
| R28 用量与通知 | M10、M5 |
| R29 复盘与版本 | M1（playbook 版本）、M2（复盘检查点） |
| R30 可运行预览 | M3（`read-exec` 或写入能力） |

## 8. 待定问题

1. Claude、Codex 的 ACP 适配器是否沿用本机已登录的凭据，长时间运行是否稳定；Pi 的社区适配器是否可用。实施计划的第一个里程碑做实测。
2. 文档根目录的默认名称（草稿用 `meldwork/`）。
3. 「主流程」群聊是否就是项目室创建时的第一个群聊，还是一个不可删除的特殊群聊。

## 9. 复用清单

| 需求 | 复用对象 | 许可证 | 取代的自研内容 |
| --- | --- | --- | --- |
| 已接受版本、diff、轮后检测 | 本机 git + Cline 的影子仓库做法 | git：GPL-2.0（作为外部命令调用）；做法参考 Cline（Apache-2.0） | 工作目录扫描器、快照清单、diff 计算 |
| Agent 接入、完整轨迹、`read-exec` | ACP：`@agentclientprotocol/sdk`、claude-agent-acp、codex-acp、原生 Gemini/Qwen ACP | Apache-2.0 | 每个 CLI 的轨迹映射与权限参数 |
| 顶层调度 | XState v5 | MIT | 手写状态机、持久化与恢复 |
| diff 展示 | `@git-diff-view/vue` | MIT | diff 组件 |
| 用量 | ccusage 的本地日志读取做法 | MIT | 各 CLI 输出解析 |
| 轨迹展示 | Nimbalyst 的会话与工具调用展示（参考） | MIT | 展示设计 |
| 默认 playbook 的提示词与模板 | BMAD-METHOD、Spec Kit | MIT | 从零编写提示词与模板 |
| 关卡持久等待 | Temporal / LangGraph 的模型（只借思路） | — | — |

明确不复用：Bernstein、Claude Squad 等编排器的任务调度（细粒度任务图，违背 agent for agent）；Temporal、LangGraph 本身（需要服务进程或节点重跑语义）；Nimbalyst 作为底座（没有阶段、关卡与跨模型评审，换底座会丢弃已有分析）。
