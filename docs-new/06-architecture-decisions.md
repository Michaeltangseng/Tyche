# 架构决策记录（ADR）

这些 ADR 把进入实现前必须稳定的取舍记录下来。它们约束平台事实和安全边界，不把协作过程重新固定成 workflow。

## ADR-001：Workspace 模型

**决定：** 代码任务默认在 Room 主目录工作，使用目录/文件写入租约、进程管理和版本快照防止冲突。Assignment workspace 作为探索、高风险或显式 Artifact 契约任务的可选模式。

**原因：** 当前 CLI Agent 以完整工作目录为执行上下文；复制工作树可能缺少 `node_modules`、忽略文件、构建缓存和 Skill 所需路径，破坏 Agent 自治执行体验。把所有任务隔离会把复杂度转移到环境准备、合并和发布。

**后果：** 并行代码任务需要更严格的写入范围和租约；隔离模式仍需记录输入、输出和 workspaceRef。只有在平台能准备完整环境后，才考虑扩大隔离模式。

## ADR-002：权威状态位置

**决定：** SQLite、Trace 和 Run Ledger 放在应用私有区，按 Room/Chat 隔离。项目根目录只放用户明确产生的项目文件和 Artifact。项目自包含导出必须由用户显式触发。

**原因：** 防止污染 Git、意外同步聊天记录和角色 Prompt，保持现有 `userData/meldwork-private` 语义，并简化复制、删除和备份。

**后果：** 删除或迁移项目时需要同时处理应用私有记录；需要提供导出/备份入口，而不是依赖复制项目目录。

## ADR-003：Actor × Action 权限

**决定：** 分离 `ControllerAction`、`UserCommand` 和 `PlatformTransition`。

```text
ControllerAction：创建/派发/交接建议、请求 Attention、更新 Context、创建/归档角色、Note
UserCommand：暂停/继续 Chat、停止/重试/交接 Task、接受/拒绝 Artifact、撤销未执行动作、恢复 Context
PlatformTransition：根据 Report、进程事实、超时和用户命令实际改变状态
```

Controller 不得通过 `update_task` 直接设置 `done` 或 `cancelled`；该动作只能更新目标、依赖、优先级和输入等元数据。Controller 的 `assign/reassign` 只针对未启动 Assignment；运行中的交接必须来自已结束事实或用户 `handoff_task` 命令。

**原因：** 用户拥有最高业务授权，但用户命令和主控建议不应混成同一权限通道；状态事实必须由平台掌握。

## ADR-004：Report 是领域真源

**决定：** Report 是任务结果和状态事实的领域真源；Event 是传输与审计记录，只引用 `reportId`、`actionId` 或平台事实，不重复维护一套独立 Report 状态。

`session_liveness` 只表示 Supervisor 观察到的 liveness，不是 Report。Task 状态由 Report、Assignment 事实和用户命令按明确映射推导；Worker 自报心跳不能单独证明进程存活。

**原因：** 避免 `task_ready` 事件和 `Report(kind=ready)` 两份数据最终不一致。

## ADR-005：Session、invokeAgent 与旧数据映射

**决定（2026-11-15 修订）：** 复用 `invokeAgent` 的原生传输、凭据检查和 Trace 能力，但 v2 不依赖已保存 group，也不创建隐藏宿主群聊。`native-runtime.cjs` 根据 Room/Chat、工作目录和已安装 Provider 创建仅存活于本次调用的执行描述。每个 Assignment 对应一次原生调用，Session key 包含 `roomId/chatId/taskId/assignmentId/attempt`，角色由 Assignment 关联；Trace 使用 v2 runId 和独立 agentRunId，operationId 按本次调用生成。v2 Prompt 不读取旧 ContextPack、聊天记录或 project-room 上下文，也不把消息和 Session 写回旧 workspace JSON。

当前运行路径强制只读，每次使用原生新 Session，尚未把原生 sessionRef 持久化到 v2 账本用于续跑；写入授权、Room 写入租约、完整 Run Ledger 对应及原生 Session 恢复另行接通。以上边界不能由角色 Prompt 改写。

旧 V4 项目继续使用旧引擎；需要展示时通过只读投影映射为 Chat/Task/Report。旧消息和 workspace JSON 保留原始引用，迁移不删除原始记录。

## ADR-006：副作用必须进入 effects/outbox

**决定：** 所有启动 Session、投递消息、发布 Artifact、发送通知和停止进程等外部副作用，必须先以 durable effect 写入 SQLite，再由 Supervisor 执行。

```text
effects
  id, chatId, actionId, kind, status, payload,
  idempotencyKey, attempts, lastError,
  createdAt, startedAt, completedAt
```

**原因：** 应用崩溃后需要知道动作是否已落盘、是否已启动、是否可以安全重试，避免重复创建 Session 或重复发送消息。

## ADR-007：首版产品范围

**决定：** 首版不支持跨 Chat 的 Task 依赖，不把完整 Trace 写入 SQLite，不把所有任务强制放入隔离 workspace，不保留用户可见的并发/顺序/自动讨论模式选择器。

跨 Chat 协作先通过 Room Artifact、消息和 Controller 链接完成；后续只有在真实使用场景证明需要时，再扩展跨 Chat 依赖。

## ADR-008：消息与旧数据真源

**决定：** 新 Chat 的 Message 只写 SQLite。旧 V4 Chat 标记 `engineVersion=legacy`，继续由旧引擎读取原始消息；迁移工具可以把可识别消息导入 SQLite，并保留原始 message id、文件路径和只读备份引用。

**原因：** 双读 JSON 和 SQLite 会产生排序、编辑和删除不一致。兼容旧项目不等于让新 Chat 永久维护两套消息真源。

## ADR-009：代码 Artifact 的发布形式

**决定：** Room 主目录中的代码任务以 shadow Git commit、diff 或受控版本引用作为 Artifact；隔离 workspace 任务以 patch、commit 或显式文件清单发布。Artifact 的唯一状态字段为 `draft | published | accepted | rejected | superseded`，不再并存 `accepted` 布尔字段。

## ADR-010：心跳真源

**决定：** `session_liveness` 由 main process 的 Supervisor/watchdog 和进程观察产生。Worker 自报心跳只能进入上下文或 progress，不得单独证明 Session 存活。Report 是业务事实，Event 只引用 Report 或平台事实。

