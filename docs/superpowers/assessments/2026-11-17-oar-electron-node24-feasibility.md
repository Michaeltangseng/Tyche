# OAR + Electron/Node 24 直连可行性评估

> 日期：2026-11-17
> 评估对象：把 `@botiverse/oar`（下称 OAR）作为 Meldwork 的运行时适配层，直接运行在 Electron main 进程。
> 关联文档：`docs-new2/05-eta-reuse-map.md`、`docs/superpowers/handoffs/2026-11-17-meldwork-room-v2-handoff.md`
> 评估方式：静态阅读 + 本机实测。未改任何生产代码。
>
> **第二轮补充（2026-11-17）**：体积不再是评估项。Codex CLI 0.169.0 装好后，OAR 0.113 的 **HTTP** host MCP 在 `NO_PROXY=127.0.0.1,localhost` 下对 Claude（默认 YOLO）和 Codex（full-access / read-only+annotations）都跑通；此前的 HTTP 失败是本机系统代理（`127.0.0.1:1082`）导致的。用户方向：Meldwork 直接复用 eta 的 YOLO 模型，native tools 放开权限，host tools 仍由平台治理。详见 §10。

## 0. 结论摘要

**技术可行，但不建议“整体直连替换”。**

1. **Node 24 不是硬阻塞。** OAR 0.86.0 声明 `engines.node >= 24`，但本机实测在 Node **22.22.2**（Electron 39 同级）下可以完成：
   - ESM import、CJS 主进程 `import()`；
   - `serveMcpTools` 启动 + MCP `initialize` / `tools/list` / `tools/call`；
   - 真实 Claude Code session；
   - Claude 通过 host MCP 工具调用并返回 `echo:hello`。
   在 Node **24.22.3** 下同样通过。`engines` 是声明，不是运行时检查；但 Node 22 不在 OAR 支持范围内，生产环境不应依赖这个“能跑”。
2. **Electron 40+ 已内置 Node 24。** Electron 43.8.10 是当前仍受支持的最老大版本（Node 24.22.1），比 44/45 的破坏性变更少，建议作为升级目标；升级本身独立有价值。
3. **真正的阻碍是权限模型、进程治理、provider 覆盖和打包，不是 Node 版本。**
   - OAR 默认 YOLO；Claude 可以通过 `launchArgs` 映射权限，但 plan 模式会阻断 host MCP 工具，需要 `dontAsk + --allowedTools` 的组合。
   - Codex 的 sandbox 由**进程级** `OAR_CODEX_SANDBOX` 控制，同一进程内无法为并发 session 设置不同模式；OAR 的 Codex 走 `codex app-server`，与 Meldwork 现有 `codex exec` 是不同传输。
   - OAR 自己 spawn CLI（POSIX detached process group），不经过 Meldwork 的 `managed-spawn` / `process-registry`；正常退出有清理钩子，硬崩溃可能留下孤儿进程。
   - OAR 只覆盖 10 个 runtime，其中与 Meldwork 现有 14 个 provider 重叠约 6 个；整体替换会丢失 Gemini、DeepSeek、Mimo、ZCode、Hermes、WorkBuddy、OpenClaw、OpenCodeReview 等。
   - 直接依赖会引入约 **165 MB** 的 `node_modules`（含 pi 系依赖、wasm/native 资源）；按用户决定，体积暂不作为取舍依据。
4. **建议路线：**
   - **先做 Electron 39 → 43 升级**（Node 24.22.1），作为独立项目；
   - **OAR 只做 room runtime 的 Claude + Codex POC**（两者都用 HTTP；session env 加 `NO_PROXY`），feature flag、in-main；
   - **权限模型按 eta 简化**：native tools YOLO，host tools 仍由 dispatcher 治理；
   - **保底方案仍是薄 `runtime-adapter.cjs`**，不要为了 OAR 阻塞 room v2 工具循环交付；
   - **不做全部 provider 迁移**；Codex CLI 0.169 已装、`app-server` 可用，HTTP MCP 已在 `NO_PROXY` 下验证（见 §10.2）。

---

## 1. 评估范围

### 已验证

- Electron 各大版本的内置 Node 版本（官方 releases 数据）。
- OAR 0.86.0 的包结构、依赖、许可、Node 声明、API 面。
- Node 22.22.2 / 24.22.3 下的 import、CJS 动态 import、MCP server、真实 Claude session、host MCP 工具循环。
- Claude 的三种权限模式与 host MCP 工具的交互。
- OAR 的进程启动、信号、清理、detached 行为。
- Meldwork 的 Electron main / preload / safeStorage / dialog / 通知 / 打包 / 进程治理现状。

### 未验证

- OAR 在 **Electron 真机 main 进程**、asar 打包、签名后的行为（本次只验证了同版本 Node）。
- Windows / Linux 的进程组与清理。
- Codex（本机 `codex` 安装损坏，`codex app-server --help` 失败）。
- 长会话、跨重启 resume、真实崩溃后的孤儿进程。
- OAR 最新版 0.113.0（本次固定 eta 所使用的 0.86.0）。
- Meldwork 全量测试 / 打包。

---

## 2. 关键事实

### 2.1 Electron 版本线

来自 `https://releases.electronjs.org/releases.json`（2026-11-17 拉取）：

| 大版本 | 最新版本 | 内置 Node | 备注 |
| --- | --- | --- | --- |
| 39 | 39.8.10 | 22.22.1 | Meldwork 当前 |
| 40 | 40.10.6 | 24.15.0 | 第一个 Node 24 线 |
| 41 | 41.10.7 | 24.18.0 | |
| 42 | 42.11.18 | 24.19.0 | |
| 43 | 43.8.10 | 24.22.1 | 当前支持窗口内最老 |
| 44 | 44.11.3 | 24.22.2 | |
| 45 | 45.3.3 | 24.22.3 | 最新 |

按 Electron “最新三个稳定大版本”的支持策略推断，当前支持窗口是 43/44/45；40–42 已过支持期。具体以官方支持政策为准。

### 2.2 OAR 0.86.0

| 项 | 值 |
| --- | --- |
| 包名 | `@botiverse/oar` |
| 版本 | 0.86.0（eta 固定） |
| 许可 | Apache-2.0 |
| 模块 | ESM only (`type: module`) |
| engines | `node >= 24.0.0` |
| dist 大小 | 约 7.9 MB |
| 安装体积（实测） | 约 122 packages / 约 165 MB（初次安装；补 `zod` 后略增） |
| 关键依赖 | `@agentclientprotocol/sdk`、`@earendil-works/pi-ai`、`pi-coding-agent`、`cross-spawn`、`dotenv`、`undici@8.12.3`、`which` |
| 依赖许可 | pi-ai / pi-coding-agent MIT；ACP SDK Apache-2.0；undici MIT；可选 Cursor SDK 许可需单独确认 |
| 默认 runtimes | antigravity, claude, codex, codebuddy, grok, kimi, opencode, pi, qwen, qoder |

OAR 的定位是“provider-independent TypeScript contracts and built-in implementations”，与 eta 的 runtime seam 对齐：

- `packages/eta-server/src/runtimes.ts`：`SessionRuntimes.open(input) → SessionRuntime { models, delegate, compact, dispose }`。
- `packages/eta-runtime-oar/src/delegate.ts`：OAR delegate，负责 host tools → MCP、`mcpServers`、steering、resume、wake。
- `packages/eta-runtime-acp/src/delegate.ts`：ACP delegate，host tools 作为本地 HTTP MCP server 传入 `session/new` / `resume` / `load`。

> 快照说明：本地 eta 源码为 `1a110998`，比 handoff 固定的 `03197d88` 新 35 个 commit（同一天）。本评估的 OAR 版本以 eta `package.json` 的 `0.86.0` 为准；若换 OAR 版本，需要重新核对 API 与权限行为。

### 2.3 Meldwork 现状

| 项 | 现状 | 影响 |
| --- | --- | --- |
| Electron | 39.8.10（Node 22.22.1） | 直接运行 OAR 受 engines 声明限制（实测可跑，但不支持） |
| main 模块 | CJS (`desktop/src/main.cjs`) | 需要动态 `import()` 加载 OAR；实测可行 |
| 渲染 sandbox | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (`main.cjs:978-981`) | Electron 45 的 preload 变更需关注 |
| SQLite | `node:sqlite` `DatabaseSync` (`room/db.cjs`) | Node 24 可用；Electron 40+ 不受影响 |
| 安全存储 | `electron.safeStorage.*` (`main.cjs:226-228`) | Electron 45 弃用这三个 API；43 不受影响 |
| 原生模块 | 自带 C supervisor（独立二进制），无 native npm addon | Electron ABI 升级风险较低 |
| 进程治理 | `managed-spawn` + C supervisor + `process-registry` + `run-scheduler` | OAR 自己 spawn，绕开这一层 |
| 打包 fuses | `runAsNode: false`, `enableNodeOptionsEnvironmentVariable: false`, `onlyLoadAppFromAsar: true`, `enableEmbeddedAsarIntegrityValidation: true` (`scripts/after-pack.cjs`) | 不能用 `ELECTRON_RUN_AS_NODE` 做 sidecar |
| 对话框 | 多处 `showOpenDialog` 未传 `defaultPath` | Electron 43 默认改为 Downloads，需显式传 |
| 通知 | main 进程使用 `new Notification` | Electron 42 起 macOS 需要代码签名 |

---

## 3. 实测结果

测试目录：`/tmp/oar-test`（OAR 0.86.0 + zod 4.4.3），Node 22 使用 `~/.nvm/versions/node/v22.22.2`，Node 24 使用 `~/.nvm/versions/node/v24.22.3`。

### 3.1 import

| 场景 | Node 22.22.2 | Node 24.22.3 |
| --- | --- | --- |
| ESM `import('@botiverse/oar')` | ✅ | ✅ |
| CJS `node -e "import('@botiverse/oar')"` | ✅ | ✅ |
| `defaultRuntimes.list()` | 10 个 | 10 个 |

### 3.2 MCP host tools

用 OAR 的 `serveMcpTools` 启动一个本地 HTTP MCP server，注册 `echo` 工具：

- `initialize` → 200，返回 `mcp-session-id`；
- `tools/list` → 200，列出 `echo`；
- `tools/call` → 200，返回 `echo:hi`；
- `close()` 正常。

Node 22 / 24 均通过。OAR 的 server 绑定 `127.0.0.1`，使用 `Authorization: Bearer <token>`、`timingSafeEqual`、loopback Origin 检查，安全性符合 Meldwork 的 MCP 使用方式。

### 3.3 真实 Claude session

| Node | 安装探测 | 会话 | 结果 |
| --- | --- | --- | --- |
| 22.22.2 | `claude 2.1.318`，`/Users/limu/.local/bin/claude` | 新建 session，`--permission-mode plan` | 输出 `OK`，`turn_ended: completed`，dispose 正常 |
| 24.22.3 | 同上 | 同上 + host MCP | 工具循环通过 |

### 3.4 权限模式与 host MCP 工具

这是本次评估最关键的一组结果。Claude session 配置 `mcpServers: [served.server]`，prompt 要求调用 `meldwork` server 的 `echo` 工具：

| 模式 | 配置 | 工具调用 | 结论 |
| --- | --- | --- | --- |
| plan | `launchArgs: ['--permission-mode','plan']` | ❌ 自动拒绝 | plan 模式不允许需要审批的 MCP 工具；无审批面 |
| acceptEdits | `--permission-mode acceptEdits` | ❌ 自动拒绝 | 仍需显式 allow |
| acceptEdits + allowedTools | `--permission-mode acceptEdits --allowedTools mcp__meldwork__echo` | ✅ `echo:hello` | 可用，但允许写 |
| **dontAsk + allowedTools** | `--permission-mode dontAsk --allowedTools mcp__meldwork__echo` | ✅ `echo:hello` | **推荐给“只读聊天 + host 工具”** |
| OAR 默认 | 不传 `launchArgs` | 可用（YOLO） | 不可接受 |

结论：

- **Meldwork 的 chat 回复“只读但需要 mention/read_chat/create_task 工具”**，在 OAR 下不能用 Claude 的 `plan` 模式；应使用 `dontAsk` + `--allowedTools` + `disallowedTools`（Claude 原生 deny 通道）来表达“默认拒绝、只允许明确工具”。
- `acceptEdits` 会允许文件编辑，适合 Task 写入型 run；但 Meldwork 的写租约/路径声明仍在平台层，不能只靠 CLI 权限。
- OAR 的 Claude adapter 明确拒绝 `--permission-prompt-tool`，因为它没有审批接口；host 侧不能指望收到权限回调。

### 3.5 Codex

> 第二轮补充：安装 Codex CLI 0.169.0 后，OAR 探测已 `available`；`codex app-server` 与模型正常。HTTP MCP 失败是本机系统代理导致，加 `NO_PROXY` 后已跑通；见 §10.2。

本机 `codex` 当前不可用：

```
codex --version
Error: spawn .../@openai/codex-darwin-arm64/.../codex ENOENT
```

OAR 的安装探测返回：

```json
{"kind":"unsupported","reason":"app-server --help failed"}
```

原因不是 OAR 不支持 Codex，而是：

- OAR 的 Codex adapter 走 `codex app-server`（JSON-RPC），不是 `codex exec`；
- 本机 npm 安装的 Codex wrapper 指向缺失的 vendor 二进制。

如果采用 OAR，Codex 的前置条件是：安装一个能正常运行 `codex app-server` 的 Codex CLI 版本。Meldwork 现有 `cli-invocations.cjs` 使用的是 `codex exec --json`，与 OAR 的传输不同。

### 3.6 进程治理

OAR 在 POSIX 上以 `detached: true` 启动每个 runtime 子进程，使其成为独立进程组 leader，便于用负 PID 结束整组（`dist/shared/executable/process-signals.js`）。它维护 `ownedChildren`，并在 `process.once('exit')` 中同步清理（`dist/shared/executable/ownership.js`）。

| 场景 | OAR 行为 | 与 Meldwork 的关系 |
| --- | --- | --- |
| 正常 dispose / 进程正常退出 | 清理 owned children / descendants | 可用 |
| 未处理信号 / SIGKILL / 主进程硬崩 | Node 不触发 `exit` 钩子，可能留下 detached 子进程 | Meldwork supervisor 无法直接看到这些子进程 |
| 启动孤儿对账 | OAR 不做跨重启对账 | 需 Meldwork 额外实现 |

Meldwork 的 `managed-spawn` 通过 `MELDWORK_CONTAINER` 标记 + supervisor 管理进程组；OAR 的子进程不在这个体系内。一个可行的缓解是把 `MELDWORK_CONTAINER` 通过 `SessionOptions.env` 注入 OAR session，启动时扫描并清理；但 `process-inspect.cjs` 已注明 **macOS 15 不再向其他进程暴露环境变量**（`ps -E` 只返回 argv），因此标记扫描在 macOS 15 上不可靠。更稳妥的是 sidecar + 优雅关闭，或向 OAR 上游提一个 spawn/registry 钩子。

### 3.7 打包体积

OAR 安装后的主要体积：

| 目录 | 大小 |
| --- | --- |
| `@earendil-works`（pi 系） | 41 MB |
| `openai` | 27 MB |
| `@anthropic-ai` | 14 MB |
| `@google` | 11 MB |
| `web-streams-polyfill` | 8.7 MB |
| `@botiverse/oar` | 7.9 MB |
| `@agentclientprotocol` | 6.2 MB |
| `undici` | 2.5 MB |

还包含：

- `@earendil-works/pi-tui/native/{darwin,linux,win32}/prebuilds/*.node`（三平台 native prebuild）；
- `quickjs-wasi/quickjs.wasm`、`@silvia-odwyer/photon-node/photon_rs_bg.wasm`；
- `pi-coding-agent` 的 examples 里还有 `doom.wasm`。

如果直接 `npm install` 并让 electron-builder 打包，体积和平台资源都会显著增加。可选缓解：

1. 只 deep-import 需要的 runtime（如 `@botiverse/oar/runtimes/claude`），不用根 index；
2. 用 esbuild 打包并按需 tree-shake，但 OAR 的动态 import / 可选 peer 可能增加复杂度；
3. 对 `.node` / `.wasm` 配置 `asarUnpack`；
4. 只保留当前平台资源。

---

## 4. 可行性判断

### 4.1 Node 24 不是硬阻塞

- OAR 的 `engines.node >= 24` 是 npm 元数据；Node 22.22.2 下 import、MCP、真实 Claude、host MCP 工具循环全部通过。
- 但 Node 22 不在 OAR 的 CI/支持矩阵内，任何上游 bug 都可能被归因为“不支持的 Node”。
- 生产建议二选一：
  - **升级 Electron 到 40+（推荐 43）**，拿到受支持的 Node 24；
  - 或接受 Node 22 的 unsupported 状态，并锁定 OAR 版本、加专项回归测试。

### 4.2 Electron 39 → 43 升级可行性

**有利因素：**

- main/preload 都是纯 JS，没有 native npm addon；C supervisor 是独立 C 二进制，不受 Electron ABI 影响。
- `node:sqlite` 在 Node 24 仍可用。
- preload 只用了 `contextBridge`、`ipcRenderer`、`process.platform`，没有 `Buffer` / `setImmediate` / `clearImmediate`，Electron 45 的 sandboxed preload 移除项影响较小。
- 代码签名 / notarize 已在 public 构建配置中启用（`electron-builder.public.cjs`：`forceCodeSigning`、`notarize`、`afterSign`）。

**需要处理的破坏性变更（39 → 43）：**

| 版本 | 变更 | 对 Meldwork 的影响 |
| --- | --- | --- |
| 40 | renderer 直接使用 `clipboard` 模块被弃用 | 前端用 `navigator.clipboard`，低风险 |
| 41 | PDF 不再单独 WebContents；cookie change cause | 未发现相关用法，低风险 |
| 42 | macOS 通知改用 `UNNotification`，要求代码签名 | public 构建已签名；dev/adhoc 构建可能收到 `failed` 事件 |
| 42 | `nativeImage.createFromNamedImage` 只传数组被弃用 | 检查是否使用 |
| 42 | `Session.clearStorageData({ quotas })` 移除 | 检查是否使用 |
| 42 | Electron 改为首次运行时下载二进制（postinstall 变更） | 影响 CI / 打包脚本；需验证 electron-builder |
| 43 | `dialog.showOpenDialog/SaveDialog` 默认目录改为 Downloads | Meldwork 多处未传 `defaultPath`，需显式补上以保持 UX |
| 43 | Linux 无边框窗口圆角 / WCO 行为变化 | Linux UI 需回归 |
| 43 | `NativeImage.toBitmap()` 默认转 sRGB | 检查截图/图像处理 |
| 43 | Linux `showHiddenFiles` 移除 | 检查对话框用法 |

**不建议直接上 44/45：**

- 44 移除 renderer `clipboard` 模块、macOS 12 支持、32 位支持，并调整登录项属性；
- 45 移除 sandboxed preload 的 Node 模块 shim / `Buffer` / `setImmediate`，并弃用 `safeStorage.isEncryptionAvailable/encryptString/decryptString`——Meldwork 正在使用这三个 API（`main.cjs:226-228`）。
- 因此 **Electron 43 是当前性价比最高的目标**：Node 24.22.1，破坏性变更可控。
- 支持窗口提醒：按最新三个稳定大版本的支持策略，43 会在 Electron 46 发布后退出支持。如果升级排期晚于 2026-12，建议直接评估 44（变更最接近 43）或 45（需额外处理 `safeStorage` 弃用与 preload 变更）。

### 4.3 OAR 直连的架构缺口

| 缺口 | 说明 | 严重度 |
| --- | --- | --- |
| 权限模型 | OAR 默认 YOLO；Claude 可映射，Codex sandbox 是进程级 env，ACP auto-allow | **高** |
| 进程治理 | OAR 自行 spawn detached 子进程，不经过 Meldwork supervisor / registry | **高** |
| Provider 覆盖 | OAR 10 个 runtime，与 Meldwork 14 个 provider 重叠约 6 个 | **高** |
| 事件/Trace 映射 | OAR Event stream → Meldwork runtime events / Trace / Timeline 需要翻译层 | 中 |
| 打包 | +165 MB、native/wasm、asarUnpack、平台裁剪 | 中 |
| Session 恢复 | OAR 有 resume，但平台侧还要负责 lane 挂起、写租约、进程对账 | 中 |
| 版本漂移 | OAR 0.86 → 0.113 迭代快，需要锁定与升级策略 | 中 |
| MCP server 重复 | Meldwork 已有 `room/tools/mcp-server.cjs`；OAR 也有 `serveMcpTools` | 低（可二选一） |

### 4.4 安全边界影响

对照 `Tyche/AGENTS.md`：

- **Agent execution 留在 Electron main**：OAR in-main 满足；sidecar 则是一个新的本地进程，需要明确边界。
- **Respect native Agent configuration**：OAR 默认 `userConfiguration: include`，可以保留用户配置；但 `disallowedTools` / `launchArgs` 的覆盖需要谨慎，不能变成 “provider override”。
- **No gateway-specific adapters / bundled patches**：OAR 是 provider-agnostic 库，不是 Magpie 式网关；但若要修改 OAR 行为（例如 spawn 钩子、permission API），应走上游，不内置 patch。
- **Workspace write opt-in**：OAR 默认 YOLO 写权限，不能直接使用；必须用 `dontAsk`/`disallowedTools`/`OAR_CODEX_SANDBOX` + 平台写租约共同约束。
- **Secrets**：OAR 的 `serveMcpTools` token 只在本机内存/headers 中；Meldwork 仍应使用 OS secure storage 存长期凭据。

---

## 5. 方案对比

| 方案 | Node | 权限契合 | 进程治理 | Provider 覆盖 | 打包 | 预估工作量 | 风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A. Electron 43 + OAR in-main** | 受支持 Node 24 | 中（Claude 可映射；Codex 进程级；ACP auto-allow） | 弱（OAR 自管，硬崩可能孤儿） | 6/14 重叠 | +165 MB + native/wasm | POC 3–5 周 | 中高 |
| **B. Electron 39/43 + Node 24 sidecar** | 受支持 | 同 A | 较好（supervisor 管 sidecar + 优雅关闭） | 同 A | +Node/Bun 二进制 + OAR | 4–6 周 | 高（新进程/IPC/打包/签名） |
| **C. 不引入 OAR，薄 runtime-adapter** | 不变 | 强（沿用现有 per-seat 权限） | 强（managed-spawn） | 全部现有 | 几乎无 | 3–5 天 | 低 |
| **D. 混合：OAR 仅 room runtime，Claude 先行** | Electron 43 | 中，范围可控 | 需补 marker/关闭钩子 | room 内 Claude/Codex | +165 MB | POC 2–4 周 | 中 |

补充：

- **方案 A** 的最大问题是“整体替换”会与现有 `cli-adapters.cjs` 形成两套 runtime 语义，而且 OAR 缺少 8 个 Meldwork provider。除非接受“按 provider 分栈”，否则不推荐。
- **方案 B** 能绕开 Electron 升级（sidecar 用 Node 24），但 fuses 已禁用 `runAsNode`，必须自带 Node 24 或 Bun 二进制；IPC、生命周期、打包、签名都是新成本。A 的 Electron 升级反而更简单。
- **方案 C** 是 room v2 工具循环的最低风险路径；它复用 OAR/eta 的语义（per-run MCP、resume、host tools），但不引入 OAR 运行时。
- **方案 D** 是把 OAR 限定在“新 room 的运行时适配器”，不改旧 chat/agent 层；可以作为 A 的渐进版。

---

## 6. 推荐路线

### 6.1 决策拆分

把问题拆成两个独立决策，不要捆绑：

**决策 1：Electron 39 → 43**

- 建议：**做**。即使不采用 OAR，Node 24、安全支持、后续 runtime 选型都受益。
- 不采用 OAR 也应升级；采用 OAR 则必须升级（或用 unsupported Node 22）。
- 预估：2–4 天升级 + 3–5 天回归（含打包、签名、通知、对话框、preload、node:sqlite）。

**决策 2：OAR 的采用范围**

- 建议：**不做整体替换；先做 room runtime 的 Claude POC**。
- POC 范围：
  - Electron 43 分支；
  - 只接 Claude；
  - 只接 room 的 `engine.startReply` / `taskQueue.pump`（新 domain）；
  - host tools 用 `mention` / `read_chat` / `create_task` / `finish_task`；
  - 权限：chat 用 `dontAsk + --allowedTools + disallowedTools`；Task 写用 `acceptEdits` + allowedTools；
  - 进程：注入 `MELDWORK_CONTAINER`，加启动孤儿扫描；验证正常退出 / SIGTERM / SIGKILL；
  - 事件：映射到 Meldwork runtime event / Trace；
  - 打包：先估算体积，再决定 deep import / bundling。
- 通过标准：见 §7。

### 6.2 不建议现在做的事

- **不要**用 OAR 替换整个 `cli-adapters.cjs`。
- **不要**为了 OAR 引入 sidecar（除非 Electron 升级被否决）。
- **不要**在 Codex 本机安装修复前承诺 Codex POC。
- **不要**让 OAR POC 阻塞 room v2 的薄 adapter 交付。

### 6.3 粗略工期

| 工作 | 预估 |
| --- | --- |
| Electron 39 → 43 + 回归 | 5–9 天 |
| OAR room adapter（Claude）POC | 10–20 天 |
| Codex app-server 接入（前置修复后） | 5–10 天 |
| 打包裁剪 / 体积优化 | 5–10 天 |
| 全 provider 迁移 | 4–8 周，不建议当前做 |

以上为工程估算，不是承诺；实际取决于 Electron 升级回归和 OAR 事件映射的复杂度。

---

## 7. Spike / Go-No-Go 清单

### Electron 43 升级

- [ ] `npm --prefix frontend test`
- [ ] `npm --prefix frontend run build`
- [ ] `npm --prefix frontend run build:desktop`
- [ ] `npm --prefix desktop test`
- [ ] `npm --prefix desktop run pack`
- [ ] Electron desktop 模式实际聊天（AGENTS.md 要求）
- [ ] `node:sqlite` 打开 / 事务 / WAL
- [ ] preload 的 `contextBridge` / `ipcRenderer` / `process.platform`
- [ ] `safeStorage` 加解密
- [ ] macOS 通知（签名 / 未签名两种情况）
- [ ] 所有 `showOpenDialog` / `showSaveDialog` 的 `defaultPath`
- [ ] fuses / asar integrity / 签名 / notarize
- [ ] Windows / Linux 冒烟（至少打包启动）

### OAR room adapter（Claude）

- [ ] Electron 43 main 中动态 import OAR（asar 内 / 外）
- [ ] 每个 run 启动 `serveMcpTools` + `dispatcher.bindRun`
- [ ] Claude chat：`dontAsk` + `--allowedTools mcp__<server>__<tool>` + `disallowedTools`
- [ ] Claude Task：`acceptEdits` + allowedTools，写租约仍由平台校验
- [ ] `mention` / `read_chat` / `create_task` / `finish_task` 真实调用
- [ ] session resume：跨 run 复用 native session ref
- [ ] abort / stop：`session.abort()` + dispose
- [ ] 进程：正常退出无孤儿；SIGTERM 优雅关闭；SIGKILL 后启动扫描
- [ ] 事件映射：text / reasoning / tool call / turn end / usage / exit
- [ ] Trace / Timeline / Report 数据完整
- [ ] 打包体积与启动延迟
- [ ] 与 `room-seam-smoke.cjs` 的 `engineDriven: true` 对齐

### Codex（前置）

- [ ] 修复本机 `codex` 安装（vendor 二进制缺失）
- [ ] `codex app-server --help` 成功
- [ ] `OAR_CODEX_SANDBOX=read-only` / `workspace-write` / `danger-full-access` 行为
- [ ] 并发 session 不同 sandbox 模式的隔离方案
- [ ] `disallowedTools` 只支持 MCP 名称的限制是否影响 room 工具

### Go / No-Go

**Go：**

- Electron 43 全部检查通过；
- Claude chat + Task 的 host MCP 工具循环通过；
- 权限模式与 Meldwork 的 per-seat 语义一致；
- 正常退出与 SIGKILL 后无孤儿，或孤儿可被可靠清理；
- 打包体积 / 启动延迟可接受；
- Codex `app-server` 可用（若要接 Codex）。

**No-Go：**

- 无法在 `dontAsk` / `acceptEdits` 下稳定调用 host 工具；
- 进程治理无法达到现有 supervisor 的恢复语义；
- OAR 事件映射导致 Trace/Report 丢失关键数据；
- 打包体积或 asar/ESM 兼容不可接受；
- Codex 只能走 `exec`，OAR 的 `app-server` 无法接入。

---

## 8. 附录：实测命令与输出摘要

### 8.1 安装

```bash
mkdir -p /tmp/oar-test && cd /tmp/oar-test
npm init -y
npm install --ignore-scripts --omit=optional --omit=peer --no-audit --no-fund @botiverse/oar@0.86.0
npm install --ignore-scripts --no-audit --no-fund zod@4.4.3
```

结果：`added 122 packages`，`node_modules` 约 165 MB。

### 8.2 Node 22 / 24 import

```bash
cd /tmp/oar-test
~/.nvm/versions/node/v22.22.2/bin/node -e "import('@botiverse/oar').then(m => console.log(process.versions.node, m.defaultRuntimes.list().length))"
~/.nvm/versions/node/v24.22.3/bin/node -e "import('@botiverse/oar').then(m => console.log(process.versions.node, m.defaultRuntimes.list().length))"
```

输出：`22.22.2 10` / `24.22.3 10`。

### 8.3 真实 Claude + host MCP（Node 22 / 24）

核心配置：

```js
const served = await serveMcpTools({
  name: 'meldwork',
  tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, handler: i => 'echo:' + i.text }],
})
const session = await runtime.session(installation, {
  cwd: '/tmp/oar-claude-smoke',
  launchArgs: ['--permission-mode', 'dontAsk', '--allowedTools', 'mcp__meldwork__echo'],
  mcpServers: [served.server],
})
```

输出（两个 Node 版本一致）：

```
[tool_started] ToolSearch
[tool_ended] ToolSearch ok
[tool_started] mcp__meldwork__echo
[tool_ended] mcp__meldwork__echo ok
echo:hello
[turn_ended] {"kind":"completed"}
[run] ended "echo:hello"
```

### 8.4 权限模式对比

- `--permission-mode plan`：MCP 工具被自动拒绝，模型明确回复 “blocked because this session is in plan mode”。
- `--permission-mode acceptEdits`（不带 `--allowedTools`）：仍被自动拒绝。
- `--permission-mode acceptEdits --allowedTools mcp__meldwork__echo`：成功。
- `--permission-mode dontAsk --allowedTools mcp__meldwork__echo`：成功。

### 8.5 Codex 探测

```bash
codex --version
# Error: spawn .../@openai/codex-darwin-arm64/.../codex ENOENT

cd /tmp/oar-test
~/.nvm/versions/node/v22.22.2/bin/node --input-type=module -e "
const { defaultRuntimes } = await import('@botiverse/oar')
console.log(await defaultRuntimes.require('codex').installation())
"
# {"kind":"unsupported","reason":"app-server --help failed"}
```

---

## 10. 第二轮补充实测（2026-11-17）

> 体积不再作为评估项（用户明确：以后再说）。本节记录 Codex CLI 安装后的实测、eta 权限模型，以及可由版本/环境/配置直接解决的问题。

### 10.1 结论更新（已修正）

- Codex CLI 0.169.0（`/Users/limu/Library/pnpm/codex`）安装后，OAR 的 `codex` 安装探测返回 `available`；`codex app-server` 与真实模型（Cubence `gpt-6.1-sol`）均正常。
- **此前把 HTTP MCP 失败归因于 Codex/OAR 不兼容是错的。根因是本机 macOS 系统代理**：`HTTPProxy/HTTPSProxy = 127.0.0.1:1082`，异常列表有 `localhost` 但没有 `127.0.0.1`；Codex 的 MCP HTTP 客户端把发往 `127.0.0.1` 的请求也交给了代理，于是出现 `rmcp ... http/request failed`。
- 给 Codex session 加 `NO_PROXY=127.0.0.1,localhost` / `no_proxy=127.0.0.1,localhost` 后，**HTTP host MCP 全部跑通**：
  - Codex `danger-full-access` + HTTP + annotations → `echo:hello`；
  - Codex `read-only` + HTTP + annotations → `echo:hello`；
  - Codex `read-only` + HTTP **无 annotations** → 被拒，返回 `MCP tool call requires approval, but approval policy is never`；
  - Claude 默认 YOLO（不传 `launchArgs`）+ HTTP + annotations → `echo:hello`。
- **OAR 0.113 支持 `HostTool.annotations`**；0.86 没有。Codex read-only 需要 `readOnlyHint: true`（或 `destructiveHint: false` + `openWorldHint: false`）；YOLO/full-access 不需要，但保留真实标注没有坏处。
- **不需要 stdio bridge**。stdio 仍然是可用的 fallback，但当前证据表明 HTTP `serveMcpTools` 对 Claude 和 Codex 都能用。之前 stdio 测试成功是因为它同时换了传输和 annotations，不能证明 HTTP 本身不行。
- 正式 Meldwork 只需要 Codex CLI；OAR 的 Codex adapter 走 `codex app-server`，不依赖 Codex 桌面端。

### 10.2 实测记录（变量隔离）

| 场景 | 结果 |
| --- | --- |
| 安装 | `codex-cli 0.169.0`，OAR 探测 `{"kind":"available","command":"/Users/limu/Library/pnpm/codex"}` |
| app-server + 模型 | 通过；`gpt-6.1-sol`（Cubence）正常返回文本 |
| Codex HTTP + full-access + **无 NO_PROXY** | 失败；`rmcp ... http/request failed ... 127.0.0.1` |
| Codex HTTP + full-access + **NO_PROXY** | `mcpToolCall` 成功，返回 `echo:hello` |
| Codex HTTP + read-only + **NO_PROXY + annotations** | `mcpToolCall` 成功，返回 `echo:hello` |
| Codex HTTP + read-only + **NO_PROXY，无 annotations** | 被拒：`MCP tool call requires approval, but approval policy is never` |
| Codex stdio + read-only + annotations | `mcpToolCall` 成功，返回 `echo:hello`（fallback） |
| Claude 默认 YOLO + HTTP + annotations | `mcp__meldwork__echo` 成功，返回 `echo:hello` |
| Claude `dontAsk` + `--allowedTools` + HTTP | 成功（非 YOLO 模式参考） |
| 进程清理 | `session.dispose()` 后未观察到 OAR 专属残留 |

代理证据：

```text
scutil --proxy
  HTTPEnable : 1
  HTTPProxy  : 127.0.0.1
  HTTPPort   : 1082
  HTTPSEnable: 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort  : 1082
  ExceptionsList: localhost, 10.0.0.0/8, *.local, ...（不含 127.0.0.1）
```

修复方式：在 **runtime 子进程 env** 里设置：

```ts
env: {
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
}
```

这对所有需要访问本机 MCP server 的 runtime 都适用；不要依赖用户改系统代理。

### 10.3 eta 的权限模型

eta 是三层，不是一层：

1. **Native runtime tools**：OAR 默认 YOLO（Claude `--dangerously-skip-permissions`、Codex `approvalPolicy: never` + `danger-full-access`）；ACP 的 `session/request_permission` 一律回答 yes。eta **没有** per-agent / per-seat 的 native permission mode。
2. **Host tools**：`toolMiddleware` 链；approval list（`setting` 表的 `approvals`）通过 session 的 ask channel 询问，成为持久的 Inbox 问题（`allow` / `deny`）；本地 session 和外部 runtime session 都走同一条链（`packages/eta-server/src/manager.ts` 在注册/提供 host tools 前安装 middleware）。
3. **MCP / plugin tools**：每个 server 的 `approveTools`（allow/deny card）、akhook 规则；JS realm 对 project/global layer capability 另有 approval store。

设计理由：eta 的 agent 是 always-on / unattended，CLI 交互式权限提示会挂起；所以它把“需要人”的动作变成 Inbox 问题，native tools 交给 runtime 自己的权限/配置。

**按你的决定，Meldwork 直接复用 eta 的 YOLO 模型：**

- **Native tools 默认放开**：Claude 不传 `launchArgs`，Codex 用 OAR 默认 `danger-full-access`；不需要 per-seat 的 `dontAsk` / `acceptEdits` / `allowedTools` 映射。
- **Host tools 仍由平台治理**：Meldwork 的 `dispatcher` 是 eta `toolMiddleware` 的等价 seam。`allowedTools`（每个 run 能用哪些 host 工具）、approval（敏感工具映射到 Attention/UI）、redaction、audit 继续保留。这不会因为 YOLO 而消失。
- **annotations 保留为真实元数据**：`read_chat` / `mention` 等只读工具标 `readOnlyHint: true`；写入类不要乱标。YOLO 下 Codex 不依赖它，但未来切到 read-only / 更强模式时直接可用。
- **Workspace 写权限仍在 Room 层 opt-in**：按 `AGENTS.md`，用户选择可写 workspace 后才开放写入；一旦 opt-in，agent 在该 workspace 内按 eta 的 YOLO 运行。这样不违背“workspace write access opt-in”，也不把执行权限暴露给 renderer。
- **ACP providers 也是 YOLO**：与 eta 一致；如果以后需要 per-seat 模式，再保留/接回 Meldwork 现有的 ACP runner。
- **Approval 可以 per-Room / per-seat**：eta 是全局 approval list；Meldwork 可以更细，把 pending approval 映射到 Attention/UI。
- **Host tools 权限与 runtime 解耦**：这是 room v2 最需要的；Meldwork 已经按 run 绑定 `allowedTools`，继续在 dispatcher 加 approval/audit 即可。

如果以后仍需非 YOLO 模式，映射表是现成的：

| Runtime | 非 YOLO 映射 |
| --- | --- |
| Claude | `dontAsk` + `--allowedTools` + `--disallowedTools`；Task 写用 `acceptEdits`；resume 重发 `launchArgs` |
| Codex | `OAR_CODEX_SANDBOX=read-only/workspace-write` + annotations；`disallowedTools` 只支持 MCP 名称 |
| ACP | 保留 Meldwork 的 ACP 权限回调，或只在支持 `disallowedTools` 的 provider 上用 OAR |

### 10.4 可由版本/环境/配置直接解决的事项

| 问题 | 简单手段 | 结论 |
| --- | --- | --- |
| Codex app-server 缺失 | 安装 Codex CLI（0.169.0） | 已解决 |
| Codex HTTP MCP 失败 | 在 session env 里加 `NO_PROXY` / `no_proxy` 排除 127.0.0.1、localhost、::1 | **已解决，无需 bridge** |
| Codex read-only host tools | OAR ≥0.113 + `readOnlyHint` annotations | 已验证；YOLO 下不需要 |
| Codex YOLO host tools | OAR 默认 `danger-full-access` + `NO_PROXY` | 已验证 |
| Claude YOLO host tools | 不传 `launchArgs` + `NO_PROXY` | 已验证 |
| Claude 非 YOLO host tools | `dontAsk` + `--allowedTools` + `--disallowedTools` | 已验证，可选 |
| Codex sandbox 并发 | 切非 YOLO 且需要混合模式时，`OAR_CODEX_SANDBOX` 在 `session()` 前后串行设置（mutex） | 仅非 YOLO 需要 |
| Node 版本 | POC 用 nvm Node 24；生产 Electron 43（Node 24.22.1） | 简单 / 中等 |
| OAR executable 路径 | `OAR_CLAUDE_BIN` / `OAR_CODEX_BIN` 或 PATH | 简单 |
| OAR annotations | 0.86 → 0.113（或更高） | 简单 |
| OAR ESM / asar | 动态 import；必要时 `asarUnpack` | 简单 / 中等 |
| 进程清理 | `app.on('will-quit')` dispose + OAR exit hook；硬崩孤儿仍需 wrapper/sidecar | 部分解决 |
| Electron 43 | dialog `defaultPath`、通知签名、45 的 `safeStorage` 弃用 | 中等 |

### 10.5 修订后的建议

1. **OAR POC 可行，而且比第一轮评估更简单**：
   - Claude：默认 YOLO + HTTP host MCP（已通）。
   - Codex：默认 `danger-full-access` + HTTP host MCP（已通）。
   - OAR 0.113 + Node 24；POC 也可以先用 Node 22/24 的 nvm。
   - 每个 session 的 env 加 `NO_PROXY` / `no_proxy`；这是必须项。
2. **优先做 room runtime adapter 的 Claude + Codex 双 provider POC**，不是全量 provider 迁移。
3. **不需要 stdio bridge**。保留它作为 fallback：如果某个 runtime 的 HTTP MCP 客户端确实不可用，再用 stdio 代理。
4. **Electron 43 仍建议做，但不阻塞 POC**；POC 可以在 Node 22/24 下跑。
5. **权限模型按 eta 简化**：native tools YOLO；host tools 由 dispatcher 治理；workspace 写权限在 Room 层 opt-in。
6. **生产前仍需解决进程治理**：OAR 的退出钩子能处理正常退出；硬崩孤儿需要 `will-quit` dispose + 启动扫描，或 wrapper/sidecar。

### 10.6 追加验证清单（Codex）

- [x] Codex CLI 0.169.0 安装，`app-server --help`
- [x] OAR 探测 `available`
- [x] Codex app-server + 真实模型 turn
- [x] Codex HTTP + full-access + `NO_PROXY` → `echo:hello`
- [x] Codex HTTP + read-only + `NO_PROXY` + annotations → `echo:hello`
- [x] Codex HTTP + read-only + `NO_PROXY` + 无 annotations → 被拒（对照）
- [x] Claude 默认 YOLO + HTTP → `echo:hello`
- [x] stdio fallback + read-only + annotations → `echo:hello`
- [x] 生产 adapter 为所有 runtime session 设置 `NO_PROXY`
- [ ] stdio bridge 仅在 HTTP 不可用时启用（fallback）
- [x] `room-oar-smoke.cjs` 的 engine-driven Claude/Codex 闭环 → `ok: true`, `engineDriven: true`
- [ ] 进程清理 / 事件映射 / Electron 43

### 10.7 POC 结果（2026-11-17）

`desktop/scripts/room-oar-smoke.cjs` 使用真实 engine + OAR 0.113 + 真实 CLI：

- **Claude**：`ok: true`, `engineDriven: true`；`assign_in_group` → `create_task` → `finish_task` 全部成功；Task `in_review`，run `completed`，report `ready`；review `assignment_settled` 并投递；Captain review reply `done`，`audience=captain`，`reviewReply=true`；`captainSessionStable=true`，`taskSessionSeparate=true`。
- **Codex**：同上（`/Users/limu/Library/pnpm/codex` 0.169.0，Cubence `gpt-6.1-sol`）。
- **关键修复**：
  - Role prompt 通过 `appendSystemPrompt` 传入；不传时 Claude 会把 briefing 当成代码任务并开始跑 Bash。
  - 所有 runtime session 设置 `NO_PROXY=127.0.0.1,localhost,::1`，绕开本机 HTTP 代理。
  - Per-run MCP server（Meldwork `mcp-server.cjs`）绑定 dispatcher/runId；HTTP 对 Claude/Codex 都可用，不需要 stdio bridge。
  - `task-queue.pump` 的 `running` 更新加 `AND status='starting'`，避免极快结算被覆盖。
  - `engine.startReply` 完成时合并既有 `data`，保留 `reviewReply` 等标记。
- **未完成**：OAR 进程治理（`managed-spawn`/`process-registry`/硬崩孤儿）、OAR Event → room Trace/activity 的完整映射、Electron 43/Node 24、asar/打包、全量测试。

### 10.8 Room service / liveness（2026-11-17）

- `desktop/src/room/room-service.cjs` 装配 domain、tools、adapter、supervisor、recovery；domain commit 150ms debounce 启动 queued replies + pump task runs；`startQueuedReplies` 按角色串行；`close()` 停 timer、`disposeAll` adapter。
- OAR smoke 现在走 room service：Claude/Codex 均 `ok: true`、`engineDriven: true`、`serviceDriven: true`；`startedRuns: 0` 表示 liveness 已经自动 pump 了 Task。
- 测试：17 个 room 测试文件，**52/52 pass**。
- 剩余：OAR 硬崩孤儿、事件 Trace 持久化、Electron 43/打包、非 OAR provider。

## 9. 参考文件

- eta runtime seam：`eta/packages/eta-server/src/runtimes.ts`
- eta OAR delegate：`eta/packages/eta-runtime-oar/src/delegate.ts`
- eta ACP delegate：`eta/packages/eta-runtime-acp/src/delegate.ts`
- Meldwork room engine：`Tyche/desktop/src/room/engine.cjs:139`
- Meldwork task pump：`Tyche/desktop/src/room/task-queue.cjs:62,165,207`
- Meldwork MCP server：`Tyche/desktop/src/room/tools/mcp-server.cjs`
- Meldwork dispatcher：`Tyche/desktop/src/room/tools/dispatcher.cjs`
- Meldwork ACP runner：`Tyche/desktop/src/agents/cli/cli-acp-runner.cjs:981,988`
- Meldwork CLI invocations：`Tyche/desktop/src/agents/cli/cli-invocations.cjs`
- Meldwork managed spawn：`Tyche/desktop/src/agents/process/managed-spawn.cjs:274`
- Meldwork process inspect：`Tyche/desktop/src/agents/process/process-inspect.cjs:85`
- Meldwork fuses：`Tyche/desktop/scripts/after-pack.cjs`
- Meldwork public build：`Tyche/desktop/electron-builder.public.cjs`
