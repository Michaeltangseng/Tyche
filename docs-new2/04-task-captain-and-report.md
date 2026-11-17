# 04 任务、Captain 与 Report

本文档定义工作如何被创建、执行、报告和验收。核心原则：**Agent 自己拥有工作；平台记录事实、校验边界、调度运行，但不替 Agent 拆任务。**

## 1. Task 的归属

### 1.1 谁创建 Task

- **只有 Agent 能在 Chat 中创建 Task。**
- 用户不直接“新建 Task”；用户通过消息表达需求，由 Agent 判断是否建 Task。
- Captain 不替目标 Agent 建 Task；它只发可见的工作授权，目标 Agent 自己建。

Agent 工具：

```text
create_task(title, description, acceptance, workspace?, parent_task_id?,
            blocked_by?, optional?, assignee_role_id?)
draft_task(title, description, acceptance, workspace?, parent_task_id?,
           blocked_by?, optional?, assignee_role_id?)
list_tasks(filter?)
get_task(taskId)
read_task(taskId, beforeSeq?, limit?)
read_chat(beforeSeq?, limit?)
update_task(taskId, title?, description?, ...)
comment_task(taskId, text)
finish_task(taskId, summary, status, evidence?, artifact_ids?)
            // status=ready|blocked；ready 是完成声明，不是 in_review
```

### 1.2 create_task 与 draft_task

- **`create_task`（默认）**：Agent 判断需要独立执行时直接创建并入队。不要求用户预先确认；这是首轮完整能力的一部分。Agent 必须在描述中写清触发它的用户消息、目标、验收标准和工作区。
- **`draft_task`（可选）**：当 Agent 主动希望用户先看一眼目标、范围或成本时使用。时间线上出现 `task_draft` 卡；用户确认后变成 Task 并入队。平台不强制使用 draft。
- 两者都要求描述是“给一个完全不了解前情的人”写的；执行 Task 的 session 看不到来源 Chat 的历史。
- 平台仍然校验 Role/Provider/Chat 归属、权限、并发和成本；这些是安全/资源边界，不是任务创建的用户审批。

### 1.3 执行者

- 默认执行者是创建者。
- `assignee_role_id` 可选；如果指定，必须是当前 Chat 的 active Role，且 Provider/能力满足任务要求。
- **Captain 授权触发时**：执行者就是被授权的接收角色；`create_task` 不能把 assignee 改成另一个角色。改派只能走用户 `handoff_task`。
- `create_task` 的 `captain_assignment_id` 从当前 reply 行/run 继承，不按“该角色最近一次 assignment”推测；同一角色多个排队授权时，每个 reply 保留自己的 assignment id。
- 平台校验 Task、Role、Chat 的归属；跨 Chat 分配一律拒绝。
- 用户可以 `handoff_task` 把已结束的失败/等待尝试交给另一个 Role；这是用户命令，不是 Agent 自由改派。
- Agent 可以在 Report 里建议 `handoff`，但那只创建一次确认/Attention，不自动改派。

### 1.4 Role 的加入与权限

- Role 由用户创建或确认；Captain 可以 `propose_role`，但不能直接创建。
- Role 绑定 Provider/模型、Prompt revision、能力、原生权限模式、Skill 绑定。
- Role 加入 Chat 后成为 Participant；每个 Chat 有自己的 session，不与其他 Chat 共享上下文。
- Role 是 Chat 级的，不跨 Chat 共享。同一个 Provider 如果出现在两个 Chat，是两个 Role、两个 session。
- 移除 Role 不删除历史；它正在进行的回复停止，已写的消息和 Report 保留。
- 用户修改 Role Prompt 或权限时，只影响之后创建的 run；历史 run 保留原 revision。现有 session 在下次唤醒时按 3.3 的条件决定 reuse/rotate。

## 2. Task 生命周期

```text
create_task ─────────────────────▶ todo ──(队列启动)──▶ in_progress
draft_task ──(用户确认)──────────▶ todo
backlog（可选，不立即运行）──────▶ todo
                                    │
                                    ├─ finish_task(ready) ──▶ 完成声明（仍 in_progress）──▶ 结算：退出确认 + 快照 ──▶ in_review ──(用户 accept_task)──▶ done
                                    ├─ finish_task(blocked) ─▶ 结算完成 ──▶ blocked ──(用户回答/评论)──▶ todo
                                    ├─ required run failed ──▶ blocked + Attention（或 todo，若已排队重试）
                                    └─(用户 stop_task)──▶ cancelled
                                    │
                                    └─(用户 handoff_task)──▶ todo（新 role / 新 run）
```

- Task 状态由平台根据 Report、TaskRun 事实和用户命令推导；Agent 不能直接设置 `done/cancelled`。
- `in_review` 表示平台已完成结算（退出确认 + 快照 + Report/Artifact 校验），等待用户验收；`done` 需要用户 `accept_task`。
- `blocked` 表示 Agent 需要用户输入；用户的评论或回答会把它推回队列。
- `cancelled` 表示用户不再要求执行；运行中的 run 要先停止并确认退出。
- Task 没有独立的 `failed` 状态；失败是 TaskRun 的事实。required run 失败后，Task 可以 `blocked` + Attention，或在已排队重试时保持 `todo`。

### 2.1 状态转移表

| 当前 | 事件 | 下一状态 | 条件 |
| --- | --- | --- | --- |
| — | `create_task` | todo | 默认；可选 backlog |
| — | `draft_task` + 用户确认 | todo | 用户确认 |
| todo | TaskRun start | in_progress | effect 成功 = 进程已启动/登记，不是 run 完成 |
| in_progress | `finish_task(ready)` | in_progress | 执行者 lane 的 active run；完成声明，等待退出与快照 |
| in_progress | 结算完成：退出确认 + 快照 + Report 校验 | in_review | ready Report；Artifact IDs 已合并 |
| in_progress | `finish_task(blocked)` | in_progress | 完成声明，等待退出与快照 |
| in_progress | 结算完成：blocked Report | blocked | 退出确认 + 快照完成 |
| in_progress | required run failed（known） | blocked | 创建失败 Attention；若有排队重试则 todo |
| in_progress | 进程退出未知 | blocked | TaskRun interrupted/outcome=unknown + Attention |
| in_review | `accept_task` | done | 结算已完成；最新 required run 有 ready Report；required Artifact 已接受/发布 |
| in_review | `reject_task` | todo | 创建 revision 评论；可排队 continuation run |
| blocked | 用户评论/回答 | todo | 平台把评论送入 task session 或排队 continuation run |
| todo/in_progress/in_review/blocked | `stop_task` | cancelled | 用户命令；TaskRun 停止另行确认 |
| blocked | `handoff_task` | todo | 目标 Role 属于同一 Chat；原 run 已结束（TaskRun failed/interrupted 是事实，不是 Task 状态） |
| cancelled | — | — | 终态；用户需显式重开 |

- Artifact 状态与 Task 状态独立：`draft | published | accepted | rejected | superseded`。接受 Artifact 不自动把 Task 置 `done`；`accept_task` 是 Task 级命令。
- `accept_task` / `reject_task` 必须带 `commandId`，幂等；同一命令重放返回原结果。
- `finish_task` 只能由执行者 lane 的当前 active run 调用；mention lane 不能调用。

### 2.2 Task 编号

- `number` 在 Room 内自增，不复用；删除/取消不回收。
- 迁移旧数据时保留原编号；冲突时新增编号并记录映射。

## 3. TaskRun 与 lane

### 3.1 表就是队列

```text
TaskRun
  id
  task_id
  lane_id
  role_id
  status          // queued | starting | running | completed | failed | interrupted | cancelled
  outcome         // pending | known | unknown
  snapshot_state  // not_applicable | pending | completed | failed | unknown
  session_id
  required        // 该 run 是否阻塞 Task 完成
  continues_run_id
  previous_run_id
  machine
  workspace_ref
  write_scopes_json
  queued_at / started_at / ended_at
  reason
```

- 一个 Task 的执行者 lane 同时最多一个未结束的 run。
- 每个被 mention 的角色有独立 lane，可以有自己的 run；执行者 lane 与 mention lane 可以并行。
- 队列按 `queued_at` 排序。
- 启动条件：该 lane 的上一个 run 已结束；目标机器在线；该机器有空闲槽位；Room 的写入租约可用（写入型 run）。
- 每台机器默认最多 2 个并发 run；**但隔离 workspace 之前，每个 Room 同时最多 1 个写入型 run**。只读 run 可以并行。
- `pump()` 在以下时刻调用：新 run 入队、run 结束、机器上线、并发上限改变、Task 状态/依赖改变。
- TaskRun 是业务队列；启动原生进程是 effect。queued TaskRun 先写 `start_run` effect；**effect 成功 = 进程已启动/已登记，不是整次 run 完成**。effect pump 启动进程后即标记 succeeded 并释放，不能 await 整段 run；run 的 outcome 由 TaskRun 单独记录。
- 并发由 lane、机器槽位和写入租约控制，不是由 effect pump 串行控制。同一 lane 的 run 串行；不同 lane 可以并行启动。
- effect 结果未知时保留 run 为 `interrupted/outcome=unknown`，进程对账后再决定；不自动重放。

### 3.2 Task Session 与 lane

- 执行者 lane：`task:<taskId>:role:<executorRoleId>`，跨 run 复用；`rerun` 创建新 generation。
- mention lane：`task:<taskId>:role:<mentionedRoleId>`，每个角色独立。
- 一个 Task 每个 lane 一个 session，`last_seq` 属于 lane，不属于 session。
- Task session 看不到来源 Chat 的历史；它只拿 Task 本身、TaskActivity 和评论。

### 3.3 首次 run 的 prompt

```text
Task #<number>: <title>

Goal:
<description>

Acceptance:
<acceptance>

Source chat: <chat title> (<chatId>)
Workspace: <path or worktree>
Report with finish_task when done, or when you are blocked.

Do not merge into the main branch unless the task says so.
```

### 3.4 评论续跑

- run 进行中：
  - runtime 支持 mid-turn input：评论作为 user 消息送入该 run；
  - Claude Code / Codex 等一次性 CLI：不支持送入当前 run。评论排队为 continuation run，或作为 TaskActivity 等待下一次 run。
- 没有 run 进行中：评论创建 continuation run，`continues_run_id` 指向它继续的那次 run；复用同一个 lane session。
- 评论是“继续做”，不是“重新开始”；Agent 已经知道上面发生过什么。
- Agent 自己的评论不回灌给自己，也不唤醒自己。
- 同一个 `clientId` 的重试只投递一次、只唤醒一次。
- Task 评论进入 `task_activities`，有独立 `seq`；Chat 里可以选择性投影一条消息，但 lane 水位用 TaskActivity 的 seq。

### 3.5 rerun

- `rerun` 明确表示“丢弃记忆，重新开始”：创建新一代 lane session，重新发首次 run 的 prompt。
- 旧 run 和旧 session 保留在历史中；不删除证据。
- `rerun` 是用户命令；Captain 的 `control_task` 只能 continue/pause，不能 rerun/stop/delete。

### 3.6 完成声明与结算

`finish_task` 是**完成声明**，不是结算完成。

1. Agent 调用 `finish_task(taskId, summary, status)`，`status=ready|blocked`：
   - 写 Report(kind=ready/blocked)；
   - 摘要成为 TaskActivity 评论；
   - 平台以 Agent 身份把“#编号 标题 + 摘要”发回来源 Chat，推进 `chat.activity_seq`；
   - Task 仍保持 `in_progress`（或等待状态），**不立即进入 `in_review`**。
2. 平台等待进程退出确认。
3. 退出确认后，按 run 类型结算：
   - **写入型 run**：在租约内完成 after 快照，生成 Artifact IDs 并合并进 Report；`snapshot_state=completed`。
   - **只读 run**：没有写入租约和快照；平台根据运行权限写入 `snapshot_state=not_applicable`，只校验 Report。`not_applicable` 不能由 Agent 自报，也不能作为快照失败的兜底。
   - **快照失败**：`snapshot_state=failed`；Task 不进入 `in_review`/`blocked`，保留 `in_progress`/`blocked` + Attention。
4. 校验 Report 归属、Artifact 范围和快照结果后，Task 才进入 `in_review`（ready）或 `blocked`，并释放 lane、机器槽位和写入租约。
5. `accept_task` 只允许在结算完成后调用；用户不能在进程仍在运行或快照未完成时接受。

边界：

- Agent 不能引用本次 run 尚未生成的 Artifact ID；平台在快照后补入。
- `finish_task` 后观察到进程非零退出：run → `failed/outcome=known`；Task → `blocked` + Attention；Report 保留但不能验收；快照/产物是否仍可生成另行判断，不能因此把退出事实改成 unknown。
- `finish_task` 后无法确认进程是否退出：run → `interrupted/outcome=unknown`；lane 阻塞到进程对账完成；Task → `blocked` + Attention；不自动重试，不伪造退出。
- run 安静结束但没有 `finish_task`：平台提醒一次；仍然没有报告则 run failed（known），Task → `blocked` + Attention。

## 4. Report

### 4.1 Report 是领域真源

```text
Report
  id
  task_id
  run_id
  lane_id
  kind            // progress | ready | waiting | blocked | failed | handoff
  summary
  evidence[]
  artifact_ids[]
  next_request?   // 例如请求另一个角色评审
  attention_id?
  created_at
```

- Report 是任务结果的领域真源；Event 只引用 Report，不重复维护一套状态。
- Task 状态由平台根据最新 required run 的 Report、TaskRun 事实和用户命令推导。
- 没有 Report 不能把 Task 推导为 `done`。
- `next_request` 只是建议，不自动派发；需要 Agent 自己 `mention`、Captain 发可见授权，或用户命令。
- `handoff` Report 只记录“建议交接”；实际交接是用户 `handoff_task`（或 Captain 提议后由用户确认）。
- Agent 提供的 `artifact_ids` 只能引用同一 Room 已存在的 Artifact；本次 run 的 Artifact 由平台在 after 快照后生成并合并，Agent 不能引用尚不存在的 ID。

### 4.2 Report 通道

- 优先 MCP 工具 `finish_task`；工具调用身份由 run/session 绑定。
- 不支持 MCP 的 CLI 用严格文本标记 fallback：

```text
[[MELDWORK_REPORT:{"kind":"ready","summary":"...","evidence":[],"artifacts":[]}]]
```

- 只接受最后一个标记；字段、kind、摘要、Artifact 归属严格校验。
- 标记后的自然语言可以作为补充说明，但不能覆盖结构化字段。
- 标记从可见正文和简报中剥离，避免二次进入上下文。
- 没有结构化报告时，平台不猜测完成状态：进程仍在运行则 run 保持 `running`；进程已退出则 `failed`（known）；退出未知则 `interrupted/outcome=unknown`，交给用户或 Captain 处理。

### 4.3 Task 状态推导

```text
最新 required run 的 Report:
  progress  → in_progress
  ready     → in_progress（完成声明）→ 结算完成后 in_review
  waiting   → blocked（run 仍 active 时可保持 in_progress）
  blocked   → blocked（结算完成后）
  failed    → blocked / todo（视重试）
  handoff   → blocked（等待用户或 Captain 决定）
```

- `waiting` 不是 Task 状态；它映射到 `blocked`（需要用户）或 `in_progress`（run 仍在进行）。
- `ready` 在退出确认、快照完成、Report/Artifact 校验完成之前不能进入 `in_review`。

- 可选 run 失败不阻塞 required 工作。
- 替代 run（retry/handoff）链上只计算最新的 required run；旧失败和迟到 Report 不覆盖新结果。
- 用户 `accept_task` 且 required Artifact 已接受/发布后，Task → `done`。
- 重复 `finish_task` 幂等；旧 run 的迟到 Report 被拒绝，不覆盖新 run。

## 5. Agent 工具传输

Agent 工具不能只存在于文档里；必须有明确通道。

### 5.1 首选：本地 MCP server

- main 为每次 run/session 起一个本地 MCP server，绑定 `runId`、`sessionId`、`chatId`/`taskId`、`roleId` 和允许的工具集合。
- 工具：`mention`、`create_task`、`draft_task`、`comment_task`、`finish_task`、`list_tasks`、`get_task`、`read_task`、`read_chat`、`request_attention`。
- 身份由 server 绑定，不接受工具参数里的 author/actor/runId。
- 只有执行者 lane 的 active run 能调用 `finish_task`；mention lane 只有读/评论/mention/ask 工具。
- 工具结果必须回传给运行中的 session（`create_task` 返回 taskId、`list_tasks` 返回列表等）；MCP server 是完整工具循环，不是一次性标记。
- **幂等身份是一次逻辑调用的 `callId`，不是参数 hash。** 平台/MCP server 首次接受调用时生成 `callId`，并在结果元数据返回；重试必须复用同一个 `callId`。如果传输不能保证重试复用 `callId`，不要承诺跨重试幂等：读工具每次都执行；写工具用领域唯一键兜底（`finish_task` 唯一 per task+run；`create_task` 唯一 per assignment+source message；`comment_task` 需要调用方提供幂等键）。
- `args hash` 只用于校验同一 `callId` 的参数一致性，不用于识别新调用；相同参数的新调用仍是新调用，读工具不得因参数相同而返回旧结果。
- MCP server 只监听 loopback，生命周期跟随 run；不把 token/凭据暴露给 CLI。

### 5.2 兜底：严格文本标记（受限降级）

```text
[[MELDWORK_TOOL:{"name":"mention","callId":"...","args":{"names":["reviewer"],"text":"..."}}]]
```

- **标记不是 MCP 等价物。** 每个回复只应用最后一个完整标记；没有工具结果回传，不能先 `create_task` 再 `comment_task`，也不能 `list_tasks`/`get_task` 后继续决策。
- 标记只适合一次**终止动作**：`mention`、`create_task`、`comment_task` 或 `finish_task` 中的一个；`finish_task` 与 Report 标记共用严格校验。
- 身份仍然由平台从 run/session 绑定；标记里的字段不能指定作者。
- 标记里的 `callId` 只是客户端重试键，不能当作平台身份；缺失或变化时按新调用处理，写工具用领域唯一键兜底，读工具每次都执行。
- Captain 工具（`assign_in_group`、`post_in_chat`、`proposal`、`control_task`）需要 MCP；标记协议没有闭环的授权/结果返回，不支持 Captain 自治。
- 不支持 MCP、也不支持标记的 CLI 只能作为只读讨论参与者；不能建 Task、mention 或 finish_task。

### 5.3 能力矩阵

Phase 2 必须为每个 CLI 记录并验证 resume、mid-turn steer、wait-for-input、MCP、tool result return / multi-call loop、压缩、cancel、并发 session。没有 mid-turn steer 的 CLI，评论和 Attention 回答一律排队为 continuation run。

## 6. Captain

### 6.1 Captain 是什么

- Captain 是 Chat 内的一个 **Role**，带 `is_captain=1`。
- 它有自己的 Participant Session，和普通 Agent 一样被唤醒、有记忆、受权限约束。
- Captain 不是平台内部的隐藏调度器；它说的话、发的授权、做的建议都落在 Chat 时间线上。
- Captain 的 `author_type` 是 `agent`；UI 用 `is_captain` 徽章标识，不设特殊 author type。
- 一个 Chat 默认一个 Captain；没有 Captain 时，路由退回“显式 @mention / 唯一参与者”。

### 6.2 Captain 工具（限定在所属 Chat）

```text
assign_in_group(chatId, text, roleIds?, mode?)
post_in_chat(chatId, text)
list_roles()
read_role(roleId)
list_tasks(filter?)
read_task(taskId)
read_chat(beforeSeq?, limit?)     // 只限当前 Chat 的历史分页
read_inbox(pendingOnly?)
request_attention(taskId?, type, question, options?)
control_task(taskId, action, text?)   // 仅 continue/pause；stop/rerun/delete 需用户命令
propose_role(...)                     // 用户确认后才创建
set_role_prompt(...)                  // 通常需要用户确认
```

- `chatId` 必须等于 Captain 自己的 Chat；跨 Chat 调用一律拒绝。
- `list_roles` / `read_role` / `list_tasks` / `read_task` / `read_chat` / `read_inbox` 只能访问所属 Chat 的对象；跨 Chat 的 roleId/taskId/messageId 一律拒绝。
- 不提供跨 Chat 的 `list_chats` / `read_chat`；Captain 只能看自己的 Chat。
- 不能读取其他 Chat 的任务、消息、Report、Trace 或 Attention。
- 不能授予新的 Provider、能力、写入范围或凭据。
- 不能直接设置 Task `done/cancelled`；不能 rerun/delete Task。
- `control_task` 的 continue/pause 也要经过平台校验和审计。

### 6.3 assign_in_group

- **一条可见消息**，带 @mentions；这条消息就是 assignment。它是普通 message，不是 `kind=mention`，不消耗 5 次 mention 预算。
- 被点名的 Agent 被唤醒；它们自己决定是否 `create_task`、如何执行。
- Captain 不创建 Task，也不替目标 Agent 指定执行者或 TaskRun。
- **不得把 Captain 自己作为目标**。如果没有 `roleIds`，只有恰好一个非 Captain active 角色时才默认给它；零个或多个都返回错误，不回落到 Captain，也不猜。
- **同一事务写入**：assignment 消息、`captain_assignments` 记录（含 `target_reply_ids`）、目标的 queued reply 行一起提交，然后 `requestTick()`。不要先写消息再异步排队，否则 150ms 快路径可能把刚发出的指派当成 `assignment_settled`。
- 被唤醒的 Agent 读到的是这条 assignment 消息的正文，而不是 Captain 还没写完的回复。

**注意**：`assign_in_group` 不是“回复一行 + mention 一行”。eta 的 `captain/service.ts:322` 只调用一次 `engine.send`，写一条带 @ 的消息。两行现象来自 `mention` 工具，不是 assign。

### 6.4 Captain review supervisor（复用 eta）

eta 没有“每个 Task 完成就单独唤醒 Captain”的机制。它用 supervisor：

- `captain/supervisor.ts` 每 60 秒 tick 是兜底；**任何领域变化**（消息追加、Task、run、inbox、conversation state）都会经由 `changed()` 触发 `requestTick()` 的 150ms debounce。不要只挂 task board；没有 Task 的聊天阶段也要走快路径。
- `captain/service.ts` 的 `observeReviews()` 检查已结算的 Captain assignment：
  - 目标成员没有 queued/working/stopping；waiting_for_input 归入 blocked 条件；
  - 关联 Task 不能还是 todo/in_progress，也不能还有未结束的 run；
  - `hasNew`，比较基线必须包含指派消息水位（见下）；
  - 或者 blocked / stalled。
- **`hasNew` 的比较**（对齐 eta `captain/service.ts:965-973`）：

```text
activityBaseline = max(checkpoint, 各未取消 assignment 的 public 消息 seq)
hasNew = chat.activity_seq > activityBaseline
```

  指派消息本身不是“指派之后的新活动”。`assign_in_group` 的可见消息、`captain_assignments` 记录、目标的 queued reply 行在同一事务写入，然后 `requestTick()`；目标立刻 queued，会被“目标仍忙”挡住。

- **没有 Task 也会 review**：目标角色回复结束并空闲、且 Chat 有 public 新活动，就生成 `assignment_settled`，不要求它建 Task。`hasNew` 比较整个 Chat 的 `activity_seq`，不按作者过滤；没有 assignment 的 Chat 不产生 assignment review，但存在未取消 assignment 时其他 public 活动也可能触发。挡住的是还在 queued/working/stopping 的回复，以及关联 Task 仍 todo/in_progress 或还有未结束 run。
- **有 Task 时等结算**：`finish_task` 的 Chat 消息先推进 `activity_seq`，但 Task 在结算完成前仍是 `in_progress`；review 等到 Task 进入 `in_review`/`blocked` 后才触发。结算引起的 Task 状态变化也必须 `requestTick()`。
- **review 流量不推进 activity 水位**：`chat.activity_seq` 只统计 public 消息，排除 `audience=captain` 的 review 行和平台为这次 review 投递创建的那条 reply（`data_json.reviewReply=true`）。`reviewReply=true` **只打在 review 投递的 reply 上**；`assign_in_group` / `post_in_chat` 是另外的消息，不继承这个标记，且是 public，计入 `activity_seq`。
- `post_in_chat` 是 public；目标已空闲时，它仍可能再开一轮 `assignment_settled`。Captain 的普通总结应放在 review reply（`audience=captain`）；`post_in_chat` 只用于确需公开的通知。
- `chat.activity_seq` 只供 supervisor 判断 public 活动；Captain 的 `chat_participants.last_seq` 仍是它的投递水位。review 行不推进 `activity_seq`，但会进入 Captain 的简报。
- `stalled` 判断的 `silentFor` 也只看最新 public 消息的更新时间；review 行和 Captain review 回复不算。
- 满足条件时创建 `captain_review`；`checkpoint_seq` 用 `activity_seq`，dedupe key 用 conversation + kind + checkpoint。
- 只在 Captain 空闲时批量投递**同一个 Chat** 的 pending review（最多 20 条 / 12k 字符）；不要跨 Chat 合并。
- review 以 `system` 消息进入 Captain 的会话，并创建一条 queued reply；`mentions: []`，不占 5 次 agent-to-agent 预算。
- review 正文是**观察**：assignment/task id、checkpoint、目标状态；不是上一环全文。Captain 通过正常增量简报读取水位之后、别人已经写完的 public 原文，再按 Prompt 决定下一步。
- Captain 的总结放在 review reply（`audience=captain`）；`post_in_chat` 是 public，会计入 `activity_seq`，可能触发下一次 review，只用于确需公开的通知。

**触发时序**：`finish_task` 的 Chat 消息先推进 `activity_seq`，但 Task 在结算完成前仍是 `in_progress`，所以 review 不会在快照前触发。退出确认 + after 快照 + Artifact 合并后，Task 进入 `in_review`/`blocked`；这个状态变化触发 `requestTick()`，supervisor 才 review。`in_review` / `done` / `cancelled` 不是 busy；`blocked` 走 `assignment_blocked`，不走 `assignment_settled`。

`hasNew` 比较的是整个 Chat 的 `activity_seq`；没有 assignment 的 Chat 不产生 assignment review。但只要存在未取消 assignment，其他 public 活动也可能推进 `activity_seq` 并触发 `hasNew`（与 eta 一致，不按作者过滤）。仍 queued/working/stopping 的回复、关联 Task 仍 todo/in_progress 或还有未结束 run 会挡住 review。

**不要**新增 `completion wake`、独立 completion budget 或 `stage_complete`。循环保护来自 `activity_seq` 排除 review 行和 review reply；`post_in_chat` 是 public，仍可能再开一轮，这是平台行为，不能靠 Prompt 保证。checkpoint/dedupe/idle 只覆盖 review 流量。

### 6.5 Captain 工作流 Prompt

- 每个 Chat 一份 Captain Prompt（`role_prompt_revisions`），用户可编辑。
- 平台不解析 Prompt、不做状态机、不验证阶段顺序。
- review 消息附带当前 Prompt revision（或轮换 Captain session），确保换 Chat / 改 Prompt 在下一轮生效。
- 示例：

```text
阶段按顺序只有三个：效果图、架构、实施。
一次只派当前未完成的阶段，只叫醒一个角色。不要提前派后面的阶段。
被唤醒后，根据时间线上已完成的结果决定下一步。
```

- 用户只 @ Captain（或不 @，Captain 是默认接收者）；如果直接 @ 执行角色，就绕过了 Captain workflow。
- `assign_in_group` 是普通消息 + @，不写 `kind=mention`，**不占 5 次 mention 预算**；5 次只约束 Agent 的 `mention` 工具调用。Captain 阶段数不受这个预算限制；平台仍校验并发、成本和写入边界。
- review 是 system 消息，也不占 5 次；3 阶段 = 3 次 assign + 3 次 review，可跑通。

### 6.6 与 v2 Controller 的区别

| v2 Controller | 目标 Captain |
| --- | --- |
| 本身也是 Agent，但被隐藏并约束为 JSON 动作生成器；有角色徽章/`note`，不是可自由对话的协作角色 | Chat 内 Agent 角色，所有发言可见 |
| 可以 `create_task` / `assign` | 只发可见授权；Task 由目标 Agent 创建 |
| 每批动作绑定 `controller_decisions` | 工具调用写 events/trace；review 队列单独 |
| 失败后自动 fallback 建任务 | 失败后只保留显式 @mention 路由，不猜任务 |
| 用结构化 JSON 动作驱动 | 用自然语言 + 工具调用驱动 |

保留的是**平台校验与审计**：Role/Provider/Chat 归属、权限、幂等、Task 状态推导、effects。丢弃的是**平台替 Agent 做任务分解**。

## 7. Attention 与 Inbox

Attention 是需要用户处理的事项：

- Task `blocked`；
- Task `in_review` 等待验收；
- Agent 的提问（ask）；
- 执行结果 unknown / 终止未确认；
- 权限、成本、Provider 变化请求；
- Artifact 接受/拒绝；
- Captain 建议交接/重试。

规则：

- 同一个问题只开一个 Attention；用确定性 ID 去重。
- Attention 回答后回到原 session，继续原来的 turn；如果 runtime 不支持等待输入，回答排队为 continuation run。
- 多个 Attention 合并到 Inbox；通知可合并，避免每个 Report 都弹一次。
- Attention 正文不包含敏感路径、Prompt 或凭据。
- 用户可以忽略/归档；忽略不等于同意。
- 所有改变状态的回答/命令必须带 `commandId`，幂等。

## 8. 工作区、权限与产物

### 8.1 工作区

- 默认所有角色在 Room 主目录工作。
- **Chat 回复默认只读**；默认 `read-only`。只有 CLI 能保证不写文件时，才允许 `read-exec`。写入只发生在获得授权的 TaskRun。
- 写入需要用户显式授权；授权绑定当前 Room 根目录 realpath。
- 同一 Room 的写入用独占租约串行化；一个角色写的时候，其他写入者等待。
- 隔离 workspace 之前，每个 Room 同时最多一个写入型 TaskRun；只读分析可以并行。
- 并行思考可以在各自草稿文件中进行，但最终交付文件只有一个 writer；这是用户的协作约定，平台用租约保证不并发写。

### 8.2 per-seat 权限

- 每个 Role 有原生权限模式：`read-only`、`read-exec`、`workspace-write` 等。
- 用户按角色配置；平台在启动 run 前校验，不能由 Prompt 改写。
- `task_runs.write_scopes_json` 在创建时冻结；必须非空、位于 Room 根目录 realpath 之内，且 Role 权限允许写。
- 省略 scopes 时使用 Task 的默认 scopes；默认是 Room 根目录（`.`），但仍要求用户已授权 Room 写。
- Room 写授权在运行中或 outcome=unknown 时不能变更。
- Controller/Captain 默认只读；Captain 不因为“主控”获得写权限。

### 8.3 Artifact

- Artifact 属于 Room，不属于 Chat。
- 写入型 run 在租约内做 shadow Git 快照；产生 commit/diff 引用；`snapshot_state=completed`。
- 只读 run 没有写入租约和快照；平台根据运行权限写 `snapshot_state=not_applicable`，不要求 Artifact。
- 快照失败时 `snapshot_state=failed`；Task 不能进入 `in_review`，创建 Attention，不把失败当成 `not_applicable`。
- Artifact 状态：`draft | published | accepted | rejected | superseded`；与 Task 状态独立。
- Report 可以引用已存在的 Artifact；Agent 不能凭路径或伪造 ID 创建版本。
- `accept_task` 只能在结算完成后调用：进程退出已确认、after 快照已完成、Artifact ID 已合并并校验；它可以要求 required Artifact 已接受/发布。接受 Artifact 本身不自动完成 Task。
- 接受是否恢复工作目录，后续单独定义；第一阶段只更新账本状态。

## 9. 不变量

1. Task 只能由 Agent 在 Chat 内创建；平台不替 Agent 建 Task。
2. Captain 只发可见授权；目标 Agent 自己建 Task、自己执行。
3. 一个 Task 的每个 lane 同时最多一个未结束的 run；执行者 lane 与 mention lane 可以并行。
4. 一个 Task 每个 lane 一个 session；执行者 lane 跨 run 复用，rerun 才重置；handoff 到另一个角色使用新 lane/session。
5. Report 是任务结果的领域真源；没有 Report 不能 done；`accept_task` 是用户接受，Artifact 状态不单独决定 Task 状态。
6. 用户命令和 Agent 工具都不能绕过权限、租约和 Report 推导。
7. Attention 回答回到原 session；不支持等待输入的 CLI 排队 continuation run。
8. 所有外部副作用先写 effects；聊天回复和 TaskRun 的进程启动都一样。
9. Agent 工具必须有 MCP 或严格标记通道；身份由 run/session 绑定，调用幂等。
10. Captain 工具限定在所属 Chat；不能跨 Chat 读取或写入。
11. Captain review 由 supervisor 驱动；不是每 Task 完成一个独立 wake，也不是每回复结束都唤醒。
12. Chat 回复只读；写入只在 TaskRun；隔离前每个 Room 同时最多一个写入型 run。
