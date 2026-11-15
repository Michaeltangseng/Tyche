# Meldwork 项目室 v2 设计

## 结论

项目室应从“固定检查点推进器”转为“可动态编程的多 Agent 群聊”。一个项目室属于一个 `Room`，每次团队协作记录是一个独立的 `Chat`。用户和 Agent 的消息统一进入 Chat Thread，由一个受平台约束的 Controller Session 理解上下文并提出路由动作；平台负责校验、持久化、执行和恢复；Worker Agent 在自己的原生生态中自治完成任务。

核心闭环是：

```text
Message
  → Controller
  → structured actions
  → Room Engine validation
  → Task / Assignment / Attention / Context update
  → native Agent session
  → Report / Artifact
  → Message
```

## 设计原则

1. **不定义固定 workflow。** “先讨论、再文档、再实施、再评审”可以是一次对话中的约定，但不能成为所有项目室的状态机。用户可以随时改变协作方式。
2. **Prompt 是协作编程层。** ChatContext、角色 Prompt 和 Skill 决定当前如何协作；它们可以版本化、被用户覆盖并在后续对话中更新。
3. **平台拥有事实和安全边界。** 权限、成员、写入范围、进程、凭据、持久化、幂等和恢复不能由 Prompt 覆盖。
4. **所有消息走同一条语义管线。** 用户派发、Agent 请求评审、Agent 请求另一个 Agent、用户新增角色，都是 Thread 消息；作者身份和上下文影响主控判断，但不需要多套业务协议。
5. **Agent 内部保持自治。** Meldwork 只管理顶层任务、报告、产物和需要人工处理的事项，不追踪 Worker 的 sub-agent、skill、shell 和内部步骤。
6. **动态组队生成角色，不生成无限权限主体。** 自动创建的角色只能绑定已有 Provider 和能力，Session 在 Assignment 执行时创建。
7. **SQLite 保存账本，Trace 和产物继续使用现有文件/Git 基础设施。** 数据库保存事实和引用，不吞并完整运行日志或文件内容。

## 三层架构

```text
协作语义层：Room / Chat / Thread / AgentRole / Task / Report / Attention / Artifact
调度治理层：Room Engine / Controller Session / ChatContext / 权限 / 租约 / Outbox / 恢复
执行层：Claude Code / Codex / Pi / 其他原生 Agent / sub-agent / skill / shell / trace
```

运行时细节见 [04-heartbeat-and-workspace.md](04-heartbeat-and-workspace.md)：所有 Controller 和 Worker Session 使用同一套心跳与事件管线；代码任务默认在 Room 主目录通过租约写入，隔离 Assignment workspace 用于探索和高风险任务，产物通过平台发布回 Room。

实施前置规范和分阶段计划见 [05-implementation-plan-and-open-questions.md](05-implementation-plan-and-open-questions.md)。

## 与当前实现的关系

保留 `invokeAgent`、原生 Session、Trace、工作目录、受管理进程、影子 Git、写入租约、Outbox、幂等和重启恢复。现有 checkpoint、Gate、Seat、轮次和主笔/评审循环降为旧项目兼容或内部投影，不再作为新项目室的用户模型。

新引擎应与旧 checkpoint engine 并存一段时间。先用读模型和纵向切片验证新交互，再逐步迁移新 Chat；不要继续在旧 checkpoint 状态机上叠加新的协作语义。

