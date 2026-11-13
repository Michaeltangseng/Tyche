# 任务单：里程碑 7 完整轨迹与工作目录浏览

## 目标

让 renderer 看到 Agent 每一步的完整内容（命令原文、工具参数与输出、读写的路径、思考内容），只做密钥脱敏；让项目室的「文件」标签可以浏览工作目录、预览文件、查看 diff。现有群聊的「运行详情」改用同一套轨迹组件。这两件事都改动了信任边界，**安全相关的规则一条都不能放宽**。

## 前置条件

- 里程碑 4 已验收（项目、IPC 的写法与 `encodeId`）；里程碑 6 已验收（右侧抽屉外壳）。里程碑 3 的 `numstat`、`fileDiff`、`describePathChange` 可用。
- 已读 `docs/handoff-guide.md`，尤其 2.2（安全边界）与第 7 节（常见错误）。

## 必读

- `docs/modules/m7-m8-trace-and-workdir.md`：**全文**。这是本里程碑的唯一设计依据。
- `docs/modules/m4-m6-versions-and-writes.md`：A2.2（路径规范化、大小写探测）、B1（`encodeId`）、B6（diff 数据）、B3.5（`describePathChange`）。
- `docs/modules/m1-m5-storage-and-interfaces.md`：7.2（不进入 renderer 的内容）、8.1（IPC 共同规则）、第 9 节第 4 步（删除项目室时删除轨迹）。
- `docs/modules/m3-seat-invocation.md`：4.2（会话号来自哪里）、第 10 节（`fullTrace` 能力）。
- 现有代码：
  - `desktop/src/security/secret-redaction.cjs` 全文；`desktop/src/agents/cli/cli-runtime-event-sanitizer.cjs` 中的 `redactChildSecrets`（`:64-75`）、`sanitizeRuntimeEventText`（`:247-262`）、`createAnswerDeltaRedactor`（`:199`）。
  - `desktop/src/agents/cli/cli-adapters.cjs:296-316`（解码回调）、stdout 与 stderr 的数据回调（约 `:402-408`）。
  - `desktop/src/agents/cli/cli-acp-runner.cjs:779`（`sessionUpdate`）。
  - `desktop/src/workspace/local-workspace-agent-invocation.cjs`（调用上下文的构造、`emitRuntimeEvent` 约 `:720`）。
  - `frontend/src/components/RunTracePanel.vue`、`frontend/src/composables/useRunTracePanel.js`。

## 范围

| 包括 | 不包括 |
| --- | --- |
| `secret-redaction.cjs` 的规则抽取与 `secretSpans` | 改变现有摘要通道（`cli-runtime-event-sanitizer.cjs` 的过滤、Run Ledger、证据胶囊、时间线）的任何行为 |
| 流式脱敏器、轨迹映射器、轨迹写入器、轨迹 IPC | 用量（里程碑 8） |
| 工作目录 IPC 与路径校验 | 文件系统监视（M7/M8 8.4：不使用） |
| 前端：轨迹组件、目录树、预览、diff | 对普通群聊开放工作目录浏览（只在项目室中） |
| `architecture.md`、`AGENTS.md` 的条款修改（M7/M8 第 9 节） | |
| 新增依赖 `@git-diff-view/vue`（核对许可证后） | 其他任何新依赖 |

## 任务

任务 7.1–7.8 是桌面端，7.9–7.12 是前端，7.13 是文档。每个任务完成后运行它列出的测试与 `npm --prefix desktop test`。

### 任务 7.1 脱敏规则的共用定义与 `secretSpans`

依据 M7/M8 4.1「前置改动」。

1. **先建回归语料**：新建 `desktop/test/fixtures/redaction/corpus.json`，至少 60 条输入：每种规则（私钥块、`Bearer`、Basic、`sk_` 等前缀、AKIA、AIza、JWT、URL 凭据、敏感赋值的各种写法）各若干条，外加不应被替换的普通文本、代码片段、路径、命令。用**改动前**的 `redactSecrets` 生成每条的期望输出，写进语料文件。这一步必须在改代码之前完成。
2. 改 `desktop/src/security/secret-redaction.cjs`：把各条规则抽成一个数组 `SECRET_RULES`（每条：名称、正则、可选的二次判断函数如 `isBasicCredential`、替换文本）。`redactSecrets` 改为按原来的顺序依次应用 `SECRET_RULES`。
3. 新增并导出 `secretSpans(text, { knownValues = [] } = {}) → Array<{ start, end, rule }>`：对每条规则在**原始** `text` 上找出全部匹配（经二次判断确认的才算），加上 `knownValues` 中每个值在 `text` 中的全部出现位置，按起点排序并合并重叠区间。不做替换。
4. 测试 `desktop/test/security/secret-redaction-spans.test.cjs`：语料中每条输入，改动后的 `redactSecrets` 输出与期望**逐字相同**；`secretSpans` 对每种规则给出正确的区间；已知值的多次出现都被找到；重叠区间被合并。
5. 运行全部现有测试，确认 `redactSecrets` 的调用方不受影响。

### 任务 7.2 流式脱敏器

新文件 `desktop/src/runs/trace/streaming-redactor.cjs`，严格按 M7/M8 4.1 实现：

```
function createStreamingRedactor({ knownValues, minWindow = 1024, holdLimit = 64 * 1024 })
  → {
      push(text) → string    放出确认安全且已替换的文本（可能为空字符串）
      end() → string         流结束：放出剩余部分
      state() → 'normal' | 'discarding-private-key'   供测试
    }
```

要点（逐条对照 4.1，不要省略）：

- 内部只保存**原始**未确认尾部，永远不保存替换后的文本。
- `W = max(knownValues 中最长值的长度, minWindow)`。
- 每次 `push`：按 4.1 正常状态的第 1–6 步；切口的三个条件全部满足；替换用 `redactSecrets(redactChildSecrets(…))`，这里的 `redactChildSecrets` 用一个以 `knownValues` 为准的等价函数（`knownValues` 中每个值替换为 `[redacted]`）。
- 私钥：遇到开头标记，放出开头之前的安全部分，再放出一次 `[redacted private key]`，进入丢弃状态；丢弃状态只保留最多「结束标记长度 − 1」个字符用于跨片段识别结束标记；没有长度上限；识别到结束标记后回到正常状态。
- `end()`：正常状态下把尾部整体替换后放出；丢弃状态下放出空字符串。

测试 `desktop/test/runs/trace/streaming-redactor.test.cjs`（M7/M8 第 10 节「流式脱敏（原始尾部）」全部条目）。另外加一个**性质测试**：从语料中任取一条含密钥的输入，随机切成 1–20 段依次 `push` 再 `end`，断言拼接后的输出与 `redactSecrets(redactChildSecrets(整段))` 相同，或者比它替换得更多，但**绝不**包含任何一个原始密钥的完整值或长度 ≥ 8 的片段。固定随机种子，失败时打印种子与切分方式。

### 任务 7.3 步骤模型与映射器

新目录 `desktop/src/runs/trace/`：

```
trace-step.cjs           TraceStep 的 zod 模式（M7/M8 3.2）
trace-metadata.cjs       stripSessionMetadata(value)：递归删除 M7/M8 4.3 第 1 条列出的键名
trace-mappers/acp.cjs
trace-mappers/claude-stream-json.cjs
trace-mappers/codex-exec.cjs
trace-mappers/raw.cjs    其他结构化输出与纯文本：每个原始事件或每行一个 raw / stderr 步骤
trace-mappers/index.cjs  按 Agent 种类与输出格式选择映射器
```

- 每个映射器是一个工厂：`createMapper() → { map(rawEvent) → Array<TraceStep 草稿>, end() → Array<TraceStep 草稿> }`。草稿还没有经过脱敏，由 7.4 的轨迹写入器统一脱敏。
- 所有映射器先调用 `stripSessionMetadata` 处理原始事件，再映射。
- 流式增量事件（ACP 的 `agent_message_chunk`、`agent_thought_chunk`，Claude 的 `content_block_delta` 等）：映射器把它们的文本交给对应流的流式脱敏器（由 7.4 提供），`raw` 记为 `{ type, coalesced: true }`（M7/M8 3.2）。
- 同一次工具调用的开始与更新共用 `toolCallId`。
- 未知事件落为 `raw` 步骤，不丢弃、不抛错。
- **样例**：在 `desktop/test/fixtures/trace/` 中放入每种 CLI 至少一个完整会话的原始输出（使用里程碑 0 采集的样例；没有的，用本机 CLI 采集一个简单会话，去掉个人内容后放入）。

测试 `desktop/test/runs/trace/trace-mappers.test.cjs`：每份样例映射为预期的步骤（期望值写成数据文件，逐条对比）；未知事件落为 `raw`；工具调用的归并；**用 `desktop/test/fixtures/agent-output/` 中的现有样例与新样例，断言任何步骤的任何字段中都不含 `session_id`、`sessionId` 等字段，也不含样例中出现过的会话号字符串**。

### 任务 7.4 轨迹写入器

新文件 `desktop/src/runs/trace/trace-writer.cjs`：

```
function createTraceSink({ tracesRoot, runId, agentRunId, groupId, projectId, agentKind, outputFormat, childEnv, knownSessionRefs, now, onAppended })
  → {
      ingest(channel, rawEvent)    channel：'acp' | 'structured' | 'stdout' | 'stderr'
      end()                         Agent 运行结束：结束所有流、刷新、写入完成标记
    }
```

- 已知值集合：`childEnv` 与 CLI 配置中的密钥值（复用 `redactChildSecrets` 取值的那部分逻辑，`cli-runtime-event-sanitizer.cjs:72-75` 的 `childSecrets`）、项目密钥值、`knownSessionRefs`。
- 流：每个流一个 7.2 的流式脱敏器；非流式的字段（工具参数、工具输出、`raw`、`title`）在写入前整体经 `redactSecrets(redactChildSecrets(…))`。工具的流式输出按 `toolCallId` 各一个脱敏器。
- 步骤切分（500 毫秒或 4 KiB）只作用在流式脱敏器**放出**的文本上（M7/M8 3.2）。
- 存储按 M7/M8 第 5 节：`encodeId` 后的目录与文件名；`meta.json` 原子写入；`.jsonl` 追加写，每秒一次或满 64 KiB 写入并 `fsync`；字段超过 256 KiB 写入 `blobs/`；目录 `0700`、文件 `0600`。
- **任何错误都不能影响 Agent 调用**：`ingest` 与 `end` 内部捕获一切异常，记录诊断；写入失败后停止这次运行的写入，并在下一次能写时（或 `end` 时）写入一个「轨迹不完整」的 `lifecycle` 步骤。
- 每次写入后调用 `onAppended({ runId, agentRunId, lastSeq })`。

测试 `desktop/test/runs/trace/trace-writer.test.cjs`：追加写与 `fsync` 的批量规则（可注入的定时器）；末尾半行由 7.6 的读取器忽略（写一个半行后读）；超过 256 KiB 的字段进入 blob；写入失败时 `ingest` 不抛错、轨迹标记不完整；放出之前的内容不出现在文件中（在 `push` 一个未完成的密钥后立即读文件，断言其中没有它）。

### 任务 7.5 接入调用链

在不改变现有摘要通道任何行为的前提下接入（M7/M8 3.1）：

1. `local-workspace-agent-invocation.cjs`：每次 Agent 调用创建一个 `traceSink`（7.4），放进传给适配器的 `options`（字段名 `traceSink`）。`runId`、`agentRunId`、`groupId`、`projectId`、`agentKind` 取自这次调用；`knownSessionRefs` 取自会话状态中这次调用的原生会话号；调用结束时 `traceSink.end()`。
2. `cli-acp-runner.cjs:779` 的 `sessionUpdate(params)`：在现有处理之前加一行 `options.traceSink?.ingest('acp', params.update)`，包在 `try/catch` 中。
3. `cli-adapters.cjs` 的解码回调（`:300` 起）：在 `profile.mapEvent` 之前加 `options.traceSink?.ingest('structured', event)`；纯文本输出的 stdout 与 stderr 数据回调中加 `options.traceSink?.ingest('stdout' | 'stderr', chunk)`。同样包在 `try/catch` 中。
4. **回归测试**（M7/M8 第 10 节「接入点」）：用三种通道的样例驱动适配器，记录改动前与改动后摘要通道产出的事件序列，断言**完全相同**。改动前的序列先录下来存进 `desktop/test/fixtures/trace/summary-baseline/`，再改代码。

### 任务 7.6 轨迹读取与 IPC

新文件 `desktop/src/runs/trace/trace-reader.cjs`（分页、`blob`、`status`）与 `desktop/src/shell/trace-ipc.cjs`（注册 `trace:page`、`trace:blob`、`trace:status`），preload 暴露冻结的 `meldworkDesktop.trace`，以及监听 `trace:appended` 的 `onAppended(listener)`。

- 输入与上限按 M7/M8 6.1；`cursor` 为 main 生成的不透明字符串（例如 base64 编码的 `{ file, offset, mac }`，`mac` 为以一个进程内随机密钥计算的 HMAC），renderer 伪造或篡改的 `cursor` 被拒绝。
- `runId` 必须属于工作区中存在的群聊（读 `meta.json` 中的 `groupId` 并在工作区中确认），否则 `TRACE_NOT_FOUND`。
- `trace:appended` 每个 Agent 运行最多 5 次/秒（合并相邻的写入），从 7.4 的 `onAppended` 驱动。

测试 `desktop/test/runs/trace/trace-ipc.test.cjs`（M7/M8 第 10 节「接口」全部条目）。

### 任务 7.7 删除与清理

- 删除群聊（`local-workspace-conversations.cjs` 的 `deleteGroup`）：删除 `meta.json` 中 `groupId` 为它的全部轨迹目录。
- 删除项目室：M1/M5 第 9 节第 4 步「删除轨迹文件」调用同一个函数。
- 启动时清理孤立目录（M7/M8 5.3）。
- Run Ledger 淘汰运行**不**删除轨迹（写一个测试断言）。
- 设置页需要的数据：`trace:diskUsage()` 返回总占用；「清理旧轨迹」按群聊或时间删除，作为一个 IPC 方法 `trace:prune({ groupId? , olderThan? })`。

### 任务 7.8 工作目录 IPC

新文件 `desktop/src/shell/workdir-ipc.cjs` 与 `desktop/src/project-room/workdir-access.cjs`，preload 暴露 `meldworkDesktop.workdir`。严格按 M7/M8 第 8 节。

```
workdir-access.cjs:
  async resolveForRead(projectRoot, relPath, volumeInfo)    → { fd, realPath }   8.2（一）
  async listDirectory(projectRoot, relPath, volumeInfo, cursor) → { entries, cursor, hasMore }   8.2（二）
  validateForDiff(projectRoot, relPath, volumeInfo)          → normalized relPath   8.2（三）
  async fdRealPath(fd)                                       → string   Linux：readlink /proc/self/fd/<fd>；macOS：lsof -a -p <pid> -d <fd> -Fn（execFile）
  isInsideGitBoundary(relativeSegments, volumeInfo)          → boolean  8.2「.git 边界」：按卷大小写规则与 NFC 比较
  classifyContent(buffer, name)                              → 'text' | 'image' | 'binary'   8.3
```

- 工作目录的真实路径与卷信息（大小写）只取自项目记录与里程碑 2 的 `resolveRoot`；renderer 只提交 `projectId` 与 `relPath`。
- `read`：`O_RDONLY | O_NOFOLLOW` 打开 → `fdRealPath` → 范围与 `.git` 边界检查 → 只经这个 `fd` 读取 → `finally` 中关闭 `fd`。
- `diff`：只做共同的第一步与（路径存在时）`.git` 边界检查；内容调用里程碑 3 的 `numstat`、`fileDiff`、`describePathChange`；git 报 `beyond a symbolic link` 时返回 `WORKDIR_PATH_REJECTED`。
- `acceptedDocuments`：来自项目状态的投影，不读文件。
- Windows：`fdRealPath` 不可用，`read` 退回 M7/M8 8.2「Windows」一段的做法。

测试 `desktop/test/project-room/workdir-access.test.cjs`（M7/M8 第 10 节「工作目录」与「`.git` 边界」全部条目）。竞争测试的写法：在 `resolveForRead` 的各步之间注入一个钩子（只在测试中可用的参数），在钩子里执行目录替换，分别覆盖「打开之前替换」与「打开之后替换」两种情况。

### 任务 7.9 新增前端依赖

1. 核对 `@git-diff-view/vue` 的 LICENSE（应为 MIT）与最近的维护情况（最近一次发布时间、未关闭的严重问题），写进汇报。不符合时停下来问。
2. 加入 `frontend/package.json` 的 `dependencies`，固定版本。

### 任务 7.10 轨迹组件

新组件 `frontend/src/components/trace/TraceStepList.vue`、`TraceToolCard.vue`、`TraceRawView.vue`，composable `frontend/src/composables/useTraceStream.js`。按 M7/M8 第 7 节：

- `useTraceStream({ runId, agentRunId })`：首次打开时 `page` 拉取最后一页；向上滚动时向前翻页；收到 `trace:appended` 且停在底部时拉取新步骤；不在查看时不拉取。
- 工具卡片按 `toolCallId` 归并；输出折叠，展开时按需 `trace:blob` 分段拉取；超过 2,000 行分段显示。
- 步骤列表虚拟滚动（不引入新的依赖，按可见区域渲染即可）。
- 「原始输出」视图；被替换处的 `[redacted]` 以明显的样式显示。
- 复制命令与输出。
- `fullTrace` 为 `false` 的 Agent：只显示原始输出视图并说明原因（M7/M8 3.3）。

接入：

- `RunTracePanel.vue`：选中的 Agent 运行有完整轨迹时（`trace:status` 的 `lastSeq > 0`），在详情区域显示 `TraceStepList`；没有时保留现有的摘要显示，并说明「这次运行没有完整轨迹」。
- 项目室右侧抽屉的「轨迹」标签：显示当前选中调用的 `TraceStepList`。

测试（`frontend/src/__tests__/meldwork/` 下）：`useTraceStream` 的翻页与停在底部时的拉取；工具卡片的归并；blob 的按需拉取；没有完整轨迹时的回退显示。

### 任务 7.11 文件标签

新组件 `frontend/src/components/workdir/WorkdirTree.vue`、`FilePreview.vue`、`FileDiff.vue`，composable `frontend/src/composables/useWorkdirTree.js`。按 M7/M8 8.4、8.5：

- 「已接受文档」列表在最上方。
- 目录树：展开时 `list`；按 8.4 的三个时机刷新已展开的目录；`.git` 条目不可展开。
- 预览：文本分段加载、等宽字体；图片；二进制只显示元信息；SVG 以文本显示；`.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*` 先显示「这个文件可能包含密钥」，点击后才显示。
- diff：`@git-diff-view/vue` 展示 `workdir:diff` 的数据；占位文件与类型变化按 `describePathChange` 的说法显示，不显示内容。

测试：密钥文件的提示；SVG 不作为图片渲染；占位文件的 diff 显示与 `describePathChange` 一致；刷新只重新列出已展开的目录。

### 任务 7.12 文案

所有新文字进入 `zh.js` 与 `en.js`；两个文件的键集合相同（复用里程碑 6 的测试）。

### 任务 7.13 文档

按 M7/M8 第 9 节逐行修改：

1. `architecture.md`：Trust Boundaries 第 1、6 条；Local Data 表格新增 `meldwork-private/traces/`；Known Risks 新增 M7/M8 第 9 节列出的各条。
2. `AGENTS.md`：`Never expose executable paths, tokens, credentials, or unrestricted shell execution to renderer code.` 改为：除完整轨迹的显示以外，renderer 不接收可执行文件路径，也不能据此启动进程；令牌、凭据与不受限的命令执行仍然永不暴露给 renderer。中英表述以 `AGENTS.md` 现有的英文为准。
3. 在汇报中列出每一处修改与 M7/M8 第 9 节对应的行。

## 验收

**本里程碑运行的自动化测试**：任务 7.1–7.12 的全部测试；`npm --prefix desktop test`、`npm --prefix frontend test`、`npm --prefix frontend run build`、`npm --prefix frontend run build:desktop` 全部通过。

**回归**：任务 7.1 的脱敏语料逐字相同；任务 7.5 的摘要通道事件序列与改动前完全相同。两项都要在汇报中附上运行结果。

**Electron 人工检查**（逐条记录，附截图）：

1. 现有群聊：让 Agent 运行几条命令、读写几个文件，打开运行详情，看到命令原文、输出、思考内容；与终端中直接运行同一个 CLI 的输出对照，内容一致（除密钥外）。
2. 在 Agent 的环境中放一个测试用的密钥值（例如在群聊的 Agent 环境变量中设置一个假的 `TEST_API_KEY=meldwork-test-secret-123456`），让 Agent 执行 `echo $TEST_API_KEY`，确认轨迹中显示为 `[redacted]`，轨迹文件中也不含这个值（用 `grep` 检查 `meldwork-private/traces/`）。
3. 一个旧的、在本里程碑之前产生的运行：运行详情显示原来的摘要与「没有完整轨迹」的说明。
4. 项目室「文件」标签：浏览目录、预览文本与图片、查看一个已接受文档的 diff 与一个已删除文件的 diff；`.git` 不可展开；在工作目录中建一个 `alias → .git` 的符号链接，确认 `alias` 下的内容不可读。
5. 删除一个群聊后，`meldwork-private/traces/` 中它的目录被删除。

需求追踪：R21、R22。

## 停下来问的情况（除交接手册第 5 节之外）

- 任务 7.1 中，改动后的 `redactSecrets` 有任何一条语料的输出与改动前不同。
- 任务 7.5 中，接入后摘要通道的事件序列有任何不同。
- 某种 CLI 的原始输出中出现了不在 M7/M8 4.3 键名清单中、但看起来是会话或身份标识的字段。
- macOS 上 `lsof` 不能按描述符给出路径，或耗时超过 200 毫秒。
- `@git-diff-view/vue` 的许可证或维护状态不符合要求。
