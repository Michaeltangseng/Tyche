# v2 实施路线图

这份文档把 `docs-new` 的架构决策转成可执行的工程计划。它描述先做什么、复用哪些现有能力、每一步怎样验收，以及哪些事项明确不进入首个切片。

## 当前实现状态（2026-11-15）

`desktop/src/room-engine/` 已提供私有 SQLite 账本、统一消息入口、ControllerAction/UserCommand/PlatformTransition 校验、Report 导入和状态推导、outbox、Supervisor 事实记录，以及 main/preload 生命周期接线。Controller 的批次动作、派发 effect 和审计在同一事务内提交；Agent 消息不能直接授权派发。数据库目录使用 `0700`、文件使用 `0600`（Windows 除外）。启动恢复会将崩溃遗留 running effects 标为 unknown 并产生 Attention，不自动重放；未启动的 pending effects 仍可继续消费。详细能力和未完成项见 Phase 4 与下方当前实现进度。

当前切片已接入独立的 v2 Renderer 页面，尚未接入旧 Chat 迁移。`controller-agent.cjs` 已在 main 中通过 `native-runtime.cjs` 连接原生 `invokeAgent`：按 Room Provider 配置顺序选择首个 Provider，验证 Chat/目录归属与已安装 Agent；创建本次调用的临时执行描述，不查找已有 group，也不创建隐藏群聊。Controller 强制只读、不写入旧消息/Session、严格解析 JSON；Worker 写入需要用户授权与根目录独占租约。Assignment Runner 已补齐原生接口要求的 promptOverride/contextPackId，并带入角色 Prompt、任务创建时的协作约定和 Report 输出要求。角色 Prompt revision 在创建 Assignment 时固定，排队期间的 Prompt 修改只影响之后创建的 Assignment。独立 Controller Session 已支持批次幂等、context revision 校验和结构化决策审计；动态角色创建与 Prompt 更新已受 Room Provider/能力白名单约束。Room schema 已升级到 v4，既有 Room 默认只读。已在 Electron main 使用真实 Claude Code CLI 跑通自动组队、单文档任务、结构化 Report、产物快照/diff 和确认 Attention，并验证账本重开；真实多 Agent 评审、平台心跳和异常恢复均已有闭环验收，未运行仓库全量测试。

Assignment Runner 现已在每个运行中的 Assignment 上由平台定时写入 `session_liveness`（默认 30 秒，随运行启动，完成/失败/取消后清理）；这是真实调用仍由平台持有的 liveness 事实，不依赖 Worker 自报消息。Electron Node 定向测试已覆盖长调用期间心跳产生及结束后停止写入；真实 recovery smoke 又验证了 17 条 liveness 事件，并确认替代 Assignment 退出后没有继续写入。Room Assignment 采用一次性有界原生调用；重试或交接通过新 Assignment 传递结构化报告、证据和 Artifact 引用，不恢复旧群聊 Session。

Supervisor 的 stale 查询现在按事件序列同时读取 `session_liveness` 与 `session_exited`；退出事件晚于最后心跳时不会再把已结束 Assignment 误报为 stale。该边界已有 Electron Node 定向回归测试。

恢复后的显式 `retry_task`/`handoff_task` 已完成一次替代 Assignment 的真实执行闭环：命令先完成残留进程对账，再创建带 `previousAssignmentId` 的新尝试和 pending effect；effect runner 启动新 Assignment，Worker 返回 `ready` Report 后，替代 Assignment 进入 `completed`、Task 推导为 `done`，历史尝试和 Report 保留。该路径已有 Electron Node 定向测试，并已在真实 Claude Code CLI 上复验 unknown 执行隔离、ProcessRegistry 进程对账、显式 retry、ready Report、Task done 和数据库重开（4 次 CLI 调用，约 62 秒，`reopenVerified: true`）。

Assignment Runner 对所有明确标记为未知结果的原生调用统一进入 `waiting/outcome=unknown`，创建恢复 Attention，并保留写入租约；只有 Supervisor 观察到进程确实结束后才写入 `session_exited` 并允许用户 retry/handoff。此前只有终止确认失败走这条路径，现已补上普通未知调用的回归测试，避免未知结果被误记为 `failed` 而绕过进程对账。

按用户反馈简化角色模型：删除角色归档动作及专门的停用检查，不增加角色生命周期状态机。“后续不再邀请某个角色”由用户指令、Prompt 和协作上下文管理，不影响已有任务或历史记录。保留 Prompt 更新的 Chat 归属校验及后续 Controller 唤醒。

协作约定更新已接通：主控使用完整 instructions 文本和当前用户源消息 ID 提交 `update_context`。平台验证来源与当前 revision，同批先保存约定、再以新 revision 创建新任务；既有任务保留版本且不隐式停止。批次失败整批回滚，更新事件可唤醒后续评估并在重启后补调度，不新增状态机或配置 DSL。约定本身不能授予写权限。下一步扩展 Prompt/Skill 配置界面与真实 CLI 长任务验收。

本切片验证：七个 room-engine 定向文件共 71 项测试通过，覆盖来源身份、版本切换、同批回滚、重复批次、上下文更新唤醒与重启恢复；`git diff --check` 通过。扩展的真实 Claude Code CLI smoke 在 Electron main 约 81 秒、6 次调用通过：先完成文档与确认 Attention，再接收“以后英文报告、后续不再邀请文档作者、只更新约定”的用户消息，保存新 revision，不新增任务或停止既有工作；人工核对保存文本包含新要求且保留原有限制，数据库重开后来源与版本仍在。该验证不代表后续实际任务遵循率或完整多 Agent 验收。未运行全量测试、构建、打包或 Renderer 交互复验。

简化后的验证：上述七个 room-engine 定向测试文件共 47 项通过；`git diff --check` 通过。Electron main 的真实 Claude Code CLI smoke 约 33 秒、4 次调用通过，覆盖文档、Report、产物 diff、Attention 与数据库重开。本轮未跑全量测试、构建、打包或 Renderer 交互复验。

本轮完成真实的“多 Agent 评审 → 用户决定 → 继续实施”纵向复验：Electron main 中使用真实 Claude Code CLI，在临时 Room/Chat 内自动创建文档作者、只读评审者和实施者三个独立角色。文档任务与评审任务各完成一次 Assignment；评审完成后才创建 approval Attention，smoke 通过同一 UserCommand 入口接受文档并回答 `implement`，之后才创建并派发实施任务。实施者写入 `src/add.cjs` 与 `test/add.test.cjs`，平台在同一临时项目中用 Electron 内置 Node 执行 `node --test` 和额外契约断言；最终 3 个 Task、3 个 Assignment、3 个 Report、文档/实施 Artifact、Attention 和用户决定事件均通过数据库重开校验，实施派发事件序号晚于用户决定。最近一次复验 10 次真实 CLI 调用、约 129 秒，`reopenVerified: true`。

真实 CLI smoke 现在也接入了受管理 `ProcessRegistry`，并将其记录提供给 v2 Room Service 的进程对账入口；普通文档场景复验 6 次 CLI 调用、约 47 秒，数据库重开和协作约定更新均通过。异常恢复场景已在真实 Claude Code CLI 上自动注入一次 unknown，确认平台不伪造 `session_exited`，进程记录确认结束后才允许用户 retry，并完成替代 Assignment；恢复 smoke 4 次 CLI 调用、约 62 秒，数据库重开验证通过。不引入旧 Session 续跑机制。

验收过程中发现原生 CLI 可能在机器 Report 标记后追加说明文字，导致原先要求标记位于回复末尾的解析器误判“无 Report”。`report-importer` 现从消息中读取最后一个 `[[MELDWORK_REPORT:{...}]]` 标记，仍对 JSON 字段、kind、摘要、Artifact 范围做严格校验；新增定向测试覆盖标记后有 prose tail 的情况。实施 Agent 的 `workspace-write` 会话在本机仍可能因 CLI Bash 审批策略返回 blocked，因此该 smoke 明确由 Agent 写入代码与测试，平台验收阶段执行测试命令；这保留了真实评审/用户决定/实施调度链路，同时不把交互式审批假设硬编码进产品。

真实 CLI 复验发现，Report 触发的批次没有保留任务源消息，可能遗漏用户的后续要求（例如“文档完成后请我确认”）。Controller 上下文现携带任务引用的历史 `sourceMessages`，过滤跨 Chat、删除和当前批次重复消息；历史消息不作为新派发触发器，不引入固定审批流程。定向回归已覆盖该缺口。

本轮验证：Electron Node 模式运行 room-actions、controller-session、controller-agent、user-commands、room-db、assignment-runner、mention-fallback 共 48 项测试通过；`git diff --check` 通过。修复后的 `npm --prefix desktop run smoke:room -- --run --provider claude` 在临时项目中以真实 Claude Code CLI 约 30 秒、4 次调用通过文档/Report/快照/diff/Attention/账本重开验证。未跑全量测试、构建或打包；本轮未复验 Renderer 点击交互。

## 实施原则

1. 新引擎与旧 checkpoint engine 并存。新 Chat 走 v2 账本，旧 Chat 保持 legacy 行为。
2. 先建立事实账本和统一消息管线，再接入 Controller 和动态组队。
3. 每一步都必须可重启、可回滚、可观测；任何外部副作用先进入 effects/outbox。
4. Controller 只产生受校验的建议，Worker 只提交 Report；Task 状态由 Room Engine 和平台事实产生。
5. 不在首个切片实现跨 Chat Task 依赖、默认隔离 workspace、自动删除旧引擎或新的远程服务。

## 目标切片

首个可交付切片只覆盖一个 Room、一个新 Chat、两个已有 Agent 角色和一条完整闭环：

```text
用户消息/@mention
  → SQLite Message
  → Controller/fallback 创建 Task
  → 两个 Assignment 执行
  → Report(kind=ready)
  → 文档 Artifact
  → 评审 Assignment
  → Attention
  → 用户 answer_attention
```

验收时，用户只看到消息、Task、Report、Attention 和 Artifact；不出现 checkpoint、Gate、Seat、Round 或讨论模式选择器。应用重启后，消息、Task、Assignment、Report 和 effects 不丢失，也不重复创建。

## 工程分层与代码落点

### 账本与迁移层（Desktop main）

新增 `desktop/src/room-engine/`，首版至少包含：

- `room-db.cjs`：SQLite 打开、WAL、外键、schema version 和事务边界；
- `room-schema.cjs`：rooms、chats、messages、agent_roles、tasks、assignments、reports、artifacts、attentions、controller_decisions、effects、events；
- `room-migrations.cjs`：schema migration、state.json 备份和失败回滚；
- `room-repository.cjs`：领域对象的查询和写入；
- `room-actions.cjs`：ControllerAction、UserCommand、PlatformTransition 的校验与落盘；
- `room-outbox.cjs`：effect 入队、幂等、重试和 unknown 恢复；已接入 `start_assignment` 的最小执行器，其他副作用仍在 Phase 3 扩展。
- `report-importer.cjs`：解析严格的 `[[MELDWORK_REPORT:{...}]]` 机器标记，写入 Report 真源和 `report_received` 审计事件；不从自由文本推断任务完成。
- `session-supervisor.cjs`：由主进程记录 session liveness 和退出事实，并查询 stale Assignment；Worker 自报消息不构成 liveness 证明。
- `report-state.cjs`：根据最新 Report 推导 Assignment/Task 状态；状态转移不接受 Controller 自由设置。
- `user-commands.cjs`：执行用户回答 Attention、Artifact 接受/拒绝、Chat 暂停/恢复、Task 停止，以及已结束 Assignment 的幂等重试/交接；unknown 执行已接入受管理进程记录对账，用户控制 UI 首版已接入，无记录执行恢复仍待完善。
- `mention-fallback.cjs`：Controller 不可用时按显式 @mention 确定性创建 Task/Assignment；不从普通自由文本推断角色或授权。
- `room-service.cjs`：Room Engine 的组合入口，后续 IPC、Controller Session 和 Agent 调用只依赖此门面。
- `room-ipc.cjs`：将 Room Service 映射为窄 IPC channel；绑定 main/preload 时沿用现有 renderer 信任校验，不暴露数据库或进程能力。

当前 v2 IPC/preload 提供 listRooms、createChat、bootstrap、snapshot、artifactDiff、submitMessage、applyUserCommand、listStaleAssignments、assignmentTrace 九个入口。assignmentTrace 只接收 Room/Assignment ID 与分页参数；主进程按数据库中的 Assignment 归属及 runId 推导 traceAgentRunId，再由 Trace reader 对照 Room Assignment 授权，不接受 Renderer 提交 Trace 路径或执行标识。直接启动 Assignment、ControllerAction、Report 导入、Session liveness 写入和 effect 入队已从 Renderer 接口与 main channel 注册中删除，不保留旧调用兼容层；这些能力仅由主进程执行链使用。注册时必须提供 Renderer 信任校验，所有调用先完成信任与退出状态检查，再校验 DTO 字段和有界标量值。消息作者固定由 main 赋为本地 user，bootstrap 创建者和 UserCommand 审计 actor 同样由 main 赋值，Renderer 不得传入 author/actorId/createdBy 或自行指定生成对象 ID。Message 的 replyTo/taskId 必须引用同一 Chat 的有效对象。正文里的 action/Report 标记只属于消息内容，不进入平台事实写入通道。消息编辑/删除与实时订阅接口尚未开放。

复用 `desktop/src/project-room/project-state-schema.cjs`、`project-state-migrations.cjs`、`project-store.cjs` 的迁移经验，但不把新的 Task 状态继续塞进 checkpoint engine。复用 `desktop/src/security/private-file.cjs` 保证数据库目录权限，数据库放在应用私有区，不放入 Room 主目录。

### 运行与通讯层（Desktop main）

复用和适配：

- `desktop/src/runs/invocation-watchdog.cjs`：Supervisor liveness 和进程退出观察；
- `desktop/src/runs/run-event-protocol.cjs`、`run-ledger.cjs`：Run Ledger 与 Assignment/runId 映射；
- `desktop/src/runs/path-claims.cjs`：Room 主目录写入租约；
- `desktop/src/workspace/local-workspace-agent-invocation.cjs`、`invocation-session.cjs`：保留原生 Agent 调用；
- `desktop/src/project-room/shadow-git.cjs`：代码 Artifact 的 commit/diff 引用；
- `desktop/src/project-room/effect-runner.cjs`：迁移为消费 v2 effects/outbox。

新增 `desktop/src/room-engine/session-supervisor.cjs` 和 `message-ingress.cjs`，分别负责 liveness 事实和统一 Message 入队。Worker 正文不得直接生成 ControllerAction；Report 只能通过窄工具或严格机器标记导入。

### Controller 层（Desktop main）

新增 `desktop/src/room-engine/controller-session.cjs`：

- 按 Chat 批量读取待处理 Message、Report 和平台事件；
- 携带 `batchId`、`contextRevision` 和幂等键调用 Controller；
- 只接受 ACP 工具调用或严格 JSON block；
- 将动作交给 `room-actions.cjs` 校验；
- Controller 不可用时回退到显式用户 @mention 的确定性派发；
- 记录 `controller_decisions`，不把长篇推理写入 Thread。

Controller Prompt、角色 Prompt 和 ChatContext revision 通过 `chat-context.cjs` 管理；Prompt 只能影响协作建议，不能修改权限、租约、Provider 白名单或持久化事实。

### Renderer 与 UI 层

先增加 v2 读模型和窄 preload API，再替换 UI：

- preload 只暴露 Room/Chat 查询、消息提交、UserCommand 和订阅事件；
- 复用 `frontend/src/composables/useProjectRoom.js`、`useProjectRoomView.js`、`useConversationTimeline.js`；
- 新增或改造任务卡、Report 卡、Attention 卡和 Artifact 卡；
- `ProjectRoomGatePanel.vue`、`ProjectRoomSeatSettings.vue` 等旧组件在新 Chat 中不再作为入口，旧 Chat 仍可使用；
- 所有新增文案进入 `frontend/src/locales/zh.js` 和 `en.js`。

## 分阶段执行

### Phase 0：运行时 Spike 与协议冻结

工作项：

- 在 Electron 当前版本验证 `node:sqlite`、WAL、事务和打包可用性；不可用时再评估 native SQLite 方案；
- 把 01、02、04 中的 schema 转成 JSON Schema 或等价运行时校验；
- 固定 Report.kind 到 Task 状态的映射；
- 固定 UserCommand、PlatformTransition、effects unknown 恢复规则；
- 明确应用私有区路径、权限、备份和迁移失败回滚。

退出条件：Spike 有可复现记录；协议校验能拒绝未知字段、错误 actor、过期 contextRevision 和重复幂等键；不修改现有用户数据。

### Phase 1：SQLite 账本与统一消息管线

工作项：

- 建立数据库 schema、迁移版本和 repository；
- 实现 Message 入库、sequence、编辑/删除事件和事件队列；
- 实现 Chat/Task/Assignment/Report/Attention 的最小查询；
- 为旧 V4 数据建立只读 legacy 标记和一次性导入工具；
- 写入 effects/outbox，但先只接入无破坏性的系统消息副作用。

退出条件：新 Chat 的消息只从 SQLite 读取；重启不会丢消息；同一幂等键不会产生重复 Task；旧 Chat 仍由旧引擎打开。

### Phase 2：Assignment、Session 与 Report

工作项：

- 将 `Assignment` 映射到现有 `invokeAgent`、native session 和 Run Ledger；
- 接入 Supervisor liveness、session_started/exited 和 stale 恢复；
- 兼容现有 `ready/question/continue` 回执，转换成 Report；
- 实现 Room 主目录租约和 shadow Git Artifact 引用；
- 记录 Agent 正文消息与结构化 Report 的关联。

退出条件：一个 Agent 运行一小时后仍能提交 Report；进程退出和应用重启都能恢复 Assignment；没有 Report 时不能把 Task 标记为 done；代码变更能生成可追踪 Artifact。

### Phase 3：Room Engine 与确定性 fallback

工作项：

- 实现 ControllerAction、UserCommand、PlatformTransition 的分离校验；
- 实现 create_task、assign、request_attention、accept_artifact、answer_attention 等最小动作；
- 实现 Controller 不可用时的显式 @mention fallback；
- 接入 outbox effect runner，处理 pending/running/succeeded/failed/unknown；
- 增加审计事件和 action result 卡。

退出条件：用户 @Agent 可以创建 Task；Agent 的 @Agent 只能进入 Controller 建议；Worker 文本不能伪造 action；Controller 故障时项目室仍可继续接收消息和执行已启动任务。

### Phase 4：Controller Session

当前批处理入口已实现 Chat 级单批次运行保护、决策前后 context revision 校验、输入消息编辑/删除检测，以及 Message/ControllerAction 的 Chat 归属校验。模型输出的所有动作会先完成协议校验，再开始应用；模型失败会释放运行槽。动作、派发 effect 和决策审计在同一同步事务中提交，后续动作或审计写入失败会整批回滚；嵌套服务事务通过 SQLite savepoint 组合。Controller 批次统一经过 Room Service 的派发入口，避免只创建 Assignment 而漏建 effect。模型调用发生在事务外，事务内不启动 Agent。

Controller Session 默认在 60 秒后超时，构造时可通过 `timeoutMs` 设置正整数毫秒期限；主进程调用方可向批处理传入 `signal` 取消等待。路由器收到独立的 AbortSignal，超时/取消后释放 Chat 运行槽，迟到成功或失败不应用动作、不写入决策审计。超时计时器与取消监听在调用结束后清理。此处是逻辑取消；真实 CLI 适配器仍需遵守 signal 并接入进程终止和清理，才能保证旧进程不再消耗资源。

`controller-queue.cjs` 已提供 Chat 级自动合批（默认 40 毫秒）、批内消息/事件 ID 去重，以及运行期间新输入的下一批排队。自动队列每批最多 32 条输入（消息与事件合计），多余输入按入队顺序拆批，每批读取最新 context revision，不同 Chat 独立运行。配置且可用的 Controller 会将用户/Agent 消息统一排队，避免同时触发确定性 fallback；未配置 Provider 或原生执行目标不可用时保留显式用户 @mention fallback。服务关闭会取消运行批次、拒绝待处理请求、清除退避定时器并等待结束，主进程在此之后关闭数据库。队列仍在内存，但已通过下述账本差集接入重启补调度；不保证跨进程只调用一次模型，不能据此视为 Phase 4 已完成。main 已连接原生调用适配器，但现有桌面 UI 仍使用原路径。

Room Service 对明确可恢复错误启用有界重试：Controller 超时、执行目标解析暂不可用（现有错误码仍为 ROOM_CONTROLLER_GROUP_NOT_FOUND）、同 Chat 批次占用、context/message 过期，以及 ETIMEDOUT/ECONNRESET/ECONNREFUSED/EAI_AGAIN。首次失败后分别等待 1/2/4 秒，最多额外重试 3 次；每次使用新 batchId 和最新 context revision，同一批输入先重试再处理后续输入。新消息或手动 flush 不能跳过冷却时间，其他 Chat 不受影响。协议错误、权限错误、暂停/关闭、未知错误不自动重试。最初 enqueue/flush 仍立即返回本次失败，后续自动尝试的错误通过主进程错误回调记录；成功才提交消费凭据，重试耗尽后保留账本输入。运行期间重复入队同一失败输入不能重置该批次重试预算；重启后预算不保留，按未消费输入重新调度。不自动转成 fallback，不自动重跑 Worker。

`controller-backlog.cjs` 使用已提交 `controller_decisions.input_ids_json` 作为消费凭据，不增加第二套队列状态。`startRuntime` 在启动 effect 消费前扫描活跃 v2 Chat，Chat 恢复时只扫描该 Chat。未删除的用户/Agent 消息，以及 Report、创建 Task/角色、用户回答 Attention/决定 Artifact/恢复 Chat/重试/交接事件，按原 sequence 进入批处理；不回放心跳、退出、普通审计与系统消息。已成功 fallback 的消息同样排除，避免 Controller 恢复后再建任务。批次执行前再次过滤已消费输入，重复扫描或运行中重入不重复提交动作；相同 batchId 仍返回原决策。

积压查询已改为 SQL 消费凭据差集与 LIMIT 分页，不再把全部消息、事件和决策输入 ID 加载为 JS 数组/Set；默认页 256 条，可按 Chat 和已入队键排除。活跃 Chat 使用数据库迭代器读取。队列全局最多 256 条输入、单 Chat 最多 64 条，运行中与退避中的输入均占容量；重复输入共享 Promise。容量满时新消息/Report 仍留在 SQLite，主进程不记录为调度失败；每批结束后按剩余容量从账本补入，直至正常积压消费完。

决策与 actions/effects 原子提交，因此落库失败的输入仍待处理；崩溃前模型已返回但决策未提交时，恢复允许重新评估。暂停/归档/legacy Chat 不补调度；扫描时 Controller 不可用则保留积压。非重试错误或重试耗尽后，该 Chat 停止自动补入，新消息也仅保存；已在队列的其他输入可继续完成，其他 Chat 可继续补入。显式 resume_chat 或重新启动运行时解除本次内存阻塞并重新扫描，重启也可恢复；该阻塞尚无独立持久化状态与 UI 提示。当前仍缺按字节/Token 划分批次、重试耗尽的用户控制面和已消费消息编辑后的重新评估；容量限制的是输入数量，不是整个 Electron 进程内存，原生 Controller Prompt 仍受现有 4 MiB 校验。数据库差集查询的历史扫描成本、决策/消息归档及消费凭据保留策略仍待优化。

`effect-pump.cjs` 已在 main 开启，平台进程恢复结束后扫描 pending effects；新派发和 fallback Assignment 都写入幂等 effect 并唤醒消费。首版串行消费 Assignment，暂停 Chat 不领取 pending effect，恢复 Chat 后自动继续；不自动重试 failed/unknown，也不接管崩溃遗留的 running effects。服务关闭时向 Worker 传递取消信号并等待消费结束。

`runtime-recovery.cjs` 在首次消费 effect 之前运行：遗留 running effect 转 unknown，并创建恢复 Attention；没有最终 Report 的 running Assignment 转 waiting/outcome=unknown，required Assignment 会使 Task waiting。已提交最终 Report 的 Assignment 按 Report 恢复，ready 仍可使满足完成条件的 Task done；可选 Assignment 中断不会阻塞已完成的 required 工作。Attention 使用确定性 ID，重启不会重复创建；恢复动作、审计和 Attention 同一事务提交，写入失败则不继续启动消费。这里不生成 session_exited，不声称残留进程已终止，也不会因用户点击“已知悉”自动重试。恢复接口仅允许新执行开始前调用。后续进程证据对账与消息/事件补调度分别由独立模块负责。

`process-reconciliation.cjs` 已接入主进程启动和显式重试/交接：原生调用将 v2 runId 写入受管理进程的 invocationId；仅在同一 runId 的记录非空、Provider/工作目录匹配且全部 ended 时，补记 session_exited 和对账审计，unknown Assignment 改为 interrupted，关联 unknown effect 收口 failed，恢复 Attention 更新说明。最终 Report 与已完成 Task 不变，不自动重放 effect；重复对账不重复写入事实。命令触发的对账与新尝试/outbox 原子提交。缺记录、身份冲突、任一进程未 ended 时继续隔离。当前只覆盖受管理进程路径；只读、远端、旧无 runId 记录以及超过 ended 记录 24 小时保留窗口的调用，仍需后续恢复方案。对账读取注册表现有事实，不主动重新探测残留进程。

Report 入账和状态推导在同一事务内完成，成功后将 `report_received` 的 eventId 放入 Controller 队列；重复 Report 不重复唤醒。主控创建 Task/角色成功后，以其动作事件触发下一批，使用真实落库 ID 继续派发；用户回答 Attention、接受/拒绝 Artifact 和恢复 Chat 也产生主控输入。Controller 校验事件属于当前 Chat，并记录输入 ID；不会把事件伪造成用户消息。已用替身验证“消息 → 建任务 → 事件 → 派发 → Worker → Report → Attention → 用户回答 → 主控”，真实 CLI、进程心跳和重启恢复验收仍待完成。

用户 `retry_task` / `handoff_task` 已实现针对具体 Assignment 的新尝试派发：命令要求 commandId 并以用户/Chat 为范围幂等；新 Assignment 通过 previousAssignmentId 关联原尝试，继承 required 和写入范围，attempt 加一。新 Assignment、命令审计、outbox effect 同一事务提交，重复命令不重复派发。报告状态和启动恢复只计算替代链上最新的 required Assignment，旧失败和迟到报告不阻塞新尝试完成；新 Worker Prompt 携带上一尝试的报告、证据和产物引用。允许 failed/waiting/blocked/cancelled 且原进程已结束的尝试；未知执行仍被拒绝，必须先完成进程对账，不能用重试命令绕过恢复边界。

`stop_task` 已接通独立控制 outbox：Task、queued Assignment/pending effect 取消与运行执行停止意图原子落盘，存储失败不发送取消。控制队列可在 Chat 暂停时工作，不被串行 Worker 消费堵住。Assignment Runner 使用独立 AbortController，停止完成后才写 cancelled 和 session_exited；取消后的迟到输出不导入 Report，报告推导/重启恢复不会复活 cancelled Task，Controller 不得直接重新派发该 Task。停止后用户可明确 retry/handoff 新尝试。终止失败转 unknown + Attention，不伪造退出；所有平台上未结束的底层调用都保留写租约至实际结束，进程对账可收口 unknown stop effect。一次操作自动完成停止并交接、残留进程主动探测及相关 UI 仍待实现。

停止切片通过 Electron 内置 Node 的 99 项定向测试，涵盖停止幂等/跨 Chat 拒绝、落盘失败回滚、暂停 Chat 控制通道、确认退出后交接、重启 unknown 隔离、迟到结果拒绝、原生取消信号及未结束调用保留写租约，以及现有 Room/进程终止/共享调用回归。CLI 进程使用替身，未运行 GUI、真实外部 CLI、全量测试或打包检查。

工作项：

- 实现按 Chat 批处理、去重、退避和 stale session 重启；
- 接入 Controller Prompt、ChatContext revision 和角色 Prompt revision；
- 支持 create_task、reassign（仅未启动 Assignment）、update_context、create_role、propose_retry/propose_stop；
- 将 Controller 长文本推理留在 Trace，只在 Thread 展示简短派发说明；
- 建立路由误派、重复派发、Attention 数量和成本指标。

退出条件：两条并发消息只触发一个批次；过期 action 被拒绝或重排；Controller 不能越过平台边界；决策可通过 batchId 和 contextRevision 审计。

### Phase 5：动态角色与新 Chat UI

第一版独立入口已落地：`RoomWorkspace.vue` 与 `useRoomWorkspace.js` 直接读取 v2 SQLite 快照，不通过旧 checkpoint/group UI。支持选择目录创建项目、选择已有 Provider、新建独立团队 Chat、发送消息、展示 Chat 角色/Report/Task/Attention 和 Room Artifact，以及回答 Attention、接受/拒绝 Artifact、暂停/恢复、停止、重试、已结束执行的交接和显式目录写授权。新 Chat 不复制另一 Chat 的角色或协作上下文。所有新增文案提供中英文。

快照补充 roles/reports/artifacts；当前使用 1.5 秒串行轮询，卸载时释放计时器，切换 Room 后丢弃迟到结果。操作完成后等待旧轮询结束并重新读取，避免新 Chat 被旧快照覆盖。草稿按 Chat 隔离，发送失败保留。产物 diff 入口已接通（见下方只读切片）；分页、实时流式消息、Prompt/Skill 编辑、运行阻塞专项提示和完整 Trace 入口仍缺，不能视为 Phase 5 完成。

动态角色已有真实 CLI 闭环：Controller 可按当前需求创建 Chat 级角色，平台检查 Room Provider/能力范围，后续决策可为该角色创建任务并派发。成员卡显示主控创建角色的理由、职责及 Prompt。Room 快照返回当前 Chat 角色的最新 Prompt；用户可通过统一、幂等的 `update_role_prompt` UserCommand 更新角色 Prompt revision。更新只影响后续 Assignment，保留历史 revision，不增加角色归档或停用状态机。Prompt 仍受 Chat/Role 归属校验，不能授予新的 Provider、能力或目录权限。

Assignment Trace 的只读入口已接通：执行记录卡片可按需加载该次 Assignment 的 Trace 步骤，并通过不透明 cursor 向前分页读取更早步骤。步骤中的大字段可通过 Room 专用 Blob IPC 按 256 KiB 分页读取，读完后隐藏继续加载按钮。Room 专用 IPC 不接受 runId、agentRunId 或文件路径；主进程由 Room DB 验证 Assignment 并推导 trace 身份，Trace reader 通过 Room 授权回调确认后读取应用私有区 JSONL。当前仍是嵌入任务卡的摘要/输出查看，完整 Trace 面板尚未接入。

Assignment 在创建时保存 `role_prompt_revision`，执行时按该 revision 读取 Prompt，避免尚未启动的排队任务被后续 Prompt 编辑暗中改变；旧数据库迁移会为已有 Assignment 固定迁移时的当前角色 revision。定向回归覆盖排队后更新 Prompt、执行仍使用创建时版本的行为。

Room UI 已消费现有 Supervisor stale 查询：平台 liveness 超过两分钟未更新时，当前 Chat 对应 Assignment 显示“可能已失联”，侧栏提示检查进程或产物。该提示不改变任务状态、不自动重试；查询失败时隐藏提示，不阻塞消息和任务操作。RoomWorkspace 定向测试覆盖查询参数与提示展示。

验收：18 项前端定向测试与 43 项 Electron Node 主进程/IPC/preload 测试通过；前端普通构建与桌面构建通过。Electron 临时用户目录下已检查侧栏入口和新页面的消息、角色、报告、任务及 Attention 布局。窗口内用户已有草稿，未继续自动操作；发送/新 Chat/任务控制的桌面交互和真实 CLI 文档生成闭环仍待验收。临时验收项目未配置 Controller Provider，不能用于验证真实 Agent 产出。未跑全量测试或打包检查。额外尝试的旧 appControllers/App.navigation 测试存在失败，已在未修改的 HEAD 副本复现，未在此切片扩展修复。

工作项：

- 实现建议模式的动态角色草案；
- 实现受限自动模式：只能绑定 Room 已有 Provider 和能力；
- 支持角色 Prompt revision、复用和按协作约定调整邀请对象；
- 将 UI 改为群聊 + Task/Report/Attention/Artifact 卡；
- 新 Chat 隐藏并发/顺序/自动讨论模式入口。

退出条件：用户可在同一 Chat 中新增生图角色并让已有 Agent 请求它；新角色不污染其他 Chat；高成本 Provider、长期角色和额外能力会产生 Attention。

### Phase 6：可选隔离 workspace 与旧模式退役

工作项：

- 仅为明确需要的 Assignment 提供隔离 workspace；
- 定义输入 Artifact、输出 patch/commit 和发布校验；
- 旧 Chat 保持兼容，逐步移除新 UI 中的 checkpoint/gate/seat/round 入口；
- 统计共享主目录冲突后，再决定是否扩大隔离模式。

退出条件：共享模式的租约冲突可拒绝或串行化；隔离模式可发布可审计 Artifact；旧模式不再成为新 Chat 的隐式依赖。

## 测试与验收矩阵

每个阶段至少补充以下测试：

| 范围 | 必测内容 |
| --- | --- |
| SQLite | schema migration、事务回滚、WAL、幂等键、备份恢复 |
| 权限 | Controller/User/Platform action 隔离、作者伪造、Prompt injection 文本不生效 |
| 调度 | 批处理、重复消息、过期 action、Controller 不可用 fallback |
| 运行 | liveness/stale/exited、长任务 Report、重启恢复、unknown effect |
| workspace | 租约冲突、shadow Git Artifact、隔离 workspace 发布 |
| UI | 中英文、Attention 回答、Escape 返回、旧 Chat 兼容、新 Chat 无旧模式入口 |

仓库级检查沿用 AGENTS.md：

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
npm --prefix desktop run pack
```

文档阶段不要求先运行上述命令；进入对应代码阶段后，阶段验收必须记录实际执行结果。

## 暂不实施的事项

- 跨 Chat Task 依赖和全局依赖图；
- 将完整 Trace、聊天正文或 Artifact 内容塞进 SQLite；
- 所有 Assignment 默认复制 worktree；
- 新的远程服务、云端消息或远程参与者；
- Controller 直接停止进程、直接设置 Task done/cancelled；
- 通过解析自由文本猜测完成、授权或用户审批；
- 在新引擎稳定前物理删除旧 checkpoint engine。

## 首轮开发顺序

实际开发按以下顺序提交，每个提交保持可回滚：

1. SQLite runtime spike 与 schema/migration 骨架；
2. Message、Event、effects/outbox repository；
3. Chat/Task/Assignment/Report 读写与 legacy 投影；
4. Session Supervisor、Report importer 和 invokeAgent 映射；
5. 确定性 fallback 与最小 Room Engine action；
6. Controller batch session；
7. 新 Chat UI 与 Attention/Artifact 卡；
8. 动态角色和受限自动组队；
9. 可选隔离 workspace 与旧模式清理。

每个提交都应附带迁移说明、测试结果和回滚方式；未经 Phase 0/1 验收，不开始动态组队和旧模式删除。

## 当前实现进度（2026-11-15）

Room Engine 的第一条主进程纵向切片已经接入 Electron 生命周期：

- SQLite ledger 初始化在应用私有目录 `userData/meldwork-private/room-engine`，不写入用户项目目录；
- `room-service` 通过 `room-ipc` 注册到受信任的主进程 IPC 边界；Renderer 只能通过窄的 preload API 调用；
- preload 仅暴露 Room 列表、Chat 创建、bootstrap、snapshot、用户消息提交、UserCommand 和 stale 只读查询；ControllerAction、Report、Session 事实、effect 和直接执行均保留在 main；
- 增加 `room:bootstrap`，在一个事务中创建独立的 v2 Room、primary Chat 和审计事件，作为新 Chat UI 的初始化入口；
- 增加 `room:snapshot` 读取面，按 Room 返回 Chat、消息、Task、Assignment 和 Attention，供新 UI 使用；
- 增加独立 `assignment-runner` 适配器：把 queued Assignment 映射到现有 `invokeAgent` 回调，记录平台 session facts；无 Report 的进程退出进入 waiting，不直接完成 Task；
- 退出流程先停止 Room IPC 接收，再关闭数据库，避免关闭期间产生新的写入；
- 进程对账一轮 52 项专项测试已在 Node 与 Electron 内置运行时通过；最新补调度/队列/决策/Room Service 50 项专项测试在 Electron 内置运行时通过，覆盖数据库重开、600 条积压分批自动补入、150 条实时消息溢出后继续消费、全局/单 Chat 容量、运行/退避占用、终止失败停止补入与显式恢复。尚未运行 Desktop 全量测试、真实 Electron GUI/CLI 端到端验收和打包检查。
- IPC 边界收口专项覆盖通道移除、信任校验、作者/actor 伪造拒绝、参数白名单/长度限制、跨 Chat 引用拒绝，以及真实 SQLite 下 Report 标记不改变 Task 状态；preload 测试验证只保留用户操作和读取入口。真实桌面交互和 CLI 端到端仍待验收。
- 独立原生调用一轮 35 项专项测试在 Electron 内置运行时通过，覆盖无 group 的 Controller/Worker、禁止旧 ContextPack/上下文读取、Trace、并发 operation 隔离、执行目标归属/权限/取消校验，以及共享 project-room 调用代码回归。测试仅替换 CLI 进程，尚未实际调用外部 CLI。

v2 已解除对持久化旧 group 的宿主依赖。`native-runtime.cjs` 仅复用原生执行底层：按 Room/Chat/runId 生成临时执行 ID 与独立 operationId，补齐 traceAgentRunId；不读取旧上下文、不生成旧群聊消息、不在旧 Session 表保存原生会话，调用结束清理临时 Agent snapshot。目录/Provider/Chat 不匹配或 Agent 不可用时拒绝。

已接通 `set_workspace_write` 用户命令与 Room 根目录独占租约：授权绑定真实目录，非空 writeScopes 的 Worker 才能申请写入；Controller 与无 writeScopes 的 Worker 保持只读。运行中/unknown 执行阻止 Room 授权变更；等待租约后再校验授权，排队取消不启动 CLI。独占声明跨租约挂起恢复保留，并传入受管理进程登记。writeScopes 不提供文件级沙箱，首版互斥单位是整个 Room 根目录；授权 UI 和自动 Artifact 快照仍待接通。

该切片在 Electron 内置 Node 运行时通过 95 项 Room/IPC/调度器定向测试，以及 14 项共享 project-room/影子 Git 调用回归；CLI 使用替身，未运行 Electron GUI、真实 CLI、打包或全量测试。

每次 Room Assignment 原生调用都创建独立的临时 Session key，并由 `native-runtime.cjs` 强制 `saveSession: false`；v2 不实现旧群聊 Session 的持久化续跑。需要继续工作时，平台创建新的 Assignment，并把上一尝试的 Report、证据和 Artifact 引用作为结构化输入。无 Report 的退出保持 waiting，畸形 Report 记录 failed 和退出事实。v2 群聊 UI 首版和授权/停止/重试/交接及产物 diff 入口已接通；下一步完成运行阻塞提示与 Trace 入口。

### 自动产物版本切片（2026-11-15）

`artifact-snapshots.cjs` 已接入 main 和 v2 原生执行：仅对获得写授权且带 writeScopes 的 Worker，在持有 Room 根目录独占租约期间保存执行前基线和正常返回后的影子 Git 快照。完成快照与产物落库后才释放租约；Controller 和只读 Worker 不触发快照，不新增隐藏 group 或旧 checkpoint 依赖。

- 快照前先事务写入 running `artifact_snapshot` effect；Git 操作在数据库事务外进行。版本回执、Artifact 与 effect succeeded 在同一事务提交。崩溃遗留 running effect 沿用启动恢复逻辑转 unknown + Attention，不自动重拍工作目录冒充原版本。
- 每个变化路径生成一个 published Artifact，记录 Room/Task/Assignment、路径和不可变 commit；删除记录 kind=deletion，事件保存基线 commit 和变化清单。没有变化不生成 Artifact。重放已成功的同一快照返回原回执和 ID。
- 平台生成的 Artifact ID 自动合并进对应 Report；Worker 报告只能引用同一 Room 已存在的 Artifact，不能凭路径或伪造 ID 创建版本。平台附加的 ID 还必须属于当前 Assignment。
- 影子 Git 位于应用私有目录。排除整个应用 userData；路径按 realpath 处理，避免 macOS `/var` 别名使排除失效。不修改用户 Git index/config/分支。此处复用的是 ShadowRepo 文件版本底层，不是旧流程引擎。
- 快照/落库失败不导入完成 Report，未确认的副作用转 unknown 并创建中英文 failure Attention。取消后不发布迟到产物；大小/LFS 占位符不能被当成完整文件版本发布。

本切片通过 Electron 内置 Node 的 60 项定向测试，涵盖真实 Git 快照、原生调用链、Report 归属、租约内完成、取消、原子回滚、停止控制和共享调用回归；外部 Agent CLI 仍为替身。未运行全量测试或打包检查。

复现命令（在 `desktop/` 执行）：

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test --test-reporter=spec \
  test/room-engine/artifact-snapshots.test.cjs test/room-engine/native-runtime.test.cjs \
  test/room-engine/report-importer.test.cjs test/room-engine/assignment-runner.test.cjs \
  test/room-engine/stop-task.test.cjs test/room-engine/room-service.test.cjs \
  test/project-room/project-room-invocation.test.cjs test/project-room/shadow-git-invocation.test.cjs
```

另通过 `node --check desktop/src/main.cjs`、`node --check desktop/src/room-engine/artifact-snapshots.cjs`（仓库根目录）和 `git diff --check`。

另在独立临时 userData 中启动了真实 Electron 桌面应用，使用本切片生成的版本与 Report 打开 v2 项目室，通过 Renderer DOM 检查确认 `docs/requirements.md` 产物卡和报告正文均已显示。验收进程已退出，原有用户窗口和草稿未被操作；这项检查不等同于真实外部 CLI 端到端验收。

边界：共享工作目录中的外部编辑器/未受平台管理的进程仍可能改变文件，因此版本记录表示执行区间内观察到的变化，不证明每一行都由该 Agent 编写。writeScopes 仍不是文件级沙箱，产物捕获记录整个工作目录的实际差异。异常退出/终止后的部分产物自动归档、快照 unknown 的专用恢复操作、已接受版本漂移提示与 Trace UI 尚待实现；Artifact 接受当前只更新账本状态，不恢复工作目录。

### 产物只读 diff 切片（2026-11-15）

`artifact-reader.cjs` 已通过 Room Service、`room:artifact-diff` 和 preload 接入产物卡。只接受有界 `roomId/artifactId`，拒绝 Renderer 传入路径、版本或 Git 可执行文件。主进程验证 Artifact 归属，并从 `artifact_snapshot_created` 回执取得执行前后 commit；无可信回执的产物返回 unavailable，不退回读取当前工作目录。查询不创建 Git 仓库、不改账本或用户文件，无需 schema 变更。

读取强制使用 literal pathspec，仅比较两个保存版本，因此当前文件被继续修改也不改变历史 diff。返回最多 256 KiB 的统一 diff，含 truncated 标记；删除和二进制变化保留 Git 的差异表示，截断多字节文本也受字节上限约束。Renderer 使用转义文本展示，不渲染产物内 HTML。

`RoomArtifactDiff.vue` 是内联面板，支持关闭按钮、Escape、加载状态、失败重试和截断提示。切换产物、Room/Chat 或离开页面后，迟到结果不会覆盖新选择。没有增加 overlay、执行能力或旧 checkpoint 适配。

验收命令：

```sh
# desktop/
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test --test-reporter=spec \
  test/room-engine/artifact-snapshots.test.cjs test/room-engine/room-ipc.test.cjs \
  test/security/preload-security.test.cjs test/room-engine/room-service.test.cjs
# frontend/
npx vitest run src/__tests__/meldwork/roomWorkspace.spec.js src/__tests__/meldwork/i18n.spec.js
# 仓库根目录
npm --prefix frontend run build
npm --prefix frontend run build:desktop
git diff --check
```

51 项 Desktop 与 19 项前端定向测试通过；两种构建通过（仍有既有的大 bundle 提示）。独立临时 userData 的真实 Electron 应用已通过 Renderer 点击产物卡、读取新增 IPC 并显示 `docs/requirements.md` 保存版本中的新增内容，验收进程随后退出，原用户窗口未操作。未运行全量测试、打包或真实外部 Agent CLI 闭环。全文浏览、版本间任意比较、已接受版本漂移和 Trace 入口仍待后续切片。

### 真实 CLI 首个闭环（2026-11-15）

新增显式入口 `desktop/scripts/smoke-room.cjs`。它在 Electron main 内通过真实 LocalWorkspace、原生 CLI adapter、Room Service 和影子 Git 工作，不模拟模型返回。平台账本、Trace 和产物保存到新建的临时目录；CLI 使用原生配置/凭据，不安装 Provider、不改配置或覆盖模型。当前脚本接受 claude/codex/gemini 作为显式选择，不加入默认测试。

首次 Claude Code 调用暴露了主控契约不足：Prompt 只列出动作名称与参数，模型返回 `action` 字段，运行时要求 `type`，整批被拒绝。修正为明确 discriminator、平铺参数与完整 JSON 示例，仍严格拒绝错误字段，不做兼容转换。另向主控提供平台写授权事实和 Room 产物引用，说明写任务需要已授权的非空 writeScopes，以及不重复创建开放 Attention。

修复后两次真实验收成功：均为 4 次 CLI 模型调用（3 次 Controller、1 次 Worker），分别约 33.5 秒和 42.5 秒。主控自行创建 1 位角色、1 个文档任务并派发；Worker 实际写出包含目标、操作、计分、失败条件与验收标准的 `docs/requirements.md`，返回 ready Report；平台生成 commit/Artifact 并关联 Report；主控发起同 Task 的 approval/decision Attention。第二次验收还关闭并重新打开数据库，确认产物、报告、Attention 与保存版本 diff 均可读取。没有预先创建角色/任务或向模型注入固定动作答案。

复现命令（`desktop/`）：

```sh
npm run smoke:room -- --run --provider claude
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test --test-reporter=spec \
  test/room-engine/controller-agent.test.cjs test/room-engine/controller-session.test.cjs test/room-engine/native-runtime.test.cjs
```

真实验收需显式 `--run`，缺失时以退出码 2 结束，不启动模型。最多 8 次 CLI 调用，单次 Worker 调用期限 90 秒，等待目标闭环期限 180 秒；退出时通过服务关闭取消并等待运行收口。控制台只打印阶段、身份、数量与错误码，详细平台 Trace 在临时私有目录，CLI 自身会话按原生配置保存。`userData/smoke-result.json` 保存本地验收摘要。29 项定向回归、语法检查及 `git diff --check` 通过；未跑全量测试或打包。本机 Codex 命令因安装缺失原生二进制无法启动，本轮未改安装或用其他可执行文件冒充通过；Gemini 尚未验收。

范围限制：本切片验证到“单 Worker 文档产出 → 等待用户确认”，不包含真实用户接受后实施、多 Agent 互评、成本/角色上限、长时心跳或崩溃后的残留进程对账，也不等同于完整产品验收。原记录中“原生 Session 续跑”已按当前架构决定取消：Assignment 使用独立调用，后续工作由新 Assignment 承接。后续真实多 Agent 评审、用户决定后的实施及异常恢复闭环已在本路线图前文记录。
