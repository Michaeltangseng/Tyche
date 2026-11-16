# v2 待办与缺口清单

本文档把 `docs-new` 中尚未完成、尚未验收或实现与文档不一致的事项集中记录，作为后续实施和评审的单一待办入口。

- 基线日期：2026-11-15
- 基线代码：`project-room` 分支当前工作树
- 关联文档：[07-implementation-roadmap.md](07-implementation-roadmap.md)、[05-implementation-plan-and-open-questions.md](05-implementation-plan-and-open-questions.md)
- 使用方式：完成后在本文档勾选并注明提交/验收记录，再把长期有效的结论回写到 `01`–`07`；不要只更新路线图的历史日志。

## 当前基线

以下主链已经存在代码和定向测试，不再列为“从零待做”：

- 应用私有区 SQLite 账本、schema version、WAL、事务和 migration；
- Message 入口、Chat/Task/Assignment/Report/Attention/Artifact 查询；
- Controller 批次、队列、退避、context revision 和决策审计；
- ControllerAction / UserCommand / PlatformTransition 的入口与校验骨架；
- Report 导入、Task 状态推导、outbox/effect、Supervisor liveness、启动恢复和进程对账；
- 动态角色创建、角色 Prompt revision、Chat/Role Skill 绑定；
- Room 主目录写入租约、Artifact 快照/diff、v2 群聊 UI、真实 Claude Code 多 Agent smoke。

因此下面的待办按“正确性缺口 / 功能缺口 / 产品化缺口 / 文档收口”排序，而不是按模块重新列一遍。

---

## P0：正确性与协议缺口

这些事项会影响数据隔离、协议一致性或用户操作结果，建议先于任何新功能处理。

### [ ] P0-01 `assign` 缺少 Chat 作用域校验

**现状**

`room-actions.cjs` 的 `applyController` 在 `assign` 时调用 `repository.createAssignment`。`room-repository.cjs` 的 `createAssignment` 只检查 Task 和 Role 是否存在：

```text
task = SELECT chat_id FROM tasks WHERE id = ?
role = SELECT prompt_revision, skill_bindings_json FROM agent_roles WHERE id = ?
```

没有校验 `task.chat_id === role.chat_id`，也没有校验 Task 属于当前 action 的 `chatId`。Controller 或错误数据可能把 Chat A 的 Task 分配给 Chat B 的 Role。

**需要做**

- 在 `createAssignment` 或 `applyController` 强制校验 Task、Role、Chat 三方归属；
- 拒绝时返回明确错误码，例如 `ROOM_ASSIGNMENT_CHAT_SCOPE_INVALID`；
- 补测试：Chat A Task + Chat B Role、跨 Chat taskId、伪造 roleId 均被拒绝。

**验收**

- 跨 Chat 分配无法落库；
- 现有同 Chat 分配、重试、交接路径不回归。

### [ ] P0-02 ControllerAction 字段校验不完整

**现状**

`room-actions.cjs` 的 `normalize` 只对少数动作做了详细校验（`update_context`、`update_role_prompt`、用户侧 `retry/handoff/stop`）。`create_task`、`assign`、`create_role`、`request_attention`、`note` 等主要动作还缺少必填字段、类型、长度和枚举校验。

例如：

- `create_task` 没有强制 `objective`、`kind`、`sourceMessageIds` 类型；
- `assign` 没有强制 `taskId`、`roleId`、`writeScopes` 结构；
- `create_role` 没有强制 `displayName`、`provider`；
- `request_attention` 没有强制 `question` 和 `options` 结构。

**需要做**

- 为每个 ControllerAction 定义字段表、类型和枚举；
- 拒绝缺失字段、错误类型、超长字符串和非法 `writeScopes`；
- 补参数化测试，覆盖每个动作的合法/非法输入。

**验收**

- Phase 0 的退出条件可复现：未知字段、错误 actor、过期 revision、重复幂等键、缺失必填字段都被拒绝。

### [ ] P0-03 `note` 已有产品效果，`propose_stop/retry` 仍只有审计事件

**进展（2026-11-16）**

`note` 现在会写入一条 `author_type=controller` 的 Chat 消息，并由前端显示为主控消息。Controller Prompt 要求包含用户消息的批次不得返回空动作；若模型仍返回 `[]`，Controller Session 会生成一条本地化兜底主控消息，避免用户消息完全无回应。

**仍待做**

`propose_stop` / `propose_retry` 仍只记录审计事件，没有 Attention 或可执行建议；`controller-agent.cjs` 也未在 Supported actions 中列出它们。二选一：

1. 实现最小产品语义：生成 Attention 或 UserCommand 建议；
2. 暂时从 `CONTROLLER_TYPES`、文档和测试中移除，等有 UI 再接。

**验收**

- 协议中出现的动作都有明确、可观察的效果，不能“成功但什么也没发生”。

### [ ] P0-04 `archive_chat` / `restore_context` 是空实现

**现状**

`room-actions.cjs` 的 `USER_TYPES` 包含：

```text
archive_chat
restore_context
```

但 `user-commands.cjs:111` 对未实现命令统一抛出：

```text
ROOM_USER_COMMAND_UNSUPPORTED
```

`room-ipc.cjs` 还专门校验了 `restore_context` 的 revision，但底层没有实现，协议和实现不一致。

**需要做**

二选一：

1. 实现 `archive_chat`（归档不删除 Room Artifact，不派发新任务）和 `restore_context`（切回历史 revision，明确后续 Assignment 使用哪个 revision）；
2. 从 `USER_TYPES`、IPC 校验、文档和 UI 中移除，等有产品入口再加。

**验收**

- 不会出现“校验通过但执行一定失败”的命令；
- 归档/恢复如果实现，必须有归属、幂等和状态测试。

### [ ] P0-05 `accept_artifact` / `reject_artifact` / `answer_attention` 缺少幂等键和状态保护

**现状**

- `accept_artifact`、`reject_artifact`、`answer_attention` 的字段表没有 `commandId`；
- 重复点击会重复写事件；
- 先 reject 再 accept 会直接覆盖状态；
- `answer_attention` 只检查 `status === 'open'`，没有统一命令幂等。

**需要做**

- 为所有改变状态、可能重复提交的用户命令增加 `commandId`；
- 定义 Artifact 合法状态转移：`published → accepted | rejected`，终态不可被普通命令覆盖；
- 定义 Attention 只能从 `open → answered`；
- 补重复命令、非法状态转移和跨 Chat Artifact 测试。

**验收**

- 同一个 `commandId` 重放返回原结果；
- 终态不会被误覆盖；
- 失败不会留下部分状态。

### [ ] P0-06 `reassign` / `update_task` 文档有、代码没有

**现状**

`docs-new/05`、`02`、`06` 均提到 `reassign` 和 `update_task`，但 `room-actions.cjs` 的 `CONTROLLER_TYPES` 没有这两个动作，`room-repository.cjs` 也没有对应更新方法。`07` Phase 4 还把 `reassign` 列为工作项。

**需要做**

二选一：

1. 实现：
   - `reassign` 只作用于尚未启动的 Assignment；
   - `update_task` 只修改目标、依赖、优先级、输入等元数据，不能改 `status`；
2. 从 `02`、`05`、`06`、`07` 中移除，明确 v2 第一版不支持。

**验收**

- 文档中的动作集合与 `CONTROLLER_TYPES` 完全一致；
- 如果实现，必须有“运行中不可改派”和“状态字段不可写”的测试。

### [ ] P0-07 Controller 只支持纯 JSON，不支持 ACP 工具调用

**现状**

`controller-agent.cjs:3` 的 `parseControllerResponse` 只接受：

- 纯 JSON；
- 带 ```json 围栏的 JSON。

文档写的是“ACP 工具调用或严格 JSON block”。如果短期不做 ACP，应直接修正文档，避免实现者误以为已有双通道。

**需要做**

二选一：

1. 接入 ACP 工具调用解析，并保留严格 JSON fallback；
2. 在 `02`、`07` 中明确“当前只支持严格 JSON”，把 ACP 放到后续 ADR。

**验收**

- 协议文档和 `parseControllerResponse` 的实际能力一致；
- 解析失败仍然不会产生动作或状态变更。

### [ ] P0-08 旧 `ready/question/continue` 回执映射缺失

**现状**

`report-importer.cjs` 只解析新的：

```text
[[MELDWORK_REPORT:{...}]]
```

`07` Phase 1 要求兼容旧 `ready/question/continue` 回执并映射为 Report。当前旧 Chat 仍走旧引擎，所以这不是新 Chat 的阻塞项，但作为 Phase 1 验收项尚未完成。

**需要做**

- 明确旧回执只用于 legacy 投影，还是也允许新 Chat 导入；
- 如果做映射，定义字段、优先级和冲突处理；
- 补旧回执 → Report 的定向测试；
- 如果不做，在 Phase 1 文档中明确降级为“旧引擎自行处理”。

**验收**

- 旧回执不会在两个引擎之间产生双真源；
- 旧 Chat 仍可打开、仍能显示历史结果。

### [ ] P0-09 RoomWorkspace 只显示泛化错误

**现状**

`useRoomWorkspace.js` 的 `mutate` 捕获所有异常后只设置 `error = true`，组件显示 `room.error`。实际错误码、IPC 失败原因和 renderer 异常都被隐藏。此前新建项目失败的 `DataCloneError` 就是因此只表现为“操作未完成”。

**需要做**

- 在 `mutate` 中至少保留并 `console.error` 原始错误；
- 对外暴露稳定的 `errorKey` / `errorDetail`，能区分：
  - IPC/序列化失败；
  - 权限失败；
  - 业务错误码；
  - 网络/超时；
- 技能保存等局部操作继续使用已有的专用错误提示。

**验收**

- 开发者能在控制台看到真实错误；
- 用户能看到可行动的错误提示，而不是一律“刷新重试”。

> 复核备注：当前工作树已把 `providers` 展开为普通数组，Skill 选择也已映射为 plain object，避免 Vue reactive Proxy 进入 IPC。仍建议保留 `structuredClone(payload)` 回归测试，防止后续重新引入同类问题。

---

## P1：Phase 5/6 功能缺口

### [ ] P1-01 动态角色的建议模式、复用和模板

当前只有 Controller 自动创建角色，还没有：

- 先创建角色草案、由用户确认后再激活的建议模式；
- 角色复用（相同职责优先复用）；
- 角色保存为模板、跨 Chat 手动复制。

> 进展（2026-11-16）：团队栏已支持用户主动新增角色，并可通过 `create_role` / `update_role` / `delete_role` 用户命令维护名称、职责、Provider、能力和主控标记；保留角色 Prompt/Skill 编辑。删除仅允许无历史 Assignment 的角色。仍缺角色草案、复用和模板。

**验收**

- 用户提出“需要一个生图角色”时，可以先看到草案和理由，再决定是否创建；
- 不会因为自动组队产生大量重复角色。

### [ ] P1-02 动态角色的成本、并发和 Provider 边界

当前 `room-actions.cjs` 只校验 Room Provider 和 capability 白名单，没有：

- 最大活跃角色数；
- 最大活跃 Assignment / Session 数；
- 单 Chat、单 Task、单 Assignment 成本上限；
- 新 Provider、高成本模型、长期保存角色触发 Attention；
- 成本超限后的降级/拒绝策略。

**验收**

- 超出上限时平台拒绝或创建 Attention，不会静默继续；
- 成本/并发事实进入 `controller_decisions` 或独立指标。

### [ ] P1-03 可选隔离 Assignment workspace

`native-runtime.cjs` 当前始终使用 Room 主目录：

```text
workdir: writeRoot || current.workdir
```

`Assignment.workspace_ref` 没有被真正使用。还缺：

- 为探索、高风险、显式 Artifact 契约任务创建隔离目录/worktree；
- 输入 Artifact 注入；
- 输出 patch/commit 或文件清单；
- 隔离 workspace 的发布、校验和清理；
- Room 主目录与隔离 workspace 的冲突/租约策略。

**验收**

- 需要强隔离的任务不再写 Room 主目录；
- 隔离结果可以发布为可审计 Artifact；
- 共享模式仍然可用，不被强制迁移。

### [ ] P1-04 Artifact 生命周期

当前 `accept_artifact` / `reject_artifact` 只改 `artifacts.status`，没有恢复工作目录。还缺：

- 接受后把版本恢复到 Room 主目录；
- 已接受版本的 drift 检测和提示；
- 任意两个版本的比较/全文浏览；
- 异常退出、终止后的部分产物自动归档；
- `artifact_snapshot` unknown 的专用恢复操作；
- 删除、重命名、二进制变化的完整展示。

**验收**

- 用户接受版本后，工作目录和账本一致；
- 版本被后续写入改变时能看到 drift；
- unknown 快照有明确的恢复/放弃路径，不自动重拍冒充原版本。

### [ ] P1-05 完整 Trace 面板

当前 `RoomWorkspace` 只有任务卡里的内联 Trace 摘要和 Blob 分页。还缺：

- 独立完整 Trace 面板；
- Controller 批次 Trace 的只读入口（当前 `assignmentTrace` 只接受 Assignment）；
- 步骤搜索、过滤和错误定位；
- 与 Artifact/Report 的关联跳转。

**验收**

- 用户可以从任务卡打开完整轨迹；
- 不向 Renderer 暴露路径、runId 或执行句柄；
- 大 Trace 仍按页/Blob 读取。

### [ ] P1-06 旧模式退役与旧 Chat 迁移

**现状**

- `App.vue` 仍保留 `ProjectRoomGatePanel`、`ProjectRoomSeatSettings`、`ProjectRoomProgress`、`ProjectRoomOverlay` 等旧入口；
- 新 v2 群聊与旧项目室并存；
- `docs-new/03` 的 legacy 标记、`state.json` 备份和消息导入工具尚未实现；
- 新 UI 的 `listRooms` 看不到旧项目室记录。

**需要做**

- 建立旧 V4 Chat 的 `engineVersion=legacy` 标记和只读投影；
- 提供一次性迁移工具：备份、导入可识别消息、保留原始引用；
- 新 Chat 隐藏 checkpoint/gate/seat/round 和并发/顺序/自动讨论选择器；
- 旧 Chat 保持兼容，迁移完成后再删除旧入口。

**验收**

- 旧项目仍可打开、历史可读；
- 新 Chat 不出现旧模式入口；
- 迁移失败可回滚，不删除旧数据。

### [ ] P1-07 v2 Attention 通知和收件箱

当前 v2 Attention 只在 Chat 内的卡片中展示。还缺：

- 系统通知；
- 未读收件箱/跨 Chat 汇总；
- 30 秒级合并，避免每个 Report 都通知；
- 点击通知后定位到对应 Room/Chat/Attention。

**验收**

- 用户离开当前 Chat 时仍知道有 Attention；
- 通知正文不包含敏感路径、Prompt 或凭据。

### [ ] P1-08 消息编辑/删除 UI

`message-ingress.cjs` 已有编辑/删除、作者校验和事件审计，但 `RoomWorkspace` 没有入口。需要：

- 编辑/删除按钮和权限判断；
- 编辑后产生新事件，不覆盖历史审计；
- 已删除消息的引用、回复和 Report 关联处理。

### [ ] P1-09 Controller 批处理、保留和重试治理

当前 `controller-queue.cjs` 限制的是输入条数（全局 256、单 Chat 64、单批 32），不是字节或 Token。还缺：

- 按字节/Token 划分批次；
- 重试耗尽后的用户控制面和持久化阻塞状态；
- 已消费消息编辑后的重新评估；
- 消息/事件/决策/消费凭据的归档和保留策略；
- 历史差集查询的扫描成本优化。

**验收**

- 大批量上下文不会撑爆 Controller Prompt；
- 重试耗尽后用户能看到原因并恢复；
- 长期运行不会无限增长关键表。

### [ ] P1-10 进程恢复边界

`process-reconciliation.cjs` 当前只覆盖受管理进程。仍需处理：

- 只读调用；
- 远端调用；
- 旧的无 `runId` 记录；
- 超过 ended 记录 24 小时保留窗口的调用；
- 残留进程的主动探测，而不是只读注册表；
- “停止 + 交接”一次操作自动完成。

**验收**

- 无法确认退出时不会伪造 `session_exited`；
- 用户能看到残留进程/unknown 的可行动指引；
- 重试/交接受进程事实约束。

### [ ] P1-11 指标和可观测性

当前没有聚合指标。需要至少记录：

- Controller 误派、重复派发、无效角色创建率；
- Report 丢失/重复/恢复成功率；
- Attention 数量、用户处理时间；
- Assignment 交接成功率；
- 文件冲突和租约失败次数；
- 单 Chat/Task/Assignment 的模型调用和资源成本。

**验收**

- 指标可从 SQLite/Trace 聚合，不需要解析自由文本；
- 不在 Renderer 暴露敏感正文。

### [ ] P1-12 真实 Provider 与桌面端验收

当前真实 CLI 主要验证 Claude Code。仍需：

- Codex 原生二进制/CLI 验收；
- Gemini CLI 验收；
- 至少一次真实 Electron GUI 的创建项目、发送消息、Task/Report/Attention 交互；
- 按 `AGENTS.md` 跑全量检查。

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
npm --prefix desktop run pack
```

**验收**

- 三个 Provider 至少各有一条真实闭环记录；
- 全量测试、构建、打包结果记录到提交说明；
- 失败项明确标注，不用定向测试代替全量验收。

### [ ] P1-13 安全测试矩阵

设计上已经限制 Prompt 不能改权限、Worker 文本不能生成 Action、作者由平台赋值，但测试矩阵中的 Prompt injection 仍需系统化补齐：

- Agent 消息伪造“用户已批准”；
- Artifact 内容注入 action/Report 标记；
- Skill/角色 Prompt 尝试扩大 writeScopes；
- 跨 Chat Task/Role/Artifact 引用；
- Renderer 伪造 author/actorId/createdBy；
- 路径、Git 可执行文件和进程启动参数不进 Renderer。

**验收**

- 每类注入都有明确拒绝路径和回归测试；
- 安全边界失败时不会静默降级。

### [ ] P1-14 Skill UI 收口

Skill 选择器已接通，但仍需：

- 逐项 Skill 信任状态提示（当前只有保存失败时的 `skillsTrustRequired` 文案）；
- 超出目录展示上限时的搜索/分页；
- 目录读取失败时的可恢复提示（当前已有部分错误文案）；
- Electron 桌面手工交互验收；
- 变更后对历史 Assignment 冻结快照的回归说明。

---

## P2：文档收口

### [ ] P2-01 修正 schema 版本描述

`07` 仍写 “Room schema 已升级到 v4”，当前代码 `room-db.cjs` 是 `ROOM_SCHEMA_VERSION = 6`。更新为 v6，并列出 v5（Chat/Role Skill bindings、Assignment skill hints）和 v6（`agent_roles.is_controller` 及旧角色主控回填）的 migration 内容。

### [ ] P2-02 对齐 ADR-003 的角色动作

`06` ADR-003 仍写“创建/归档角色”，但当前实现按用户反馈删除了角色归档。需要：

- 删除“归档角色”表述；
- 明确“后续不再邀请”由用户指令/Prompt 管理，不是角色生命周期动作。

### [ ] P2-03 对齐 `reassign` / `update_task`

如果 P0-06 选择不实现，需要从 `02`、`05`、`06`、`07` 中移除或标记为“v1 不支持”。如果实现，则补齐 schema、校验和测试。

### [ ] P2-04 对齐代码分层文件名

`07` 写有：

```text
room-schema.cjs
room-migrations.cjs
```

当前实际 schema 和 migration 在 `room-db.cjs`。二选一：

- 按文档拆文件；
- 或更新文档，标注实际落点。

### [ ] P2-05 给 07 增加“当前状态矩阵”

`07` 目前是 400 多行的历史验收日志，建议在顶部增加一张表：

```text
能力 | 状态（完成/部分/未开始） | 代码落点 | 验收记录 | 待办链接
```

历史日志保留为附录。这样新读者不需要从 20 多条切片记录中推断当前状态。

### [ ] P2-06 清理过期状态描述

`07` 中仍有个别已经被后续切片覆盖的“仍待/尚未”描述（例如授权 UI、Trace 入口、Skill UI）。建议统一以本文档和状态矩阵为准，历史日志只记录当时结论。

---

## 明确不做（v1 范围）

以下事项不是“待做”，除非后续 ADR 明确改变范围：

- 跨 Chat Task 依赖和全局依赖图；
- 把完整 Trace、聊天正文或 Artifact 内容写入 SQLite；
- 所有 Assignment 默认复制 worktree；
- 新的远程服务、云端消息或远程参与者；
- Controller 直接停止进程或直接设置 Task `done/cancelled`；
- 通过解析自由文本猜测完成、授权或用户审批；
- 在新引擎稳定前物理删除旧 checkpoint engine。

---

## 建议执行顺序

1. **P0-01 / P0-02 / P0-05**：先收口跨 Chat 校验、Action 字段校验和用户命令幂等；这些是数据正确性和安全边界。
2. **P0-03 / P0-04 / P0-06 / P0-07**：让协议里的每个动作要么有真实效果，要么被删除；同时统一 ACP/JSON 文档。
3. **P0-09**：补错误可观测性，避免下一个小问题又变成“刷新重试”。
4. **P1-03 / P1-04**：隔离 workspace 和 Artifact 生命周期，是从“能跑”到“可交付”的关键。
5. **P1-01 / P1-02 / P1-11**：动态角色治理、成本边界和指标。
6. **P1-06 / P1-12**：旧模式迁移、真实 Provider 和全量验收。
7. **P1-05 / P1-07 / P1-08 / P1-09 / P1-10 / P1-13 / P1-14**：按用户可见价值补 UI、通知和恢复细节。

## 验收记录模板

完成一项时，在对应条目下补充：

```text
完成提交：<commit>
修改文件：<paths>
测试命令：<commands>
测试结果：<pass/fail，定向/全量>
未覆盖项：<remaining>
```

这样本文档既能当待办，也能当验收索引，不需要再去翻长篇历史日志。
