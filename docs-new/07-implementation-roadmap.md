# v2 实施路线图

这份文档把 `docs-new` 的架构决策转成可执行的工程计划。它描述先做什么、复用哪些现有能力、每一步怎样验收，以及哪些事项明确不进入首个切片。

## 当前实现状态（2026-11-15）

首个可回滚切片已落地：`desktop/src/room-engine/` 提供基于 Electron Node 运行时 `node:sqlite` 的私有账本骨架，覆盖 Room、Chat、Message、Task、Assignment、Report、Artifact、Attention、ControllerDecision、Effect 和 Event 表；Repository 已支持创建 Room/Chat、追加消息、角色、Assignment、Report、Artifact、Attention、任务和 outbox effect，`message-ingress.cjs` 已提供统一消息校验、@提及提取、编辑/删除和事件写入，`room-actions.cjs` 已分离并校验 ControllerAction、UserCommand、PlatformTransition，Controller 可将创建任务、派发、角色和 Attention 建议落到账本。`room-outbox.cjs` 已提供外部副作用的幂等入队、`pending → running → succeeded/failed/unknown` 状态机、批量 claim、失败记录和 unknown 恢复重试；`report-importer.cjs` 已严格解析 Worker 机器标记，校验 Chat/Task/Assignment 归属，以 reportId 幂等写入 Report 和 `report_received` 事件；`session-supervisor.cjs` 已记录由 Supervisor 观察到的 session started/liveness/exited 事实，并能按最近 liveness 查询 stale Assignment。副作用执行前先持久化 effect，应用重启后可继续扫描未完成项。事务失败会回滚，数据库关闭后可重开恢复。数据库目录使用 `0700`、数据库文件使用 `0600`（Windows 除外）。

当前切片仍未接入 Renderer、Controller Session、真实 `invokeAgent` 映射或旧 Chat 迁移；这些保持在后续 Phase 1–4，避免改变现有 checkpoint 执行链。专项账本测试和 Electron 39 runtime spike 已通过；仓库全量测试受既有 workspace 长测及环境权限失败影响。

## 实施原则

1. 新引擎与旧 checkpoint engine 并存。新 Chat 走 v2 账本，旧 Chat 保持 legacy 行为。
2. 先建立事实账本和统一消息管线，再接入 Controller 和动态组队。
3. 每一步都必须可重启、可回滚、可观测；任何外部副作用先进入 effects/outbox。
4. Controller 只产生受校验的建议，Worker 只提交 Report；Task 状态由 Room Engine 和平台事实产生。
5. 不在首个切片实现跨 Chat Task 依赖、默认隔离 workspace、自动删除旧引擎或新的远程服务。

## 目标切片

首个可交付切片只覆盖一个 Room、一个新 Chat、两个已有 Agent 角色和一条完整闭环：

```text
用户消息/@mention
  → SQLite Message
  → Controller/fallback 创建 Task
  → 两个 Assignment 执行
  → Report(kind=ready)
  → 文档 Artifact
  → 评审 Assignment
  → Attention
  → 用户 answer_attention
```

验收时，用户只看到消息、Task、Report、Attention 和 Artifact；不出现 checkpoint、Gate、Seat、Round 或讨论模式选择器。应用重启后，消息、Task、Assignment、Report 和 effects 不丢失，也不重复创建。

## 工程分层与代码落点

### 账本与迁移层（Desktop main）

新增 `desktop/src/room-engine/`，首版至少包含：

- `room-db.cjs`：SQLite 打开、WAL、外键、schema version 和事务边界；
- `room-schema.cjs`：rooms、chats、messages、agent_roles、tasks、assignments、reports、artifacts、attentions、controller_decisions、effects、events；
- `room-migrations.cjs`：schema migration、state.json 备份和失败回滚；
- `room-repository.cjs`：领域对象的查询和写入；
- `room-actions.cjs`：ControllerAction、UserCommand、PlatformTransition 的校验与落盘；
- `room-outbox.cjs`：effect 入队、幂等、重试和 unknown 恢复；当前已实现基础状态机，真实 effect runner 仍在 Phase 3 接入。
- `report-importer.cjs`：解析严格的 `[[MELDWORK_REPORT:{...}]]` 机器标记，写入 Report 真源和 `report_received` 审计事件；不从自由文本推断任务完成。
- `session-supervisor.cjs`：由主进程记录 session liveness 和退出事实，并查询 stale Assignment；Worker 自报消息不构成 liveness 证明。

复用 `desktop/src/project-room/project-state-schema.cjs`、`project-state-migrations.cjs`、`project-store.cjs` 的迁移经验，但不把新的 Task 状态继续塞进 checkpoint engine。复用 `desktop/src/security/private-file.cjs` 保证数据库目录权限，数据库放在应用私有区，不放入 Room 主目录。

### 运行与通讯层（Desktop main）

复用和适配：

- `desktop/src/runs/invocation-watchdog.cjs`：Supervisor liveness 和进程退出观察；
- `desktop/src/runs/run-event-protocol.cjs`、`run-ledger.cjs`：Run Ledger 与 Assignment/runId 映射；
- `desktop/src/runs/path-claims.cjs`：Room 主目录写入租约；
- `desktop/src/workspace/local-workspace-agent-invocation.cjs`、`invocation-session.cjs`：保留原生 Agent 调用；
- `desktop/src/project-room/shadow-git.cjs`：代码 Artifact 的 commit/diff 引用；
- `desktop/src/project-room/effect-runner.cjs`：迁移为消费 v2 effects/outbox。

新增 `desktop/src/room-engine/session-supervisor.cjs` 和 `message-ingress.cjs`，分别负责 liveness 事实和统一 Message 入队。Worker 正文不得直接生成 ControllerAction；Report 只能通过窄工具或严格机器标记导入。

### Controller 层（Desktop main）

新增 `desktop/src/room-engine/controller-session.cjs`：

- 按 Chat 批量读取待处理 Message、Report 和平台事件；
- 携带 `batchId`、`contextRevision` 和幂等键调用 Controller；
- 只接受 ACP 工具调用或严格 JSON block；
- 将动作交给 `room-actions.cjs` 校验；
- Controller 不可用时回退到显式用户 @mention 的确定性派发；
- 记录 `controller_decisions`，不把长篇推理写入 Thread。

Controller Prompt、角色 Prompt 和 ChatContext revision 通过 `chat-context.cjs` 管理；Prompt 只能影响协作建议，不能修改权限、租约、Provider 白名单或持久化事实。

### Renderer 与 UI 层

先增加 v2 读模型和窄 preload API，再替换 UI：

- preload 只暴露 Room/Chat 查询、消息提交、UserCommand 和订阅事件；
- 复用 `frontend/src/composables/useProjectRoom.js`、`useProjectRoomView.js`、`useConversationTimeline.js`；
- 新增或改造任务卡、Report 卡、Attention 卡和 Artifact 卡；
- `ProjectRoomGatePanel.vue`、`ProjectRoomSeatSettings.vue` 等旧组件在新 Chat 中不再作为入口，旧 Chat 仍可使用；
- 所有新增文案进入 `frontend/src/locales/zh.js` 和 `en.js`。

## 分阶段执行

### Phase 0：运行时 Spike 与协议冻结

工作项：

- 在 Electron 当前版本验证 `node:sqlite`、WAL、事务和打包可用性；不可用时再评估 native SQLite 方案；
- 把 01、02、04 中的 schema 转成 JSON Schema 或等价运行时校验；
- 固定 Report.kind 到 Task 状态的映射；
- 固定 UserCommand、PlatformTransition、effects unknown 恢复规则；
- 明确应用私有区路径、权限、备份和迁移失败回滚。

退出条件：Spike 有可复现记录；协议校验能拒绝未知字段、错误 actor、过期 contextRevision 和重复幂等键；不修改现有用户数据。

### Phase 1：SQLite 账本与统一消息管线

工作项：

- 建立数据库 schema、迁移版本和 repository；
- 实现 Message 入库、sequence、编辑/删除事件和事件队列；
- 实现 Chat/Task/Assignment/Report/Attention 的最小查询；
- 为旧 V4 数据建立只读 legacy 标记和一次性导入工具；
- 写入 effects/outbox，但先只接入无破坏性的系统消息副作用。

退出条件：新 Chat 的消息只从 SQLite 读取；重启不会丢消息；同一幂等键不会产生重复 Task；旧 Chat 仍由旧引擎打开。

### Phase 2：Assignment、Session 与 Report

工作项：

- 将 `Assignment` 映射到现有 `invokeAgent`、native session 和 Run Ledger；
- 接入 Supervisor liveness、session_started/exited 和 stale 恢复；
- 兼容现有 `ready/question/continue` 回执，转换成 Report；
- 实现 Room 主目录租约和 shadow Git Artifact 引用；
- 记录 Agent 正文消息与结构化 Report 的关联。

退出条件：一个 Agent 运行一小时后仍能提交 Report；进程退出和应用重启都能恢复 Assignment；没有 Report 时不能把 Task 标记为 done；代码变更能生成可追踪 Artifact。

### Phase 3：Room Engine 与确定性 fallback

工作项：

- 实现 ControllerAction、UserCommand、PlatformTransition 的分离校验；
- 实现 create_task、assign、request_attention、accept_artifact、answer_attention 等最小动作；
- 实现 Controller 不可用时的显式 @mention fallback；
- 接入 outbox effect runner，处理 pending/running/succeeded/failed/unknown；
- 增加审计事件和 action result 卡。

退出条件：用户 @Agent 可以创建 Task；Agent 的 @Agent 只能进入 Controller 建议；Worker 文本不能伪造 action；Controller 故障时项目室仍可继续接收消息和执行已启动任务。

### Phase 4：Controller Session

工作项：

- 实现按 Chat 批处理、去重、退避和 stale session 重启；
- 接入 Controller Prompt、ChatContext revision 和角色 Prompt revision；
- 支持 create_task、reassign（仅未启动 Assignment）、update_context、create_role、propose_retry/propose_stop；
- 将 Controller 长文本推理留在 Trace，只在 Thread 展示简短派发说明；
- 建立路由误派、重复派发、Attention 数量和成本指标。

退出条件：两条并发消息只触发一个批次；过期 action 被拒绝或重排；Controller 不能越过平台边界；决策可通过 batchId 和 contextRevision 审计。

### Phase 5：动态角色与新 Chat UI

工作项：

- 实现建议模式的动态角色草案；
- 实现受限自动模式：只能绑定 Room 已有 Provider 和能力；
- 支持角色 Prompt revision、复用、idle 和 archive；
- 将 UI 改为群聊 + Task/Report/Attention/Artifact 卡；
- 新 Chat 隐藏并发/顺序/自动讨论模式入口。

退出条件：用户可在同一 Chat 中新增生图角色并让已有 Agent 请求它；新角色不污染其他 Chat；高成本 Provider、长期角色和额外能力会产生 Attention。

### Phase 6：可选隔离 workspace 与旧模式退役

工作项：

- 仅为明确需要的 Assignment 提供隔离 workspace；
- 定义输入 Artifact、输出 patch/commit 和发布校验；
- 旧 Chat 保持兼容，逐步移除新 UI 中的 checkpoint/gate/seat/round 入口；
- 统计共享主目录冲突后，再决定是否扩大隔离模式。

退出条件：共享模式的租约冲突可拒绝或串行化；隔离模式可发布可审计 Artifact；旧模式不再成为新 Chat 的隐式依赖。

## 测试与验收矩阵

每个阶段至少补充以下测试：

| 范围 | 必测内容 |
| --- | --- |
| SQLite | schema migration、事务回滚、WAL、幂等键、备份恢复 |
| 权限 | Controller/User/Platform action 隔离、作者伪造、Prompt injection 文本不生效 |
| 调度 | 批处理、重复消息、过期 action、Controller 不可用 fallback |
| 运行 | liveness/stale/exited、长任务 Report、重启恢复、unknown effect |
| workspace | 租约冲突、shadow Git Artifact、隔离 workspace 发布 |
| UI | 中英文、Attention 回答、Escape 返回、旧 Chat 兼容、新 Chat 无旧模式入口 |

仓库级检查沿用 AGENTS.md：

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
npm --prefix desktop run pack
```

文档阶段不要求先运行上述命令；进入对应代码阶段后，阶段验收必须记录实际执行结果。

## 暂不实施的事项

- 跨 Chat Task 依赖和全局依赖图；
- 将完整 Trace、聊天正文或 Artifact 内容塞进 SQLite；
- 所有 Assignment 默认复制 worktree；
- 新的远程服务、云端消息或远程参与者；
- Controller 直接停止进程、直接设置 Task done/cancelled；
- 通过解析自由文本猜测完成、授权或用户审批；
- 在新引擎稳定前物理删除旧 checkpoint engine。

## 首轮开发顺序

实际开发按以下顺序提交，每个提交保持可回滚：

1. SQLite runtime spike 与 schema/migration 骨架；
2. Message、Event、effects/outbox repository；
3. Chat/Task/Assignment/Report 读写与 legacy 投影；
4. Session Supervisor、Report importer 和 invokeAgent 映射；
5. 确定性 fallback 与最小 Room Engine action；
6. Controller batch session；
7. 新 Chat UI 与 Attention/Artifact 卡；
8. 动态角色和受限自动组队；
9. 可选隔离 workspace 与旧模式清理。

每个提交都应附带迁移说明、测试结果和回滚方式；未经 Phase 0/1 验收，不开始动态组队和旧模式删除。
