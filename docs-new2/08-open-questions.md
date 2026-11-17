# 08 待决问题

本文件记录尚未冻结、但会影响实现的选择。每项给出推荐；批准后写入 `07-decisions.md` 或实施计划。

## 已决定（2026-11-17）

以下 6 项已由用户确认；实施计划以此为准。选项保留用于记录取舍。

### Q1. Worker 运行时范围：只接外部 CLI，还是同时做内置 runtime？

**已决定：第一阶段只接外部 CLI。**

- **选项 A（推荐）**：第一阶段只接外部 CLI（Claude Code、Codex 等），平台不拥有 session 正文和压缩。
- **选项 B**：同时做一个平台自管 runtime，使用 eta 的 journal/compaction。
- **影响**：B 会显著增加实现量，并引入“平台自己的模型调用、工具、journal、压缩”一整套责任；A 更符合“复用用户已有的 Agent”的产品定位。
- **推荐理由**：先把会话语义跑通；内置 runtime 作为后续可选能力。

### Q2. Captain 的配置粒度

**已决定：每个 Chat 一个 Captain Role。** 新建 Chat 时默认创建，可由用户更换。

- **选项 A（推荐）**：每个 Chat 一个 Captain Role；新建 Chat 时默认创建，可由用户更换。
- **选项 B**：每个 Room 一个 Captain，跨 Chat 记忆。
- **影响**：B 会让不同 Chat 的上下文和权限互相污染；A 与“Chat 是独立工作记录”一致。
- **推荐理由**：Captain 是 Chat 内的协调者，不是全局管理员。

### Q3. Task 创建策略：默认 draft 还是 direct？

**已决定：默认直接 `create_task`；`draft_task` 保留为可选；首轮不增加任务创建的用户审批限制。**

- **选项 A**：默认 `draft_task`，用户确认后入队；用户在消息中明确说“直接做/开始实施”时，Agent 可用 `create_task`。
- **选项 B（选用）**：默认 `create_task`；`draft_task` 只在 Agent 主动想先确认目标/范围/成本时使用。
- **影响**：B 更快，Agent 有完整自主能力；代价是可能产生用户不需要的任务，需要后续用 stop/cancel/评论纠正。
- **选用理由**：首轮先上完整能力，不在任务创建上增加人工闸门；平台仍保留权限、并发、成本和安全边界。

### Q4. 是否保留平台级 Controller？

**已决定：不保留隐藏 Controller。** Captain 是可见角色；路由规则是纯函数；用户命令和 Agent 工具都走公开入口。

- **选项 A（推荐）**：不保留隐藏 Controller。Captain 是可见角色；路由规则是纯函数；用户命令和 Agent 工具都走公开入口。
- **选项 B**：保留一个平台路由器，只做消息路由，不建 Task、不拆任务。
- **影响**：B 可以作为可靠性兜底，但要防止它重新长成任务分解器。
- **推荐理由**：A 更符合 agent-for-agent；如果后续证明需要确定性路由，再加一个“只路由、不建任务”的组件，并写进 ADR。

### Q5. Report 的产生方式

**已决定：优先 MCP 工具 `finish_task`，不支持时用严格文本标记 fallback。**

- **选项 A（推荐）**：优先注入 MCP 工具 `finish_task`；不支持 MCP 的 CLI 用严格文本标记 fallback。
- **选项 B**：只接受文本标记。
- **选项 C**：只接受工具调用。
- **影响**：A 兼容性最好；B 简单但脆弱；C 对 CLI 能力要求高。
- **推荐理由**：先探测 runtime 能力，再选择通道；两种通道共用同一套严格校验。

### Q6. Task 验收：用户手动接受，还是可自动 done？

**已决定：`ready` → `in_review` → 用户接受 → `done`，默认保留人工验收。**

- **选项 A（推荐）**：`ready` → `in_review`，用户接受后 `done`；可对低风险 Task 配置自动接受。
- **选项 B**：`ready` 直接 `done`，用户可事后拒绝。
- **影响**：A 保留人工验收点；B 更快但容易把未验收结果当成完成。
- **推荐理由**：项目室的核心价值之一是“可检查的结果”，默认保留人工验收。

## 可以 Phase 2/3 再决定

### Q7. 旧数据迁移的深度

- **推荐**：一次性导入 Room/Chat/Message/Task/Report/Artifact 引用；不导入 checkpoint/gate/seat/round 状态；不伪造旧原生 session。
- **待定**：旧消息是否全部导入，还是只导入最近 N 条 + 归档其余。
- **影响**：全部导入会让新库变大；只导入最近 N 条会丢失历史可读性。

### Q8. Session Handoff 由谁生成

- **推荐**：平台模板 + Captain 可选补充。平台模板包含 Chat goal、已决定事项、开放 Task、最近消息；Captain 可以在轮换时写一段交接。
- **待定**：Captain 生成 handoff 是否算一次模型调用、是否消耗 wake budget。
- **影响**：Captain 生成更自然，但增加成本和延迟。

### Q9. Agent 评论是否唤醒执行者

- **推荐**：其他 Agent 的评论可以唤醒执行者（作为新的 user message / continuation run）；执行者自己的评论不回灌。
- **待定**：是否需要限制“Agent 之间互相评论”的 wake budget，防止循环。
- **影响**：不限制可能形成对话循环；限制过严会让协作变慢。

### Q10. Task 依赖与子任务的范围

- **推荐**：第一阶段只支持 `parent_task_id`、`blocked_by_task_ids`、`required_artifact_ids`、`optional`；不做跨 Chat 依赖图。
- **待定**：是否在 UI 中显示任务树，还是只显示列表。

### Q11. 隔离 workspace 的时机

- **推荐**：Phase 5 之后；先跑通 Room 主目录 + 租约 + Artifact。
- **待定**：隔离模式是 worktree、临时目录，还是两者都支持。
- **影响**：过早引入会把环境准备、合并和发布复杂度提前。

### Q12. 角色/Provider 的默认选择

- **推荐**：新建 Chat 时用户显式选择 Provider 和角色；Captain 使用用户指定的 Provider。
- **待定**：没有可用 Provider 时，是否允许创建只读的“未配置”角色。

### Q13. 成本与并发边界

- **推荐**：第一阶段至少限制：
  - 每 Room 最大并发 TaskRun（默认 2）；
  - 每 Chat 最大 active Role 数；
  - 每用户消息 wake budget 5；
  - 单 Task/run 的模型调用上限（可配置）。
- **待定**：是否在超限时创建 Attention，还是直接拒绝。

### Q14. 多机器 / daemon

- **推荐**：不做。Meldwork 是本地 Electron 产品；跨机器运行不属于第一阶段。
- **待定**：如果未来要做，是否复用 eta 的 daemon 语义。

### Q15. Memory / 知识源

- **推荐**：第一阶段不做跨会话 memory；保留现有 Skill/知识源能力。
- **待定**：后续是否接入 eta 的 memory sidecar 语义，还是保留 Meldwork 现有 knowledge connector。

## 命名与文档

### Q16. 用户可见术语

- **推荐**：继续使用 Room / Chat / 角色 / 任务 / 报告 / 待处理事项 / 产物。
- **避免**：Controller、Assignment、Checkpoint、Gate、Seat、Round、Batch、Briefing 等内部词出现在用户界面。
- **待定**：英文文案中 Captain 是否保留，还是叫 Coordinator / Lead。

### Q17. 旧文档的处置

- **推荐**：`docs-new/` 顶部加“已被 docs-new2 取代”的说明，但不删除历史；`docs/` 保留为 v1 参考。
- **待定**：是否把 `docs-new` 的实现记录压缩成一份“经验与坑”文档。

## 决策记录模板

决定一项后，在 `07-decisions.md` 增加 ADR：

```text
## ADR-N<x>：<标题>

**背景：** ...
**决定：** ...
**后果：** ...
**取代：** <旧文档/旧 ADR>
```
