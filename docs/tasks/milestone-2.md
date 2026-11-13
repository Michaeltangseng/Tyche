# 任务单：里程碑 2 调度器

## 目标

把现有的 `RunScheduler`（每个请求一把不透明的键）扩展为：用**路径声明**表达写入范围，一个申请的全部声明**全有或全无**地授予，冲突的申请按到达顺序；新增不绑定单次操作的申请接口、持有者类型、残留占用、恢复模式。现有调用方继续可用，现有测试全部通过。

## 前置条件

- 里程碑 1 已验收（残留占用目前保存在内存中，本里程碑把它们接入调度器）。
- 已读 `docs/handoff-guide.md`。

## 必读

- `docs/modules/m4-m6-versions-and-writes.md`：A1、A2（全部）、A3（全部）、A4、A5、C、D 中「调度器」部分。
- `docs/modules/m2-checkpoint-engine.md`：5.2、5.4（全部，尤其「调度器契约」三条）、5.3 中「调度器对账」与持有者类型表。
- 现有代码：`desktop/src/runs/run-scheduler.cjs` 全文；`desktop/test/runs/run-scheduler.test.cjs`；`desktop/src/workspace/local-workspace-agent-invocation.cjs:274-320`（现有的写入键与 `withLease` 调用）。

## 范围

| 包括 | 不包括 |
| --- | --- |
| 新文件 `desktop/src/runs/path-claims.cjs` | 项目室（还不存在；与项目重叠的规则以测试覆盖） |
| `run-scheduler.cjs` 的新接口与公平规则 | 引擎、对账副作用本身（里程碑 5） |
| 现有 `acquire` / `withLease` 增加持有者类型与路径声明 | 界面 |
| 启动时的恢复模式与顺序（M4/M6 C 中本层可做的部分） | |

## 任务

### 任务 2.1 路径声明

新文件：`desktop/src/runs/path-claims.cjs`。

```
async resolveRoot(root)                         → { realRoot, volumeId, caseInsensitive }
    realRoot：fs.realpathSync.native；volumeId：fs.statSync(realRoot).dev
    caseInsensitive：按 M4/M6 A2.2 的探测（在 realRoot 下建临时文件、用改变大小写的名字 stat）；结果按 volumeId 缓存到进程结束
normalizeRelativePath(path)                     → string   '/' 分隔、去掉 '.'、拒绝 '..'、绝对路径、NUL；NFC
async resolveClaimPath(rootInfo, relativePath)  → string   M4/M6 A2.2「符号链接」：已存在的部分 realpath，不存在的尾部接在最近的已存在祖先之后；结果必须在 realRoot 之内，否则抛 SCHEDULER_CLAIM_OUTSIDE_ROOT
async makeClaim({ root, path, mode })           → claim    { volumeId, key, mode }，key 为解析后的绝对路径（大小写不敏感的卷上为折叠后的值）
claimsConflict(a, b)                            → boolean  M4/M6 A2.1：同一卷；按段比较的前缀或相同；至少一条 exclusive。shared-legacy 与 shared-legacy 不冲突
```

测试 `desktop/test/runs/path-claims.test.cjs`（M4/M6 D「冲突规则」「符号链接」）：

- 相同路径、前缀路径冲突；`a/b` 与 `a/bc` 不冲突。
- 大小写不敏感卷上 `Docs/A.md` 与 `docs/a.md` 冲突（在 macOS 的默认卷上测；在大小写敏感的卷上断言不冲突，用一个可注入的探测结果模拟）。
- NFC 与 NFD 形式的同名文件冲突。
- `shared-legacy` 之间不冲突；`shared-legacy` 与 `exclusive` 重叠时冲突。
- `root/alias → root/docs` 时 `alias/spec.md` 与 `docs/spec.md` 冲突；尚不存在的 `docs/new/file.md` 按最近的已存在祖先解析；经符号链接指向 `root` 之外的声明被拒绝。
- `..`、绝对路径、NUL 被拒绝。

### 任务 2.2 新接口

在 `RunScheduler` 中新增以下方法（M4/M6 A3 表格）。保留现有的全部字段、方法与行为。

```
request({ requestId, holder, claims, onGranted })
    holder：{ kind: 'checkpoint-scope' | 'project-maintenance' | 'invocation', projectId?, ownerId }
    排队；按 2.3 的规则授予；授予时调用 onGranted(requestId)。不计入并发上限（M4/M6 A3.4）
    同一 requestId 重复提交：已在队列或已授予则无操作
release(requestId)          已授予的释放，然后 drain；不存在则无操作
withdraw(requestId)         等待中的移出队列；已授予的等同 release；不存在则无操作
restoreGranted(requests)    恢复模式中使用：不经队列直接设为已授予；任意两条重叠、或与已有授予重叠，整体拒绝并返回冲突清单，不做任何修改
registerResidual({ residualId, claims })    登记残留占用：与一切重叠的声明冲突（包括 shared-legacy）
clearResidual(residualId)
holdRoot(root)              暂停授予与这个 root 重叠的申请（root 用 path-claims 解析）；可以多次调用
openRoot(root)              解除；然后 drain
enterRecoveryMode()、exitRecoveryMode()   恢复模式中不授予任何可写申请，只接受 holdRoot、registerResidual、restoreGranted
snapshot()                  在现有内容之外，加上：每个授予与等待申请的 holder、claims；残留占用；被暂停的 root；每个等待申请的阻挡者（当前持有者、残留占用、被暂停的 root，或排在它前面的冲突申请）
```

### 任务 2.3 授予规则与公平

改写 `drain()`，对每个等待中的申请（按到达顺序）：

1. 恢复模式中：只有不含任何声明的只读申请可以授予。
2. 全有或全无：它的每条声明都不与任何当前授予、残留占用、被暂停的 root 冲突，才可能授予。
3. **公平**：它的任一条声明与**更早到达、仍在等待**的申请冲突时，不授予（即使此刻可以），排在后面。与所有更早的等待者都不冲突的申请可以越过它们。
4. 现有的并发上限照常适用于 `acquire` / `withLease`；不适用于 `request`。

测试（新文件 `desktop/test/runs/run-scheduler-claims.test.cjs`）：

- 全有或全无：申请两个文件，其中一个被占用，断言两个都没有授予；占用释放后同时授予。
- 公平：一个 `path = ''`（整个目录）的申请在等待时，后到的单文件申请不能越过它；与它无关的另一个目录的申请可以越过。
- 死锁不可能：两个申请各要两个文件、顺序相反，断言不会各拿一个。
- 残留占用挡住 `shared-legacy` 与 `exclusive`；`clearResidual` 后授予。
- `holdRoot` 挡住重叠申请，`openRoot` 后授予。
- 恢复模式中可写申请不授予；`exitRecoveryMode` 后授予。
- `restoreGranted` 遇到重叠整体拒绝，调度器状态不变。

### 任务 2.4 现有 `acquire` / `withLease` 的接入

1. `acquire` / `withLease` 的输入增加可选字段 `workdirRoot`（工作目录的真实路径）。提供时，调度器为它生成一条声明：`{ root: workdirRoot, path: '', mode }`，`mode` 默认为 `shared-legacy`。现有的 `workspaceKey` 照常用于同一群聊内的写入轮流（M4/M6 A2.3），两者同时生效。
2. 这类申请的 `holder.kind` 记为 `invocation`。
3. **与项目室重叠时改为独占**（M4/M6 A2.3）：调度器提供一个可注入的 `projectRootsProvider()`（返回所有项目室工作目录的真实路径）。`workdirRoot` 与任一项目 root 相同或互相包含时，`mode` 改为 `exclusive`。本里程碑还没有项目室，`projectRootsProvider` 默认返回空数组；用测试注入非空值覆盖这条规则。
4. 在 `local-workspace-agent-invocation.cjs` 的 `withLease` 调用处传入 `workdirRoot`（工作目录的真实路径）。解析失败时：
   - **可能写入的调用**（`workspace-write`，里程碑 5 起还有 `read-exec`）：**拒绝启动**，以 `LOCAL_WORKDIR_UNRESOLVED` 失败返回，界面显示「无法确认工作目录，未开始写入」。**不能**退回到不带路径声明的申请：那样的申请不会与项目租约或残留占用判冲突，目录恢复可用后 Agent 就可能在没有保护的情况下开始写入。
   - 只读调用：不传 `workdirRoot`，保持现有行为，记录诊断。
5. 现有测试 `desktop/test/runs/run-scheduler.test.cjs` 全部不改、全部通过。新增测试：带 `workdirRoot` 的两个普通群聊（同一目录）彼此不等待；注入项目 root 后，与它重叠的普通群聊与一个 `exclusive` 申请互斥；残留占用挡住普通群聊；工作目录解析失败时，可写调用以 `LOCAL_WORKDIR_UNRESOLVED` 失败、调度器中没有它的任何申请，只读调用照常进行。

### 任务 2.5 契约测试（测试替身引擎）

新文件 `desktop/test/runs/run-scheduler-contract.test.cjs`。写一个很小的**测试替身引擎**：它持有一张内存中的申请记录表，严格按 M2 5.4 的「状态先落盘，再通知调度器」调用 `request` / `release` / `withdraw`（「落盘」在替身中就是更新这张表）。用它验证调度器一侧的契约：

- 契约第 1 条：A 已授予，B 申请冲突的作用域；在替身调用 `release(A)` 之前，B 不被授予。
- 迟到的授予：替身先把 A 标为「已撤回」并调用 `withdraw(A)`，但调度器在此之前已经调用了 `onGranted(A)`；断言替身收到 `onGranted` 后按规则立即调用 `release(A)`，最终调度器中没有 A。
- 撤回与授予以两种顺序到达，最终都不持有。
- `restoreGranted` + `holdRoot` + `openRoot` 的启动顺序（M4/M6 C 第 1、2、4、5 步中调度器的部分）。

### 任务 2.6 启动顺序与残留占用接入

在 `desktop/src/main.cjs` 的启动流程中，按 M4/M6 C 的顺序调用：

1. `scheduler.enterRecoveryMode()`。
2. 对工作区文件中每个项目室的 `workdir` 调用 `holdRoot`（本里程碑还没有项目室，循环为空；代码要写好）。
3. `await registry.recover()`（里程碑 1），对每个 `residual` 调用 `registerResidual`，声明取自登记表的记录（没有写入声明的用工作目录 `path = ''`）。
4. `scheduler.exitRecoveryMode()`。

里程碑 1 中保存在内存里的残留列表改为以调度器为准；诊断显示改为读 `scheduler.snapshot()` 中的残留占用。

## 验收

**本里程碑运行的测试**：任务 2.1、2.3、2.4、2.5 中的全部测试；现有的 `run-scheduler.test.cjs` 不改且通过；`npm --prefix desktop test` 全部通过。

**推迟到里程碑 5 的测试**：M2 第 11 节中依赖真实引擎的：纪元增加后租约通知仍被执行；`reconcile-scheduler` 对账；项目内群聊写入时检查点对账不撤回它的租约；恢复屏障中「已获批」申请的重建（真实项目状态文件）。

**人工检查（Electron）**：两个普通群聊使用同一个文件夹、都打开写入权限，同时让它们写文件，确认它们和改动前一样不互相等待；同一群聊内的两次写入仍然轮流进行。

需求追踪：R7、R23。

## 停下来问的情况（除交接手册第 5 节之外）

- 现有 `run-scheduler.test.cjs` 中有测试依赖「后到的请求可以越过不能授予的请求」，与 2.3 的公平规则冲突。
- `fs.realpathSync.native` 在某些工作目录（例如网络卷）上很慢或报错。
