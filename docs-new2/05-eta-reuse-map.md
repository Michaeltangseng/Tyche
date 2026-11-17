# 05 eta 复用映射

> eta 源码位于本仓库的同级目录 `eta/eta/`。下表中的路径均相对 eta 源码根（例如 `apps/eta/src/...`、`packages/eta-core/...`），不是 Tyche 仓库内的路径。

本文档回答两个问题：

1. eta 的哪些机制值得复用？
2. 以什么方式复用：移植纯逻辑、按语义重写、只做参考，还是不用？

## 1. 复用方式定义

| 方式 | 含义 |
| --- | --- |
| **Port** | 逻辑足够纯、依赖少，直接移植到 `desktop/src/room/`，用 CJS 重写并补测试 |
| **Adapt** | 采用 eta 的语义，但接口、存储、权限或 UI 要按 Meldwork 的边界重写 |
| **Reference** | 只读 eta 的实现来理解边界和坑，不复制代码 |
| **Reject** | 不适合 Meldwork 的产品边界或运行时，不引入 |

## 2. 机制映射

### 2.1 会话与上下文

| 机制 | eta 位置 | Meldwork 目标 | 方式 | 说明 |
| --- | --- | --- | --- | --- |
| 每个 (agent × conversation) 一个持久 session | `apps/eta/src/conversations/places.ts:199-243`、`engine.ts:1081-1104` | `room/session-store.cjs` + `sessions` 表 | **Adapt** | Meldwork 旧引擎已有 `InvocationSession`；新 domain 负责 SQLite 指针和水位 |
| session 首次唤醒创建、之后复用 | `docs/architecture/product-model.md` | 同上 | **Port 语义** | Chat key：`chat:<chatId>:role:<roleId>` |
| participant 的 `last_seq` 水位 | `docs/architecture/product-model.md` | `chat_participants.last_seq` | **Port** | 水位属于 participant，不属于 session |
| 增量简报（原文，不总结） | `conversations/briefing.ts` | `room/briefing.cjs` | **Port** | 100 条 × 2000 字；未完成行阻塞水位 |
| 同一 session 串行、不同 session 并行 | `conversations/engine.ts:1011-1023` | `room/engine.cjs` | **Adapt** | 用 participant chain；外部 CLI 默认不支持 mid-turn steer |
| session 轮换 | `places.ts:214-224`、`engine.ts:1089-1103` | `room/session-store.cjs` | **Adapt** | 水位留在 participant/lane；轮换时一次性 handoff |
| Task session key | `tasks/session-key.ts` | `room/session-store.cjs` | **Adapt** | 改为 `task:<taskId>:role:<roleId>`；执行者 lane 跨 run 复用 |
| 评论续跑同一个 task session | `tasks/runner.ts:22-53` | `room/task-queue.cjs` | **Adapt** | 一次性 CLI 不能 steer，评论排队 continuation run |
| rerun 丢弃记忆 | `tasks.md:63` | `room/task-queue.cjs` | **Adapt** | 新建 generation；旧 run/session 保留 |

### 2.2 消息、唤醒与交接

| 机制 | eta 位置 | Meldwork 目标 | 方式 | 说明 |
| --- | --- | --- | --- | --- |
| 回复行就是唤醒/队列 | `timeline.ts`、`product-model.md` | `room/timeline.cjs` + `messages` 表 | **Adapt** | 加 `revision`、`client_id`、`status`、`root_message_id` |
| 用户消息路由（@ / steward / 单成员 / 不猜） | `conversations/routing.ts:24-55` | `room/routing.cjs` | **Port** | 规则纯函数，直接移植 |
| Agent mention 工具 | `engine.ts:811-899` | `room/tools/mention.cjs` | **Adapt** | MCP 优先，严格标记兜底；身份由 run/session 绑定 |
| 5 次 wake budget | `routing.ts:13,57-67`、`timeline.ts:450-457` | `room/routing.cjs` | **Port** | 只统计 `kind=mention`；`assign_in_group` 和 Captain review 都不占这个预算 |
| mention 正文就是交接内容 | `tasks.md:99`、`engine.ts:853-884` | `mention` 工具参数 | **Port 语义** | 对方读不到尚未完成的回复，所以正文必须自带 |
| `assign_in_group` 是一条带 @ 的可见消息 | `captain/service.ts:322` | `room/captain-review.cjs` / `room/tools` | **Adapt** | 不要写成“回复一行 + mention 一行”；两行是 `mention` 工具的行为 |
| steer 并入当前 turn | `engine.ts:774-807` | `room/engine.cjs` | **Adapt** | runtime 能力决定 queue/steer；Claude/Codex 默认 queue |
| 停止/重启恢复 | `engine.ts:925-1006`、`data.md` | `room/engine.cjs`、`room/recovery.cjs` | **Adapt** | working → interrupted/unknown；进程对账后再启动 |
| 聊天回复也走 effect | （Meldwork 约束，不是 eta 机制） | `room/effects.cjs` | **Adapt** | 所有进程启动先写 effect |

### 2.3 Task、Captain 与 review

| 机制 | eta 位置 | Meldwork 目标 | 方式 | 说明 |
| --- | --- | --- | --- | --- |
| Agent 自己创建 Task | `tasks.md:5-9` | `room/tools/tasks.cjs` | **Adapt** | 接 Meldwork Role/Provider/权限校验 |
| create_task 直接创建 | `tasks.md:5-9` | `create_task` 默认入口 | **Port 语义** | `draft_task` 可选；不增加用户审批 |
| TaskRun 表就是队列 | `tasks/runner.ts:22-53` | `room/task-queue.cjs` + `task_runs` | **Port 语义** | 按 lane + `queued_at` + 机器槽位 |
| Task lane（执行者/mention） | `tasks/runner.ts:187-196`、`tasks/runs.ts:214-222` | `task_lanes` + `task_runs.lane_id` | **Adapt** | 执行者 lane 与 mention lane 可并行；每个 lane 同时一个 run |
| 每机器并发上限 | `tasks.md:53` | Room/机器配置 | **Adapt** | 默认 2；隔离前写入型 run 每 Room 1 |
| finish_task → in_review/blocked | `tasks.md:55` | `room/tools/tasks.cjs`、`room/reports.cjs` | **Adapt** | 接 Meldwork Report/Attention；用户 `accept_task` 才 done |
| 评论唤醒续跑 | `tasks.md:56-62` | `room/task-queue.cjs` | **Adapt** | 无 run 时建 continuation run；一次性 CLI 不能 steer |
| Captain `assign_in_group` 只发可见授权 | `captain/tools.ts:348-376`、`tasks.md:9` | `room/tools/captain.cjs` | **Adapt** | 目标 Agent 自己 create_task |
| Captain review supervisor | `captain/supervisor.ts:28,59,77,122-127`、`captain/service.ts:863-870,946-1050,1152-1215` | `room/captain-review.cjs` + `captain_reviews` 表 | **Port/Adapt** | 150ms debounce 快路径 + 60 秒兜底；已结算 assignment；无 Task 也可 review；system 消息唤醒；review 流量不计入 activity_seq；不占 5 次 |
| Captain 提案（新 Role/群） | `captain/propose-*.ts` | `room/tools/captain.cjs` 的 propose_role | **Reference** | Meldwork Role 是 Chat 级；Captain 不能直接创建 |
| Captain 审查队列 | `captain/store.ts`、migrations 0047 | `captain_reviews` | **Adapt** | 借 checkpoint/dedupe/retry/backoff，不照搬全局 Captain |
| Inbox/ask | `inbox/*` | Attention/Inbox | **Adapt** | 一次性 CLI 的回答排队 continuation run |
| 任务依赖/子任务 | `migrations/0051/0052` | Task 依赖字段 | **Reference** | 第一阶段只保留轻量依赖 |

**重要区别**：eta 的 Captain 是全局唯一（`migrations/0046-captain.sql`）；Meldwork 采用每个 Chat 一个 Captain，这是 **Adapt**，不是直接复用。因此 Captain 工具必须限定在所属 Chat，不能照搬 `list_chats` / `read_chat`。

### 2.4 上下文压缩

| 机制 | eta 位置 | Meldwork 目标 | 方式 | 说明 |
| --- | --- | --- | --- | --- |
| 阈值 `min(window-16384, 64000)`、保留 20000 | `packages/eta-core/src/types/config.ts:75-79`、`eta-harness/src/estimation.ts:155-171` | 未来内置 runtime | **Reference / Port** | 只对平台自管 session 生效 |
| Compaction plan / fold / digest | `packages/eta-compaction/src/index.ts` | 未来内置 runtime | **Port** | 纯算法多；依赖 `@eta/core` 类型，需要去依赖化 |
| 外部 runtime 自己压缩 | `docs/architecture/runtimes.md`、`manager.ts:592-593` | runtime adapter | **Reference** | 平台不接管 CLI journal |
| 上下文溢出恢复 | `runs/failure-signals.cjs` | `room/engine.cjs` | **Adapt** | 轮换 session + 一次性 handoff，不无限重试 |

### 2.5 存储、运行时与工具

| 机制 | eta 位置 | Meldwork 目标 | 方式 | 说明 |
| --- | --- | --- | --- | --- |
| SQLite 产品台账 + 文件 session | `docs/architecture/data.md` | SQLite 台账 + CLI 自有 session | **Adapt** | 只复用“DB 存指针，正文归 runtime”的分层 |
| FileSessionStore `meta.json + journal.jsonl` | `packages/eta-server/src/file-store.ts` | 未来内置 runtime | **Reject（现在）** | 外部 CLI 的 session 在 CLI 自己那里；平台不能假装拥有 |
| JsonlStorage | `packages/eta-storage-jsonl/src/index.ts` | 未来内置 runtime | **Reject（现在）** | 同上 |
| Session runtime seam（OAR/ACP） | `docs/architecture/runtimes.md` | 现有 CLI adapter | **Reference** | Meldwork 已有 `invokeAgent`；后续可评估 ACP |
| Agent 工具注入 | eta host tools / MCP | `room/tools` + local MCP server | **Adapt** | eta 有 host tools；Meldwork 需要自己的 MCP bridge 或标记协议 |
| daemon / 多机器 | `apps/daemon`、`docs/architecture/machines.md` | 不做 | **Reject** | 本地优先，无必需服务端 |
| Memory sidecar | `apps/memory` | 不做（后续可选） | **Reject（现在）** | Python/PostgreSQL 依赖，不符合第一阶段边界 |
| Web UI / wire protocol / cordis | `apps/web`、`packages/eta-server` | 不做 | **Reject** | 与 Electron/Vue 架构不同 |

## 3. 从 Meldwork 保留什么

| 能力 | 现有位置 | 在新架构中的角色 |
| --- | --- | --- |
| Electron 信任边界 | `main.cjs`、`preload.cjs`、`shell/*` | 不变 |
| 原生 Agent 调用 | `workspace/local-workspace-agent-invocation.cjs` | RuntimeAdapter 的底层 |
| session resume/adopt/discard | `workspace/invocation-session.cjs` | SessionStore port 的底层原语 |
| CLI adapters | `agents/cli/*` | runtime adapter |
| 进程注册/观察 | `runs/*`、`agents/*` | Supervisor / recovery |
| Run Ledger | `runs/run-ledger.cjs` | 运行记录和崩溃恢复 |
| 写入租约 | `runs/path-claims.cjs` | Room 根目录写入 |
| 权限模式 | `agents/native-permission-modes.cjs`、`agent-permission-policy.cjs` | per-seat 权限 |
| Artifact 快照/diff | `project-room/shadow-git.cjs` | Artifact |
| Report 导入/状态推导 | `room-engine/report-importer.cjs`、`report-state.cjs` | 保留思路，按新 Task/Run 重写 |
| effects/outbox | `room-engine/room-outbox.cjs`、`effect-pump.cjs` | 保留思路，按新 domain 重写 |
| Supervisor liveness | `room-engine/session-supervisor.cjs` | 保留思路，按新 session 重写 |
| 进程对账 | `room-engine/process-reconciliation.cjs` | 保留 |
| IPC 安全 | `room-engine/room-ipc.cjs`、`security/*` | 保留模式，重新接线 |

## 4. 明确不复用

- eta 的 cordis 插件体系；
- eta 的 WebSocket wire protocol；
- eta 的 Web/TUI/mobile UI；
- eta 的 daemon / 多机器；
- eta 的 LLM gateway / provider 账号体系；
- eta 的 memory sidecar；
- eta 的全局 Agent / project / conversation 表结构（语义可参考，表不能照搬）；
- eta 的 routine 调度器（后续若做 routine，再单独评估）；
- eta 的全局 Captain 唯一约束（Meldwork 是每 Chat 一个 Captain）。

## 5. 移植注意事项

1. **语言与模块系统**：eta 是 TypeScript + ESM + Bun；Meldwork 是 CJS + Electron Node。移植时只保留纯函数和明确依赖，禁止引入 `cordis`、`@eta/server`、`@eta/core` 的运行时依赖。
2. **类型**：eta 的 TypeBox/Zod 类型不能直接使用；Meldwork 侧用现有校验方式重写。
3. **存储**：eta 的 SQLite schema 不照搬；只复用字段语义和约束（例如 `seq`、`last_seq`、`session_key`、`checkpoint`）。
4. **权限**：eta 的 ACP 权限默认全允许；Meldwork 必须保留 per-seat 权限、写入租约和 main-process 校验。
5. **Prompt**：eta 的 Prompt 是产品文本，可以借鉴结构，但要按 Meldwork 的 Role/Captain/Report 语境重写；不要把 eta 的内部词汇原样暴露给用户。
6. **Captain review**：eta 的 review 发到 Captain 的 direct chat，不推进群 `lastSeq`；Meldwork 没有同样的 direct chat，可发到 Chat 的 `system` 消息并标记 `audience=captain`。必须同时维护 `chat.activity_seq`，只统计 public 消息，排除 `audience=captain` 的 review 行和 Captain review 回复；否则 review 会自己推进水位并形成循环。review 正文是观察，不是上一环全文；Captain 通过增量简报读实际消息。
7. **许可**：eta 是 MIT；Meldwork 是 Apache-2.0。移植纯逻辑时保留 eta 的版权/许可声明，并在 `NOTICE` / `THIRD_PARTY_NOTICES` 中记录。

## 6. 复用的优先级

```text
第一优先（直接决定正确性）
  routing / briefing / participant watermark / reply-row queue / task session key

第二优先（决定可用性）
  task run queue + lanes / finish_task / report / attention /
  captain review supervisor / assign_in_group

第三优先（决定长期成本）
  compaction（仅自管 runtime）/ inbox 聚合 / captain patrol for failures/stuck

暂不做
  daemon / memory / eta web / cordis / 多机器 / 自创 completion wake
```
