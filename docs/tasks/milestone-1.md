# 任务单：里程碑 1 受管理的可写进程（A14）

## 目标

让 Meldwork 启动的每一个可能写入工作目录的调用，都在一个受管理的进程容器里运行：身份落盘之后才放行；主进程死亡时整个容器随之结束；重启后确认容器已空，确认不了的登记为残留占用。这一改动作用于**所有群聊**，不只是项目室。

## 前置条件

- 里程碑 0 已验收。任务 0.2 的结论是「打包后的应用关闭了 RunAsNode fuse，Node 脚本形式的监护程序不可用」，据此已裁决改为原生小程序，本任务单已按此修订（任务 1.3）。
- 本机有 `clang`（Xcode 命令行工具）。
- 已读 `docs/handoff-guide.md`。

## 必读

- `docs/functional-architecture.md`：决定 A14；「受管理的可写进程」一段（M3 段落下）。
- `docs/modules/m3-seat-invocation.md`：第 2 节、第 3 节全部、第 5 节、第 11 节中与监护程序、登记表、常驻 ACP、钉子、强制结束、控制消息、fd 3、适配器终止路径有关的条目。
- `docs/modules/m1-m5-storage-and-interfaces.md`：6.1 中关于「提交点是改名」与 `phase` 的部分。
- `docs/spikes/milestone-0-results.md`：任务 0.2、0.3、0.6 的结论。

## 范围

| 包括 | 不包括 |
| --- | --- |
| 新增 `desktop/native/supervisor/` 下的原生监护程序与 `desktop/scripts/build-native.cjs`；`desktop/src/agents/process/` 下的受管理启动器、进程登记表、进程检查工具 | 项目室的任何部分 |
| `atomicWritePrivateFile` 的 `phase` | `read-exec` 权限模式（里程碑 5） |
| 两个适配器的 `spawnFn` 注入与终止路径 | 调度器的残留占用（里程碑 2；本里程碑先保存在内存里） |
| 可能写入的 ACP 调用改为每轮一个进程 | 残留进程的完整界面（里程碑 6；本里程碑只在诊断中显示） |
| 应用启动时的进程登记表恢复 | Windows 作业对象（本里程碑在 Windows 上退回现有行为，见任务 1.9） |

本里程碑中「可能写入的调用」就是 `permissionMode === 'workspace-write'` 的调用；`read-exec` 在里程碑 5 加入后同样适用。

## 任务

### 任务 1.1 `atomicWritePrivateFile` 报告失败阶段

文件：`desktop/src/security/private-file.cjs`。

1. 在函数中记录是否已经执行过 `fs.renameSync`。
2. 改名之前抛出的错误，附 `error.phase = 'before-commit'`；改名之后（目录 `fsync`）抛出的错误，附 `error.phase = 'after-commit'`。不改变函数的其他行为、参数和返回值。
3. 新增测试 `desktop/test/security/private-file-phase.test.cjs`：
   - 正常写入：没有错误。
   - 用依赖注入或临时替换 `fs.openSync`（打开目录时）、`fs.fsyncSync` 让目录 `fsync` 抛出 `EIO`：断言抛出的错误 `phase === 'after-commit'`，且文件已经是新内容。
   - 让写临时文件失败：断言 `phase === 'before-commit'`，且文件仍是旧内容。
   - 测试结束恢复被替换的函数。
4. 运行 `npm --prefix desktop test`，确认现有调用方的测试全部通过。

### 任务 1.2 进程检查工具

新文件：`desktop/src/agents/process/process-inspect.cjs`。全部用 `execFile` 加参数数组，不经过 shell；每个函数都接受一个可注入的 `execFileFn`，便于测试。

```
async processStartTime(pid)       → string | null   'ps -o lstart= -p <pid>'，进程不存在返回 null
async processGroupOf(pid)         → number | null   'ps -o pgid= -p <pid>'
async groupMembers(pgid)          → Array<{ pid, startTime }>   'pgrep -g <pgid>'，再逐个取启动时间
groupEmpty(pgid)                  → boolean          process.kill(-pgid, 0)：抛 ESRCH 为 true，抛 EPERM 为 false（有成员但无权限），不抛为 false
async readEnvironmentMarker(pid, marker) → 'present' | 'absent' | 'unreadable'
                                      macOS：'ps -wwE -o command= -p <pid>' 输出中是否含 'MELDWORK_CONTAINER=<marker>'
                                      Linux：读 /proc/<pid>/environ，按 \0 分割比较
                                      读取失败（权限、进程已退出）返回 'unreadable'
```

测试 `desktop/test/agents/process/process-inspect.test.cjs`：用注入的 `execFileFn` 覆盖每个函数的正常、进程不存在、权限不足分支；再用一个真实的 `sleep 5` 子进程做一次端到端（启动时间非空、组成员包含它、环境标记 `present`），测试结束 `kill` 它。

### 任务 1.3 原生监护程序

监护程序是**随应用分发的原生小程序**，不是 Node 脚本（M3 3.2；原因：打包后的应用关闭了 RunAsNode fuse，里程碑 0 任务 0.2）。**不要修改 `desktop/scripts/after-pack.cjs` 中的任何 fuse 设置。**

1. 新文件 `desktop/native/supervisor/meldwork-supervisor.c`。C99，只用系统库（macOS：`libproc`、`kqueue` 可选；Linux：`/proc`）。以里程碑 0 的 `desktop/spikes/supervisor-prototype.cjs` 为行为参照，必须完全符合 M3 3.3–3.5：
   - 启动后立即：`signal(SIGTERM, SIG_IGN)`；对 fd 3 设置 `FD_CLOEXEC`；监护程序打开的其他描述符一律 `O_CLOEXEC`。
   - **永远不向 fd 1、2 写任何内容**。诊断只经 fd 3 的 `error` 消息。
   - 控制通道：fd 3，按行解析 JSON。消息只有下面几种，字段固定，可以用一个很小的手写解析器（只需支持字符串、字符串数组、字符串字典、布尔与整数）；遇到无法解析的消息，发送 `{"error":{"code":"SUPERVISOR_PROTOCOL"}}` 并按 stop 处理。
     - main → 监护程序：`{"go":{"command":"…","args":["…"],"env":{"K":"V"},"cwd":"…"}}`、`{"stop":{"force":true|false}}`。
     - 监护程序 → main：`{"started":{"agentPid":N}}`、`{"agentExit":{"code":N|null,"signal":"SIGNAME"|null}}`、`{"finalKill":{"agentAlive":true|false,"members":[{"pid":N,"startTime":N}]}}`、`{"error":{"code":"…"}}`。
   - 事件循环：`poll` 等待 fd 3 可读与「子进程结束」（`SIGCHLD` 经自管道写入，或在 macOS 上用 `kqueue` 的 `EVFILT_PROC`）。不在任何地方阻塞读取。
   - 放行前 fd 3 读到结束（main 死亡）：立即 `_exit(0)`，不启动 Agent。
   - 放行：`fork`；子进程中 `chdir(cwd)`、`execve(command, args, env)`（不改变进程组，与监护程序同组）。`env` 完全取自 `go` 消息：main 已剔除 `ELECTRON_RUN_AS_NODE` 等变量并加入 `MELDWORK_CONTAINER`，监护程序不增删环境变量。`execve` 失败时子进程 `_exit(127)`。父进程发送 `started`，然后 `dup2` 打开的 `/dev/null` 到 0、1、2（**不要只 `close`**，见 M3 3.3）。
   - 子进程结束（`waitpid`）：立即发送 `agentExit`（最多一次），开始清理。
   - `stop`：开始清理；`force` 时跳过等待。
   - fd 3 读到结束（main 死亡）：开始清理，之后不再发送消息。
   - 清理（只执行一次）：`kill(-getpgrp(), SIGTERM)` → 等 2500 毫秒（`force` 时 0），期间继续处理事件循环（这样等待中结束的根进程能被 `waitpid` 收到）→ 再处理一次事件循环中已到达的事件 → 若此时观察到根进程退出且尚未发送 `agentExit`，先发送 → 用 `proc_listpids(PROC_PGRP_ONLY, getpgrp(), …)`（macOS）或扫描 `/proc/*/stat`（Linux）列出组内成员（排除自己），用 `proc_pidinfo(PROC_PIDTBSDINFO)` 或 `/proc/<pid>/stat` 取启动时间 → 发送 `finalKill`（`agentAlive` 为「尚未观察到根进程退出」）→ 确认消息已完整写入 fd 3（循环 `write` 直到写完）→ `kill(-getpgrp(), SIGKILL)`。
2. 新文件 `desktop/scripts/build-native.cjs`：用 `execFile` 调用 `clang`（不经过 shell），编译参数 `-std=c99 -O2 -Wall -Wextra -Werror`。macOS 上分别以 `-arch arm64`、`-arch x86_64` 编译，再 `lipo -create` 合并为 `desktop/native/build/meldwork-supervisor`；Linux 上编译当前架构。找不到 `clang` 时以明确的错误退出，提示安装 Xcode 命令行工具。
3. `desktop/package.json`：
   - `scripts` 中新增 `"build:native": "node scripts/build-native.cjs"`；`dev`、`pack`、`dist`、`dist:public` 在现有步骤之前先运行它（例如 `"pack": "npm run build:native && npm run build:frontend && electron-builder --dir"`）。
   - `build.extraResources` 新增 `{ "from": "native/build/meldwork-supervisor", "to": "bin/meldwork-supervisor" }`。
4. `.gitignore`：加入 `desktop/native/build/`。
5. 签名：现有 `after-pack.cjs` 的 `codesign --force --deep --sign -` 会一并签名 `Resources/bin/` 下的可执行文件；在汇报中给出 `codesign -dv <应用>/Contents/Resources/bin/meldwork-supervisor` 的输出确认。
6. 测试 `desktop/test/agents/process/supervisor-native.test.cjs`：测试开始时若 `desktop/native/build/meldwork-supervisor` 不存在，先调用构建脚本。按 M3 3.6 的四个场景各一个用例（驱动方式与里程碑 0 的 `run-supervisor-scenarios.cjs` 相同，但改为启动原生监护程序）；另外断言：Agent 的环境与 `go` 消息中的 `env` 完全一致；fd 3 不被 Agent 继承；无法解析的消息导致清理而不是崩溃；`execve` 失败时报告 `agentExit` 退出码 127。

### 任务 1.4 进程登记表

新文件：`desktop/src/agents/process/process-registry.cjs`。

```
class ProcessRegistry {
  constructor({ storagePath, now, inspect })     storagePath：meldwork-private/process-registry.json
  load()                                          读文件；不存在则为空；损坏则把原文件改名为 .corrupt-<时间>.json 并以空登记表开始，记录诊断
  async begin(record) → recordId                  写入「启动中」：调用 id、群聊 id、项目 id（可空）、工作目录真实路径、权限、写入声明（可空）、容器标记、创建时间
  async markRunning(recordId, { pgid, leaderStartTime })   写入「运行中」。必须持久化确认：遇到 phase === 'after-commit' 时重写一次；重写仍失败则抛出
  async markEnding(recordId, { finalKillMembers })          写入「结束中」
  async markEnded(recordId)                                  写入「已结束」，24 小时后在下一次写入时清除
  async recover() → Array<{ recordId, outcome: 'ended' | 'residual', residual? }>   M3 3.7 的启动恢复
}
```

- 所有写入都排进一个内存中的先进先出队列，一次一个，经 `atomicWritePrivateFile` 写入整个文件。
- `recover()` 严格按 M3 3.7 的表格实现，**任何分支都不对单个进程 id 发信号**；唯一会发信号的情况是 M3 3.7「组长存活、组号与启动时间相同」，而这时也只是等待（最多 10 秒），不发信号。
- `residual` 的内容：记录 id、工作目录真实路径、写入声明、组号、成员清单（`pid`、`startTime`、Agent 种类、程序名、是否带标记），供诊断显示（M1/M5 7.2：程序名只取命令行第一个词的最后一级名称）。

测试 `desktop/test/agents/process/process-registry.test.cjs`：

- 每种状态之间注入写入失败（替换 `atomicWritePrivateFile`），断言登记表在内存与磁盘之间不分叉。
- `markRunning` 遇到 `after-commit`：断言重写一次；重写成功则正常返回，失败则抛出。
- `recover()`：用注入的 `inspect` 构造 M3 3.7 表格中的每一种情况（组为空；组长存活且启动时间相同；组长存活但启动时间不同；组长不存在、成员带标记；成员无标记；成员环境不可读；成员早于记录创建时间减 1 秒；「启动中」无组号；「结束中」有清单），断言 `outcome`，并断言 `inspect` 中发信号的函数从未被调用。

### 任务 1.5 受管理启动器

新文件：`desktop/src/agents/process/managed-spawn.cjs`。

```
function createManagedSpawn({ registry, invocation, supervisorPath, platform })
  → spawnFn(command, args, options)      签名与 child_process.spawn 相同，返回一个 managed child
```

managed child 的接口（`EventEmitter`）：

| 成员 | 行为 |
| --- | --- |
| `stdin`、`stdout`、`stderr` | 监护程序子进程的三路 pipe（Agent 继承它们） |
| `pid` | 监护程序的 pid，即容器的组号 |
| `exitCode`、`signalCode` | 与 `exit` 事件中的值一致；之前为 `null` |
| `stop({ force })` | 经 fd 3 发送 `stop` |
| `kill(signal)` | 不直接发信号：`SIGKILL` 等同 `stop({ force: true })`，其他等同 `stop({ force: false })` |
| 事件 `exit(code, signal, info)` | M3 3.4 的四种来源；`info` 中带 `terminatedBy` 或失败码 |
| 事件 `close(code, signal, info)` | `exit` 之后，stdout 与 stderr 都读到结束；或 M3 3.4 的 5 秒截断（`info.outputTruncated`） |
| 事件 `container-empty` | 监护程序退出、控制通道读到结束之后，按 M3 3.4「结束的确认」判断为已空 |
| 事件 `error` | 启动失败 |
| `[Symbol.for('meldwork.managed-process')]` | `true`，供 `terminateAgentProcess` 识别 |

启动步骤，严格按 M3 3.3 的顺序：

1. 生成容器标记 `crypto.randomBytes(16).toString('hex')`，放进传给 Agent 的 `env`。
2. `await registry.begin(...)`。
3. 以 `spawn(supervisorPath, [], { detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' }, windowsHide: true })` 启动原生监护程序。监护程序自己的环境只放最少的变量；Agent 的完整环境经 `go` 消息传递。启动前检查 `supervisorPath` 存在且可执行，否则以 `LOCAL_MANAGED_PROCESS_UNAVAILABLE` 失败，**不退回无保护的启动**。
4. 取 `pid` 与 `processStartTime(pid)`，`await registry.markRunning(...)`。失败则结束监护程序（关闭 fd 3，它会在放行前退出），以 `error` 返回。
5. 发送 `go`。
6. 选择 `exit` 结果时，**必须先排空控制通道**（M3 3.4）：真实的 `agentExit` 到达就立即发出 `exit`；需要回退时，等监护程序的子进程 `exit` 事件**和** fd 3 的 `end` 都到达，再选择；5 秒内 fd 3 没有结束则按 `LOCAL_AGENT_SUPERVISOR_LOST`。
7. `exit` 与 `close` 各**恰好一次**；用一个状态变量保证，重复调用直接返回。
8. `container-empty` 之后 `await registry.markEnded(...)`；确认不了已空时 `markEnding` 并保持，不发出 `container-empty`。

`supervisorPath` 的取值（M3 3.2「定位」）：打包后（`app.isPackaged`）为 `path.join(process.resourcesPath, 'bin', 'meldwork-supervisor')`；开发与测试时为 `desktop/native/build/meldwork-supervisor`。

测试 `desktop/test/agents/process/managed-spawn.test.cjs`，用真实进程（监护程序用 `desktop/native/build/meldwork-supervisor`，Agent 用一个 `desktop/test/fixtures/` 下的小脚本）：

- M3 3.6 的场景 A、B（B 通过让测试进程派生一个「假 main」子进程，再对它 `SIGKILL` 来模拟）、C。
- 事件顺序 `exit` → 输出排空 → `close` → `container-empty`；`exit` 中的退出码是 Agent 的真实退出码。
- Agent 在退出前写出 1 MB 的输出：`close` 之前全部读到。
- Agent 忽略 `SIGTERM`：`exit` 为 `signal: 'SIGKILL'`、`terminatedBy: 'cleanup'`。
- `stop({ force: true })`：同上。
- 延迟读取 fd 3：人为在 main 一侧延迟处理控制通道的数据，断言结果仍是真实的 `agentExit`。
- 监护程序在发出 `finalKill` 之前被外部 `SIGKILL`：断言 `exit` 为 `LOCAL_AGENT_SUPERVISOR_LOST`，main 不发任何信号，登记表进入「结束中」。
- fd 3 不被 Agent 继承：在 Agent 中列出打开的描述符（`lsof -p $$` 或 `/dev/fd`），断言没有 3。
- 每个测试的 `finally` 中：结束本测试创建的所有进程，并用 `pgrep` 断言没有残留。

### 任务 1.6 `terminateAgentProcess` 与两个适配器的终止路径

1. `desktop/src/agents/cli/cli-process-support.cjs` 新增并导出：

```
async function terminateAgentProcess(child, { force = false, platform, spawnFn } = {})
  受管理的 child（带 Symbol.for('meldwork.managed-process')）：child.stop({ force })，等待 close
  不受管理的 child：保持现有逻辑（POSIX 对 -pid 发信号、回退到 child.kill；Windows 走 terminateWindowsProcessTree）
```

2. `desktop/src/agents/cli/cli-adapters.cjs`：`signalProcessTree`（约 `:328-338`）对受管理的 child 改为调用 `child.stop({ force: signal === 'SIGKILL' })`，不再调用 `process.kill(-child.pid, …)`；不受管理的 child 不变。
3. `desktop/src/agents/cli/cli-acp-runner.cjs`：`terminateChild`（约 `:479-505`）同样处理。
4. 在这两个文件中搜索所有 `process.kill(-` 与 `child.kill(`，确认受管理的 child 都不会走到直接发信号的分支；在汇报中列出搜索结果。
5. 测试：`desktop/test/agents/cli/` 下现有的适配器测试全部通过；新增一个测试，用一个假的受管理 child，断言取消、超时、强制终止都调用了 `stop`，从未调用 `process.kill`。

### 任务 1.7 注入受管理启动器

1. 在 `desktop/src/workspace/local-workspace-agent-invocation.cjs` 中，找到构造适配器选项（传给 CLI 与 ACP 运行器的 `options`）的地方。当这次调用的 `permissionMode === 'workspace-write'` 且平台不是 Windows 时，传入 `spawnFn: createManagedSpawn({ registry, invocation, supervisorPath, platform })`。`invocation` 中带群聊 id、工作目录真实路径、权限。
2. `registry` 是应用级的单例，在 `desktop/src/main.cjs` 创建 `LocalWorkspace` 的地方创建，经构造参数传入。不要在多个地方各建一个。
3. 只读调用不传，行为与现在完全相同。

### 任务 1.8 可能写入的 ACP 调用每轮一个进程

依据 M3 3.9。在 `local-workspace-agent-invocation.cjs` 约 `:1052-1055` 处：

```
...(kind !== 'openclaw' ? { acpPersistenceKey: session.key } : {}),
```

改为：只有 `permissionMode` 为只读时才传 `acpPersistenceKey`。可能写入的调用不传，ACP 运行器因此走 `runDisposableAcpAgent`，每轮启动、结束后关闭；会话靠现有的 `resumeSession` 恢复（`cli-acp-runner.cjs:994-1004`）。

测试：一个可写调用连续两轮，断言两轮使用了不同的进程、第二轮调用了 `resumeSession`；一个只读调用连续两轮，断言复用同一个常驻进程。

### 任务 1.9 Windows

本里程碑在 Windows 上不注入受管理启动器（任务 1.7 的平台判断），行为与现在相同。在 Agent 能力登记中，Windows 上 `managedProcess` 为 `false`（能力登记的完整实现在里程碑 5；本里程碑只需要在 `desktop/src/agents/` 中留一个常量或函数，返回当前平台是否支持受管理进程，供后续使用）。

### 任务 1.10 启动恢复

1. 在 `desktop/src/main.cjs` 的应用启动流程中，在任何 Agent 调用可能开始之前，调用 `await registry.recover()`。
2. 把 `residual` 结果保存在一个内存中的列表里（里程碑 2 会把它们接入调度器），并经现有的诊断机制显示（日志与开发者可见的诊断信息即可，不需要界面）。
3. 运行记录的 `recoverInterrupted` 保持不变，它只负责运行状态。

### 任务 1.11 人工检查与打包

按「验收」一节的人工检查执行，结果写进汇报。

## 验收

**本里程碑运行的自动化测试**：任务 1.1、1.2、1.4、1.5、1.6、1.8 中列出的全部测试；`npm --prefix desktop test` 全部通过。

**推迟到后续里程碑的测试**：M3 第 11 节中与 `read-exec` 评审、项目室提示词、会话键、标记、权限三种模式、看门狗、用量有关的条目（里程碑 5）；残留占用接入调度器后的冲突测试（里程碑 2）。

**人工检查（Electron 桌面模式，`npm --prefix desktop run dev`）**：

1. 普通群聊打开写入权限，让 Agent 运行 `sh -c "(while true; do date >> bg.txt; sleep 1; done) &"`，确认一轮结束后 `bg.txt` 停止增长。
2. 在 Agent 运行一个长任务时，用 `kill -9 <Electron 主进程 pid>` 强制结束应用；在终端中确认 Agent 及其子进程在约 3 秒内消失；重新启动应用，确认没有误报残留。
3. 只读群聊的行为与改动前相同：回答正常，常驻 ACP 进程在两轮之间保留。
4. 可写的 ACP 群聊（例如 DeepSeek）连续两轮，第二轮能接着上一轮的上下文回答。
5. `npm --prefix desktop run pack` 之后，在打包的应用中重复第 1、2 条；同时确认 `after-pack.cjs` 读回的 fuse 状态与改动前相同（`runAsNode` 仍为关闭），以及 `Contents/Resources/bin/meldwork-supervisor` 已签名。

需求追踪：R20、R26（A14），架构第 6 节的边界变更。

## 停下来问的情况（除交接手册第 5 节之外）

- 现有的某个适配器测试依赖「终止时直接对 `-child.pid` 发信号」的行为，改动后失败。
- `ps -wwE` 在当前 macOS 上看不到同一用户其他进程的环境。
- 打包后的应用中找不到 `Contents/Resources/bin/meldwork-supervisor`，或它没有被签名。
- 原生监护程序需要系统库以外的依赖。
- 有人建议通过修改 `after-pack.cjs` 的 fuse 来解决问题：不允许，停下来问。
