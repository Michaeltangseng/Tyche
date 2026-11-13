# 模块文档：M1 项目室存储、M5 关卡接口

定稿（第六版），2026-11-13，用户裁决定稿（第六版未再经独立评审；r23 的修改范围限于新增 `DRAIN_CHECK` 事件）。后续修改按新一轮评审处理。第六版吸收评审 r23（`docs/reviews/architecture-v5/r23-review.md`）：新增幂等的排空检查事件 `DRAIN_CHECK`，在项目队列之外的收尾（群聊调用结束、残留占用解除等）完成时投递，并有定时兜底。第五版吸收评审 r22（`docs/reviews/architecture-v5/r22-review.md`）：排空时项目内群聊的调用经它们自己的生命周期取消与等待，对账只处理项目状态管理的持有者。第四版吸收评审 r21（`docs/reviews/architecture-v5/r21-review.md`）：排空时保留尚未执行的租约通知，进入 `drained` 前对账调度器；新增 `retryDeletion`。第三版吸收评审 r20（`docs/reviews/architecture-v5/r20-review.md`）：删除改为分阶段的短事务，排空期间照常处理收尾事件与清理；删除期间保留进度、诊断与残留处理入口；恢复时以项目目录确实不存在为准。第二版吸收评审 r19（`docs/reviews/architecture-v5/r19-review.md`）：写入的提交点为改名，区分提交前失败、提交后持久性不确定与通知失败；删除前建立项目删除屏障；删除选项与标记一同落盘；状态文件为控制记录预留空间并提供压缩；补充取消漂移恢复的接口。

依据：`docs/product-target.md`（R6、R14、R16、R17、R19、R23、R28、R29）、`docs/functional-architecture.md` 第二十三版（决定 A2、A6、A11、A13）、`docs/modules/m2-checkpoint-engine.md` 第九版、`docs/modules/m4-m6-versions-and-writes.md` 定稿、`docs/modules/m3-seat-invocation.md` 定稿、`docs/modules/m13-interaction-experience.md` 第十二版。

前面几份模块文档在「项目状态文件」里放进了许多字段：检查点实例、关卡、副作用、租约申请、未解决漂移、越界条目、调用时间窗、占位清单、本地指标。本文把它们收拢成**一个**权威的数据模型，规定它怎样落盘、怎样迁移、怎样投影给界面，并定义 renderer 能调用的全部 `project:*` 接口与它们的校验。关卡的逻辑在 M2、交互在 M13，M5 在这里只剩接口、校验与通知。

## 1. 范围

| 本文负责 | 不负责 |
| --- | --- |
| 工作区文件中与项目室有关的字段（v4） | 状态转移规则（M2） |
| 项目状态文件的完整模式、上限、写入队列、迁移、损坏处理 | 影子仓库与租约（M4/M6） |
| 席位、侧写、playbook、模板的存储与版本 | 进程登记表与审计记录的内容（M3、M4/M6 C 第 6 步，本文只登记位置） |
| 给 renderer 的投影：侧边栏、项目快照、「待我决定」 | 工作目录浏览与轨迹通道 `workdir:*`、`trace:*`（M7/M8） |
| `project:*` IPC：方法、输入模式、校验、错误 | 界面与文案（M13、M12） |
| 关卡决定的接口与校验顺序、系统通知（M5） | |
| 项目室的删除 | |

## 2. 现状

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| 私有文件统一经 `atomicWritePrivateFile` 写入：临时文件、`fsync`、改名、目录 `fsync`，权限 `0600` | `desktop/src/security/private-file.cjs:22-47` | 项目状态文件沿用 |
| Human Gate 存储：单文件、版本号、数量上限、读不出的记录逐条隔离到 `.quarantine.json` | `desktop/src/gates/human-gate-store.cjs:17-19`、`:69-100` | 沿用单文件与版本号；**不沿用逐条隔离**，见 6.3 |
| 工作区文件加载只接受版本 1–3，按白名单重建字段，写回为版本 3 | `desktop/src/workspace/local-workspace-state.cjs:171`、`:224-249` | 升级到 4 的影响见 3.1 |
| 每次变化都把完整的工作区快照推给 renderer | `desktop/src/main.cjs:446` | 项目状态不能这样推送，见第 7 节 |
| IPC 经 `registerTrustedHandle` 注册：校验来源是受信任的本地页面、关机中拒绝 | `desktop/src/main.cjs:244-250` | `project:*` 沿用 |
| IPC 输入用 zod `strictObject` 校验，失败抛出统一错误码 | `desktop/src/shell/delivery-ipc.cjs:5-10` | 沿用 |
| preload 以冻结对象暴露方法，每个方法只是 `ipcRenderer.invoke` | `desktop/src/preload.cjs:129-135`、`:231` | `projectRoom` 命名空间沿用 |

## 3. 存储布局

```
<用户数据目录>/
  meldwork-workspace.json                  工作区文件（v4）：项目列表、群聊的项目归属
  meldwork-workspace.v3.backup.json        首次写入 v4 前对 v3 的备份（3.1）
  meldwork-private/
    projects/<projectId>/
      state.json                           项目状态文件（第 4 节），唯一权威
      state.v<n>.backup.json               迁移前的备份（第 6 节）
      state.corrupt-<时间>.json            读不出的原文件副本（6.3）
      shadow.git/                          影子仓库（M4/M6 B）
    traces/<runId>/<agentRunId>.jsonl      完整轨迹（M7）
    templates.json                         playbook 与席位模板（第 5 节）
    process-registry.json                  进程登记表（M3 3.7）
    audit.jsonl                            应用级审计记录（M4/M6 C 第 6 步）
```

与架构文档原写法的差异：项目状态文件由 `meldwork-private/projects/<projectId>.json` 改为 `meldwork-private/projects/<projectId>/state.json`，与同一项目的影子仓库放在同一个目录下，删除项目室时整个目录一起删除。

### 3.1 工作区文件 v4

新增的字段：

| 位置 | 字段 | 说明 |
| --- | --- | --- |
| 顶层 | `projects: [{ id, name, workdir, createdAt, updatedAt, deleting? }]` | 只放侧边栏需要的轻量信息（架构 A2）。`workdir` 为创建时解析的真实路径。`deleting: { requestedAt, keepChats }`：删除请求连同它的选项一起落盘，见第 9 节 |
| 群聊 | `projectId?` | 群聊所属的项目室 |
| 群聊 | `projectRole?: 'main'` | 主流程群聊（A13）；每个项目室恰好一个 |

修改：`local-workspace-state.cjs` 的加载路径接受版本 1–4，并把上面的字段加入白名单；`local-workspace-message-records.cjs` 的 `emptyState`、`normalizeLoadedGroup`；`createGroup`；`workspaceSnapshot`；renderer 的 `desktop-snapshot.js`。

**降级**：旧版本的应用只接受 1–3，读到 v4 会拒绝加载。这比「不升版本号」安全：如果保持版本 3，旧版本会按白名单把 `projects`、`projectId` 静默丢掉再写回，项目室就失去了宿主群聊。所以：

- 版本号升到 4；
- 第一次以 v4 写入之前，把原文件复制为 `meldwork-workspace.v3.backup.json`；
- 不支持降级。发布说明写明：降级前请先恢复这份备份，项目室在旧版本中不可用。

### 3.2 一致性约束（加载时校验）

- 每个项目室恰好一个 `projectRole: 'main'` 的群聊，且它的 `projectId` 指向这个项目室。缺失或多于一个时，项目室只读打开并说明原因，不自动修复。
- `projectId` 指向不存在的项目室的群聊：去掉 `projectId`，变为普通群聊，并记录诊断。
- 两个项目室的 `workdir` 相同或互相包含：后创建的只读打开。正常情况下创建时已判重（8.1），这里只防外部修改。
- 工作区文件中有项目、但 `meldwork-private/projects/<id>/state.json` 不存在：项目室只读打开，说明「项目状态丢失」。

## 4. 项目状态文件

### 4.1 顶层

```
{
  schemaVersion: 1,
  projectId,
  revision,            每次落盘加 1，单调递增；用于界面判断快照是否过期
  config: { ... },     4.2：席位、playbook 实例、项目设置
  instances: [ ... ],  4.3：检查点实例
  driftItems: [ ... ], M2 8.2
  outOfScopeItems: [ ... ], M6
  callWindows: [ ... ],     M4/M6 A6 的归属依据
  placeholders: [ ... ],    M4/M6 B3.5
  metrics: { ... },    M13 第 9 节
  preferences: { ... } 界面偏好（M13：抽屉宽度、标签、「同时提交到 git」的上次选择）
}
```

所有字段用一套 zod 模式定义（`desktop/src/project-room/project-state-schema.cjs`），加载与每次写入前都整体校验。模式以本文为准，其他模块文档中列出的字段是它的子集。

### 4.2 `config`

| 记录 | 字段 | 说明 |
| --- | --- | --- |
| `seats[]` | `id`、`roleName`（≤ 40 字）、`duty`（≤ 200 字）、`agentKind`、`capabilities`（`read`、`read-exec`、`write-drafts`、`write-workdir` 的子集）、`checkpointRoles`（在哪些检查点做主笔、评审、草稿）、`profileVersionId` | 席位 |
| `profiles[]` | `id`、`seatId`、`version`、`text`（≤ 16 KiB）、`createdAt`、`source`（默认 / 用户编辑 / 复盘采纳 / 回退） | 侧写的全部版本。席位只引用当前版本；回退即把 `profileVersionId` 指回旧版本，并新增一条 `source: 回退` 的记录。更换 `agentKind` 不改侧写（R16） |
| `playbook` | `templateId`、`templateVersion`、`checkpointDefs[]`（M1 架构表中的 `CheckpointDef` 字段）、`roundLimit`（默认 3）、`continuationLimit` | 项目使用的 playbook 实例；创建时从模板复制，之后独立修改 |
| `settings` | `docsRoot`（默认 `meldwork/`）、`language`、快照上限（M4/M6 B3.4）、自动排除的嵌套仓库列表 | 项目设置 |
| `configRevision` | 整数 | 配置每改一次加 1。席位与 playbook 的修改在**下一次调用**时生效（R16），调用记录它使用的 `configRevision` |

### 4.3 检查点实例

字段以 M2 第 2 节为准，这里补充存储层面的规则：

| 字段 | 存储规则 |
| --- | --- |
| `rounds[]` | 只保留最近 20 轮的详细记录；更早的折叠为一条摘要（轮次范围、结论计数）。评审文件本身在工作目录与影子仓库中，不受影响 |
| `effects[]` | 未消费的全部保留；已消费的只保留最近 200 条，供诊断 |
| `leaseRequests[]` | 「已撤回」「已释放」的记录保留 24 小时后删除 |
| `gate` | 当前待决关卡。已决定的关卡移入 `decisions`，只保留最近 200 条的索引（id、时间、走向、原因）；完整内容在 `decisions.md` |
| `activeInvocations` | 只保存 M2 规定的字段；不保存提示词、输出或会话号 |

### 4.4 其他集合

| 集合 | 上限与清理 |
| --- | --- |
| `driftItems` | 已解决、已作废的保留 30 天 |
| `outOfScopeItems` | 已处理的保留 30 天 |
| `callWindows` | 对应关卡决定后删除（越界归属只在关卡上使用） |
| `placeholders` | 每次快照整体重写（M4/M6 B3.5） |
| `metrics` | 每个关卡一条（决定用时、走向、原因、是否在评审通过后人工要求修改），保留全部；超过 5,000 条时按月聚合最旧的部分 |

### 4.5 不放进项目状态文件的内容

- 提示词、Agent 输出、轨迹：在 Run Ledger、消息存储与 `traces/`（M7）。
- 会话号：在工作区文件的 `sessions`（M3 4.2）。
- 文件内容：在工作目录与影子仓库。
- 凭据与任何密钥：永不进入。写入前对所有自由文本字段（插话、关卡意见、侧写、席位职责）执行现有的 `redactSecrets`：已知的密钥值被替换，而不是拒绝整次写入。

### 4.6 大小上限与压缩

两级上限：

| 上限 | 值 | 适用的写入 |
| --- | --- | --- |
| 常规上限 | 8 MiB | 所有常规转移 |
| 硬上限 | 9 MiB | 只有**控制类写入**可以使用常规上限与硬上限之间的 1 MiB：记录 `blockedOn` 与存储故障、取消调用、租约的撤回与释放、删除屏障（第 9 节）。这些写入让项目能够停下来、交还写入权，不能因为空间不足而写不进去 |

写入前序列化后：

1. 不超过常规上限：照常写入。
2. 常规转移超过常规上限：先自动执行一次**压缩**（见下），再重试一次。仍超过时，这次转移不写入，以一次控制类写入记下存储故障（`blockedOn`，原因为「项目状态超出上限」），项目暂停；错误条提供「压缩项目状态」与「导出诊断」。
3. 控制类写入超过硬上限（按 4.3、4.4 的清理规则不应发生）：不写入，项目进入只读，在内存中保持暂停，并在 `meldwork-private/projects/<projectId>/fault.json`（一个很小的独立文件）记下故障，重启后据此仍保持只读；目录保持写入保护。

**压缩**（`project:compact`，也在上面第 2 步自动执行一次）按更严格的保留规则重写状态：评审轮次只留最近 5 轮的详细记录；已消费的副作用只留最近 20 条；已决定关卡的索引只留最近 50 条；指标按月聚合除最近 30 天外的全部；已解决的漂移、已处理的越界、已撤回与已释放的租约申请全部删除。压缩**从不删除**：未消费的副作用、待决关卡、未结束（等待中、已获批、待释放）的租约申请、未解决的漂移与越界条目、活动调用、配置与侧写的当前版本。完整的决策与评审内容在 `decisions.md` 与工作目录中，不受影响。压缩是一次常规转移，在项目队列中执行。

## 5. 模板与版本（R17、R29）

`meldwork-private/templates.json`，应用级，原子写入、`0600`：

- `playbookTemplates[]`：`id`、`version`、`name`、`checkpointDefs[]`、`seatTemplates[]`（角色名、职责、默认 Agent 建议、默认能力、默认侧写文本）、`createdAt`、`source`（内置 / 用户保存 / 复盘采纳）。
- 内置的默认 playbook 不写进这个文件，随应用代码提供（架构 M1），版本随应用版本。用户「另存为模板」时复制一份写入。
- 模板的每次修改都形成新版本，旧版本保留，可以回退；项目只记录它创建时复制的 `templateId` 与 `templateVersion`，之后与模板互不影响。
- 复盘采纳的建议（M13 5.9）生成项目内 playbook 或侧写的新版本；用户可以选择「同时更新模板」，那是模板的又一个新版本。

## 6. 写入、迁移与损坏

### 6.1 写入队列

- 每个项目在 main 中有一份**内存中的权威副本**，加载时读一次，之后只在内存中修改、整体写回；运行期间从不「读盘—修改—写盘」。
- 每个项目一个先进先出的异步队列（架构 M1）。所有会改变项目状态的操作，包括 M2 的每次转移与副作用结果的消费、IPC 发起的配置修改、M3 上报的进程标识，都排进这个队列，一次一个：计算新状态 → 模式校验 → 序列化与大小检查 → `atomicWritePrivateFile` → 替换内存副本 → 通知界面（第 7 节）。
- **提交点是改名。** 现有 `atomicWritePrivateFile` 的顺序是：写临时文件并 `fsync` → 改名 → 对目录 `fsync`（`desktop/src/security/private-file.cjs:30-46`）。改名之后，磁盘上已经是新内容；之后的目录 `fsync` 仍可能失败并抛错。所以写入结果分三种，处理不同：

| 结果 | 含义 | 处理 |
| --- | --- | --- |
| 改名之前失败（模式校验、超限、写临时文件或其 `fsync` 失败、改名失败） | 磁盘仍是旧内容 | 内存副本不变，这次操作视为没有发生，错误交给调用方：M2 的副作用按 9.2 处理，IPC 返回错误码 |
| 改名成功，之后的目录 `fsync` 失败 | 新内容已在磁盘上，但断电后可能退回旧内容（持久性不确定） | **内存副本采用新状态**，不能当作没有发生，否则下一次写入会以旧状态覆盖已经落盘的转移。同时，这次转移产生的副作用**暂停执行**，项目标为「存储持久性不确定」：队列对同一内容重写一次（同样的临时文件、改名、目录 `fsync`），成功后才继续执行副作用；失败则按 M2 9.2 暂停，错误条写明。副作用必须等持久化确认后才执行，原因是像租约释放这样的副作用会对外产生效果（调度器把作用域授予下一位），如果此后断电、文件退回旧内容，就会违反 M2 5.4 的「状态先落盘」 |
| 落盘成功，通知界面失败 | 已提交 | 视为已提交；界面通知是尽力而为，renderer 下一次拉取快照时自然得到新状态 |

  为此，`atomicWritePrivateFile` 抛出的错误带上阶段：`phase: 'before-commit'` 或 `phase: 'after-commit'`。这是对现有函数的小改动，现有调用方不读这个字段，行为不变；需要加故障注入测试。
- 不同项目的队列互不等待。
- 队列中的每个操作都是短事务：计算、校验、落盘，然后让出队列。任何需要「等待某件事发生」的流程（例如删除的排空，第 9 节），都表示为一个状态加上之后的若干次转移，而不是在队列里阻塞等待；否则它所等待的事件也排在同一个队列里，永远轮不到。

### 6.2 迁移

- `schemaVersion` 从 1 开始。每次修改模式就新增一个纯函数 `migrate_<n>_to_<n+1>(state)`，加载时依次执行。
- 迁移前把原文件复制为 `state.v<n>.backup.json`；迁移后的状态通过完整模式校验，才写回并成为内存副本。
- 迁移失败：项目室只读打开，原文件不动，界面说明原因（M4/M6 C 第 6 步：目录保持写入保护）。
- 遇到**高于**当前应用的 `schemaVersion`（用户降级了应用）：只读打开，说明「这个项目室由更新版本的 Meldwork 创建」，不写入。

### 6.3 损坏

项目状态文件读不出、JSON 无效或模式校验失败时：

- **整份只读**，不做逐条隔离。Human Gate 存储可以丢弃单条坏记录，是因为每条关卡相互独立；项目状态的各部分彼此引用（实例引用租约申请、漂移条目引用实例与版本、发件箱引用实例的纪元），丢掉一部分会让状态机在不一致的状态上继续运行，比停下来更危险。
- 原文件复制为 `state.corrupt-<时间>.json` 保留；项目室只读打开，目录保持写入保护（M4/M6 C 第 6 步），界面提供「从备份恢复」（若有 `state.v<n>.backup.json`）与 M4/M6 C 第 6 步的「解除这个目录的写入保护」。

## 7. 给界面的投影

renderer 永远只拿到投影，不拿到项目状态文件本身。投影函数在 main 中，纯函数，单独测试（`desktop/src/project-room/project-projection.cjs`）。

### 7.1 三种投影

| 投影 | 内容 | 送达方式 |
| --- | --- | --- |
| 侧边栏条目（随工作区快照） | 项目 id、名称、工作目录的显示名（最后一级目录名）、是否只读、是否正在删除及所处阶段（9.2）、待决关卡数、未解决漂移数、残留占用数 | 放进现有的工作区快照（`main.cjs:446` 的推送），体积很小 |
| 「待我决定」（随工作区快照） | 跨项目的待决条目列表：类型（关卡 / 漂移 / 残留进程 / 暂停）、项目、检查点、原因、等待时长；最多 100 条，按等待时长排序，附总数 | 同上 |
| 项目快照 | 一个项目的完整可见状态：进度（实例的状态、轮次、主笔、等待对象）、当前关卡的首屏内容（M13 第 4 节，按预算组装）、漂移与越界条目、错误条、配置（席位、侧写当前版本、playbook）、`revision` | 推送 `project:changed { projectId, revision }`（每个项目最多 10 次/秒，合并相邻的变化）；renderer 收到后调用 `project:snapshot` 拉取。只在用户打开这个项目室时拉取 |

### 7.2 投影中不出现的内容

- 可执行文件路径、会话号、提示词、Context Pack 内容、进程的完整命令行。
- M13 5.7 要列出残留进程时，投影只给出：进程 id、启动时间、Agent 种类（来自登记表）、程序名（命令行第一个词的最后一级名称）、是否带有本容器标记。完整命令行可能含有可执行路径与参数，不送往 renderer（`AGENTS.md`：轨迹显示以外，renderer 不接收可执行文件路径）。
- 工作目录的完整路径只在项目设置页显示，经 `project:snapshot` 的 `config` 部分提供。它是用户自己选择的目录，与架构第 6 节「工作目录本来就是用户选定的、界面可见的路径」一致。

## 8. `project:*` 接口

### 8.1 共同规则

- 全部经 `registerTrustedHandle` 注册（`desktop/src/shell/project-ipc.cjs`），preload 暴露为冻结的 `meldworkDesktop.projectRoom.*`。
- 每个方法的输入是一个 zod `strictObject`，多余字段即拒绝。通用类型：
  - `id`：`/^[A-Za-z0-9._:-]{1,120}$/`
  - 自由文本：去掉首尾空白、不含 NUL，长度上限见各方法；写入前执行 `redactSecrets`（4.5）。
  - 修订号与版本：非负整数。
- **renderer 从不提交文件系统路径。** 工作目录只能经 main 的系统对话框选择（8.2 `chooseWorkdir`），renderer 拿到的是一个一次性的选择令牌。
- 会改变状态的方法都排进项目队列（6.1），返回 `{ ok: true, revision }` 或抛出带错误码的错误；错误码有中英文案（M13）。
- 方法不接受「下一步做什么」的指令，只接受人的意图；状态如何变化由 M2 的转移函数决定。renderer 无法让检查点跳过任何状态。

### 8.2 方法

**项目室**

| 方法 | 输入 | 校验与行为 |
| --- | --- | --- |
| `chooseWorkdir()` | — | main 打开系统的目录选择框；返回 `{ token, displayName, existingProjectId? }`。令牌有效 10 分钟、只能用一次。所选目录（真实路径）与已有项目室相同或互相包含时，返回 `existingProjectId`，界面直接打开它（M13 5.1） |
| `create({ token, name, templateId?, seats, playbookOverrides? })` | `name` ≤ 80 字 | 令牌有效且未用过；再次检查目录判重；检查 git 版本（M4/M6 B1）；探测大小写（M4/M6 A2.2）；扫描嵌套仓库（M4/M6 B2）。按顺序写入：项目状态文件 → 影子仓库初始化 → 工作区文件（项目与主流程群聊，同一次写入）。中途失败按相反顺序清理 |
| `rename({ projectId, name })` | | 只改工作区文件 |
| `delete({ projectId, keepChats })` | `keepChats`：项目内群聊变为普通群聊或一并删除 | 第 9 节 |
| `retryDeletion({ projectId })` | | 只在删除期间有效，9.2 |
| `snapshot({ projectId })` | | 返回 7.1 的项目快照 |

**配置**

| 方法 | 输入 | 校验与行为 |
| --- | --- | --- |
| `updateSeat({ projectId, seat, configRevision })` | 席位字段（4.2） | `configRevision` 与当前一致，否则 `PROJECT_CONFIG_STALE`；`agentKind` 已安装；能力组合经 M3 第 10 节的能力登记校验，不能表达的组合拒绝并返回原因（R16，不静默降级）；主笔与评审同种 Agent 时返回警告，不拒绝 |
| `addSeat`、`removeSeat` | 同上 | 移除仍被检查点引用、或正有调用在运行的席位时拒绝 |
| `updateProfile({ projectId, seatId, text, configRevision })` | `text` ≤ 16 KiB | 新增一个侧写版本 |
| `rollbackProfile({ projectId, seatId, profileId, configRevision })` | | 4.2 的回退 |
| `updatePlaybook({ projectId, patch, configRevision })` | 软硬关卡、轮数上限、续跑上限 | 只允许修改尚未开始的检查点的定义；已开始的检查点，修改在它下一次进入 `checking` 时生效 |
| `saveAsTemplate({ projectId, name })` | | 第 5 节 |

**流程**

| 方法 | 输入 | 校验与行为 |
| --- | --- | --- |
| `start({ projectId, brief })` | `brief` ≤ 32 KiB | 只在项目尚未开始时有效；作为第一个检查点（访谈）的输入（M13 5.1） |
| `interject({ projectId, checkpointId, purpose, text })` | `purpose`：`interjection` | M13 第 6 节的目标与用途；用途与当前状态不符即拒绝（`PROJECT_TARGET_CHANGED`），文字由 renderer 保留 |
| `stopAndDeliver({ projectId, checkpointId })` | | M2 第 7 节 |
| `decideGate({ projectId, gateId, gateRevision, candidateCommit?, outcome, comment?, upstreamCheckpointId?, impactHash?, driftChoice?, commitToGit? })` | `comment` ≤ 32 KiB | 第 10 节 |
| `previewReject({ projectId, checkpointId, upstreamId })` | | 返回影响范围与 `impactHash`（M2 6.2） |
| `previewReopen({ projectId, checkpointId })`、`reopen({ projectId, checkpointId, reason, impactHash })` | `reason` 必填，≤ 32 KiB | M2 6.3 |
| `resolveDrift({ projectId, items: [{ itemId, revision }], choice })` | `choice`：`workdir` / `accepted`；最多 200 项 | M2 8.2 |
| `cancelDriftResolution({ projectId, itemId, revision })` | | 取消一条正在进行的「恢复为已接受版本」（M2 8.2、M13 5.8.1）：条目必须处于「处理中」且修订号一致，否则 `PROJECT_DRIFT_STALE`。作为放弃这条恢复链的事件进入项目队列，按 M2 5.4 的「放弃」在同一次转移中持久化撤回（等待中的申请立即撤回，已获批且正在写入的进入「待释放」）；条目回到「未解决」 |
| `compact({ projectId })` | | 4.6 的压缩 |
| `resolveOutOfScope({ projectId, itemIds })` | | 标记已处理（接受即保留改动，M6） |
| `retryEffect({ projectId, checkpointId, effectId })` | | M2 9.2 |
| `residual({ projectId?, residualId, action })` | `action`：`manuallyEnded` / `notRelated` | M3 3.7 第 4 步：平台复核，不发信号 |
| `unlockDirectory({ projectId, folderName })` | `folderName` 必须等于工作目录的最后一级名称 | M4/M6 C 第 6 步：先重新检查残留进程，再写审计记录 |
| `diagnostics({ projectId })` | | 返回错误条与诊断的详细内容（不含 7.2 排除的内容） |

工作目录浏览（`workdir:*`）与轨迹（`trace:*`）的接口在 M7/M8 模块文档中定义。

## 9. 删除项目室

删除涉及工作区文件、项目目录（状态文件、影子仓库）、会话键、轨迹、群聊，以及 main 中可能仍在执行的副作用。要求：中途崩溃不留下半个项目室；不在操作还在进行时撤走它们依赖的数据；也不能让删除流程自己挡住它所等待的收尾。

### 9.1 阶段

项目状态中新增 `deletion: { phase, startedAt }`，`phase` 为 `draining`（排空中）或 `drained`（已排空）。

1. **拒绝条件**：有残留占用未处理时，不开始删除（它代表可能仍在写的进程，先由人处理，M3 3.7）。
2. **落盘删除请求**：在工作区文件中写入 `deleting: { requestedAt, keepChats }`（一次原子写入）。删除选项与标记一起落盘，崩溃后恢复时严格沿用当时的选择。
3. **进入排空**：项目队列中的**一次短转移**（属于 4.6 的控制类写入），然后立即让出队列：
   - 写入 `deletion.phase = 'draining'`；
   - 所有实例的纪元加 1（包括 `accepting` 中的实例：项目正在被删除，不再需要完成接受，所以这里不适用 M2 5.3 对接受事务的例外一）。尚未启动的副作用随之作废（M2 5.3），不会再启动；**但租约的调度器通知（`release-scope`、`withdraw-lease`）与取消调用照常执行**（M2 5.3 例外二）：例如记录已落盘为「已释放」、通知还没执行时开始删除，这条通知仍要执行，否则调度器会一直持有这个作用域；
   - 为所有进行中的检查点调用产生取消副作用，按 M2 5.4 放弃所有检查点与项目维护的持有者：等待中的租约申请立即撤回，已获批、没有写入在进行的释放，有写入在进行的进入「待释放」。
   - **项目内群聊**正在运行或等待租约的调用，同样取消：经现有的停止机制，由**它们自己的调用生命周期**结束进程、等容器清空并释放它们的 `invocation` 租约（M3 3.4）。它们的租约不在项目状态文件里，不经过项目队列，也不由对账撤回（M2 5.3）。在删除开始之后，项目内群聊不能再发起新的可写调用。
4. **排空期间**，项目队列照常运行，但只接受收尾：
   - 照常处理：`INVOCATION_ENDED`、`LEASE_GRANTED`（按 M2 5.4，对已撤回的申请立即释放）、副作用结果的消费、「待释放」改为「已释放」、清理类副作用。
   - 拒绝：一切新业务事件（插话、关卡决定、配置修改、开始、重新打开等），以 `PROJECT_DELETING` 返回。转移函数在 `draining` 中不产生任何非清理类的新副作用。
   - 已经开始执行的副作用（一次 git 命令、一次文件改名、一次用户仓库提交）不被打断，结束后照常消费结果，只是不再引出后续步骤。
   - **排空检查**：每次转移落盘后，以及每次收到 `DRAIN_CHECK` 事件时检查（见下）：没有活动的检查点调用；没有未结束（等待中、已获批、待释放）的租约申请；这个项目的副作用执行器空闲、影子仓库的互斥队列为空；所有受管理容器已清空（M3 3.4）；**项目内群聊的调用都已结束**（它们的调用生命周期已完成，`invocation` 租约已由它们自己释放）。前五项满足后，执行一次**调度器对账**（M2 5.3 的 `reconcile-scheduler`，只处理 `checkpoint-scope` 与 `project-maintenance`），并确认 `scheduler.snapshot()` 中已没有属于这个项目的任何授予与等待申请，三种持有者类型都没有。只看记录不够：通知可能还没执行，或执行失败。全部满足时，再以一次短转移写入 `deletion.phase = 'drained'`。
   - **`DRAIN_CHECK` 事件**：有些收尾不经过项目队列，完成时不会产生项目的转移。最典型的是项目内群聊的调用：它由自己的调用生命周期结束、释放租约（第 3 步）。如果它是最后一项收尾，之后再没有任何项目事件，只靠「每次转移后检查」，删除就会一直停在 `draining`。所以以下时机都向项目队列投递一次 `DRAIN_CHECK`：
     - 这个项目的项目内群聊的一次调用完成：容器已空，`invocation` 租约已释放；
     - 这个项目相关的残留占用被解除（M4/M6 A5）；
     - 这个项目的副作用执行器或影子仓库互斥队列变为空闲；
     - 调用 `retryDeletion`；应用启动时恢复删除（9.3）。
     兜底：处于 `draining` 期间，每 30 秒再投递一次，防止遗漏某个触发点。`DRAIN_CHECK` 只执行上面的检查，条件满足时才写入 `drained`，不满足时什么也不写；重复投递没有副作用。
   - 排空过程中确认不了容器已空的，按 M3 3.7 登记残留占用，删除停在排空阶段，等人处理（9.2）。
5. **删除数据**（`drained` 之后，不再经过项目队列，因为项目已经没有任何活动）：删除轨迹文件、`sessions` 中 `project:<projectId>:` 开头的会话键（架构 M1）、主流程群聊；项目内其他群聊按落盘的 `keepChats` 处理。这些操作都是幂等的：已经不存在的直接跳过。
6. **删除项目目录**：递归删除 `meldwork-private/projects/<projectId>/`（`fs.rmSync(…, { recursive: true, force: true })`），然后**确认这个目录确实不存在**。
7. 确认之后，才从工作区文件中移除这个项目（一次原子写入）。

工作目录中的文件始终不动（架构 M1）。

### 9.2 删除期间的界面与接口

- 侧边栏不隐藏这个项目，而是显示「正在删除」及当前阶段（排空中、删除数据中），点击打开一个只读的进度视图。
- 删除期间，`project:*` 中只允许四类方法，其余一律以 `PROJECT_DELETING` 拒绝（包括再次调用 `delete`）：
  - `snapshot`：返回删除进度（阶段、仍在等待的调用与租约、残留占用）；
  - `diagnostics`；
  - `residual`：人手动结束残留进程后请求复核（M3 3.7 第 4 步）。复核通过、残留占用解除后，排空检查继续。
  - `retryDeletion({ projectId })`：从当前阶段幂等地继续删除，沿用落盘的 `keepChats`，不接受新的选项。用于 9.3 中目录删除失败、用户修复权限之后，不必重启应用。
- 删除一旦开始就不能取消：排空已经取消了所有调用、作废了尚未执行的副作用，项目不再能恢复到删除前的状态。确认弹层写明这一点。

### 9.3 崩溃后的恢复

启动时发现 `deleting` 的项目，在进程登记表恢复（M4/M6 C 第 3 步）之后：

- **项目状态文件可读**，且 `deletion.phase` 为 `draining` 或尚未写入：从第 3 步重新执行。第 3 步是幂等的：已经作废的副作用、已经撤回或释放的申请直接跳过；进程在重启后已由进程登记表处理（M3 3.7）。
- `deletion.phase` 为 `drained`：从第 5 步继续。
- **项目状态文件不存在或读不出**：第 6 步只在 `drained` 之后才开始，所以状态文件不存在通常意味着第 6 步已经开始；读不出则是损坏（6.3）。两种情况下，项目在 main 中都已没有活动；崩溃前的 Agent 进程由进程登记表处理，处理不了的已经登记为残留占用，按真实路径挡住这个目录的写入（M4/M6 A5）。所以直接执行第 5、6 步：**继续递归删除整个项目目录，确认目录不存在**，再执行第 7 步。不能把「状态文件不存在」当作「目录已删完」：递归删除不是原子的，可能先删掉了 `state.json`、在删除 `shadow.git` 的途中崩溃。
- 第 6 步的删除或确认失败（例如权限问题）：保持 `deleting`，界面显示诊断与「重试删除」（调用 `retryDeletion`），不移除工作区中的记录。

## 10. 关卡决定的接口（M5）

`decideGate` 的校验顺序。前面的检查不通过就不做后面的，返回第一个错误：

1. 输入模式校验。
2. 项目存在、未在删除中、未处于只读。
3. 关卡存在、仍待决，`gateRevision` 与当前一致 → 否则 `PROJECT_GATE_STALE`（M2 6.1 第 1 条）。
4. `outcome` 在这个关卡原因下可用（M2 第 6 节表格）→ 否则 `PROJECT_GATE_OUTCOME_UNAVAILABLE`，附不可用的原因。
5. 绑定候选提交的关卡：`candidateCommit` 一致 → 否则 `PROJECT_GATE_STALE`。
6. `continue` 需要非空 `comment`（「以当前文件重新送审」例外，M2 6.1）→ 否则 `PROJECT_GATE_COMMENT_REQUIRED`。
7. `reject-upstream`：`upstreamCheckpointId` 确实是上游；`impactHash` 与重新计算的一致 → 否则 `PROJECT_IMPACT_CHANGED`。
8. `accept`：读取过的上游没有待决的「文档新版本」关卡与未解决漂移 → 否则 `PROJECT_ACCEPT_BLOCKED`，附阻挡项；工作目录不等于候选提交且请求中没有选定「接受送审版本」或「重新送审」→ 返回 `PROJECT_CANDIDATE_DIVERGED` 与差异，让人选择（M2 6.1 第 4 条）。
9. `commitToGit`：按 M4/M6 B7 的前置条件预检；不满足时整次决定**仍然可以提交**，只是不提交到用户仓库，返回中标明原因（界面在勾选前已经显示过，这里是执行前的再确认）。
10. 通过：作为 `GATE_DECIDED` 事件进入项目队列；转移函数再校验一次（M2 6.1）。

**通知**（R28，扩展 `shell/main-run-notifications.cjs`）：

- 触发：M13 第 7 节表中的时机，由 main 在项目状态落盘后根据新旧投影的差异判断，而不是由各模块各自发出。
- 合并：同一项目 30 秒内的多个新条目合并为一条通知。
- 内容：只含项目室名、检查点名与原因的本地化短语，不含产物、评审或意见的内容（锁屏可见）。
- 点击：打开对应项目室，并把输入框的操作目标设为该条目（M13 第 6 节）。
- 用户正在查看该项目室时不发通知。

## 11. 测试

- 工作区文件：v3 文件加载后写回为 v4，首次写入前生成 v3 备份；v4 中 `projects`、`projectId`、`projectRole` 在加载、保存、快照中完整保留；3.2 的每条一致性约束。
- 项目状态模式：每个集合的字段与上限；超过 8 MiB 时写入失败、内存副本不变、项目暂停。
- 写入队列：并发提交 100 个操作，断言按到达顺序逐个落盘、`revision` 连续；在写入的每一步注入崩溃，断言重启后读到的要么是旧版本、要么是新版本，没有半份文件；一步失败时内存副本不变。
- 迁移：逐版本迁移、迁移前备份、迁移失败只读、高版本只读。
- 损坏：截断的 JSON、模式不符的字段，断言整份只读、原文件保留副本、目录保持写入保护。
- 投影：7.2 列出的内容一律不出现在任何投影中（对全部字段做穷举断言）；「待我决定」的排序与上限；`project:changed` 的频率合并。
- IPC：每个方法的多余字段、超长文本、非法 id 被拒绝；renderer 提交路径的方法不存在；`chooseWorkdir` 令牌过期与重复使用被拒绝；含已知密钥的文本被替换后存储。
- `decideGate`：第 10 节每一步各一个失败用例，断言返回的是第一个失败项；全部通过时恰好产生一个 `GATE_DECIDED`。
- 删除：在第 9 节每两步之间注入崩溃，断言重启后完成删除、沿用落盘的 `keepChats`、不留下工作区中的项目或孤立的目录；工作目录中的文件不变。删除时有 `restore-files` 正在执行、有接受提交排在影子仓库队列中，断言它们结束之后才进入 `drained`、才删除影子仓库；有可能写入的调用在运行时，断言排空期间仍能消费它的 `INVOCATION_ENDED`、把「待释放」改为「已释放」，而不是卡住。
- 删除期间的接口：断言只有 `snapshot`、`diagnostics`、`residual`、`retryDeletion` 被允许，再次调用 `delete` 被拒绝；目录删除失败后修复权限，断言 `retryDeletion` 沿用原 `keepChats` 完成删除；
- 排空与项目内群聊：删除开始时有项目内群聊正在写入，断言排空经它自己的调用生命周期取消并等到容器清空，对账不撤回它的租约，它结束之后才进入 `drained`；删除开始后项目内群聊发起的可写调用被拒绝。
- 最后一项收尾在项目队列之外：检查点与副作用都已收尾，只剩一个项目内群聊调用，它结束后再没有任何项目事件，断言 `DRAIN_CHECK` 被投递、删除自动完成，不需要「重试删除」；人为去掉这个触发点，断言 30 秒的兜底仍能完成删除；重复投递 `DRAIN_CHECK` 不改变状态。
- 排空与调度器：记录已落盘为「已释放」、`release-scope` 尚未执行时开始删除，断言通知仍被执行、进入 `drained` 时调度器中没有该项目的占用；人为让一条释放通知失败，断言对账补上撤回之后才进入 `drained`；排空中登记了残留占用时，人请求复核通过后排空继续完成。
- 删除的目录恢复：删除 `state.json` 之后、`shadow.git` 删除到一半时注入崩溃，断言重启后继续删除整个目录、确认不存在之后才移除工作区记录；目录删除失败时断言保持 `deleting` 并提供重试。
- 写入的提交点：对目录 `fsync` 注入 `EIO`，断言内存副本采用新状态、副作用暂停、重写成功后才执行副作用，后续写入不会以旧状态覆盖；改名之前注入失败，断言内存副本不变。
- 上限：状态接近常规上限时触发一次自动压缩；压缩后仍超限时，断言暂停记录作为控制类写入成功落盘；压缩不删除 4.6 列出的任何活动记录；控制类写入超过硬上限时断言进入只读并写入 `fault.json`。
- 取消漂移恢复：在等待租约时取消，断言申请立即撤回、条目回到未解决；修订号不符时被拒绝。
- 通知：30 秒合并；锁屏内容不含产物文字；正在查看时不发。

## 12. 对其他文档的修改

| 文档 | 修改 |
| --- | --- |
| 架构 M1 | 项目状态文件路径改为 `meldwork-private/projects/<projectId>/state.json`；工作区文件 v4 不支持降级、首次写入前备份 v3；项目状态损坏时整份只读，不逐条隔离 |
| 架构 M5 | 关卡决定的校验顺序与错误码见本文第 10 节；通知由 main 根据投影差异统一判断 |
| 架构 A11、M2 4.3 | 「原子写入」的提交点是改名；改名之后持久性不确定时，转移的副作用暂停到重写持久化成功（6.1）。所有要求「状态先落盘、再对外生效」的地方都以持久化确认为准 |
| M3 3.3、3.7 | 进程登记表的写入同样区分阶段：第 3 步「运行中」的记录必须**持久化确认**（目录 `fsync` 成功）之后才发送放行；`after-commit` 失败时重写，成功后再放行，否则 Agent 可能在身份没有可靠落盘时开始工作 |
| `desktop/src/security/private-file.cjs` | `atomicWritePrivateFile` 抛出的错误带 `phase`（6.1），现有调用方不受影响 |
| 架构第 6 节 | 新增：renderer 从不提交文件系统路径，工作目录经 main 的系统对话框选择；残留进程在界面上只显示程序名，不显示完整命令行 |
| M13 | 错误码的中英文案；残留进程列表显示的字段与 7.2 一致 |

## 13. 待定问题

1. `rounds` 保留 20 轮、已消费副作用保留 200 条等数值，在实现中按真实项目的状态文件大小校准。
2. 工作区文件 v4 是否需要为旧版本提供一个只读的兼容视图，本文选择「不支持降级 + 备份」，如实施中发现用户常在版本间切换再评估。
