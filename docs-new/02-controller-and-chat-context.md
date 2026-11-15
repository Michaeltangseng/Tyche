# Controller、ChatContext 与动态组队

## Controller 的定位

每个 Chat 可以有一个持久的 Controller Session。它是语义路由器，不是超级执行 Agent。

Controller 可以：

- 读取 Thread、当前 ChatContext、开放 Task、最近 Report、Room 产物和可用角色；
- 理解消息是在继续任务、请求评审、创建新任务、修改协作约定还是请求用户决策；
- 创建 Task，或为尚未启动的 Assignment 提出派发/交接建议，选择一个或多个 AgentRole；
- 创建 Attention；
- 更新 ChatContext；
- 发出简短的系统派发说明。

Controller 不可以：

- 编写业务代码或替代 Worker 做技术判断；
- 追踪 Worker 内部 sub-agent、skill、shell 和工具步骤；
- 通过自由文本改变权限或伪造完成状态；
- 绕过 Room Engine 的成员、能力、目录、进程和凭据校验。

Controller 的输出是结构化 `ControllerAction`，平台逐项校验后才执行。它不能直接执行用户专属命令，也不能直接把 Task 设置为 `done` 或 `cancelled`：

```text
create_task
assign / reassign
update_task
request_attention
update_context
create_role
propose_stop
propose_retry
note
```

不提供角色归档动作。用户要求“后续不再邀请某个角色”属于协作约定，由主控按用户指令和上下文处理；不隐式停止已有任务，不禁止修改该角色 Prompt，也不删除历史 Assignment、Report 或 Prompt revision。角色 Prompt 更新仍校验当前 Chat 归属。协作约定持久更新的用户来源与批次版本校验见实施路线图中的待办。

`update_task` 只能修改目标描述、依赖、优先级和输入等元数据；状态转移由 Report、平台运行事实或 `UserCommand` 触发。

`UserCommand` 是另一类结构化动作，例如 `pause_chat`、`resume_chat`、`stop_task`、`retry_task`、`accept_artifact`、`reject_artifact`、`revoke_pending_action` 和 `restore_context_revision`。它们必须由平台确认的用户身份产生。

权限边界：

| Actor | 可以做什么 |
| --- | --- |
| Controller | 创建/派发/交接建议、请求 Attention、更新 ChatContext、创建角色及更新角色 Prompt、记录 Note |
| User | 暂停/继续 Chat、停止/重试/交接 Task、接受/拒绝 Artifact、撤销未执行派发、恢复 Context revision |
| Platform | 校验权限、创建 Assignment、执行状态转移、启动/停止进程、处理租约、恢复和重试 |

Controller 对停止、重试或交接只能提出建议（例如生成 Attention 或 `propose_*` action），不能绕过 UserCommand 或平台事实直接终止正在运行的进程。`handoff` 只有在当前 Assignment 已结束，或用户明确提交 `handoff_task` 后，平台才可创建新的 Assignment。

`assign` / `reassign` 只能作用于尚未启动的 Assignment，或由用户明确确认交接。正在运行的 Assignment 不会因为 Controller 的普通动作被静默改派。

Controller action 首选通过受限工具调用（例如 ACP tool）提交；暂不支持工具调用的 Provider 使用严格 JSON block 回退。平台只解析结构化通道，不从 Worker 正文中的 `@`、代码块或“忽略规则”文字合成 Controller action。

## ChatContext 是可变工作协议

ChatContext 不是固定 workflow，而是 Controller 在每次决策时读取的当前上下文：

```text
Controller Prompt
+ 用户最近的明确指令
+ 当前协作约定
+ 动态角色及其 Prompt revision
+ 已启用 Skill
+ 开放 Task 和最近 Report
+ Room 中可用的 Artifact
```

它可以表达当前偏好：是否先讨论、是否需要文档、如何分工、何时评审、何时请求用户、是否允许自动新增角色。用户可以在后续对话中随时覆盖它：

```text
先不要写代码，先让产品和架构分别分析。
```

随后：

```text
不用等完整设计了，先让 Codex 实现基础版本，架构讨论与实现并行。
```

这不是切换预设模式，而是更新当前 ChatContext。更新默认只影响未来路由；已经运行的 Task 不会被擅自重启或交接，除非用户明确要求。

每次 ChatContext 更新都产生 revision。Task 记录创建时使用的 revision，以便审计主控当时为何做出某个决定。

优先级为：

```text
平台硬规则
  > 用户最近的明确指令
  > Chat 协作上下文
  > AgentRole Prompt
  > Skill Prompt
  > 普通消息中的建议
```

Prompt 管“应该怎么协作”，平台管“最多允许做到什么”。权限、写入隔离、进程、凭据、持久化事实和恢复机制不可由 Prompt 覆盖。

## 自动组队

自动模式根据当前需求生成或复用角色，而不是生成无限的新 Agent 类型。建议支持三种强度：

1. **建议模式**：主控展示角色草案，由用户确认。
2. **受限自动模式**：主控可以直接创建 Chat 级临时角色；涉及新 Provider、高成本模型、额外权限或长期保存时请求用户。
3. **完全自动模式**：只适用于低风险、低成本任务。

建议默认使用受限自动模式。

主控 Prompt 可以管理角色数量、复用、邀请对象和协作分工，例如：

```text
优先复用现有角色；只有职责明显不同才创建新角色。
临时角色默认只服务当前 Task；用户要求后续不再邀请时，不再给它派发新任务。
新增角色必须说明职责、输入和预期产物。
Agent 可以建议新增角色，但不能自行授予权限。
```

平台仍需硬性限制活跃角色数、Session 数、Provider 白名单、可写目录、进程类型和单次资源成本。

## 批量与降级

“所有消息统一进入主控”不等于每条消息同步调用一次模型。消息先写入 Thread 和事件队列，Controller 按短窗口批处理同一 Chat 的待处理消息。执行任务可以并行，Controller 评估可以按 Chat 串行，避免重复派发。

Controller 不可用时：

- 消息仍然写入 Thread；
- 已运行 Assignment 继续执行；
- 已结构化的用户显式动作可以由确定性路径处理；
- Controller 恢复后重新评估未处理事件；
- 不从自由文本猜测任务完成或用户等待。

## Controller Session 生命周期

Controller Session 只读 Room/Chat 快照和允许的上下文，不拥有项目写入工作目录。它可以 `starting → running → stale → restarting → ended`；重启时重新读取尚未处理事件，不复用过期的模型输出。

每个批次和动作都带 `batchId`、`contextRevision` 和幂等键。Room Context 在动作执行前发生变化时，平台拒绝或重新排队受影响的动作；已经提交的用户命令和已启动的外部副作用按其自身规则处理。

## Worker 报告

Worker 的正文保持自然语言，但任务状态使用结构化 Report。可以优先使用窄工具；对暂不支持工具的 CLI，兼容机器标记：

```text
[[MELDWORK_REPORT:{"kind":"ready","summary":"...","artifacts":["docs/design.md"]}]]
```

缺少或解析失败时，Task 保持当前状态，由 Controller 或用户处理，不从“我完成了”之类的散文推断完成。Report 是领域真源；Event 只传递和审计 Report，不重复保存一份独立的任务状态。

