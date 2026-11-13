# 模块文档：M3 席位调用适配（含 M10 用量、A14 受管理进程的实现）

第二版，2026-11-13。第二版吸收评审 r12（`docs/reviews/architecture-v5/r12-review.md`）：重启恢复先核实容器身份（容器标记与组长启动时间），只对核实属于本容器的进程发信号；`read-exec` 评审串行运行并纳入快照与核对；常驻 ACP 调用以协议的一轮完成为结束；监护程序先报告 Agent 结果、再逐个清理组内进程、最后报告容器已空。

依据：`docs/product-target.md`（R2、R8、R10、R16、R20、R21、R26、R27、R28）、`docs/functional-architecture.md` 第十六版（决定 A3、A8、A9、A13、A14）、`docs/modules/m2-checkpoint-engine.md` 第八版（4.2 结果隔离、5.4 租约生命周期、第 10 节恢复屏障）、`docs/modules/m4-m6-versions-and-writes.md` 定稿（A3 调度器接口、C 启动顺序）。

M3 把「席位 + 检查点 + 输入」变成一次 Agent 调用，再把结果变成 M2 的事件。本文还给出 A14「受管理的可写进程」的平台实现。A14 是所有可能写入工作目录的调用的前提，风险最高，所以放在最前面，并附上在 macOS 上的实测结果。

## 1. 范围

| 本文负责 | 不负责 |
| --- | --- |
| A14 的实现：监护程序、启动握手、进程容器、结束确认、进程登记表与启动恢复 | 租约与调度（M6） |
| `project-room` 调用策略：提示词分层、会话键、宿主群聊、Context Pack | 检查点状态转移（M2） |
| 结尾标记的解析 | 关卡与界面（M5、M13） |
| 能力到 CLI 权限的映射，包括新增的 `read-exec` | 完整轨迹的存储与分页（M7） |
| 接入通道：ACP 与 print/exec 回退，Claude、Codex 的 ACP 实测计划 | |
| 每次调用的看门狗策略 | |
| 用量的来源（M10） | |
| 每种 Agent 的能力登记 | |

## 2. 现状

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| Agent 以 `stdio: ['pipe','pipe','pipe']`、POSIX 上 `detached: true` 启动 | `desktop/src/agents/cli/cli-adapters.cjs:246-252`；ACP 同理 `cli-acp-runner.cjs:684` | 监护程序可以夹在中间而不改变 stdio 的用法（第 3 节） |
| 停止时对整个进程组发信号 `process.kill(-child.pid, …)` | `cli-adapters.cjs:331`、`cli-acp-runner.cjs:500` | `child` 换成监护程序后，同样的代码结束的是整个容器 |
| 子进程环境中剔除 `ELECTRON_RUN_AS_NODE` 等变量 | `cli-process-support.cjs:40` | 监护程序自己需要这个变量才能用 Electron 的可执行文件运行，在启动 Agent 前剔除 |
| Windows 的进程树结束在直接子进程退出后立即返回 | `cli-process-support.cjs:47` | 证明不了后代已退出（A14） |
| 正常退出时 `before-quit` 经 `workspace.stopAll()` 结束 Agent；崩溃时不执行 | `desktop/src/main.cjs:1157` | A14 的监护 |
| 运行记录的崩溃恢复只改状态，不处理进程 | `desktop/src/runs/run-ledger.cjs:568` | A14 的进程登记表 |
| 除 OpenClaw 外，ACP Agent 按会话键保持常驻进程，读写调用共用 | `local-workspace-agent-invocation.cjs:1052-1055`、`cli-acp-runner.cjs:1248` | 与「一轮结束即容器清空」冲突（3.9） |
| ACP 在新进程中可以恢复已有会话（`resumeSession`），除非该 Agent 的会话策略为 `new` | `cli-acp-runner.cjs:994-1004` | 可写调用改为每轮一个进程，而不丢失会话（3.9） |
| Claude print 模式：只读用 `--permission-mode plan`，写入用 `acceptEdits` | `cli-invocations.cjs:251` | `plan` 模式不能运行命令，`read-exec` 需要另外的参数（第 6 节） |
| ACP 自动审批：只读时只放行 `read`、`search`、`fetch`、`think` | `agent-permission-policy.cjs:9`、`:25` | `read-exec` 增加 `execute`（第 6 节） |
| 运行时只有 `read-only`、`workspace-write` 两种权限模式 | `agent-runtime-contract.cjs:31` | 新增 `read-exec` |
| 无活动 10 分钟、工具 20 分钟、无进展上限为无活动窗口的 3 倍；CLI 与 ACP 各有 2 小时硬上限 | `local-workspace-runtime-contracts.cjs:18-19`、`cli-adapters.cjs:396-399`、`cli-acp-runner.cjs:987-990` | 每次调用的看门狗策略（第 8 节） |
| Claude 与 Codex 在本机写会话日志：`~/.claude/projects/<编码后的工作目录>/`、`~/.codex/sessions/<年>/…` | 本机核实 | 用量来源（第 9 节） |

## 3. 受管理的进程（A14 的实现）

### 3.1 适用范围

A14 原文说「可写调用」。本文把范围修正为**可能写入工作目录的调用**：权限为 `workspace-write`，以及 `read-exec`。`read-exec` 不使用编辑工具，但它运行的命令可以写文件（例如测试生成的产物，或 `echo > file`），所以同样需要容器、监护与结束确认。只有 `read-only` 调用（不能运行命令）不经过受管理进程。

### 3.2 组成

- **监护程序**：`desktop/src/agents/process/meldwork-supervisor.cjs`，一个不依赖第三方包的小脚本。用 Electron 自己的可执行文件运行，环境中只为它设置 `ELECTRON_RUN_AS_NODE=1`。打包时放进 `asarUnpack`，避免依赖 asar 内的读取。
- **启动器**：`desktop/src/agents/process/managed-spawn.cjs`，替换现有调用中的 `spawnFn`。它返回的 `child` 与原来的用法相同（`stdin`、`stdout`、`stderr`、`pid`、`kill`），但事件分成两种：`exit` / `close` 报告的是 **Agent 根进程**的真实退出码与信号（经 fd 3 由监护程序转报，而不是监护程序自己的退出状态），现有适配器照常使用；新增的 `container-empty` 报告整个容器已经清空，只有 M3 与 M2 的租约逻辑使用它。所以 `cli-adapters.cjs` 和 `cli-acp-runner.cjs` 只需换掉 `spawnFn`。
- **进程登记表**：`desktop/src/agents/process/process-registry.cjs`，文件 `meldwork-private/process-registry.json`。

### 3.3 启动握手（POSIX）

```
main                                   监护程序（新进程组的组长）              Agent
 │ 1 登记「启动中」并落盘                 │
 │ 2 启动监护程序：detached，             │
 │   stdio = Agent 的三路 pipe + fd 3 控制通道
 │ 3 取 pgid（= 监护程序 pid）与组长启动时间
 │   登记「运行中」并落盘                  │ 等待 fd 3
 │ 4 fd 3 发送 {"go": 命令, 参数, 环境}  →│
 │                                        │ 5 剔除 ELECTRON_RUN_AS_NODE，
 │                                        │   在同一进程组内启动 Agent ───────→ 开始工作
 │                                        │   stdio 继承，main 看到的仍是 Agent 的输入输出
 │ ←─ fd 3 {"started": agentPid}          │
```

- 第 3 步的组长启动时间以 `ps -o lstart= -p <pgid>` 读取。
- **容器标记**：main 为每个容器生成一个随机值，作为环境变量 `MELDWORK_CONTAINER=<随机值>` 交给监护程序，监护程序原样传给 Agent，Agent 的子进程默认继承。随机值与组号、组长启动时间一起登记。重启恢复时，用它确认某个进程确实属于这个旧容器（3.7）。
- 第 4 步之前，监护程序不执行任何 Agent 代码。main 在第 4 步之前死亡时，fd 3 关闭，监护程序直接退出，Agent 从未开始。所以任何能写文件的 Agent，它的容器标识必定已经落盘。
- 命令、参数与环境经 fd 3 传递，不出现在监护程序的命令行里。Agent 自己的命令行与现在相同。

### 3.4 容器与结束的确认

- **容器**：监护程序所在的进程组。Agent 与它启动的一切子进程（测试、构建、脚本、MCP 服务）默认都在这个组里。
- **结束**：进程组中除监护程序外没有任何进程，并且监护程序本身也已退出。判断方式：`kill(-pgid, 0)` 返回 `ESRCH`。
- **正常结束**。Agent 的根进程退出后，监护程序按以下顺序处理。监护程序自己也在这个进程组里，所以它**不对整个组发 `SIGKILL`**，否则会先杀死自己，无法转报结果：
  1. 立即经 fd 3 报告 Agent 根进程的退出码与信号（`{"agentExit": {...}}`）。main 收到后触发 `child` 的 `exit` / `close`，适配器照常解析结果。
  2. 列出组内除自己以外的进程（`pgrep -g <pgid>`）。没有就跳到第 4 步。
  3. 对这些进程逐个发 `SIGTERM`（监护程序忽略 `SIGTERM`，但这一步本来就不发给自己），等待 2.5 秒（沿用 `DEFAULT_RUN_ABORT_GRACE_MS`），再对仍存在的逐个发 `SIGKILL`；重复「列出 → 结束」，因为清理期间可能有进程又派生了子进程。最多 10 轮。
  4. 组内只剩自己时，经 fd 3 报告 `{"containerEmpty": true}`，然后退出。main 收到后再以 `kill(-pgid, 0)` 返回 `ESRCH` 复核，触发 `container-empty`。
  5. 10 轮后仍有进程：报告 `{"containerStuck": [进程 id…]}`，监护程序**不退出**、继续尝试；main 把登记表记录保持为「结束中」，租约保持「待释放」，项目室显示诊断。
- **取消**：main 经 fd 3 发送 `{"stop": true}`，监护程序对 Agent 根进程发 `SIGTERM`，宽限后 `SIGKILL`，之后走「正常结束」的第 1–5 步。现有代码对 `-child.pid` 发信号的路径同样可用：信号到达整个组，监护程序忽略 `SIGTERM`；若收到的是 `SIGKILL`，监护程序随之结束，main 得不到 Agent 的退出码，按失败（`LOCAL_AGENT_SUPERVISOR_LOST`）处理，再由 main 自己以 `kill(-pgid, 0)` 轮询确认容器已空。所以受管理启动器的 `kill()` 实现为发送 `stop` 消息，而不是直接发信号。
- **监护程序意外退出**（未报告 `containerEmpty` 就退出了）：main 按失败处理，并自己轮询确认容器已空；确认不了时同「结束中」。
- **给 M2 的结束事件**：见第 5 节。凡是可能写入的调用，都在 `container-empty` 之后才发出 `INVOCATION_ENDED`，并把登记表记录改为「已结束」。这满足 M2 4.2 与 5.4「写入已结束的确认」。

### 3.5 监护

监护程序始终读着 fd 3。main 死亡（崩溃、被强制结束）时 fd 3 关闭，监护程序立即按 3.4「正常结束」的步骤结束整个进程组，再退出。断电时所有进程本来就不存在。

### 3.6 实测（macOS）

2026-11-13 在 Darwin 24.6、Node 25 上，以一个与 3.3–3.5 相同的原型验证（临时目录，未进入仓库）。模拟 Agent 是一个 shell 脚本：启动后写标记文件，再启动一个每 0.2 秒写一次文件的后台进程，模拟测试或构建。

| 场景 | 操作 | 结果 |
| --- | --- | --- |
| A：放行前 main 死亡 | 身份落盘后、发送放行前对 main 发 `SIGKILL` | 监护程序检测到 fd 3 关闭后退出；标记文件不存在，Agent 从未开始；进程组为空 |
| B：放行后 main 死亡 | 放行 1.5 秒后对 main 发 `SIGKILL` | 监护程序结束整个进程组；组内进程数为 0；后台写入停止 |
| C：Agent 根进程退出后留下后台进程 | main 保持运行，Agent 主循环提前结束 | 监护程序报告「留下 2 个进程」（后台循环及其 `sleep`），结束它们；组内进程数为 0；写入停止 |
| 逃逸 | Agent 启动的进程调用 `setsid()` 脱离进程组 | 该进程不受监护，在 Agent 结束后继续写入。与 A14 写明的已知限制一致 |

仍需在正式实现中验证：用 Electron 可执行文件加 `ELECTRON_RUN_AS_NODE` 运行监护程序（原型用的是系统 Node）；打包后的路径；Linux。

### 3.7 进程登记表与启动恢复

**记录**：调用 id、所属群聊、项目室（如有）、工作目录真实路径、权限、写入声明（M6 A2）、容器标识（pgid、组长启动时间）、状态（启动中 / 运行中 / 结束中 / 已结束）、时间。整个文件原子写入、`0600`。已结束的记录保留 24 小时供诊断，之后清除。

**启动恢复**（M4/M6 C 第 3 步）。对每条未结束的记录：

1. 「启动中」且没有容器标识：Agent 从未开始（3.3），记为已结束。
2. 有容器标识：先**核实身份**，再决定是否发信号。组号可能已被复用：旧容器被清空之后，同一个进程 id 可以成为一个无关进程组的组长，`pgrep -g <pgid>` 因此非空。所以组号本身不能作为发信号的依据。
   - 组长存活，且启动时间与记录相同：组长就是当年的监护程序，整个组都属于这个容器。经 3.4 第 2–5 步逐个结束组内进程（main 代替监护程序执行），并确认已空。
   - 其他情况（组长已不存在，或组长进程 id 存在但启动时间不符）：列出组内成员，逐个核实。成员的环境中带有本容器的 `MELDWORK_CONTAINER` 值，才算属于这个容器。读取环境：macOS 上读取同一用户进程的参数与环境（`sysctl KERN_PROCARGS2`，与 `ps -E` 同源），Linux 上读取 `/proc/<pid>/environ`。
     - 核实属于本容器的：逐个结束。发信号前再比对一次它的启动时间，防止核实与发信号之间进程 id 被复用。
     - 读不到环境、或没有标记的成员：**不发信号**。
   - 组内没有成员，或成员全部核实为不属于本容器：这个容器已空。
   - 仍有核实属于本容器、但结束不了的成员，或有读不到环境、无法判断的成员：确认不了已空，进入下一步。
3. 确认不了已空的，调用 M6 的 `registerResidual`，声明取自记录（M4/M6 A5）。

### 3.8 Windows

方案：随应用分发一个小型辅助程序 `meldwork-job-helper.exe`（原生程序，随应用签名）。

- 以挂起方式（`CREATE_SUSPENDED`）创建 Agent 进程，放进一个设置了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、不允许脱离（不设 `JOB_OBJECT_LIMIT_BREAKAWAY_OK`）的作业对象；身份落盘后才恢复执行。挂起本身就是门。
- 容器已空：作业中的活动进程数为 0（`QueryInformationJobObject`）。
- 监护：辅助程序等待 main 的进程句柄；main 死亡时辅助程序退出，作业句柄关闭，作业中的进程全部结束。
- 恢复：辅助程序随 main 一起结束，作业随之关闭，所以崩溃后通常不会留下进程；登记表仍按 3.7 核对。

在这个辅助程序实现并实测通过之前，Windows 上 A14 标为未实现（架构 A14、M13）。辅助程序的语言与构建方式在实施计划中确定。

### 3.9 常驻的 ACP 进程

现在除 OpenClaw 外，ACP Agent 按会话键保持常驻进程，跨多轮复用（`acpPersistenceKey`）。常驻进程与「一轮结束时容器已空」冲突：进程在两轮之间仍然存活，它启动的 MCP 服务也在，平台无法区分这是 Agent 的正常组成部分，还是会继续写文件的后台进程。

决定：**可能写入的调用（`workspace-write`、`read-exec`）不使用常驻进程**，每轮启动一个 ACP 进程，在受管理的容器中运行，结束后容器清空；会话的连续性靠 ACP 的 `resumeSession`，在新进程中恢复上一轮的会话（现有实现已支持）。只读调用继续使用常驻进程。

代价：

- 可能写入的调用，每轮多出 ACP 进程启动与会话恢复的时间（通常为秒级）。
- 会话策略为 `new` 的 Agent 无法在新进程中恢复会话，在可能写入的调用中每轮都是新会话。能力登记中记为「可写调用不保持会话」，席位配置时提示。

这一改动同样作用于项目外的普通群聊（A14 覆盖所有可能写入的调用），写入架构第 6 节的边界变更。

## 4. `project-room` 调用策略

### 4.1 提示词

四层，按顺序拼接，原样发送，不附加 `RESPONSE_SCOPE_INSTRUCTION` 或工作偏好等任何后缀：

1. **平台立场**（只管流程）：主笔的结尾标记约定；评审者「找出缺漏、矛盾和不现实之处，『通过』是正当结论，意见要引用原文或证据，开头写几行摘要」；驳回轮的说明（M2 5.1）。中英两套，按项目语言选择。
2. **席位侧写**：原样放入，平台不解析（R16）。
3. **检查点输入**：目标文件路径；已接受上游的版本与提交号；上一轮的评审文件与回应文件路径；候选提交号与 diff（评审者，由影子仓库的两个固定提交计算，M4/M6 B3.3）；排队的插话；变更通知（「自你上次读取以来，哪些文档有了新版本」）；未解决漂移的提示（M2 8.2）；越界提醒（「只写你的目标文件和回应文件」）。
4. **语言约定**：用哪种语言写文档。

**Context Pack**：每次调用前，用现有的 Context Pack 存储捕获这一次的完整提示词与上游提交号，得到 `contextPackId`（现有路径要求必须提供，`local-workspace-agent-invocation.cjs:98-115`）。这也是每次调用的可追溯记录。

### 4.2 会话

- 宿主群聊：项目室的主流程群聊（A13），所有检查点调用都以它调用 `invokeAgent`。
- 主笔会话键：`project:<projectId>:cp:<checkpointId>:seat:<seatId>:<kind>:g<代数>`，存在工作区的 `sessions` 里。`resolveSessionState`（`local-workspace-context.cjs:437`）对 `project-room` 策略使用调用者给出的键；`sessionKey()` 的超长哈希回退（`:357-371`）把项目、检查点、席位、代数都纳入哈希。
- 评审者：每轮新会话，不保存会话号。`onSessionRef` 与结束时的 `session.complete` 两处都跳过保存（现有跳过条件在 `local-workspace-agent-invocation.cjs:385`、`:964`、`:1371`，只覆盖代码审查类 Agent 与 `isolated`，需要加入 `project-room` 的评审调用）。
- 删除项目室时按 `project:<projectId>:` 前缀清理会话键（架构 M1）。

### 4.3 权限来源

现有路径从群聊的 `allowWrite` 取权限（`local-workspace-agent-invocation.cjs:284`、`:392`、`:398`）。`project-room` 策略改用调用上下文给出的模式（由 M2 按席位能力决定），不读主流程群聊的 `allowWrite`。写入声明由 M2 的检查点作用域持有（M2 5.2），这次调用以只读模式向调度器计数（M4/M6 A3.4）。

### 4.4 结尾标记

新模块 `desktop/src/project-room/signal-markers.cjs`，语法与现有回执一致：

```
[[MELDWORK_CHECKPOINT:{"signal":"ready"}]]      主笔：ready | question | continue
[[MELDWORK_REVIEW:{"verdict":"pass"}]]          评审：pass | revise | needs-human
```

- 只认最终回答中**最后一个非空行**上的标记（参照现有 `AUTO_FINAL_CONSENSUS_MARKER` 的做法）。正文中间出现的同样文字不算，避免 Agent 引用标记说明时被误判。
- JSON 严格解析，字段只能是上面列出的取值；多出字段、取值不合法、缺失，一律视为「标记缺失」，由 M2 按需要人处理（R2）。
- 流式输出中用现有的 `answer-marker-filter.cjs` 隐藏标记。
- 不扩展 V4 的回执白名单（架构 A8）。

### 4.5 评审文件

评审者保持只读（或 `read-exec`）。它的最终回答（去掉结尾标记）由平台写入 `meldwork/reviews/<检查点>/r<轮次>-<席位>.md`（M2 `write-review-file`）。开头几行就是关卡首屏的评审者摘要（M13 第 4 节）。

## 5. 结束事件

M3 把一次调用的结果交给 M2 时，统一为 `INVOCATION_ENDED`（M2 4.1），带副作用 id、角色、席位、轮次、会话代数，以及：

| 情况 | 结果 |
| --- | --- |
| 正常结束，解析到合法标记 | `marker` 与取值 |
| 正常结束，没有合法标记 | `marker` 为缺失 |
| 调用失败 | `failed` 与失败分类：登录失效、额度用尽、启动失败、连续失败、其他。沿用现有的失败分类，映射到 M2 的失败关卡（R27） |
| 被取消 | `cancelled` |

何时发出：

| 调用 | 发出时机 |
| --- | --- |
| 可能写入的调用（`workspace-write`、`read-exec`） | `container-empty` 之后（3.4）。它们总是在受管理容器中运行，不使用常驻进程（3.9） |
| 只读调用，非常驻进程（print/exec，或不常驻的 ACP） | Agent 进程退出之后 |
| 只读调用，常驻 ACP 进程 | 协议上的**一轮完成**之后，即这一轮 `prompt` 请求得到响应（`runPersistentAcpAgent` 返回结果时）。常驻进程在两轮之间继续存活是预期行为，不等它退出。只读调用不能写文件，所以不需要「写入已结束」的确认 |

## 6. 权限：三种模式

| 能力（席位配置） | 运行时模式 | 含义 |
| --- | --- | --- |
| 读工作目录 | `read-only` | 只读，不运行命令 |
| 运行命令 | `read-exec`（新增） | 可以读、可以运行命令，不使用编辑类工具。命令本身可能写文件，所以 `read-exec` 调用在受管理容器中运行（3.1），前后各做一次快照、纳入越界检测（M4/M6 A6），并按 6.2 与其他调用协调 |
| 写草稿区、写工作目录 | `workspace-write` | 可以写。「写草稿区」在 CLI 层也是 `workspace-write`，范围由写入声明与越界检测保证 |

修改：`agent-runtime-contract.cjs` 的模式列表、`run-scheduler.cjs` 的模式校验（M4/M6 A3 中调用以只读计数，模式校验只用于兼容旧接口）。

### 6.2 `read-exec` 与送审内容的隔离

`read-exec` 最常见的用途是评审者运行测试。测试可能改动工作目录里的文件，包括送审的目标文件。如果它与其他评审并行，其他评审读到的就可能不是候选内容（M2 5.2 的保证被破坏）；如果它改了又改回，结束时的候选核对也发现不了。所以：

1. **同一轮里先跑只读评审，再跑 `read-exec` 评审。** 只读评审照常并行；它们全部结束后，`read-exec` 评审**一次只跑一个**。
2. 每个 `read-exec` 评审调用前后各做一次快照（与可写调用相同，M4/M6 A6），结束后（容器已空之后）做候选核对：工作目录中的目标文件是否仍等于 `candidate`。
3. 核对不通过，说明这次评审运行的命令改动了送审文件：这次评审的结论作废，`gate(评审失败)`，首屏写明「评审运行的命令改动了送审文件」并列出文件与 diff。人的选择按 M2 6.1：接受送审版本（工作目录中的差异记为未解决漂移），或以当前文件重新送审，或让主笔继续改。
4. 越界检测照常：`read-exec` 调用没有写入声明，所以它在目标文件之外改动的、未被 `.gitignore` 忽略的文件都列为越界条目（构建产物通常已被忽略）。
5. 取消 `read-exec` 评审时，要等它的容器清空，才能进入下一个状态或开始下一位评审（M2 5.2 规则 5 对评审「不必等待」的例外）。

这样，只读评审读到的一定是候选内容（期间没有任何写入者）；每个 `read-exec` 评审开始时，工作目录也等于候选内容（前一位结束后已核对通过）；它运行期间对送审文件的任何改动，都会在结束时被发现并作废这次结论。剩余的限制是：`read-exec` 评审运行期间改了又改回，它**自己**读到的可能不是候选内容。这只影响这一位评审自己的结论，写入 Known Risks。

### 6.1 各通道的映射

| 通道 | `read-only` | `read-exec` | `workspace-write` | 状态 |
| --- | --- | --- | --- | --- |
| ACP（所有 ACP Agent） | 放行 `read` `search` `fetch` `think`，其余拒绝（现有） | 另放行 `execute`；`edit` `delete` `move` 与 `other` 拒绝 | 全部放行（现有） | 一处实现，在 `agent-permission-policy.cjs` 的 `automaticPermissionResponse` 中加一个分支 |
| Claude print | `--permission-mode plan`（现有） | 候选：`--permission-mode default`，`--allowedTools` 放行读取类与 `Bash`，`--disallowedTools` 列出 `Edit` `Write` `MultiEdit` `NotebookEdit`；禁止列表中不能出现任何 `Bash` 规则，否则整个 Bash 被移除 | `--permission-mode acceptEdits`（现有） | `read-exec` 待实测 |
| Codex exec | 现有只读参数 | 候选：`--sandbox read-only`。它在操作系统层禁止写入，命令仍可运行，但构建、测试需要写临时文件时可能失败 | 现有写入参数 | `read-exec` 待实测 |
| 其他 print/exec 回退（WorkBuddy、ZCode 等） | 现有 | 不支持 | 现有 | 席位配置提示「这个 Agent 不支持只运行命令」，不静默降级或放宽（R16） |

一种 Agent 的 `read-exec` 只有在实测通过后，才在能力登记中标为支持（第 10 节）。

## 7. 接入通道

沿用架构 A9 的表格。本文补充实测计划与切换条件。

### 7.1 Claude、Codex 的 ACP 适配器实测

适配器：`@agentclientprotocol/claude-agent-acp`、`@agentclientprotocol/codex-acp`（Apache-2.0），由安装器按固定版本安装。逐项实测，全部通过才把它们的主通道切到 ACP：

| 项目 | 通过条件 |
| --- | --- |
| 登录 | 沿用本机 CLI 已有的登录，不要求重新登录、不另存凭据 |
| 权限 | 三种模式（6.1）的审批请求能被 `automaticPermissionResponse` 正确放行或拒绝；`codex-acp` 默认审批模式下不会绕过客户端审批 |
| 会话 | 新进程中 `resumeSession` 能恢复上一轮会话（3.9） |
| 取消 | 一轮中途取消后进程按 3.4 结束，容器确认已空 |
| 长时间运行 | 连续运行 2 小时以上不被适配器自身中断；看门狗按第 8 节提醒而不中止 |
| 轨迹 | `tool_call`、`tool_call_update`、`agent_thought_chunk` 带有完整内容（M7） |
| 用量 | 有 `usage_update` 或可从本地日志按会话号取得（第 9 节） |
| SDK 版本 | 适配器与桌面端已依赖的 `@agentclientprotocol/sdk` 0.23.0 兼容；需要升级时一并测试现有 ACP Agent |

未通过之前，Claude、Codex 仍用现有的 print/exec 通道，A14 照样适用。

### 7.2 Gemini、Qwen、Pi

Gemini、Qwen 改为原生 ACP（`--acp`）；Pi 的社区适配器 `pi-acp` 处于 0.0.x，同样按 7.1 的表格实测，不稳定则保留 print。

## 8. 看门狗

调用上下文新增 `watchdog` 选项（读取位置 `local-workspace-agent-invocation.cjs:636`）：

```
watchdog = {
  onInactivity: 'abort' | 'remind',   现有行为为 abort
  inactivityMs, toolMs,               默认沿用 10 分钟、20 分钟
  noProgressCapMs,                    默认沿用 3 倍无活动窗口；remind 时同样只提醒
  hardLimitMs: number | null          默认 2 小时；null 表示不设硬上限
}
```

- 项目室的主笔与可写草稿：`remind`，`hardLimitMs = null`。无活动到阈值时发提醒事件与系统通知（M13 5.6），由人停止或继续，不自动中止（R20）。
- 项目室的评审：`remind`，`hardLimitMs = null`。运行测试的评审可能很久没有输出。
- 其他调用：默认值不变。
- 2 小时硬上限在 `cli-adapters.cjs:396-399` 与 `cli-acp-runner.cjs:987-990` 两处，都改为读取 `hardLimitMs`。

## 9. 用量（M10）

按优先级取得每次调用的 token 数：

1. **ACP `usage_update` 事件**：在 ACP 运行器中直接取得。
2. **CLI 本地日志**（参考 ccusage 的做法）：按这次调用的原生会话号读取 CLI 自己写的日志。
   - Claude：`~/.claude/projects/<编码后的工作目录>/<会话号>.jsonl`。
   - Codex：`~/.codex/sessions/<年>/<月>/<日>/` 下与会话号对应的文件。
   - 具体的文件名与字段，以第 7 节实测时的 CLI 版本为准，写入解析器的测试样例。
3. 都没有：显示「不可用」。

规则：

- 只在 main 中读取，只提取用量字段，会话内容不进入 renderer，也不进入任何 Meldwork 的存储。
- 读取路径限定在这些目录下，按会话号定位，不遍历用户的其他会话。
- 费用按公开价格估算，界面标明「估算」；价格表随应用版本更新，不联网获取。
- 用量经现有的 `recordReplyUsage`（`invocation-budget.cjs:17-34`）记录：有上报值时用上报值，否则按现有方式估算并标明。

## 10. 能力登记

每种 Agent 在目录（`CATALOG.md` 对应的数据）中登记以下能力，席位配置界面据此提示（R16）：

| 能力 | 含义 |
| --- | --- |
| `fullTrace` | 能提供完整轨迹（ACP 通道，或回退通道中映射器已支持） |
| `readExec` | `read-exec` 已实测支持 |
| `midTurnCancel` | 一轮中途取消后能干净结束 |
| `writeSessionContinuity` | 在可能写入的调用中能保持会话（3.9） |
| `usage` | 能取得 token 数 |
| `managedProcess` | 当前平台上 A14 已实现（macOS、Linux 为是；Windows 在辅助程序通过前为否） |

## 11. 测试

- 监护程序（`desktop/test/managed-spawn.test.cjs`，真实进程）：3.6 的四个场景；Agent 退出后留下进程时，断言适配器收到的是 Agent 的真实退出码，`container-empty` 在其后到达；清理期间又派生子进程时，断言多轮清理后容器为空；`kill()` 发送 `stop` 后断言仍能得到 Agent 的退出状态；用 Electron 可执行文件与 `ELECTRON_RUN_AS_NODE` 运行；Agent 的 stdin、stdout、stderr 经监护程序透明传递，现有适配器的解析测试全部通过；Agent 的退出码与信号被如实转报；取消时对 `-pid` 发信号能结束整个容器。
- 登记表：每个状态之间注入崩溃，断言重启后 3.7 的判断正确。组号复用：旧容器清空后，用同一组号启动一个无关进程组（不带容器标记），断言恢复时不对它发任何信号、也不误报残留；组长存活且启动时间相同时整组结束；成员带本容器标记时逐个结束；读不到环境的成员不发信号并登记残留占用。
- 常驻只读 ACP：断言一轮完成后立即发出 `INVOCATION_ENDED`，进程保持存活。
- `read-exec` 评审：断言只读评审全部结束后才开始、一次一个；它改动目标文件时断言结论作废、进入评审失败关卡、其后的评审不开始；它改动 `.gitignore` 之外的其他文件时断言列为越界条目；取消时断言等容器清空后才进入下一状态。
- 常驻 ACP：可能写入的调用断言每轮新进程、`resumeSession` 被调用、轮后容器已空；只读调用断言仍复用常驻进程。
- 提示词：四层顺序；`project-room` 不附加任何后缀；缺少 `contextPackId` 时报错。
- 会话：主笔键在 `revise`、`continue`、驳回轮之间不变，过期重开后代数加 1；评审不写入 `sessions`；超长键的哈希包含项目、检查点、席位、代数，两个同种 Agent 的席位不会撞键。
- 标记：只认最后一个非空行；正文中间的标记被忽略；非法 JSON、多余字段、未知取值都按缺失处理。
- 权限：ACP `read-exec` 放行 `execute`、拒绝 `edit`；Claude、Codex 的 `read-exec` 按 6.1 实测后的参数断言。
- 看门狗：`remind` 只发提醒、不中止；`hardLimitMs = null` 时不设定时器；其他调用的默认行为不变。
- 用量：以实测的日志样例断言解析；读取范围不越出约定目录。

## 12. 对其他文档的修改

| 文档 | 修改 |
| --- | --- |
| 架构 A14 | 范围由「可写调用」改为「可能写入的调用」（`workspace-write` 与 `read-exec`）；POSIX 实现指向本文第 3 节，附实测 |
| 架构第 6 节 | 新增：可能写入的 ACP 调用不再使用常驻进程，每轮启动并恢复会话；作用于所有群聊，写入调用多出秒级的启动时间；会话策略为 `new` 的 Agent 在这类调用中每轮都是新会话 |
| 架构第 5 节 | `cli-adapters.cjs`、`cli-acp-runner.cjs` 的 `spawnFn` 换为受管理启动器；新增 `desktop/src/agents/process/` 三个文件；`agent-permission-policy.cjs` 增加 `read-exec` 分支 |
| M2 | `activeInvocations` 中记录登记表 id 的对象由「可写调用」改为「可能写入的调用」；5.1 的评审调用改为「只读评审并行，之后 `read-exec` 评审串行」；5.2 规则 5 增加 `read-exec` 评审的例外；`read-exec` 评审核对不通过时进入评审失败关卡 |
| M4/M6 | A6 的快照与越界检测覆盖 `read-exec` 调用（定稿后的补充） |
| 架构第 6 节 Known Risks | `read-exec` 评审运行期间改了又改回送审文件时，它自己读到的可能不是候选内容（6.2） |
| M13 | 席位配置按第 10 节的能力提示；「可写调用不保持会话」的提示 |

## 13. 待实测与待定

1. 监护程序在 Electron 可执行文件下运行、打包后路径（3.6）；Linux 上的 `pgrep -g` 与进程组行为。
2. Claude、Codex 的 ACP 适配器（7.1 全表）。
3. Claude print 与 Codex exec 的 `read-exec` 参数（6.1）。
4. Windows 作业对象辅助程序的实现方式（3.8）。
5. 可能写入的 ACP 调用每轮启动的实际延迟（3.9），若明显影响体验，再评估「整个检查点循环内保持常驻、循环结束时清空」的替代方案。
