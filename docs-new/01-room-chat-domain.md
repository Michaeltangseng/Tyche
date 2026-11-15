# Room 与 Chat 领域模型

## Room 与 Chat 的边界

`Room` 表示项目和工作空间，负责共享的工程事实：

- 一个工作目录；
- 项目成员候选和可用 Provider；
- 产物账本、版本和已接受版本；
- 全局权限、写入范围和执行资源；
- 跨 Chat 的“需要你处理”查询。

`Chat` 表示一次独立的团队工作记录，负责协作上下文：

- 用户和 Agent 的 Thread 消息；
- 本 Chat 的动态角色；
- 角色 Prompt revision；
- 当前协作约定；
- Task、Assignment、Report 和 Attention；
- 指向 Room 产物的引用。

不同 Chat 的团队配置互不污染。产物仍归 Room，可以被多个 Chat 引用；任务、角色、报告和协作约定默认只属于创建它们的 Chat。

## 最小对象

```text
Room
  id, name, workspace, providers, allowedCapabilities, primaryChatId, sharedMembers, artifactLedger

Chat
  id, roomId, title, status, isPrimary, engineVersion, controllerSessionId, contextRevision, createdAt, updatedAt

Message
  id, chatId, sequence, author, content, mentions, attachmentIds, replyTo, taskId?, createdAt, editedAt?, deletedAt?

AgentRole
  id, chatId, displayName, responsibilities, capabilities, provider, promptRevision, createdBy, creationReason, status

Task
  id, chatId, objective, kind, status, createdBy, sourceMessageIds, parentTaskId, blockedByTaskIds, requiredArtifactIds, optional, waitingFor, contextRevision, inputs, assignments, artifactIds, latestReportId

Assignment
  id, taskId, roleId, nativeSessionId, runId, workspaceRef, writeScopes, required, attempt, previousAssignmentId?, status, endedReason, outcome

Report
  id, taskId, assignmentId, kind, summary, evidence, artifactIds, nextRequest, attentionId, createdAt

Attention
  id, chatId, taskId?, type, question, options, status, resolution, requestedBy, answeredBy

Artifact
  id, roomId, sourceTaskId, sourceAssignmentId, path, kind, version, status, supersedesArtifactId

ChatContextRevision
  id, chatId, revision, source, instructions, active, createdAt

ControllerDecision
  id, chatId, batchId, contextRevision, actionIds, results, model, latencyMs, cost, createdAt

Event
  id, roomId, chatId, sequence, actorId, type, reportId?, actionId?, payload, createdAt
```

状态保持少量且可检查：

```text
Task:       open → active → waiting → done / cancelled
Assignment: queued → running → ended
Attention:  pending → answered / dismissed
Report:     progress | ready | waiting | blocked | failed | handoff
```

`Attention.type` 只取 `decision | clarification | approval | blocked | failure`。`options` 是结构化选项数组，每项至少包含 `optionId`、`label` 和可选的 `effect`；澄清类 Attention 可以没有选项。用户回答通过独立的 `UserCommand(type=answer_attention)` 写入，平台校验 `attentionId`、`optionId` 或自由文本答案，并产生 `resolution` 与审计事件。Attention 本身不直接改变 Task，后续状态由平台根据回答产生的 PlatformTransition 推导。

Task 不跟随某个 Agent Session 的状态。执行器失败、重试或交接只改变 Assignment；Task 保留其目标、历史报告和产物。

## 统一消息管线

用户消息和 Agent 消息使用相同的 envelope：

```json
{
  "chatId": "chat-001",
  "messageId": "msg-123",
  "author": { "type": "user", "id": "user-1" },
  "content": "@agent2 请评审 docs/architecture.md",
  "mentions": ["agent2"],
  "replyTo": "msg-120",
  "taskId": "task-7",
  "createdAt": "..."
}
```

`Agent-1 @Agent-2` 是 Agent-1 反馈给主控的协作建议；`用户 @Agent-2` 也是一条进入主控的消息。两者不需要不同的业务 API。作者类型、用户授权优先级和平台权限由 Controller Prompt 与 Room Engine 共同处理。

消息不直接改变 Task 状态。状态变化必须来自结构化 Controller action、平台动作或结构化 Report；普通文本只能作为上下文。

## 动态角色

动态角色是 Chat 级定义，不是新的权限主体：

```text
proposed → active → idle → archived
```

角色可以复用或归档。执行时才为 Assignment 创建原生 Session。角色只能从 Room 已安装的 Provider、能力和安全范围中选择；“管理员”“系统 Agent”等名称不能自动产生额外权限。

一个 Chat 可以在运行中新增角色：

```text
用户：新增一个生图 Agent3，让 Agent2 在需要素材时调用它。
主控：创建 Chat 级视觉角色，绑定已有生图能力，更新当前协作上下文。
Agent2：@Agent3 请生成三种英雄区插图。
主控：根据上下文创建素材 Task 和 Agent3 Assignment。
```

## Attention

Attention 只表示真正需要用户行动的事实：决策、澄清、审批、阻塞或失败处理。进度和普通建议留在消息、Task 和 Report 中，避免把用户变成每轮调度器。

## Task 完成条件

一个 Task 可以有多个 Assignment。每个 Assignment 明确记录 `required`。重试/交接通过 `previousAssignmentId` 形成替代链，完成条件只计算每条链上未被后继替代的最新 Assignment；旧 Assignment 保留原 required、状态与历史报告，不再阻塞新尝试完成。默认情况下，所有当前 required Assignment 都产生 `ready` Report 后，Task 才能进入 `done`；任一当前 required Assignment 进入 `blocked` 或 `failed` 时，Task 进入 `waiting` 并可创建 Attention。optional Assignment 不阻塞 Task 完成。旧尝试的迟到 Report 可以保留，但不得覆盖其已保留的执行状态或改变新尝试的完成条件。

第一版不支持跨 Chat 的 Task 依赖。跨 Chat 协作通过 Room Artifact 和消息/Controller 链接完成，避免把多个 Chat 的依赖图合并成新的全局流程状态机。

## 共享 Room 主目录的可见性

代码任务默认共享 Room 主目录。此模式下，Agent 可能看到其他 Assignment 尚未提交的文件变化；平台不能提供按 Assignment 的读取隔离。Prompt 可以要求 Agent 只读取任务输入和已发布 Artifact，但这只是协作约定。需要真实读写隔离时，必须使用 Assignment workspace。完整 Trace 默认仍按角色和 Task 限制读取。

