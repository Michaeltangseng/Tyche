# 02 目标架构

## 1. 总览

```text
┌────────────────────────────────────────────────────────────────────┐
│ Renderer（Vue）                                                     │
│  RoomWorkspace · Chat Timeline · Task/Report/Attention/Artifact 卡  │
│  只通过 preload 的窄 IPC 读取快照、提交消息、执行用户命令            │
└───────────────────────────────┬────────────────────────────────────┘
                                │  IPC（main 校验来源与 DTO）
┌───────────────────────────────▼────────────────────────────────────┐
│ Electron main                                                       │
│                                                                     │
│  Collaboration Domain（新）                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│  │ Message      │ │ Router /     │ │ Session      │                │
│  │ Timeline     │ │ Briefing     │ │ Registry     │                │
│  └──────────────┘ └──────────────┘ └──────────────┘                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│  │ Task Queue   │ │ Report /     │ │ Captain /    │                │
│  │ (TaskRun)    │ │ Attention    │ │ Agent Tools  │                │
│  └──────────────┘ └──────────────┘ └──────────────┘                │
│                                                                     │
│  Platform Infrastructure（保留/改造）                                │
│  RuntimeAdapter · CLI adapters · ProcessRegistry · Trace ·          │
│  Run Ledger · Lease · Permissions · Artifact Snapshots · Effects    │
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

## 2. 分层职责

### 2.1 Collaboration Domain（新写）

| 模块 | 职责 |
| --- | --- |
| `timeline.cjs` | Message 追加、序号分配、状态迁移、编辑/删除事件、回复行占位 |
| `routing.cjs` | 用户消息唤醒规则；mention 解析；wake budget |
| `briefing.cjs` | 按 participant 水位生成增量简报；处理进行中的行、附件、长度上限 |
| `session-registry.cjs` | Chat × Role 的 session、Task 的 session；原生引用、baseline、last_seq、轮换 |
| `engine.cjs` | 把 reply 行变成运行：串行/并行、steer、stop、重启恢复 |
| `task-queue.cjs` | TaskRun 队列、并发限制、pump、评论续跑、rerun |
| `reports.cjs` | 解析/导入 Report；推导 Task 状态；拒绝自由文本猜测 |
| `attentions.cjs` | 需要用户处理的事项；合并、幂等、回答后回到原 session |
| `captain/` | Captain 的 Prompt 和工具面：assign_in_group、post_in_chat、propose_role、读工具、request_attention |
| `tools/` | Agent 会话工具：mention、create_task、list_tasks、finish_task、comment_task 等 |
| `commands.cjs` | UserCommand 的校验、幂等、审计 |
| `effects.cjs` | durable outbox：启动进程、投递消息、发布 Artifact、通知 |
| `supervisor.cjs` | 平台观察的 liveness/exited 事实；不把 Worker 自报当存活证明 |
| `recovery.cjs` | 启动恢复、进程对账、unknown 隔离 |

### 2.2 Platform Infrastructure（保留，必要时适配）

| 模块 | 保留原因 |
| --- | --- |
| `workspace/local-workspace-agent-invocation.cjs` | 原生 Agent 调用的实际执行链 |
| `workspace/invocation-session.cjs` | 原生 session 的 resume/adopt/discard 机制 |
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
| `room-engine/controller-session.cjs` | 平台内部批次调度器，由 Captain 取代 |
| `room-engine/controller-agent.cjs` | Controller 拆任务模型，退役 |
| `room-engine/assignment-runner.cjs` | Assignment 即会话模型，退役 |
| `room-engine/mention-fallback.cjs` | 只作为临时 fallback，最终由统一路由取代 |
| `room-engine/room-db.cjs` 的旧 schema | 新账本使用干净 schema，旧库只做迁移 |

## 3. 新代码布局

```text
desktop/src/
  collaboration/
    db.cjs                 SQLite 打开、WAL、事务、schema version
    schema.cjs             表定义与迁移
    repository.cjs         领域对象读写（或按对象拆分）
    timeline.cjs
    routing.cjs
    briefing.cjs
    session-registry.cjs
    engine.cjs
    task-queue.cjs
    reports.cjs
    attentions.cjs
    commands.cjs
    effects.cjs
    supervisor.cjs
    recovery.cjs
    captain/
      prompt.cjs
      tools.cjs
    tools/
      mention.cjs
      tasks.cjs
      ask.cjs
  shell/
    collaboration-ipc.cjs  窄 IPC
  ...
```

命名可以调整，但边界不变：**domain 不直接启动进程，runtime 不直接写产品表。** 所有外部副作用先写 effect，再由 pump 执行。

## 4. 数据归属

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| Room / Chat / Role / Participant | SQLite | 产品事实 |
| Message / Task / TaskRun / Report / Attention / Artifact 引用 | SQLite | 产品事实 |
| Session 指针（native ref、baseline、last_seq） | SQLite | 只存指针，不存正文 |
| Session 正文 / 模型上下文 | Agent CLI 自己的存储 | 平台不拥有、不解析 |
| Trace | 应用私有区 JSONL | 只读执行轨迹；DB 存引用 |
| Artifact 内容 | 应用私有区 Git / 快照 | DB 存 commit / version / 元数据 |
| Effects / UserCommand 幂等 | SQLite | 外部副作用边界 |
| 旧 workspace JSON / 旧 room DB | 应用私有区归档 | 一次性迁移后只读 |

### 4.1 SQLite 表草案

> 具体字段在实施计划中冻结；这里只固定语义。

- `rooms`：id、name、workspace、providers、allowed_capabilities、write_authorization、created_at。
- `chats`：id、room_id、title、status、created_at。
- `chat_roles`：id、chat_id、display_name、responsibilities、provider、capabilities、native_permission、is_captain、status、created_at。
- `role_prompt_revisions`：role_id、revision、prompt、created_by、created_at。
- `chat_context_revisions`：chat_id、revision、instructions、changes、created_by、created_at。保存用户可编辑的协作约定（目标、已决定事项、当前偏好）；每次修改追加新 revision，不覆盖历史。
- `chat_participants`：chat_id、role_id、session_id、joined_at、left_at。
- `messages`：id、chat_id、seq、author_type、author_id、kind、content、mentions、reply_to、task_id、root_message_id、status、created_at、edited_at、deleted_at。
- `sessions`：id、scope_type（chat/task）、scope_id、role_id、provider、native_session_ref、baseline_seq、last_seq、state、created_at、rotated_at。
- `tasks`：id、chat_id、number、title、description、status、created_by_role_id、assignee_role_id、parent_task_id、blocked_by_task_ids、source_message_ids、context_revision、created_at、updated_at。
- `task_runs`：id、task_id、role_id、status、session_id、continues_run_id、machine、workspace、queued_at、started_at、ended_at、reason。
- `reports`：id、task_id、run_id、kind、summary、evidence、artifact_ids、next_request、attention_id、created_at。
- `attentions`：id、chat_id、task_id、type、question、options、status、requested_by、answered_by、resolution、created_at、answered_at。
- `artifacts`：id、room_id、task_id、run_id、path、kind、version、status、commit、created_at。
- `events`：id、room_id、chat_id、seq、actor_id、type、payload、created_at（append-only 审计）。
- `effects`：id、chat_id、kind、status、payload、idempotency_key、attempts、last_error、created_at。
- `user_commands`：id、chat_id、type、payload、status、result、created_at（幂等）。

**不再保留** `assignments`、`controller_decisions`、`reports.assignment_id` 这类以“平台派发”为中心的表/字段。TaskRun 取代 Assignment；Captain 的可见消息和 Agent 工具调用取代 ControllerAction 批次。

## 5. 一次完整的运行

```text
1. 用户发送消息
   → messages 追加（seq），events 记录 message_created
2. Router 决定唤醒谁
   → 为每个目标创建 reply 行（status=queued，seq 预留，root_message_id）
3. Engine 按 participant session 串行取 reply
   → 生成增量简报（last_seq 之后）
   → session 不存在则创建；存在则 resume
   → runtime.invokeAgent({ sessionRef, prompt })
4. Agent 运行
   → 可调用 mention / create_task / list_tasks / finish_task / request_attention
   → 流式输出写入 reply 行
5. 结束
   → reply status = done/failed/stopped
   → last_seq 推进到已看完的最后一个完成行
6. 如果 create_task
   → tasks + task_runs(queued)
   → task queue pump 启动 run（task session）
7. 如果 finish_task
   → reports + task status in_review/blocked
   → 在来源 Chat 追加 Agent 消息
8. 如果需要用户
   → attentions + 通知/收件箱
9. 所有外部副作用
   → 先写 effects，再执行；失败/未知可恢复
```

## 6. UI 目标

- **一个 RoomWorkspace**，不再有并发/顺序/自动讨论模式选择器。
- Chat 时间线显示：用户消息、Agent 回复、mention 行、Task 卡、Report 卡、Attention 卡、Artifact 卡、系统事件。
- 角色栏显示：角色名、Provider、职责、权限、是否 Captain。
- Task 卡可以打开执行记录/Trace；Report 卡显示摘要、证据、产物。
- Attention 卡可以直接回答；回答回到原 session。
- 旧 `ProjectRoomGatePanel`、`ProjectRoomSeatSettings`、`ProjectRoomProgress`、`ProjectRoomOverlay` 不再作为新 Chat 入口。
- 所有新增文案进入 `frontend/src/locales/zh.js` 和 `en.js`。

## 7. 架构不变量

1. 一条 Message 先落账，再触发唤醒。
2. 一个 reply 行只属于一个 participant session；同一 session 串行，不同 session 并行。
3. 一个 Task 同时最多一个未结束的 run。
4. 一个 Task 的 session 属于 Task，不属于某一次 run。
5. 没有 Report 不能把 Task 推导为 done。
6. 平台观察的 liveness/exited 是进程事实；Agent 自报不是。
7. 所有外部副作用先写 effects。
8. Renderer 永远不接触路径、凭据、原生 session 引用或进程句柄。
9. 旧引擎不参与新 Chat 的读写；旧数据只做一次性迁移/归档。
