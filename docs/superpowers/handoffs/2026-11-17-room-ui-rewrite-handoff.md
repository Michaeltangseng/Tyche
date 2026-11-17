# Room UI 重写交接（2026-11-17）

> 用途：后端阶段完成、UI 审计完成后的交接。上下文压缩后从本文继续。
>
> 配套：
> - `docs-new2/09-ui-direction.md`：完整 UI 审计、Keep/Delete/Rewrite、目标信息架构。
> - `docs/superpowers/handoffs/2026-11-17-meldwork-room-v2-handoff.md`：后端垂直切片历史与语义。

## 0. 一句话

**后端已经闭环；旧 Project Room preview 与旧 `room-engine` 均已删除；`RoomWorkspace` 已直接跑在新 room domain 上，并接好流式事件、tool trace、usage、artifact 账本与乐观 outbox。下一步做硬化（Slice 5）：Electron 43/Node 24、pack、真实窗口验收、Windows 崩溃治理、POC YOLO 复核。保留视觉外壳，不保留旧 contract。**

## 1. 当前状态

- 仓库：`/Users/limu/Desktop/githubs/29-meldwork/Tyche`
- 分支：`project-room`；12 个 commit **未 push**
- 最新 commit：`5c81260 feat(room): switch the team room UI to the new domain`（旧 `room-engine` 删除在其后一次提交）

| Commit | 内容 |
| --- | --- |
| `48d5eec` | OAR runtime adapter + engine-driven smoke |
| `58a95b9` | 领域幂等（schema v2） |
| `2d672fd` | room-service + liveness + supervisor + recovery |
| `ae86b61` | runtime_events（schema v3） |
| `5d94e35` | Task number / progress / acceptTask |
| `a2d5eff` | OAR 硬崩进程治理（wrapper + sweep） |
| `7ba6a66` | mention lane + unknown-effect Attention |
| `988fab2` | display-safe room read model |
| `eede08b` | UI 方向与重写 handoff 文档 |
| `dfe4c09` | Slice 0：删除旧 Project Room preview |
| `24f14ed` | Slice 1：新 room host + team-room IPC + preload |
| `5c81260` | Slice 2：RoomWorkspace/useRoomWorkspace 切到新 domain；角色 CRUD/Attention/删 Room |
| 本次提交 | Slice 4：删除旧 `room-engine`、preload `room.*`、RoomAssignmentTrace/RoomArtifactDiff |

验证状态：

- **259/259** focused desktop tests（Node 24.22.3 + Electron 43 环境）：room + shell + preload/main security + trace。
- **109/109** `main-security.test.cjs`（删除旧 room-engine 后从基线 7/110 恢复）。
- Electron 43.8.10（Node 24.22.1）启动 smoke 通过；OAR 动态加载、`node:sqlite` 可用。
- **96/96** room domain + team-room IPC + preload security。
- **30/30** invocation/permission/write/lease workspace tests。
- Claude / Codex service-driven OAR smoke（Node 24.22.3，Electron 43 升级后）：均 `ok: true`、`engineDriven: true`、`serviceDriven: true`；`assign_in_group → create_task → finish_task → settlement → Captain review → mention lane comment_task` 全链路；wrapper PID 记录 7/9 → 0。
- 前端：build / build:desktop 通过；Node 22 全量 **103 failed / 375 passed**，与 HEAD 基线减去已删除测试一致（剩余失败均为基线已有的 App 旧断言漂移）。
- 未跑：desktop 全量 suite、pack、Electron 43/Node 24、真实 Electron 窗口手工验收。

新 room domain 已具备：

- SQLite schema v3、Room/Chat/Role/Participant/Message/Task/TaskRun/Report/Attention/Session/CaptainReview/Artifact/Effect/RuntimeEvent/DomainIdempotency。
- `engine`、`task-queue`、`settlement`、`captain-review`、`supervisor`、`recovery`。
- `runtime-adapter.cjs`（OAR，Claude/Codex）、per-run MCP、NO_PROXY、YOLO（POC 例外）。
- `room-service.cjs`（liveness、supervisor、recovery、disposeAll）。
- `room-host.cjs`：生产装配 + bootstrap/chat/role/message/task/files/write/trace 命令 + 启动 sweep/close。
- `shell/team-room-ipc.cjs` + preload `teamRoom`：验证过的窄 IPC；旧 `room.*` 已删除。
- `domain-idempotency.cjs`、`runtime-events.cjs`、`runtime-processes.cjs` + wrapper。
- `read-model.cjs`：`listRooms`（含 chats）/ `snapshot` / `chatMessages`，display-safe snake_case DTO。

UI 现状：

- `RoomWorkspace`（`frontend/src/components/RoomWorkspace.vue`）保留视觉外壳，数据已来自 `teamRoom` preload / 新 room host。
- 角色配置、任务/run/report/Captain review/Captain assignment、Attention、文件、写授权、新建/删除 Room/Chat 已接通。
- 旧 Project Room preview 与旧 `room-engine` 已删除；当前只剩一套 Room UI、一套数据源。
- 已接：流式文本/thinking、tool cards、per-run trace、context usage chip、artifact 账本、乐观 outbox。
- 仍缺：Task 瀑布图/时间条、Role/TaskRun/Room 三层 cost、Session prompt/tools 检查器（Slice 5 / 后续）。

## 2. UI 审计结论（详见 `docs-new2/09-ui-direction.md`）

当前 UI：

- 左侧 Agent 列表 + Team rooms（Room → Chat）+ 旧 Project rooms。
- RoomWorkspace：header（Room/Chat 名、角色 chips、Attention/文件/Work）、timeline（用户/Agent/Controller、Report、Assignment Trace、实时输出、Attention）、composer、右侧文件抽屉、Work 面板、设置弹窗。
- 截图问题：文件面板报 `SCHEDULER_CLAIM_ROOT_INVALID`；写授权靠 Captain 在聊天里解释；没有流式 process/tool 卡、token/context、独立 Task 板/Inbox。

已死/应删的旧 UI：

- `ProjectRoomProgress.vue`（进度链/摘要注释，永远不展开）。
- `ProjectRoomStatus` 的 “View diff”（无消费者）。
- `ProjectRoomDrawer` 的 FileDiff（从未加载）。
- `ProjectRoomSeatSettings` 的 add/remove（模板注释）。
- `project:open` 事件（无消费）。
- `projectRoomPreview` 开关（迁移脚手架）。

eta 的强项：

- 回复行状态机 `queued → working → waiting_for_input → done/failed/stopping/stopped`。
- 持久时间线 vs 实时流分离（live 来自 session events，结束后读 timeline 快照）。
- process 与 answer 分离；tool card 按 command/diff/write/plan/JSON/图片/子步骤渲染；Transcript 抽屉。
- TaskRun 日志 + 时间条/瀑布图；上下文占用环 + Session prompt/tools 检查器。
- Attention 只列真正阻塞的事，可内联回答；不做通知中心。
- 乐观 outbox、幂等 clientId、held messages、草稿恢复。
- Task/Artifact 卡与 turn provenance；Agent/Role 配置 tabs；三栏自适应外壳。

eta 的缺口 / 不照搬：

- 没有一等公民 Report（finish_task 摘要只变评论）→ Meldwork 必须做独立 Report 卡。
- Usage 分散、无全局页、无 per-run cost、cost 未渲染 → Meldwork 做 Role/TaskRun/Room 三层。
- 不照搬：全局 Captain、machines/daemon、memory、routines、LLM gateway、Email、wire/cordis、Agent 作为全局配置、用户新建 Task/拖拽到 done、XML review fallback、TUI/mobile、4 字符/token 当计费。

## 3. 关键决策

1. **保留 `RoomWorkspace` 视觉外壳，重写数据适配层。** 不保留旧 `room-engine` 的 assignment/artifact/trace/files/context contract。
2. **删除旧 Project Room preview 整套。** 不保留 checkpoint/gate/seat/round 的任何 UI 或后端状态机。
3. **不做长期双引擎。** 新 UI 切换完成后删除旧 `room-engine` IPC/service/UI 数据路径；旧数据只归档，不迁移。
4. **借鉴 eta 的信息模型，不复制它的产品边界。** 重点借：回复状态机、持久时间线 vs 实时流、process/tool trace、TaskRun 日志、context/session 检查器、Attention、乐观 outbox、Task/Artifact 卡、Role 配置、三栏外壳。
5. **Meldwork 要有 eta 没有的：** 一等公民 Report、Role/TaskRun/Room token·cost、per-seat 权限与 write scope、Room 级 Artifact 账本、每 Chat 一个 Captain。
6. **POC 例外保留：** Chat/Task 当前 YOLO；生产化前重新评估 Chat 只读/write 租约语义。

## 4. 接下来的实施方向（按顺序）

### Slice 0：删除旧 Project Room preview（已完成，`dfe4c09`）

完成内容：

- 删除 `ProjectRoom*.vue`（9 个）、`useProjectRoom*.js`、对应 10 个前端 spec。
- 删除 `desktop/src/project-room/`、`shell/project-ipc.cjs`、`shell/workdir-ipc.cjs`、`desktop/test/project-room/`、`fake-agent` fixture。
- 移除 `project:*` / `workdir:*` IPC 与 preload API、`App.vue` 旧控制器、侧栏 Project rooms/Legacy projects/pending decisions、设置 preview 开关。
- 移除 workspace JSON 的 `projects[]`、`group.projectId/projectRole`、`projectRooms/pendingDecisions`、旧 project 消息 metadata 与 `insertProjectRoomMessage`。
- 删除 `projectRoom.*` / `errors.PROJECT_*` / `generalSettings.projectRoom*` 文案与 102 条死 CSS 规则。
- `workdir-access.cjs` / `shadow-git.cjs` 移到 `desktop/src/room-engine/`（旧 room-engine 仍在使用）；trace `encodeId` 独立到 `runs/trace/trace-ids.cjs`。
- 验证：frontend build / build:desktop 通过；Node 22 下 frontend 全量 103 failed / 400 passed，等于 HEAD 基线 109 failed 减去已删除的 6 个 ProjectRoom 失败，无新增回归；desktop focused 25/25、room-engine 209/209、room 65/65。

### Slice 0 原始范围（保留供追溯）

目标：把旧 checkpoint/gate/seat/round UI 和入口一次清掉，Team rooms/RoomWorkspace 不受影响。

删除范围：

- UI 组件：`ProjectRoomStatus.vue`、`ProjectRoomGatePanel.vue`、`ProjectRoomProgress.vue`、`ProjectRoomComposer.vue`、`ProjectRoomTimelineCard.vue`、`ProjectRoomCreateDialog.vue`、`ProjectRoomSeatSettings.vue`、`ProjectRoomOverlay.vue`、旧 `ProjectRoomDrawer.vue`。
- Composables：`useProjectRoomView.js`、`useProjectRoom.js`。
- App：`App.vue` 中旧 project room controllers/watches/timeline props/sidebar props/overlay/dialog/imports。
- 侧栏：`WorkspaceSidebar.vue` 的 Project rooms / Legacy projects / pending decisions。
- 设置：`GeneralSettingsPanel.vue` 的 Project rooms preview 开关、`projectRoomPreview` preference、locale。
- IPC/preload：`project:*`、`projectRoom.*`、`frontend/src/desktop.js` 旧方法、`preload.cjs:111-156`。
- 后端：`desktop/src/project-room/` 全部（ProjectService/checkpoint/gate/seat/round/projection/store）。
- workspace JSON：`state.projects[]`、`groups[].projectId/projectRole`、`snapshot.projectRooms/pendingDecisions`。
- i18n/CSS/测试：`projectRoom.*` 旧分组、旧 project-room CSS、`projectRoom*.spec.js`。

删除顺序：UI 入口 → composables/controllers → preload/project IPC → ProjectService/checkpoint → workspace JSON 字段 → i18n/CSS/tests。

验收：

- 侧栏只剩 Team rooms + Agent 列表；无 Project rooms / Legacy projects / preview 开关。
- `rg -n "ProjectRoom|useProjectRoom|projectRoomPreview|project:" frontend/src desktop/src` 无残留引用（测试/文档除外）。
- frontend build + 相关 tests 通过。
- RoomWorkspace 仍能打开（它只依赖 `room` API，不依赖 `project`）。

### Slice 1：新 Room host + IPC + preload（已完成，`24f14ed`）

目标：让新 room domain 成为唯一运行时数据源；不再经过旧 `room-engine`。

新增/修改：

- `desktop/src/room/room-host.cjs`（新）：
  - 新 SQLite 目录（如 `<privateRoot>/room/room.sqlite`），打开 `room-db`/repository/read model。
  - 创建 `room-service`，`adapterFactory: createOarRuntimeAdapter`，传 `runtimeWrapperPath`（asar unpack 路径）、`runtimeStateDir`、`env`。
  - `recoverOnOpen: true`、`startupSweep`、app quit `close()`（先 disposeAll 再 sweep）。
- `desktop/src/shell/room-ipc.cjs`（新）：
  - 窄 handler：`listRooms`、`snapshot`、`chatMessages`、`bootstrap`、`chat-create`、`message-submit`、`accept-task`、`stop-reply`、`changed`。
  - 只返回 display-safe DTO；拒绝绝对路径/session ref/PID/token。
- `preload.cjs`：用新 `room` API 替换旧 `room.*`；`onChanged` 用 `room:changed`。
- `main.cjs`：创建 room host、注册 room IPC、quit close；移除旧 room-engine service/IPC 只在新 UI 切换后做。
- 缺失 contract 一起补：
  - `artifacts`（read model + accept/reject/ledger）
  - `filesList/filesRead`（Room workspace 安全只读；不走旧 scheduler claim）
  - `chat_context_revisions`（协作约定真正保存）
  - `skills`（Role/Chat skill bindings）
  - `runtime_events` / trace endpoint（按 runId；授权在 main）
  - `usage/context`（OAR events 的 usage、context；Role/TaskRun/Room 聚合）
  - `write authorization`（Room 级 opt-in）
  - `stop/retry/accept task` 用户命令（commandId 幂等）
  - `mention` 输入能力（composer @ 成员/文件）

验收：

- 新 RoomWorkspace 能用新 IPC 完成：建 Room/Chat、发消息、流式、Task/Report/Review/Attention、文件、artifact、trace。
- `room-engine` 不再被新 UI 调用；旧 IPC/service 在 Slice 4 删除。
- 不向 renderer 下发 workspace 绝对路径、session/native ref、PID、token、tool 原始 activity。

### Slice 2：重写 `useRoomWorkspace` + `RoomWorkspace` 数据层（核心已完成，`5c81260`）

- `useRoomWorkspace.js`（202 行）改为新 read model：`assignments→runs`、`is_controller→is_captain`、`report.run_id`、`attention.options`、`workspace_label/write_authorized`。
- `RoomWorkspace.vue` 保留视觉外壳；重绑 header/角色 chips/timeline/composer/work panel/settings。
- 新增卡片：Captain review、Captain assignment、Task/Run/Report/Artifact、Attention、mention/system。
- Composer：@ 成员/文件、# 任务、附件、reply/root；排队/发送。
- 右栏：文件 / 任务 / 待办 / 产物 / 轨迹。
- 角色设置：`is_captain`、prompt revision、native permission、capabilities、write scopes；删除 checkpointRoles。
- Chat 设置：context revision、skills；删除旧 `sendContext` 伪消息。
- 保留 i18n/视觉 token/响应式/Escape/aria。

验收：

- Electron desktop 模式跑通完整协作：消息、流式、Task/Report、Captain review、Attention、文件/artifact/trace。
- 不出现 checkpoint/gate/seat/round/controller/pending decision 词汇。
- frontend tests + build + build:desktop；desktop 相关测试。

### Slice 3：补 eta 借鉴的 UI 能力（核心已完成，`28a439d`）

- 流式：RuntimeEvent → process box + tool cards + answer；30–60ms 批量；首 token skeleton；重连/interrupted 状态。
- Tool trace：按 command/diff/write/plan/JSON/图片/子步骤渲染；默认折叠；Transcript 抽屉；失败/权限节点。
- TaskRun：日志 + 时间条/瀑布图；LiveRuns；attempt/previous run。
- Context/Usage：Chat header context chip；Session 检查器（prompt/tools/分片/compaction）；Role/TaskRun/Room 三层 token·cost；provider-reported vs estimated。
- Needs you：统一 Attention 面板；内联回答；不自动弹窗；统一 badge。
- Task 板 + Artifact 账本 + Report 卡；Room 级页面。
- 乐观 outbox/held messages/草稿恢复（桌面端优先）。

### Slice 4：删除旧 `room-engine`（已完成）

- 删除 `preload.cjs` 旧 `room.*`、`desktop/src/room-engine/` 全部、`scripts/smoke-room.cjs`、`test/room-engine/`。
- `RoomAssignmentTrace.vue`、`RoomArtifactDiff.vue` 及其测试删除；新 trace/artifact 在 Slice 3 重建。
- `workdir-access.cjs` 移入 `desktop/src/room/`，是新 host 文件读取的唯一共享 helper。
- `local-workspace-agent-invocation` 删除 `project-room`/`room` session policy 分支。
- 仅保留两套数据源之外的共享 CSS 类名（`project-room-*` 仍被团队项目室侧栏和文件抽屉复用）；旧 i18n 字符串暂留，切片 3 会用到 trace/diff 文案。
- 现在只有一套 Room UI、一套数据源、一套状态机。

### Slice 5：硬化（进行中，人工/环境敏感）

- **Electron 43 / Node 24（已完成）**：`electron@43.8.10`（内置 Node 24.22.1），`engines.node >=24`；OAR 在 Electron Node 下可加载，`node:sqlite` 可用。二进制用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js` 下载。
- **启动 smoke（已完成）**：`./node_modules/.bin/electron .` 在 Electron 43 下成功启动 main/GPU/network/renderer，无启动异常；仅做了启动/退出，未做完整交互。
- **真实 Electron 窗口验收（待人工）**：新建 Room → 选目录/角色 → 发消息 → 流式 → create_task/finish_task → Report/验收 → Captain review → Attention → 文件抽屉/trace。
- **Pack（待人工）**：`npm --prefix desktop run pack`。
- **Windows**：PID wrapper/sweep 仅 POSIX；adapter 已在 Windows 跳过 wrapper（不会尝试执行 `.sh`），但硬崩后进程组回收需要单独实现 taskkill/process tree。
- **runtime_events 保留（已完成）**：host 启动时按 30 天 / 每 chat 5000 条裁剪；可在 `runtime-events.prune()` 调整。
- **Trace UI 授权（已完成）**：`teamRoom.runtimeEvents` 由 main 校验 room/chat 归属；payload 经过 `runtime-event-view` allowlist/redaction。新增 trace 字段时必须同步更新 allowlist 测试。
- **非 OAR provider**：Gemini/DeepSeek/Mimo/ZCode/Hermes/WorkBuddy/OpenClaw/OpenCodeReview 目前只支持旧 local-workspace 路径；新 room runtime adapter 只支持 Claude/Codex，单独评估。
- **POC YOLO 复核**：Chat/Task 当前 `bypassPermissions` / `danger-full-access`；Room `write_authorized` 只是 UI/host 标志，尚未接到执行租约。生产前必须重新评估 Chat 只读、Task 写入租约、per-seat 权限。

## 5. 第一刀的具体文件清单（Slice 0）

删除/修改：

```text
frontend/src/components/ProjectRoomStatus.vue
frontend/src/components/ProjectRoomGatePanel.vue
frontend/src/components/ProjectRoomProgress.vue
frontend/src/components/ProjectRoomComposer.vue
frontend/src/components/ProjectRoomTimelineCard.vue
frontend/src/components/ProjectRoomCreateDialog.vue
frontend/src/components/ProjectRoomSeatSettings.vue
frontend/src/components/ProjectRoomOverlay.vue
frontend/src/components/ProjectRoomDrawer.vue
frontend/src/composables/useProjectRoomView.js
frontend/src/composables/useProjectRoom.js
frontend/src/App.vue（旧 controllers/watches/props/imports）
frontend/src/components/WorkspaceSidebar.vue（旧 Project rooms / Legacy / pending decisions）
frontend/src/components/GeneralSettingsPanel.vue（preview 开关）
frontend/src/desktop.js（projectRoom methods）
desktop/src/preload.cjs（projectRoom API）
desktop/src/shell/project-ipc.cjs
desktop/src/project-room/*
desktop/src/workspace/local-workspace-state.cjs（projectRooms/pendingDecisions）
desktop/src/workspace/local-workspace-conversations.cjs（projectId/projectRole 字段）
frontend/src/locales/en.js, zh.js（projectRoom.*）
frontend/src/styles/*（旧 project-room 专用）
frontend/src/__tests__/meldwork/projectRoom*.spec.js
```

保留：`RoomWorkspace`、`RoomFilesDrawer`、`WorkdirTree/FilePreview`、`RoomAssignmentTrace` 视觉、`RoomArtifactDiff` 视觉、`room.*` i18n、通用样式。

## 6. 坑 / 风险

- **read model roles**：snapshot 返回 room 下所有 chat 的 roles；UI 要按当前 chat 过滤，不要误以为 Room 级角色。
- **assignments vs runs**：`read-model.assignments` 是 Captain assignment；执行记录是 `runs`。旧 UI 的 `assignments` 概念必须改名。
- **文件面板**：新 `teamRoom.filesList/filesRead` 按 `roomId` 解析 workspace，只读且不下发绝对路径；旧的 `SCHEDULER_CLAIM_ROOT_INVALID` 路径已删除。
- **写授权**：Room 级 `write_authorized` 开关已接到 host / UI；POC 下运行时仍是 YOLO，生产前需把该开关接到执行租约。
- **usage/context**：usage 事件已持久化到 `runtime_events` 并在 UI 显示 chat context chip / per-run trace；尚无 Role/TaskRun/Room 三层 cost 聚合。
- **artifacts**：read model 已返回 room artifact 账本，UI 已渲染；仍缺 producer/diff/accept 命令。
- **Captain review**：read model 返回 `reviews`，新 UI 已在工作台渲染。
- **旧数据迁移**：本阶段不做；旧数据归档/只读；不要双读双写。
- **Windows**：wrapper/sweep 仅 POSIX；Windows 需另做 taskkill/process tree。
- **POC YOLO**：Chat/Task 全 YOLO 是临时决定，生产前重新评估 handoff 的 Chat 只读/write 租约。

## 7. 验证命令

```bash
cd desktop

# 后端 room 测试（当前 65/65）
node --test test/room/db.test.cjs test/room/repository.test.cjs test/room/timeline.test.cjs \
  test/room/session-store.test.cjs test/room/routing.test.cjs test/room/briefing.test.cjs \
  test/room/effects.test.cjs test/room/engine.test.cjs test/room/dispatcher.test.cjs \
  test/room/mcp-server.test.cjs test/room/mention.test.cjs test/room/read.test.cjs \
  test/room/task-queue.test.cjs test/room/settlement.test.cjs test/room/captain-review.test.cjs \
  test/room/recovery.test.cjs test/room/room-service.test.cjs test/room/runtime-events.test.cjs \
  test/room/runtime-processes.test.cjs test/room/read-model.test.cjs

# OAR service smoke（真实 Claude/Codex）
MELDWORK_USER_DATA=/tmp/meldwork-room-oar node scripts/room-oar-smoke.cjs --run --provider claude
MELDWORK_USER_DATA=/tmp/meldwork-room-oar node scripts/room-oar-smoke.cjs --run --provider codex

# UI 切片后
npm --prefix ../frontend test
npm --prefix ../frontend run build
npm --prefix ../frontend run build:desktop

# 最终集成
npm --prefix desktop test
npm --prefix desktop run pack
```

按仓库规则：全部测试由所有者人工做；不要声称跑过全量。

## 8. 压缩后恢复清单

- [ ] 读本文 + `docs-new2/09-ui-direction.md` + `2026-11-17-meldwork-room-v2-handoff.md`。
- [ ] `git log -16 --oneline` 确认 `28a439d` 及之前 commit；分支 `project-room`。
- [ ] 跑 focused desktop 测试确认 **259/259**（room + shell + security + trace）。
- [x] Slice 0：删除旧 Project Room preview（`dfe4c09`）。
- [x] Slice 1：Room host + IPC + preload（`24f14ed`）。
- [x] Slice 2：RoomWorkspace 新数据层（核心，`5c81260`）。
- [x] Slice 4：删除旧 `room-engine`（`09b3191`）。
- [x] Slice 3：流式/trace/usage/Artifact 账本/乐观 outbox（核心，`28a439d`）。
- [x] Slice 5 环境：Electron 43.8.10 / Node 24.22.1、OAR 加载、sqlite、启动 smoke。
- [ ] 下一步（人工）：**真实 Electron 完整交互验收 + `npm --prefix desktop run pack`**。
- [ ] 后续：Windows 进程树回收、Role/TaskRun/Room cost 聚合、POC YOLO 生产化复核。
- [ ] 不要恢复旧 `project:*` / `room:*` contract；不要双引擎。
