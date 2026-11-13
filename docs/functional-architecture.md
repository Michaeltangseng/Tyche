# 功能架构：项目室

初稿，2026-11-13。依据：`docs/product-target.md`（需求定稿，条目编号 R1–R30）与源码核实。本文回答「由哪些模块组成、各管什么、怎么接到现有代码上、改哪些现有边界」。每个模块后面有一份模块文档；分期交付写在实施计划里。

## 1. 总体结构

```
┌────────────────────────── Renderer（Vue） ──────────────────────────┐
│ 侧边栏：项目室 ▸ 群聊      群聊头部：成员头像 / 席位配置            │
│ 检查点进度   关卡面板      目录树 / 预览 / diff     完整轨迹面板    │
└───────────────┬───────────── preload：窄 IPC ──────────────────────┘
                │ project:* / workdir:* / trace:* / 现有 local-workspace:*
┌───────────────┴──────────────── Main ───────────────────────────────┐
│ M2 检查点引擎（确定性状态机） ── M1 项目室存储                      │
│   │        │            │                                           │
│   │        │            └─ M5 关卡（复用 Human Gate 存储）          │
│   │        └─ M4 产物与版本（快照、哈希、diff、过期传播、记录文件）  │
│   └─ M3 席位调用适配 ── 现有 LocalWorkspace.invokeAgent ── CLI       │
│                  └─ M6 写入协调（复用调度器租约）                    │
│ M7 完整轨迹（轨迹存储 + 分页）   M8 工作目录浏览   M9 组队   M10 用量 │
└──────────────────────────────────────────────────────────────────────┘
```

核心思路：

- 项目室是 main 进程里的一层新协调器，目录 `desktop/src/project-room/`。它不扩展 `LocalWorkspaceAutoRunner`（V2/V3/V4 的执行器），只通过现有的单 Agent 调用入口 `LocalWorkspace.invokeAgent`（`desktop/src/workspace/local-workspace.cjs:2895`）驱动 Agent。Agent 的进程、会话恢复、事件、Run Ledger、失败分类全部沿用现有链路。
- 状态机只读四类输入：主笔与评审的结尾标记、人的关卡选择、平台计算的内容哈希、已确认的检查点清单（R2）。它不调用模型，不解析自由文本。
- 文件是 Agent 之间唯一的共享真源（R9）；完整轨迹只给人看（R21）。

## 2. 关键架构决定

| # | 决定 | 理由 | 替代方案及放弃原因 |
| --- | --- | --- | --- |
| A1 | 项目室作为独立协调器，经 `invokeAgent` 调用 Agent | 复用调用链约 1,400 行的成熟逻辑；不碰 V4 执行器（约 8,000 行） | 扩展自动讨论执行器：耦合 V4 回执与阶段，违背 agent for agent |
| A2 | 轻量项目元数据放 `meldwork-workspace.json`，引擎状态放独立私有存储 | 工作区文件每次保存整体重写；引擎状态和版本记录会持续增长 | 全放工作区文件：写放大；全放私有存储：侧边栏快照要跨两个来源拼装 |
| A3 | 原生会话键加入「项目、检查点、席位」 | 同种 Agent 多席位需要独立会话（R16）；新检查点要新会话（R10） | 每个席位一个合成群聊：污染侧边栏与消息存储 |
| A4 | 已接受版本 = 内容哈希清单 + 内容寻址快照，自有 diff | 不依赖 git，非 git 目录同样可用；不碰用户的 `.git`（R25） | 用 git 对象或 `refs/meldwork/*`：要写 `.git`，违背 R25 |
| A5 | 写入协调 = 按目标文件的建议性租约 + 轮后变更检测 | CLI 沙箱以整个工作目录为单位，无法在进程层面限制到单个文件；能做到的诚实保证是「排队 + 事后发现越界并叫人」 | 为每个席位复制工作树：Agent 失去完整上下文，违背 agent for agent |
| A6 | 关卡复用 Human Gate 存储，增加「项目检查点」作为拥有者，不用内存等待者 | 现有存储、确定性 ID、选项与决定校验都可用；决定经已有的孤儿决定路径回调引擎即可跨重启 | 新建关卡存储：重复约 700 行 |
| A7 | 完整轨迹走独立通道：main 写入经脱敏的追加日志，renderer 分页拉取 | 现有摘要通道带多层截断，且被 Run Ledger 与证据胶囊依赖；另开通道不破坏它们 | 直接放宽现有通道的上限：会撑大 Run Ledger 与消息存储 |
| A8 | 结尾标记沿用现有回执语法 `[[MELDWORK_…:{json}]]`，新建独立解析模块 | 流式隐藏（`answer-marker-filter.cjs`）可直接复用；不扩展 V4 白名单，避免与 V4 耦合 | 扩展 `collaboration-receipt.cjs` 的 V4 阶段：把项目室绑进 V4 记录 |

## 3. 模块

### M1 项目室存储

管什么：项目实体、席位、playbook 实例、检查点进度、产物版本索引、决策与插话队列。（R16、R19、R23）

- 工作区文件新增 `projects: [{ id, name, workdir, createdAt, updatedAt }]`；群聊新增可选的 `projectId`。需要修改的白名单：`local-workspace-state.cjs:224-244` 加载路径、`local-workspace-message-records.cjs` 的 `emptyState` 与 `normalizeLoadedGroup`、`createGroup`、`workspaceSnapshot`（`local-workspace-state.cjs:428-456`）、renderer 的 `desktop-snapshot.js:367-376`。版本号升到 4，加载时接受 1–4。
- 引擎状态存 `meldwork-private/projects/<projectId>.json`，按 `human-gate-store.cjs` 的模式实现：单文件、经 `atomicWritePrivateFile` 原子写入、`0600`、有大小上限。
- 产物快照的内容存进现有的 `ContentBlobStore`（`desktop/src/attachments/content-blob-store.cjs`，sha256，单个最大 256 MiB）。
- 一个工作目录只对应一个项目室：创建时按真实路径（realpath）判重（R23）。
- 删除项目室：删除引擎状态，其群聊变为普通群聊或一并删除（由用户选择）；不删除工作目录里的文件。

主要记录（字段在模块文档里定）：

| 记录 | 要点 |
| --- | --- |
| Project | id、名称、工作目录、文档根目录（默认 `meldwork/`）、席位列表、playbook 实例、主流程群聊 id |
| Seat | id、角色名、职责、Agent 种类、角色提示词、能力集合（读 / 写草稿区 / 写工作目录 / 运行命令）、参与的检查点 |
| Playbook | id、版本、检查点定义列表；可保存为模板（R17、R29） |
| CheckpointDef | key、类型（访谈 / 文档 / 就绪检查 / 里程碑 / 最终评审 / 复盘）、目标文件、主笔席位、评审席位、并行草稿席位、关卡软硬、轮数上限、是否产出清单 |
| CheckpointInstance | 状态、轮次、续跑次数、主笔会话键、评审文件列表、当前关卡、已接受版本、过期标记 |
| ArtifactVersion | 文件路径 → 哈希的清单、快照引用、接受时间、来源（关卡 / 软关卡 / 实施中调整）、对应决策 |
| Decision | 决定、理由、谁定的、引用的评审文件；同时追加到 `decisions.md` |
| Interjection | 内容、目标检查点、状态（排队 / 已交付） |

### M2 检查点引擎

管什么：按 playbook 推进检查点，决定下一步谁做什么、何时叫人。（R1–R5、R12、R15、R19、R20）

- 由两部分组成：纯函数的转移表 `checkpoint-transitions.cjs`（输入当前状态和一个事件，输出新状态和要执行的动作，单元测试覆盖每条转移），以及执行动作的 `checkpoint-engine.cjs`。
- 同一项目室同一时刻可以有多个检查点在运行（并行模块文档），但每个检查点内部严格串行。

检查点状态：

```
pending → drafting（并行草稿，可选）→ leading → reviewing ─┬─ pass ─ 软关卡 → accepted
                                        ↑                   ├─ pass ─ 硬关卡 → gate
                                        └──── revise ───────┤
                                                            └─ needs-human / 上限 / 产物未变 → gate
gate ─ 接受 → accepted ─（上游打回）→ stale → leading
     ─ 再给几轮 / 打回附意见 → leading
leading ─ question → gate（问题）─ 回答 → leading（同一会话）
        ─ continue → leading（同一会话，续跑次数 +1，到上限 → gate）
        ─ 失败 → gate（失败：重试 / 换人接替）
```

事件来源：主笔结尾标记、评审结尾标记、Agent 调用失败、人的关卡选择、人的插话、已接受的需求或架构文档出现新版本、工作目录与已接受版本不一致（R11）。

其他规则：

- 评审轮次：每个评审席位一次独立调用。多位评审时，任一 `needs-human` 即进入关卡；全部 `pass` 才算通过；其余情况按 `revise`。
- 产物未变：评审给 `revise` 后，主笔交回 `ready`，但目标文件哈希与上一轮相同 → 关卡（R5）。
- 检查点清单（R4）：主笔把清单写成 `meldwork/checklists/<检查点>.json`；引擎按模式校验，校验失败按需要人处理；人在硬关卡上接受后生成后续检查点实例。
- 打回（R15）：从关卡上选择一个上游检查点；引擎计算依赖于它的已接受检查点，先在关卡上展示影响预览，确认后标为过期。过期检查点在上游重新接受后依次重新进入 `leading`，主笔的输入包括上游的变化和决策记录。
- 实施中调整文档（R12）：每次主笔或其他群聊的调用结束后，M4 检测已接受文档是否变化。变化即形成新版本并要求 `changes.md` 中有对应记录（缺失则在关卡上提示）；如果变化的是需求文档或功能架构，立即开关卡。
- 插话（R17）：主笔一轮进行中时排队，下次调用主笔时放进提示词；人选择「停止并交付」时，用现有的停止机制结束当前一轮后立即调用。插话会让这一轮已有的 `pass` 失效。
- 重启（R20）：引擎状态持久化。重启时，未结束的只读调用重新发起；可写入的调用一律转为关卡，由人决定是否续跑，与现有 Run Ledger 规则一致。

### M3 席位调用适配

管什么：把「席位 + 检查点 + 输入」变成一次 `invokeAgent` 调用，并把结果变成引擎事件。（R2、R8、R10、R16、R20）

- 提示词由四层拼成：平台立场（主笔或评审的立场、结尾标记约定）+ 席位的角色提示词 + 检查点输入（目标文件、已接受上游文件的路径与哈希、上一轮评审与回应文件、排队的插话、变更通知）+ 语言约定。通过现有的 `promptOverride` 传入（`local-workspace-agent-invocation.cjs:98-115`）；需要一个选项去掉现有的 `RESPONSE_SCOPE_INSTRUCTION` 与工作偏好后缀（`:829-847`），避免与项目室立场冲突。
- 结尾标记：新模块 `signal-markers.cjs`，语法与现有回执一致，例如 `[[MELDWORK_CHECKPOINT:{"signal":"ready"}]]`、`[[MELDWORK_REVIEW:{"verdict":"pass"}]]`。复用 `answer-marker-filter.cjs` 在流式输出时隐藏。缺失或无法解析 → 需要人。
- 会话（决定 A3）：会话键扩展为 `project:<projectId>:cp:<checkpointId>:seat:<seatId>:<kind>`，超长时沿用现有的哈希回退（`local-workspace-context.cjs:357-371`）。需要修改 `resolveSessionState` 与会话键规范化（`local-workspace.cjs:2665-2668`），使带席位的键不被归并为群聊级的键。同一检查点内主笔的多轮 `revise` 与 `continue` 恢复同一会话；新检查点用新键，也就是新会话。评审者每轮用新会话（只读、无状态，避免被上一轮立场锚定）。
- 能力到 CLI 的映射：现在只有 `read-only` 与 `workspace-write` 两种模式（`agent-runtime-contract.cjs:31`）。新增第三种模式 `read-exec`（能运行命令、不改文件），需要修改运行时约定、调度器的模式校验（`run-scheduler.cjs:143`）、`cli-invocations.cjs` 中各 CLI 的参数、ACP 自动审批策略（`agent-permission-policy.cjs`）。每个 CLI 能否表达这一模式，在模块文档里逐个验证（例如 Codex 的只读沙箱可以运行命令；Claude 可能需要用工具允许与禁止列表组合）。不能表达的组合，在席位配置界面提示，不静默降级或放宽（R16）。
- 「写草稿区」能力在 CLI 层就是 `workspace-write`，限制由 M6 的轮后检测保证。
- 看门狗：调用上下文新增 `watchdog` 选项（读取位置 `local-workspace-agent-invocation.cjs:636`）。项目室的主笔调用使用「提醒不中止」策略：无活动超时只发提醒事件和系统通知，由人停止或继续；`cli-adapters.cjs:396-399` 的 2 小时硬上限也改为可按调用覆盖（R20）。
- 评审文件：评审者保持只读；它这一轮的最终回答由平台写入 `meldwork/reviews/<检查点>/r<轮次>-<席位>.md`（R9）。主笔的回应由主笔自己写入 `r<轮次>-response.md`，作为它目标文件的一部分。

### M4 产物与版本

管什么：快照、哈希、diff、漂移检查、过期传播所需的依赖、`decisions.md` 与 `changes.md`。（R10–R15、R25）

- 工作目录扫描：把 `agent-output-importer.cjs` 中针对 `.meldwork-output/` 的扫描逻辑提取成可配置的扫描器：根目录可配置、忽略规则（`.git`、`node_modules`、构建产物，以及 `.gitignore`）、更高的数量上限、能识别删除的文件、基线可以持久化。现有的输出捕获改为调用这个扫描器，行为不变。
- 已接受版本（决定 A4）：
  - 文档类检查点：目标文件的全文存入 `ContentBlobStore`，版本记录保存路径 → 哈希的清单。
  - 里程碑：整个工作目录（按忽略规则）的路径 → 哈希清单；文本文件在单文件和总量上限以内时存全文，以便 diff；超过上限或二进制文件只存哈希，diff 只显示「已变化」。上限的取值在模块文档里定。
- diff：用成熟的文本 diff 库（例如 npm 包 `diff`），在 main 里计算，renderer 只接收结果。git 仓库不是前提；git 只在人于关卡上选择「同时提交」时调用（R25）。
- 漂移检查（R11）：检查点开始前，比较上游已接受文件的当前哈希与版本记录；不一致 → 关卡（以哪一版为准）。
- 记录文件：`decisions.md` 由平台追加（来源是关卡上的选择）；`changes.md` 由修改文档的 Agent 写，平台只检查是否有对应条目。
- 依赖：每个检查点实例记录它读取过的上游版本，打回时据此计算影响范围。

### M5 关卡

管什么：项目室的所有等人时刻：硬关卡、问题、失败、漂移、需求或架构新版本、打回确认。（R5、R6、R15、R27、R28）

- 存储（决定 A6）：在 `human-gate-records.cjs` 中增加拥有者字段 `{ ownerKind: 'project-checkpoint', projectId, checkpointId }`；有拥有者时 `runId`、`agentRunId` 可以为空。现有的运行类关卡不变。
- 不使用内存等待者：引擎直接创建记录；人的决定经现有的孤儿决定回调（`human-gate-coordinator.cjs` 的 `onOrphanDecision`）交给引擎。`reconcileOrphans` 对项目关卡不做自动拒绝，因为引擎状态是持久的。
- 快照：项目关卡不依赖运行即可发布到 renderer。需要修改 `local-workspace-state.cjs:410-416` 与 `desktop-snapshot.js:349-375` 的过滤。
- 首屏内容（R6）：评审者摘要（评审文件开头的几行）、是否有驳回、改动的文件和 diff 统计、轮次、用时、软关卡批量摘要。选项按关卡类型给出：接受、再给 N 轮、换评审者、打回（选择上游检查点）并附意见、裁决驳回、接受现状、同时提交到 git。选项总数受现有上限 16 约束，足够使用。
- 通知（R28）：扩展 `shell/main-run-notifications.cjs`，新增项目关卡通知，点击后打开对应项目室。

### M6 写入协调

管什么：同一文件同一时刻只有一位写入者，跨群聊生效。（R7、R23）

- 租约键（决定 A5）：项目室内的可写调用不再使用按会话的键（`local-workspace-agent-invocation.cjs:278-282`），而是按目标：
  - 文档检查点：每个目标文件一个键，例如 `project:<id>:file:<相对路径>`。
  - 草稿：每个席位自己的草稿目录一个键。
  - 里程碑和项目内群聊的可写调用：整个工作目录一个键 `project:<id>:workdir`，与所有文件键互斥。
- 需要给调度器（`run-scheduler.cjs`）增加原子地同时获取多个键的能力，以及「工作目录键与文件键互斥」的层级关系。现在的键只是不透明字符串（`:22-26`），单键可以直接使用。
- 轮后检测：可写调用结束后，M4 比较这一轮前后的工作目录清单；改动了声明目标之外的文件 → 在关卡上列出越界的文件，由人处理。这是建议性租约的兜底，也是对「写草稿区」能力的实际保证。

### M7 完整轨迹

管什么：Agent 每一步完整可见；群聊的「运行详情」与项目室共用。（R21）

- 现状：内容在六处以上被裁剪或替换。命令一律变成 `command`（`cli-runtime-summaries.cjs:92-94`）；工具参数只剩长度和字段数（`:66-90`）；工具输出只剩行数和字节数（`:109-137`）；Codex 与 ACP 的命令显示为 `[operation hidden]`，ACP 的思考文本被丢弃（`cli-runtime-event-mappers.cjs:41-42, 442-474`）；路径与命令被改写，并有 2000/4000 字符上限（`cli-runtime-event-sanitizer.cjs:51-58, 251-259`）；harness 再截一次（`run-harness-normalization.cjs:100-119`、`run-harness.cjs:1-2`）。
- 新通道（决定 A7）：
  - 在解码回调处（`cli-adapters.cjs:300-314`，映射之前）以及原始输出处（`:402-408`）取得完整内容。各 CLI 的映射器在现有摘要字段之外，再产出一份完整内容（命令原文、工具参数、工具输出、思考文本）。
  - 完整内容只经过密钥脱敏（`redactChildSecrets` 与 `security/secret-redaction.cjs` 的 `redactSecrets`），不做路径和命令改写，然后写入 `meldwork-private/traces/<runId>/<agentRunId>.jsonl`（追加写，`0600`）。
  - 实时事件只推送「有新内容」的通知和一个小窗口；renderer 通过新 IPC `trace:page(runId, agentRunId, cursor)` 分页读取。
  - 现有摘要通道、Run Ledger、证据胶囊保持不变，继续服务现有功能。
- 保留与上限：暂不设置（需求 R21）；删除会话时一并删除它的轨迹文件。
- 边界变更：`architecture.md` Trust Boundaries 第 6 条、Local Data 表格需要改写。另见第 6 节关于 `AGENTS.md` 的冲突。

### M8 工作目录浏览

管什么：目录树、文件预览、相对已接受版本的 diff。（R22）

- 现在没有任何文件读取或目录列举的 IPC。新增 `workdir:list(projectId, relPath)`、`workdir:read(projectId, relPath)`、`workdir:diff(projectId, relPath, against)`，通过 `registerTrustedHandle` 注册。
- 路径限制：只接受项目工作目录内的相对路径；解析真实路径后必须仍在工作目录内（拒绝指向外部的符号链接）；单次读取有大小上限，二进制文件只返回元信息。
- 目录变化：main 侧可以监听工作目录变化并推送「树已变化」，或由 renderer 在每次调用结束后刷新。取舍在模块文档里定。

### M9 组队

管什么：用户输入需求后给出团队草案与裁剪过的 playbook。（R18）

- 通过一个「组队席位」调用本机某个 CLI（只读、新会话），要求它输出结构化的团队草案，由 M2 校验后展示给人确认。
- jev 目前没有在 Meldwork 中接入。只要它能通过某个本机 CLI 调用（作为该 CLI 的模型），组队席位选择那个 CLI 即可，不需要专用适配（保持 provider-agnostic）。
- 失败、超时或输出无法校验时，回退到默认 playbook，并用现有的确定性路由（`desktop/src/agents/agent-routing.cjs`）为席位挑选 Agent。

### M10 用量

管什么：每个检查点显示用量。（R28）

- 本地 CLI 现在不解析用量，只做估算（`invocation-budget.cjs:17-34`）。在各 CLI 的输出累加器中解析结束事件里的用量（例如 Claude 的 stream-json 结果事件、Codex 的 token 计数事件），作为 `result.usage` 返回。不提供用量的 CLI 显示「不可用」，不做估算冒充。

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
| 群聊头部 | 成员头像；点击打开席位配置弹层（角色、Agent、角色提示词、能力、增删席位） | `ConversationHeader.vue` |
| 检查点进度 | 当前检查点、主笔、轮次、在等谁、过期标记 | 新组件 |
| 关卡面板 | 首屏摘要、选项、驳回裁决、打回影响预览 | 现有关卡按钮在 `ConversationTimelineView.vue:613-655` |
| 目录树面板 | 可折叠；预览；diff | 新组件 |
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
4. 主笔结束：M6 释放租约；M4 做轮后检测与哈希；根据结尾标记：`ready` → 5；`question` → M5 开问题关卡；`continue` → 回到 3。
5. M3 调用各评审者（只读、新会话）；平台写入评审文件。
6. M2 汇总结论：`revise` → 回到 3（输入加上评审文件）；`pass` → 软关卡直接接受，硬关卡交给 M5；`needs-human`、到达上限、产物未变 → M5。
7. 接受：M4 存快照与版本，追加 `decisions.md`；M2 推进到下一个检查点，或者在清单确认后生成后续检查点。

### 实施中的文档调整

主笔在里程碑中修改了已接受的 `requirements.md` → 这一轮结束后，M4 发现哈希变化 → 形成新版本并检查 `changes.md` → 因为是需求文档，M2 立即开关卡 → 人接受（版本生效，其他席位下次调用时收到变更通知），或者打回到需求检查点。

### 项目内的群聊

用户在第二个群聊里讨论某个技术问题 → 调用沿用现有的群聊路径，额外注入「项目室已接受文档清单 + 自上次以来的变化」→ 该 Agent 若改了文档，按「实施中的文档调整」处理；可写调用使用 `project:<id>:workdir` 键，与主流程的写入互斥。

## 5. 对现有代码的修改清单

| 位置 | 修改 | 风险 | 模块 |
| --- | --- | --- | --- |
| `local-workspace-state.cjs`、`local-workspace-message-records.cjs`、`desktop-snapshot.js` | 白名单加入 `projects`、`projectId`；版本升到 4 | 低；旧版本文件照常加载 | M1 |
| `local-workspace-context.cjs`、`local-workspace.cjs` 的会话键 | 支持带席位的键 | 中；会话迁移逻辑要有测试 | M3 |
| `invocation-prompt.cjs` | 选项：不附加响应范围说明与工作偏好 | 低 | M3 |
| `agent-runtime-contract.cjs`、`run-scheduler.cjs`、`cli-invocations.cjs`、`agent-permission-policy.cjs` | 新增 `read-exec` 模式 | 中；逐个 CLI 验证 | M3 |
| `local-workspace-agent-invocation.cjs:636`、`cli-adapters.cjs:396` | 按调用设置看门狗与硬上限 | 低；默认值不变 | M3 |
| `local-workspace-agent-invocation.cjs:278` | 允许调用者指定租约键 | 低 | M6 |
| `run-scheduler.cjs` | 原子获取多个键；工作目录键与文件键互斥 | 中 | M6 |
| `agent-output-importer.cjs` | 提取可配置扫描器；现有行为不变 | 中；回归测试 | M4 |
| `human-gate-records.cjs`、`human-gate-coordinator.cjs`、`local-workspace-state.cjs:410` | 拥有者字段；项目关卡不随运行发布；重启不自动拒绝 | 中 | M5 |
| `cli-runtime-event-mappers.cjs`、`cli-adapters.cjs`、新的轨迹存储 | 完整内容通道 | 中；不改动现有摘要通道 | M7 |
| `main-run-notifications.cjs` | 关卡通知 | 低 | M5 |
| 各 CLI 输出累加器 | 解析用量 | 低 | M10 |
| `preload.cjs`、`shell/main-ipc.cjs` | 新增 `project:*`、`workdir:*`、`trace:*` IPC | 中；每个方法都要做输入校验 | M1、M7、M8 |

新增目录：`desktop/src/project-room/`（M1–M6、M9）、`desktop/src/runs/trace-store.cjs`（M7）、`desktop/src/shell/project-ipc.cjs`、`desktop/src/shell/workdir-ipc.cjs`（M8）。每个新模块在 `desktop/test/` 下有同名测试（node 测试脚本）；前端测试用 vitest，放在 `frontend/src/__tests__/meldwork/`。

## 6. 信任边界与产品边界的变更

| 现有规则 | 变更 | 依据 |
| --- | --- | --- |
| `architecture.md` Trust Boundaries 1：renderer 不得任意读取文件 | renderer 可以读取项目工作目录内的文件，由 main 校验路径并限制大小 | R22；工作目录本来就是用户选定的、界面可见的路径 |
| Trust Boundaries 6：命令、原始输出、工具负载不进入 renderer | 进入 renderer，只做密钥脱敏 | R21，用户裁决 |
| `AGENTS.md`：不得向 renderer 暴露可执行文件路径 | **冲突，需要用户确认**：命令原文和原始输出里可能包含可执行文件路径。要么修改 `AGENTS.md` 的这一条，要么在完整轨迹中仍然替换可执行文件路径 | 需求 R21 写的是「唯一保留的处理是密钥脱敏」 |
| `architecture.md` Reliability：写入租约按会话划分，会话之间互不等待 | 项目室内改为按文件和工作目录划分；项目外的会话保持原样 | R7、R23 |
| `architecture.md` Known Risks：共用文件夹的写入不协调 | 项目室内已协调；项目外仍不协调 | R23 |
| Local Data 表格 | 新增项目室状态文件、轨迹文件 | M1、M7 |

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
| R25 git 只用于提交选项 | M4、M5 |
| R26 产品边界 | 第 6 节 |
| R27 主笔失败与接替 | M2、M5 |
| R28 用量与通知 | M10、M5 |
| R29 复盘与版本 | M1（playbook 版本）、M2（复盘检查点） |
| R30 可运行预览 | M3（`read-exec` 或写入能力） |

## 8. 待定问题

1. 可执行文件路径是否也完整显示（第 6 节冲突）。
2. jev 可以通过哪个本机 CLI 调用。
3. `read-exec` 在每个 CLI 上能否表达，尤其是 Claude。
4. 里程碑快照的文本文件上限，以及是否默认尊重 `.gitignore`。
5. 文档根目录的默认名称（草稿用 `meldwork/`）。
6. 「主流程」群聊是否就是项目室创建时的第一个群聊，还是一个不可删除的特殊群聊。
