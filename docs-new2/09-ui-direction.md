# 09 UI 方向与信息架构

> 2026-11-17。基于当前 `RoomWorkspace` / 旧 Project Room UI 审计，以及 eta Web UI 审计。
>
> **结论：保留 RoomWorkspace 的视觉外壳与卡片模式，重写数据适配层；删除整个旧 Project Room preview 和 checkpoint/gate/seat/round 状态机；不复用旧 `room-engine` 的 assignment/artifact/trace/files/context contract；按新 room domain 重建。**

## 1. 现状：三套东西并存

| 层 | 位置 | 状态 |
| --- | --- | --- |
| 旧 Project Room preview | `desktop/src/project-room/` + `ProjectRoom*.vue` + `useProjectRoom*.js` | ProjectService/checkpoint/gate/seat/round；由 `projectRoomPreview` 开关控制；应整体删除 |
| 当前 `RoomWorkspace` | `frontend/src/components/RoomWorkspace.vue` + `useRoomWorkspace.js` | 独立 `rooms` 页面，视觉层可用；数据来自旧 `desktop/src/room-engine/`；应保留视觉、重写数据层 |
| 新 room domain | `desktop/src/room/` + `read-model.cjs` | 领域、runtime、liveness、idempotency、events 已就绪；**没有 IPC/preload/UI**；是未来唯一数据源 |

目标 UI 已经写在 `docs-new2/02` / `06`：一个 `RoomWorkspace`，只显示消息、Agent 回复、mention、Captain assignment/review、Task/Report/Attention/Artifact 卡和 Trace；不出现 checkpoint/gate/seat/round 词汇。

## 2. 当前 RoomWorkspace 的逻辑

### 2.1 布局

```text
左侧栏
  Agent 列表
  Team rooms
    Room
      Chat（主 Chat + 其他 Chat）
  旧 Project rooms / Legacy projects（preview 开关）

中间 RoomWorkspace
  header
    Room 名 / Chat 名 / 工作目录 basename
    角色 chips（头像、名称、Controller badge、+）
    Attention 计数 / 文件 / Work 面板 / 新建 Room
  timeline
    加载更早
    用户消息（右）、Agent 消息（左）、Controller 高亮
    Report 卡（evidence + artifact）
    Assignment Trace（可展开）
    实时 assignment 输出
    Attention 卡（可回答）
  composer
  Work 面板（tasks/assignments/artifacts/stale）
右侧
  RoomFilesDrawer（目录树 + 文件预览；窄屏变 dialog）
弹窗
  Room 创建 / Project 设置 / Chat 设置 / 角色设置
```

截图中的实际问题：

- 右侧文件面板报 `room:files-list ... SCHEDULER_CLAIM_ROOT_INVALID`——旧 scheduler/room-engine 根目录逻辑，典型旧引擎包袱。
- “工作区写入授权”由 Captain 在聊天里解释 `workspace.writeAuthorized=false`——这是平台配置，不应靠 Agent 对话传达。
- 没有流式 process、tool call 卡、token/context、独立 Task 板/Inbox；Report 混在消息流里，Trace 只有一个折叠入口。

### 2.2 角色与 Chat

- Room = 工作目录、Provider、产物账本、共享工程事实。
- Chat = 独立团队记录（消息、角色、任务、报告、Attention、协作约定）。
- 角色 chips 来自当前 Chat 的 roles；点击打开角色设置；`is_controller` 是旧词，新 domain 是 `is_captain`。
- Chat 设置包含协作约定、Skill 绑定；当前 `sendContext` 实际只是发一条普通消息，不是 context revision。

### 2.3 旧 Project Room preview（应删除）

- Gate：accept/accept as-is/continue/reject、changed files、review summaries、commit to git。
- Drift：用工作区/恢复 accepted、diff。
- Out-of-scope、residual 进程确认、error bar retry、compact、diagnostics。
- Seat/Profile/Playbook/Template/Round/Checkpoint 配置。
- Reject upstream / reopen / impact preview。
- 侧栏 “Project rooms / Legacy projects” 与待处理决策列表。
- 这些全部绑定 `ProjectService` / checkpoint engine / workspace JSON，和新的 Room/Chat/Role/TaskRun/Report 模型无关。

### 2.4 已经死掉或坏掉的 UI（容易误留）

| 项 | 证据 | 结论 |
| --- | --- | --- |
| `ProjectRoomProgress.vue` | 进度链/摘要整段注释，`expanded` 默认 false 且无展开按钮 | 删除 |
| `ProjectRoomStatus` 的 “View diff” | `openDriftDiff` 只写 `selectedDiff`，无消费者 | 删除 |
| `ProjectRoomDrawer` 的 FileDiff | 模板有，但没有 `loadDiff` 调用 | 删除（用新文件抽屉） |
| `ProjectRoomSeatSettings` 的 add/remove | 模板注释，底层命令仍在 | 删除（新角色编辑器） |
| `project:open` 事件 | preload 暴露，前端无消费 | 删除 |
| `projectRoomPreview` 开关 | 迁移脚手架 | 删除 |
| 旧 `room:files-list` | 截图报 scheduler root 错误 | 重写文件 API |

## 3. 数据形状错配（新 domain 必须重写的地方）

新 `read-model.cjs` 已提供 display-safe snapshot，但旧 UI 仍按 room-engine 字段消费：

| 旧 UI | 新 domain |
| --- | --- |
| `assignments[]`（执行 assignment） | `runs[]`（TaskRun）+ `assignments[]`（Captain assignment） |
| `role.is_controller` | `role.is_captain` |
| `room.workspace` 绝对路径 | `room.workspace_label` + `write_authorized` |
| `task.objective` | `task.title/description/acceptance` |
| `report.assignment_id` | `report.run_id/lane_id/kind` |
| `attention.options_json` | `attention.options` |
| `role.current_prompt`/`skill_bindings` | `role.prompt/prompt_revision`（skills 待补） |
| `liveAssignments`（assignment-event） | `runtime_events` + run 事件流（待补 IPC） |
| `assignmentTrace` | run trace / runtime events（待补） |
| `artifactDiff` / `filesList` | 新 artifact/files contract（待补） |
| `chat.current_context` / `skill_bindings` | `chat_context_revisions`（待补 read model） |

**最容易踩错**：新 domain 的 `assignments` 是 Captain assignment，不是执行记录；执行记录是 `runs`。

## 4. eta 的 UI 逻辑与可借鉴点

### 4.1 一级结构

eta 是“对话驾驶舱 + 右侧上下文面板”：

- 左侧：Captain、全局入口（Chat/Tasks/Email/Routines）、按 project 分组的 Conversation、Agent 列表、Settings。
- 中间：Conversation 时间线 + composer。
- 右侧：Context / Tasks / Pending / Artifacts。
- 详情与编辑用弹层/抽屉，不离开当前上下文；窄屏变抽屉/整屏。
- 没有全局 Artifact/Inbox 页面；Artifact 和 Inbox 是 conversation 面板的一部分。

Meldwork 不需要照搬“全局 Captain / project 分组 / machines”，但可以借“中间对话 + 右侧当前上下文面板 + 弹层编辑”的结构。

### 4.2 十项值得借鉴

1. **回复行状态机**：`queued → working → waiting_for_input → done/failed/stopping/stopped`；回复一创建就占 `seq`，流式内容只增长 `revision`。Meldwork 的 Message 已有 status/seq/revision；TaskRun 用独立 status。
2. **持久时间线 vs 实时流分离**：运行中从 session 事件流渲染；结束后读 timeline 行里的稳定快照。Meldwork 用 `RuntimeEvent` 做 live，`Message`/`TaskRun`/`Report` 做提交后事实。
3. **process 与 answer 分离**：thinking/tool/过程文本折叠，answer 独立；tool card 默认折叠，按 command/diff/write/plan/JSON/图片/子步骤渲染；固定尺寸 Transcript 抽屉看全量。
4. **TaskRun 日志 + 时间条/瀑布图**：run 的日志复用同一套 tool card；header 显示状态/耗时/尝试/workspace；时间条按 model/shell/read/edit/other 着色，可点击跳到日志。
5. **上下文占用 + Session 检查器**：头像外环分片 system/context/user/assistant/toolDefs/tool；Inspect 看 prompt/tools；成员行显示 in/out/cache/tools/tok/s。
6. **Attention 只列真正阻塞的事**：pending question/approval、blocked/in_review task、unseen report/failure；可内联回答；不做通知中心；不做自动弹窗。
7. **乐观 outbox + 幂等发送 + held messages**：消息立即显示 Sending；失败 Retry/Edit/Discard；`clientId` 幂等；所有 lane 忙时 held 在 composer 上方；草稿/outbox 刷新恢复。
8. **Task/Artifact 卡与 provenance**：task draft/card 归属到写它的 turn；任务卡显示状态/run/comments/summary/artifacts/progress；artifact 有版本、publisher、task 关联、sandbox preview。
9. **Role/Agent 配置**：General/Instructions/Tools tabs；模型按 provider 分组、不可用项解释原因；thinking level 有“模型默认”；字段错误定位到 tab。
10. **三栏自适应 + 本地 UI 记忆**：面板可拖宽、宽度/折叠/rail 存 localStorage；窄屏变抽屉；详情/编辑用弹层。

### 4.3 eta 没做好、Meldwork 应做得更好的

- **Report**：eta 没有一等公民 Report，`finish_task` 摘要只变成评论。Meldwork 必须有独立 Report 卡：kind/summary/evidence/artifact_ids/next_request/attention。
- **Usage/Token**：eta 只在 Settings→Agents、成员行、上下文环露出；没有全局 usage 页、没有 per-run cost、`cost` 未渲染。Meldwork 应做 Role / TaskRun / Room 三层 token/cost，并区分 provider-reported 与 estimated。
- **流式状态**：eta 有 reconnect 提示，但桌面端还应显示 runtime 连接状态、interrupted/unknown、queued 原因。
- **Task 创建**：eta Web 有用户 `+ New`，但 Meldwork 的 Task 只由 Agent 创建；不要照搬用户新建或拖拽到 done。
- **Captain review**：eta 有 XML 文本 fallback；Meldwork 只消费结构化 `reviews`，不要解析自然语言。

### 4.4 不照搬

- 全局唯一 Captain / Captain 自己的会话；Meldwork 是每 Chat 一个 Captain Role。
- machines/daemon/Tailscale/phone link/max active runs。
- memory sidecar、routines、LLM gateway、Email。
- wire/cordis/target-action/WebSocket 协议；用 Electron IPC + SQLite，但可借 revision/快照/事件语义。
- Agent 作为全局配置、Project 作为 machine+directory；Meldwork 是 Room/Chat/Role。
- TUI/mobile 专用交互、4 字符/token 作为计费、快捷键文案不一致。

## 5. 删除 / 保留 / 重写

### 5.1 删除（旧 Project Room 整体）

| 范围 | 文件 |
| --- | --- |
| 旧 UI 组件 | `ProjectRoomStatus.vue`、`ProjectRoomGatePanel.vue`、`ProjectRoomProgress.vue`、`ProjectRoomComposer.vue`、`ProjectRoomTimelineCard.vue`、`ProjectRoomCreateDialog.vue`、`ProjectRoomSeatSettings.vue`、`ProjectRoomOverlay.vue`、`ProjectRoomDrawer.vue` |
| 旧 composables | `useProjectRoomView.js`、`useProjectRoom.js` |
| App 装配 | `App.vue` 中旧 project room controllers/watches/timeline props/sidebar props/overlay/dialog |
| 侧栏入口 | `WorkspaceSidebar.vue` 的 Project rooms / Legacy projects / pending decisions |
| Preview 开关 | `GeneralSettingsPanel.vue` + `projectRoomPreview` preference + locale |
| IPC/preload | `project:*`、`projectRoom.*`、`desktop.js` 旧方法 |
| 后端 | `desktop/src/project-room/` 全部 ProjectService/checkpoint/gate/seat/round/projection/store |
| workspace JSON | `state.projects[]`、`groups[].projectId/projectRole`、`snapshot.projectRooms/pendingDecisions` |
| i18n/CSS/测试 | `projectRoom.*` 旧分组、旧 project-room CSS、旧 `projectRoom*.spec.js` |

删除顺序：先移除 UI 入口 → 删 composables/controllers → 删 preload/project IPC → 解耦并删除 ProjectService/checkpoint → 清理 workspace JSON 字段与测试。

### 5.2 保留（视觉/交互可复用）

- `RoomWorkspace.vue` 页面外壳、header、角色 chips、timeline 消息层级、Report/evidence/artifact 卡、Attention 卡、实时输出行、Work 面板、简单 composer、设置弹窗壳、创建 Room 弹窗壳。
- `RoomFilesDrawer.vue` + `WorkdirTree` + `FilePreview`（换新 files API）。
- `RoomAssignmentTrace` 的展开/步骤视觉（键从 assignmentId 改 runId，数据换 runtime_events）。
- `RoomArtifactDiff` 的 diff 视觉（后端换新 artifact contract）。
- 角色编辑器视觉：两栏、头像、Provider、权限 chips、Prompt。
- 视觉 token：用户右/Agent 左/Captain accent、内容最大宽度、颜色变量、间距、响应式、Escape/aria/focus。
- i18n 模式：`room.*` 文案、错误码映射、缺 key 回退。

### 5.3 重写（概念需要，数据/接口换）

- `useRoomWorkspace.js` → 新 read model：`assignments→runs`、`is_controller→is_captain`、`workspace_label/write_authorized`、`report.run_id`、`attention.options`。
- Room header/角色 chips → 新 Room 级 roles 过滤、Captain、写授权状态。
- Project 设置 → Room 目录 label、Captain、写授权；删除 Controller。
- Chat 设置 → `chat_context_revisions` 真正保存协作约定；Skills 接新 domain。
- 角色设置 → `is_captain`、prompt revision、native permission、capabilities；删除 checkpointRoles。
- Work 面板 → Task/TaskRun/lane：stop/retry/handoff 按新语义重写，不照搬 assignment 命令。
- Report/Attention 卡 → 新字段。
- Artifact/Trace/Files/Context/Skills → 新 IPC/read model contract。
- 侧栏 Team rooms → `chat_count`、`primary_chat_id`；删除 `is_primary` 假设。
- 创建 Room → 新 bootstrap（workspace + roles），删除 template/seat。
- Composer → @ 成员/文件、# 任务、附件、reply/root；接新 routing/briefing。

### 5.4 新 UI 必须新增、旧 UI 没有

- Captain review 卡（`read-model.reviews`）。
- Captain assignment 行 / review reply。
- Task 编号/标题/验收标准、TaskRun/lane/required/writeScopes。
- Room 级写授权开关 + 只读提示。
- mention 行、system 事件、Task/Report/Artifact/Attention 卡。
- 流式 process + tool 卡 + Trace 抽屉。
- Token/context 显示。
- 统一的 “Needs you” Attention 面板、Task 板、Room 级 Artifacts。

## 6. 目标信息架构

```text
左侧
  Team rooms
    Room（attention badge、running 数）
      Chat（未读/working/waiting）
  Agents（全局 Agent 列表，保留 DM 入口）
  Inbox / Usage / Settings

中间
  Room header：Room 名 + workspace label + 写授权 + Room 级 Tasks/Artifacts
  Chat header：Chat 名 + 成员 chips（点击角色配置）+ 模型/思考/context chip + stop
  Timeline：
    用户消息 / Agent 回复 / mention / system
    process box（thinking + tool cards，折叠）
    answer
    Task 卡 / Report 卡 / Artifact 卡 / Captain review 卡 / Attention 卡
    流式、queued、waiting、failed、stopped 状态
  Composer：@ 成员/文件、# 任务、附件、发送/排队

右侧（可拖宽，窄屏抽屉）
  文件 / 任务 / 待办 / 产物 / 轨迹

Room 级页面
  Task 板（Agent 创建的 Task；状态 todo/in_progress/in_review/blocked/done）
  Artifact 账本（版本、publisher、task 关联）
  Usage（Role/TaskRun/Room token·cost）
```

### 6.1 流式

- `RuntimeEvent` 驱动 live：text/thinking/tool start·update·end/turn end/exit/permission；30–60ms 批量渲染。
- 首 token 前 skeleton；process 固定高度内部滚动并自动跟随；读者上滚停止跟随。
- answer 与 process 分离；结束后 process 折叠，完整内容进 Transcript 抽屉。
- 明确 `streaming / waiting_for_input / reconnecting / interrupted`；桌面端显示 runtime 连接状态。

### 6.2 Token / Usage / Context

- **Role 级**：成员 chip/右侧成员行显示 in/out/cache、tok/s；hover 展开 5h/24h/7d。
- **TaskRun 级**：run header/Report 卡显示本 run tokens、cost（可选）、耗时、尝试次数。
- **Room 级**：Usage 面板显示当日/本周、按 Role/Provider 分解、失败率、预算。
- **Context**：Chat header 放紧凑 chip（“72% · 145k/200k”），点击打开 Session 检查器：分片、provider-reported/estimated、最后一次 compaction 前后、prompt revision。
- 超过预算/失败率/模型不可用 → 生成 Attention，而不是只藏在设置页。
- 区分“provider 精确 usage”和“4 字符/token 估算”；不要把估算当计费。

### 6.3 Attention

- 统一的 “Needs you”：question/approval、blocked/in_review task、failure/unknown、report ready。
- 每条显示来源 Chat/Task/Run/Role、为什么需要你、选项/影响、年龄、是否 blocking。
- 内联回答：单选/多选/自由文本/give up；乐观更新，失败重试。
- 不做通知中心、不自动弹窗；可选系统通知/托盘红点与 Inbox 同源。
- 统一 badge：Room attention、Chat 未读/working、Task blocked/in_review；不要 eta 那种口径分裂。
- 原处已有确认入口的 draft 不重复计入 Attention。

### 6.4 Role 配置

- General：显示名、Provider、模型、thinking level、Captain toggle。
- Instructions：Prompt 编辑 + revision 历史/diff；保存后新 run 生效。
- Permissions：native permission mode（YOLO 仍按 POC 决定）、capabilities、writeScopes（Task 级）。
- Tools/Skills：Skill 绑定、工具可见性。
- 字段级错误定位；保存失败保留输入。

## 7. 实施切片

> 具体交接、第一刀文件清单、验证命令和风险，见 `docs/superpowers/handoffs/2026-11-17-room-ui-rewrite-handoff.md`。

1. **删除旧 Project Room preview**：UI 入口/composables/project IPC/ProjectService/checkpoint/workspace JSON 字段/i18n/CSS/测试。独立、低风险，立即减少噪音。
2. **新 Room host + IPC + preload**：新 SQLite、OAR adapter、wrapper/state、startupSweep、app quit close；`room:*` narrow handlers；缺失 contract（files/artifacts/trace/context/skills/usage/write auth/accept task）一起补。
3. **重写 `useRoomWorkspace` + `RoomWorkspace` 数据层**：保留视觉外壳，换新 read model；先跑通 Room/Chat 时间线、发送、流式、Task/Report/Review/Attention。
4. **补 UI 卡与右栏**：process/tool trace、Task 板、Artifact、Needs you、Usage/Context、Role 编辑。
5. **删除旧 `room-engine` IPC/service/UI 数据路径**：新 UI 切换完成后，避免双引擎。
6. **Electron desktop 验证、i18n、全量检查**。

## 8. 判断标准

- 用户只通过消息、角色、Task、Report、Attention、Artifact 完成协作；
- 不出现 checkpoint/gate/seat/round/controller/pending decision 等旧词汇；
- renderer 不接收绝对 workspace 路径、session/native ref、PID、token、tool 原始路径；
- 流式、失败、排队、等待输入、interrupted 都有明确状态；
- token/context 是“可查、可解释、可行动”的，不是装饰数字；
- 旧 UI 删除后，代码只保留一套 Room UI、一套数据源、一套状态机。
