# 里程碑 0 实测报告

状态：进行中。日期、环境与逐项结果在完成后补齐。

本报告验证各模块文档中尚未实测的前提。结论决定后续里程碑能否按现在的设计实现；需要修订模块文档的条目只写建议，经人确认后再改。

## 总表

| 编号 | 实测项 | 结论 | 对文档的影响 |
| --- | --- | --- | --- |
| 0.2 | 监护程序在 Electron 下运行（含打包后） | **不通过**：系统 Node 与开发用 Electron 通过；打包后无法以 Node 运行 | 建议改为随应用分发的独立小程序（M3 3.2）；M3 3.3 补充 fd 0/1/2 的处理约束 |
| 0.3 | Linux 上的进程组、`pgrep -g`、`/proc/<pid>/environ` | 待测 | 待定 |
| 0.4 | Claude、Codex 的 ACP 适配器 | 待测 | 待定 |
| 0.5 | Claude print、Codex exec 的 `read-exec` 参数 | 待测 | 待定 |
| 0.6 | 可写 ACP 调用每轮启动的延迟 | 待测 | 待定 |
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

环境：
步骤：
结果：
结论：
对文档的影响：
清理：

## 0.4 Claude、Codex 的 ACP 适配器

环境：
步骤：
结果：
结论：
对文档的影响：
清理：

## 0.5 `read-exec` 参数

环境：
步骤：
结果：
结论：
对文档的影响：
清理：

## 0.6 可写 ACP 调用每轮启动的延迟

环境：
步骤：
结果：
结论：
对文档的影响：
清理：

## 0.7 影子仓库

环境：
步骤：
结果：
结论：
对文档的影响：
清理：
