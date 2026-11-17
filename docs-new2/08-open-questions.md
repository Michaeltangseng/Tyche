# 08 待决问题

本文件记录尚未冻结、但会影响实现的选择。每项给出推荐；批准后写入 `07-decisions.md` 或实施计划。

## 已决定（2026-11-17）

以下 6 项已由用户确认；实施计划以此为准。选项保留用于记录取舍。

### Q1. Worker 运行时范围：只接外部 CLI，还是同时做内置 runtime？

**已决定：第一阶段只接外部 CLI。**

- **选项 A（选用）**：第一阶段只接外部 CLI（Claude Code、Codex 等），平台不拥有 session 正文和压缩。
- **选项 B**：同时做一个平台自管 runtime，使用 eta 的 journal/compaction。
- **影响**：B 会显著增加实现量，并引入“平台自己的模型调用、工具、journal、压缩”一整套责任；A 更符合“复用用户已有的 Agent”的产品定位。

### Q2. Captain 的配置粒度

**已决定：每个 Chat 一个 Captain Role。** 新建 Chat 时默认创建，可由用户更换。

- **选项 A（选用）**：每个 Chat 一个 Captain Role；新建 Chat 时默认创建，可由用户更换。
- **选项 B**：每个 Room 一个 Captain，跨 Chat 记忆。
- **影响**：B 会让不同 Chat 的上下文和权限互相污染；A 与“Chat 是独立工作记录”一致。

### Q3. Task 创建策略：默认 draft 还是 direct？

**已决定：默认直接 `create_task`；`draft_task` 保留为可选；首轮不增加任务创建的用户审批限制。**

- **选项 A**：默认 `draft_task`，用户确认后入队；用户在消息中明确说“直接做/开始实施”时，Agent 可用 `create_task`。
- **选项 B（选用）**：默认 `create_task`；`draft_task` 只在 Agent 主动想先确认目标/范围/成本时使用。
- **选用理由**：首轮先上完整能力，不在任务创建上增加人工闸门；平台仍保留权限、并发、成本和安全边界。

### Q4. 是否保留平台级 Controller？

**已决定：不保留隐藏 Controller。** Captain 是可见角色；路由规则是纯函数；用户命令和 Agent 工具都走公开入口。

- **选项 A（选用）**：不保留隐藏 Controller。Captain 是可见角色；路由规则是纯函数；用户命令和 Agent 工具都走公开入口。
- **选项 B**：保留一个平台路由器，只做消息路由，不建 Task、不拆任务。
- **选用理由**：A 更符合 agent-for-agent；如果后续证明需要确定性路由，再加一个“只路由、不建任务”的组件，并写进 ADR。

### Q5. Report 的产生方式

**已决定：优先 MCP 工具 `finish_task`，不支持时用严格文本标记 fallback。**

- **选项 A（选用）**：优先注入 MCP 工具 `finish_task`；不支持 MCP 的 CLI 用严格文本标记 fallback。
- **选项 B**：只接受文本标记。
- **选项 C**：只接受工具调用。
- **选用理由**：A 兼容性最好；B 简单但脆弱；C 对 CLI 能力要求高。

### Q6. Task 验收：用户手动接受，还是可自动 done？

**已决定：`ready` → `in_review` → 用户接受 → `done`，默认保留人工验收。**

- **选项 A（选用）**：`ready` → `in_review`，用户接受后 `done`；自动接受是后续可选，不是首轮默认。
- **选项 B**：`ready` 直接 `done`，用户可事后拒绝。
- **选用理由**：项目室的核心价值之一是“可检查的结果”，默认保留人工验收。

## 评审后新增决定

以下不是“待决”，已经写入 `07-decisions.md`；列在这里方便评审对照。

### D1. Captain 协调复用 eta review supervisor，不做 completion wake

- 不新增 completion wake、独立 completion 预算或 `stage_complete` 工具。
- supervisor 60 秒 tick 是兜底，领域变化 150ms debounce 是快路径；检查已结算 assignment；目标空闲、关联 Task 不是 todo/in_progress 且无 open run、`activity_seq` 有新活动/blocked/stalled 时创建 `captain_review`。
- 没有 Task 的 assignment 回复也能生成 `assignment_settled`。
- review 行和 Captain review 回复标 `audience=captain`，不计入 `activity_seq`；否则 review 会自己推进水位并循环。
- review 正文是观察，不是上一环全文；Captain 通过增量简报读实际 public 消息。
- review 以 `system` 消息进入 Captain 会话，不占 5 次 agent-to-agent 预算；`assign_in_group` 也不占 5 次，5 次只约束 `mention` 工具调用。
- 详见 ADR-N16；实现参考 `eta/apps/eta/src/captain/supervisor.ts` 和 `captain/service.ts`。

### D2. 水位属于 participant/lane，不属于 session

- `chat_participants.last_seq`、`task_lanes.last_seq`。
- `sessions.baseline_seq` 只记录 session 起点。
- 轮换 session 不丢水位。

### D3. Task session 按 lane/role 区分

- `chat:<chatId>:role:<roleId>`。
- `task:<taskId>:role:<roleId>`；执行者 lane 跨 run 复用，mention lane 独立。
- handoff 到另一个角色创建新 lane/session，不继承旧执行者记忆。

### D4. 所有进程启动走 effect

- 聊天回复：`start_reply` effect。
- TaskRun：`start_run` effect。
- effect 成功后才进入 running；unknown 不自动重放。

### D5. Chat 回复默认只读；写入只在 TaskRun

- Chat 回复 `read-only` / `read-exec`。
- 写入需要 Room 授权、Role 写入权限、非空 writeScopes、租约。
- 隔离前每个 Room 同时最多一个写入型 TaskRun；只读 run 可并行。

### D6. Agent 工具通道 MCP 优先，严格标记兜底

- `mention` / `create_task` / `comment_task` / `finish_task` 都必须有通道。
- 身份由 run/session 绑定；`toolCallId` 幂等。
- 只有执行者 lane 的 active run 能 `finish_task`。

### D7. Task 验收是用户命令

- 新增 `accept_task` / `reject_task`，带 `commandId`。
- Artifact 状态与 Task 状态独立。
- `handoff` Report 只记录建议；实际交接是用户 `handoff_task`。

## 必须在 Phase 2 前验证

### Q18. Claude Code / Codex 的 resume 是否真的接着上次上下文？

这不是文档选择，而是硬门槛。

- 每个 CLI 做一次：prompt A 让 Agent 记住事实 → resume → prompt B 问事实。
- 再测：CLI 重启后、长对话/压缩后、权限/Prompt 变化后。
- 记录 token 使用和失败模式。
- 如果 resume 只是“新 prompt 但没记忆”，停止 Phase 2，改设计：
  - 要么接受无记忆 + 每次带最近上下文；
  - 要么平台生成 handoff，不承诺原生记忆。

### Q19. MCP server 的边界与认证

- main 为每次 run/session 起 MCP server；只监听 loopback。
- 需要确定：
  - 每个 run 一个 server，还是每个 session 一个；
  - CLI 如何拿到 endpoint/token；
  - 工具调用的超时、取消和幂等；
  - 不把 token/凭据暴露给 CLI 的 prompt 或日志。
- 推荐：每次 run 一个短期 server，token 只通过受控环境变量传递，run 结束即失效。

### Q20. 不支持 MCP / 标记的 CLI 怎么办

- 推荐：只作为只读讨论参与者；不能建 Task、不能 mention、不能 finish_task。
- 用户手动触发下一步，或换一个支持工具的 CLI。
- 不要把“自由文本 @”当成派发。

## 可以 Phase 2/3 再决定

### Q7. 旧数据迁移的深度

- **推荐**：一次性导入 Room/Chat/Message/Task/Report/Artifact 引用；不导入 checkpoint/gate/seat/round 状态；不伪造旧原生 session。
- **待定**：旧消息全部导入，还是只导入最近 N 条 + 归档其余。
- **影响**：全部导入会让新库变大；只导入最近 N 条会丢失历史可读性。

### Q8. Session Handoff 由谁生成

- **推荐**：平台模板 + Captain 可选补充。平台模板包含 Chat goal、当前 context revision、开放 Task、最近消息；Captain 可以在轮换时写一段交接。
- **待定**：Captain 生成 handoff 是否算一次模型调用、是否占用 Captain 的 review/wake 预算。
- **影响**：Captain 生成更自然，但增加成本和延迟。

### Q9. Agent 评论是否唤醒执行者

- **推荐**：其他 Agent 的评论进入 TaskActivity；执行者 lane 的 session 在下一次 continuation run 读到。不直接唤醒一个正在运行的一次性 CLI。
- **待定**：是否需要限制 Agent 之间互相评论的频率。
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

- **已定**：隔离前每个 Room 同时最多一个写入型 TaskRun；只读 run 默认最多 2。
- **待定**：单 Task/run 的模型调用上限、最大 active Role 数、超限时创建 Attention 还是直接拒绝。

### Q14. 多机器 / daemon

- **推荐**：不做。Meldwork 是本地 Electron 产品；跨机器运行不属于第一阶段。
- **待定**：如果未来要做，是否复用 eta 的 daemon 语义。

### Q15. Memory / 知识源

- **推荐**：第一阶段不做跨会话 memory；保留现有 Skill/知识源能力。
- **待定**：后续是否接入 eta 的 memory sidecar 语义，还是保留 Meldwork 现有 knowledge connector。

### Q21. Captain review 的节奏

- **推荐**：沿用 eta 的 150ms 领域变化 debounce 作为快路径，60 秒 tick 只是没有新事件时的兜底；批量 20 条 / 12k 字符。
- **待定**：Meldwork 是否需要更快的 tick（例如 10 秒）来改善交互感；是否按 Chat 配置。
- **注意**：不要退化成“每个 Task 完成立即 wake”或“每个回复结束 wake”。

### Q22. Task 迁移的编号与 Report 归属

- **推荐**：保留旧 Task 编号；冲突时新增编号并记录映射；Report 按 assignment id 迁移，不按 task id 折叠。
- **待定**：旧 checkpoint 的 gate/seat/round 是否需要在归档中可读，还是只保留原始 JSON。

### Q23. Renderer 是否显示 Room 根目录

- **推荐**：默认只显示 Room 名称和相对路径；如果需要显示绝对路径，作为显式只读字符串，不提供文件系统能力。
- **待定**：是否在设置页显示“当前工作目录”完整路径。

## 命名与文档

### Q16. 用户可见术语

- **推荐**：继续使用 Room / Chat / 角色 / 任务 / 报告 / 待处理事项 / 产物。
- **避免**：Controller、Assignment、Checkpoint、Gate、Seat、Round、Batch、Briefing、Completion wake 等内部词出现在用户界面。
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
