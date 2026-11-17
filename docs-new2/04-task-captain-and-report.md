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
update_task(taskId, title?, description?, ...)
comment_task(taskId, text)
finish_task(taskId, summary, status, evidence?, artifact_ids?)
```

### 1.2 create_task 与 draft_task

- **`create_task`（默认）**：Agent 判断需要独立执行时直接创建并入队。不要求用户预先确认；这是首轮完整能力的一部分。Agent 必须在描述中写清触发它的用户消息、目标、验收标准和工作区。
- **`draft_task`（可选）**：当 Agent 主动希望用户先看一眼目标、范围或成本时使用。时间线上出现 `task_draft` 卡；用户确认后变成 Task 并入队。平台不强制使用 draft。
- 两者都要求描述是“给一个完全不了解前情的人”写的；执行 Task 的 session 看不到来源 Chat 的历史。
- 平台仍然校验 Role/Provider/Chat 归属、权限、并发和成本；这些是安全/资源边界，不是任务创建的用户审批。

### 1.3 执行者

- 默认执行者是创建者。
- `assignee_role_id` 可选；如果指定，必须是当前 Chat 的 active Role，且 Provider/能力满足任务要求。
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
                                    ├─ finish_task(ready) ──▶ in_review ──(用户 accept_task)──▶ done
                                    ├─ finish_task(blocked) ─▶ blocked ──(用户回答/评论)──▶ todo
                                    ├─ required run failed ──▶ blocked + Attention（或 todo，若已排队重试）
                                    └─(用户 stop_task)──▶ cancelled
                                    │
                                    └─(用户 handoff_task)──▶ todo（新 role / 新 run）
```

- Task 状态由平台根据 Report、TaskRun 事实和用户命令推导；Agent 不能直接设置 `done/cancelled`。
- `in_review` 表示 Agent 认为工作完成，等待用户验收；`done` 需要用户 `accept_task`。
- `blocked` 表示 Agent 需要用户输入；用户的评论或回答会把它推回队列。
- `cancelled` 表示用户不再要求执行；运行中的 run 要先停止并确认退出。
- Task 没有独立的 `failed` 状态；失败是 TaskRun 的事实。required run 失败后，Task 可以 `blocked` + Attention，或在已排队重试时保持 `todo`。

### 2.1 状态转移表

| 当前 | 事件 | 下一状态 | 条件 |
| --- | --- | --- | --- |
| — | `create_task` | todo | 默认；可选 backlog |
| — | `draft_task` + 用户确认 | todo | 用户确认 |
| todo | TaskRun start | in_progress | effect 成功启动 |
| in_progress | `finish_task(ready)` | in_review | 执行者 lane 的 active run |
| in_progress | `finish_task(blocked)` | blocked | 执行者 lane 的 active run |
| in_progress | required run failed | blocked | 创建失败 Attention；若有排队重试则 todo |
| in_review | `accept_task` | done | 最新 required run 有 ready Report；required Artifact 已接受/发布 |
| in_review | `reject_task` | todo | 创建 revision 评论；可排队 continuation run |
| blocked | 用户评论/回答 | todo | 平台把评论送入 task session 或排队 continuation run |
| todo/in_progress/in_review/blocked | `stop_task` | cancelled | 用户命令；TaskRun 停止另行确认 |
| blocked/failed/interrupted | `handoff_task` | todo | 目标 Role 属于同一 Chat；原 run 已结束 |
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
- TaskRun 是业务队列；启动原生进程是 effect。queued TaskRun 先写 `start_run` effect，effect 成功后才进入 running；effect 结果未知时保留 run 为 unknown，不自动重放。

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

### 3.6 结束

- Agent 调用 `finish_task(taskId, summary, status)`：
  - `status=in_review`（默认）→ Report(kind=ready)，Task → `in_review`；
  - `status=blocked` → Report(kind=blocked)，Task → `blocked`；
  - 摘要成为 TaskActivity 评论；
  - 平台以 Agent 身份把“#编号 标题 + 摘要”发回来源 Chat；这会推进 `chat.activity_seq`，供 Captain review 看到。
- 如果 run 安静结束但没有 `finish_task`：平台提醒一次；仍然没有报告则 run failed，Task 按 2.1 推导。
- 进程退出但未确认结果：run → `interrupted/unknown`；创建 Attention；不自动重试，不伪造退出。

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

### 4.2 Report 通道

- 优先 MCP 工具 `finish_task`；工具调用身份由 run/session 绑定。
- 不支持 MCP 的 CLI 用严格文本标记 fallback：

```text
[[MELDWORK_REPORT:{"kind":"ready","summary":"...","evidence":[],"artifacts":[]}]]
```

- 只接受最后一个标记；字段、kind、摘要、Artifact 归属严格校验。
- 标记后的自然语言可以作为补充说明，但不能覆盖结构化字段。
- 标记从可见正文和简报中剥离，避免二次进入上下文。
- 没有结构化报告时，平台不猜测完成状态；run 保持 waiting/interrupted，交给用户或 Captain 处理。

### 4.3 Task 状态推导

```text
最新 required run 的 Report:
  progress  → in_progress / waiting
  ready     → in_review
  waiting   → waiting
  blocked   → blocked
  failed    → blocked / todo（视重试）
  handoff   → blocked / waiting（等待用户或 Captain 决定）
```

- 可选 run 失败不阻塞 required 工作。
- 替代 run（retry/handoff）链上只计算最新的 required run；旧失败和迟到 Report 不覆盖新结果。
- 用户 `accept_task` 且 required Artifact 已接受/发布后，Task → `done`。
- 重复 `finish_task` 幂等；旧 run 的迟到 Report 被拒绝，不覆盖新 run。

## 5. Agent 工具传输

Agent 工具不能只存在于文档里；必须有明确通道。

### 5.1 首选：本地 MCP server

- main 为每次 run/session 起一个本地 MCP server，绑定 `runId`、`sessionId`、`chatId`/`taskId`、`roleId` 和允许的工具集合。
- 工具：`mention`、`create_task`、`draft_task`、`comment_task`、`finish_task`、`list_tasks`、`get_task`、`request_attention`。
- 身份由 server 绑定，不接受工具参数里的 author/actor/runId。
- 只有执行者 lane 的 active run 能调用 `finish_task`；mention lane 只有读/评论/mention/ask 工具。
- 工具调用带 `toolCallId`；平台按 `(runId, toolCallId)` 幂等，重复调用返回原结果。
- MCP server 只监听 loopback，生命周期跟随 run；不把 token/凭据暴露给 CLI。

### 5.2 兜底：严格文本标记

```text
[[MELDWORK_TOOL:{"name":"mention","callId":"...","args":{"names":["reviewer"],"text":"..."}}]]
```

- 每个回复只应用最后一个完整标记；标记从可见正文和简报中剥离。
- 身份仍然由平台从 run/session 绑定；标记里的字段不能指定作者。
- 标记协议必须覆盖 `mention`、`create_task`、`comment_task`、`finish_task`，不能只覆盖 Report。
- 不支持标记的 CLI 无法参与 Agent 间交接和建 Task；该 CLI 只能作为只读讨论参与者，或由用户手动触发。

### 5.3 能力矩阵

Phase 2 必须为每个 CLI 记录并验证 resume、mid-turn steer、wait-for-input、MCP、压缩、cancel、并发 session。没有 mid-turn steer 的 CLI，评论和 Attention 回答一律排队为 continuation run。

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
read_inbox(pendingOnly?)
request_attention(taskId?, type, question, options?)
control_task(taskId, action, text?)   // 仅 continue/pause；stop/rerun/delete 需用户命令
propose_role(...)                     // 用户确认后才创建
set_role_prompt(...)                  // 通常需要用户确认
```

- `chatId` 必须等于 Captain 自己的 Chat；跨 Chat 调用一律拒绝。
- 不提供 `list_chats` / `read_chat` 的跨 Chat 读取；Captain 只能看自己的 Chat。
- 不能读取其他 Chat 的任务、消息、Report、Trace 或 Attention。
- 不能授予新的 Provider、能力、写入范围或凭据。
- 不能直接设置 Task `done/cancelled`；不能 rerun/delete Task。
- `control_task` 的 continue/pause 也要经过平台校验和审计。

### 6.3 assign_in_group

- **一条可见消息**，带 @mentions；这条消息就是 assignment。它是普通 message，不是 `kind=mention`，不消耗 5 次 mention 预算。
- 被点名的 Agent 被唤醒；它们自己决定是否 `create_task`、如何执行。
- Captain 不创建 Task，也不替目标 Agent 指定执行者或 TaskRun。
- 如果没有 `roleIds`，消息交给 Chat 的默认接收者（Captain 自己或 steward）。
- 被唤醒的 Agent 读到的是这条 assignment 消息的正文，而不是 Captain 还没写完的回复。

**注意**：`assign_in_group` 不是“回复一行 + mention 一行”。eta 的 `captain/service.ts:322` 只调用一次 `engine.send`，写一条带 @ 的消息。两行现象来自 `mention` 工具，不是 assign。

### 6.4 Captain review supervisor（复用 eta）

eta 没有“每个 Task 完成就单独唤醒 Captain”的机制。它用 supervisor：

- `captain/supervisor.ts` 每 60 秒 tick 是兜底；领域变化（task board/report/run）触发 150ms debounce，通常很快唤醒 Captain，不需要等一分钟。
- `captain/service.ts` 的 `observeReviews()` 检查已结算的 Captain assignment：
  - 目标成员没有 queued/working/stopping；waiting_for_input 归入 blocked 条件；
  - 关联 Task 不能还是 todo/in_progress，也不能还有未结束的 run；
  - `chat.activity_seq` 超过上次 checkpoint（有新活动）；
  - 或者 blocked / stalled。
- **没有 Task 也会 review**：目标角色回复结束并空闲、且 Chat 有 public 新活动，就生成 `assignment_settled`，不要求它建 Task。挡住的是还在 queued/working/stopping 的回复，以及关联 Task 仍 todo/in_progress 或还有未结束 run。
- **review 流量不推进 activity 水位**：`chat.activity_seq` 只统计 public 消息，排除 `audience=captain` 的 review 行和 Captain 为 review 写的回复（`data_json.reviewReply=true`）。`assign_in_group` / `post_in_chat` 是 public，计入 `activity_seq`。否则 review 自己会推进水位，下一轮 tick 又看到“新活动”，形成循环。
- `chat.activity_seq` 只供 supervisor 判断 public 活动；Captain 的 `chat_participants.last_seq` 仍是它的投递水位。review 行不推进 `activity_seq`，但会进入 Captain 的简报。
- `stalled` 判断的 `silentFor` 也只看最新 public 消息的更新时间；review 行和 Captain review 回复不算。
- 满足条件时创建 `captain_review`；checkpoint 用 `activity_seq`，dedupe key 用 conversation + kind + checkpoint。
- 只在 Captain 空闲时批量投递（最多 20 条 / 12k 字符）。
- review 以 `system` 消息进入 Captain 的会话，并创建一条 queued reply；`mentions: []`，不占 5 次 agent-to-agent 预算。
- review 正文是**观察**：assignment/task id、checkpoint、目标状态；不是上一环全文。Captain 通过正常增量简报读取水位之后、别人已经写完的 public 原文，再按 Prompt 决定下一步。
- Captain 的总结放在 review reply（`audience=captain`）；`post_in_chat` 是 public，会计入 `activity_seq`，可能触发下一次 review，只用于确需公开的通知。

触发来源：`finish_task` 在来源 Chat 追加 Agent 消息，推进 `activity_seq`；supervisor 看到新活动，在目标空闲后生成 review。不是每个 `finish_task` 立刻唤醒，也不是每个聊天回复都唤醒。

**不要**新增“Captain completion wake”或独立 completion budget；review supervisor 的 checkpoint + idle 检查已经覆盖循环保护。**不要**要求每个阶段调用 `stage_complete`；纯聊天阶段只要有 Captain assignment 且产生新活动，review 就能看到。

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
| 隐藏批次；有角色徽章/`note`，但不是可自由对话的协作角色 | Chat 内 Agent 角色，所有发言可见 |
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
- 写入型 run 在租约内做 shadow Git 快照；产生 commit/diff 引用。
- Artifact 状态：`draft | published | accepted | rejected | superseded`；与 Task 状态独立。
- Report 可以引用已存在的 Artifact；Agent 不能凭路径或伪造 ID 创建版本。
- `accept_task` 可以要求 required Artifact 已接受/发布；接受 Artifact 本身不自动完成 Task。
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
