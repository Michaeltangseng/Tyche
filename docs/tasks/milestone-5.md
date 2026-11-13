# 任务单：里程碑 5 检查点引擎与席位调用

## 目标

实现检查点引擎（转移函数、项目级进度、副作用执行器、发件箱、纪元、对账、恢复屏障、未解决漂移、越界）与项目室的席位调用（提示词、会话、结尾标记、权限三种模式、`read-exec` 评审、看门狗、能力登记），接通 `project:*` 的流程类方法与 `decideGate` 的完整校验，发送系统通知；并补跑前面里程碑推迟的集成测试。这是最大的一个里程碑，按任务顺序逐个验收。

## 前置条件

- 里程碑 4 已验收。
- 已读 `docs/handoff-guide.md`。

## 必读

- `docs/modules/m2-checkpoint-engine.md`：全文。
- `docs/modules/m3-seat-invocation.md`：第 4–10 节、第 11 节中对应条目。
- `docs/modules/m1-m5-storage-and-interfaces.md`：6.1、第 8 节流程类方法、第 10 节。
- `docs/modules/m4-m6-versions-and-writes.md`：A6（越界检测与归属）。
- `docs/spikes/milestone-0-results.md`：任务 0.4、0.5 的结论（哪些 Agent 的 ACP 与 `read-exec` 可用）。

## 范围

| 包括 | 不包括 |
| --- | --- |
| `desktop/src/project-room/` 下的引擎文件 | 界面（里程碑 6） |
| `project-room` 调用策略（改 `local-workspace-agent-invocation.cjs`、`invocation-prompt.cjs`、`local-workspace-context.cjs`） | 默认 playbook 的完整内容与提示词措辞（里程碑 8；本里程碑用最小的测试 playbook） |
| 权限 `read-exec`、看门狗、能力登记 | 完整轨迹（里程碑 7） |
| 系统通知的发送 | 用量（里程碑 8） |

## 任务

任务按依赖顺序排列。5.1–5.6 是纯逻辑，不启动任何进程；5.7 起接入真实调用。

### 任务 5.1 转移函数：先写表，再写代码

1. 新建 `desktop/test/project-room/transition-table.cjs`：把 M2 5.1 主表、第 6 节的走向表、第 7 节的插话表**逐行**写成数据：`{ state, event, condition, expectState, expectEffects, expectGate }`。这份数据就是测试的期望值。逐行对照文档，一行都不能少；写完后在汇报中给出「文档的行数」与「数据的条数」。
2. 新建 `desktop/test/project-room/checkpoint-transitions.test.cjs`：对表中每一行生成一个用例；另外对「所有状态 × 所有事件」中不在表里的组合，断言结果为「忽略」（状态与副作用都不变，返回一条诊断）。
3. 这时运行测试，全部失败。
4. 新文件 `desktop/src/project-room/checkpoint-transitions.cjs`：`transition(instance, event, config) → { instance, effects, diagnostics }`。纯函数：不读时钟（时间在事件里）、不做 I/O、不修改输入（返回新对象）。
5. 让测试全部通过。

不变量测试（M2 第 11 节「不变量」全部条目）写进 `checkpoint-invariants.test.cjs`：用随机生成的事件序列（固定随机种子，失败时打印种子）驱动转移函数，每一步之后检查全部不变量。

### 任务 5.2 项目级进度

新文件 `desktop/src/project-room/project-progress.cjs`，纯函数：依赖关系、哪些实例可以开始、清单确认后新增实例、打回与重新打开的影响范围与 `impactHash`（M2 6.2、6.3）、未解决漂移的阻挡、`UPSTREAM_BLOCKERS_CHANGED` 的产生。测试：影响范围的计算；`impactHash` 只在影响范围变化时变化；阻挡条件。

### 任务 5.3 结尾标记

新文件 `desktop/src/project-room/signal-markers.cjs`（M3 4.4）：`parseCheckpointSignal(text)`、`parseReviewVerdict(text)`，只认最后一个非空行。复用 `answer-marker-filter.cjs` 在流式输出中隐藏标记。测试按 M3 第 11 节「标记」。

### 任务 5.4 副作用执行器

新文件 `desktop/src/project-room/effect-runner.cjs`：

- 按 M2 9.1 的类别（必要、调用、外部、清理、尽力）执行；按 M2 5.3 比较纪元，**`release-scope`、`withdraw-lease`、`cancel-invocation` 例外**。
- 结果作为事件交回引擎，**不**单独写「完成」（M2 4.3）；只有调用与用户仓库提交在执行前落盘「已开始」。
- 必要副作用自动重试 3 次（1 秒、5 秒、30 秒），之后 `EFFECT_FAILED`；暂停时清理类照常执行（M2 9.2）。
- 存储持久性不确定（里程碑 4 的 `durable: false`）时，暂停这个项目的所有副作用，直到持久化确认（M1/M5 6.1）。
- `reconcile-scheduler`（M2 5.3）：只处理 `checkpoint-scope` 与 `project-maintenance`。

每种副作用的具体实现调用里程碑 3 的 `shadow-git.cjs` / `user-git.cjs`、里程碑 2 的调度器、本里程碑 5.7 的调用。

测试：纪元作废与三种例外；重试与暂停；清理越过暂停；对账只撤回前两类持有者；`durable: false` 时暂停。

### 任务 5.5 引擎

新文件 `desktop/src/project-room/checkpoint-engine.cjs`：把事件送进转移函数，经里程碑 4 的 `ProjectStore.enqueue` 落盘，再交给副作用执行器；副作用结果作为新事件送回。队列中的操作都是短事务，不在队列里等待（M1/M5 6.1）。

- 恢复屏障（M2 第 10 节）：启动时按第 1–12 步执行；接入 M4/M6 C 的顺序（里程碑 4 中「加载完成后直接 `openRoot`」改为在屏障通过之后）。
- 未解决漂移（M2 第 8 节）：条目是状态，与产生它的转移同一次落盘；处理的前提与基准版本校验。
- 越界条目与调用时间窗（M4/M6 A6）。
- 删除：实现里程碑 4 中 `project-deletion.cjs` 所需的 `beginDraining`、`isDrained`，替换替身。

### 任务 5.6 `decideGate` 与流程类方法

把里程碑 4 中返回 `PROJECT_ENGINE_UNAVAILABLE` 的方法接上引擎。`decideGate` 按 M1/M5 第 10 节的十步顺序实现；测试为每一步写一个失败用例，断言返回的是第一个失败项；全部通过时恰好产生一个 `GATE_DECIDED`。`residual`、`unlockDirectory` 按 M3 3.7、M4/M6 C 第 6 步实现。

### 任务 5.7 `project-room` 调用策略

依据 M3 第 4 节。

1. `local-workspace-agent-invocation.cjs`：新增 `sessionPolicy: 'project-room'`。宿主为主流程群聊；提示词原样发送，不附加任何后缀（`invocation-prompt.cjs` 中对这一策略跳过 `RESPONSE_SCOPE_INSTRUCTION` 与工作偏好）；权限取自调用上下文，不读群聊的 `allowWrite`；必须带 `contextPackId`。
2. 会话：`local-workspace-context.cjs` 的 `resolveSessionState`（`:437`）对这一策略使用调用者给出的键；`sessionKey()` 的哈希回退（`:357-371`）纳入项目、检查点、席位、代数。评审调用在 `onSessionRef` 与 `session.complete` 两处跳过保存（现有跳过条件在 `:385`、`:964`、`:1371`）。
3. 写入声明由检查点作用域持有（M2 5.2），这次调用以只读模式向调度器计数（M4/M6 A3.4）。
4. 结束事件按 M3 第 5 节的三种时机发出。

测试按 M3 第 11 节「提示词」「会话」。

### 任务 5.8 权限 `read-exec`

1. `agent-runtime-contract.cjs`：模式列表加入 `read-exec`。
2. `agent-permission-policy.cjs` 的 `automaticPermissionResponse`：`read-exec` 放行 `read`、`search`、`fetch`、`think`、`execute`，拒绝其余（M3 6.1）。
3. `cli-invocations.cjs`：只为里程碑 0 任务 0.5 中**实测通过**的 CLI 加入 `read-exec` 参数；其他 CLI 不支持，由能力登记表达（5.10）。
4. `read-exec` 调用经受管理进程运行（里程碑 1 的注入条件扩展为 `workspace-write` 或 `read-exec`）。
5. `read-exec` 评审的串行与核对（M3 6.2、M2 5.1 中对应的行、5.2 规则 5）。

### 任务 5.9 看门狗

依据 M3 第 8 节：调用上下文的 `watchdog` 选项；`cli-adapters.cjs:396-399` 与 `cli-acp-runner.cjs:987-990` 的两处 2 小时硬上限改为读取 `hardLimitMs`；项目室的主笔、草稿、评审使用 `remind`、`hardLimitMs = null`。测试：`remind` 只发提醒不中止；其他调用的默认行为不变。

### 任务 5.10 能力登记

依据 M3 第 10 节：每种 Agent 的 `fullTrace`、`readExec`、`midTurnCancel`、`writeSessionContinuity`、`usage`、`managedProcess`。取值以里程碑 0 的实测结论为准；没有实测的一律为 `false`。`updateSeat` 的能力组合校验（M1/M5 8.2）改为读取这里。

### 任务 5.11 系统通知

扩展 `desktop/src/shell/main-run-notifications.cjs`：以里程碑 4 的 `notification-coalescer.cjs` 为依据，在项目状态提交后比较新旧投影，发出通知；点击打开对应项目室（打开的方式在里程碑 6 由界面响应，本里程碑发出一个 `project:open` 事件即可）。

### 任务 5.12 假 Agent

为端到端测试实现一个假 Agent，**不修改产品代码中的 Agent 列表**：

1. 新文件 `desktop/test/fixtures/fake-agent/fake-agent.cjs`：一个 Node 脚本，从环境变量 `FAKE_AGENT_SCRIPT` 指向的 JSON 文件读取剧本，按顺序执行步骤：输出文本、写文件、运行命令、等待、挂起、以指定退出码退出、崩溃；最后一行输出指定的结尾标记（或故意不输出）。
2. 在测试中通过现有的自定义 Agent 机制（`desktop/src/agents/custom-agent-store.cjs`）注册它：一个指向 `fake-agent.cjs` 的定义。先确认现有的 `promptMode` 取值中有适合的一种（提示词从参数或标准输入读取）；没有合适的，停下来问。
3. 剧本中的每一步都写进测试，测试读起来要能看出这一轮 Agent 做了什么。

### 任务 5.13 端到端测试

`desktop/test/project-room/end-to-end.test.cjs`，用假 Agent 与一个最小的测试 playbook（一个文档检查点、一位主笔、一位评审）：

1. 一个文档检查点从开始到接受。
2. `revise` 循环两轮后 `pass`。
3. 主笔全部驳回、正文未变：进入驳回轮；评审给 `revise` 时进入关卡。
4. 轮数上限。
5. `needs-human`。
6. 主笔 `question`，人回答后在同一会话继续。
7. 插话与停止并交付。
8. 打回到上游、重新打开已接受的检查点。
9. 关卡上「接受送审版本」而工作目录已被改动：产生未解决漂移，处理后下游可以接受。
10. 主笔写入中途对 main 发 `SIGKILL`（用一个子进程运行引擎），重启后出现恢复关卡，容器已清空。

每个用例断言：状态、关卡原因、`decisions.md` 中的记录、影子仓库中的提交、调度器中没有遗留的申请。

### 任务 5.14 补跑推迟的测试

逐条运行并在汇报中列出：

- 里程碑 2 推迟的：纪元增加后租约通知仍被执行；`reconcile-scheduler`；项目内群聊写入时检查点对账不撤回它的租约；恢复屏障中「已获批」申请的重建。
- 里程碑 3 推迟的：副作用以真实引擎调用时的幂等重放、崩溃后重放、纪元作废。
- 里程碑 4 推迟的：`decideGate` 第 3–10 步；删除时与真实检查点副作用、真实租约、真实项目内群聊调用的交互；通知发送。

### 任务 5.15 真实 Agent

用一个真实的 Agent（里程碑 0 中通过的通道），以测试 playbook 跑通一个文档检查点的一轮主笔与一轮评审。这一项人工执行，把过程与结果写进汇报。

## 验收

- 任务 5.1–5.14 的全部测试；`npm --prefix desktop test` 全部通过。
- 汇报中给出：转移表的「文档行数 = 数据条数」核对；补跑清单的逐条结果；任务 5.15 的人工记录。

需求追踪：R1、R2、R5、R7、R8、R9、R12、R15、R19、R20、R27。

## 停下来问的情况（除交接手册第 5 节之外）

- 写转移表数据时，发现 M2 的表格有遗漏、矛盾，或某一行的期望不明确。**不要自己推断**，列出具体的行。
- 不变量测试找到违反不变量的事件序列，而转移函数是按表实现的（说明表本身有问题）。
- 现有自定义 Agent 机制无法承载假 Agent。
