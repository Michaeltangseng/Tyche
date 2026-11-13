# 任务单：里程碑 0 实测

## 目标

验证模块文档中尚未实测的前提。本里程碑**不写应用代码**，只写实测脚本、做实验、写报告。实测结论决定后面的里程碑能否按现在的设计实现。

## 前置条件

- 已读 `docs/handoff-guide.md`。
- 本机有 macOS（主要环境）。Linux 一项需要一台 Linux 机器或虚拟机；没有的话在报告中写「未完成」，不要跳过不提。
- 本机已安装并登录 Claude Code 与 Codex CLI（第 3、4 项需要）。

## 必读

- `docs/modules/m3-seat-invocation.md`：第 3 节全部（尤其 3.2–3.6）、6.1、7.1、3.9、第 13 节。
- `docs/modules/m4-m6-versions-and-writes.md`：B1、B2、B3、B3.4、B3.5、F。

## 范围

| 包括 | 不包括 |
| --- | --- |
| `desktop/spikes/` 下的实测脚本 | `desktop/src/` 的任何改动 |
| `docs/spikes/milestone-0-results.md` 实测报告 | `desktop/test/` 下的任何文件 |
| 按结论修订模块文档（需要人确认后再改，见任务 8） | 新的依赖（实测 ACP 适配器所需的 npm 包装在临时目录，不写进 `package.json`） |

## 任务

### 任务 0.1 准备

1. 新建目录 `desktop/spikes/`，在其中放一个 `README.md`，写明：这里是里程碑 0 的实测脚本，手动运行，不属于应用，不被测试收集。
2. 新建 `docs/spikes/milestone-0-results.md`，按下面的模板为任务 0.2–0.7 各留一节：

```
## <编号> <实测项>

环境：macOS 版本 / Electron 版本 / Node 版本 / CLI 版本
步骤：<可以照着重做的步骤>
结果：<观察到的原始输出，必要时截取>
结论：通过 / 不通过 / 部分通过
对文档的影响：无 / <哪个文档哪一节需要怎么改>
清理：<确认实验进程与临时目录已清理的命令与输出>
```

### 任务 0.2 监护程序在 Electron 下运行

依据 M3 3.2–3.6。原型已在系统 Node 上验证过，这里要在 **Electron 的可执行文件**上、并且在**打包后的应用**里重做。

1. 写 `desktop/spikes/supervisor-prototype.cjs`：监护程序原型，行为严格按 M3 3.3–3.5：
   - 忽略 `SIGTERM`（`process.on('SIGTERM', () => {})`）。
   - 用 `new net.Socket({ fd: 3, readable: true, writable: true })` 读控制通道，**不要**用 `fs.createReadStream`。
   - 收到 `{"go": ...}` 之前不启动任何东西；控制通道在放行前关闭就直接 `process.exit(0)`。
   - 放行后用 `child_process.spawn` 在**同一个进程组**里启动 Agent（不设 `detached`），`stdio` 为 `['inherit', 'inherit', 'inherit']`，只传 0、1、2。启动前从环境中删除 `ELECTRON_RUN_AS_NODE`，加入 `MELDWORK_CONTAINER=<随机值>`。
   - 启动 Agent 后关闭自己的 fd 0、1、2（`fs.closeSync(0)`、`fs.closeSync(1)`、`fs.closeSync(2)`），之后只经 fd 3 写消息。
   - 清理顺序按 M3 3.4：报告 `agentExit` → `process.kill(-process.pid, 'SIGTERM')` → 等 2.5 秒 → 让出一次事件循环 → 报告 `finalKill`（含 `agentAlive`）→ `process.kill(-process.pid, 'SIGKILL')`。
2. 写 `desktop/spikes/fake-agent.sh`：启动后先输出一行 `STARTED`，启动一个每 0.2 秒向 `$OUT/bg` 追加一行的后台循环，主循环跑 `$LOOPS` 次（每次 0.2 秒）后输出 `FINAL-ANSWER` 并退出。
3. 写 `desktop/spikes/run-supervisor-scenarios.cjs`：一个主进程脚本，用参数选择场景，按 M3 3.6 的场景 A、B、C 与「逃逸」各跑一次：
   - A：落盘身份（写一个 JSON 文件模拟）之后、发送放行之前，对自己发 `SIGKILL`。断言：`$OUT/started` 不存在；进程组为空。
   - B：放行 1.5 秒后对自己发 `SIGKILL`。断言：3 秒后 `$OUT/bg` 不再增长；进程组为空。
   - C：主进程保持运行，`LOOPS=3`。断言：收到的消息顺序为 stdout `FINAL-ANSWER` → `agentExit` → `finalKill` → stdout 结束 → 监护程序以 `SIGKILL` 退出；进程组为空；`$OUT/bg` 不再增长。
   - 逃逸：假 Agent 用 `perl -e 'use POSIX; POSIX::setsid(); ...'` 让一个子进程脱离进程组。断言：它在 Agent 结束后**仍在写**（这是已知限制）。实验后手动结束它。
   - 每个场景结束都运行 `pgrep -fl "supervisor-prototype|fake-agent"`，结果为空才算清理干净。
4. 分别用三种方式运行监护程序，每种都跑全部场景：
   - 系统 Node：`node`。
   - Electron 可执行文件：`ELECTRON_RUN_AS_NODE=1 <desktop/node_modules/electron 的可执行文件> supervisor-prototype.cjs`。
   - 打包后的应用：临时在 `desktop/package.json` 的 `build.asarUnpack` 中加入 `desktop/spikes/supervisor-prototype.cjs` 的路径、执行 `npm --prefix desktop run pack`，用打包产物里的 Electron 可执行文件与解包后的脚本路径运行。**实验完成后把 `package.json` 改回原样**，不要提交这个改动。
5. 任何一个场景的结果与断言不符：在报告中写「不通过」，附原始输出，**停下来问**。

### 任务 0.3 Linux

在 Linux 上用系统 Node 与 Electron 各跑一遍任务 0.2 的场景，另外验证：

- `pgrep -g <pgid>` 可用。
- 能读取同一用户进程的 `/proc/<pid>/environ`，并能找到 `MELDWORK_CONTAINER`。
- 用 `env -i` 启动的子进程，环境中确实没有这个变量（验证 M3 3.7「标记缺失视为身份未知」的前提）。

没有 Linux 环境：报告中写「未完成：没有 Linux 环境」。

### 任务 0.4 Claude、Codex 的 ACP 适配器

依据 M3 7.1 的表格，逐项实测。

1. 在 `os.tmpdir()` 下的临时目录里安装 `@agentclientprotocol/claude-agent-acp` 与 `@agentclientprotocol/codex-acp`，记录版本号。**不要写进 `desktop/package.json`。**
2. 写 `desktop/spikes/acp-adapter-check.cjs`：用 `desktop/node_modules/@agentclientprotocol/sdk`（0.23.0）作为客户端，连接适配器进程，逐项检查 M3 7.1 的 8 项：
   - 登录：不要求重新登录。
   - 权限：发送一个会触发读取、执行、编辑三种工具的请求；客户端按 `read-only` / `read-exec` / `workspace-write` 三种策略分别放行或拒绝（参照 `desktop/src/agents/agent-permission-policy.cjs` 的 `automaticPermissionResponse`）；断言被拒绝的工具确实没有执行（检查文件是否被修改）。**`codex-acp` 要专门检查**：在它的默认审批模式下，工具调用是否都经过客户端审批，有没有绕过。
   - 会话：第一轮新建会话；结束进程；新进程中 `resumeSession` 同一会话，第二轮问「上一轮你说了什么」，确认上下文保留。
   - 取消：一轮中途取消，进程按预期结束。
   - 长时间运行：一个运行 2 小时以上的任务（例如每分钟写一行的脚本），确认适配器自身不中断。这一项可以与其他项并行。
   - 轨迹：记录 `tool_call`、`tool_call_update`、`agent_thought_chunk` 的原始事件，确认带有完整的命令、参数与输出。
   - 用量：是否有 `usage_update`。
   - SDK 版本：适配器要求的 SDK 版本是否与 0.23.0 兼容。
3. 每一项在报告中单独记录结论。

### 任务 0.5 `read-exec` 参数

依据 M3 6.1。

1. Claude print：用 M3 6.1 中「候选」一栏的参数运行 `claude --print`，让它：读一个文件、运行 `ls`、运行一个写文件的命令（`echo x > out.txt`）、用编辑工具改一个文件。记录哪些成功、哪些被拒绝。注意 M3 6.1 的提醒：`--disallowedTools` 中不能写任何 `Bash` 规则。
2. Codex exec：用 `--sandbox read-only` 做同样的四件事，另外运行一个需要写临时文件的测试命令（例如 `node -e "require('fs').writeFileSync(require('os').tmpdir()+'/x','1')"`），记录结果。
3. 结论按 M3 6.1 的口径：「能运行命令、编辑类工具被拒绝」才算支持 `read-exec`。命令能写文件是预期的（M3 3.1），不算失败，但要记录。

### 任务 0.6 可写 ACP 调用每轮启动的延迟

依据 M3 3.9。对现有的每种 ACP Agent（DeepSeek、Hermes、Kimi、MiMo、OpenCode，以及任务 0.4 通过的 Claude、Codex）：

1. 测量「启动 ACP 进程 → `initialize` → `resumeSession` → 第一个事件」的耗时，各测 5 次取中位数。
2. 与「常驻进程中直接发送下一轮」的耗时对比。
3. 记录每种 Agent 的会话策略是否为 `new`（查 `desktop/src/agents/cli/cli-invocations.cjs` 中的 `acpSessionStrategy`），这类 Agent 在可写调用中每轮都是新会话。

### 任务 0.7 影子仓库

依据 M4/M6 B1、B3、B3.4、B3.5。

1. 写 `desktop/spikes/shadow-git-check.cjs`，在一个**复制出来的**工作目录上（不要直接对真实仓库操作）按 M4/M6 B1 的参数与环境创建影子仓库，执行 B3.1 的快照步骤。
2. 选三个真实仓库复制到临时目录：一个含大量小文件（例如 10 万个以上的文件）、一个含大的二进制文件、一个使用 Git LFS。对每个：
   - 记录首次快照与第二次（无改动）快照的用时。
   - 修改 10 个文件后再快照，记录用时。
   - 记录影子仓库的磁盘占用。
3. 原始字节：在工作目录放 `.gitattributes`（`*.txt text eol=lf`）和一个 CRLF 文件，按 M4/M6 B1 写 `info/attributes` 后快照，用 `git cat-file blob` 确认保存的是 CRLF；把文件改成 LF，确认 `git diff --quiet` 报告差异。
4. 用 `git --version` 记录 macOS 自带 git 的版本，确认 ≥ 2.32。
5. 与 M4/M6 B3.4 的默认上限（60 秒、20 万个文件、单文件 50 MB）对比，在报告中给出建议值。

### 任务 0.8 汇总与文档修订

1. 在报告开头写一个总表：每个实测项一行，结论、对文档的影响。
2. 对「对文档的影响」不为「无」的每一项，写出**建议**的修改（哪个文件、哪一节、改成什么），**不要直接改模块文档**。等人确认后再改。
3. 按交接手册第 6 节的格式汇报。

## 验收

| 项 | 标准 |
| --- | --- |
| 报告 | `docs/spikes/milestone-0-results.md` 覆盖任务 0.2–0.7 的每一项，每项都有环境、步骤、结果、结论、清理 |
| 清理 | 每项都给出 `pgrep` 等清理检查的输出；`desktop/package.json` 与实验前相同（`git diff desktop/package.json` 为空） |
| 不越界 | `git status` 中只有 `desktop/spikes/`、`docs/spikes/` 下的新文件 |
| 文档修订建议 | 每条影响都有具体的修改建议 |

需求追踪：R16、R20、R21、R26。

## 停下来问的情况（除交接手册第 5 节之外）

- 任务 0.2 的任何场景在 Electron 或打包后的应用中不通过。
- `codex-acp` 在默认审批模式下有工具调用绕过了客户端审批。
- 任何实测需要修改 `desktop/src/` 才能进行。
