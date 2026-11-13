# 任务单：里程碑 4 项目室存储与 `project:*` 接口

## 目标

实现项目室的数据层与接口层：工作区文件 v4、项目状态文件（模式、写入队列、提交点、上限与压缩、迁移、损坏处理）、模板、给界面的投影、`project:*` IPC 中的项目与配置类方法、主流程群聊、删除流程。检查点引擎在里程碑 5，本里程碑用测试替身代替它。

## 前置条件

- 里程碑 2、3 已验收。
- 已读 `docs/handoff-guide.md`。

## 必读

- `docs/modules/m1-m5-storage-and-interfaces.md`：全文。这是本里程碑的主要依据。
- `docs/modules/m2-checkpoint-engine.md`：第 2 节（实例字段）、第 3 节（状态）、5.4 中租约申请记录的五种状态；只需要知道数据结构，不需要实现转移。
- `docs/modules/m4-m6-versions-and-writes.md`：C（启动顺序）。
- `docs/functional-architecture.md`：M1、A2、A13。
- 现有代码：`desktop/src/workspace/local-workspace-state.cjs`（加载与版本，`:171`、`:224-249`）、`desktop/src/workspace/local-workspace-message-records.cjs`（`emptyState`、`normalizeLoadedGroup`）、`local-workspace.cjs` 中的 `createGroup`、`deleteGroup`、`snapshot`；`desktop/src/shell/delivery-ipc.cjs`（IPC 写法）；`desktop/src/preload.cjs:129-135`、`:231`；`desktop/src/main.cjs:244`、`:446`；`desktop/src/gates/human-gate-store.cjs`（单文件存储的写法）。

## 范围

| 包括 | 不包括 |
| --- | --- |
| 工作区文件 v4 | 检查点的状态转移与副作用执行（里程碑 5） |
| `desktop/src/project-room/` 下的存储、投影、服务、删除 | `decideGate` 的第 3–10 步（里程碑 5） |
| `project:*` 中项目、配置、快照、删除相关的方法 | 流程类方法（`start`、`interject`、`decideGate` 等）只建立接口与输入校验，内部调用一个「引擎未就绪」的占位，返回 `PROJECT_ENGINE_UNAVAILABLE` |
| 功能开关「项目室（预览）」 | 界面（里程碑 6） |
| 通知的合并规则（纯函数） | 实际发送系统通知（里程碑 5） |

## 任务

### 任务 4.1 工作区文件 v4

依据 M1/M5 3.1、3.2。

1. `local-workspace-state.cjs`：加载时接受版本 1–4；把 `projects`（每项 `id`、`name`、`workdir`、`createdAt`、`updatedAt`、可选的 `deleting: { requestedAt, keepChats }`）、群聊的 `projectId`、`projectRole` 加入白名单；写回为版本 4。
2. 第一次以 v4 写入之前，把原文件复制为同目录下的 `meldwork-workspace.v3.backup.json`（已存在则不覆盖）。
3. `local-workspace-message-records.cjs` 的 `emptyState`、`normalizeLoadedGroup`，`createGroup`（接受 `projectId`、`projectRole`），`workspaceSnapshot`，以及 renderer 的 `frontend/src/desktop-snapshot.js`：保留并传递这些字段。
4. 加载时的一致性约束（M1/M5 3.2）：逐条实现，违反时按文档处理（只读打开、去掉悬空的 `projectId` 等），并记录诊断。
5. `deleteGroup`：`projectRole === 'main'` 的群聊拒绝删除（`PROJECT_MAIN_CHAT_UNDELETABLE`），只能随项目室删除。

测试（`desktop/test/workspace/` 下新增或扩展）：v3 文件加载后写回为 v4 并生成备份；v4 字段在加载、保存、快照中完整保留；3.2 的每条约束；主流程群聊不能单独删除。另外用一份**真实的旧工作区文件**（从你自己的开发环境复制，去掉个人内容后放进 `desktop/test/fixtures/`）验证升级后现有群聊、消息、会话完整保留。

### 任务 4.2 项目状态模式

新文件 `desktop/src/project-room/project-state-schema.cjs`：用 zod 定义 M1/M5 第 4 节的完整模式（顶层、`config`、实例、各集合）。实例字段以 M2 第 2 节为准。

- 导出 `parseProjectState(value)`（失败抛 `PROJECT_STATE_INVALID`，附 zod 的错误路径）、`emptyProjectState({ projectId, config })`、`PROJECT_STATE_SCHEMA_VERSION = 1`。
- 长度与数量上限按 M1/M5 第 4 节（侧写 ≤ 16 KiB、角色名 ≤ 40 字等）。
- 测试：每个集合的合法与非法样例；多余字段被拒绝（`strictObject`）。

### 任务 4.3 项目存储与写入队列

新文件 `desktop/src/project-room/project-store.cjs`：

```
class ProjectStore {
  constructor({ projectDir, now, writeFile = atomicWritePrivateFile })
  async load()                → 读 state.json；迁移（4.5）；损坏（4.6）；返回内存副本
  current()                   → 内存副本（只读视图，调用方不得修改）
  enqueue(operation)          → Promise   operation: (state) => { next, control?: boolean }
                                 先进先出，一次一个；按 M1/M5 6.1 的流程：计算 → 校验 → 序列化与大小检查 → 写入 → 替换内存副本
  onCommitted(listener)       → 每次提交后调用 listener({ revision, durable })
}
```

- 提交点语义（M1/M5 6.1 的表）：`phase === 'before-commit'` → 内存不变，Promise 以错误拒绝；`phase === 'after-commit'` → **内存采用新状态**，`durable: false`，然后立即对同一内容重写一次，成功后再以 `durable: true` 通知；重写失败则保持 `durable: false`，并把存储故障记进内存（供里程碑 5 暂停副作用）。
- `revision` 每次提交加 1。
- 大小上限（M1/M5 4.6）：常规 8 MiB、控制类 9 MiB（`control: true` 的操作）。常规操作超限时，先调用一次 4.4 的压缩再重试；仍超限则以控制类写入记录存储故障，并以 `PROJECT_STATE_TOO_LARGE` 拒绝。控制类超过硬上限时，写 `fault.json`，进入只读。
- 运行期间**从不读盘**；内存副本是唯一来源。

测试 `desktop/test/project-room/project-store.test.cjs`（M1/M5 第 11 节「写入队列」「写入的提交点」「上限」）：并发提交 100 个操作按顺序落盘、`revision` 连续；在每一步注入崩溃（替换 `writeFile` 抛出），重启（新建实例 `load()`）后读到旧版本或新版本，没有半份文件；`after-commit` 时内存采用新状态、立即重写、后续写入不会以旧状态覆盖；超限的四种情况。

### 任务 4.4 压缩

在 `project-store.cjs` 中实现 `compact(state)`（纯函数）与 `ProjectStore.compactNow()`，按 M1/M5 4.6 的规则。

测试：压缩后体积减小；**断言 4.6 列出的「从不删除」的每一类记录都完整保留**（构造一个包含所有活动记录的状态，逐类断言）。

### 任务 4.5 迁移

`desktop/src/project-room/project-state-migrations.cjs`：导出一个数组 `MIGRATIONS`，第 i 项把版本 i 迁移到 i + 1。当前版本为 1，数组为空，但 `load()` 的迁移流程要完整实现：迁移前备份为 `state.v<n>.backup.json`；迁移后完整校验；失败只读；高于当前版本只读（M1/M5 6.2）。用一个测试专用的假迁移（版本 0 → 1）覆盖整个流程。

### 任务 4.6 损坏处理

`load()` 中 JSON 无效或模式校验失败：整份只读，原文件复制为 `state.corrupt-<时间>.json`，**不做逐条隔离**（M1/M5 6.3）。测试：截断的 JSON、模式不符的字段。

### 任务 4.7 模板

新文件 `desktop/src/project-room/templates-store.cjs`，文件 `meldwork-private/templates.json`，按 M1/M5 第 5 节。内置的默认 playbook 本里程碑先放一个**最小的占位**（只有一个检查点），完整内容在里程碑 8。测试：保存、新版本、回退、损坏时只读。

### 任务 4.8 投影

新文件 `desktop/src/project-room/project-projection.cjs`，纯函数：

```
sidebarEntry(projectRecord, state)       M1/M5 7.1 第一行
pendingDecisions(allProjects)            7.1 第二行：最多 100 条，按等待时长排序，附总数
projectSnapshot(projectRecord, state)    7.1 第三行
```

测试：**穷举断言** M1/M5 7.2 列出的内容一律不出现：构造一个所有字段都有值的状态（包括会话号、可执行路径样式的字符串、提示词、完整命令行），对投影的全部输出做字符串搜索，断言这些值都不在其中；残留进程只给出程序名。

### 任务 4.9 项目服务与主流程群聊

新文件 `desktop/src/project-room/project-service.cjs`：组合工作区、`ProjectStore`、`ShadowRepo`（里程碑 3）、调度器（里程碑 2），提供项目级操作。

- `create(...)`：按 M1/M5 8.2「`create`」的顺序：项目状态文件 → 影子仓库初始化（`ShadowRepo.create`）→ 工作区文件（项目与主流程群聊，同一次写入）。中途失败按相反顺序清理。创建前：`checkGitVersion`、`resolveRoot`（大小写探测）、扫描嵌套仓库（M4/M6 B2）、目录判重。
- `rename`、配置类方法：见 4.11 的表。
- 启动时：加载所有项目；对每个项目 `scheduler.holdRoot(workdir)`（里程碑 2 的启动顺序第 2 步已经为它留好了位置）；本里程碑还没有引擎，加载完成后直接 `openRoot`（里程碑 5 改为在恢复屏障之后）。

### 任务 4.10 删除流程（测试替身）

新文件 `desktop/src/project-room/project-deletion.cjs`，按 M1/M5 第 9 节实现阶段、排空检查、`DRAIN_CHECK`、9.2 的接口限制、9.3 的恢复。

它依赖三样东西，全部通过构造参数注入，本里程碑用**测试替身**：

| 依赖 | 接口 | 本里程碑的替身 |
| --- | --- | --- |
| 引擎 | `beginDraining(state) → next`（纪元加 1、产生取消与租约放弃的副作用）、`isDrained(state) → boolean` | 一个按脚本返回结果的假对象 |
| 副作用执行器 | `isIdle(projectId)`、`onIdle(projectId, cb)` | 可以按脚本保持「忙」或变为空闲的假对象 |
| 项目内群聊的调用 | `activeInvocations(projectId)`、`onInvocationEnded(projectId, cb)`、`cancelAll(projectId)` | 可以按脚本结束调用的假对象 |

调度器用里程碑 2 的真实实现（检查 `snapshot()` 中三种持有者都已没有属于该项目的申请）。

测试（M1/M5 第 11 节「删除」中本层的部分）：每两步之间注入崩溃，重启后完成删除并沿用 `keepChats`；替身执行器保持「忙」时不进入 `drained`；只剩一个替身群聊调用、它结束后没有任何其他事件，断言 `DRAIN_CHECK` 被投递、删除自动完成；去掉这个触发点，30 秒兜底仍能完成（用可注入的定时器）；删除 `state.json` 之后、删除 `shadow.git` 途中崩溃，重启后继续删除整个目录；目录删除失败保持 `deleting`、`retryDeletion` 完成；删除期间只有 `snapshot`、`diagnostics`、`residual`、`retryDeletion` 被允许。

### 任务 4.11 `project:*` IPC

新文件 `desktop/src/shell/project-ipc.cjs`，写法参照 `delivery-ipc.cjs`；在 `main.cjs` 中注册（`registerTrustedHandle`）；`preload.cjs` 新增冻结的 `projectRoom` 命名空间与 `onChanged(listener)`（监听 `project:changed`，写法参照 `local-workspace:changed`，`preload.cjs:92`）。

本里程碑实现的方法（M1/M5 8.2）：`chooseWorkdir`、`create`、`rename`、`delete`、`retryDeletion`、`snapshot`、`updateSeat`、`addSeat`、`removeSeat`、`updateProfile`、`rollbackProfile`、`updatePlaybook`、`saveAsTemplate`、`compact`、`diagnostics`。

本里程碑只建立接口与输入校验、内部返回 `PROJECT_ENGINE_UNAVAILABLE` 的方法：`start`、`interject`、`stopAndDeliver`、`decideGate`、`previewReject`、`previewReopen`、`reopen`、`resolveDrift`、`cancelDriftResolution`、`resolveOutOfScope`、`retryEffect`、`residual`、`unlockDirectory`。`decideGate` 本里程碑实现 M1/M5 第 10 节的第 1–2 步（输入模式、项目状态），之后返回 `PROJECT_ENGINE_UNAVAILABLE`。

共同规则（M1/M5 8.1）：每个方法一个 zod `strictObject`；renderer 不提交路径；自由文本经 `redactSecrets`；`chooseWorkdir` 用 `dialog.showOpenDialog`，令牌在内存中，有效 10 分钟、只能用一次。

推送：`ProjectStore.onCommitted` 触发 `project:changed { projectId, revision }`，每个项目最多 10 次/秒（合并相邻的变化）；侧边栏条目与「待我决定」放进现有的工作区快照。

测试 `desktop/test/project-room/project-ipc.test.cjs`：每个方法的多余字段、超长文本、非法 id 被拒绝；不存在接受路径的方法（用代码检查断言没有任何方法的模式包含路径字段）；令牌过期与重复使用被拒绝；含已知密钥的文本被替换后存储；`decideGate` 第 1–2 步的失败用例。安全测试 `desktop/test/security/preload-security.test.cjs` 若有对暴露方法的清单断言，按新增的 `projectRoom` 更新。

### 任务 4.11b 时间线消息的存储字段

依据 M1/M5 4.5 与 M13 5.11：在 `local-workspace-conversations.cjs` 的 `addMessage`（写入）与 `local-workspace-message-records.cjs` 的 `normalizeLoadedMessage`（加载）两处，把 `metadata.projectRoom` 加入白名单，存为消息的顶层字段 `projectRoom`，`user` 与 `agent` 两种角色都支持，字段按 M13 5.11 的表格逐个校验。测试：两种角色的消息写入后再加载，`projectRoom` 完整保留；非法字段被丢弃；没有 `projectRoom` 的现有消息不受影响。

同时实现 M1/M5 4.5 的私有正文暂存、历史记录存储，以及仅 main 可用的稳定 id／原始时间消息插入接口：按群聊串行、确认持久化才算去重成功，同 id 内容不符报存储故障。实现 `timelineHistory` 的分页、投影过滤和绑定项目的不透明游标校验；服务合并未归档的已提交历史。补全 `projectBlockedOn`、`chatWriteChecks`、`maintenanceLeaseRequests` 权威模式及保留规则，`retryEffect` 的 `checkpointId` 可选并限定查找集合。测试覆盖写入后消费前崩溃重放不重复、正文不进状态文件、历史不随状态压缩删除、游标不能跨项目读数据。

### 任务 4.12 功能开关与通知合并

1. 功能开关：在现有的应用偏好中新增 `projectRoomPreview`（默认 `false`）。关闭时，`project:*` 中除 `snapshot` 外的方法都返回 `PROJECT_ROOM_DISABLED`，侧边栏投影不包含项目室。如果找不到合适的现有偏好存储位置，停下来问。
2. 通知合并：新文件 `desktop/src/project-room/notification-coalescer.cjs`，纯函数，按 M1/M5 第 10 节「通知」：输入新旧投影与时间，输出应发出的通知（30 秒合并、正在查看时不发、内容只含项目室名、检查点名与原因的本地化键）。测试覆盖每条规则。实际发送在里程碑 5。

## 验收

**本里程碑运行的测试**：任务 4.1–4.12 的全部测试；`npm --prefix desktop test` 全部通过。

**推迟到里程碑 5 的测试**：`decideGate` 第 3–10 步；删除时与真实检查点副作用、真实租约申请、真实项目内群聊调用的交互；通知的实际发送。

**人工检查**：打开功能开关后，在开发者控制台中调用 `window.meldworkDesktop.projectRoom.chooseWorkdir()`、`create(...)`、`snapshot(...)`、`delete(...)`，确认项目室与主流程群聊被创建、出现在工作区快照中、能被删除，删除后 `meldwork-private/projects/<id>/` 不存在，工作目录中的文件不变。用一份 v3 工作区文件启动，确认升级后现有群聊完整、备份存在。

需求追踪：R16、R17、R19、R23。

## 停下来问的情况（除交接手册第 5 节之外）

- 现有的工作区加载或保存测试因 v4 的改动失败，且失败不只是版本号的断言。
- 找不到放置功能开关的现有偏好存储。
- `createGroup` 的现有校验阻止创建带 `projectId` 的群聊，需要修改校验规则。
