# 错误码清单：项目室

第一版，2026-11-13。本文是项目室相关错误码的**唯一清单**。实现中需要新的错误码时，先在这里加一行（写明含义、由谁返回、界面提示），再写代码；不在清单里的错误码不得返回给 renderer。

## 1. 约定

- 形式：`Object.assign(new Error(CODE), { code: CODE })`，`CODE` 为大写下划线常量（交接手册 2.1）。
- 前缀表示产生它的层：

| 前缀 | 层 |
| --- | --- |
| `PROJECT_` | 项目室的存储、引擎与 `project:*` 接口（M1/M5、M2） |
| `SCHEDULER_` | 调度器（M4/M6 A） |
| `SHADOW_` | 影子仓库（M4/M6 B） |
| `WORKDIR_` | 工作目录浏览（M7/M8 第 8 节） |
| `TRACE_` | 完整轨迹（M7/M8 第 6 节） |
| `LOCAL_` | 现有的 Agent 调用与运行时（沿用现有前缀） |

- **界面文案**：每个会到达 renderer 的错误码，在 `frontend/src/locales/zh.js` 与 `en.js` 中有一条 `errors.<CODE>`。下表「界面提示」一栏是中文文案的依据，英文按同样的意思写。
- **附加信息**：错误对象可以带 `details`（例如被拒绝的原因、阻挡项列表），`details` 也经过投影规则（M1/M5 7.2），不含路径以外的敏感内容。
- 「只在 main 内部」的错误码不会到达 renderer，没有界面文案，只进入诊断。

## 2. `PROJECT_`：项目室

### 2.1 通用

| 错误码 | 含义 | 由谁返回 | 界面提示 |
| --- | --- | --- | --- |
| `PROJECT_INPUT_INVALID` | IPC 输入未通过模式校验（多余字段、超长文本、非法 id） | 所有 `project:*` 方法（M1/M5 8.1） | 请求格式不正确，请重试 |
| `PROJECT_NOT_FOUND` | 项目室不存在 | 所有带 `projectId` 的方法、`workdir:*` | 找不到这个项目室 |
| `PROJECT_READ_ONLY` | 项目室只读打开（状态损坏、迁移失败、高版本、一致性约束不满足），`details.reason` 写明原因 | 所有会改变状态的方法 | 这个项目室当前只读：<原因> |
| `PROJECT_ROOM_DISABLED` | 功能开关「项目室（预览）」关闭 | 除 `snapshot` 外的 `project:*` 方法（里程碑 4 任务 4.12） | 项目室功能尚未开启 |
| `PROJECT_DELETING` | 项目室正在删除，只允许 9.2 列出的方法 | 其余 `project:*` 方法（M1/M5 9.2） | 这个项目室正在删除 |
| `PROJECT_RECOVERING` | 项目正在恢复屏障中（M2 第 10 节） | 会改变状态的方法 | 正在恢复上次的状态，请稍候 |
| `PROJECT_ENGINE_UNAVAILABLE` | 引擎尚未实现（只在里程碑 4 的过渡期存在，里程碑 5 后不应再出现） | 流程类方法（里程碑 4） | 此功能尚未就绪 |

### 2.2 创建、配置与删除

| 错误码 | 含义 | 由谁返回 | 界面提示 |
| --- | --- | --- | --- |
| `PROJECT_WORKDIR_TOKEN_INVALID` | `chooseWorkdir` 的令牌不存在、已过期或已用过 | `create`（M1/M5 8.2） | 目录选择已失效，请重新选择 |
| `PROJECT_WORKDIR_TAKEN` | 所选目录与已有项目室相同或互相包含（创建时的再次判重） | `create` | 这个目录已属于另一个项目室 |
| `PROJECT_GIT_UNAVAILABLE` | 找不到 git，或版本低于 2.32，`details.version` | `create`、启动时（M4/M6 B1、B9） | 需要 git 2.32 或更高版本 |
| `PROJECT_CONFIG_STALE` | 提交的 `configRevision` 已过期 | 配置类方法（M1/M5 8.2） | 配置已被修改，已重新载入 |
| `PROJECT_CAPABILITY_UNSUPPORTED` | 席位的能力组合在这个 Agent 上表达不了，`details` 列出不支持的能力 | `updateSeat`、`addSeat`（M1/M5 8.2，R16） | <Agent> 不支持「<能力>」 |
| `PROJECT_SEAT_IN_USE` | 移除的席位仍被检查点引用，或正有调用在运行 | `removeSeat` | 这个席位正在使用，不能移除 |
| `PROJECT_MAIN_CHAT_UNDELETABLE` | 试图单独删除主流程群聊 | `deleteGroup`（里程碑 4 任务 4.1） | 主流程群聊只能随项目室一起删除 |
| `PROJECT_RESIDUAL_UNRESOLVED` | 有未处理的残留占用，不能开始删除，或不能解除目录写入保护 | `delete`、`unlockDirectory`（M1/M5 9.1、M4/M6 C 第 6 步） | 上次的 Agent 进程仍在运行，请先处理 |
| `PROJECT_UNLOCK_CONFIRMATION_MISMATCH` | 输入的文件夹名与工作目录不符 | `unlockDirectory` | 文件夹名不正确 |

### 2.3 状态与存储

| 错误码 | 含义 | 由谁返回 | 界面提示 |
| --- | --- | --- | --- |
| `PROJECT_STATE_INVALID` | 项目状态未通过模式校验 | `ProjectStore` 写入前（只在 main 内部）；加载时转为 `PROJECT_READ_ONLY` | — |
| `PROJECT_STATE_TOO_LARGE` | 压缩后仍超过常规上限 | `ProjectStore.enqueue`（M1/M5 4.6） | 项目状态过大，请压缩项目状态 |
| `PROJECT_STORAGE_FAULT` | 存储持久性不确定或写入失败，项目暂停（M1/M5 6.1、4.6） | 错误条（经投影） | 项目状态未能可靠保存，已暂停 |

### 2.4 流程与关卡

| 错误码 | 含义 | 由谁返回 | 界面提示 |
| --- | --- | --- | --- |
| `PROJECT_TARGET_CHANGED` | 插话或关卡意见的目标实例状态已变化，这类输入不再被接受（文字由界面保留） | `interject`、`stopAndDeliver`（M1/M5 8.2、M2 第 7 节） | 检查点状态已变化，你的文字已保留 |
| `PROJECT_ALREADY_STARTED` | 项目已经开始，`start` 不再有效 | `start` | 项目已经开始 |
| `PROJECT_GATE_STALE` | 关卡已决定、已刷新（修订号不符）或候选提交不符 | `decideGate` 第 3、5 步（M1/M5 第 10 节） | 关卡内容已更新，请重新查看 |
| `PROJECT_GATE_OUTCOME_UNAVAILABLE` | 这个关卡原因下该走向不可用，`details.reason` | `decideGate` 第 4 步 | 此关卡不能「<走向>」：<原因> |
| `PROJECT_GATE_COMMENT_REQUIRED` | 继续改需要意见 | `decideGate` 第 6 步 | 请写下意见 |
| `PROJECT_IMPACT_CHANGED` | 打回或重新打开的影响范围在预览后变化 | `decideGate` 第 7 步、`reopen` | 影响范围已变化，请重新查看 |
| `PROJECT_ACCEPT_BLOCKED` | 上游有待确认的新版本、未解决漂移，或项目文档变更检测屏障未解除，`details.blockers` | `decideGate` 第 8 步及引擎接受转移 | 上游有待处理的变化，或正在等待文档变更检测，处理完成后才能接受 |
| `PROJECT_CANDIDATE_DIVERGED` | 工作目录与候选提交不同，需要人选择「接受送审版本」或「重新送审」，`details.files` | `decideGate` 第 8 步 | 送审之后文件有变化，请选择 |
| `PROJECT_NOT_REOPENABLE` | 只有已接受的检查点可以重新打开 | `reopen` | 这个检查点不能重新打开 |
| `PROJECT_DRIFT_STALE` | 漂移条目的修订号不符、状态不允许处理、或处理的前提不满足（M2 8.2） | `resolveDrift`、`cancelDriftResolution` | 内容已变化，请重新查看 |
| `PROJECT_EFFECT_NOT_FOUND` | 要重试的副作用不存在，或不处于失败状态 | `retryEffect` | 没有需要重试的步骤 |
| `PROJECT_AUTO_TEAMING_UNAVAILABLE` | 自动组队未实现（R18 占位） | 组队接口（里程碑 8 任务 8.6） | 自动组队尚未提供 |

## 3. `SCHEDULER_`、`SHADOW_`：只在 main 内部

| 错误码 | 含义 | 由谁返回 | 到达界面时的形式 |
| --- | --- | --- | --- |
| `SCHEDULER_CLAIM_OUTSIDE_ROOT` | 路径声明解析到工作目录之外 | `path-claims.cjs`（M4/M6 A2.2） | 作为调用失败或副作用失败进入诊断 |
| `SHADOW_TARGET_TOO_LARGE` | 目标文件或回应文件超过单文件上限，`details.file` | `snapshot`（M4/M6 B3.5） | 错误条：「<文件> 超过大小上限，无法生成送审快照」 |
| `SHADOW_SNAPSHOT_LIMIT` | 非可选快照超过用时或文件数上限 | `snapshot`、`verifyAgainst`（M4/M6 B3.4） | 错误条：「工作目录太大，无法<这一步>」 |
| `SHADOW_PLACEHOLDER_NOT_RESTORABLE` | 试图恢复占位文件 | `restoreFiles`（M4/M6 B5） | 界面在此之前已把「恢复」置灰，不应出现 |

影子仓库中 git 命令的其他失败以必要副作用失败处理（M2 9.2），错误条显示「<步骤>失败」与诊断入口，不另设错误码。

## 4. `WORKDIR_`、`TRACE_`

| 错误码 | 含义 | 由谁返回 | 界面提示 |
| --- | --- | --- | --- |
| `WORKDIR_PATH_REJECTED` | 路径未通过校验（规范化、范围、`.git` 边界、符号链接、竞争检查），不说明具体原因 | `workdir:*`（M7/M8 8.2） | 无法打开这个路径 |
| `WORKDIR_NOT_FOUND` | 路径不存在（只用于 `read`、`list`；`diff` 允许不存在） | `workdir:read`、`workdir:list` | 文件不存在 |
| `TRACE_NOT_FOUND` | 运行不存在或不属于任何群聊 | `trace:*`（M7/M8 6.1） | 找不到这次运行的轨迹 |
| `TRACE_CURSOR_INVALID` | 分页游标被伪造、篡改或已失效 | `trace:page` | 轨迹已更新，已重新载入 |

## 5. `LOCAL_`：Agent 调用

新增：

| 错误码 | 含义 | 由谁返回 | 界面提示 |
| --- | --- | --- | --- |
| `LOCAL_WORKDIR_UNRESOLVED` | 可能写入的调用无法解析工作目录的真实路径，拒绝启动 | 调用入口（M4/M6 A2.3、里程碑 2 任务 2.4） | 无法确认工作目录，未开始写入 |
| `LOCAL_AGENT_SUPERVISOR_LOST` | 监护程序意外退出，Agent 的结果未知 | 受管理启动器（M3 3.4） | Agent 进程意外结束，结果未知 |
| `LOCAL_AGENT_EXIT_UNKNOWN` | Agent 已退出，但退出报告没能送达 | 受管理启动器（M3 3.4） | Agent 已结束，但无法确认它的退出结果 |
| `LOCAL_DISCUSSION_STYLE_UNAVAILABLE_IN_PROJECT` | 项目内群聊不提供自动讨论（`discussionStyle: 'agent-led'`） | 消息提交的 `validateInput`（M11 3.1） | 项目内不提供自动讨论，请改用顺序讨论 |
| `LOCAL_MANAGED_PROCESS_UNAVAILABLE` | 原生监护程序不存在或不可执行（构建缺失、打包遗漏），可能写入的调用拒绝启动 | 受管理启动器（M3 3.2） | 写入保护组件缺失，未开始写入；请重新安装 |
| `LOCAL_MANAGED_PROCESS_UNSUPPORTED` | 当前平台上受管理进程尚未实现（Windows），用于能力提示 | 能力登记（M3 第 10 节） | 当前系统上尚不支持这项保护 |

沿用现有：`LOCAL_AGENT_TERMINATION_FAILED`、`LOCAL_AGENT_SPAWN_FAILED`、`LOCAL_AGENT_EXECUTION_STOPPED`、`LOCAL_RUN_ISOLATED_CONTEXT_INVALID` 等，含义不变。

## 6. 不是错误码的标识

以下名字在文档中以大写下划线形式出现，但它们是事件、常量或状态，不作为错误返回：

| 名字 | 是什么 |
| --- | --- |
| `LEASE_GRANTED` | 调度器授予事件（M2 5.4） |
| `LEASE_NOT_HELD` | 受租约保护的副作用发现租约不在时上报的**失败原因**，以必要副作用失败处理（M2 5.4、9.2），错误条显示「写入权已失效，将重新申请」 |
| `PROJECT_STATE_SCHEMA_VERSION` | 项目状态的模式版本常量 |
| `INVOCATION_ENDED`、`GATE_DECIDED`、`DRAIN_CHECK`、`EFFECT_FAILED` 等 | M2 与 M1/M5 中的事件名 |
