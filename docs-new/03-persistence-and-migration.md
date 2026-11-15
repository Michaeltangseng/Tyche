# 持久化、运行时边界与迁移

## SQLite 账本

新项目室需要保存 Chat、动态角色、Prompt revision、Task、Report、Attention、事件审计和 Controller 决策。SQLite 适合做本地单库账本，按 `room_id` 和 `chat_id` 隔离数据；不建议为每个 Chat 建一个数据库文件。

权威数据库和 Trace 放在应用私有区 `userData/meldwork-private`，按 `room_id` / `chat_id` 隔离；项目主目录不默认放 `db.sqlite`、聊天记录或角色配置，避免污染 Git、意外同步敏感记录和改变项目复制语义。项目目录只保存用户明确产生的文档、代码和 Artifact。需要自包含导出时，使用显式导出目录，不自动修改用户 `.git` 配置。

建议表：

```text
rooms
chats
messages
chat_members / agent_roles
role_prompt_revisions
chat_context_revisions
tasks
assignments
reports
artifacts
attentions
controller_decisions
effects / outbox
events
```

关键约束：

当前 schema version 为 3：`rooms.write_authorized_root` 保存用户明确授权的真实工作目录，默认 NULL（只读）；v2 数据库升级时既有 Room 不自动获得写权限。授权变更与用户命令审计在同一事务中提交，命令通过 commandId 幂等；数据库继续留在应用私有区。

- 使用 WAL、外键、事务和 schema version；
- 所有写入由 Room Engine 统一提交；
- Controller action 先持久化，再执行外部副作用；
- `effects / outbox` 记录待执行副作用、幂等键、重试次数、错误和完成时间；至少包含 `id、chatId、actionId、kind、status、payload、idempotencyKey、attempts、lastError、createdAt、startedAt、completedAt`；
- 用幂等键避免重复创建 Task、Assignment 和消息；
- 事件记录“谁在何时做了什么”，决策记录“主控使用了哪个 ChatContext revision”；
- Report 是任务事实的唯一真源；Event 只引用 `reportId`、`actionId` 或平台事实，不重复维护另一套状态；
- 消息和事件需要压缩/保留策略，避免无限增长。

副作用状态至少区分 `pending | running | succeeded | failed | unknown | cancelled`。应用在 `running` 时崩溃或外部调用结果不可确认，恢复器不得盲目重试：幂等且可安全重试的 effect 可以重新入队；非幂等或已可能产生外部结果的 effect 进入 `unknown`，创建 Attention 等待用户或平台探测确认。`controller_decisions` 记录批次的输入消息/事件、`batchId`、`contextRevision`、动作结果、模型、延迟和成本。

实现前需要确认 Electron 运行时是否支持可用的 `node:sqlite`。若支持，优先使用它以避免原生模块打包和 rebuild；否则评估 `better-sqlite3` 等方案的桌面打包成本。SQLite 迁移必须覆盖现有 `state.json` 数据，不应以破坏旧项目为代价。

## Trace 与 Artifact 不直接塞进 SQLite

SQLite 保存引用和索引：

```text
Trace:    runId / agentRunId / jsonlPath
Artifact: roomId / taskId / path / commit / status
Diff:     shadow Git commit 或版本引用
```

完整 Trace 继续由 M7 的 JSONL 和现有脱敏机制管理；产物内容继续由工作目录和影子 Git 管理。这样数据库保持适合查询的账本，运行日志和大型文件不被复制进单一数据库。

## Message 真源与旧数据迁移

新 Chat 的 Message 以 SQLite 为唯一真源；UI 不双读新 SQLite 和旧 workspace JSON。迁移旧项目时：

1. 备份原 `state.json`、workspace JSON 和旧消息文件；
2. 为旧项目创建 `Chat(engineVersion=legacy)`；
3. 将可识别的旧消息导入 SQLite，保留原始 message id、原始文件路径和迁移批次；
4. 未能安全解析的旧记录只保留只读原始引用，不猜测为新 Message/Report；
5. 旧 Chat 继续由旧 engine 运行，新 Chat 只写 SQLite；
6. 迁移失败时回滚本次数据库事务，保留备份，不删除旧数据。

这样不会出现新消息写 SQLite、旧消息又从 JSON 投影导致的双真源。旧记录的原始文件只用于审计和兼容查看。

## invokeAgent、Session 与 Run Ledger 映射

新模型不要求立即重写现有 `invokeAgent`。第一阶段采用兼容映射：

| 现有概念 | 新概念 |
| --- | --- |
| 项目室主流程群聊/宿主群聊 | Chat 的内部宿主会话，用户不再看到“主流程”术语 |
| group/message | Chat/Message，保留原始 message id 作为迁移引用 |
| Agent 调用 | Assignment |
| 原生会话键 | `roomId/chatId/taskId/assignmentId/roleId` 组成的稳定 Session key |
| agentRunId / Run Ledger | Assignment.runId 和执行事件引用 |
| 现有 workspace JSON | 迁移为 Message/Task/Report 投影；原始记录保留只读引用 |
| V4 旧项目 | 继续使用旧引擎，或通过只读投影显示为新 Task/Report |

v2 原生执行已改为临时执行描述，不再创建或查找持久化宿主群聊；上表的旧宿主记录只属于历史数据映射，不作为新 Chat 执行前提。新的 Room Engine 是 Chat、Task、Assignment、Report 和 Attention 的唯一业务写入者。Trace 仍由现有运行链写 JSONL，SQLite 只保存 `runId` 和路径引用。当前原生 Session 不写回旧 workspace JSON，也尚未保存 sessionRef 用于 v2 续跑，见 ADR-005。

## 旧群聊模式退役

“并发回复 / 顺序讨论 / 自动讨论”从新 UI 中删除模式选择器，但不立即物理删除底层能力：

```text
并发回复 → 一个 Task 的多个并行 Assignment
顺序讨论 → Task 依赖或 Controller 等待前一份 Report
自动讨论 → Controller 根据当前 ChatContext 邀请角色
```

旧 Chat 保持兼容；新 Chat 只暴露消息、@提及、Task、Report、Attention 和 Artifact。迁移完成后再删除旧 UI 和旧调用入口。

## 迁移路线

### 阶段 0：文档和数据模型

明确 Room/Chat 边界、统一消息 envelope、结构化 Report、Controller actions、ChatContext revision 和 SQLite schema。

### 阶段 1：读模型与 UI 切片

在旧 checkpoint engine 之上投影 Thread、Task、Report、Attention 和 Artifact，先把项目室 UI 改成群聊和任务卡，不改变 Agent 执行链。

### 阶段 2：新 Room Engine

新 Chat 走 Task/Assignment/Report/Attention；旧项目继续走旧引擎。先实现统一消息管线、批量事件队列和确定性动作校验。

### 阶段 3：Controller Session

引入批量、可恢复、可降级的 Controller。主控不可用时，消息和已运行任务不能丢失；显式用户动作可以走受限确定性 fallback。

### 阶段 4：动态角色与自动组队

从建议模式开始，再开放受限自动模式。角色绑定已有 Provider 和能力，ChatContext 与角色 Prompt 都有版本；高成本或新权限请求用户。

### 阶段 5：旧模型退役

隐藏并最终移除 checkpoint、Gate、Seat、Round、主笔/评审循环和讨论模式选择器。保留底层 Trace、版本、租约、Outbox、安全和恢复能力。

## 第一个可验证切片

```text
用户在 Chat 中 @codex @pi 讨论需求
  → Controller 批量处理消息
  → 创建两个并行 Assignment
  → Agent 返回结构化 Report
  → Controller 创建文档 Task
  → 文档 Artifact 产生
  → Controller 创建评审 Task
  → 评审产生 Attention
  → 用户确认
  → Controller 创建实施 Task
```

全过程不向用户展示 checkpoint、Gate、Seat、Round、Playbook 或讨论模式选择器。

