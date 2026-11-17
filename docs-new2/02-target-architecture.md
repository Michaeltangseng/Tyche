# 02 目标架构

## 1. 总览

```text
┌────────────────────────────────────────────────────────────────────┐
│ Renderer（Vue）                                                     │
│  RoomWorkspace · Chat Timeline · Task/Report/Attention/Artifact 卡  │
│  Captain 工作流 Prompt 编辑 · Captain Review 卡                     │
│  只通过 preload 的窄 IPC 读取快照、提交消息、执行用户命令            │
└───────────────────────────────┬────────────────────────────────────┘
                                │ IPC（main 校验来源与 DTO）
┌───────────────────────────────▼────────────────────────────────────┐
│ Electron main                                                       │
│                                                                     │
│  Room Domain（新，desktop/src/room/）                                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│  │ Message      │ │ Router /     │ │ SessionStore │                │
│  │ Timeline     │ │ Briefing     │ │ (SQLite)     │                │
│  └──────────────┘ └──────────────┘ └──────────────┘                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│  │ Task Queue   │ │ Report /     │ │ Agent Tools  │                │
│  │ (TaskRun)    │ │ Attention    │ │ (MCP/marker) │                │
│  └──────────────┘ └──────────────┘ └──────────────┘                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│  │ Captain      │ │ Captain      │ │ Effects /    │                │
│  │ Assignment   │ │ Review       │ │ Outbox       │                │
│  └──────────────┘ └──────────────┘ └──────────────┘                │
│                                                                     │
│  Platform Infrastructure（保留/改造）                                │
│  RuntimeAdapter · CLI adapters · ProcessRegistry · Trace ·          │
│  Run Ledger · Lease · Permissions · Artifact Snapshots              │
│                                                                     │
│  Storage（新）                                                       │
│  SQLite 账本（事实/指针/水位） + Trace JSONL + Artifact Git 快照     │
└───────────────────────────────┬────────────────────────────────────┘
                                │ 原生子进程 / stdio / MCP
┌───────────────────────────────▼────────────────────────────────────┐
│ Claude Code · Codex · 其他原生 Agent CLI（各自管理 session/上下文）  │
└────────────────────────────────────────────────────────────────────┘
```

核心边界：

- **平台账本**保存事实、指针、水位、任务、报告、Attention、产物引用。
- **Agent runtime**保存自己的 session 正文和上下文；平台不接管。
- **平台不拆任务**：Task 由 Agent 创建；平台只校验、排队、记录、恢复。
- **平台不隐藏决策**：Captain 的授权、Agent 的 mention、Task/Report 都落在 Chat 时间线。
- **平台不做隐式串行**：多条唤醒并行；串行由每一环自己 `mention` 或 Captain review 驱动。
- **所有进程启动走 effect**：聊天回复和 TaskRun 都一样。

## 2. 分层职责

### 2.1 Room Domain（新写，`desktop/src/room/`）

| 模块 | 职责 |
| --- | --- |
| `timeline.cjs` | Message 追加、序号分配、状态迁移、编辑/删除事件、回复行占位 |
| `routing.cjs` | 用户消息唤醒规则；mention 解析；5 次 wake budget |
| `briefing.cjs` | 按 participant/lane 水位生成增量简报；处理进行中的行、附件、长度上限 |
| `session-store.cjs` | Chat Session 与 Task Session 的 SQLite 指针、baseline、轮换、原生引用 |
| `engine.cjs` | 把 reply 行变成运行：串行/并行、steer/queue、stop、重启恢复 |
| `task-queue.cjs` | TaskRun 队列、lane、并发限制、pump、评论续跑、rerun |
| `captain-review.cjs` | Captain assignment 的 review 队列、checkpoint、批处理、唤醒 |
| `reports.cjs` | 解析/导入 Report；推导 Task 状态；拒绝自由文本猜测 |
| `attentions.cjs` | 需要用户处理的事项；合并、幂等、回答后回到原 session |
| `commands.cjs` | UserCommand 的校验、幂等、审计 |
| `effects.cjs` | durable outbox：启动进程、投递消息、发布 Artifact、通知 |
| `supervisor.cjs` | 150ms 领域变化 debounce 快路径 + 60 秒兜底 tick；驱动 Captain review |
| `recovery.cjs` | 启动恢复、进程对账、unknown 隔离 |
| `tools/` | Agent 工具：mention、create_task、comment_task、finish_task、ask；`captain.cjs` 是 Captain 专用工具 |
| `ipc.cjs` | 窄 IPC；不暴露路径、原生 session 引用或进程句柄 |

### 2.2 Platform Infrastructure（保留，必要时适配）

| 模块 | 保留原因 |
| --- | --- |
| `workspace/local-workspace-agent-invocation.cjs` | 原生 Agent 调用的实际执行链 |
| `workspace/invocation-session.cjs` | 原生 session 的 resume/adopt/discard 机制；由 SessionStore port 适配 |
| `agents/cli/*` | Claude Code / Codex 等 CLI adapter |
| `runs/run-ledger.cjs` / `run-journal.cjs` | 运行记录与崩溃恢复 |
| `runs/path-claims.cjs` | Room 根目录写入租约 |
| `runs/invocation-watchdog.cjs` | 启动/停滞/无进展窗口 |
| `project-room/shadow-git.cjs` | Artifact 的 commit/diff 快照 |
| `security/*` | 私密文件、脱敏、IPC 安全 |
| `attachments/*` | 附件导入、校验、预览 |
| `skills/*` / `knowledge/*` | Skill 与知识源能力 |

这些模块可以调整接口，但不应为了新领域模型重写其内部实现。

### 2.3 明确退役

| 模块 | 原因 |
| --- | --- |
| `project-room/checkpoint-engine.cjs` | 固定检查点状态机，不再是用户模型 |
| `project-room/checkpoint-transitions.cjs` | 同上 |
| `project-room/gate-screen.cjs` | Gate 作为内部词汇，不再是顶层界面 |
| `workspace/local-workspace-auto-runner-v2/v3/v4-*` | 多套协作执行器，统一由新 engine 取代 |
| `room-engine/controller-session.cjs` | 平台内部批次调度器，由 Captain + review 取代 |
| `room-engine/controller-agent.cjs` | Controller 拆任务模型，退役 |
| `room-engine/assignment-runner.cjs` | Assignment 即会话模型，退役 |
| `room-engine/mention-fallback.cjs` | 只作为临时 fallback，最终由统一路由取代 |
| `room-engine/room-db.cjs` 的旧 schema | 新账本使用干净 schema，旧库只做迁移 |

> 删除顺序与依赖见 [06 重写与迁移](06-rewrite-and-migration.md)。不要先删 `local-workspace-auto-runner*`：`LocalWorkspace` 仍依赖它；先把运行时原语拆出来，再接新 domain。

## 3. 新代码布局

```text
desktop/src/room/                 # 新 domain；不要复用 desktop/src/collaboration/ 目录名
  db.cjs                          # SQLite 打开、WAL、事务、schema version
  schema.cjs                      # 表定义与迁移
  repository.cjs                  # 领域对象读写（或按对象拆分）
  timeline.cjs
  routing.cjs
  briefing.cjs
  session-store.cjs
  engine.cjs
  task-queue.cjs
  captain-review.cjs
  reports.cjs
  attentions.cjs
  commands.cjs
  effects.cjs
  supervisor.cjs
  recovery.cjs
  tools/
    mention.cjs
    tasks.cjs
    ask.cjs
    captain.cjs
  ipc.cjs
```

命名可以调整，但边界不变：**domain 不直接启动进程，runtime 不直接写产品表。** 所有外部副作用先写 effect，再由 pump 执行。

## 4. 数据归属

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| Room / Chat / Role / Participant | SQLite | 产品事实 |
| Message / Task / TaskRun / Report / Attention / Artifact 引用 | SQLite | 产品事实 |
| Session 指针（native ref、baseline） | SQLite | 只存指针，不存正文 |
| Participant / lane 水位 | SQLite | `last_seq` 属于 participant/lane，不属于 session |
| Session 正文 / 模型上下文 | Agent CLI 自己的存储 | 平台不拥有、不解析 |
| Trace | 应用私有区 JSONL | 只读执行轨迹；DB 存引用 |
| Artifact 内容 | 应用私有区 Git / 快照 | DB 存 commit / version / 元数据 |
| Effects / UserCommand 幂等 | SQLite | 外部副作用边界 |
| 旧 workspace JSON / 旧 room DB | 应用私有区归档 | 一次性迁移后只读 |

### 4.1 SQLite 表草案

> 具体字段在实施计划中冻结；这里只固定语义。

- `rooms`：id、name、workspace、write_authorization（realpath）、providers_json、allowed_capabilities_json、created_at、updated_at。
- `chats`：id、room_id、title、status、last_seq（最新 message seq，含 review 行）、activity_seq（最新 **public** 消息 seq，供 Captain review 比较）、captain_reviewed_seq、created_at、updated_at。
- `chat_roles`：id、chat_id、display_name、responsibilities、provider、model、capabilities_json、native_permission、is_captain、status、created_at、updated_at。
- `role_prompt_revisions`：role_id、revision、prompt、created_by、created_at。
- `chat_context_revisions`：chat_id、revision、instructions、changes_json、created_by、created_at。保存用户可编辑的协作约定（目标、已决定事项、当前偏好）；每次修改追加新 revision，不覆盖历史。
- `chat_participants`：chat_id、role_id、session_id、last_seq、joined_at、left_at。`last_seq` 是该 Role 在 Chat 中的权威投递水位。
- `sessions`：id、scope_type（chat/task）、scope_id、role_id、provider、native_session_ref、baseline_seq、prompt_revision、permission_mode、workspace_ref、skill_bindings_json、model、thinking_level、state（active/rotated/closed）、created_at、rotated_at。**没有 `last_seq`。**
- `messages`：id、chat_id、seq、revision、client_id（chat 内唯一）、audience（chat/captain；默认 chat）、author_type（user/agent/system）、author_id、kind（message/mention/system/task_draft/task_card/report_card/captain_review）、content、mentions_json、reply_to、task_id、root_message_id、status（queued/working/waiting_for_input/stopping/done/failed/stopped/interrupted）、data_json、created_at、edited_at、deleted_at。
- `tasks`：id、chat_id、number、title、description、acceptance、kind、status（backlog/todo/in_progress/in_review/blocked/done/cancelled）、created_by_role_id、assignee_role_id、captain_assignment_id、parent_task_id、blocked_by_task_ids_json、required_artifact_ids_json、optional、source_message_ids_json、context_revision、default_write_scopes_json、created_at、updated_at。
- `task_activities`：id、task_id、seq、kind（comment/report/status/run）、author_type、author_id、body、message_id、created_at。Task 自己的时间线；Task lane 的 `last_seq` 用它。
- `task_lanes`：id、task_id、role_id、kind（executor/mention）、session_id、last_seq、active、created_at。一个 Task 一个执行者 lane，外加每个被 mention 的角色一个 lane。
- `task_runs`：id、task_id、lane_id、role_id、status（queued/starting/running/completed/failed/interrupted/cancelled）、session_id、required、continues_run_id、previous_run_id、machine、workspace_ref、write_scopes_json、queued_at、started_at、ended_at、reason。
- `reports`：id、task_id、run_id、lane_id、kind（progress/ready/waiting/blocked/failed/handoff）、summary、evidence_json、artifact_ids_json、next_request_json、attention_id、created_at。
- `attentions`：id、chat_id、task_id、type、question、options_json、status、requested_by、answered_by、resolution_json、created_at、answered_at。
- `artifacts`：id、room_id、task_id、run_id、path、kind、version、status（draft/published/accepted/rejected/superseded）、commit、created_at、updated_at。
- `captain_assignments`：id、chat_id、message_id、root_message_id、target_role_ids_json、created_at。Captain 可见授权消息的台账，不是执行 Assignment。
- `captain_reviews`：id、chat_id、assignment_id、kind、dedupe_key、checkpoint_seq、status（pending/running/completed/failed）、attempts、next_attempt_at、body、data_json、reply_id、created_at、updated_at。Captain review 队列。
- `events`：id、room_id、chat_id、seq、actor_id、type、payload_json、created_at（append-only 审计）。
- `effects`：id、chat_id、kind、status（pending/running/succeeded/failed/unknown）、payload_json、idempotency_key、attempts、last_error、created_at、started_at、completed_at。
- `user_commands`：id、chat_id、type、payload_json、status、result_json、created_at（幂等）。

**不再保留** `assignments`、`controller_decisions`、`reports.assignment_id` 这类以“平台派发”为中心的表/字段。TaskRun 取代 Assignment；Captain 的可见消息和 Agent 工具调用取代 ControllerAction 批次；`captain_assignments` 只是可见授权的 review 台账。

## 5. 一次完整的运行

```text
1. 用户发送消息
   → messages 追加（seq），events 记录 message_created
2. Router 决定唤醒谁
   → 为每个目标创建 reply 行（status=queued，seq 预留，root_message_id）
3. 启动聊天回复
   → 写 start_reply effect（durable）
   → effect pump 领取
   → runtime.invokeAgent({ sessionRef, prompt })
4. Agent 运行
   → 可调用 mention / create_task / comment_task / finish_task / ask
   → 流式输出写入 reply 行
5. 结束
   → reply status = done/failed/stopped/interrupted
   → participant.last_seq 推进到 seen
6. 如果 create_task
   → tasks + task_lanes(executor) + task_runs(queued)
   → 写 start_run effect → task queue pump 启动 run（task session）
7. 如果 finish_task
   → task_activities + reports + task status in_review/blocked
   → 在来源 Chat 追加 Agent 消息（advance chat.activity_seq）
8. Captain review supervisor
   → 周期 tick / 领域变化 debounce
   → 检查已结算的 Captain assignment
   → 有新活动/blocked/stalled 且目标空闲
   → captain_reviews(pending) → 批量/system 消息唤醒 Captain
9. 如果需要用户
   → attentions + 通知/收件箱
10. 所有外部副作用
   → 先写 effects，再执行；失败/未知可恢复
```

## 6. Agent 工具传输

Agent 工具不能只存在于文档里；必须有明确通道。

### 6.1 首选：本地 MCP server

- Electron main 为每次 run/session 起一个本地 MCP server，绑定：
  - `runId` / `sessionId`
  - `chatId` 或 `taskId`
  - `roleId`
  - 允许的工具集合
- 工具：
  - `mention(names, text)`
  - `create_task(title, description, acceptance, workspace?, parent_task_id?, blocked_by?, optional?)`
  - `draft_task(...)`（可选）
  - `comment_task(taskId, text)`
  - `finish_task(taskId, summary, status, evidence?, artifact_ids?)`
  - `list_tasks` / `get_task`
  - `request_attention(question, options?)`
- 身份由 MCP server 绑定，**不接受工具参数里的 author/actor/runId**。
- 只有执行者 lane 的当前 run 可以调用 `finish_task`；mention lane 只有读/评论/mention/ask 工具。
- 工具调用带 `toolCallId`；平台按 `(runId, toolCallId)` 幂等，重复调用返回原结果。
- MCP server 只监听 loopback，生命周期跟随 run；不把 token/凭据暴露给 CLI。

### 6.2 兜底：严格文本标记

如果某个 CLI 不支持 MCP：

```text
[[MELDWORK_TOOL:{"name":"mention","callId":"...","args":{"names":["reviewer"],"text":"..."}}]]
```

- 每个回复只应用最后一个完整标记；标记从可见正文和简报中剥离。
- 身份仍然由平台从 run/session 绑定，标记里的字段不能指定作者。
- `finish_task` 的标记与 Report 标记共用严格校验。
- 标记协议必须覆盖 `mention`、`create_task`、`comment_task`、`finish_task`，不能只覆盖 Report。

### 6.3 能力矩阵

Phase 2 必须为每个 CLI 记录并验证：

| 能力 | Claude Code | Codex | ACP |
| --- | --- | --- | --- |
| resume | 待验证 | 待验证 | `session/resume` / `session/load` |
| mid-turn steer | 不支持（`--print` 一次性） | 不支持（`exec -` 一次性） | 队列下一 prompt，不是 steer |
| wait-for-input | 仅 connector 路径 | 待验证 | ask/permission |
| MCP tools | 待验证 | 待验证 | 待验证 |
| 自身压缩 | 有 | 有 | 由 runtime 决定 |
| cancel | 进程终止 | 进程终止 | `session/cancel` |

没有 mid-turn steer 的 CLI，评论和 Attention 回答一律排队为 continuation run，不要假装能“送入当前 run”。

## 7. UI 目标

- **一个 RoomWorkspace**，不再有并发/顺序/自动讨论模式选择器。
- Chat 时间线显示：用户消息、Agent 回复、mention 行、Captain assignment、Captain review、Task 卡、Report 卡、Attention 卡、Artifact 卡、系统事件。
- 角色栏显示：角色名、Provider、职责、权限、是否 Captain。
- Captain 工作流 Prompt 可编辑；每个 Chat 一份，变更追加 revision。
- Task 卡可以打开执行记录/Trace；Report 卡显示摘要、证据、产物。
- Attention 卡可以直接回答；回答回到原 session，或按 runtime 能力排队 continuation run。
- 旧 `ProjectRoomGatePanel`、`ProjectRoomSeatSettings`、`ProjectRoomProgress`、`ProjectRoomOverlay` 不再作为新 Chat 入口。
- 所有新增文案进入 `frontend/src/locales/zh.js` 和 `en.js`。
- Renderer 只接收 display-safe DTO：不包含原生 session 引用、绝对路径、进程句柄、凭据；Room 根目录如必须显示，以只读字符串例外处理。

## 8. 架构不变量

1. 一条 Message 先落账，再触发唤醒。
2. 一个 reply 行只属于一个 participant；同一 participant 串行，不同 participant 并行。
3. 一个 Task 的每个 lane 同时最多一个未结束的 run；执行者 lane 与 mention lane 可以并行。
4. 一个 Task 的 session 属于 Task lane（task × role），不属于某一次 run；执行者 lane 跨 run 复用，rerun 才重置。
5. 没有 Report 不能把 Task 推导为 done；`accept_task` 是用户接受，Artifact 状态不单独决定 Task 状态。
6. 平台观察的 liveness/exited 是进程事实；Agent 自报不是。
7. 所有外部副作用先写 effects，聊天回复和 TaskRun 都一样。
8. Renderer 永远不接触路径、凭据、原生 session 引用或进程句柄。
9. 旧引擎不参与新 Chat 的读写；旧数据只做一次性迁移/归档。
10. Agent 之间唤醒是异步的，平台不做隐式串行。
11. Captain review 由 supervisor 驱动，不是每 Task 完成一个独立 wake，也不是每回复结束都唤醒；review 行和 Captain review 回复不计入 `activity_seq`。
12. Chat 回复默认只读；写入只发生在获得授权的 TaskRun；隔离 workspace 之前，每个 Room 同时最多一个写入型 run。
