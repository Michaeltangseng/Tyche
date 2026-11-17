# 01 原则、范围与约束

## 1. 意图与原因

Meldwork 的目标不是造一个新的 Agent，而是让用户已经在用的原生 Agent（Claude Code、Codex 等）在一个本地房间里协作：共享目标、上下文、任务、产物和权限，同时保留每个 Agent 自己的生态。

项目室的核心问题不是“如何编排一个 workflow”，而是：

- Agent 之间如何看见彼此的工作；
- 谁来决定下一件事是什么；
- 工作结果如何被记录、验收和追问；
- 平台在什么边界内可以替 Agent 做决定。

eta 的答案更接近我们的原则：平台提供时间线、唤醒、会话、任务和报告；Agent 自己决定是否建任务、如何执行；Captain 只发可见的工作授权。Meldwork v2 的答案更偏向平台调度器，需要纠正。

## 2. 目标

1. **一个 Chat 就是一个可持续的团队工作空间。** 用户和 Agent 的消息进入同一条时间线；Agent 在 Chat 内有持续记忆。
2. **Agent 自己拥有工作。** Agent 自己创建 Task、自己执行、自己调用 `finish_task`；平台不替它分解大任务。
3. **上下文增量投递。** 每个 Agent 只收到自己上次看过之后的新消息，而不是每次重放整段群聊。
4. **Task 有持续记忆。** 一个 Task 的每个 lane（执行者/mention 角色）一个 session；执行者 lane 跨 run 复用；评论续跑；rerun 才丢弃记忆。
5. **可见的协作。** 用户能看到谁被唤醒、谁在做什么、任务是什么、报告是什么、哪里需要自己。
6. **平台治理不后退。** 权限、写入范围、进程、凭据、产物版本、恢复和审计仍由平台掌握。
7. **可以重写。** 早期阶段允许删除旧引擎和旧 UI；不为了兼容旧 Chat 保留两套语义。
8. **唤醒是异步的。** 一条消息里的多个 @ 同时开工；`mention` 不等待对方；平台不做隐式串行。
9. **Captain 通过 review supervisor 协调。** 平台只检查已结算的 Captain assignment 并投递 review；不维护 workflow 状态机。
10. **Agent 工具有真实通道。** `mention` / `create_task` / `finish_task` 等必须有 MCP 或严格标记通道，不能只写在文档里。
11. **聊天不写文件。** Chat 回复默认只读；写入只发生在获得授权的 TaskRun；隔离 workspace 之前，每个 Room 同时最多一个写入型 run。

## 3. 非目标

- 不做必需的远端服务、云端消息通道或远程参与者。
- 不把 Meldwork 做成通用 Agent 框架，或复刻 eta 的 daemon / 多机器 / Web 产品。
- 不实现跨 Chat 的全局任务依赖图。
- 不把完整 Trace、聊天正文或 Artifact 内容塞进 SQLite。
- 不默认复制 worktree；默认仍在 Room 主目录工作。
- 不在第一阶段接入新的内置模型 runtime；继续使用外部原生 Agent CLI。
- 不把 eta 的 cordis 插件体系、eta-server wire protocol、Web UI 搬进 Meldwork。

## 4. 反目标（即使技术能跑也算失败）

- Agent 每次执行都从零开始，平台反复把同一段上下文重新喂给模型。
- 平台偷偷拆任务、改任务、替 Agent 决定下一步，用户却看不见。
- 一个 Task 的多次尝试互相不知道对方做过什么，只能靠复制 Report 续命。
- 为了兼容旧 Chat，长期维护两套消息真源、两套 session 语义或两套 UI。
- 权限、写入范围和凭据被 Prompt 或聊天内容改写。
- 恢复时猜测进程已退出，或重放一个结果未知的写操作。
- 用户需要理解 checkpoint、gate、seat、round、Controller batch 等内部词汇才能使用项目室。
- 平台维护一个隐藏的 workflow 状态机，替 Agent 决定阶段顺序。
- 每个聊天回复结束都唤醒 Captain，造成噪音和循环。
- 把 Captain 协作做成独立的 completion wake 预算、独立阶段工具或新的调度器。
- Chat 回复默认可写，多个 Task 同时改同一个 Room 目录。

## 5. 新增原则：早期阶段允许推倒重写

这条原则优先于旧文档中的兼容性约定：

- 现在是早期开发阶段，修改代价最小。不要为了兼容旧逻辑而堆砌架构。
- 如果新架构明显更优，可以直接重写，抛弃旧架构。
- 旧数据通过**一次性迁移或归档**处理，不做长期双读、双写、双引擎。
- 保留的标准是“这个能力在新架构里仍然正确”，不是“这段代码已经写了”。
- 删除旧代码是正常交付的一部分，不是后续清理。

具体到本项目：

- `docs-new/06-architecture-decisions.md` 的 ADR-005（v2 一次性原生调用、不持久化 sessionRef）被本文档取代。
- `docs-new/README.md` 的“新引擎与旧 checkpoint engine 并存一段时间”被本文档取代。
- `docs-new/07-implementation-roadmap.md` 中“旧 Chat 保持 legacy 行为、逐步迁移”的双轨策略被本文档取代。
- 旧 `docs/` 只作为历史背景，不作为实现约束。

## 6. 约束

### 6.1 产品与安全

- 本地 Electron 产品，无必需服务端；Agent 执行只在 main process。
- Renderer 通过窄 preload API 访问；不得暴露可执行路径、凭据、原生 session 引用或任意文件系统能力。
- 写入必须显式授权；写入租约仍然存在。
- 用户可见文案必须支持中文和英文。
- 新增浮层支持 Escape/back 关闭；保持现有视觉语言和响应式行为。

### 6.2 运行时

- Worker 是外部原生 Agent CLI；每个 CLI 自己管理自己的 session journal 和上下文压缩。
- 平台只保存原生 session 引用、水位和必要的元数据；不能假设自己拥有 CLI 的上下文。
- 平台的增量简报必须有界；不能把无限增长的群聊直接塞进 prompt。
- 平台不承诺跨崩溃“只执行一次模型调用”；只保证已提交的账本、effects 和恢复事实一致。
- **resume 必须先证明。** Claude Code / Codex 的 resume 是否真的接着上次上下文，未验证前不能把“持久 session”当成产品承诺；Phase 2 必须有 proof。
- **`last_seq` 是投递水位，不是模型记忆保证。** CLI 自己的压缩可能丢掉已经投递的内容；重要事实必须落在 Task/Report/Artifact/文件里。
- **一次性 CLI 不支持 mid-turn steer。** 评论和 Attention 回答默认排队为 continuation run，不能假装能送入当前 run。
- **Chat 回复默认只读。** 写入只在获得用户授权和写入 scope 的 TaskRun 中发生。

### 6.3 技术栈

- main process 继续使用 CommonJS / Node（Electron 内置 Node）。
- 不引入 Bun 作为运行时依赖。
- eta 的 TypeScript/Bun 代码不能直接 import；只移植纯逻辑或按目标语义重写。
- SQLite 使用现有 `node:sqlite`（或当前已验证的运行时），保持 WAL、外键、事务和迁移。

## 7. 术语映射

| Meldwork 目标术语 | eta 对应 | 说明 |
| --- | --- | --- |
| Room | project | 工作空间、共享目录、产物账本、Provider/权限边界 |
| Chat | conversation (group) | 一次独立的团队工作记录 |
| Role / Participant | agent + participant | Chat 内的角色；绑定 Provider、Prompt、能力、权限 |
| Captain | captain / steward | Chat 内负责路由和授权的 Agent 角色 |
| Message | message | 时间线行；回复行同时是唤醒和队列 |
| Session | session | 每个 Chat × 角色一个；Task 另有自己的 session |
| Task | task | Agent 创建的工作项 |
| TaskRun | task_run | Task 的一次执行尝试；表本身是队列 |
| Report | report / finish_task | 任务结果的领域真源 |
| Attention / Inbox | attention / inbox | 需要用户处理的事项 |
| Artifact | artifact | Room 级产物版本；Task 引用 |
| Trace | session journal / activity | 只读执行轨迹；平台账本只存引用 |

## 8. 成功标准

第一阶段结束时，应能用真实 Claude Code 或 Codex 完成：

1. 用户在一个 Chat 里 @ 两个角色，两个角色各自被唤醒并在自己的 session 里回答。
2. 一个角色用 `mention` 交接给另一个角色；被交接者看到交接原文和上次之后的新消息。
3. 一个角色自己 `create_task`，在独立 task session 里执行，`finish_task` 把结果发回 Chat。
4. 用户对 Task 追加评论，Agent 在同一个 task session 里继续，而不是从零开始。
5. 应用重启后，消息、任务、报告、session 指针和未完成 run 都能恢复；不会重复建 Task。
6. 用户能在界面上看到角色、消息、任务、报告、Attention 和 Artifact，而不需要理解内部状态机。
7. 用户在一个 Chat 的 Captain Prompt 里写“效果图 → 架构 → 实施”，只 @ Captain，Captain 能按阶段发可见授权；每阶段完成后由 review supervisor 唤醒 Captain，不需要用户逐段转发。
8. Chat 回复默认只读；写入只在获得授权的 Task 中发生；隔离前同一 Room 不会有两个写入型 run 并发。

## 9. 与旧文档的关系

- `docs/`：v1 / legacy 参考，不再更新。
- `docs-new/`：v2 设计与实施记录，保留为历史；其代码实现作为“基础设施素材”参考，但其领域模型不再作为目标。
- `docs-new2/`：本目录，项目室唯一目标架构。
- `architecture.md`：保留产品边界和安全边界的总览；项目室的领域细节以本目录为准。
