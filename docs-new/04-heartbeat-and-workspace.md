# 心跳、Agent 通讯与工作空间

## 目标

项目室需要同时处理两类事实：

1. Agent 是否仍然连接、正在运行、暂停或退出；
2. Agent 是否产生了进度、完成、阻塞、交接或需要用户的业务报告。

这两类事实不能混为一谈。心跳只能说明 Session 还活着，不能从“长时间没有消息”推断任务完成或失败；任务状态必须来自结构化 Report、平台观察到的进程事实或用户动作。

## 统一心跳机制

Controller Session 和 Worker Session 使用同一个平台心跳机制。心跳由 Electron main process 管理，Renderer 只通过窄的 preload API 读取投影。

```text
Native Agent Session
        │ liveness / report / session event
        ▼
Session Supervisor（main）
        │ durable event
        ▼
Chat event queue
        │ batch / debounce
        ▼
Controller Session
        │ structured actions
        ▼
Room Engine
```

Supervisor liveness envelope 至少包含：

```json
{
  "chatId": "chat-001",
  "taskId": "task-7",
  "assignmentId": "assignment-9",
  "sessionId": "session-22",
  "source": "supervisor",
  "kind": "session_liveness",
  "observedBy": "watchdog",
  "sessionState": "running",
  "observedAt": "...",
  "sequence": 42
}
```

`kind: session_liveness` 只更新 Session 的 liveness 和最后观察时间。Worker 自报的心跳不能证明进程仍然存活；进程状态、Supervisor watchdog 和退出观察才是 liveness 真源。业务报告使用 Report，不使用重复的 task 状态事件：

```text
session_started
session_paused
session_exited
session_liveness
report_received
attention_requested
artifact_published
```

`report_received` 的 payload 只引用 `reportId` 和 `report.kind`；不持久化 `task_ready`、`task_failed` 等与 Report 重复的事件类型。UI 中的任务标签由 Report、Assignment 事实和 PlatformTransition 派生。

例如 Backend Agent 执行一小时后完成：

```text
Backend Agent
  → task_report(kind=ready, summary="接口实现完成", artifacts=[...])
  → durable event queue
  → Thread 中出现一条简短报告
  → Controller 在下一批事件中读取
  → Controller 创建评审或后续任务
```

Agent 可以在报告正文中写“@主控 Agent”，但平台应同时保存结构化 `task_report`。只有文本提及而没有结构化报告时，主控可以把它当作上下文或建议，不能直接把 Task 标记为完成。

## 心跳不等于轮询模型

心跳由 Supervisor 定时接收和记录，不应该每次都同步调用 Controller 模型。事件按 Chat 聚合，在以下情况下触发一次批量评估：

- 新的用户消息到达；
- 结构化 Report 到达；
- 多条 Agent 消息在短窗口内聚合完成；
- Attention 或 Session 异常需要处理；
- 之前的 Controller action 执行完成。

单纯的 `session_liveness` 默认只更新运行状态，不触发主控模型。长时间运行的 Agent 可以每隔一段时间发送 progress Report；Controller 是否采取行动由 ChatContext 决定。

## 通讯方向和权限

Agent 之间不建立绕过平台的直接控制通道。消息仍然进入 Chat Thread：

```text
Agent-1 → Thread message / structured request
        → Controller batch
        → Room Engine validation
        → Assignment to Agent-2
```

这样 Agent-1 可以表达“建议 Agent-2 评审”，但不能凭一句话直接启动 Agent-2。用户消息、Agent 消息和系统事件使用统一入口；作者类型影响主控的优先级，平台权限决定动作是否可执行。

## 异常和恢复

Supervisor 需要区分：

```text
healthy       最近收到心跳，Session 仍在运行
stale         超过心跳窗口未收到心跳，暂时无法确认
exited        进程已退出
failed        已确认启动或执行失败
paused        用户或系统暂停派发
```

`stale` 不直接等于 `failed`。平台可以先等待、检查进程或重连；只有确定失败或收到结构化失败报告，才创建 blocked/failed 事实。应用重启后，Supervisor 根据持久化 Assignment 和进程观察结果写入 recovery event，Controller 再决定继续、重试或交接。

## Room、Chat 和 Agent 工作空间

建议把三种概念分开：

```text
Room root                 项目主目录和共享工程事实
Chat record               一次团队工作记录，主要保存在 SQLite
Assignment workspace      某次 Agent 执行的隔离写入空间
```

一个 Room 可以有多个 Chat，但默认只有一个项目主目录。例如：

```text
<room-root>/
  docs/
  src/
  assets/

应用私有区/
  rooms/<room-id>/
    db.sqlite
    traces/
    chats/<chat-id>/context/
    assignments/<chat-id>/<assignment-id>/
```

`chats/<chat-id>/context/` 保存需要落盘的 ChatContext 快照或导出文件；权威记录仍在应用私有区 SQLite。项目目录不默认放私有数据库、Trace 或聊天记录。`assignments/<...>/` 是 Agent 的临时工作空间，可以是独立目录、影子 Git worktree 或平台支持的其他隔离形式。

### 默认工作目录决策

代码任务默认继续在 Room 主目录工作，以保留完整依赖、忽略文件、构建缓存和 Agent 对项目的真实上下文。平台通过目录/文件写入租约、受管理进程和版本快照防止冲突。

隔离 Assignment workspace 只用于：

- 并行探索或实验性改动；
- 高风险、需要先验证的改动；
- 明确声明输入/输出 Artifact 契约的任务；
- Room 主目录不能安全共享的任务。

除非平台已经能够完整准备依赖、忽略文件、构建缓存和 Skill 所需的项目根路径，否则不把隔离 workspace 作为所有任务的默认模式。

## 工作空间访问规则

### 默认读取

Agent 可以读取：

- Room 中已经发布或允许访问的 Artifact；
- 当前 Chat 的相关消息、Task 和 Report；
- 自己 Assignment 的输入和工作目录；
- Prompt 明确授权的共享文档。

在共享 Room 主目录模式下，Agent 可能实际看到其他 Assignment 的未发布文件变化；平台不提供按 Assignment 的读隔离。Prompt 约定可以要求只使用任务输入和已发布 Artifact，但这不是安全边界；需要强隔离时必须使用 Assignment workspace。共享目录下的并行读取污染属于已知风险。

### 默认写入

代码任务默认以 Room 主目录为工作目录；实际写入必须先由用户通过 `set_workspace_write` 授权。当前实现按真实 Room 根目录申请独占租约，重叠目录的写任务串行执行；Controller 始终只读。Assignment 的 `writeScopes` 表达写入意图，不构成按文件的 CLI 沙箱限制，非空范围仍需整个 Room 的用户授权。无范围的任务保持只读。探索性、高风险或显式 Artifact 契约任务才使用可选 Assignment workspace。

授权绑定目录的 realpath，领取租约后、启动原生调用前再次校验；目录指向或授权变化会拒绝执行。运行中或恢复状态 unknown 的 Assignment 存在时，拒绝修改同一 Room 的授权；应先停止并确认进程退出。授权 UI、自动 Artifact 快照仍待接通。只读任务不申请写租约，也不获得一致性快照，因此可能看到写任务的中间变化。

需要共享代码时，Agent 通过平台发布 Artifact 或请求受控应用：

```text
Assignment workspace
  → validate / test
  → publish Artifact
  → Room artifact ledger
  → 下一个 Assignment 读取指定版本
```

### 需要修改 Room 主目录时

如果任务本身就是修改项目代码，可以创建带写入租约的 Assignment：

- 由平台记录明确的写入意图，首版以整个真实 Room 根目录作为授权和互斥单位；
- 重叠根目录不能被冲突的写入 Assignment 同时占用；
- 写入前后保留版本或 diff；
- 结果仍须通过 Artifact/Report 回到 Thread；
- 评审 Agent 读取发布版本，而不是未提交的任意中间状态。

这保留了本地项目的直接开发体验，同时避免多个 Agent 互相覆盖文件。

## 产物交接

Agent 之间共享的是产物引用和结构化报告，不是隐式共享全部目录：

```text
Agent-3 生成图片
  → Artifact: assets/hero-v2.png
  → Report: ready
  → Controller 将 Artifact 作为 Agent-2 Task input
  → Agent-2 在自己的 workspace 使用该版本
```

如果后续 Agent 需要修改同一个产物，平台创建新的版本或新的 Assignment，不直接覆盖前一个 Agent 的工作空间。

## 生命周期清理

- Room root 和已接受 Artifact 长期保留；
- Chat 记录按产品保留策略归档；
- 已结束 Assignment workspace 可以压缩或清理，但必须保留 Artifact、Report、Trace 引用；
- 正在运行或等待 Attention 的 Assignment 不得自动清理；
- 清理动作写入事件审计，不能影响 SQLite 中的任务历史。

