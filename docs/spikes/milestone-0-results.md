# 里程碑 0 实测报告

状态：进行中。日期、环境与逐项结果在完成后补齐。

本报告验证各模块文档中尚未实测的前提。结论决定后续里程碑能否按现在的设计实现；需要修订模块文档的条目只写建议，经人确认后再改。

## 总表

| 编号 | 实测项 | 结论 | 对文档的影响 |
| --- | --- | --- | --- |
| 0.2 | 监护程序在 Electron 下运行（含打包后） | **不通过**：系统 Node 与开发用 Electron 通过；打包后无法以 Node 运行 | 建议改为随应用分发的独立小程序（M3 3.2）；M3 3.3 补充 fd 0/1/2 的处理约束 |
| 0.3 | Linux 上的进程组、`pgrep -g`、`/proc/<pid>/environ` | **未完成**：没有 Linux 环境（用户明确不需要容器） | 无（Linux 上 A14 的实现验证留待有环境时进行） |
| 0.4 | Claude、Codex 的 ACP 适配器 | **部分通过**：登录、权限、会话、取消、轨迹、用量、SDK 兼容已测；2 小时长跑后台进行中 | 建议 M3 7.1 增加「必须显式设置会话模式」与 SDK 兼容性说明 |
| 0.5 | Claude print、Codex exec 的 `read-exec` 参数 | **通过**（Claude 需去掉不存在的 `--permission-mode default`） | 建议更新 M3 6.1 的 Claude 候选参数与提示词传递方式 |
| 0.6 | 可写 ACP 调用每轮启动的延迟 | **部分通过**：Claude/Codex 已测；DeepSeek 无 `acp` profile，其余 ACP Agent 未安装 | 建议把实测值写入 M3 3.9；DeepSeek 等仍待有环境时补测 |
| 0.7 | 影子仓库 | 待测 | 待定 |

## 0.2 监护程序在 Electron 下运行

环境：macOS Darwin 24.6.0（arm64）；系统 Node v25.2.0；Electron 39.8.10（`desktop/node_modules/electron`）；打包产物 `desktop/dist/mac-arm64/Meldwork.app`；git 2.39.5。

步骤：

1. 写 `desktop/spikes/supervisor-prototype.cjs`：按 M3 3.2–3.5 实现监护程序；`net.Socket({ fd: 3 })` 控制通道；放行前不启动 Agent；Agent 在同一个进程组内启动；清理顺序为 `agentExit` → 整组 `SIGTERM` → 2.5 秒 → `finalKill` → 整组 `SIGKILL`。
2. 写 `desktop/spikes/fake-agent.sh`：输出 `STARTED` 并写 `$OUT/started`；启动一个每 0.2 秒写 `$OUT/bg` 的后台循环（忽略 `SIGTERM`，用于验证最后的整组 `SIGKILL`）；主循环结束后输出 `FINAL-ANSWER`；`ESCAPE=1` 时用 `perl` + `setsid()` 派生一个脱离进程组的写进程。
3. 写 `desktop/spikes/run-supervisor-scenarios.cjs`：编排器为每个场景启动一个子进程扮演应用 main；A 在身份落盘后、放行前让 main 自杀；B 在放行 1.5 秒后让 main 自杀；C 让 main 保持运行并记录事件顺序；escape 在 C 的基础上验证脱离进程组的进程继续写文件。
4. 用三种运行方式跑全部四个场景：系统 `node`、Electron 可执行文件（`ELECTRON_RUN_AS_NODE=1`）、打包后的应用。打包测试前临时在 `desktop/package.json` 的 `build.files` 与 `build.asarUnpack` 中加入 `spikes/supervisor-prototype.cjs`，测试后恢复（`asarUnpack` 单独不足以把文件打进包）。

结果：

- **系统 Node：四个场景全部通过。**
  - A：`$OUT/started` 不存在；`kill(-pgid, 0)` 返回 `ESRCH`。
  - B：应用 main 死亡 3.5 秒后 `$OUT/bg` 尺寸不再增长（100 → 100）；容器已空。
  - C：事件顺序为 stdout `FINAL-ANSWER` → `agentExit` → `finalKill` → stdout 结束 → 监护程序以 `SIGKILL` 退出；容器已空；`bg` 停止增长。
  - escape：脱离进程组的 perl 进程在容器被整组 `SIGKILL` 后仍在写（90 → 115 字节，`growing: true`）；测试脚本随后结束它。
  - 每个场景的 `pgrep -fl '[s]upervisor-prototype|[f]ake-agent'` 均为空。
- **开发用 Electron 可执行文件（`ELECTRON_RUN_AS_NODE=1`）：四个场景全部通过**，结果与系统 Node 相同。
- **打包后的应用：不通过。** `desktop/scripts/after-pack.cjs` 把 Electron fuse `runAsNode` 设为 `false`（读回 fuse wire：`RunAsNode: 48`，即字符 `'0'` 禁用）。因此：
  - `ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/Meldwork" -e "process.stdout.write(...)"` 没有输出，进程保持存活（按普通 GUI 应用启动）。
  - 在打包产物中运行四个场景时，监护程序都没有以 Node 启动，Agent 从未开始；A 场景中打包进程一直存活，B/C/escape 的断言全部失败。
  - 打包产物的 Helper 可执行文件也不能替代：`Meldwork Helper` 报 `Unable to find helper app`，`Meldwork Helper (Renderer)` 无输出退出。
- **实现约束（新增发现）**：在 Node 25 / macOS 上，监护程序在放行后关闭自己的 fd 0、1、2，之后再 `spawn` 子进程（清理阶段运行 `pgrep`/`ps`）会让进程 `SIGABRT`（exit 134）。原型在关闭后立即用 `/dev/null` 重新占用 0、1、2，既不再持有 Agent 的输出管道，又避免新管道编号落进这三个空位；此后场景 C 的事件顺序完全符合 M3 3.4。

结论：**不通过（打包后一项）**。系统 Node 与开发用 Electron 的监护行为符合 M3 3.2–3.5，但打包后的应用无法用 Electron 可执行文件加 `ELECTRON_RUN_AS_NODE` 运行监护程序，M3 3.2 的前提不成立。

对文档的影响（建议，未修改）：

- `docs/modules/m3-seat-invocation.md` 3.2 与实施计划「里程碑 0」的不通过处理一致：改为**随应用分发的独立小程序**作为 POSIX 监护程序宿主，不再依赖打包后的 Electron 可执行文件；或明确打开 `runAsNode` fuse，但这会放宽现有的打包安全配置（`after-pack.cjs` 当前明确禁用），需要人裁决。
- `docs/modules/m3-seat-invocation.md` 3.3、3.6 补充：关闭 fd 0/1/2 后如果还要 `spawn`（`pgrep`/`ps`），必须以 `/dev/null` 重新占用 0、1、2，否则 Node 25 会 `SIGABRT`；或改用不依赖 `spawn` 的成员枚举方式。
- 打包测试的步骤说明补充：只把脚本加入 `build.asarUnpack` 不会让它进入应用，必须同时加入 `build.files`（本次临时加入后已恢复）。

清理：`pgrep -fl '[s]upervisor-prototype|[f]ake-agent'` 为空；失败场景保留的 `os.tmpdir()/meldwork-spike0-*` 目录已删除；`desktop/package.json` 已恢复（`git diff -- desktop/package.json` 为空）；`desktop/dist/` 已删除。

## 0.3 Linux

环境：未完成。本机是 macOS（Mac mini，Darwin 24.6.0）；用户明确不需要为此启动 Linux 容器或其他 Linux 环境。

步骤：计划在 Linux 上用系统 Node 与 Electron 重跑任务 0.2 的四个场景，并验证 `pgrep -g <pgid>`、读取同一用户进程的 `/proc/<pid>/environ`、`env -i` 启动的子进程环境中没有 `MELDWORK_CONTAINER`。本机没有 Linux 环境，未执行。

结果：未完成：没有 Linux 环境。

结论：**未完成**。Linux 上的进程组语义、`pgrep -g` 与 `/proc` 环境读取仍需在有 Linux 机器时验证；M3 3.7 的 Linux 分支在验证前不应标为已实测。

对文档的影响：无。`docs/modules/m3-seat-invocation.md` 第 13 节已把 Linux 列为待验证项，本次结果与之相符。

清理：未创建 Linux 环境；为尝试环境而启动的 Docker Desktop 已退出，拉取的测试镜像已删除。

## 0.4 Claude、Codex 的 ACP 适配器

环境：macOS Darwin 24.6.0（arm64）；Node v25.2.0；桌面端 `@agentclientprotocol/sdk` 0.23.0（客户端）；适配器临时安装在 `/tmp/meldwork-acp-spike`：`@agentclientprotocol/claude-agent-acp` 0.107.0（依赖 SDK 2.6.0）、`@agentclientprotocol/codex-acp` 2.6.0（依赖 SDK ~2.4.0）；Codex 适配器使用其依赖的 `@openai/codex`，并读取本机 `~/.codex/config.toml` 的 `cubence_codex`。适配器未写入 `desktop/package.json`。

步骤：

1. 写 `desktop/spikes/acp-adapter-check.cjs`：用桌面端 SDK 0.23.0 建立 `ClientSideConnection`，实现 `requestPermission` 与 `sessionUpdate`。权限策略按 M3 6.1：`read` 放行 read/search/fetch/think；`read-exec` 另放行 execute；`write` 全部放行。
2. 每次 `newSession` 后按需调用 `setSessionMode`（见下），再发送提示。
3. 权限：临时目录放 `sample.txt` 与 `edit-me.txt`，提示依次读文件、运行 `ls`、运行 `echo x > out.txt`、编辑 `edit-me.txt`。
4. 会话：第一轮记住 `BANANA`，关闭进程；新进程 `resumeSession` 后问同一个词。
5. 取消：运行 `sleep 30 # <随机标记>`，4 秒后 `cancel`，检查 `stopReason` 与残留进程。
6. 用量：一条 `Reply with exactly OK.` 提示，记录 `usage_update`。
7. 长跑：启动每分钟写一行的后台任务后立即返回，保持同一 ACP 进程与会话空闲 2 小时，再检查日志行数并发送第二条提示。

结果：

- **登录：通过。** 两个适配器都复用了本机已有登录，不需要重新登录或另存凭据；Claude 发送 `auth/status_update`，Codex 使用 `cubence_codex`。0.23.0 客户端对这两个通知记录 `Method not found`，不影响会话。
- **权限：通过，但必须显式设置会话模式。**
  - Claude 的 `newSession` 默认 `currentModeId = "auto"`（「Claude handles permission decisions」），不会向客户端发权限请求；实测未设置模式时直接执行了 Edit，`edit-me.txt` 变成 `NEW`。调用 `setSessionMode({ modeId: 'default' })` 后：
    - `read`：execute 与 edit 都被拒绝；`out.txt` 不存在，`edit-me.txt` 保持 `OLD`。
    - `read-exec`：execute 被批准（`out.txt` 为 `x`），edit 被拒绝（`edit-me.txt` 保持 `OLD`）。
    - `write`：两者都被批准（`out.txt` 为 `x`，`edit-me.txt` 变成 `NEW`）。
  - Codex 的 `newSession` 默认 `currentModeId = "agent"`（「Auto review」），同样绕过客户端审批：实测未设置模式时 `permissionCount = 0`，Edit 直接执行。设置 `setSessionMode({ modeId: 'read-only' })` 后，edit 会向客户端请求并被拒绝（`permissionCount = 1`，`edit-me.txt` 保持 `OLD`，`out.txt` 不存在）；`workspace-write` 模式下工作区内编辑由模式本身放行（`permissionCount = 0`，`edit-me.txt` 变成 `NEW`），符合该模式的语义。
  - **结论：接入 Claude/Codex 的 ACP 时，必须在 `newSession`/`resumeSession` 之后调用 `setSessionMode`；不能使用适配器的默认 `auto`/`agent` 模式，否则客户端审批被绕过。** Claude 的模式建议 `default`（只读/read-exec）与 `acceptEdits`（写入）；Codex 建议 `read-only` 与 `workspace-write`。
- **会话：通过。** 关闭适配器进程后，新进程 `resumeSession` 能恢复上下文：Claude 的第二轮回答为 `BANANA`；Codex 的第二轮回答包含 `BANANA`（并附带一条 `disable_response_storage` 被忽略的配置警告）。
- **取消：通过。** 两个适配器的 `prompt` 都以 `stopReason: "cancelled"` 返回；`sleep 30` 的随机标记没有残留进程。
- **轨迹：部分通过。**
  - Claude：完整。`tool_call`/`tool_call_update` 带 `rawInput`（例如 `{ "command": "ls" }`、`{ "file_path": "...", "old_string": "OLD", "new_string": "NEW" }`）、`rawOutput`（命令输出、文件内容）与 `agent_thought_chunk` 文本。
  - Codex：部分完整。`tool_call` 有标题（`Read file ...`、`List files`、`Editing files`），编辑事件带 diff 内容，`rawOutput` 有 `{ exit_code: 0 }`；但 shell 命令的 `rawInput` 为 `null`，没有命令原文。M7 需要按通道如实标注能力，不能假设所有 ACP Agent 都提供完整命令。
  - 两边都有 `agent_thought_chunk`；Claude 的思考增量数量明显更多。
- **用量：通过。** 两个适配器都发 `usage_update`：
  - Claude：`{ size: 1000000, used: 17968, _meta: { "_claude/model": "..." } }`，`promptResult.usage` 另带 input/output/cached/total。
  - Codex：`{ size: 258400, used: 19016 }`，`promptResult.usage` 带 total/input/cached/output。
- **SDK 版本：功能兼容，但有通知噪音。** 适配器依赖 SDK 2.6.0 / ~2.4.0，桌面端是 0.23.0；两边 `PROTOCOL_VERSION` 都是 1，initialize、newSession、resumeSession、prompt、cancel 全部可用。2.x 适配器会发送 0.23.0 客户端不认识的 `_auth/status_update`、`auth/status_update` 通知，桌面端 SDK 记录 `Method not found`。这不影响会话，但正式接入前要决定：升级桌面端 SDK（需回归现有 ACP Agent）或过滤未知通知。
- **2 小时长跑：后台进行中。** 已用同一脚本启动 Claude 与 Codex 的空闲长跑（后台任务每分钟写一行，2 小时后检查日志并发送第二条提示）；结果待补。

结论：**部分通过（7/8 项已测，长跑待补）**。Claude/Codex 的 ACP 适配器在功能上可用；接入时的硬性条件是显式设置会话模式，Codex 的轨迹完整度低于 Claude。

对文档的影响（建议，未修改）：

- `docs/modules/m3-seat-invocation.md` 7.1：增加「登录、权限、会话、取消、轨迹、用量、SDK」的实测结论；在「权限」一项明确写出必须调用 `setSessionMode`，默认 `auto`/`agent` 会绕过客户端审批。
- 7.1 的「轨迹」一项：Claude 完整，Codex 的 shell 命令没有命令原文（`rawInput` 为空）；M7 的能力登记按通道标注。
- 第 10 节能力登记：`fullTrace` 对 Codex ACP 不能简单标为 `true`，应按实际提供的内容标注。
- SDK 兼容：0.23.0 与适配器 2.x 在协议版本 1 上功能兼容，但会记录未知通知；升级或过滤的决定留给里程碑 5。
- 0.4 的临时安装不改 `desktop/package.json`；正式接入时由安装器按固定版本安装。

清理：测试临时目录已删除；`/tmp/meldwork-acp-spike` 保留到 0.6 完成后统一删除；2 小时长跑的两个后台进程仍在运行，结束后补结果并清理。

## 0.5 `read-exec` 参数

环境：macOS Darwin 24.6.0（arm64）；Node v25.2.0；Claude Code 2.1.318（`/Users/limu/.local/bin/claude`）；Codex CLI 0.169.0（临时安装于 `/tmp/meldwork-codex-spike`，使用本机 `~/.codex/config.toml` 的 `model_provider = "cubence_codex"`、`model = "gpt-6.1-sol"`）。全局 `codex` 命令当前不可用：npm 包装找不到平台二进制（`ENOENT .../@openai/codex-darwin-arm64/.../codex`），因此用临时安装验证。

步骤：

1. 写 `desktop/spikes/read-exec-check.cjs`：在临时目录放 `sample.txt`（`ALPHA`）与 `edit-me.txt`（`OLD`），提示模型依次做四件事：用 Read 读 `sample.txt`、用 Bash 运行 `ls`、用 Bash 运行 `echo x > out.txt`、用 Edit 工具把 `edit-me.txt` 的 `OLD` 改成 `NEW`。
2. Claude：`--print --output-format stream-json --verbose --allowedTools Read,Glob,Grep,Bash --disallowedTools Edit,Write,MultiEdit,NotebookEdit`；提示词经 stdin 传入（`--allowedTools` 是可变参数，放在末尾的提示词会被它吞掉）。
3. 另做一次聚焦测试：明确要求调用 Edit，并检查初始化事件中的工具清单。
4. Codex：`exec --sandbox read-only --skip-git-repo-check --json <提示词>`。

结果：

- **Claude：通过。**
  - Read 工具被调用；Bash 依次运行 `ls` 与 `echo x > out.txt`，`out.txt` 存在且内容为 `x`。
  - 初始化事件的工具清单中没有 `Edit`、`Write`、`MultiEdit`、`NotebookEdit`。
  - 聚焦测试中模型尝试调用 Edit，返回 `<tool_use_error>Error: No such tool available: Edit. Edit is disabled for this session, in subagents as well as here.</tool_use_error>`；`edit-me.txt` 保持 `OLD`。
  - 结论：能读、能运行命令，编辑类工具被拒绝，支持 `read-exec`。
  - **参数修正**：本机 Claude Code 2.1.318 的 `--permission-mode` 可选值为 `acceptEdits`、`auto`、`bypassPermissions`、`manual`、`dontAsk`、`plan`，**没有 `default`**。候选参数应省略 `--permission-mode`（默认模式），只用 `--allowedTools` / `--disallowedTools`；否则 CLI 会拒绝启动。另：`--allowedTools` 会吞掉后面的位置参数，提示词必须走 stdin（或在参数之间加 `--`），落地时要与现有 `promptArg: true` 的调用方式一起处理。
  - 注意：初始化工具清单仍包含 Task、CronCreate、CronDelete、Workflow、Skill 以及本机 MCP 工具；`--allowedTools` 只做预批准，不做工具裁剪。编辑类工具确实不可用。是否进一步收窄其他工具，留到里程碑 5 的权限实现中决定；容器与轮后快照仍是兜底。
- **Codex：通过。**
  - `cat sample.txt` 与 `ls` 两条命令成功执行（`command_execution`，`completed`）。
  - 编辑尝试被拒绝：stderr 为 `patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings`；`edit-me.txt` 保持 `OLD`。
  - `echo x > out.txt` 没有创建文件（`read-only` 沙箱阻止写入）；按 M3 6.1 的口径，命令能写文件不是 `read-exec` 的必要条件，记录为预期行为。
  - 结论：能运行命令、编辑类工具被拒绝，支持 `read-exec`。
- 全局 Codex CLI 的 `ENOENT` 是环境问题；临时安装的 0.169.0 证明参数本身可用。Meldwork 的安装器/能力登记应以实际可用的 CLI 为准，不在本任务内修复本机全局安装。

结论：**通过**。Claude print 与 Codex exec 都能表达 `read-exec`；Claude 的候选参数需要去掉 `--permission-mode default`。

对文档的影响（建议，未修改）：

- `docs/modules/m3-seat-invocation.md` 6.1 的 Claude 行：把 `--permission-mode default` 改为「省略 `--permission-mode`」；补充 `--allowedTools` 为可变参数、提示词需经 stdin 或 `--` 分隔的调用约束。
- 6.1 可补充：`--allowedTools` 只做预批准，不裁剪工具清单；`read-exec` 的实际边界仍由容器、快照与轮后检测保证。

清理：测试临时目录已删除；`/tmp/meldwork-codex-spike` 保留到任务 0.4/0.6 完成后统一删除；仓库中只新增 `desktop/spikes/read-exec-check.cjs`。

## 0.6 可写 ACP 调用每轮启动的延迟

环境：macOS Darwin 24.6.0（arm64）；Node v25.2.0；桌面端 ACP SDK 0.23.0；Claude 适配器 0.107.0、Codex 适配器 2.6.0（临时安装于 `/tmp/meldwork-acp-spike`）；本机 `deepseek` CLI 0.8.13（`deepseek-tui` 同版本）。

步骤：

1. 写 `desktop/spikes/acp-latency-check.cjs`：对每个目标测 5 次冷启动；第一次 `newSession`，后续用 `resumeSession`（模拟可写调用每轮新进程 + 恢复会话）。
2. 每次记录：`spawn → initialize → newSession/resumeSession → setSessionMode → prompt`，以及 prompt 之后的首个 `sessionUpdate`、首个实质事件（message/thought/tool_call）与首条回答。
3. 常驻对比：同一进程、同一会话连续两轮，测第二轮 prompt 到首事件/首条回答的耗时。
4. Claude 用 `setSessionMode('default')`，Codex 用 `setSessionMode('workspace-write')`（0.4 的结论）；权限请求一律批准。

结果（5 次中位数，单位毫秒）：

| 目标 | 冷启动：spawn→首事件 | 冷启动：spawn→首个实质事件 | 冷启动：spawn→首条回答 | 冷启动：spawn→完成 | 常驻第二轮：prompt→首事件 | 常驻第二轮：prompt→首条回答 | 常驻第二轮：完成 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude ACP | 1,432 | 2,862 | 2,862 | 2,879 | 351 | 880 | 893 |
| Codex ACP | 229 | 5,524 | 5,524 | 5,534 | 9 | 4,350 | 4,362 |

- 两次运行都是 5/5 成功；适配器经 `resumeSession` 恢复同一会话，`setSessionMode` 正常。
- 「首事件」常常是 `usage_update` / `session_info_update` / `config_option_update` 一类的协议内务事件（几毫秒内到达），不能代表用户可见输出；上表同时给出首个实质事件与首条回答。
- 冷启动相对常驻的额外开销：Claude 约 1.1 秒（首事件 1,432 vs 351）到约 2.0 秒（首条回答 2,862 vs 880）；Codex 约 0.22 秒（首事件 229 vs 9），首条回答的差异主要来自模型响应时间（5,524 vs 4,350），不是进程启动。
- Codex 的冷启动很快，但模型首条回答较慢；Claude 的进程/会话恢复开销更大一些。两者都在「秒级」范围内，没有出现数十秒的启动延迟。

**未测到的目标**：

- DeepSeek：本机 `deepseek` 0.8.13 不接受 `--patch`（`unexpected argument '--patch'`）；`deepseek --profile acp` 报 `Profile 'acp' not found. Available profiles: none`；`~/.dsh` 不存在。应用内的 DeepSeek 集成可能依赖安装器写入的 profile，本次无法在应用外复现。**未测**。
- Hermes、Kimi、MiMo、OpenCode、OpenClaw：本机未安装对应 CLI，**未测**。
- Gemini、Qwen：当前仍走 print 通道，不在本任务「现有 ACP Agent」的列表内；切换到原生 ACP 时再测。

会话策略（查 `desktop/src/agents/cli/cli-invocations.cjs`）：只有 OpenClaw 显式设置 `acpSessionStrategy: 'new'`；DeepSeek、Kimi、MiMo、OpenCode、Hermes 默认走 `resumeSession`。Claude/Codex 目前走 print/exec，尚未登记 ACP 会话策略；0.4 已证明它们的适配器支持 `resumeSession`。

结论：**部分通过**。Claude/Codex 的每轮新进程 + `resumeSession` 在启动延迟上可接受（额外约 0.2–2 秒，模型响应占主导）；DeepSeek 与其他 ACP Agent 因本机配置/安装缺失未验证，M3 3.9 的结论仍不能覆盖它们。

对文档的影响（建议，未修改）：

- `docs/modules/m3-seat-invocation.md` 3.9：补充 Claude/Codex 的实测数值；明确「首事件」包含协议内务事件，评估体验应看首个实质事件/首条回答。
- 第 13 节第 5 条：DeepSeek、Hermes、Kimi、MiMo、OpenCode 的延迟仍待补测；在有可用 Agent 的环境中重跑本脚本。
- 0.4 的会话模式要求同样适用于延迟测量：Claude 用 `default`，Codex 用 `workspace-write`。

清理：测试临时目录已删除；`/tmp/meldwork-acp-spike` 与 2 小时长跑进程保留到长跑结束；本脚本不修改仓库中的产品代码。

## 0.7 影子仓库

环境：
步骤：
结果：
结论：
对文档的影响：
清理：
