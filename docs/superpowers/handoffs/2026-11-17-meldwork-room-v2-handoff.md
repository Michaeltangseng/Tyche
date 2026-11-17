# Meldwork Room v2 实施交接

> 用途：新人接手 Meldwork 项目室重写。当前 `project-room` 分支上的垂直切片已经实现、测试并跑过真实 CLI 证明。
> 下一步不是继续铺功能，而是把 **engine → runtime adapter → MCP/工具循环** 真正接通，然后做集成、UI 和旧数据/旧引擎退场。
> 本文取代此前“尚未开始实施”的版本；历史版本在 git 里。

## 当前状态

- 分支：`project-room`，已推送 `origin/project-room`。
- 实施计划：`docs/superpowers/plans/2026-11-17-meldwork-room-v2-vertical-slice.md`，13 个任务全部完成。
- 设计基线：`docs-new2/` 已批准。
- 新领域代码：`desktop/src/room/`。
- 测试：`desktop/test/room/`。
- 旧引擎：`desktop/src/room-engine/`、`desktop/src/project-room/` **未改动**，不要在新切片里复用它们的 schema。
- 未做：Renderer/preload/UI、旧数据迁移、旧引擎删除。engine 工具循环已有 OAR POC（2026-11-17，Claude/Codex `ok: true`、`engineDriven: true`）；生产化（进程治理、事件/Trace 对齐、Electron 43/Node 24、全量验证）未完成。

## 验证证据（本分支已实际运行）

| 项目 | 结果 |
| --- | --- |
| `desktop/test/room` 18 个测试文件 | **53 tests / 53 pass / 0 fail** |
| Claude Code resume proof | `resumed: true`, `remembered: true`, session ref 稳定 |
| Codex resume proof | `resumed: true`, `remembered: true`, session ref 稳定 |
| MCP tool loop proof | `create_task` / `finish_task` / `mention` list + call 成功，`ok: true` |
| Seam smoke Claude | `ok: true`，持久 Chat session、独立 Task session、finish→settlement→in_review、Captain review 全链路 |
| Seam smoke Codex | `ok: true`，同上 |
| OAR service smoke Claude（2026-11-17） | `ok: true`, `engineDriven: true`, `serviceDriven: true`；liveness 自动 pump Task；assign_in_group/create_task/finish_task、in_review、review reply |
| OAR service smoke Codex（2026-11-17） | `ok: true`, `engineDriven: true`, `serviceDriven: true`；同上 |

按仓库所有者要求，没有跑全量测试；最终集成阶段由人工验证。不要声称跑过全量。

## 先读什么

1. `docs-new2/README.md`：总览、原则、明确抛弃项。
2. `docs-new2/02-target-architecture.md`：目标分层、SQLite 表语义、effect 生命周期、MCP/标记。
3. `docs-new2/03-conversation-session-and-briefing.md`：Message/回复行、Session、增量简报、routing、Captain review。
4. `docs-new2/04-task-captain-and-report.md`：Task/TaskRun/lane、finish/结算、Report、Captain 工具。
5. `docs-new2/07-decisions.md`：ADR-N1 ~ N21。
6. 实施计划：`docs/superpowers/plans/2026-11-17-meldwork-room-v2-vertical-slice.md`。
7. 本文。

eta 参考固定 commit `03197d88`；不要和另一个快照 `fab4012` 混用。

## 代码地图

```text
desktop/src/room/
  db.cjs / schema.cjs          SQLite 打开、WAL/FK/busy_timeout、私有目录、事务、schema v1
  repository.cjs               Room/Chat/Role/Participant/role_prompt_revisions
  timeline.cjs                 message seq、activity_seq、clientId 去重、edit 事件、状态迁移
  session-store.cjs            chat/task 两种 scope、持久 native ref、baseline、轮换、水位
  routing.cjs                  用户消息路由、mention budget
  briefing.cjs                 增量简报、100 条/2000 字上限、captain-only 可见性、seen
  effects.cjs                  outbox：pending/running/succeeded/failed/unknown
  engine.cjs                   submitUserMessage、queueReply、startReply、startQueuedReplies、stopReply
  task-queue.cjs               createTask、enqueueRun、pump、lane、写租约、恢复门禁
  settlement.cjs               finish_task claim、settle、accept_task、finish_task 工具
  captain-review.cjs           assignment 台账、review 生成、批量投递、start_reply effect
  supervisor.cjs               150ms debounce + 60s tick 兜底
  recovery.cjs                 restart 恢复、lane 挂起/激活、process 对账
  runtime-adapter.cjs          OAR runtime adapter：per-run MCP、dispatcher 绑定、YOLO、NO_PROXY、Task 结算
  room-service.cjs             domain/tools/adapter/supervisor/recovery 装配、liveness、disposeAll
  runtime-events.cjs           bounded runtime_events（schema v3）：tool/turn/usage/failure/exit
  tools/
    dispatcher.cjs             register/bindRun/invoke、callId 幂等、args_hash 校验、readOnly 审计
    mcp-server.cjs             Streamable HTTP MCP server、per-run bearer token、callId metadata
    mention.cjs                mention 工具、5 次预算、queueReply
    read.cjs                   read_chat 分页、captain-only 过滤
    tasks.cjs                  create_task / comment_task
    captain.cjs                assign_in_group / post_in_chat、createCaptainAssignment

desktop/scripts/
  room-resume-proof.cjs        Claude/Codex resume 证明，写 room-resume-proof.json
  room-mcp-proof.cjs           本地 MCP list/call 证明，写 room-mcp-proof.json
  room-seam-smoke.cjs          模块级真实 CLI 接缝证明，写 room-seam-result.json
  room-oar-smoke.cjs           engine-driven OAR 接缝证明（真实 Claude/Codex），写 room-oar-result.json
```

## 已实现的能力

1. **Schema v1**：17 张核心表 + `role_prompt_revisions` / `chat_context_revisions` / `attentions` / `user_commands`。私有目录 `0700`、DB `0600`、WAL/FK/busy_timeout、同步事务/savepoint。
2. **Repository**：Room/Chat/Role/Participant，稳定的错误码；role prompt revision 1 与 role 同事务写入。
3. **Timeline**：`seq` 分配、`clientId` 去重、`activity_seq` 只统计 public 行（排除 `audience=captain` 和 `data.reviewReply=true`）；`edit` 追加 public 事件并推进 activity。
4. **Session store**：Chat 每个 Role 一个持久 session；Task lane 一个持久 session；`last_seq` 在 participant/lane，不在 session；配置变化自动轮换旧 active session；`baseline_seq` 来自当前水位。
5. **Routing**：显式 @ → Captain → 唯一成员；5 次预算只数 `kind=mention`。
6. **Briefing**：只发 `last_seq` 之后的行；跳过自己；未完成行阻塞水位；100 条/2000 字；返回 `seen`、`omittedSeqs`、`truncatedIds`；Captain-only 行只对 Captain 可见。
7. **Effects/Engine**：`start_reply` effect 在 launch 后成功，不等待 run 完成；runtime launch/completion 分离；完成时水位用 `briefing.seen`，不会跳过 in-flight peer；`startQueuedReplies` 会暴露 launch 错误。
8. **Tools/MCP**：dispatcher 逻辑 `callId` 幂等、同 callId 不同 args 抛 `ROOM_TOOL_CALL_ARGS_MISMATCH`、read 工具不缓存；MCP Streamable HTTP + per-run bearer token；`read_chat` 过滤 Captain-only；`mention` 写 `kind=mention` 并排队；`create_task`/`finish_task` 可用。
9. **Task/Run**：`create_task` 默认直接建 Task + executor lane + queued run + `start_run` effect；`pump` 每个 lane 一个 run、Room 一个写 run；creator/assignee 同 Chat 校验；Captain assignment 下强制调用者执行。
10. **Settlement**：`finish_task` 只是 claim，Task 保持 `in_progress`；`settle` 要求退出确认 + 报告；写入型要求 `snapshot=completed`，只读型平台设 `not_applicable`；非零退出 `failed/known`，退出未知 `interrupted/unknown`；`accept_task` 只能在结算后。
11. **Captain review**：全局基线 `max(checkpoint, 所有 active assignment 消息 seq)`；目标忙/Task 未结算/run 未结束会挡住；review 行和 review reply 不推进 activity；批量投递同 Chat；投递时写 `start_reply` effect；supervisor 150ms debounce + 60s tick。
12. **Recovery**：queued 保留；working/waiting → interrupted；starting/running → interrupted/unknown；running effect → unknown；有写 scope 的 run 建 Attention；被中断的 lane `active=0`，`pump` 不启动，必须 `activateLane` 释放。
13. **真实 CLI 证明**：resume、MCP、模块级 seam 都已跑通（见上表）。
14. **领域幂等**：`domain_idempotency` 表（schema v2）；`create_task` 唯一 per assignment+source；无 assignment 时按 run+args；`comment_task` 支持调用方 `idempotency_key`，缺省按 source+text。
15. **Room service / liveness**：`room-service.cjs` 装配 domain、tools、adapter、supervisor、recovery；domain commit 150ms debounce 启动 queued replies + pump runs；`startQueuedReplies` 按角色串行；`close()` 停 timer、`disposeAll` adapter。
16. **Runtime events**：schema v3 `runtime_events`；OAR 非增量事件（tool/turn/usage/failure/exit）按 run/chat/task 持久化，payload 16KB 截断；文本 delta 留在 reply 行；trace 写失败不影响 run。

## 必须守住的语义

- 新 Chat 路径不读写旧 `meldwork-workspace.json` 存 session。
- `last_seq` 属于 `chat_participants` / `task_lanes`；`sessions` 只有 `baseline_seq`。
- `activity_seq` 排除 `audience=captain` 的 review 行和 `reviewReply=true` 的投递回复；`assign_in_group` / `post_in_chat` 是 public，会计入。
- Captain 不建 Task、不自我派发；`assign_in_group` 一条可见消息 + assignment + 目标 queued reply 同一事务。
- 5 次预算只约束 Agent `mention`，不约束 `assign_in_group` / review。
- Chat 回复只读；写入只在有授权、非空冻结 `write_scopes`、租约的 TaskRun；隔离前每个 Room 最多一个写 run。
- `finish_task` 是完成声明，不是结算；`in_review` 只能在退出/快照结算后。
- 只读 Task 的 `snapshot_state=not_applicable` 由平台确定，不信任 Agent 自报。
- 观察到的非零退出与无法确认退出不能合并。
- MCP 是完整工具循环；文本标记只是受限 fallback；Captain 工具需要 MCP。
- 不做双引擎长期兼容；旧数据迁移不在这个切片。

> **POC 例外（2026-11-17，用户决定）**：为快速跑通 engine → OAR → MCP → real CLI 闭环，POC 阶段 Chat 和 Task 都使用 OAR 默认 YOLO，暂停“Chat 回复只读 / 写入只在 TaskRun”的限制；`write_scopes` 和 snapshot 仅做占位。生产化前必须重新评估并恢复相应语义。

## 当前限制（接手第一优先级）

### Ruling 1：engine 工具循环（OAR POC 已接通，生产化未完成）

> **2026-11-17 POC 更新**：`desktop/src/room/runtime-adapter.cjs` + `desktop/src/room/room-service.cjs` + `desktop/scripts/room-oar-smoke.cjs` 已把 `engine.startReply` / Task `pump` → OAR → per-run MCP → 真实 Claude/Codex 接通；两个 provider 都是 `ok: true`、`engineDriven: true`、`serviceDriven: true`，走完 assign_in_group → create_task → finish_task → settlement → Captain review。smoke 现在走 room-service 的 liveness/supervisor；下面的“没有”是原始缺口，保留作背景；生产化剩余项见本节末尾。

`engine.startReply` 目前只调用 runtime 的 `start/launch/completion`，没有：

- 创建并传入 per-run MCP server URL/token；
- 把 dispatcher、`finish_task`、`create_task`、`mention` 绑定到 run；
- 把 TaskRun 的 `start_run` 真正变成一次 CLI 调用；
- 生产代码里的 supervisor/review 投递后启动 Captain reply。

`room-seam-smoke.cjs` 是**模块级**接缝证明：它直接调用 queue/settlement/review，并用严格文本标记模拟工具动作。结果里明确写了：

```json
{ "integrationMode": "module-seam-marker-fallback", "engineDriven": false }
```

不要把它当成“真实 CLI 全自主工具循环”。下一步应新增 `desktop/src/room/runtime-adapter.cjs`（计划文件列表中已有但未分配任务），并：

1. 为每个 run 启动一个本地 MCP server，生成 token，绑定 `runId`；
2. 把 MCP URL/token 注入 Claude Code / Codex 的启动参数或临时配置（需要改 `desktop/src/agents/cli/cli-invocations.cjs` 或 proof 层适配）；
3. `engine.startReply` 与 Task `pump` 通过 adapter 调用真实 CLI；
4. 用真实 CLI 重跑 engine 驱动的 seam，替换 marker fallback。

**POC 结果与剩余项（2026-11-17）**：真实 Claude/Codex 均通过（service-driven）；`room-service` 负责 liveness（domain commit 150ms debounce 启动 queued replies + pump runs）、supervisor review、recovery 和 `close()` disposeAll；`startQueuedReplies` 按角色串行；OAR 非增量事件已持久化到 `runtime_events`（schema v3）。仍未生产化：OAR 进程硬崩孤儿（不经过 `managed-spawn`/`process-registry`）；Trace UI/保留策略；非 OAR provider 仍走旧层；Electron 43/Node 24、asar/打包、全量测试未验证。

### Ruling 2：领域幂等仍不完整

> **2026-11-17 更新**：已实现 `domain_idempotency`（schema v2）。`create_task` 唯一 per assignment+source；无 assignment 时按 run+args；`comment_task` 支持调用方 `idempotency_key`，缺省按 source+text。聚焦 room 测试 **48/48**。

dispatcher 的 `callId` 幂等只覆盖“客户端复用 callId”的情况。`create_task` / `comment_task` 还没有 per-assignment+source-message 的领域幂等键；客户端用新 callId 重试仍可能重复。下一步按 `docs-new2/04` §5.1 补。

### 已修复的 review 问题（不要回退）

- Captain review 投递必须同时写 `start_reply` effect。
- Captain 的 briefing 必须传 `viewerIsCaptain`。
- 完成水位必须用 `briefing.seen`，不能用 `reply.seq`。
- 重启后 lane 必须挂起，`pump` 必须尊重 `task_lanes.active` 和未对账的写 run。
- `read_chat` 必须过滤 Captain-only。
- `create_task` 必须校验 creator/assignee 同 Chat；Captain assignment 下强制调用者。
- session 配置变化必须轮换旧 active session。
- review 基线必须是所有 active assignment 消息的全局最大值。
- MCP server 必须要求 per-run bearer token。
- resume proof 必须要求第二次 session ref 相同。

### Deferred minors

- `comment_task` 续跑使用评论者 lane，而不是 Task executor lane。
- `acceptTask` 只校验“有 completed run + report”，未校验最新 required run 的 ready report/artifacts。
- `progress` 报告把 Task 映射成 `blocked`，spec 是 `in_progress`。
- Task number 按 Chat 分配，spec 说按 Room。
- recovery 的 Attention 只覆盖有 write scope 的 run，未覆盖 unknown effects。

## 验证命令

```bash
cd desktop

# 小范围 room 测试（当前 53/53）
node --test test/room/db.test.cjs test/room/repository.test.cjs test/room/timeline.test.cjs \
  test/room/session-store.test.cjs test/room/routing.test.cjs test/room/briefing.test.cjs \
  test/room/effects.test.cjs test/room/engine.test.cjs test/room/dispatcher.test.cjs \
  test/room/mcp-server.test.cjs test/room/mention.test.cjs test/room/read.test.cjs \
  test/room/task-queue.test.cjs test/room/settlement.test.cjs \
  test/room/captain-review.test.cjs test/room/recovery.test.cjs \
  test/room/room-service.test.cjs test/room/runtime-events.test.cjs
```

真实证明（需要本机已安装并登录对应 CLI）：

```bash
cd desktop
export MELDWORK_USER_DATA=/tmp/meldwork-room-proof

ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/room-resume-proof.cjs --run --provider claude
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/room-resume-proof.cjs --run --provider codex

node scripts/room-mcp-proof.cjs

ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/room-seam-smoke.cjs --run --provider claude
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/room-seam-smoke.cjs --run --provider codex

# OAR engine-driven smoke（需要 OAR 0.113+、真实 Claude/Codex；先安装依赖）
# npm --prefix desktop install --registry=https://registry.npmmirror.com
node scripts/room-oar-smoke.cjs --run --provider claude
node scripts/room-oar-smoke.cjs --run --provider codex
```

结果文件在 `$MELDWORK_USER_DATA/room-resume-proof.json`、`room-mcp-proof.json`、`room-seam-result.json`。

按仓库规则，最终集成前还要跑（当前所有者会人工做）：

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
npm --prefix desktop run pack
```

## 建议的下一步顺序

1. **人工集成验证**：按上面的真实证明命令重跑，确认本机 CLI 行为。
2. **runtime adapter + MCP 注入（POC 已完成）**：`runtime-adapter.cjs` 使用 OAR，`engine.startReply` 和 Task `pump` 已走真实 Claude/Codex；`room-oar-smoke.cjs` 明确 `engineDriven: true`（Claude/Codex 均通过）。下一步是进程治理、事件/Trace 对齐、Electron 43/Node 24 与全量验证。
3. **领域幂等（已完成）**：`domain_idempotency`（schema v2）；`create_task` per assignment+source，`comment_task` 调用方 key/缺省 source+text；room 测试 52/52。下一步建议先补 OAR 硬崩进程清理/事件 Trace 持久化，再进 deferred minors。
4. **Deferred minors**：按业务优先级补。
5. **UI/preload/renderer**：在 engine 真实闭环通过后再接。
6. **旧数据迁移/旧引擎退场**：单独计划；当前切片不碰。

## 交接检查

- [ ] 已读 `docs-new2/README.md`、`02/03/04/07` 和本文。
- [ ] 已在本机跑过 room 测试，确认 43/43。
- [ ] 已在本机跑过 Claude/Codex resume、MCP、seam 证明。
- [ ] 理解 `room-seam-smoke.cjs` 是模块级 marker fallback，不是 engine 驱动的完整闭环。
- [ ] 理解 `desktop/src/room-engine/` 是旧引擎，不要在新切片里复用。
- [ ] 不新增数据迁移、不做双引擎长期兼容。
- [ ] 下一步先做 runtime adapter + CLI MCP 注入，再考虑 UI/迁移。
