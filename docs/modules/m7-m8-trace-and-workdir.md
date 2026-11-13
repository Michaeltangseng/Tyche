# 模块文档：M7 完整轨迹、M8 工作目录浏览

第二版，2026-11-13。第二版吸收评审 r25（`docs/reviews/architecture-v5/r25-review.md`）：先脱敏、后切分，跨步骤维护脱敏缓冲；流式增量事件的原始视图改为合并后的文本；按键名删除会话类元数据并按值替换已知会话号；读取文件时按打开的对象反查真实路径；预览与历史比较分开校验；补充威胁模型。

依据：`docs/product-target.md`（「执行过程完整可见」、R21、R22）、`docs/functional-architecture.md` 第二十九版（决定 A7、A9，M7、M8，第 6 节）、`docs/modules/m1-m5-storage-and-interfaces.md` 定稿（IPC 约定、投影、项目目录）、`docs/modules/m4-m6-versions-and-writes.md` 定稿（A2.2 路径规范化、B6 diff 数据）、`docs/modules/m3-seat-invocation.md` 定稿（第 10 节能力登记）、`docs/modules/m13-interaction-experience.md` 定稿（右侧抽屉）。

本文的两部分都是新的 renderer 读取通道，都改动了现有的信任边界：M7 让 renderer 看到 Agent 每一步的完整内容（命令原文、工具参数、工具输出、读写路径、思考内容），只做密钥脱敏；M8 让 renderer 读取项目工作目录内的文件。两者的共同原则是：**main 决定能读什么、读多少；renderer 只提交 id 与相对路径，永远不提交绝对路径；每一次读取都有大小上限。**

## 1. 范围

| 本文负责 | 不负责 |
| --- | --- |
| 完整轨迹：从哪里取得、怎样脱敏、怎样存储、怎样分页送给 renderer、何时删除 | 现有摘要通道（Run Ledger、证据胶囊、时间线）：保持不变 |
| 统一的轨迹步骤模型，以及各通道到它的映射 | 用量（M10，在 M3 第 9 节） |
| 工作目录的目录列表、文件预览、diff 的接口与路径校验 | diff 数据本身（M4/M6 B6，由影子仓库计算） |
| 右侧抽屉「轨迹」「文件」标签的内容组件 | 抽屉外壳与布局（M13 第 3 节，里程碑 6） |
| `architecture.md` 与 `AGENTS.md` 中对应条款的修改内容 | |

## 2. 现状

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| 运行事件经 `cli-runtime-event-sanitizer.cjs` 过滤：只有 9 种类型；摘要截到 2000 字符、详情 4000 字符 | `cli-runtime-event-sanitizer.cjs:38-58` | 完整轨迹不经过这里 |
| 同一个 `sanitizeRuntimeEventText` 里混着两类处理：**密钥脱敏**（`redactChildSecrets`、私钥块、`credential=` 类赋值、`Bearer`、AKIA、URL 中的凭据）与**内容隐藏**（路径改写为 `[path]`、命令改写为 `[operation hidden]`、stderr 改写为 `[diagnostic hidden]`） | `cli-runtime-event-sanitizer.cjs:247-262` | 完整轨迹保留前一类，去掉后一类（第 4 节） |
| 工具参数只剩长度与字段数，命令只剩 `command`，输出只剩行数与字节数 | `cli-runtime-summaries.cjs:9-61` | 同上 |
| ACP 映射丢弃思考文本、隐藏命令 | `cli-runtime-event-mappers.cjs:442-474` | 完整轨迹在映射之前取得 |
| print/exec 通道的解码回调在映射之前拿到 CLI 原生的完整事件 | `cli-adapters.cjs:300-314` | 回退通道的接入点 |
| ACP 的 `sessionUpdate(params)` 拿到完整的 `update` | `cli-acp-runner.cjs:779` | ACP 通道的接入点 |
| harness 每个 Agent 运行最多保留 80 条事件（上限 500），Run Ledger 持久化这些事件 | `run-harness.cjs:1`、`:53`、`:238`；`run-ledger.cjs:341` | 完整轨迹不能放进这里：放宽上限会撑大 Run Ledger 与消息存储（架构 A7） |
| 运行事件逐条推送到 renderer：`local-workspace:run-event` | `shell/main-run-notifications.cjs:109`、`preload.cjs:102` | 完整轨迹不逐条推送全文，只推「有新内容」（第 6 节） |
| 两种脱敏函数：`redactChildSecrets(value, env)` 按子进程环境与配置中已知的密钥值替换；`redactSecrets(value)` 按模式替换私钥、敏感赋值、Basic 认证、JWT 一类的凭据 | `cli-runtime-event-sanitizer.cjs:64-75`、`security/secret-redaction.cjs` | 完整轨迹的脱敏只用这两个（第 4 节） |
| 现在没有任何读取工作目录文件或列举目录的 IPC | 架构 M8 | M8 新增 |

## 3. 完整轨迹：取得与步骤模型（M7）

### 3.1 接入点

完整内容在**映射与过滤之前**取得，与现有的摘要通道并行，互不影响：

| 通道 | 接入点 | 取得的内容 |
| --- | --- | --- |
| ACP | `cli-acp-runner.cjs` 的 `sessionUpdate(params)`，在交给现有映射之前 | 完整的 `params.update`：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan` 等，带工具的原始输入、输出内容、涉及的路径 |
| print/exec，结构化输出（`jsonl`、`jsonrpc-jsonl`） | `cli-adapters.cjs` 解码回调中，`profile.mapEvent` 之前 | CLI 原生的完整事件（例如 Claude 的 `stream-json`、Codex 的 JSON 事件） |
| print/exec，纯文本输出 | `cli-adapters.cjs` 的 `child.stdout`、`child.stderr` 数据回调 | 原始输出，按行切分 |

接入方式：调用上下文中新增一个 `traceSink`（第 5 节的写入器）。上面三处只做一件事：把取得的原始内容交给 `traceSink.ingest(channel, rawEvent)`，**不改变**现有代码对同一事件的任何处理。`traceSink` 内部完成映射、脱敏与写入；它抛出的任何错误都被捕获并记录诊断，绝不影响 Agent 调用本身。

### 3.2 步骤模型

所有通道映射到同一种步骤，渲染组件只认这一种：

```
TraceStep = {
  seq,                 每个 Agent 运行内从 1 开始递增
  at,                  ISO 时间
  kind,                'thinking' | 'message' | 'tool' | 'plan' | 'stderr' | 'raw' | 'lifecycle'
  toolCallId?,         同一次工具调用的开始与更新共用
  title?,              工具名或简短标题
  status?,             'running' | 'completed' | 'failed' | …
  command?,            命令原文（脱敏后）
  input?,              工具参数（脱敏后，JSON）
  output?,             工具输出或文本内容（脱敏后）
  paths?,              涉及的文件路径（原样）
  exitCode?,
  raw,                 映射前的原始事件（脱敏后），供「原始输出」视图
  blobs?               超过内联上限的字段，见 5.2
}
```

- 同一次工具调用的多次更新（`tool_call_update`）各是一个步骤，带相同的 `toolCallId`；渲染时按它归并为一张卡片。
- `message`、`thinking` 的流式片段与纯文本输出，**先经 4.1 的流式脱敏，再切分成步骤**：切分规则（500 毫秒或 4 KiB）只作用在已经脱敏、确认安全的文本上。不能反过来先切分再脱敏，否则密钥恰好跨在切口上时，两边分别脱敏都会漏掉。
- **原始视图中的流式增量事件**：增量事件（例如 Claude `stream-json` 的 `content_block_delta`、ACP 的 `agent_message_chunk`）的文本可能把一个密钥切在两个事件之间，逐条单独脱敏同样会漏掉。所以这类事件不逐条保留原始形式：它们的 `raw` 记为 `{ type, coalesced: true }`，文本来自 4.1 的脱敏输出。非增量的事件（工具调用、工具结果、生命周期事件）是完整的对象，照常逐条保留。这比「原样」损失了增量的切分方式，换来的是原始视图中不会出现被切开的密钥。

### 3.3 各通道的映射

| 通道 | 映射器 | 产出 |
| --- | --- | --- |
| ACP（所有 ACP Agent） | `trace-mappers/acp.cjs`，一个通用映射 | 全部字段 |
| Claude print（`stream-json`） | `trace-mappers/claude-stream-json.cjs` | 全部字段（`assistant` 中的 `tool_use` 为参数，`user` 中的 `tool_result` 为输出，`thinking` 块为思考） |
| Codex exec（JSON 事件） | `trace-mappers/codex-exec.cjs` | 全部字段（命令、输出、退出码、补丁） |
| 其他结构化输出 | 不映射 | 每个原始事件一个 `raw` 步骤 |
| 纯文本输出 | 不映射 | 每行一个 `raw` 或 `stderr` 步骤（按行合并规则同 3.2） |

能力登记（M3 第 10 节）的 `fullTrace`：有映射器的通道为 `true`；只有 `raw` 步骤的为 `false`。界面据此在「轨迹」标签中只显示原始输出视图，并说明「这个 Agent 不提供结构化的步骤」。CLI 只给思考摘要、不给完整思维链时，如实显示它给的内容（需求原文）。

映射器的输入样例（每种 CLI 至少一个完整会话的原始输出）放在 `desktop/test/fixtures/trace/`，映射器的测试以它们为准。CLI 升级改变了格式时，未知的事件落为 `raw` 步骤，不丢弃。

## 4. 脱敏（M7）

**唯一保留的处理是密钥脱敏**（需求原文）。完整轨迹的每个文本字段（`command`、`input` 中的字符串、`output`、`title`、`raw`）都经过：

1. `redactChildSecrets(value, childEnv)`：替换子进程环境与 CLI 配置中已知的密钥值，以及项目的密钥值（`Symbol.for('meldwork.project-secret-values')`）。**另外把这次调用已知的原生会话号加入这个集合**（4.3）。
2. `redactSecrets(value)`（`security/secret-redaction.cjs`）：按模式替换私钥块、敏感赋值、Basic 认证、JWT 一类的凭据。

**不做**：路径改写、命令改写、stderr 隐藏、长度截断、ANSI 以外的字符删除。`sanitizeRuntimeEventText` 中这些「内容隐藏」的规则只属于现有的摘要通道，完整轨迹不调用它。

### 4.1 流式脱敏：先脱敏，后切分

现有的两个脱敏函数都作用于一整段文本；实测把一个已知密钥拆成两段分别传入时，两段都原样返回。所以凡是会被分段到达的文本，都先经过一个**流式脱敏器**，再切分、落盘、发送：

- 每个流（每个 Agent 运行的 `message`、`thinking`、stdout 纯文本、stderr 纯文本，以及每个工具调用的流式输出）一个脱敏器。
- 脱敏器持有一段**未确认尾部**。新内容到达时，把「未确认尾部 + 新内容」整体脱敏，只放出其中确认安全的前缀，留下最后 `W` 个字符作为新的未确认尾部。`W` 取「已知密钥值的最大长度」与 1,024 中的较大者。放出的切口不能落在一个替换标记（`[redacted]`）的中间。
- 尾部中出现私钥块的开头（`-----BEGIN … PRIVATE KEY-----`）而还没有结尾时，继续持有，直到结尾出现。持有超过 64 KiB 仍没有结尾时，把从开头起的全部持有内容替换为 `[redacted private key]` 并放出。
- 流结束（Agent 运行结束、工具调用结束、流的类型切换）时，对尾部做最后一次脱敏并全部放出。
- 现有的 `createAnswerDeltaRedactor`（`cli-runtime-event-sanitizer.cjs:199`）对已知密钥采用的就是这种「保留可疑尾部」的做法；流式脱敏器以它为基础扩展到模式脱敏，并且对两种脱敏使用同一个尾部。
- **在放出之前，内容不落盘、不发送**，只存在于 main 的内存中。代价是轨迹的显示最多比实际输出晚一个尾部的长度，流结束时补齐。

### 4.2 已知限制与代价

- **模式脱敏的误伤**：`redactSecrets` 会把形如 `token = getToken()` 的代码也替换掉。这是复用现有逻辑的已知代价，界面在被替换处显示 `[redacted]`，用户知道这里被处理过。
- 只能替换已知的密钥值与能被模式识别的凭据。Agent 读出的文件内容中的其他密钥（例如某个 `.env` 里的值）会原样显示（需求原文，用户已接受）。写入 `architecture.md` 的 Known Risks（第 9 节）。
- ANSI 转义：去掉（`stripAnsi`），它们不是内容；终端颜色在 renderer 中不还原。

### 4.3 会话号与其他元数据

CLI 的原始事件中常带有会话标识，例如 Claude `stream-json` 的 `session_id`、ACP 的 `sessionId`。`redactSecrets` 的 `session ref` 规则**不匹配**这些字段名（实测会原样保留 `session_id`），而会话号属于不能进入 renderer 的内容（M1/M5 7.2）。所以：

1. **按键名删除**：映射器在写入 `raw` 与任何字段之前，递归删除键名（不区分大小写，忽略 `_` 与 `-`）为 `sessionid`、`session`、`sessionref`、`conversationid`、`threadid`、`resumeid` 的字段。删除写在映射器的公共部分，所有通道都经过它。
2. **按值替换**：这次调用已知的原生会话号（M3 4.2，来自会话状态）加入 4 第 1 步的已知值集合，在所有文本字段中替换为 `[redacted]`。这覆盖了会话号出现在其他字段或文本里的情况。
3. 测试用仓库中现有的 CLI 输出样例（`desktop/test/fixtures/agent-output/`）与新采集的样例，断言任何步骤的任何字段中都不含会话号。

## 5. 存储（M7）

### 5.1 布局

```
meldwork-private/traces/<runId>/
  meta.json                     { runId, groupId, projectId?, createdAt }，原子写入
  <agentRunId>.jsonl            每行一个 TraceStep，追加写
  <agentRunId>.blobs/<seq>-<字段>.txt   超过内联上限的字段
```

- 目录 `0700`，文件 `0600`。`runId`、`agentRunId` 先按 `/^[A-Za-z0-9._:-]{1,120}$/` 校验，再用 `encodeId`（M4/M6 B1 的 SHA-256 十六进制）作为目录名与文件名，与影子仓库的引用名用同一种编码，避免冒号等字符在文件名中出问题。
- 路径只在 main 中拼接，renderer 永远只提交 id（第 6 节）。

### 5.2 写入

- **追加写**，不是整份重写：轨迹不是权威状态，崩溃只会丢掉最后一小段。写入器按每秒一次或 64 KiB 批量 `write`，然后 `fsync`；Agent 运行结束时立即刷新。
- 读取时忽略文件末尾不完整的一行（崩溃留下的半行）。
- **内联上限**：单个步骤的某个字段超过 256 KiB 时，写进 `blobs/` 下的独立文件，步骤中只记录 `{ blobId, bytes }`。renderer 按需分段读取（6.1 `trace:blob`）。这样一次 20 MB 的工具输出不会让一页轨迹变成 20 MB。
- 写入失败（磁盘满等）：记录诊断，停止这个 Agent 运行的轨迹写入，在轨迹末尾标记「轨迹不完整」；**不影响 Agent 调用本身**。

### 5.3 保留与删除

- **不设保留期限和磁盘上限**（R21，用户接受的代价）。设置页显示轨迹的总磁盘占用，并提供「清理旧轨迹」（按群聊或按时间选择，人工触发）。
- 删除群聊时删除它的全部轨迹：按 `meta.json` 中的 `groupId` 找到对应目录，整目录删除。删除项目室时随项目内群聊一起删除（M1/M5 第 9 节第 5 步）。
- 启动时清理孤立的轨迹目录：`meta.json` 中的 `groupId` 在工作区中已不存在的目录，整目录删除；没有 `meta.json` 的目录（崩溃在创建途中）同样删除。
- 运行记录从 Run Ledger 中被淘汰（只保留最近 64 次）**不**删除轨迹：轨迹的生命周期跟随群聊，而不是跟随 Run Ledger。

## 6. 送给 renderer（M7）

### 6.1 接口

经 `registerTrustedHandle` 注册（`desktop/src/shell/trace-ipc.cjs`），preload 暴露为冻结的 `meldworkDesktop.trace.*`，输入用 zod `strictObject`：

| 方法 | 输入 | 输出 |
| --- | --- | --- |
| `page` | `{ runId, agentRunId, cursor?, direction: 'forward' \| 'backward', limit }`，`limit` ≤ 200 | `{ steps, cursor, hasMore, complete }`；单页的序列化大小上限 512 KiB，到达上限时提前结束这一页 |
| `blob` | `{ runId, agentRunId, blobId, offset, length }`，`length` ≤ 256 KiB | `{ text, totalBytes, eof }`，按 UTF-8 字符边界截取 |
| `status` | `{ runId, agentRunId }` | `{ lastSeq, complete, incomplete, bytes }` |

校验：`runId` 必须属于工作区中存在的群聊的运行（查 `meta.json` 与工作区）；不存在或不属于任何群聊时返回 `TRACE_NOT_FOUND`。`cursor` 是 main 生成的不透明字符串（文件偏移量的编码），renderer 不能构造任意偏移量去读其他文件。

### 6.2 实时更新

- 不逐条推送全文。main 推送 `trace:appended { runId, agentRunId, lastSeq }`，每个 Agent 运行最多 5 次/秒，合并相邻的写入。
- renderer 正在查看这个运行的轨迹、且停在底部时，收到通知后调用 `page` 拉取新步骤；不在查看时忽略。
- 现有的 `local-workspace:run-event` 摘要推送不变，时间线与运行详情的状态仍由它驱动。

### 6.3 信任边界

完整轨迹进入 renderer 的内容包括命令原文、工具参数与输出、读写的文件路径、思考内容，以及其中出现的**可执行文件路径**（需求原文：可执行文件路径原样显示）。这改变了两条现有规则：

| 规则 | 修改后 |
| --- | --- |
| `architecture.md` Trust Boundaries 第 6 条：命令、原始输出、工具负载不进入 renderer | 经完整轨迹通道进入 renderer，只做密钥脱敏（第 4 节）；现有的摘要通道仍按原规则过滤 |
| `AGENTS.md`：不得向 renderer 暴露可执行文件路径 | 「轨迹显示以外，renderer 不接收可执行文件路径，也不能据此启动进程」。renderer 收到的轨迹是只读的展示数据，没有任何接口能用其中的路径或命令执行操作 |

不变的规则：凭据只经系统安全存储；renderer 不能启动进程、不能执行命令；会话号、令牌不进入 renderer（会话类字段按键名删除，已知会话号按值替换，见 4.3）。

## 7. 轨迹的展示（M7）

- 组件 `frontend/src/components/trace/TraceStepList.vue`，被两处使用：现有群聊的「运行详情」（`RunTracePanel.vue`）与项目室右侧抽屉的「轨迹」标签。
- 每个步骤一行或一张卡片：思考（可折叠）、消息、工具调用（标题、命令、参数、状态、退出码；输出折叠，展开时按需拉取 `blob`）、计划、stderr（与 stdout 区分颜色）。
- 「原始输出」视图：按 `raw` 字段逐条显示，等宽字体，接近终端。
- 长内容：步骤列表虚拟滚动；超过 2,000 行的输出在组件中分段显示，「显示更多」继续拉取。
- 没有完整轨迹的旧运行（这个功能上线之前的运行）：保留现有的摘要显示，并说明「这次运行没有完整轨迹」。
- 复制：每个步骤可以复制命令或输出（复制的是脱敏后的内容）。
- 设计参考 Nimbalyst（MIT）对工具调用的展示方式（架构复用清单），只参考布局，不复制代码。

## 8. 工作目录浏览（M8）

### 8.1 接口

经 `registerTrustedHandle` 注册（`desktop/src/shell/workdir-ipc.cjs`），preload 暴露为 `meldworkDesktop.workdir.*`。所有方法以 `projectId` 定位工作目录：工作目录的真实路径只来自项目记录（M1/M5 3.1），renderer 只提交 `projectId` 与相对路径。

| 方法 | 输入 | 输出 |
| --- | --- | --- |
| `list` | `{ projectId, relPath, cursor? }` | `{ entries: [{ name, kind, size, mtime, linkTarget? }], cursor, hasMore }`；每次最多 1,000 项，目录在前、按名称排序 |
| `read` | `{ projectId, relPath, offset?, length? }`，`length` ≤ 512 KiB | 文本：`{ kind: 'text', text, totalBytes, eof, encoding }`；图片：`{ kind: 'image', mime, dataBase64 }`（≤ 5 MiB）；其他：`{ kind: 'binary', size, mime? }`，不返回内容 |
| `diff` | `{ projectId, relPath, against }`，`against` 为 `{ kind: 'accepted', checkpointId, version? }` 或 `{ kind: 'candidate', checkpointId }` | M4/M6 B6 的 `numstat` 与 `fileDiff`（工作目录当前内容对该提交），以及 `describePathChange` 的输出（占位文件、类型变化等按它显示） |
| `acceptedDocuments` | `{ projectId }` | 「已接受文档」列表（M13 第 3 节）：路径、当前版本、是否有待确认的新版本、是否过期、是否有未解决漂移；来自项目状态，不读文件 |

### 8.2 路径校验

**威胁模型**。能制造路径竞争的，是与用户同权限、在工作目录中运行的 Agent 或其他程序。它本来就能读取这些文件，所以这里防的不是「数据被它拿走」，而是「renderer 在用户自己的界面里显示了工作目录之外的文件」：最坏的结果是一个用户自己可读的文件出现在用户自己的窗口里，没有外泄的渠道。即便如此，读取**内容**的路径要做到无竞争；只暴露文件名的列表尽量收窄窗口，残余风险如实写明。

**共同的第一步**（所有方法）：`relPath` 按 M4/M6 A2.2 规范化（`/` 分隔、拒绝 `..`、绝对路径、NUL，NFC）；空字符串表示工作目录本身；路径中任一段为 `.git` 时拒绝（`.git/config` 可能含有带凭据的远程地址；`list` 中仍显示 `.git` 一项，标为「仓库元数据」，不可展开）。失败返回 `WORKDIR_PATH_REJECTED`。

之后按用途分三种校验：

**（一）读取现存文件的内容：`read`**

1. 把相对路径拼接到工作目录的真实路径上，以 `O_RDONLY | O_NOFOLLOW` 打开（最后一段若是符号链接则打开失败；指向工作目录之内的链接，renderer 改为打开它的目标路径）。
2. **按打开的对象反查它的真实路径**，而不是重新解析路径：
   - Linux：`fs.readlinkSync('/proc/self/fd/<fd>')`。
   - macOS：`lsof -a -p <main 的 pid> -d <fd> -Fn`，取 `n` 开头的一行（`execFile`，不经过 shell）。已在 macOS 上验证：打开之后把路径中的目录换成指向外部的链接，查询结果仍是实际打开的对象的路径。
   - Windows：没有可用的方式，见下文「Windows」。
3. 反查得到的路径必须在工作目录的真实路径之内（按段比较），否则关闭描述符、拒绝。
4. 校验通过后，只通过这个描述符读取内容，不再按路径打开任何东西。

这样，无论替换发生在打开之前（打开到的是外部文件，第 3 步拒绝）还是之后（描述符指向原来的文件，读到的就是它），读到的内容都属于工作目录。每次读取多一次 `lsof` 调用（数十毫秒），对预览可以接受。

**（二）列出目录：`list`**

Node 不能按描述符列目录，所以列表无法做到与读取同样的无竞争。做法：先以（一）的方式打开这个目录并反查路径、确认在工作目录之内；然后按路径 `readdir` 并对每项 `lstat`（不跟随链接）；最后再次 `stat` 这个路径，设备号与 inode 必须与打开的描述符的 `fstat` 相同，否则丢弃结果、拒绝。残余的窗口只在「`readdir` 执行期间路径被换走又换回」时存在，最坏的结果是列表中出现外部目录的**文件名**，不会出现内容，因为读取内容永远经过（一）。这条写入 Known Risks。

**（三）比较历史版本：`diff`**

被比较的路径在工作目录中**可以已经不存在**（文件被删除时正需要显示删除），所以不要求它能打开或能解析。做法：只做共同的第一步；内容一律由影子仓库的 git 读取（M4/M6 B6 的 `numstat`、`fileDiff`，工作目录一侧由 git 自己读）。git 不跟随工作目录中的符号链接读取文件内容，路径穿过符号链接时 git 报错（`beyond a symbolic link`），这时返回 `WORKDIR_PATH_REJECTED`。本节自己不读取工作目录中的任何文件。

**Windows**：没有按句柄反查路径的可用接口，`read` 退回「打开前解析真实路径、打开后比较文件标识」的做法，残余竞争窗口写入 Known Risks。Windows 上 A14 也尚未实现（M3 3.8），两者一并在界面与发布说明中注明。

### 8.3 内容判断

- 文本：前 8 KiB 中没有 NUL 字节，且能按 UTF-8 解码（允许末尾被截断的多字节字符）。不是 UTF-8 的文本按二进制处理，显示「无法以文本预览」。
- 图片：按文件头识别 PNG、JPEG、GIF、WebP，大小 ≤ 5 MiB 时返回 base64；SVG 按文本返回，renderer 以文本显示，不作为图片渲染（避免脚本）。
- 预览**不做脱敏**：这是用户自己工作目录中的文件，界面显示它本来的内容。文件名匹配 `.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*` 时，预览先显示「这个文件可能包含密钥」，用户点击后才显示内容。

### 8.4 刷新

不使用文件系统监视（跨平台行为不一致，大目录开销大）。目录树在以下时机刷新：

- 收到 `project:changed`，且新快照显示有可能写入的调用结束（容器已空）；
- 用户点击「刷新」；
- 打开一个之前没有展开过的目录。

刷新只重新列出当前已展开的目录。

### 8.5 展示

- 组件 `frontend/src/components/workdir/WorkdirTree.vue`、`FilePreview.vue`、`FileDiff.vue`，放在右侧抽屉的「文件」标签中（外壳在里程碑 6）。
- 「已接受文档」列表在最上方（M13 第 3 节），点击打开预览或 diff。
- diff 用 `@git-diff-view/vue`（MIT），引入前核对 LICENSE 与维护状态（架构第 5 节新增依赖）。数据来自 `workdir:diff`，组件只负责展示。
- 文本预览用等宽字体，超过 512 KiB 的文件分段加载。

## 9. 对其他文档的修改

| 文档 | 修改 |
| --- | --- |
| `architecture.md` Trust Boundaries 第 1 条 | renderer 可以经 `workdir:*` 读取项目工作目录内的文件；main 校验路径（8.2）、限制大小；renderer 从不提交绝对路径 |
| `architecture.md` Trust Boundaries 第 6 条 | 6.3 的表格 |
| `architecture.md` Local Data 表格 | 新增 `meldwork-private/traces/`（5.1） |
| `architecture.md` Known Risks | 轨迹只能替换已知的密钥值与能被模式识别的凭据，Agent 读出的文件内容中的其他密钥会原样显示；模式脱敏会误伤形如密钥赋值的代码；轨迹不设保留上限，可能占用大量磁盘；工作目录的列表在 `readdir` 期间路径被换走又换回时，可能显示外部目录的文件名（不会显示内容）；Windows 上读取文件内容仍有路径替换的竞争窗口 |
| `AGENTS.md` | 「Never expose executable paths … to renderer code」改为：轨迹显示以外，renderer 不接收可执行文件路径，也不能据此启动进程 |
| 架构 M7、M8 | 指向本文；M8「目录变化」的待定取舍定为不使用文件系统监视（8.4） |
| M3 第 10 节 | `fullTrace` 的取值依据为 3.3 的映射器 |

## 10. 测试

- 接入点：三种通道各用一份 `fixtures/trace/` 中的原始输出驱动，断言 `traceSink` 收到的内容与原始输出一致，且现有摘要通道产出的事件与改动前**完全相同**（对比改动前后的事件序列）。
- 映射器：每种 CLI 的样例映射为预期的步骤；未知事件落为 `raw`；同一 `toolCallId` 的开始与更新。
- 脱敏：环境中的密钥值、项目密钥、私钥块、Basic、JWT、URL 凭据都被替换；路径、命令、stderr **不被**改写。流式脱敏：已知密钥恰好跨在**两个步骤的切分边界**（500 毫秒与 4 KiB 两种）上时仍被替换；跨两个流式增量事件时，原始视图中也不出现它的任何一半；私钥块跨越多个片段时在结尾出现后整体替换，超过 64 KiB 没有结尾时整体替换；放出之前的内容不出现在轨迹文件与 `trace:appended` 中。
- 会话号：用 `fixtures/agent-output/` 中的现有样例与新样例，断言 `session_id`、`sessionId` 等字段被删除，已知会话号在任何字段中都被替换。
- 存储：追加写；末尾半行被忽略；超过 256 KiB 的字段写入 blob；写入失败时调用不受影响、轨迹标记不完整；删除群聊删除轨迹；孤立目录在启动时被清理；Run Ledger 淘汰运行不删除轨迹。
- 接口：`page` 的前后翻页与 512 KiB 页上限；`blob` 的分段与 UTF-8 边界；不属于任何群聊的 `runId` 被拒绝；伪造的 `cursor` 被拒绝；`trace:appended` 的频率上限。
- 工作目录：`..`、绝对路径、NUL 被拒绝；指向外部的符号链接被拒绝、指向内部的允许；`.git/` 内的读取被拒绝；`read` 的竞争：在打开之前把祖先目录换成指向外部的符号链接，断言反查到外部路径而被拒绝；在打开之后替换，断言读到的是原来的文件；`list` 在两次 `stat` 之间替换目录，断言结果被丢弃；`diff` 对已删除的文件返回删除变化，对穿过符号链接的路径被拒绝；文本、图片、二进制、非 UTF-8 的判断；SVG 按文本返回；超大文件分段读取；`.env` 类文件的提示由 renderer 显示（前端测试）。
- 前端：`TraceStepList` 的工具卡片归并、按需拉取 blob、虚拟滚动；没有完整轨迹的旧运行显示摘要；`WorkdirTree` 的展开与刷新；`FileDiff` 对占位文件与类型变化的显示与 `describePathChange` 一致。
- Electron 人工检查：现有群聊的运行详情显示完整轨迹（命令原文、输出、思考）；一个已知密钥出现在命令输出中时被替换；项目室的「文件」标签浏览、预览、diff。

## 11. 待定问题

1. Claude `stream-json` 与 Codex JSON 事件的字段以里程碑 0 采集的样例为准；如果 Claude、Codex 改走 ACP（里程碑 0 任务 0.4 通过），这两个映射器只服务于回退通道。
2. 「清理旧轨迹」的界面放在设置页还是群聊菜单，在实现时按现有设置页的结构决定，不影响本文的接口。
