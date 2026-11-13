# 模块文档：M3 席位调用适配（含 M10 用量、A14 受管理进程的实现）

第六版，2026-11-13。第六版吸收评审 r16（`docs/reviews/architecture-v5/r16-review.md`）：根进程退出与清理相互独立地上报；`exit` 与 `close` 对每个子进程恰好发出一次，拿不到真实结果、也不能确认是被清理结束时以「退出结果未知」收尾。第五版吸收评审 r15（`docs/reviews/architecture-v5/r15-review.md`）：不再用启动时间推断组号已被复用；钉子不在时平台不对任何单个进程自动发信号，一律登记残留占用、由人处理；`finalKill` 携带 Agent 根进程是否存活，清理中被一并结束的 Agent 以 `SIGKILL` 报告 `exit`。第四版吸收评审 r14（`docs/reviews/architecture-v5/r14-review.md`）：容器改回监护程序领头的进程组，监护程序作「钉子」：忽略 `SIGTERM`，先报告结果与成员清单，最后对整组 `SIGKILL`；组号在放行前落盘；适配器的终止路径改为统一经受管理的停止接口；附第三轮实测。第三版吸收评审 r13（`docs/reviews/architecture-v5/r13-review.md`）：容器改为 Agent 自己的进程组、监护程序在组外，整组原子发信号，正常清理不再逐个进程发信号；启动器的 `exit`、`close`、`container-empty` 三个事件分开定义，`close` 等输出排空；标记缺失视为身份未知；附第二轮实测与控制通道的实现约束。第二版吸收评审 r12（`docs/reviews/architecture-v5/r12-review.md`）：重启恢复先核实容器身份（容器标记与组长启动时间），只对核实属于本容器的进程发信号；`read-exec` 评审串行运行并纳入快照与核对；常驻 ACP 调用以协议的一轮完成为结束；监护程序先报告 Agent 结果、再逐个清理组内进程、最后报告容器已空。

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

- **监护程序**：`desktop/src/agents/process/meldwork-supervisor.cjs`，一个不依赖第三方包的小脚本。用 Electron 自己的可执行文件运行，环境中只为它设置 `ELECTRON_RUN_AS_NODE=1`。打包时放进 `asarUnpack`。每个可能写入的调用多一个这样的进程，内存占用为一个最小的 Node 进程。
- **受管理启动器**：`desktop/src/agents/process/managed-spawn.cjs`，替换现有调用中的 `spawnFn`，返回的 `child` 带 `stdin`、`stdout`、`stderr`、`pid`，事件语义见 3.4，另提供受管理的停止接口 `stop({ force })`。
- **进程登记表**：`desktop/src/agents/process/process-registry.cjs`，文件 `meldwork-private/process-registry.json`。
- **适配器的终止路径必须一起修改**，不是只换 `spawnFn`。现有代码在 `cli-adapters.cjs` 的 `signalProcessTree`（`:328-338`）和 `cli-acp-runner.cjs` 的 `terminateChild`（`:479-505`）里直接调用全局的 `process.kill(-child.pid, signal)`，成功后立即返回，不经过启动器。`child.pid` 现在是监护程序，这样发出的信号会绕过 3.4 的停止协议：`SIGTERM` 被监护程序忽略，随后的 `SIGKILL` 会在它报告 Agent 结果之前就把它杀死。所以在 `cli-process-support.cjs` 新增 `terminateAgentProcess(child, { force })`：对受管理的 `child` 调用 `child.stop({ force })`；对不受管理的 `child`（只读调用）保持现有的信号与 Windows 进程树逻辑。两个适配器的取消、超时与强制终止都改为调用它，不再直接调用 `process.kill(-child.pid, …)`。

**容器是监护程序领头的进程组，监护程序是组的「钉子」。** main 以 `detached` 方式启动监护程序，Node 为它调用 `setsid()`：监护程序成为一个新会话、新进程组的组长，组号就是它的 pid；它在同一个组里启动 Agent，Agent 的子进程默认也在这个组里。

- 监护程序活着，这个组就不可能清空，组号就不可能被复用。所以只要在监护程序存活时发出，对 `-pgid` 的任何信号都只会到达这个容器，等待期间也不存在组号复用的窗口。
- 监护程序忽略 `SIGTERM`，只有 `SIGKILL` 能结束它。所以清理时对整组发 `SIGTERM` 不会结束它，钉子一直在；最后一步对整组发的 `SIGKILL` 会连同它一起结束。这个 `SIGKILL` 发出时监护程序仍然存活，组号仍然被钉住，信号是原子的。在这之后不再发任何信号。
- 组号在启动 Agent 之前就已经确定（就是监护程序的 pid），所以容器身份可以在放行之前落盘。

### 3.3 启动握手（POSIX）

```
main                                    监护程序（新会话、新进程组的组长）       Agent（同一个组）
 │ 1 生成容器标记，登记「启动中」，落盘
 │ 2 启动监护程序（detached），stdio = 三路 pipe，fd 3 = 控制通道
 │ 3 取组号（= 监护程序 pid）与组长启动时间，登记「运行中」，落盘
 │ 4 fd 3：{"go": 命令, 参数, 环境}  ──→│
 │                                      │ 5 剔除 ELECTRON_RUN_AS_NODE，加入 MELDWORK_CONTAINER，
 │                                      │   在同一个组里启动 Agent，stdio 继承 ─────────────→ 开始工作
 │                                      │   随后关闭自己持有的 fd 0、1、2
```

- 第 4 步之前，监护程序不执行任何 Agent 代码。main 在第 4 步之前死亡时，fd 3 关闭，监护程序直接退出，Agent 从未开始。
- 容器的组号与组长启动时间在第 3 步、也就是放行之前落盘。所以任何能写文件的 Agent 及其子进程（包括用 `env -i` 清空了环境的子进程），所在的组号都已经登记。这正是 A14「身份落盘后才放行」的保证。
- **容器标记**：第 1 步生成的随机值，以环境变量 `MELDWORK_CONTAINER=<随机值>` 传给 Agent，子进程默认继承。用于组长已经不在时，恢复时辅助核实成员（3.7）。
- 命令、参数与环境经 fd 3 传递，不出现在监护程序的命令行里。
- 监护程序**从不向 fd 1、2 写任何内容**，它们是 Agent 的输出通道；它的消息只经 fd 3。第 5 步之后它关闭自己持有的 fd 0、1、2，使 stdout、stderr 的结束只取决于 Agent 及其子进程。

### 3.4 清理、结束的确认与三个事件

**清理顺序**。Agent 根进程退出、收到 `stop`、或 fd 3 关闭（main 死亡）时，监护程序：

1. **根进程的退出独立上报**：无论处于清理的哪一步、清理因何开始，只要监护程序观察到 Agent 根进程退出（它的退出回调被调用），就立即经 fd 3 报告 `{"agentExit": {...}}`，最多一次。清理由根进程退出触发时，这就是第一步。
2. `kill(-pgid, SIGTERM)`。监护程序自己忽略它，钉子仍在。
3. 等待 2.5 秒（沿用 `DEFAULT_RUN_ABORT_GRACE_MS`）。期间监护程序始终存活，组号始终被钉住。
4. 先让出一次事件循环（等待已经到达、尚未处理的子进程退出事件被处理，例如 Agent 刚响应 `SIGTERM` 退出），若因此观察到根进程退出，按第 1 步先报告 `agentExit`。然后经 fd 3 报告 `{"finalKill": {"agentAlive": <此刻尚未观察到根进程退出>, "members": [...]}}`。成员清单（进程 id 与启动时间）只用于诊断显示，不用于判断容器是否已空：清单之后、`SIGKILL` 之前，组内仍可能派生新进程。
5. `kill(-pgid, SIGKILL)`：最后一步，连同监护程序自己一起结束。

**结束的确认**（由 main 完成，因为监护程序已经不在了）：main 收到过 `finalKill`，并且监护程序已经退出，然后检查 `kill(-pgid, 0)`：

- 返回 `ESRCH`：容器已空。最后的 `SIGKILL` 是对整组发出的，发出时钉子存活，清单之后才派生的进程同样在组内、同样被结束，所以这个结果就是结论。
- 仍能找到成员：**不推断原因**。它们可能是原容器中处于不可中断睡眠、暂未退出的进程，也可能是组号在极短时间内被复用后的无关进程，平台无法区分。按 3.7 的逐个成员判断：全部能证明不属于这个容器（启动时间早于记录创建时间减 1 秒）才算已空；否则不发任何信号，记录保持「结束中」，租约保持「待释放」，按 3.7 第 4 步登记残留占用并显示诊断。

**取消**：main 调用 `child.stop({ force })`，经 fd 3 发送 `{"stop": true}`，监护程序从第 2 步开始；`force` 时跳过第 3 步的等待。

**监护程序意外退出**（没有发出 `finalKill` 就退出了，例如崩溃，或被外部的 `SIGKILL` 结束）：钉子已经没了，组号随时可能被复用，main **不对 `-pgid`、也不对任何单个进程发信号**。main 立即检查 `kill(-pgid, 0)`：`ESRCH` 即为已空；否则按 3.7 第 4 步登记残留占用，界面列出组内进程，由人处理（M13 5.7）。

**启动器的三个事件**：

| 事件 | 含义 | 使用者 |
| --- | --- | --- |
| `exit` | Agent 根进程的终止结果。监护程序退出后，按下面的顺序取第一个成立的：① 收到过 `agentExit`：它报告的真实退出码与信号；② 收到过 `finalKill` 且 `agentAlive` 为真：Agent 是在清理最后一步与监护程序一同被整组 `SIGKILL` 结束的（例如它忽略了 `SIGTERM`，或 `force` 取消跳过了等待），以 `{ code: null, signal: 'SIGKILL', terminatedBy: 'cleanup' }` 发出；③ 收到过 `finalKill` 但 `agentAlive` 为假（根进程已经退出，但退出报告没能在监护程序结束前送出）：以失败 `LOCAL_AGENT_EXIT_UNKNOWN` 发出，附 `terminatedBy: 'cleanup'`；④ 没有 `finalKill`（监护程序意外退出）：以失败 `LOCAL_AGENT_SUPERVISOR_LOST` 发出。`agentExit` 若在监护程序退出前到达，立即发出 `exit`，不等监护程序退出 | 现有适配器 |
| `close` | 在 `exit` 之后，并且 stdout 与 stderr **都已读到结束**。附同样的退出码与信号 | 现有适配器：它们在 `close` 时结束解析，所以必须等输出排空，否则可能漏掉最终回答、结尾标记或诊断 |
| `container-empty` | 上面「结束的确认」通过 | M3 第 5 节、M2 的租约 |

**不变量**：对每个已启动的受管理子进程，启动器**恰好发出一次** `exit`、**恰好一次** `close`，且 `close` 在 `exit` 之后。上表的四种来源覆盖了监护程序退出时的全部组合：有没有 `agentExit`，有没有 `finalKill`，`agentAlive` 的真假。任何拿不到真实结果、也不能确认是被清理结束的情况，都落在 ③ 或 ④ 的「结果未知」失败上，不会让适配器无限等待。被取消的调用结果为失败时，M2 照常按 `cancelled` 处理（第 5 节），不会把未知结果当成成功。

清理的最后一步会结束所有持有输出管道的进程，所以 `close` 通常在清理完成时到达。确认不了容器已空、仍有进程持有管道时，`exit` 之后最多等 5 秒，再关闭 main 一侧的读取，发出 `close` 并附 `outputTruncated: true`，适配器照常解析已读到的内容；租约仍按「待释放」保持，直到 `container-empty`。

### 3.5 监护

监护程序以非阻塞的流读取 fd 3（`net.Socket({ fd: 3 })`）。main 死亡（崩溃、被强制结束）时 fd 3 关闭，监护程序按 3.4 的清理顺序结束整个容器（没有人接收报告，跳过第 1、4 步的报告）。断电时所有进程本来就不存在。

### 3.6 实测（macOS）

2026-11-13 在 Darwin 24.6、Node 25 上用原型验证（临时目录，未进入仓库，实验进程均已清理）。模拟 Agent 是一个 shell 脚本：启动一个每 0.2 秒写一次文件的后台进程（模拟测试或构建），主循环结束时输出 `FINAL-ANSWER`。前后共三轮原型，最终采用第三轮的结构（3.2–3.5）：

| 场景 | 第一轮：监护程序在组内，先清组后退出 | 第二轮：监护程序在组外 | 第三轮：监护程序在组内作钉子，先报告、最后整组 `SIGKILL` |
| --- | --- | --- | --- |
| A：放行前 main 死亡 | Agent 从未开始 | 同左 | 放行前逻辑未变，同左 |
| B：放行后对 main 发 `SIGKILL` | 整组被结束，写入停止 | 整组被结束，写入停止 | 整组被结束，写入停止 |
| C：根进程退出、留下后台进程 | 留下的进程被结束 | `agentExit` 先于清理到达 | 事件依次为：stdout 输出 `FINAL-ANSWER` → `agentExit` → `finalKill` → stdout 结束 → 监护程序以 `SIGKILL` 退出，容器已空；写入停止 |
| 逃逸：子进程 `setsid()` / `setpgid` | 继续写入（已知限制） | 同左 | 同左 |

第二轮放弃的原因：Agent 先运行、组号后落盘，留下了评审 r13 指出的窗口。第一轮的问题只是报告与清理的顺序（评审 r12）。第三轮同时解决了两者。

实现约束（第二轮发现）：用 `fs.createReadStream` 读取 fd 3 是线程池中的阻塞读，会使监护程序的 `process.exit` 挂起不退出；必须用 `net.Socket({ fd: 3 })`。

仍需在正式实现中验证：用 Electron 可执行文件加 `ELECTRON_RUN_AS_NODE` 运行监护程序（原型用的是系统 Node）；打包后的路径；Linux。

### 3.7 进程登记表与启动恢复

**记录**：调用 id、所属群聊、项目室（如有）、工作目录真实路径、权限、写入声明（M6 A2）、容器标记、容器的组号与组长（监护程序）启动时间、最近一次 `finalKill` 报告的成员清单、记录创建时间、状态（启动中 / 运行中 / 结束中 / 已结束）。整个文件原子写入、`0600`。已结束的记录保留 24 小时供诊断，之后清除。

**启动恢复**（M4/M6 C 第 3 步）。原则：**只对能证明属于这个旧容器的进程发信号；证明不了的不发信号，也不当作「不属于」，而是作为「身份未知」登记残留占用。**

对每条未结束的记录：

1. 「启动中」且没有组号：Agent 从未开始（3.3：组号在放行之前落盘，没有组号就没有放行），记为已结束。
2. 「结束中」且有 `finalKill` 清单：按 3.4「结束的确认」复查清单中的进程，不对 `-pgid` 发信号。
3. 其余有组号的记录：先判断这个组号现在指向的是不是原来的组。

| 观察 | 判断 | 处理 |
| --- | --- | --- |
| 组内没有成员（`kill(-pgid, 0)` 为 `ESRCH`） | 已空 | 记为已结束 |
| 组长（pid = 组号）存活，它的组号等于这个组号，启动时间与记录相同 | 原来的组：组长就是当年的监护程序，它钉住了组号；组属于它的会话，其他会话的进程无法加入，所以组内成员都属于这个容器 | 旧的 main 死亡时 fd 3 已经关闭，所以这个监护程序此刻正在执行 3.5 的清理。main **不发任何信号**，只等它自己完成：它的最后一步是对整组的 `SIGKILL`，发出时它仍存活、钉子有效。main 发信号反而可能撞上「它刚完成清理、组号随即被复用」的瞬间。最多等 10 秒，组长消失后按 3.4 确认已空；10 秒后组长仍在（监护程序挂起），不发信号，进入第 4 步登记残留占用，并显示诊断 |
| 组长存活，它的组号等于这个组号，启动时间不同 | 组号已被复用：原来的组曾经清空，这是一个新的无关进程组 | 不发信号；原容器已空，记为已结束 |
| 组长不存在（或该 pid 属于别的组），组内有成员 | 可能是原来的组（组长已退出、成员仍在），也可能是复用后组长又退出的无关组。逐个成员判断，见下表 | — |

逐个成员判断：

| 成员的情况 | 判断 |
| --- | --- |
| 启动时间早于「记录创建时间减 1 秒」 | 不属于这个容器（容器创建之前就已存在的进程不可能是它的成员）。减 1 秒是因为 macOS 上 `ps` 报告的启动时间精度为秒，同一秒内启动的成员不能据此排除 |
| 环境可读，带有本容器标记 | 属于这个容器 |
| 环境可读，没有本容器标记 | **身份未知**。Agent 可以用 `env -i` 等方式清空子进程的环境，标记缺失不能证明它不属于这个容器 |
| 环境不可读 | 身份未知 |

   - 所有成员都能证明不属于这个容器：原容器已空，记为已结束。
   - 否则（有属于这个容器的成员，或有身份未知的成员）：**不发任何信号**，进入第 4 步。

   为什么连核实属于本容器的成员也不自动结束：组长已经不在，没有钉子；对单个进程发信号时，「核实」与「`kill`」之间进程可能退出、进程 id 被复用，信号就会发给无关进程。重新比对启动时间只能缩小这个窗口，不能消除它。macOS 没有稳定的进程句柄，重启后的 main 也不是这些进程的父进程，无法持有它们。所以平台不自动结束它们，而是交给人：界面列出这些进程（进程 id、命令、启动时间、是否带本容器标记），人手动结束后复核。Linux 上可以用 pidfd（`pidfd_open` 与 `pidfd_send_signal`）做到无竞态的结束，但 Node 没有提供，需要原生模块，留作以后的改进。
4. 确认不了已空的，调用 M6 的 `registerResidual`，声明取自记录（M4/M6 A5）。界面列出相关进程；人手动结束它们后选择「我已手动结束」，或在确认它们与 Meldwork 无关后选择「这些进程与 Meldwork 无关」，平台都再按本节复核一次（不发信号），复核通过才解除残留占用（M13 5.7）。只有组长存活且启动时间相符的情况（钉子仍在），「重试结束」才会由平台发信号：等它自己完成清理，见上表。

这是有意的保守取舍：宁可多一条需要人处理的残留占用，也不对无法证明归属的进程发信号，更不在无法证明的情况下放开写入保护。读取环境的方式：macOS 上读取同一用户进程的参数与环境（`sysctl KERN_PROCARGS2`，与 `ps -E` 同源），Linux 上读取 `/proc/<pid>/environ`。

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

- 监护程序（`desktop/test/managed-spawn.test.cjs`，真实进程）：3.6 的四个场景；Agent 退出后留下进程时，断言适配器收到的是 Agent 的真实退出码，事件顺序为 `exit` → 输出排空 → `close` → `container-empty`（`close` 与 `container-empty` 可以同时到达）；Agent 在退出前写出大量输出、`agentExit` 先于输出到达时，断言 `close` 之前已读到全部输出与结尾标记；容器卡住时断言 5 秒后 `close` 附 `outputTruncated`、租约仍为「待释放」；`kill()` 发送 `stop` 后断言仍能得到 Agent 的退出状态；监护程序从不向 fd 1、2 写入；控制通道关闭后监护程序能正常退出；用 Electron 可执行文件与 `ELECTRON_RUN_AS_NODE` 运行；Agent 的 stdin、stdout、stderr 经监护程序透明传递，现有适配器的解析测试全部通过；Agent 的退出码与信号被如实转报；取消时对 `-pid` 发信号能结束整个容器。
- 登记表：每个状态之间注入崩溃，断言重启后 3.7 的判断正确。组号复用：旧容器清空后，用同一组号启动一个无关进程组，断言恢复时不对它发任何信号；组长存活、组号与启动时间相同时整组结束；组长已退出时，带本容器标记的成员不被自动结束、登记残留占用；用 `env -i` 启动、环境可读但没有标记、且启动时间晚于记录的成员，断言不发信号、登记残留占用；启动时间早于记录的成员断言判为不属于；放行之前崩溃时，断言没有组号的记录直接记为已结束、Agent 从未开始。
- 钉子：宽限期间人为让组内其他成员全部退出，断言最后的 `SIGKILL` 仍只到达这个容器（组长存活）；监护程序在发出 `finalKill` 之前被杀死时，断言 main 不再对 `-pgid` 或任何单个进程发信号，登记残留占用。
- `finalKill` 之后的窗口：报告清单后让一个旧成员派生子进程再退出，接着在整组 `SIGKILL` 之前让监护程序被外部 `SIGKILL` 结束，断言新子进程不会被判为「组号复用」、租约不释放、登记残留占用。
- 恢复时组长已不在、组内有带本容器标记的成员：断言平台不发任何信号，登记残留占用并列出这些进程；人手动结束后选择「我已手动结束」，断言复核通过后才解除。
- 强制结束：Agent 忽略 `SIGTERM` 时，断言 `exit` 以 `signal: 'SIGKILL'`、`terminatedBy: 'cleanup'` 到达，`close` 在输出排空后到达，适配器得到的是「被终止」而不是成功；`force` 取消同样。
- 响应 `TERM` 后、退出回调处理前强制清理：取消后让 Agent 响应 `SIGTERM` 立即退出，同时人为延迟监护程序处理子进程退出事件，使它在处理之前进入最后清理。断言两种结果之一：监护程序在第 4 步让出事件循环后报告了 `agentExit`，`exit` 带真实结果；或者 `finalKill` 报告 `agentAlive: false`，`exit` 以 `LOCAL_AGENT_EXIT_UNKNOWN` 到达。两种情况下 `close` 都随后到达，适配器不挂起。
- 不变量：随机组合「有无 `agentExit`」「有无 `finalKill`」「`agentAlive` 真假」「`agentExit` 早于或晚于监护程序退出」，断言 `exit` 与 `close` 各恰好一次且顺序正确。
- 适配器的终止路径：断言 `cli-adapters.cjs` 与 `cli-acp-runner.cjs` 的取消、超时、强制终止都经过 `terminateAgentProcess`，受管理调用中不出现对 `-child.pid` 的直接信号；只读调用的终止行为不变。
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
