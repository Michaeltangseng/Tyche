# 04 任务、Captain 与 Report

本文档定义工作如何被创建、执行、报告和验收。核心原则：**Agent 自己拥有工作；平台记录事实、校验边界、调度运行，但不替 Agent 拆任务。**

## 1. Task 的归属

### 1.1 谁创建 Task

- **只有 Agent 能在 Chat 中创建 Task。**
- 用户不直接“新建 Task”；用户通过消息表达需求，由 Agent 判断是否建 Task。
- Captain 不替目标 Agent 建 Task；它只发可见的工作授权，目标 Agent 自己建。

Agent 工具：

```text
create_task(title, description, acceptance, workspace?, parent_task_id?, blocked_by?, optional?)
draft_task(title, description, acceptance, workspace?, parent_task_id?, blocked_by?, optional?)
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

### 1.4 Role 的加入与权限

- Role 由用户创建或确认；Captain 可以 `propose_role`，但不能直接创建。
- Role 绑定 Provider/模型、Prompt revision、能力、原生权限模式、Skill 绑定。
- Role 加入 Chat 后成为 Participant；每个 Chat 有自己的 session，不与其他 Chat 共享上下文。
- 移除 Role 不删除历史；它正在进行的回复停止，已写的消息和 Report 保留。
- 用户修改 Role Prompt 或权限时，只影响之后创建的 run；历史 run 保留原 revision。

## 2. Task 生命周期

```text
create_task ─────────────────────▶ todo ──(队列启动)──▶ in_progress
draft_task ──(用户确认)──────────▶ todo
backlog（可选，不立即运行）──────▶ todo
                                    │
                                    ├─ finish_task(ready) ──▶ in_review ──(用户接受)──▶ done
                                    ├─ finish_task(blocked) ─▶ blocked ──(用户回答/评论)──▶ todo
                                    └─ 失败/中断 ──────────▶ failed/waiting ──(retry)──▶ todo
                                    │
                                    └─(用户取消)──▶ cancelled
```

- Task 状态由平台根据 Report、TaskRun 事实和用户命令推导；Agent 不能直接设置 `done/cancelled`。
- `in_review` 表示 Agent 认为工作完成，等待用户验收；`done` 需要用户接受（或显式配置为自动接受）。
- `blocked` 表示 Agent 需要用户输入；用户的评论或回答会把它推回队列。
- `cancelled` 表示用户不再要求执行；运行中的 run 要先停止并确认退出。

## 3. TaskRun 队列

### 3.1 表就是队列

参考 eta `tasks/runner.ts`：

```text
TaskRun
  id
  task_id
  role_id
  status          // queued | starting | running | completed | failed | interrupted
  session_id
  continues_run_id
  machine
  workspace
  queued_at / started_at / ended_at
  reason
```

- 一个 Task 同时最多一个未结束的 run。
- 队列按 `queued_at` 排序。
- 启动条件：该 Task 的上一个 run 已结束；目标机器在线；该机器有空闲槽位。
- 每台机器默认最多 2 个并发 run，可配置（1–20）。
- `pump()` 在以下时刻调用：新 run 入队、run 结束、机器上线、并发上限改变、Task 状态/依赖改变。
- TaskRun 是业务队列；启动原生进程是 effect。queued TaskRun 先写 `start_run` effect，effect 成功后才进入 running；effect 结果未知时保留 run 为 unknown，不自动重放。

### 3.2 Task Session

- 一个 Task 一个 session，key `task:<taskId>`。
- 第一次 run 创建；评论续跑复用；`rerun` 创建新一代 session。
- session 的 `last_seq` 使用 Task 的活动序号（评论、Report、状态变化），不是 Chat 消息序号。
- Task session 看不到来源 Chat 的历史；它只拿 Task 本身和评论。

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

- run 进行中：评论作为 user 消息送入该 run；runtime 支持 steer 时并入当前 turn，否则排队到该 run 的下一个 turn。
- 没有 run 进行中：评论创建 continuation run，`continues_run_id` 指向它继续的那次 run；复用同一个 Task session。
- 评论是“继续做”，不是“重新开始”；Agent 已经知道上面发生过什么。
- Agent 自己的评论不回灌给自己，也不唤醒自己。
- 同一个 `clientId` 的重试只投递一次、只唤醒一次。

### 3.5 rerun

- `rerun` 明确表示“丢弃记忆，重新开始”：创建新一代 Task session，重新发首次 run 的 prompt。
- 旧 run 和旧 session 保留在历史中；不删除证据。

### 3.6 结束

- Agent 调用 `finish_task(taskId, summary, status)`：
  - `status=ready` → Report(kind=ready)，Task → `in_review`；
  - `status=blocked` → Report(kind=blocked)，Task → `blocked`；
  - 摘要成为 Task 评论；
  - 平台以 Agent 身份把“#编号 标题 + 摘要”发回来源 Chat。
- 如果 run 安静结束但没有 `finish_task`：平台提醒一次；仍然没有报告则 run failed，Task 保持原状态。
- 进程退出但未确认结果：run → `waiting / outcome=unknown`；创建 Attention；不自动重试，不伪造退出。

## 4. Report

### 4.1 Report 是领域真源

```text
Report
  id
  task_id
  run_id
  kind            // progress | ready | waiting | blocked | failed | handoff
  summary
  evidence[]
  artifact_ids[]
  next_request?   // 例如请求另一个角色评审
  attention_id?
  created_at
```

- Report 是任务结果的领域真源；Event 只引用 Report，不重复维护一套状态。
- Task 状态由平台根据最新 Report、TaskRun 事实和用户命令推导。
- 没有 Report 不能把 Task 推导为 `done`。
- `next_request` 只是建议，不自动派发；需要 Agent 自己 `mention` 或用户命令。

### 4.2 如何产生 Report

优先使用工具：

- 如果 runtime 支持注入 MCP 工具，Agent 直接调用 `finish_task`。
- 如果不支持，使用严格机器标记作为 fallback：

```text
[[MELDWORK_REPORT:{"kind":"ready","summary":"...","evidence":[],"artifacts":[]}]]
```

- 只接受最后一个标记；字段、kind、摘要、Artifact 归属严格校验。
- 标记后的自然语言可以作为补充说明，但不能覆盖结构化字段。
- 没有结构化报告时，平台不猜测完成状态；run 保持 waiting，交给用户或 Captain 处理。

### 4.3 Task 状态推导

```text
最新 required run 的 Report:
  progress  → in_progress / waiting
  ready     → in_review
  waiting   → waiting
  blocked   → blocked
  failed    → failed / waiting
  handoff   → waiting（交给下一个 Assignment/Run）
```

- 可选 run 失败不阻塞 required 工作。
- 替代 run（retry/handoff）链上只计算最新的 required run；旧失败和迟到 Report 不覆盖新结果。
- 用户接受 Artifact（或显式的验收命令）后，Task → `done`。

## 5. Captain

### 5.1 Captain 是什么

- Captain 是 Chat 内的一个 **Role**，带 `is_captain=1`。
- 它有自己的 Participant Session，和普通 Agent 一样被唤醒、有记忆、受权限约束。
- Captain 不是平台内部的隐藏调度器；它说的话、发的授权、做的建议都落在 Chat 时间线上。
- 一个 Chat 默认一个 Captain；没有 Captain 时，路由退回“显式 @mention / 唯一参与者”。

### 5.2 Captain 工具

```text
assign_in_group(chatId, text, roleIds?, mode?)
post_in_chat(chatId, text)
list_roles()
read_role(roleId)
list_chats()
read_chat(chatId, limit?, beforeSeq?)
list_tasks(filter?)
read_task(taskId)
read_inbox(pendingOnly?)
request_attention(taskId?, type, question, options?)
control_task(taskId, action, text?)   // 仅 continue/pause；stop/rerun/delete 需用户命令
propose_role(...)
set_role_prompt(...)   // 通常需要用户确认
```

### 5.3 assign_in_group

- 在群聊中写一条可见消息，并 @ 一个或多个成员。
- 被点名的 Agent 被唤醒；它们自己决定是否 `create_task`、如何执行。
- **Captain 不创建 Task，也不替目标 Agent 指定 Assignment。**
- 如果没有 `roleIds`，消息交给 Chat 的默认接收者（Captain 自己或 steward）。
- Captain 的回复和它发出的 assignment 是两行：一行是 Captain 在群里说的话，一行是 mention 消息本身。被唤醒的 Agent 读到的是 mention 的正文。

### 5.4 Captain 不能做什么

- 不能授予新的 Provider、能力、写入范围或凭据。
- 不能直接设置 Task `done/cancelled`。
- 不能绕过用户确认创建 Role（动态角色仍需确认）。
- 不能读取或修改平台内部 Trace 之外的凭据、路径、进程句柄。
- 不能伪造用户命令。

### 5.5 与 v2 Controller 的区别

| v2 Controller | 目标 Captain |
| --- | --- |
| 平台内部批次，不可见 | Chat 内 Agent 角色，所有发言可见 |
| 可以 `create_task` / `assign` | 只发可见授权；Task 由目标 Agent 创建 |
| 每批动作绑定 `controller_decisions` | 工具调用写 events/trace；不做隐式批次 |
| 失败后自动 fallback 建任务 | 失败后只保留显式 @mention 路由，不猜任务 |
| 用结构化 JSON 动作驱动 | 用自然语言 + 工具调用驱动 |

保留的是**平台校验与审计**：Role/Provider/Chat 归属、权限、幂等、Task 状态推导、effects。丢弃的是**平台替 Agent 做任务分解**。

## 6. Attention 与 Inbox

Attention 是需要用户处理的事项：

- Task `blocked`；
- Task `in_review` 等待验收；
- Agent 的提问（ask）；
- 执行结果 unknown / 终止未确认；
- 权限、成本、Provider 变化请求；
- Artifact 接受/拒绝。

规则：

- 同一个问题只开一个 Attention；用确定性 ID 去重。
- Attention 回答后回到原 session，继续原来的 turn。
- 多个 Attention 合并到 Inbox；通知可合并，避免每个 Report 都弹一次。
- Attention 正文不包含敏感路径、Prompt 或凭据。
- 用户可以忽略/归档；忽略不等于同意。

## 7. 工作区、权限与产物

### 7.1 工作区

- 默认所有角色在 Room 主目录工作。
- 写入需要用户显式授权；授权绑定当前工作目录 realpath。
- 同一 Room 的写入用独占租约串行化；一个角色写的时候，其他写入者等待。
- 并行思考可以在各自草稿文件中进行，但最终交付文件只有一个 writer；这是用户的协作约定，平台用租约保证不并发写。
- 可选隔离 workspace（worktree/临时目录）后续再做；第一阶段不做默认复制。

### 7.2 per-seat 权限

- 每个 Role 有原生权限模式：`read-only`、`read-exec`、`workspace-write` 等。
- 用户按角色配置；平台在启动 run 前校验，不能由 Prompt 改写。
- writeScopes 非空且用户已授权时，Role 才能申请写入。
- Controller/Captain 默认只读；Captain 不因为“主控”获得写权限。

### 7.3 Artifact

- Artifact 属于 Room，不属于 Chat。
- 写入型 run 在租约内做 shadow Git 快照；产生 commit/diff 引用。
- Artifact 状态：`draft | published | accepted | rejected | superseded`。
- Report 可以引用已存在的 Artifact；Agent 不能凭路径或伪造 ID 创建版本。
- 用户接受 Artifact 是 Task → `done` 的条件之一；接受是否恢复工作目录，后续单独定义。

## 8. 不变量

1. Task 只能由 Agent 在 Chat 内创建；平台不替 Agent 建 Task。
2. Captain 只发可见授权；目标 Agent 自己建 Task、自己执行。
3. 一个 Task 同时最多一个未结束的 run。
4. 一个 Task 一个 session；评论续跑，rerun 才重置。
5. Report 是任务结果的领域真源；没有 Report 不能 done。
6. 用户命令和 Agent 工具都不能绕过权限、租约和 Report 推导。
7. Attention 回答回到原 session；不另起一段无记忆的对话。
8. 所有外部副作用先写 effects；失败/未知可恢复，不自动重放写操作。
