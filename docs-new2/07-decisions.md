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

## ADR-N3：每个 Chat × Role 一个持久 Session；每个 Task lane 一个 Session

**背景：** v2 每次 Assignment 新建原生调用，`saveSession: false`；Agent 不记得上次做过什么。

**决定：**
- Chat Session：`chat:<chatId>:role:<roleId>`，首次唤醒创建，之后复用。
- Task Session：`task:<taskId>:role:<roleId>`，按 lane 区分；执行者 lane 跨 run 复用，mention lane 独立；rerun 新建 generation。
- Session 的正文由 Agent runtime 拥有；平台只存 `native_session_ref`、`baseline_seq`、`prompt_revision`、`permission_mode`、`workspace_ref`、`skill_bindings`。
- **`last_seq` 属于 Participant / TaskLane，不属于 Session。** 轮换 session 时水位留在 participant/lane。

**后果：**
- 重试/交接不再靠复制 Report 续命；同一 Task lane 的后续 run 能看到自己做过什么。
- Provider/Prompt/权限/工作目录/Skill 变化时轮换 session；轮换时生成一次性 handoff。
- 外部 CLI 的 journal 不被平台读取或改写。

**取代：** `docs-new/06` ADR-005（v2 一次性原生调用、不持久化 sessionRef）。

## ADR-N4：增量简报，不做每轮总结

**背景：** v2 每次把任务/角色/协作约定重新拼成完整 prompt；旧 V4 已经有 delivery watermark，但 v2 没有。eta 证明“只发上次之后的新消息”足够，而且省 token。

**决定：**
- 每个 participant/lane 有 `last_seq`。
- 唤醒时只发 `last_seq` 之后、已经完成的、别人的消息；触发消息必带。
- 未完成的行阻塞水位；最多 100 条、每条 2000 字。
- 简报返回被省略的 `omittedSeqs` / `truncatedIds`；Agent 可以调用 `read_chat(beforeSeq, limit)` 补读当前 Chat，不能跨 Chat。
- 编辑追加 `message_edited` 事件/消息并推进 `activity_seq`；只改旧行 revision 不会被增量投递发现。
- 简报是原文摘录，不是总结。
- 只有新建/轮换 session 时，生成一次 Session Handoff。
- **`last_seq` 是投递水位，不是模型记忆保证。** 外部 CLI 的压缩可能丢掉已投递内容；平台无法可靠观测。

**后果：**
- 需要维护水位和“进行中”状态。
- 长 Chat 需要简报上限和 handoff；简报是有损的，但提供 `read_chat` 补读入口，不能承诺每次自动投递全部历史。
- 平台不拥有外部 CLI 的完整上下文，不能承诺“模型看到了全部历史”。
- 重要事实应落在 Task/Report/Artifact/文件里，方便重新读取。

## ADR-N5：回复行就是唤醒和队列

**背景：** v2 用 Assignment/effect 队列表；eta 用 message 行的 status 兼作队列。两套队列会产生状态同步问题。

**决定：**
- Message 表中的一种回复行同时是唤醒、队列和结果载体。
- 入队即分配 `seq`，`status=queued`；运行时 `working`；结束 `done/failed/stopped/interrupted`。
- `revision` 随流式输出增加，`seq` 不变。
- 同一 participant/lane 串行；不同 participant/lane 并行。
- 重启时 queued 继续；working/waiting_for_input 转 `interrupted`，等待进程对账，不直接 failed。

**后果：**
- 消息表承担队列职责；需要仔细处理 seq、状态迁移和并发。
- 不再需要单独的业务唤醒队列表。
- 前端可以直接从消息行渲染进度。

## ADR-N6：Captain 是可见的 Agent 角色，不是平台 Controller

**背景：** v2 Controller 本身也是 Agent，但被隐藏并约束为 JSON 动作生成器，拥有 `create_task/assign/create_role` 等动作。用户看不到它如何拆任务，也不符合 agent-for-agent。

**决定：**
- Captain 是 Chat 内的 Role，`is_captain=1`，有自己的 Participant Session；`author_type=agent`，用徽章标识。
- 它的工具是：`assign_in_group`、`post_in_chat`、读工具、`request_attention`、`control_task`（continue/pause）、`propose_role`、`set_role_prompt`。
- `assign_in_group` 只写一条可见消息并 @ 目标；目标 Agent 自己建 Task；不得以 Captain 自己为目标，assignment 因果链见 ADR-N21。
- Captain 工具限定在所属 Chat；不能跨 Chat 读取/写入；不提供 `list_chats` / `read_chat`。
- Captain 不能授予权限、改工作区、直接设置 Task done/cancelled、rerun/delete Task。
- 没有 Captain 时，路由退回显式 @mention / 唯一参与者。

**后果：**
- v2 的 `controller_decisions` 批次模型退役。
- 保留平台校验/审计/幂等/effects，但绑定到可见的 Agent 工具和用户命令。
- Captain 的失败不会触发“平台自动建任务”的 fallback。
- 每个 Chat 一个 Captain 是 Meldwork 适配；eta 的全局 Captain 不能照搬。

## ADR-N7：SQLite 存事实与指针，Session 正文归 Runtime

**背景：** v2 把产品事实放 SQLite，但没有 session；旧引擎把 sessionRef 放 workspace JSON；eta 用 SQLite + 文件 journal。三种做法混在一起。

**决定：**
- SQLite 存 Room/Chat/Role/Participant/Message/Task/TaskLane/TaskRun/Report/Attention/Artifact/Session 指针/Event/Effect/UserCommand。
- 外部 CLI 的 session 正文留在 CLI 自己的存储；平台不复制。
- Trace 存应用私有区 JSONL，DB 只存引用。
- Artifact 内容存应用私有区 Git/快照，DB 只存版本元数据。
- 新 Chat 路径使用 **SessionStore port** 写 SQLite；不再写旧 workspace JSON 的 session 映射。
- `InvocationSession` 保留为原生 session 原语，由 SessionStore 适配。

**后果：**
- 备份/迁移需要同时处理 SQLite、Trace、Artifact 和 CLI 自己的 session。
- 平台不能假设自己能重放某个 Agent 的完整上下文。
- 未来若引入内置 runtime，才需要平台自己的 journal；那时再定义。

## ADR-N8：保留 Meldwork 的治理与安全基础设施

**背景：** eta 的权限模型较松（ACP 默认允许），且没有 Meldwork 的 Room 租约、per-seat 权限、Artifact 账本。直接照搬会破坏本地产品的安全边界。

**决定：**
- 保留 Electron main/preload/renderer 信任边界。
- 保留原生权限模式、写入授权、Room 根目录租约、writeScopes 校验。
- 保留 Artifact 快照/diff、Report/Attention、effects/outbox、Supervisor、进程对账。
- 新 domain 只能调用这些基础设施，不能绕过。
- Renderer 只接收 display-safe DTO；不暴露原生 session 引用、绝对路径、进程句柄、凭据。

**后果：**
- 新架构不是 eta 的翻版，而是“eta 会话语义 + Meldwork 治理”。
- 权限/租约/进程相关的测试继续有效。
- UI 仍然不暴露敏感执行细节；Room 根目录如需显示，作为显式只读例外。

## ADR-N9：外部 CLI 的 Session 和压缩由 Runtime 拥有

**背景：** Meldwork 的 Worker 是 Claude Code/Codex 等外部 CLI，不是 eta 的内置 kernel。平台无法读取或改写它们的上下文。

**决定：**
- 平台只保存 `native_session_ref`、Provider、baseline 和水位。
- resume 由 runtime adapter 调用 CLI 自己的恢复机制。
- 压缩由 CLI 自己做；平台只做有界简报、session 轮换和一次性 handoff。
- 上下文溢出时轮换 session，不无限重试。
- **Phase 2 必须做 resume proof**：Claude Code/Codex 各自验证“resume 后接着上次上下文”；失败则停止并改设计。
- 只有在未来引入平台自管 runtime 时，才移植 eta-compaction。

**后果：**
- 不同 CLI 的 session/steer/压缩能力不同，需要 capability matrix。
- 平台不能保证“所有 Agent 看到同样的完整历史”；它保证“每个 Agent 收到自己没看过的新消息”。
- `last_seq` 只是投递水位，不是记忆保证。

## ADR-N10：一次性迁移，旧引擎退役

**背景：** 旧 workspace JSON、旧 room DB、旧 checkpoint 状态都包含与目标模型不兼容的字段。

**决定：**
- 新账本使用干净 schema，目录 `desktop/src/room/`。
- 旧数据由一次性迁移工具导入或归档；迁移后旧库只读。
- 旧引擎、旧 runner、旧 UI 入口在迁移完成后删除。
- 迁移失败回滚新库，旧库不动。
- 迁移必须 dry-run、幂等、可回滚，并有 source→target 矩阵。

**后果：**
- 需要备份和迁移报告。
- 旧 session 无法恢复时，新 Task 从新 session 开始。
- 不再维护旧数据格式的兼容代码。

## ADR-N11：Report 是任务结果的领域真源；验收是用户命令

**背景：** v2 已经有 Report/状态推导；eta 用 `finish_task`。两者可以对齐，但必须解决“accept Artifact 是否等于 done”和 `handoff` 谁创建下一次 run。

**决定：**
- Report 的 kind 至少包含 `progress/ready/waiting/blocked/failed/handoff`。
- Task 状态由最新 required run 的 Report、TaskRun 事实和用户命令推导。
- 没有 Report 不能把 Task 置 `done`。
- 自由文本不能作为完成依据；工具优先，严格标记作为 fallback。
- `finish_task` 是完成声明，不是结算：Task 保持 `in_progress`，直到进程退出确认、after 快照完成、Artifact ID 合并并校验后，才进入 `in_review`（ready）或 `blocked`。
- 用户 `accept_task` 只能在结算完成后调用；`reject_task` 回到 `todo`。
- Artifact 状态（draft/published/accepted/rejected/superseded）与 Task 状态独立；accept Artifact 不自动 done。
- `handoff` Report 只记录建议；实际 `handoff_task` 是用户命令。

**后果：**
- 需要稳定的 Report 解析和归属校验。
- 需要新增 `accept_task` / `reject_task` 用户命令，并带 `commandId`。
- 用户仍然是最终验收者。

## ADR-N12：Attention/Inbox 是唯一的用户打断通道

**背景：** v2 有 Attention、Human Gate、通知；eta 有 Inbox。多个通道会让用户不知道去哪里处理。

**决定：**
- 所有需要用户处理的事项（blocked、in_review、提问、unknown、权限/成本请求、Artifact 接受）进入统一的 Attention/Inbox。
- 同一问题确定性去重；回答回到原 session，或按 runtime 能力排队 continuation run。
- 通知可合并，不逐条弹窗。
- Attention 正文不包含敏感路径、Prompt 或凭据。
- 所有改变状态的回答/命令带 `commandId`。

**后果：**
- UI 只需要一个收件箱/Attention 面板。
- 需要定义 Attention 生命周期和幂等回答。
- 用户离开当前 Chat 时仍能看到待处理事项。

## ADR-N13：Room 主目录是默认工作区，Chat 回复只读

**背景：** 用户的原则是“并行思考可以各自草稿，lead 合并；绝不两个 writer 写同一文档”。默认复制 worktree 会把环境准备、合并和发布的复杂度转移给平台。

**决定：**
- 默认所有 Agent 在 Room 主目录工作，写入用独占租约串行化。
- **Chat 回复默认只读**（`read-only` 或 `read-exec`）；写入只发生在获得用户授权和 writeScopes 的 TaskRun。
- per-seat 权限决定谁能写；`task_runs.write_scopes_json` 在创建时冻结。
- 隔离 worktree/临时 workspace 作为后续可选能力，只用于探索或高风险任务。
- Artifact 用 shadow Git commit/diff 记录版本。

**后果：**
- 共享目录下不同 Chat 的写入仍可能竞争；平台保证同一 Room 的写入租约。
- 需要清晰的 Artifact 发布/接受语义。
- 不在第一阶段实现 worktree 自动化。

## ADR-N14：eta 只复用机制，不复用运行时

**背景：** eta 是 TypeScript/Bun + cordis + WebSocket + daemon；Meldwork 是 CJS/Electron + preload + 本地 CLI。

**决定：**
- 只移植纯逻辑或按语义重写：routing、briefing、session keys、task queue、report 推导、Captain review supervisor。
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

## ADR-N16：Captain review 复用 eta 的 supervisor，不做 completion wake

**背景：** 需要让“Captain Prompt 定义 workflow”在多阶段场景下稳定推进。外部讨论提出“每个阶段完成唤醒 Captain 一次”，但 eta 已有更简单、更成熟的机制。

**决定：**
- 不新增 “Captain completion wake”、独立 completion 预算或 `stage_complete` 工具。
- 复用 eta 的 Captain review supervisor：
  - 60 秒 tick 是兜底；**任何领域变化**（消息追加、Task、run、inbox、conversation state）经由 `changed()` 触发 150ms debounce；
  - 检查已结算的 Captain assignment：目标没有 queued/working/stopping；关联 Task 不能还是 todo/in_progress 或还有未结束 run；blocked/stalled；
  - `hasNew` 的比较：

```text
activityBaseline = max(checkpoint, 各未取消 assignment 的 public 消息 seq)
hasNew = chat.activity_seq > activityBaseline
```

  - `assign_in_group` 的消息、`captain_assignments` 记录、目标的 queued reply 行同一事务写入，然后 `requestTick()`；指派消息本身不算“指派之后的新活动”；
  - 没有 Task 的 assignment 回复也能生成 `assignment_settled`；
  - 有 Task 时，`finish_task` 的 Chat 消息先推进 `activity_seq`，但 Task 在结算完成前仍是 `in_progress`；review 等 Task 进入 `in_review`/`blocked` 后才触发；结算状态变化也 `requestTick()`；
  - review 行和**平台为这次 review 投递创建的那条 reply** 标 `audience=captain`，**不计入 `chat.activity_seq`**；`reviewReply=true` 只打在这条 reply 上，`assign_in_group` / `post_in_chat` 是另外的 public 消息，不继承；
  - 批量、checkpoint、dedupe、attempts/backoff；只合并同一个 Chat 的 pending review；
  - review 以 `system` 消息进入 Captain 会话，并创建一条 queued reply；`mentions: []`，不占 5 次 agent-to-agent 预算；
  - 只在 Captain 空闲时投递。
- `finish_task` 在来源 Chat 追加 Agent 消息，推进 `chat.activity_seq`；supervisor 由此看到新活动。
- review 正文是观察，不是上一环全文；Captain 通过增量简报读取实际 public 消息。
- Captain Prompt 按 Chat 保存 revision；review 附带当前 revision，平台不解析 Prompt、不做状态机。

**后果：**
- 三阶段 workflow：3 次 `assign_in_group` 是普通消息 + @，不写 `kind=mention`，**不占 5 次**；3 次 system review 也不占。5 次只约束 Agent 的 `mention` 工具调用，不限制 `assign_in_group` 的阶段数；平台仍校验并发/成本。
- review 行和 review reply 不推进 `activity_seq`，所以不会因为它们自己再次触发 `assignment_settled`；但 `post_in_chat` 是 public，目标空闲时仍可能再开一轮。Captain 的普通总结应放在 review reply；`post_in_chat` 只用于确需公开的通知。
- 已指派角色的 public 回复结束并空闲就会 review；未指派的回复、仍在 queued/working/stopping 的回复、以及关联 Task 仍 todo/in_progress 或还有未结束 run 时不触发。
- 不需要自创 loop guard；checkpoint/dedupe/idle 检查已经覆盖 review 流量；`post_in_chat` 例外由 Captain Prompt 约束。

## ADR-N17：Agent 间唤醒异步，平台不做隐式串行

**背景：** 用户测试的“Captain 做完再叫 Claude，Claude 做完再叫 Codex”不是 eta 的行为；一条消息里的多个 @ 同时开工，`mention` 也不等待。

**决定：**
- 多个 @ 并发唤醒；同一 participant/lane 串行，不同 participant/lane 并行。
- `mention` / `assign_in_group` 不等待对方；调用方继续完成当前回复。
- 平台不提供隐式串行链；串行来自每一环自己 `mention`，或 Captain review supervisor 在 assignment 结算后唤醒 Captain。
- 5 次 wake budget 只统计 `kind=mention`，按 root user message 计数；`assign_in_group` 和 Captain review 都不占这个预算。
- Review supervisor 不是同步等待；它只是事件驱动的通知。

**后果：**
- 用户不能期待“Captain 自动等上一环完成”而不写 Prompt/mention。
- 需要 Captain review 来处理多阶段 workflow。
- 需要用户理解：直接 @ 执行角色会绕过 Captain workflow。

## ADR-N18：隔离前，写入型 run 每个 Room 同时一个

**背景：** 群聊 session 带着完整工具；外部 CLI 有 Bash 和写文件；多个 Task 并行可能改同一个目录。仅靠“写入租约”不够直观，也不适合早期。

**决定：**
- 隔离 workspace 之前，每个 Room 同时最多一个写入型 TaskRun。
- 只读 run 可以并行（默认最多 2）。
- Chat 回复默认只读；不参与写入并发。
- Write scopes 在 run 创建时冻结；必须位于 Room 根目录 realpath 内；Role 权限必须允许写；用户必须已授权 Room 写。
- Room 写授权在运行中或 outcome=unknown 时不能变更。

**后果：**
- 早期不会出现两个 Agent 同时改同一目录。
- 并行探索仍可通过只读 run 进行。
- 未来引入隔离 workspace 后，再放宽写入并发。

## ADR-N19：Agent 工具必须 MCP 优先、严格标记兜底

**背景：** 方案把 `mention` / `create_task` / `finish_task` 当工具用，但当前代码没有 MCP server；唯一的结构化协议是 v2 Report 标记。只有 Report 有通道，交接和建 Task 会断。

**决定：**
- main 为每次 run/session 起一个本地 MCP server；工具包括 `mention`、`create_task`、`comment_task`、`finish_task`、`list_tasks`、`get_task`、`read_task`、`read_chat`、`request_attention`。
- 身份由 MCP server 绑定，不接受工具参数里的 author/actor/runId。
- 工具结果必须回传给运行中的 session；MCP 是完整工具循环，不是一次性标记。
- 调用 ID 由 MCP server/平台生成并记录；不要假设 CLI 或模型提供稳定的 `toolCallId`。幂等键用 `(runId, toolName, canonical args)` 或 server 调用 ID，跨重试保持不变。
- 只有执行者 lane 的 active run 能调用 `finish_task`；mention lane 只有读/评论/mention/ask 工具。
- 不支持 MCP 的 CLI 只能用严格文本标记做**受限降级**：一次回复只应用一个终止动作，没有工具结果回传，不能 `list_tasks`/`get_task` 后继续决策，也不能同一回复里先 `create_task` 再 `comment_task`。
- Captain 工具（`assign_in_group`、`post_in_chat`、proposal、`control_task`）需要 MCP；标记协议没有闭环的授权/结果返回。
- 不支持工具通道的 CLI 只能作只读讨论参与者，或由用户手动触发下一步。

**后果：**
- 需要实现 MCP server、工具结果回传和身份绑定；这是 Phase 2/3 的硬依赖。
- Codex/Claude Code 的 MCP 支持需要验证；失败时只能用受限标记，不能声称完全自主。
- 工具调用幂等和作者绑定成为平台不变量。

## ADR-N20：Effect 成功 = 启动已确认，不等于运行结束

**背景：** 方案要求多角色并发、所有启动走 effect；当前 pump 会 await 整段 run，如果直接复用会把并发串行化，并混淆“启动成功”和“运行完成”。

**决定：**
- `start_reply` / `start_run` effect 成功只表示平台已领取并确认**进程已启动/已登记**。
- effect pump 启动进程、写 `session_started`/ProcessRegistry 记录后即标记 succeeded 并释放；不 await 整段 run。
- 长运行由 reply 行 / TaskRun 持有；participant/lane 串行、机器槽位、写入租约分别记录。
- 启动失败 → effect failed；进程已启动但确认丢失 → effect unknown + Attention；运行结果单独写 reply 状态 / TaskRun outcome。
- 并发由 participant/lane、机器槽位和租约控制，不是由 pump 串行控制。
- 重启：pending start effect 可继续消费；running effect 转 unknown；未确认退出的 run 保持 interrupted/unknown；不自动重放写操作。

**后果：**
- 需要把“启动”和“运行”拆成两个生命周期；不能直接把现有 pump 的 await 整段 run 搬过来。
- 并发、恢复和租约的归属必须在实现前写清。

## ADR-N21：Captain assignment 的因果链与自派发边界

**背景：** Captain 的可见授权、目标回复、原生调用、工具调用和 Task 之间需要可追溯的绑定；同一角色可能收到多个排队授权；Captain 还可能把自己作为默认目标。

**决定：**
- `assign_in_group` 的可见消息、`captain_assignments` 记录、目标的 queued reply 行在同一事务写入，然后 `requestTick()`。
- 每个目标 reply 行存 `captain_assignment_id`；run、MCP 工具 server 和 `create_task` 从这条 reply/run 继承 assignment id，不按“该角色最近一次 assignment”推测。
- Captain assignment 触发的 Task 由接收者自己执行；`create_task` 不能把 assignee 改成另一个角色。用户之后可以用 `handoff_task` 改派。
- `assign_in_group` 不得把 Captain 自己作为目标；省略目标时只有恰好一个非 Captain active 角色才默认给它；零个或多个都返回错误，不回落到 Captain。
- 同一角色多个排队 assignment 时，每个 reply 行保留自己的 assignment id；重启后来源链仍可恢复。

**后果：**
- 不会因为“最近一次 assignment”把 Task 挂错授权。
- 不会出现 Captain 自我唤醒/自我派发的循环。
- 授权来源链成为 Task/Run 的持久事实，不是 Prompt 猜测。

## 首轮实施选择（2026-11-17）

| 问题 | 选择 | 对应 ADR |
| --- | --- | --- |
| 1. Worker 运行时 | 第一阶段只接外部 CLI | ADR-N9 |
| 2. Captain 粒度 | 每个 Chat 一个 Captain Role | ADR-N6 |
| 3. Task 创建 | 默认直接 `create_task`；`draft_task` 可选；不增加用户审批 | ADR-N2 / ADR-N15 |
| 4. 平台 Controller | 不保留隐藏 Controller | ADR-N2 / ADR-N6 |
| 5. Report 通道 | MCP `finish_task` 优先；标记只做受限降级 | ADR-N11 / ADR-N19 |
| 6. Task 验收 | 完成声明 → 结算（退出+快照）→ `in_review` → 用户接受 → `done` | ADR-N11 / ADR-N12 |
| 7. Captain 协调 | eta review supervisor；不做 completion wake | ADR-N16 / ADR-N17 |
| 8. 水位归属 | participant/lane，不在 session | ADR-N3 / ADR-N4 |
| 9. Chat 权限 | 默认只读；写入只在 TaskRun | ADR-N13 / ADR-N18 |
| 10. 工具通道 | MCP 完整循环；标记只支持单一终止动作 | ADR-N19 |
| 11. Effect 生命周期 | 成功 = 启动已确认，不是运行结束；pump 不 await 整段 run | ADR-N20 |
| 12. Assignment 因果 | 授权消息 + assignment + queued reply 同事务；reply 存 assignment id；禁止自我派发/改派 assignee | ADR-N21 |
| 13. finish_task | 完成声明与结算分离；退出确认/快照后才 in_review | ADR-N11 |
| 14. 不支持 MCP 的 CLI | 只能只读参与或受限标记终止动作，不能声称完全自主 | ADR-N19 |

## 评审吸收

| 评审问题 | 处理 |
| --- | --- |
| Agent 工具没有传输通道 | ADR-N19；02/04 增加 MCP + 标记章节 |
| 重启恢复与反目标冲突 | 03 6.4 改为 interrupted/unknown + Attention；进程对账后再启动 |
| Task 验收状态机矛盾 | ADR-N11；04 加状态转移表、accept_task/reject_task、Artifact 独立 |
| Session 指针所有权分裂 | ADR-N7；SessionStore port 写 SQLite；新路径不写 workspace JSON |
| Schema 缺 TaskActivity/revision/client_id/lane/required/writeScopes | 02 schema 补齐 |
| 外部 CLI 不支持 same-turn 评论/回答 | 03/04 明确 queue continuation run；能力矩阵 |
| Captain 跨 Chat 风险 | ADR-N6；工具限定所属 Chat |
| 删除计划不闭合 | 06 增加依赖顺序、目录改名、LocalWorkspace/ProjectService 解耦 |
| 工具/Report 幂等与作者绑定 | ADR-N19；04 工具传输；05 说明 |
| 迁移只是草图 | 06 增加 source→target 矩阵、dry-run、回滚 |
| Renderer 路径不变量 | ADR-N8；02/07 定义 display-safe DTO |
| `assign_in_group` 两行描述错误 | 03/04/05 修正为一条带 @ 消息 |
| `last_seq` 表位置不一致 | ADR-N3/N4；统一到 participant/lane |
| 聊天回复直接 invokeAgent | 02/03 改为 start_reply effect |
| completion wake 过度设计 | ADR-N16；改为 eta review supervisor |
| resume 未证明 | ADR-N9；Phase 2 proof gate |
| `hasNew` 少了指派消息水位 | 03/04/07/08 改为 `activityBaseline = max(checkpoint, assignment 消息 seq)` |
| 150ms 触发源写窄 | 改为任何领域变化（消息追加、Task、run、inbox、conversation state） |
| 批量跨 Chat | 改为只合并同一个 Chat 的 pending review |
| review 流量/`post_in_chat` 例外 | `reviewReply=true` 只打在 review 投递的 reply 上；`post_in_chat` 是 public，可能再次触发 |
| Effect 成功时点未定义 | ADR-N20；成功 = 进程已启动/登记，pump 不 await 整段 run |
| 标记协议不能当完整工具 | ADR-N19；MCP 完整循环；标记只支持单一终止动作，无结果回传 |
| `finish_task`/退出/快照结算缺失 | ADR-N11；完成声明 → 退出确认 → 快照 → 结算 → in_review/accept_task |
| Captain 自我派发 | ADR-N21；不得以 Captain 自己为目标；无合法目标就报错 |
| Assignment 因果链不完整 | ADR-N21；授权消息 + assignment + queued reply 同事务；reply/run/tool 绑定 assignment id；禁止改派 assignee |
| 简报裁剪后无补读 | 02/04 增加当前 Chat 的分页 `read_chat`；编辑产生新活动 |
| Task/TaskRun/Effect 状态不闭合 | 04 统一 Task 状态、TaskRun status+outcome、Effect 生命周期 |
| 迁移未覆盖 v2/活跃执行/Trace/Artifact | 06 增加 v2 source→target、unknown/active 处理、Trace/shadow Git/session 校验 |
| Controller 被说成平台算法 | 修正：Controller 本身也是被隐藏/JSON 约束的 Agent |
| sidecar 与 local-first 表述不准确 | 修正：本地 sidecar 不必然违反 local-first；不选它是因为运行时/数据/权限/打包成本 |
| eta `session-key.ts` 路径质疑 | 本地 eta 快照 `03197d88` 中该文件存在；05 固定参考提交 |

## 被取代的旧决策

| 旧决策 | 新决策 | 原因 |
| --- | --- | --- |
| `docs-new/06` ADR-003：Controller 创建/派发 Task | ADR-N2 / ADR-N6 | 平台不分解大任务 |
| `docs-new/06` ADR-005：v2 一次性原生调用、不持久化 sessionRef | ADR-N3 / ADR-N4 | Agent 需要持续记忆和增量上下文 |
| `docs-new/README.md`：新旧引擎并存一段时间 | ADR-N1 / ADR-N10 | 早期阶段，避免双轨 |
| `docs-new/07`：旧 Chat 保留 legacy 行为 | ADR-N1 / ADR-N10 | 单一目标架构 |
| `docs-new/06` ADR-007：首版不做跨 Chat 依赖等 | 保留 | 本文件不改变该范围 |
| `docs-new/06` ADR-001：Room 主目录 + 隐藏辅助目录 | ADR-N13 / ADR-N18 | 保留主目录，增加 Chat 只读和写入并发 1 |
| 自创 Captain completion wake | ADR-N16 | 复用 eta review supervisor，避免过度设计 |
