# 07 架构决策记录

本文件记录项目室重构的方向性决策。编号 `ADR-N*` 与 `docs-new/06-architecture-decisions.md` 的旧 ADR 区分；冲突时以本文件为准。

## ADR-N1：单一目标架构，允许推倒重写

**背景：** 现在有两代引擎（旧 checkpoint/V4 与 v2 room-engine），继续双轨会让消息、session、任务、UI 都出现两套语义。早期阶段修改代价最小。

**决定：** 只保留一个目标架构。新架构明显更优时，删除旧引擎、旧 UI、旧 schema 的运行时依赖，不做长期兼容层。

**后果：**
- 旧数据只做一次性迁移或归档，不做双读。
- 旧 Chat 不保留“legacy 模式”。
- 删除旧代码是交付的一部分。
- 每一项保留都必须说明“它在新架构里仍然正确”，而不是“它已经写了”。

**取代：** `docs-new/README.md` 的“新引擎与旧 checkpoint engine 并存一段时间”；`docs-new/07` 的双轨迁移策略。

## ADR-N2：Agent 拥有工作，平台不分解大任务

**背景：** v2 让 Controller 在平台内部 `create_task` / `assign`，Worker 只执行。这与“单个 Agent 在自己的生态里完成大任务、平台不追踪内部步骤”的原则冲突。

**决定：**
- Task 只能由 Agent 在 Chat 中创建。
- Captain 只发可见的工作授权，不替目标 Agent 建 Task。
- 平台负责校验、排队、记录 Report、推导状态、恢复和审计。
- 平台不根据自由文本猜测任务拆分或完成。

**后果：**
- `create_task` 是 Agent 工具，不是平台内部调度动作。
- ControllerAction 中的 `create_task` / `assign` 退役；Captain 的 `assign_in_group` 只写消息。
- Task 的粒度由 Agent 决定；平台只约束权限、成本和并发。

**取代：** `docs-new/06` ADR-003 中 Controller 创建/派发 Task 的部分。

## ADR-N3：每个 Chat × Role 一个持久 Session；每个 Task 一个 Session

**背景：** v2 每次 Assignment 新建原生调用，`saveSession: false`；Agent 不记得上次做过什么。

**决定：**
- Chat Session：`chat:<chatId>:role:<roleId>`，首次唤醒创建，之后复用。
- Task Session：`task:<taskId>`，首次 run 创建；评论续跑复用；rerun 新建 generation。
- Task 上被 mention 的其他角色使用 `task:<taskId>:role:<roleId>`。
- Session 的正文由 Agent runtime 拥有；平台只存 `native_session_ref`、`baseline_seq`、`last_seq`。

**后果：**
- 重试/交接不再靠复制 Report 续命；同一 Task 的后续 run 能看到自己做过什么。
- Provider/Prompt/工作目录变化时轮换 session；轮换时生成一次性 handoff。
- 外部 CLI 的 journal 不被平台读取或改写。

**取代：** `docs-new/06` ADR-005（v2 一次性原生调用、不持久化 sessionRef）。

## ADR-N4：增量简报，不做每轮总结

**背景：** v2 每次把任务/角色/协作约定重新拼成完整 prompt；旧 V4 已经有 delivery watermark，但 v2 没有。eta 证明“只发上次之后的新消息”足够，而且省 token。

**决定：**
- 每个 participant 有 `last_seq`。
- 唤醒时只发 `last_seq` 之后、已经完成的、别人的消息；触发消息必带。
- 未完成的行阻塞水位；最多 100 条、每条 2000 字。
- 简报是原文摘录，不是总结。
- 只有新建/轮换 session 时，生成一次 Session Handoff。

**后果：**
- 需要维护水位和“进行中”状态。
- 长 Chat 需要简报上限和 handoff。
- 平台不拥有外部 CLI 的完整上下文，不能承诺“模型看到了全部历史”。

## ADR-N5：回复行就是唤醒和队列

**背景：** v2 用 Assignment/effect 队列表；eta 用 message 行的 status 兼作队列。两套队列会产生状态同步问题。

**决定：**
- Message 表中的一种回复行同时是唤醒、队列和结果载体。
- 入队即分配 `seq`，`status=queued`；运行时 `working`；结束 `done/failed/stopped`。
- 同一 participant session 串行；不同 session 并行。
- 重启时 queued 继续、working 失败。

**后果：**
- 消息表承担队列职责；需要仔细处理 seq、状态迁移和并发。
- 不再需要单独的业务唤醒队列表。
- 前端可以直接从消息行渲染进度。

## ADR-N6：Captain 是可见的 Agent 角色，不是平台 Controller

**背景：** v2 Controller 是不可见的平台批次，拥有 `create_task/assign/create_role` 等动作。用户看不到它如何拆任务，也不符合 agent-for-agent。

**决定：**
- Captain 是 Chat 内的 Role，`is_captain=1`，有自己的 Participant Session。
- 它的工具是：`assign_in_group`、`post_in_chat`、读工具、`request_attention`、`control_task`、提案工具。
- `assign_in_group` 只写一条可见消息并 @ 目标；目标 Agent 自己建 Task。
- Captain 不能授予权限、改工作区、直接设置 Task done/cancelled。
- 没有 Captain 时，路由退回显式 @mention / 唯一参与者。

**后果：**
- v2 的 `controller_decisions` 批次模型退役。
- 保留平台校验/审计/幂等/effects，但绑定到可见的 Agent 工具和用户命令。
- Captain 的失败不会触发“平台自动建任务”的 fallback。

## ADR-N7：SQLite 存事实与指针，Session 正文归 Runtime

**背景：** v2 把产品事实放 SQLite，但没有 session；旧引擎把 sessionRef 放 workspace JSON；eta 用 SQLite + 文件 journal。三种做法混在一起。

**决定：**
- SQLite 存 Room/Chat/Role/Participant/Message/Task/TaskRun/Report/Attention/Artifact/Session 指针/Event/Effect。
- 外部 CLI 的 session 正文留在 CLI 自己的存储；平台不复制。
- Trace 存应用私有区 JSONL，DB 只存引用。
- Artifact 内容存应用私有区 Git/快照，DB 只存版本元数据。
- 不做 workspace JSON 与 SQLite 的双写。

**后果：**
- 备份/迁移需要同时处理 SQLite、Trace、Artifact 和 CLI 自己的 session。
- 平台不能假设自己能重放某个 Agent 的完整上下文。
- 未来若引入内置 runtime，才需要平台自己的 journal；那时再定义。

## ADR-N8：保留 Meldwork 的治理与安全基础设施

**背景：** eta 的权限模型较松（ACP 默认允许），且没有 Meldwork 的 Room 租约、per-seat 权限、Artifact 账本。直接照搬会破坏本地产品的安全边界。

**决定：**
- 保留 Electron main/preload/renderer 信任边界。
- 保留原生权限模式、写入授权、Room 根目录租约。
- 保留 Artifact 快照/diff、Report/Attention、effects/outbox、Supervisor、进程对账。
- 新 domain 只能调用这些基础设施，不能绕过。

**后果：**
- 新架构不是 eta 的翻版，而是“eta 会话语义 + Meldwork 治理”。
- 权限/租约/进程相关的测试继续有效。
- UI 仍然不暴露路径、凭据、原生 session 引用或进程句柄。

## ADR-N9：外部 CLI 的 Session 和压缩由 Runtime 拥有

**背景：** Meldwork 的 Worker 是 Claude Code/Codex 等外部 CLI，不是 eta 的内置 kernel。平台无法读取或改写它们的上下文。

**决定：**
- 平台只保存 `native_session_ref`、Provider、水位。
- resume 由 runtime adapter 调用 CLI 自己的恢复机制。
- 压缩由 CLI 自己做；平台只做有界简报、session 轮换和一次性 handoff。
- 上下文溢出时轮换 session，不无限重试。
- 只有在未来引入平台自管 runtime 时，才移植 eta-compaction。

**后果：**
- 不同 CLI 的 session/steer/压缩能力不同，需要 capability matrix。
- 平台不能保证“所有 Agent 看到同样的完整历史”；它保证“每个 Agent 收到自己没看过的新消息”。

## ADR-N10：一次性迁移，旧引擎退役

**背景：** 旧 workspace JSON、旧 room DB、旧 checkpoint 状态都包含与目标模型不兼容的字段。

**决定：**
- 新账本使用干净 schema。
- 旧数据由一次性迁移工具导入或归档；迁移后旧库只读。
- 旧引擎、旧 runner、旧 UI 入口在迁移完成后删除。
- 迁移失败回滚新库，旧库不动。

**后果：**
- 需要备份和迁移报告。
- 旧 session 无法恢复时，新 Task 从新 session 开始。
- 不再维护旧数据格式的兼容代码。

## ADR-N11：Report 是任务结果的领域真源

**背景：** v2 已经有 Report/状态推导；eta 用 `finish_task`。两者可以对齐。

**决定：**
- Report 的 kind 至少包含 `progress/ready/waiting/blocked/failed/handoff`。
- Task 状态由最新 required run 的 Report、TaskRun 事实和用户命令推导。
- 没有 Report 不能把 Task 置 `done`。
- 自由文本不能作为完成依据；工具优先，严格标记作为 fallback。
- Task `ready` 进入 `in_review`，用户接受后 `done`。

**后果：**
- 需要稳定的 Report 解析和归属校验。
- Agent 必须学会 `finish_task`；Prompt 和工具描述要明确。
- 用户仍然是最终验收者。

## ADR-N12：Attention/Inbox 是唯一的用户打断通道

**背景：** v2 有 Attention、Human Gate、通知；eta 有 Inbox。多个通道会让用户不知道去哪里处理。

**决定：**
- 所有需要用户处理的事项（blocked、in_review、提问、unknown、权限/成本请求、Artifact 接受）进入统一的 Attention/Inbox。
- 同一问题确定性去重；回答回到原 session。
- 通知可合并，不逐条弹窗。
- Attention 正文不包含敏感路径、Prompt 或凭据。

**后果：**
- UI 只需要一个收件箱/Attention 面板。
- 需要定义 Attention 生命周期和幂等回答。
- 用户离开当前 Chat 时仍能看到待处理事项。

## ADR-N13：Room 主目录是默认工作区，隔离 workspace 后置

**背景：** 用户的原则是“并行思考可以各自草稿，lead 合并；绝不两个 writer 写同一文档”。默认复制 worktree 会把环境准备、合并和发布的复杂度转移给平台。

**决定：**
- 默认所有 Agent 在 Room 主目录工作，写入用独占租约串行化。
- per-seat 权限决定谁能写。
- 隔离 worktree/临时 workspace 作为后续可选能力，只用于探索或高风险任务。
- Artifact 用 shadow Git commit/diff 记录版本。

**后果：**
- 共享目录下不同 Chat 的写入仍可能竞争；平台只保证同一 Room 的写入租约。
- 需要清晰的 Artifact 发布/接受语义。
- 不在第一阶段实现 worktree 自动化。

## ADR-N14：eta 只复用机制，不复用运行时

**背景：** eta 是 TypeScript/Bun + cordis + WebSocket + daemon；Meldwork 是 CJS/Electron + preload + 本地 CLI。

**决定：**
- 只移植纯逻辑或按语义重写：routing、briefing、session keys、task queue、report 推导。
- 不引入 eta 的 server、wire protocol、web UI、daemon、memory sidecar、cordis 插件体系。
- 不把 eta 作为子进程或 sidecar 运行。
- 移植代码保留 MIT 许可声明，并在 NOTICE 中记录。

**后果：**
- 不能“一行 import”复用；需要测试和适配。
- 但产品边界、权限模型和 UI 保持 Meldwork 自己的。
- eta 文档作为语义参考，不作为架构约束。

## ADR-N15：Task 默认直接创建，draft 可选

**背景：** 首轮目标是完整能力，不在任务创建上增加人工闸门；`draft_task` 仍有价值，但不作为默认。

**决定：**
- `create_task` 是默认入口：Agent 判断需要独立执行时直接创建并入队。
- `draft_task` 保留为可选：Agent 主动想先确认目标、范围或成本时使用。
- 平台不要求用户预先确认 Task；仍校验 Role/Provider/Chat 归属、权限、并发和成本。
- Task 的结果仍由 Report + 用户验收决定，不能用“创建时没确认”作为跳过验收的理由。

**后果：**
- Agent 有完整自主能力，可能创建用户不需要的任务；用户用 stop/cancel/评论纠正。
- 不以“防误建”为理由增加平台审批；如果后续出现滥用，再通过 Prompt、并发/成本上限或可选 draft 策略处理。

## 首轮实施选择（2026-11-17）

| 问题 | 选择 | 对应 ADR |
| --- | --- | --- |
| 1. Worker 运行时 | 第一阶段只接外部 CLI | ADR-N9 |
| 2. Captain 粒度 | 每个 Chat 一个 Captain Role | ADR-N6 |
| 3. Task 创建 | 默认直接 `create_task`；`draft_task` 可选；不增加用户审批 | ADR-N2 / ADR-N15 |
| 4. 平台 Controller | 不保留隐藏 Controller | ADR-N2 / ADR-N6 |
| 5. Report 通道 | MCP `finish_task` 优先，文本标记 fallback | ADR-N11 |
| 6. Task 验收 | `ready` → `in_review` → 用户接受 → `done` | ADR-N11 / ADR-N12 |

## 被取代的旧决策

| 旧决策 | 新决策 | 原因 |
| --- | --- | --- |
| `docs-new/06` ADR-003：Controller 创建/派发 Task | ADR-N2 / ADR-N6 | 平台不分解大任务 |
| `docs-new/06` ADR-005：v2 一次性原生调用、不持久化 sessionRef | ADR-N3 / ADR-N4 | Agent 需要持续记忆和增量上下文 |
| `docs-new/README.md`：新旧引擎并存一段时间 | ADR-N1 / ADR-N10 | 早期阶段，避免双轨 |
| `docs-new/07`：旧 Chat 保留 legacy 行为 | ADR-N1 / ADR-N10 | 单一目标架构 |
| `docs-new/06` ADR-007：首版不做跨 Chat 依赖等 | 保留 | 本文件不改变该范围 |
| `docs-new/06` ADR-001：Room 主目录 + 隐藏辅助目录 | ADR-N13 | 保留主目录，但隐藏目录不是目标语义 |
