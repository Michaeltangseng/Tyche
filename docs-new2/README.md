# Meldwork 项目室重构方向（docs-new2）

> 状态：方向文档，已吸收独立评审和 eta 机制核对。待你安排下一轮评审后再进入实施计划。
>
> 本文档集取代 `docs-new/`，成为项目室的唯一目标架构。`docs/` 与 `docs-new/` 只保留为历史参考；其中与本文冲突的 ADR、阶段计划和兼容策略一律失效。

## 为什么重写

Meldwork 已经有一套能跑通的 v2 引擎：SQLite 账本、Message 入口、Controller 批次、Task/Assignment/Report/Attention、effects/outbox、Supervisor、写入租约、Artifact 快照、真实 Claude Code smoke。这些能力证明平台治理层是可行的。

但它同时暴露了一个结构性问题：

- v2 的 Controller 本身也是 Agent，但被隐藏并约束为 JSON 动作生成器；它替目标 Agent 建 Task/Assignment，而 Worker 只负责执行。这与项目室的核心原则冲突：单个 Agent 在自己的生态里完成大任务，平台不应该替它分解工作，也不应该追踪 Agent 内部步骤。
- v2 把 **一次 Assignment 当成一次会话**，每次重试或交接都新建原生调用，`saveSession: false`。Agent 不记得上次做过什么，平台只能把上一次 Report 重新喂进去。
- v2 没有 **participant 水位**，没有群聊增量简报，没有 Agent 之间的 `mention` 交接；所有唤醒都必须经过 Controller 或显式 @mention fallback。
- v2 没有自己的 Agent 工具通道：`mention` / `create_task` / `finish_task` 目前只有 Report 标记或内部动作，不能作为真实 CLI 的工具面。
- v2 的 Controller 是隐藏批次：UI 有 `is_controller` 徽章、也能发 `note` 消息，但它不是可自由对话的协作角色。

eta 已经提供这些机制：每个 (agent × conversation) 一个持久 session、被唤醒时只收 `last_seq` 之后的原文、Agent 用 `mention` 交接、Task 的 session 属于 Task lane、评论可以续跑、Captain 只发可见的工作授权而由目标 Agent 自己建 Task、Captain review supervisor 在 assignment 结算后唤醒 Captain。这些正是 Meldwork 需要补的底层语义。

现在是早期开发阶段，修改代价最小。继续在 v2 的错误模型上叠加兼容层，只会把 Controller/Assignment 的假设扩散到更多模块。目标架构更优时，应当直接重写，而不是保留旧引擎做双轨。

## 结论

**保留 Meldwork 经过验证的基础设施，重写协作语义层。**

保留的是**能力与模式**，不是 v2 room-engine 的整体代码。v2 的 Controller/Assignment schema、批次模型和一次性 session 策略都会被重写或删除。

保留：

- Electron main / preload / renderer 的信任边界；
- 原生 Agent 调用、CLI adapter、进程注册表、Trace、Run Ledger；
- 写入租约、per-seat 权限、Artifact 快照与 diff；
- SQLite 作为产品事实账本，effects/outbox 作为外部副作用边界；
- Report 作为任务结果的领域真源，Attention 作为需要用户处理的事项。

重写：

- 会话模型：从“一次 Assignment 一次调用”改为“每个 Chat × 角色一个持久 session；每个 Task lane 一个 task session”。
- 上下文投递：从“每次重新组织完整 prompt”改为“participant/lane 水位 + 增量简报”。
- 唤醒与交接：从“Controller 唯一派发”改为“用户 @ / Captain 可见授权 / Agent `mention` 交接”。
- 任务归属：从“平台建 Task、平台建 Assignment”改为“Agent 自己建 Task；平台只校验、排队、记录 Report”。
- 入口角色：Controller 替换为 **Captain（主控角色）**，它是 Chat 里的一个 Agent，不是平台内部的调度器。
- Captain 协调：使用 eta 的 **review supervisor**，不是自创的 completion wake。

不再保留：

- checkpoint engine、Gate/Seat/Round 状态机；
- 并发/顺序/自动讨论模式选择器；
- v2 的 `controller_decisions` 批次模型与“Controller 拆任务”假设；
- 旧 workspace JSON 与新 SQLite 的双写/双读。

## 原则

1. **Agent for agent。** 平台不分解大任务、不追踪 Agent 内部步骤。平台只拥有房间、消息、任务、报告、产物、权限、进程和恢复事实。
2. **平台拥有事实与安全边界。** 权限、成员、写入范围、进程、凭据、持久化、幂等和恢复不能由 Prompt 覆盖。
3. **复用优先。** 能从 eta 和 Meldwork 旧引擎复用的机制，先复用；不能直接复用的，移植纯逻辑，不重复造。
4. **早期阶段优先正确架构。** 不为旧逻辑堆砌兼容层。新架构更优时，允许删除旧引擎、旧 UI、旧数据结构的运行时依赖。
5. **单一目标架构。** 不做长期双引擎。旧数据只做一次性迁移或归档，不做持续双读。
6. **可恢复。** 消息、任务、报告、会话指针和外部副作用都必须能跨重启恢复；恢复不猜测、不伪造退出、不重放未确认的写操作。
7. **可见。** Agent 之间的授权、交接、任务和结果都落在 Chat 时间线上；平台内部的批次和调度细节不成为用户模型。
8. **唤醒异步。** 多个 @ 并发；`mention` 不等待；平台不做隐式串行。
9. **Captain review 不是 workflow 引擎。** 平台只检查已结算的 Captain assignment 并投递 review；Prompt 决定下一步。
10. **Agent 工具有真实通道。** MCP 优先，严格标记兜底；身份由 run/session 绑定。
11. **聊天不写文件。** Chat 回复默认只读；写入只在授权的 TaskRun；隔离前每个 Room 同时最多一个写入型 run。

## 方案比较

### 方案 A：在 v2 上增量改造

保留 `room-engine` 的 Controller/Assignment 模型，逐步加入持久 session 和增量简报。

- 优点：改动面最小，现有测试和 UI 可以继续用。
- 缺点：Controller 拆任务、Assignment 即会话、Report 绑定 Assignment 等假设已经渗入 schema 和 UI；增量改造会不断遇到“旧字段表达不了新语义”的问题，最后变成两套语义并存。
- 结论：不选。它正是“为兼容旧逻辑堆砌”的路径。

### 方案 B：保留基础设施，重写协作领域层（选定）

新建干净的协作领域模型（Room / Chat / Participant / Message / Task / TaskLane / TaskRun / Report / Attention / Artifact / Session / CaptainReview），复刻 eta 的会话、简报、唤醒、任务续跑和 review supervisor 语义；运行时、权限、租约、产物和 Trace 继续复用 Meldwork 现有实现。

- 优点：一次性把模型摆正；可以删除旧状态机和模式选择器；外部 CLI 和 Electron 边界不被破坏；复用 eta 被验证过的语义，而不是它的运行时。
- 缺点：需要重写 domain、schema 和 UI 读模型；旧项目室数据需要一次性迁移；外部 CLI 的 resume 仍需验证。
- 结论：选定。

### 方案 C：把 eta host 作为 sidecar 嵌入

直接运行 eta 的 Bun host，Meldwork 只做壳和 UI。

- 优点：代码复用最多。
- 缺点：引入必需的 Bun host、数据/权限双模型和打包成本；本地 sidecar 本身不违反 local-first，但它不是本产品的边界。eta 的 Captain/权限模型也不包含 Meldwork 的 per-seat 权限、写入租约、Artifact 账本；两套产品模型需要长期映射。
- 结论：不选。

## 架构一句话

```text
用户消息 / Agent mention / Captain 授权
  → Chat 时间线（Message 先落账）
  → 唤醒规则（@成员 / Captain / 单成员）
  → 每个 participant/lane 的持久 Session
  → 增量简报（participant/lane.last_seq 之后的原文）
  → Agent 自己 create_task / 执行 / finish_task
  → TaskRun 队列 + task lane session 续跑
  → Report 入账 → Task 状态推导 → Attention / Artifact
  → Captain review supervisor 在 assignment 结算后唤醒 Captain
```

## 首轮实施选择（2026-11-17）

- Worker 运行时：第一阶段只接外部 CLI。
- Captain：每个 Chat 一个 Captain Role。
- Task 创建：默认直接 `create_task`；`draft_task` 可选；不增加用户审批。
- 平台 Controller：不保留隐藏 Controller。
- Report：优先 MCP `finish_task`，文本标记 fallback。
- Task 验收：`ready → in_review → 用户接受 → done`。
- Captain 协调：复用 eta 的 review supervisor；不做 completion wake。
- Chat 权限：默认只读；写入只在 TaskRun；隔离前每个 Room 同时最多一个写入型 run。
- Agent 工具：MCP 优先，严格标记兜底；`mention` / `create_task` / `finish_task` 都要有通道。
- 水位：`last_seq` 属于 participant/lane，不属于 session。

## 评审吸收

### 独立评审

- 工具传输缺失：已在 02/04 增加 MCP + 严格标记通道。
- 重启恢复与反目标冲突：已改为 `interrupted/unknown` + Attention + 进程对账后再启动。
- Task 验收状态机矛盾：已加状态转移表、`accept_task` / `reject_task`、Artifact 独立状态。
- Session 指针所有权分裂：已定义 SessionStore port，新路径只写 SQLite。
- Schema 缺 TaskActivity、revision、client_id、lane、required、writeScopes：已在 02 补齐。
- 删除计划不闭合：已在 06 增加依赖顺序、目录改名、运行时解耦。
- 迁移只是草图：已在 06 增加 source→target 矩阵和 dry-run 要求。
- Renderer 路径不变量：已在 02/07 定义 display-safe DTO allowlist。

### 外部讨论

- Captain 不会等：已写成 ADR-N17；平台不做隐式串行。
- 外部 CLI resume 未证明：已加 Phase 2 proof gate；明确 `last_seq` 只是投递水位。
- 群聊工具与并发：已加 Chat 只读、写入只在 Task、隔离前写入并发 1。
- `assign_in_group` 是一条消息，不是两行：已在 03/04 修正。
- `last_seq` 归属：已统一到 participant/lane。
- 聊天回复也要走 effect：已在 02/03 修正。
- `mention` / `create_task` 也要有通道：已在 02/04 增加工具传输章节。
- Workflow in Captain prompt：已改为 eta 的 review supervisor，不加 completion wake / 独立预算 / stage_complete。
- `assign_in_group` 不计入 5 次 mention；5 次只约束 `mention` 工具调用。
- review 流量（`audience=captain` 行和 Captain review 回复）不计入 `activity_seq`，避免 review 自己触发下一轮；150ms 领域变化 debounce 是快路径，60 秒 tick 只是兜底。
- 没有 Task 的 assignment 回复也会触发 `assignment_settled`；挡住的是还在 queued/working/stopping 的回复，以及关联 Task 仍 todo/in_progress 或还有未结束 run。
- review 正文是观察，不是上一环全文；Captain 通过增量简报读取实际 public 消息。
- `hasNew` 基线包含 assignment 消息 seq；150ms 触发源是任何领域变化，不只 task board；review 只合并同一个 Chat；`reviewReply=true` 只打在 review 投递的 reply 上，`post_in_chat` 可能再次触发。
- Effect 成功 = 启动确认，不是运行结束；MCP 是完整工具循环，标记只支持单一终止动作；`finish_task` 是完成声明，退出确认 + 快照后才结算。
- Captain 不得自我派发；授权消息 + assignment + queued reply 同事务；reply/run/tool 绑定 assignment id；Captain 授权任务不得改派 assignee。
- 简报提供当前 Chat 的补读入口；Task/TaskRun/Effect 状态闭合；迁移覆盖 v2 数据、活跃执行/unknown、Trace/shadow Git。
- 修正：v2 Controller 本身也是 Agent；本地 sidecar 本身不违反 local-first，仍有运行时/数据/权限/打包成本。

## 文档索引

- [01 原则、范围与约束](01-principles-and-scope.md)
- [02 目标架构](02-target-architecture.md)
- [03 会话、简报与唤醒](03-conversation-session-and-briefing.md)
- [04 任务、Captain 与 Report](04-task-captain-and-report.md)
- [05 eta 复用映射](05-eta-reuse-map.md)
- [06 重写与迁移](06-rewrite-and-migration.md)
- [07 架构决策记录](07-decisions.md)
- [08 待决问题](08-open-questions.md)
- [09 UI 方向与信息架构](09-ui-direction.md)

## 明确抛弃

- `desktop/src/project-room/checkpoint-engine.cjs`、`checkpoint-transitions.cjs`、`gate-screen.cjs` 及其状态机；
- Seat、Round、Gate 作为用户模型；
- `workspace/local-workspace-auto-runner-*.cjs` 中的 V2/V3/V4 多套执行器；
- v2 `assignment-runner` 的“一次 Assignment 一次 session”策略；
- v2 `controller-agent` 的“Controller 内部拆任务”模型；
- `mention-fallback` 作为 Agent 之间唯一的交接路径；
- 旧 `workspace` JSON 作为活数据源；
- 任何“为了兼容旧 Chat 而保留旧引擎”的双轨方案；
- 自创的 “Captain completion wake”、独立 completion 预算、`stage_complete` 工具。

## 下一步

1. 你安排下一轮独立评审。
2. 评审通过后，进入 `superpowers:writing-plans`，产出文件级实施计划。
3. 第一个纵向验证：Chat 时间线 + participant session + 增量简报 + Agent `mention` + Task/Report 闭环。
4. 验证通过后再迁移 UI、删除旧引擎、做旧数据一次性归档。
