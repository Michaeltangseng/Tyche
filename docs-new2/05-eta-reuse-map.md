# 05 eta 复用映射

> eta 源码位于本仓库的同级目录 `eta/eta/`。下表中的路径均相对 eta 源码根（例如 `apps/eta/src/...`、`packages/eta-core/...`），不是 Tyche 仓库内的路径。

本文档回答两个问题：

1. eta 的哪些机制值得复用？
2. 以什么方式复用：移植纯逻辑、按语义重写、只做参考，还是不用？

## 1. 复用方式定义

| 方式 | 含义 |
| --- | --- |
| **Port** | 逻辑足够纯、依赖少，直接移植到 `desktop/src/collaboration/`，用 CJS 重写并补测试 |
| **Adapt** | 采用 eta 的语义，但接口、存储、权限或 UI 要按 Meldwork 的边界重写 |
| **Reference** | 只读 eta 的实现来理解边界和坑，不复制代码 |
| **Reject** | 不适合 Meldwork 的产品边界或运行时，不引入 |

## 2. 机制映射

### 2.1 会话与上下文

| 机制 | eta 位置 | Meldwork 目标 | 方式 | 说明 |
| --- | --- | --- | --- | --- |
| 每个 (agent × conversation) 一个持久 session | `apps/eta/src/conversations/places.ts:199-243`、`engine.ts:1081-1104` | `collaboration/session-registry.cjs` + `sessions` 表 | **Adapt** | Meldwork 旧引擎已有 `InvocationSession`，可复用 resume/adopt/discard；新 domain 负责指针和水位 |
| session 首次唤醒创建、之后复用 | `product-model.md` | 同上 | **Port 语义** | 统一 key：`chat:<chatId>:role:<roleId>` |
| participant 的 `last_seq` 水位 | `data.md`、`product-model.md` | `chat_participants.last_seq` | **Port** | 只存指针，不存正文 |
| 增量简报（原文，不总结） | `conversations/briefing.ts` | `collaboration/briefing.cjs` | **Port** | 100 条 × 2000 字；未完成行阻塞水位 |
| 同一 session 串行、不同 session 并行 | `conversations/engine.ts:1011-1023` | `collaboration/engine.cjs` | **Adapt** | 用 participant chain；外部 CLI 的 steer 能力由 adapter 声明 |
| session 轮换 | `places.ts:214-224`、`engine.ts:1089-1103` | `session-registry.cjs` | **Adapt** | 增加一次性 Session Handoff；外部 CLI 的 journal 不接管 |
| Task session key | `tasks/session-key.ts` | `collaboration/session-registry.cjs` | **Port** | `task:<taskId>`；mention 用 `task:<taskId>:role:<roleId>` |
| 评论续跑同一个 task session | `tasks/runner.ts:22-53` | `collaboration/task-queue.cjs` | **Adapt** | 外部 CLI 的评论作为 user message；不支持 steer 时排队 |
| rerun 丢弃记忆 | `tasks.md:63` | `task-queue.cjs` | **Adapt** | 新建 generation；旧 run/session 保留 |

### 2.2 消息、唤醒与交接

| 机制 | eta 位置 | Meldwork 目标 | 方式 | 说明 |
| --- | --- | --- | --- | --- |
| 回复行就是唤醒/队列 | `timeline.ts`、`product-model.md` | `collaboration/timeline.cjs` + `messages` 表 | **Adapt** | v2 的 messages 没有 status/root；新 schema 补上 |
| 用户消息路由（@ / steward / 单成员 / 不猜） | `conversations/routing.ts:24-55` | `collaboration/routing.cjs` | **Port** | 规则纯函数，直接移植 |
| Agent mention 工具 | `engine.ts:811-899` | `collaboration/tools/mention.cjs` | **Adapt** | 平台工具；解析 Role 名/ID；未知名字回给 Agent |
| 5 次 wake budget | `routing.ts:13,57-67` | `routing.cjs` | **Port** | 按 `root_message_id` 计数 |
| mention 正文就是交接内容 | `tasks.md:99`、`engine.ts:853-884` | `mention` 工具参数 | **Port 语义** | 对方读不到尚未完成的回复，所以正文必须自带 |
| steer 并入当前 turn | `engine.ts:774-807` | `engine.cjs` | **Adapt** | runtime 能力决定 queue/steer |
| 停止/重启恢复 | `engine.ts:925-1006`、`data.md` | `engine.cjs`、`recovery.cjs` | **Adapt** | 与 Meldwork ProcessRegistry/RunLedger 合并 |

### 2.3 Task 与 Captain

| 机制 | eta 位置 | Meldwork 目标 | 方式 | 说明 |
| --- | --- | --- | --- | --- |
| Agent 自己创建 Task | `tasks.md:5-9` | `collaboration/tools/tasks.cjs` | **Adapt** | 接 Meldwork 的 Role/Provider/权限校验 |
| draft_task 可选确认 | `tasks.md:13-25` | Task 卡 + UserCommand | **Adapt** | 默认 `create_task`；draft 仅在 Agent 主动想先确认时使用 |
| TaskRun 表就是队列 | `tasks/runner.ts:22-53` | `collaboration/task-queue.cjs` + `task_runs` 表 | **Port 语义** | 按 `queued_at`、机器槽位、上一 run 结束 |
| 每机器并发上限 | `tasks.md:53` | Room/机器配置 | **Adapt** | 第一阶段单机，默认 2 |
| finish_task → in_review/blocked | `tasks.md:55` | `tools/tasks.cjs`、`reports.cjs` | **Adapt** | 接 Meldwork Report/Attention |
| 评论唤醒续跑 | `tasks.md:56-62` | `task-queue.cjs` | **Adapt** | 无 run 时建 continuation run |
| Captain `assign_in_group` 只发可见授权 | `captain/tools.ts:348-376`、`tasks.md:9` | `collaboration/captain/tools.cjs` | **Adapt** | 目标 Agent 自己 create_task |
| Captain 提案（新 Role/群） | `captain/propose-*.ts` | `collaboration/captain/` 的 propose_role + 用户确认 | **Reference** | Meldwork Role 是 Chat 级，不需要 eta 的全局 Agent 创建 |
| Captain 审查队列 | `captain/supervisor.ts`、migrations 0047 | Attention/Inbox | **Reference** | 只借鉴“失败/卡住/待回答”分类 |
| Inbox/ask | `inbox/*` | Attention/Inbox | **Adapt** | 回答回到原 session |
| 任务依赖/子任务 | `migrations/0051/0052` | Task 依赖字段 | **Reference** | 第一阶段只保留轻量依赖 |

### 2.4 上下文压缩

| 机制 | eta 位置 | Meldwork 目标 | 方式 | 说明 |
| --- | --- | --- | --- | --- |
| 阈值 `min(window-16384, 64000)`、保留 20000 | `packages/eta-core/src/types/config.ts:75-79`、`eta-harness/src/estimation.ts:155-171` | 未来内置 runtime | **Reference / Port** | 只对平台自管 session 生效 |
| Compaction plan / fold / digest | `packages/eta-compaction/src/index.ts` | 未来内置 runtime | **Port** | 纯算法多；依赖 `@eta/core` 类型，需要去依赖化 |
| 外部 runtime 自己压缩 | `docs/architecture/runtimes.md`、`manager.ts:592-593` | runtime adapter | **Reference** | 平台不接管 CLI journal |
| 上下文溢出恢复 | `runs/failure-signals.cjs` | `engine.cjs` | **Adapt** | 轮换 session + 一次性 handoff，不无限重试 |

### 2.5 存储与运行时

| 机制 | eta 位置 | Meldwork 目标 | 方式 | 说明 |
| --- | --- | --- | --- | --- |
| SQLite 产品台账 + 文件 session | `docs/architecture/data.md` | SQLite 台账 + CLI 自有 session | **Adapt** | 只复用“DB 存指针，正文归 runtime”的分层 |
| FileSessionStore `meta.json + journal.jsonl` | `packages/eta-server/src/file-store.ts` | 未来内置 runtime | **Reject（现在）** | 外部 CLI 的 session 在 CLI 自己那里；平台不能假装拥有 |
| JsonlStorage | `packages/eta-storage-jsonl/src/index.ts` | 未来内置 runtime | **Reject（现在）** | 同上 |
| Session runtime seam（OAR/ACP） | `docs/architecture/runtimes.md` | 现有 CLI adapter | **Reference** | Meldwork 已有 `invokeAgent`；后续可评估 ACP |
| daemon / 多机器 | `apps/daemon`、`docs/architecture/machines.md` | 不做 | **Reject** | 本地优先，无必需服务端 |
| Memory sidecar | `apps/memory` | 不做（后续可选） | **Reject（现在）** | Python/PostgreSQL 依赖，不符合第一阶段边界 |
| Web UI / wire protocol / cordis | `apps/web`、`packages/eta-server` | 不做 | **Reject** | 与 Electron/Vue 架构不同 |

## 3. 从 Meldwork 保留什么

| 能力 | 现有位置 | 在新架构中的角色 |
| --- | --- | --- |
| Electron 信任边界 | `main.cjs`、`preload.cjs`、`shell/*` | 不变 |
| 原生 Agent 调用 | `workspace/local-workspace-agent-invocation.cjs` | RuntimeAdapter 的底层 |
| session resume/adopt/discard | `workspace/invocation-session.cjs` | SessionRegistry 的底层 |
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
- eta 的 routine 调度器（后续若做 routine，再单独评估）。

## 5. 移植注意事项

1. **语言与模块系统**：eta 是 TypeScript + ESM + Bun；Meldwork 是 CJS + Electron Node。移植时只保留纯函数和明确依赖，禁止引入 `cordis`、`@eta/server`、`@eta/core` 的运行时依赖。
2. **类型**：eta 的 TypeBox/Zod 类型不能直接使用；Meldwork 侧用现有校验方式重写。
3. **存储**：eta 的 SQLite schema 不照搬；只复用字段语义和约束（例如 `seq`、`last_seq`、`session_key`）。
4. **权限**：eta 的 ACP 权限默认全允许；Meldwork 必须保留 per-seat 权限、写入租约和 main-process 校验。
5. **Prompt**：eta 的 Prompt 是产品文本，可以借鉴结构，但要按 Meldwork 的 Role/Captain/Report 语境重写；不要把 eta 的内部词汇原样暴露给用户。
6. **许可**：eta 是 MIT；Meldwork 是 Apache-2.0。移植纯逻辑时保留 eta 的版权/许可声明，并在 `NOTICE` / `THIRD_PARTY_NOTICES` 中记录；不要把 eta 的商标或产品文案带过来。

## 6. 复用的优先级

```text
第一优先（直接决定正确性）
  routing / briefing / session keys / reply-row queue / task session

第二优先（决定可用性）
  task run queue / finish_task / report / attention / captain assign_in_group

第三优先（决定长期成本）
  compaction（仅自管 runtime）/ inbox 聚合 / captain supervisor

暂不做
  daemon / memory / eta web / cordis / 多机器
```
