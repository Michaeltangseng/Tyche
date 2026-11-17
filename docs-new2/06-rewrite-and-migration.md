# 06 重写与迁移

本文档说明如何从现有两代引擎过渡到目标架构。核心原则：**单一目标架构；旧数据一次性迁移或归档；不做长期双引擎、双读、双写。**

## 1. 重写范围

### 1.1 保留（基础设施）

| 模块 | 处理 |
| --- | --- |
| Electron main / preload / renderer 信任边界 | 保留 |
| `workspace/local-workspace-agent-invocation.cjs` | 保留，作为 RuntimeAdapter 底层 |
| `workspace/invocation-session.cjs` | 保留，作为原生 session resume/adopt 的底层 |
| `agents/cli/*` | 保留，按 runtime adapter 接口适配 |
| `runs/run-ledger.cjs`、`runs/run-journal.cjs` | 保留 |
| `runs/path-claims.cjs` | 保留 |
| `runs/invocation-watchdog.cjs` | 保留 |
| `agents/native-permission-modes.cjs`、`agent-permission-policy.cjs` | 保留 |
| `project-room/shadow-git.cjs` | 保留 |
| `security/*`、`attachments/*`、`skills/*`、`knowledge/*` | 保留 |

### 1.2 重写（协作领域）

| 新模块 | 取代 |
| --- | --- |
| `collaboration/timeline.cjs` | `room-engine/message-ingress.cjs` + messages 表重写 |
| `collaboration/routing.cjs` | Controller 路由 + `mention-fallback.cjs` |
| `collaboration/briefing.cjs` | v2 的 `promptOverride` 全量文本 |
| `collaboration/session-registry.cjs` | v2 `assignment-runner` 的一次性 session |
| `collaboration/engine.cjs` | v2 Controller 批次 + assignment runner |
| `collaboration/task-queue.cjs` | v2 的 Assignment/effect 派发 |
| `collaboration/reports.cjs` | `room-engine/report-importer.cjs` / `report-state.cjs` 的思路重写 |
| `collaboration/attentions.cjs` | v2 Attention 的读写重写 |
| `collaboration/captain/*` | `room-engine/controller-*.cjs` |
| `collaboration/commands.cjs` | `room-engine/user-commands.cjs` 的语义重写 |
| `collaboration/effects.cjs` | `room-engine/room-outbox.cjs` / `effect-pump.cjs` 的思路重写 |
| `collaboration/supervisor.cjs` | `room-engine/session-supervisor.cjs` 的思路重写 |
| `collaboration/recovery.cjs` | `room-engine/runtime-recovery.cjs` / `process-reconciliation.cjs` |

### 1.3 删除（旧领域）

- `desktop/src/project-room/checkpoint-engine.cjs`
- `desktop/src/project-room/checkpoint-transitions.cjs`
- `desktop/src/project-room/gate-screen.cjs`
- `desktop/src/project-room/project-*-prompt.cjs` 中与 checkpoint/seat/round 绑定的部分
- `desktop/src/workspace/local-workspace-auto-runner-v2/v3/v4-*`
- `desktop/src/workspace/local-workspace-auto-runner-natural-*` 中与旧 orchestration 绑定的部分
- `desktop/src/room-engine/controller-agent.cjs`
- `desktop/src/room-engine/controller-session.cjs`
- `desktop/src/room-engine/controller-queue.cjs`
- `desktop/src/room-engine/controller-backlog.cjs`
- `desktop/src/room-engine/assignment-runner.cjs`
- `desktop/src/room-engine/mention-fallback.cjs`
- `desktop/src/room-engine/room-actions.cjs` 的 ControllerAction 部分（UserCommand/PlatformTransition 的校验可保留/重写）
- 旧 `ProjectRoomGatePanel.vue`、`ProjectRoomSeatSettings.vue`、`ProjectRoomProgress.vue`、`ProjectRoomOverlay.vue` 的新 Chat 入口

> 删除前先用 `rg` 确认调用点；不要保留“以防万一”的兼容层。

## 2. 数据迁移

### 2.1 新数据库

- 新账本：`userData/meldwork-private/collaboration/collaboration.sqlite`
- 旧账本：`userData/meldwork-private/room-engine/` 与 `meldwork-workspace.json`
- 新架构只读写新账本；旧账本在迁移完成后只读归档，不再参与运行时。

### 2.2 一次性迁移

迁移工具只做一次：

1. 备份旧账本（复制到带时间戳的目录）。
2. 读取旧 Room/Chat/Task/Report/Attention/Artifact，写入新表。
3. 能识别的消息按原 `sequence` 导入；不能识别的保留原始引用。
4. 旧 `assignments` 映射为 `task_runs`：
   - `status` 映射到新状态；
   - `native_session_id`/`session_ref` 无法可靠恢复时，不创建新 session，任务下次执行时重新开始；
   - 旧 Report 按 `task_id` 关联到新运行。
5. 旧 checkpoint/gate/seat/round 状态不迁移为运行状态；只作为只读历史备注或丢弃。
6. 写入 `legacy_imported` 标记和迁移报告。
7. 迁移失败时回滚新库；旧库不动。

### 2.3 不做的事

- 不做旧 JSON + 新 SQLite 双读。
- 不做旧 checkpoint engine 与新 engine 双跑。
- 不做旧 Chat 的长期“legacy 模式”。
- 不为了兼容旧消息格式而在新表里加旧字段。
- 不为旧 session 伪造原生 session 恢复；恢复不了就从新 session 开始。

### 2.4 迁移后的 UI

- 只显示新账本。
- 旧数据如果需要展示，标记为“已归档/导入”，只读。
- 旧项目室入口从导航移除；旧组件删除或降级为历史查看器。

## 3. 实施阶段

> 这是方向性阶段，不是详细计划；详细文件级计划在批准后由 `writing-plans` 产出。

### Phase 0：冻结目标与清理边界

- 批准 `docs-new2`。
- 明确被取代的旧 ADR/文档。
- 列出保留/重写/删除清单。
- 为纯函数建立测试骨架：routing、briefing、session key、task state。
- 不写产品代码。

**退出条件**：目标模型、数据表、模块边界、删除清单都无歧义。

### Phase 1：新账本 + 时间线 + 路由 + 简报

- 新建 `collaboration.sqlite` 与 schema/migration。
- 实现 Room/Chat/Role/Participant/Message/Session 的 repository。
- 实现 Message 追加、seq、status、编辑/删除事件。
- 实现 routing 和 briefing 的纯函数 + 定向测试。
- 实现 SessionRegistry 的 key/baseline/last_seq；先不接真实 CLI。

**退出条件**：给定一组消息和 participant 水位，能生成正确的增量简报；同一消息不会重复投递；未完成行阻塞水位。

### Phase 2：Engine + RuntimeAdapter

- 把 queued reply 行变成运行。
- 接 Meldwork 现有 `invokeAgent` 和 `InvocationSession`。
- 实现 resume/create/rotate。
- 实现 `mention` 工具与 wake budget。
- 实现 stop/steer/restart 恢复。
- 用 fake CLI 做集成测试。

**退出条件**：两个角色可以并发回答；一个角色 mention 另一个；重启后 queued 继续、working 失败、session 指针保留。

### Phase 3：Task + TaskRun + Report

- Agent 工具：`create_task`、`draft_task`、`list_tasks`、`get_task`、`comment_task`、`finish_task`。
- TaskRun 队列、并发、pump、评论续跑、rerun。
- Report 导入与 Task 状态推导。
- Task 卡/Report 卡的最小 UI 读模型。

**退出条件**：Agent 自己建 Task（默认直接 `create_task`，`draft_task` 可选）；Task 在自己的 session 里执行；评论续跑同一 session；finish_task 回到 Chat；没有 Report 不能 done。

### Phase 4：Captain + Attention

- Captain Role、Prompt、工具面。
- `assign_in_group` 只发可见授权；目标 Agent 自己建 Task。
- Role 提案/创建的用户确认。
- Attention/Inbox 聚合、回答回流、通知合并。
- 用户命令：pause/resume/stop/retry/handoff/accept artifact/answer attention。

**退出条件**：用户不 @ 时消息进入 Captain；Captain 授权后目标 Agent 自己建 Task；用户能在 Inbox 回答并回到原 session。

### Phase 5：UI 重写

- 新 `RoomWorkspace`：Chat 时间线、角色栏、Task/Report/Attention/Artifact 卡、Trace 入口。
- 移除并发/顺序/自动讨论模式选择器。
- 移除 checkpoint/gate/seat/round 入口。
- 中英文文案、Escape/back、响应式。
- Electron 桌面模式验证。

**退出条件**：用户只通过消息、角色、Task、Report、Attention、Artifact 完成协作；不出现旧内部词汇。

### Phase 6：旧数据迁移 + 删除旧引擎

- 运行迁移工具，备份、导入、生成报告。
- 新 UI 只读新账本。
- 删除旧 engine、旧 runner、旧 UI 入口、旧 schema 代码。
- 删除不再使用的测试/样例。

**退出条件**：`rg` 不再有旧引擎调用点；全量测试/构建通过；旧数据可只读查看。

### Phase 7：真实 Provider 验收

- Claude Code：多角色群聊、mention 链、Task 创建/finish、评论续跑、重启恢复。
- Codex：至少一条同样的闭环。
- 全量检查按 `AGENTS.md`：

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
npm --prefix desktop run pack
```

**退出条件**：每个目标 Provider 至少一条真实闭环；恢复和权限边界通过；无旧引擎参与。

## 4. 验收标准

### 4.1 行为

- 用户 @ 多个角色 → 并发唤醒，各自在自己的 session 回答。
- 角色 A mention 角色 B → B 收到 A 的正文和上次之后的新消息。
- 角色自己 create Task → task session 执行 → finish_task → Chat 看到结果。
- 用户评论 Task → 同一 task session 续跑，不重读任务简报。
- rerun → 新 task session，从零开始。
- 重启 → 消息、任务、报告、session 指针、未完成 run 可恢复。
- 上下文过长 → 简报有界；session 轮换时有一次性 handoff；不无限重试。

### 4.2 治理

- Task/Role/Chat 归属校验通过；跨 Chat 引用拒绝。
- 用户命令幂等；重复点击不重复写。
- 权限不能由 Prompt 改写；写入需要授权和租约。
- Report 是唯一完成依据；自由文本不能把 Task 置 done。
- Attention 不重复；回答回到原 session。

### 4.3 架构

- 新 Chat 不依赖 checkpoint/gate/seat/round。
- 新 Chat 不依赖 Controller 批次。
- 新 Chat 不读写旧 workspace JSON。
- 旧引擎不在新 Chat 的运行路径上。
- 只有一套 session 语义、一套消息真源、一套 UI 入口。

## 5. 风险与应对

| 风险 | 应对 |
| --- | --- |
| 外部 CLI 的 session resume/steer 能力不一致 | 建立 adapter capability matrix；不支持 steer 就 queue；resume 失败就轮换 + handoff |
| 简报裁掉关键信息 | 100×2000 上限 + Session Handoff + 重要内容由 Agent 写进 Task/Artifact |
| 长 Chat 上下文仍然太大 | 简报有界；session 轮换；未来自管 runtime 才接压缩 |
| Report 解析不可靠 | 优先 MCP 工具；fallback 标记严格校验；无报告不猜完成 |
| 迁移丢数据 | 先备份、dry-run、迁移报告、失败回滚；旧库只读保留 |
| 权限/租约回归 | 保留现有安全测试；新 domain 只能调用既有权限层，不能绕过 |
| 重新长回 Controller | ADR 明确禁止平台拆任务；代码评审检查 `create_task` 只能由 Agent 工具触发 |
| 删除旧代码误伤 | 先 `rg` 调用点，再分阶段删除；每阶段可回滚 |

## 6. 不做什么

- 不做“新引擎跑新 Chat、旧引擎跑旧 Chat”的长期双轨。
- 不做“为了旧数据而保留旧 schema”的兼容字段。
- 不做 Controller 的隐藏批次兼容层。
- 不做 Assignment 与 TaskRun 的双模型。
- 不做旧 sessionRef 的伪造恢复。
- 不在第一阶段做隔离 worktree、跨 Chat 依赖、内置模型 runtime、memory sidecar。
