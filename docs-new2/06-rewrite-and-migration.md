# 06 重写与迁移

本文档说明如何从现有两代引擎过渡到目标架构。核心原则：**单一目标架构；旧数据一次性迁移或归档；不做长期双引擎、双读、双写。**

## 1. 重写范围

### 1.1 保留（基础设施）

| 模块 | 处理 |
| --- | --- |
| Electron main / preload / renderer 信任边界 | 保留 |
| `workspace/local-workspace-agent-invocation.cjs` | 保留，作为 RuntimeAdapter 底层 |
| `workspace/invocation-session.cjs` | 保留原语；通过 SessionStore port 适配到 SQLite |
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
| `room/timeline.cjs` | `room-engine/message-ingress.cjs` + messages 表重写 |
| `room/routing.cjs` | Controller 路由 + `mention-fallback.cjs` |
| `room/briefing.cjs` | v2 的 `promptOverride` 全量文本 |
| `room/session-store.cjs` | v2 `assignment-runner` 的一次性 session；旧 workspace JSON 的 session 映射 |
| `room/engine.cjs` | v2 Controller 批次 + assignment runner |
| `room/task-queue.cjs` | v2 的 Assignment/effect 派发 |
| `room/captain-review.cjs` | 无（新机制，复用 eta review supervisor） |
| `room/reports.cjs` | `room-engine/report-importer.cjs` / `report-state.cjs` 的思路重写 |
| `room/attentions.cjs` | v2 Attention 的读写重写 |
| `room/commands.cjs` | `room-engine/user-commands.cjs` 的语义重写 |
| `room/effects.cjs` | `room-engine/room-outbox.cjs` / `effect-pump.cjs` 的思路重写 |
| `room/supervisor.cjs` | `room-engine/session-supervisor.cjs` 的思路重写 + Captain review tick |
| `room/recovery.cjs` | `room-engine/runtime-recovery.cjs` / `process-reconciliation.cjs` |

### 1.3 退役（按依赖顺序）

**不要一次性删除。** 先解耦，再删除：

1. **新 domain 使用新目录 `desktop/src/room/`**，不要复用 `desktop/src/collaboration/`。现有 `collaboration/` 存放 context-pack/outcome/answer-marker 等模块；`InvocationSession` 仍依赖 `collaboration/context-pack-records.cjs`，不能删。
2. **解耦 `LocalWorkspace` 与 `LocalWorkspaceAutoRunner`**：`local-workspace.cjs:21` 仍 require auto-runner；`local-workspace-auto-runner.cjs:8-22` 又 require V4 文件。先把 invocation/session/trace/run-ledger 原语抽到 `runtime/`，让新 domain 不依赖 auto-runner；再删除 V2/V3/V4。
3. **解耦 `ProjectService` 与 checkpoint engine**：`project-service.cjs:18,39` 仍 require `checkpoint-engine.cjs` / `checkpoint-transitions.cjs`；`project-projection.cjs:2` 也 require transition。先移除旧 UI 入口/旧 service 使用，再删除。
4. **改写 `artifact-snapshots.cjs` / Trace 授权**：它们目前按 Assignment 键控（`artifact-snapshots.cjs:15-24,63-67`、`room-service.cjs:282-287`）；改成按 TaskRun/runId + Room 归属键控，再接入新 domain。
5. **删除旧 UI 入口**：`ProjectRoomGatePanel.vue`、`ProjectRoomSeatSettings.vue`、`ProjectRoomProgress.vue`、`ProjectRoomOverlay.vue` 从导航移除后，再删组件。

删除清单：

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

## 2. 数据迁移

### 2.1 新数据库

- 新账本：`userData/meldwork-private/room/room.sqlite`
- 旧账本：`userData/meldwork-private/room-engine/` 与 `meldwork-workspace.json`
- 新架构只读写新账本；旧账本在迁移完成后只读归档，不再参与运行时。
- 新代码目录：`desktop/src/room/`；旧 `room-engine/` 只作为历史实现参考。

### 2.2 Source → Target 矩阵

| 旧来源 | 新目标 | 规则 |
| --- | --- | --- |
| checkpoint project | `rooms` + primary `chats` | 一个 project 至少一个 Room；需要时建一个 primary Chat |
| project messages / rounds | `messages` | 按原顺序生成 `seq`；保留原始 id 引用 |
| seats / roles | `chat_roles` | 保留名称、Provider、能力；Prompt 进 `role_prompt_revisions` |
| checkpoint tasks | `tasks` | 保留编号；冲突时新增编号并记录映射 |
| old assignments | `task_runs` | 按 assignment id 映射，不按 task id 折叠；保留 attempt/status |
| old reports | `reports` | 按 assignment id 关联；多个 attempt 不合并 |
| artifactVersions | `artifacts` | 保留 path/version/commit；接受状态映射 |
| attentions / gates | `attentions` | 保留问题/选项/回答；内部 gate 细节丢弃 |
| checkpoint/gate/seat/round state | 归档 | 不迁移为运行时状态；需要时作为只读 JSON 附件 |
| v2 rooms | `rooms` | 保留 workspace/providers/capabilities；写授权按当前 realpath 重验 |
| v2 chats | `chats` | 保留 title/status；legacy 标记只读，不进入新运行路径 |
| v2 agent_roles | `chat_roles` + `role_prompt_revisions` | 保留 Provider/Prompt/能力/native_permission；is_captain 映射 |
| v2 chat_context_revisions | `chat_context_revisions` | 保留 revision/instructions；来源 ID 保留 |
| v2 messages | `messages` | 映射 author_type/status/mentions/data；Controller note 作为历史消息 |
| v2 tasks / reports / attentions / artifacts | 同名新表 | 按 assignment/run 归属映射；Artifact 保留 commit/version |
| v2 assignments | `task_runs` | 按 assignment id 映射；report 按 assignment 关联；不重建旧 Assignment 模型 |
| v2 controller_decisions | `events` / 归档 | 不再保留 decisions 表；决策作为历史审计事件 |
| v2 effects | 归档 / 按 kind 转换 | 不能只迁 status；旧 kind 的 handler/payload 与新引擎不同。旧 pending 默认不取得新引擎执行资格；按下方 kind 表转换 |
| Trace JSONL | 原文件保留 | 新库只存引用；按新 Room/TaskRun 重新授权，不重写历史 Trace |
| shadow Git | 原仓库保留 | Artifact commit/diff 引用保留；不重写历史；按新 Artifact 授权读取 |

- 旧 sessionRef：不能只因 Provider 匹配就恢复；必须同时校验 scope、工作目录 realpath、权限模式和 Role，全部匹配才写入 `sessions`；否则从新 session 开始。
- Task 编号：保留原编号；冲突记录映射表。
- 迁移前先停止启动新 run；活跃 run 标 `status=interrupted, outcome=unknown`，活跃 effect 标 `unknown`；完成进程对账后才允许 retry/handoff；迁移窗口内不双写。
- 迁移工具必须 dry-run、幂等、可回滚；迁移报告写入私有区。

**v2 effect kind 迁移表**

| v2 kind | 处理 |
| --- | --- |
| `start_assignment` | **只归档**。新引擎只有在迁移后的 TaskRun 仍是 active 且用户显式 retry 时，才创建新的 `start_run`；不消费旧 effect。 |
| `artifact_snapshot` | 默认归档；仅当对应新 TaskRun/Artifact 已存在且 run 已结算时，才转换为新快照意图；否则归档 + 报告。 |
| `stop_assignment` | 默认归档；仅当迁移后的 TaskRun 仍 active/unknown 且进程对账确认后，才创建新的 stop 意图；否则归档。 |
| 其他 / 未知 | 归档 + 迁移报告；不自动执行。 |

旧 `pending` effect 不因状态为 pending 就取得新引擎执行资格；转换必须同时满足 kind 白名单、目标对象存在、权限/租约和幂等键校验。

### 2.3 一次性迁移步骤

1. 停止启动新 run；等待当前写入/租约收口；迁移窗口内不双写。
2. 备份旧 checkpoint 账本和 v2 SQLite（复制到带时间戳的目录）。
3. 读取两种旧结构，生成迁移计划（dry-run）。
4. 写入新 Room/Chat/Role/Participant/Message/Task/TaskRun/Report/Artifact/Attention；活跃 run 标 `status=interrupted, outcome=unknown`，effect 标 `unknown`；旧 effect 按 kind 表归档/转换，不默认执行。
5. 写入 `legacy_imported` 标记和迁移报告。
6. 校验数量、编号、Report 归属、Artifact/Trace 引用；进程对账完成后再允许 retry/handoff。
7. 迁移失败回滚新库；旧库不动。
8. 迁移成功后旧库只读；UI 只显示新库。

### 2.4 不做的事

- 不做旧 JSON + 新 SQLite 双读。
- 不做旧 checkpoint engine 与新 engine 双跑。
- 不做旧 Chat 的长期“legacy 模式”。
- 不为了兼容旧消息格式而在新表里加旧字段。
- 不为旧 session 伪造原生 session 恢复；恢复不了就从新 session 开始。
- 不把 checkpoint/gate/seat/round 迁移成新状态机。

### 2.5 迁移后的 UI

- 只显示新账本。
- 旧数据如果需要展示，标记为“已归档/导入”，只读。
- 旧项目室入口从导航移除；旧组件删除或降级为历史查看器。

## 3. 实施阶段

> 这是方向性阶段，不是详细计划；详细文件级计划在评审通过后由 `writing-plans` 产出。

### Phase 0：冻结目标与清理边界

- 批准 `docs-new2`。
- 明确被取代的旧 ADR/文档。
- 列出保留/重写/删除清单，以及依赖顺序。
- 为纯函数建立测试骨架：routing、briefing、session key、task state、captain review checkpoint。
- 不写产品代码。

**退出条件**：目标模型、数据表、模块边界、删除顺序、测试骨架都无歧义。

### Phase 1：新账本 + 时间线 + 路由 + 简报

- 新建 `room.sqlite` 与 schema/migration；**先建最小表**（Room/Chat/Role/Participant/Message/Session/TaskLane/Event/Effect）。Phase 2.5 需要的最小 Task/TaskRun/Report/Artifact/CaptainReview 表也在此先建薄版；完整字段和迁移按 Phase 3/4 增量补齐，不要一次铺完。
- 实现 Room/Chat/Role/Participant/Message/Session/TaskLane 的 repository。
- 实现 Message 追加、seq、revision、client_id、status、编辑/删除事件。
- 实现 routing 和 briefing 的纯函数 + 定向测试；简报返回 `omittedSeqs`/`truncatedIds`，实现当前 Chat 的 `read_chat` 分页。
- 实现 SessionStore 的 key/baseline/水位；先不接真实 CLI。
- 冻结 Task、TaskRun、Effect 的状态枚举与 outcome 定义，确保全文一致。

**退出条件**：给定一组消息和 participant 水位，能生成正确的增量简报；同一消息不会重复投递；未完成行阻塞水位；session 轮换不丢 participant 水位；状态枚举无 `failed/interrupted/waiting/unknown` 混用。

### Phase 2：Engine + RuntimeAdapter + resume proof

- 把 queued reply 行变成运行。
- 接 Meldwork 现有 `invokeAgent` 和 `InvocationSession`；通过 SessionStore port 写 SQLite。
- 实现 resume/create/rotate。
- 实现 `mention` 工具与 wake budget；MCP 是完整工具循环，标记只支持单一终止动作。
- 实现 stop/steer/restart 恢复（`interrupted/unknown`）。
- 所有进程启动走 `start_reply` effect；effect 成功 = 进程已启动/登记，pump 不 await 整段 run。
- 实现当前 Chat 的 `read_chat` 分页补读；编辑追加事件并推进 `activity_seq`。

**Resume proof（硬门槛）**：
- Claude Code：第一次 prompt 让 Agent 记住一个事实；第二次用同一 native session resume，问它这个事实；确认它接着上次上下文；测一次 CLI 重启后、一次长对话/压缩后。
- Codex：同样。
- 记录 token 使用、resume 成功/失败、压缩后是否丢上下文。
- **如果 resume 失败，停止 Phase 2，不进入 Phase 3；要么改回无记忆模式，要么先做平台 handoff。**

**退出条件**：两个角色可以并发回答；一个角色 mention 另一个；重启后 queued 继续、working 转 interrupted、session 指针保留；两个 CLI 的 resume proof 通过；工具结果能回传给运行中的 session。

### Phase 2.5：架构接缝纵向验证（先于完整 UI/schema）

只验证最难的外部 CLI 接缝，不做完整 UI：

```text
持久 Session
→ 真实 MCP 工具调用与结果回传
→ 创建独立 Task session
→ finish_task 完成声明
→ 进程退出确认
→ Artifact 快照/结算
→ Captain review
```

- 先建这条链用到的最小表：Task / TaskRun / Report / Artifact / CaptainReview / CaptainAssignment / Effect；不需要完整 UI 或全量迁移。
- 不允许用替身模拟全部模型返回；至少一个真实 CLI 跑通这条链。
- 如果 MCP 不可用，验证受限标记的终止动作，并明确它不能替代完整工具循环。
- 这条链跑通前，不铺完所有 UI 和旧数据迁移。

**退出条件**：真实 CLI 能完成“会话 → 工具 → Task → 结算 → review”的接缝；effect 不串行化并发；finish_task 不会在退出/快照前进入 in_review。

### Phase 3：Task + TaskRun + lane + Report

- Agent 工具：`create_task`、`draft_task`、`list_tasks`、`get_task`、`read_task`、`comment_task`、`finish_task`。
- TaskRun 队列、lane、writeScopes、并发、pump、评论续跑、rerun；`start_run` effect 成功 = 进程启动，不是运行结束。
- Report 导入与 Task 状态推导；`accept_task` / `reject_task`。
- `finish_task` 完成声明与结算分离：写入型 = 退出确认 + after 快照 + Artifact 合并后才 `in_review`/`blocked`；只读型 = 退出确认 + Report 校验 + `snapshot_state=not_applicable`。
- Task 卡/Report 卡的最小 UI 读模型。
- 一次性 CLI 的评论/回答排队 continuation run。

**退出条件**：Agent 默认直接 `create_task`；Task 在自己的 lane session 里执行；评论续跑同一 lane；finish_task 回到 Chat；没有 Report 不能 done；写入型 run 的退出/快照完成前不能 in_review/accept_task；只读 run 的 `snapshot_state=not_applicable` 且 Report 校验后才 in_review；writeScopes 校验通过；TaskRun outcome 能表达 known/unknown。

### Phase 4：Captain + Captain review supervisor + Attention

- Captain Role、Prompt revision、工具面（限定 Chat）。
- `assign_in_group` 只发一条可见授权；不得以 Captain 自己为目标；无合法目标就报错。
- 授权消息 + `captain_assignments` + 目标 queued reply 同一事务；reply 存 `captain_assignment_id`；目标自己建 Task，不能改派 assignee。
- `captain_assignments` / `captain_reviews`；150ms 任意领域变化 debounce（快路径）+ 60 秒兜底 tick；只合并同 Chat pending review；checkpoint/dedupe/backoff。
- Attention/Inbox 聚合、回答回流、通知合并。
- 用户命令：pause/resume/stop/retry/handoff/accept_task/reject_task/answer_attention。

**退出条件**：用户不 @ 时消息进入 Captain；Captain 授权后目标 Agent 自己建 Task；Task 结算后 review supervisor 唤醒 Captain；`hasNew` 使用 `max(checkpoint, assignment 消息 seq)` 基线；没有 Task 的 assignment 回复也能生成 `assignment_settled`；只合并同一 Chat 的 review；review 流量不推进 `activity_seq`；三阶段 Prompt 工作流可以跑通；`assign_in_group` 和 review 都不占 5 次 mention 预算；没有 completion wake/独立预算。

### Phase 5：UI 重写

- 新 `RoomWorkspace`：Chat 时间线、角色栏、Captain Prompt 编辑、Captain review 卡、Task/Report/Attention/Artifact 卡、Trace 入口。
- 移除并发/顺序/自动讨论模式选择器。
- 移除 checkpoint/gate/seat/round 入口。
- Chat 回复只读提示；Task 写入授权与 writeScopes 展示。
- 中英文文案、Escape/back、响应式。
- Electron 桌面模式验证。

**退出条件**：用户只通过消息、角色、Task、Report、Attention、Artifact 完成协作；不出现旧内部词汇；renderer 不接收原生 session 引用/绝对路径/进程句柄。

### Phase 6：旧数据迁移 + 删除旧引擎

- 运行迁移工具，备份、dry-run、导入、校验、生成报告。
- 新 UI 只读新账本。
- 按依赖顺序解耦/删除旧 engine、旧 runner、旧 UI 入口、旧 schema 代码。
- 删除不再使用的测试/样例。

**退出条件**：`rg` 不再有旧引擎调用点；全量测试/构建通过；旧数据可只读查看；`desktop/src/collaboration/` 未被新 domain 覆盖。

### Phase 7：真实 Provider 验收

- Claude Code：多角色群聊、mention 链、Captain review、Task 创建/finish、评论续跑、重启恢复、resume proof。
- Codex：至少一条同样的闭环；如果工具通道不可用，验证标记 fallback。
- 全量检查按 `AGENTS.md`：

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
npm --prefix desktop run pack
```

**退出条件**：每个目标 Provider 至少一条真实闭环；恢复和权限边界通过；无旧引擎参与；无 completion wake。

## 4. 验收标准

### 4.1 行为

- 用户 @ 多个角色 → 并发唤醒，各自在自己的 session 回答。
- 角色 A mention 角色 B → B 收到 A 的正文和上次之后的新消息。
- 角色自己 create Task → task lane session 执行 → finish_task → Chat 看到结果。
- 用户评论 Task → 同一 lane session 续跑，不重读任务简报；一次性 CLI 排队 continuation run。
- rerun → 新 lane session，从零开始。
- 重启 → 消息、任务、报告、session 指针、未完成 run 可恢复；消息 `working` → `interrupted`；TaskRun `status=interrupted, outcome=unknown`；不伪造退出。
- 上下文过长 → 简报有界；session 轮换时有一次性 handoff；不无限重试。
- Captain 三阶段 Prompt → review supervisor 逐阶段唤醒 Captain；`hasNew` 用 `max(checkpoint, assignment 消息 seq)` 基线；3 次 `assign_in_group` 是普通消息，不占 5 次 mention；3 次 review 是 system 消息，也不占；5 次只约束 Agent 的 `mention` 工具调用。只合并同一 Chat 的 pending review；review 行和 review reply 不推进 `activity_seq`，`post_in_chat` 例外。

### 4.2 治理

- Task/Role/Chat 归属校验通过；跨 Chat 引用拒绝。
- 用户命令幂等；重复点击不重复写；所有改变状态的命令带 `commandId`。
- 权限不能由 Prompt 改写；写入需要授权、writeScopes 和租约。
- Report 是唯一完成依据；自由文本不能把 Task 置 done；Artifact 状态不单独完成 Task。
- Attention 不重复；回答回到原 session 或 continuation run。
- Captain 工具限定所属 Chat；不能跨 Chat 读取/写入。

### 4.3 架构

- 新 Chat 不依赖 checkpoint/gate/seat/round。
- 新 Chat 不依赖 Controller 批次。
- 新 Chat 不读写旧 workspace JSON。
- 旧引擎不在新 Chat 的运行路径上。
- 只有一套 session 语义、一套消息真源、一套 UI 入口。
- 没有自创 completion wake、独立 completion 预算或 `stage_complete`。

## 5. 风险与应对

| 风险 | 应对 |
| --- | --- |
| 外部 CLI resume 不可靠 | Phase 2 resume proof；失败则停止并改设计 |
| CLI 压缩后丢失平台已投递内容 | `last_seq` 只保证投递；重要事实落 Task/Report/Artifact；轮换 handoff |
| 工具通道不可用 | MCP 完整循环优先；标记只支持单一终止动作，无结果回传；不支持的 CLI 只作只读参与者 |
| 简报裁掉关键信息 | 100×2000 上限 + `omittedSeqs`/`truncatedIds` + `read_chat` 补读 + Session Handoff + Task/Artifact |
| Report 解析不可靠 | MCP 工具优先；标记严格校验；无报告不猜完成 |
| Effect pump 串行化并发 | ADR-N20：启动成功 = 进程已启动/登记，pump 不 await 整段 run；并发由 lane/机器/租约控制 |
| finish_task 提前结算 | 完成声明与结算分离：写入型退出+快照+Artifact，只读型退出+Report+`snapshot_state=not_applicable`；快照失败不结算；accept_task 只能在结算后 |
| 迁移丢数据 | 备份、dry-run、source→target 矩阵、迁移报告、失败回滚；v2/active/unknown 单独处理 |
| 权限/租约回归 | 保留现有安全测试；新 domain 只能调用既有权限层 |
| 重新长回 Controller | ADR 明确禁止平台拆任务；`create_task` 只能由 Agent 工具触发 |
| 删除旧代码误伤 | 依赖顺序表；先解耦 LocalWorkspace/ProjectService；每阶段可回滚 |
| Chat 回复写文件 | Chat 默认只读；写入只在 TaskRun；隔离前写入并发 1 |
| Captain 自我派发 | 不得以 Captain 为目标；无合法目标报错；assignment 因果链持久化 |
| Captain review 循环 | assignment 消息基线 + checkpoint/dedupe/idle + `activity_seq` 排除 review 流量；`post_in_chat` 例外由 Prompt 约束 |
| 状态含义不一致 | Task/TaskRun/Effect 分开定义；TaskRun 用 outcome 表达 unknown；无 Report 的已知退出和未知退出分开 |

## 6. 不做什么

- 不做“新引擎跑新 Chat、旧引擎跑旧 Chat”的长期双轨。
- 不做“为了旧数据而保留旧 schema”的兼容字段。
- 不做 Controller 的隐藏批次兼容层。
- 不做 Assignment 与 TaskRun 的双模型。
- 不做旧 sessionRef 的伪造恢复。
- 不默认执行旧 pending effect；只按 kind 白名单转换。
- 不做自创 Captain completion wake / 独立 completion 预算 / `stage_complete` 工具。
- 不把文本标记当成完整工具循环；不把 `finish_task` 当成结算完成。
- 不在第一阶段做隔离 worktree、跨 Chat 依赖、内置模型 runtime、memory sidecar。
