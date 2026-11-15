# 实施前置规范与计划

这份文档把架构中尚未收敛的部分转成实施前需要确定的协议、边界和验收指标。它不重新引入固定 workflow；它规定的是平台如何记录事实、校验动作和恢复运行。

P0 决策记录见 [06-architecture-decisions.md](06-architecture-decisions.md)。在进入协议冻结和代码实现前，应先完成其中的 ADR-001 至 ADR-010。

## 一、实施前必须冻结的核心协议

### 1. Message Envelope

```json
{
  "messageId": "msg-123",
  "chatId": "chat-001",
  "sequence": 42,
  "author": { "type": "user", "id": "user-1" },
  "content": "@agent2 请评审架构文档",
  "mentions": ["role-agent2"],
  "attachmentIds": [],
  "replyTo": "msg-120",
  "taskId": "task-7",
  "createdAt": "...",
  "editedAt": null,
  "deletedAt": null
}
```

规则：

- 消息先写入 Thread，再进入 Controller 事件队列；
- `mentions` 是解析结果，不等于授权；
- `taskId` 只表示上下文关联，不能凭空改变 Task 状态；
- 消息不可通过编辑绕过历史审计，编辑应产生新事件；
- 用户、Agent、系统消息统一使用此 envelope。

### 2. Controller Action

Controller 只能产生有限的结构化动作：

```json
{
  "actionId": "action-55",
  "type": "create_task",
  "chatId": "chat-001",
  "objective": "评审架构文档",
  "assignees": ["role-pi"],
  "inputs": ["artifact-12"],
  "blockedByTaskIds": [],
  "requiredArtifactIds": ["artifact-12"],
  "optional": false,
  "parentTaskId": null,
  "sourceMessageIds": ["msg-123"],
  "contextRevision": 4,
  "idempotencyKey": "chat-001:review:artifact-12:v1"
}
```

初始动作集合：

```text
create_task
assign
reassign
update_task
request_attention
update_context
create_role
archive_role
propose_stop
propose_retry
note
```

Room Engine 对每个动作逐项校验：成员、权限、能力、Task 去重、写入范围、资源上限、Attention 字段、Context revision 和幂等键。批量动作允许部分成功，但每项必须有独立结果，不能因为一项失败而丢失其他合法动作。

### 3. Report

Worker 的自然语言正文和机器可读报告分离：

```json
{
  "reportId": "report-88",
  "taskId": "task-7",
  "assignmentId": "assignment-9",
  "kind": "ready",
  "summary": "接口实现完成，测试已通过",
  "evidence": ["test-run-12"],
  "artifactIds": ["artifact-23"],
  "nextRequest": {
    "kind": "review",
    "roles": ["role-pi"]
  },
  "createdAt": "..."
}
```

`kind` 至少包括 `progress`、`ready`、`waiting`、`blocked`、`failed`、`handoff`。缺失或解析失败时，平台不猜测完成状态，Task 保持原状态并把消息交给 Controller 或用户处理。

### 4. UserCommand

用户命令必须由平台确认的用户身份产生，不能由 Controller 或 Worker 文本伪造：

```json
{
  "commandId": "cmd-9",
  "type": "answer_attention",
  "chatId": "chat-001",
  "attentionId": "attention-3",
  "answer": { "optionId": "方案B" },
  "idempotencyKey": "attention-3:answer:v1",
  "createdAt": "..."
}
```

初始命令集合：

```text
pause_chat
resume_chat
stop_task
retry_task
handoff_task
accept_artifact
reject_artifact
answer_attention
revoke_pending_action
restore_context_revision
archive_chat
```

当前已实现的 `retry_task` / `handoff_task` 必须携带 `chatId`、`taskId`、`assignmentId` 和 `commandId`；handoff 另需 `roleId`，`reason` 可选。命令只接受同一 Chat 内已处于 failed/waiting/blocked、且已结束原生执行的 Assignment；有 runId 时必须存在匹配的 Supervisor `session_exited` 事实。恢复后 outcome=unknown 的执行仍需先完成残留进程对账，不能仅凭重试命令重跑。当前不支持停止运行中任务后直接交接。

已接入受管理进程对账：主进程启动恢复后、用户重试/交接前，会检查相同 runId 的进程注册记录。只有记录非空，且每条记录的 Provider、工作目录均匹配并已 ended，才记录 Supervisor `session_exited`、将未知 Assignment 转为 interrupted，并将关联 unknown effect 收口为 failed。对账不自动派发，已有最终 Report 不被覆盖。用户命令中的对账、新尝试和 effect 同一事务提交，失败一起回滚。

这条路径仅覆盖实际使用受管理进程且保存了 runId 的调用。只读、远端或其他未登记路径，以及旧记录缺少 runId、ended 记录超过现有 24 小时保留窗口被清理等情况，继续保持 unknown，不靠超时、日志或用户点击“已知悉”推断进程结束。运行中停止、残留进程重新探测与无记录调用的恢复仍待实施。

成功命令新建 attempt+1 的 queued Assignment，保留 previousAssignmentId、required 和写入范围；Room Service 将新 Assignment、命令事件和幂等派发 effect 一起提交。相同用户/Chat/commandId 的相同载荷重放返回原结果，不重复派发；改变载荷复用 commandId 或对同一旧 Assignment 再建分支都会拒绝。这里的 commandId 是已实现的重试/交接命令幂等契约，不代表上方所有规划命令已支持统一幂等 envelope。

### 5. PlatformTransition

PlatformTransition 是平台根据 Report、Supervisor liveness、进程事实、超时和 UserCommand 产生的内部事实，不是 Controller 可直接调用的工具。例如 `assignment_started`、`assignment_exited`、`task_done`、`task_waiting` 和 `task_cancelled`。它们必须带 source、sourceId 和时间，不能由自由文本合成。

## 二、Task 依赖与状态边界

不设置九个固定阶段，但仍需要表达轻量依赖：

```text
Task B blocks on Task A
Task B waits for Artifact C
Task D is optional
```

依赖只回答“是否可以派发”，不定义整个项目的阶段图。建议第一版只支持：

- `blockedByTaskIds`；
- `requiredArtifactIds`；
- `optional`；
- `parentTaskId`。

Task 状态只由结构化 Report、平台事实或用户动作改变：

```text
open → active → waiting → done / cancelled
```

Assignment 的失败、重试和交接不重写 Task 目标；它们产生新的 Assignment 和事件。

## 三、用户控制面

用户必须能在不理解内部状态机的情况下控制项目室：

```text
暂停 Chat
继续 Chat
停止 Task
重试 Assignment
交接给另一个 Agent
修改角色 Prompt
归档动态角色
接受 / 拒绝 Artifact
撤销最近一次派发
恢复旧的 ChatContext revision
```

操作应写入 Thread 和事件审计。撤销只影响尚未开始的外部副作用；已经写入的文件、已发送的消息和已启动的进程需要通过新的补偿动作处理。

## 四、Controller 不可用和重复执行

需要定义以下运行参数：

- 事件批处理窗口；
- Controller 调用超时；
- 连续失败后的退避时间；
- 事件最大重试次数；
- stale Session 的观察窗口；
- action 幂等保留时间。

降级规则：

1. 消息和心跳始终先落盘；
2. 已运行 Assignment 继续运行，除非平台明确停止；
3. 明确的用户操作可以走受限确定性 fallback；
4. Controller 恢复后重新评估未处理事件；
5. 每个 action 使用幂等键，重复恢复不能创建重复 Task 或 Assignment。

当前重启补调度已使用 SQLite 决策账本作为消费凭据：启动运行时、用户恢复 Chat 时，将活跃 v2 Chat 的未消费消息和指定业务事件重新入队。已提交决策的输入与已成功 fallback 的消息排除；心跳、退出与普通审计不触发历史回放。批次执行前再过滤一次，避免运行期间重复扫描造成重复动作。模型调用本身不保证跨崩溃只执行一次；只有决策/actions/effects 已原子提交才算消费完成。自动队列每批 32 条、单 Chat 共 64 条、全局共 256 条输入，运行/退避均占容量；SQL 分页按空余容量补入，溢出输入留在账本。明确的暂时错误进行 1/2/4 秒、最多 3 次额外重试；新输入不绕过退避，协议/权限/未知错误不自动重试。终止失败后停止该 Chat 自动补入，显式 resume_chat 或重新启动运行时可恢复。仍待补齐字节/Token 上限、失败状态的持久化与用户控制面、编辑消息重新评估和归档后的消费凭据策略。详细实现边界见 [实施路线图](07-implementation-roadmap.md)。

## 五、动态角色和成本边界

ChatContext 可以管理“应该如何组队”，平台需要限制“最多能组到什么程度”：

- 最大活跃角色数；
- 最大活跃 Assignment 和 Session 数；
- Provider 白名单；
- 单 Chat、单 Task 和单 Assignment 成本上限；
- 新 Provider、高成本模型、外部能力和长期保存角色需要用户确认；
- 相同职责的动态角色优先复用；
- Agent 提议新增角色不等于角色已经创建。

动态角色创建记录：角色职责、生成原因、绑定 Provider、能力范围、创建消息、Prompt revision 和生命周期状态。

## 六、Room 与 Chat 的可见性规则

默认规则：

- Task、Assignment、Report、Attention 属于 Chat；
- Artifact 属于 Room，但可以有 Chat 级可见性；
- 在隔离 Assignment workspace 中，未发布的中间文件不跨 Assignment 可见；共享 Room 主目录模式下，平台无法提供读隔离，未发布变化可能被其他 Agent 看到；
- 已接受 Artifact 可以被同一 Room 的其他 Chat 引用；
- Chat 归档不删除 Room Artifact；
- Agent 默认只能读取自己 Task 的 Trace，其他 Trace 需要显式授权。

这些规则必须在读取接口中强制执行，不依赖 Worker Prompt 自律。

## 七、安全、恢复和桌面边界

实施时必须继续遵守：

- Agent 执行只在 Electron main process；
- Renderer 只能使用窄的 preload API；
- 当前 v2 只开放 bootstrap/snapshot/用户消息/UserCommand/stale 查询；author、createdBy 与 UserCommand actor 由 main 固定为本地用户。Renderer 传入身份或内部执行字段会拒绝，不能直接导入 Report、写心跳、提交主控动作、派发 effect 或启动 Assignment；上述内部通道已删除。replyTo/taskId 也须通过同 Chat 归属校验。
- Prompt 和消息不能修改 secrets、执行路径、工作目录和进程权限；
- 动态角色不能创建新的凭据或 Provider；
- 目录租约、受管理进程、脱敏、Outbox 和恢复逻辑保留；
- SQLite 事务提交后再执行外部副作用；
- Trace 使用现有 JSONL 路径，数据库只保存引用。

## 八、分阶段实施计划

### Phase 0：文档与只读模型

目标是验证概念，不改变 Agent 执行链：

- 定义 Message、Action、Report schema；
- 完成 workspace、权威状态位置、Actor × Action、Report 真源和 Session 映射 ADR；
- 定义 Room/Chat 边界；
- 从旧 checkpoint 状态投影 Task、Report、Attention；
- UI 显示群聊、Task 卡和“需要你”；
- 隐藏 checkpoint、Gate、Seat、Round 等内部词汇。

验收：用户可以从群聊看到“谁在做什么、产物是什么、哪里需要我”，但旧执行链仍能继续工作；两个 Agent 在 5 分钟内各返回一条结构化 Report；全程不出现 checkpoint/gate/seat/round。

### Phase 1：统一事件和结构化报告

- 建立 Chat 事件队列；
- 接入统一心跳；
- 兼容旧 `ready/question/continue` 回执并映射为 Report；
- 引入 idempotency、批处理和重启恢复；
- 不要求 Controller 模型先可用。

验收：长时间运行的 Agent 完成后，完成报告可以可靠回到 Thread；应用重启不会丢失消息或重复创建任务；Controller 不可用时，用户显式 @mention 仍可通过受限 fallback 创建任务。

### Phase 2：SQLite Room Engine

- 建立 schema version 和 migration；
- 迁移或投影现有 `state.json`；
- 让 Room Engine 成为 Task、Assignment、Report、Attention 的唯一写入者；
- Trace、Shadow Git 和工作目录继续使用现有基础设施。

验收：Room/Chat/Task/Report/Artifact 可以查询、恢复和审计；effects/outbox 可以在崩溃后恢复；旧项目仍可打开。

### Phase 3：Controller Session

- 引入批量 Controller；
- 实现 action 校验和 action 结果卡；
- 支持主控不可用时的确定性 fallback；
- 记录 context revision 和 controller decision；
- 支持用户修改当前 ChatContext。

验收：用户和 Agent 的 @消息都进入同一管线；主控可以创建、交接、评审和请求 Attention，但不能越过平台边界。

### Phase 4：动态角色与自动组队

- 先做建议模式；
- 再做受限自动模式；
- 支持 Chat 级角色 Prompt revision；
- 支持角色复用、归档、保存为模板；
- 加入成本、并发和 Provider 限制。

验收：用户提出一个新需求后，可以生成临时角色并完成一次多 Agent 协作；角色不会污染其他 Chat。

### Phase 5：可选工作空间隔离和旧模式退役

- 实现可选的 Assignment 隔离工作空间或受控 worktree 模式；
- 通过 Artifact 发布和版本引用交接；
- 新 Chat 移除并发/顺序/自动讨论模式选择器；
- 旧 Chat 保持兼容；
- 最后删除旧 UI 和旧入口。

验收：代码任务使用 Room 主目录租约时，冲突写入被平台拒绝或串行化；需要强隔离的任务使用可选 Assignment workspace；用户只使用消息、Task、Report、Attention 和 Artifact 完成协作。

## 九、验证指标

每个阶段都应记录：

- 从用户需求到第一份有效产物的时间；
- Controller 误派、重复派发和无效角色创建率；
- Report 丢失、重复和恢复成功率；
- Attention 数量以及用户需要处理的时间；
- Assignment 交接成功率；
- 文件冲突和租约失败次数；
- 单个 Chat、Task、Assignment 的模型调用和资源成本；
- 用户主动纠正、停止或撤销主控决定的次数。

如果主控路由错误率高、Attention 数量过多或自动组队成本不可控，应先收紧 Controller Prompt 和默认模式，不要重新引入固定 checkpoint workflow。

