# 03 会话、简报与唤醒

本文档定义项目室的会话语义。它参考 eta 的 `conversations/engine.ts`、`routing.ts`、`briefing.ts` 和 `captain/supervisor.ts`，但适配 Meldwork 的 Electron 边界和外部原生 Agent CLI。

## 1. 对象

```text
Room
  └─ Chat（一次团队工作记录）
       ├─ Role（Chat 内角色，绑定 Provider / Prompt / 能力 / 权限）
       ├─ Participant（Role 加入 Chat 的记录 + session 指针 + last_seq）
       ├─ Message（时间线；回复行同时是唤醒和队列）
       ├─ Task（Agent 创建的工作项）
       │    ├─ TaskActivity（Task 自己的评论/报告/状态时间线）
       │    ├─ TaskLane（执行者 lane / 每个被 mention 角色的 lane）
       │    └─ TaskRun（一次执行尝试）
       ├─ Report（任务结果）
       ├─ CaptainAssignment（可见授权消息的台账）
       ├─ CaptainReview（Captain 的 review 队列）
       └─ Attention（需要用户处理的事项）
```

- **Room**：工作空间、共享目录、产物账本、Provider/权限边界。
- **Chat**：一次独立的团队工作记录。不同 Chat 的角色、任务、上下文互不污染。
- **Role**：Chat 内的 Agent 身份。绑定 Provider、Prompt revision、能力、原生权限模式、Skill。`is_captain` 标记主控角色。
- **Participant**：Role 在 Chat 中的参与记录。每个 Participant 对应一个持久 Session 和一个权威 `last_seq` 水位。
- **Message**：用户、Agent、系统的统一时间线行。
- **Session**：Agent 的持续上下文。平台只存指针和 baseline；正文由 Agent CLI 自己管理。

## 2. Message 时间线

### 2.1 字段语义

```text
Message
  id
  chat_id
  seq                 // Chat 内单调递增，读取顺序
  revision            // 流式输出版本；seq 不变
  client_id           // 发送幂等键；同一 clientId 重试不重复
  author_type         // user | agent | system
  author_id           // 用户固定为本地用户；Agent 为 role_id
  kind                // message | mention | system | task_draft | task_card |
                      // report_card | captain_review
  content
  mentions[]          // 解析后的 role_id
  reply_to            // 回复的用户/Agent 消息
  task_id             // 上下文关联，不等于状态变更授权
  root_message_id     // 本轮讨论根；用于 wake budget 和引用链
  status              // queued | working | waiting_for_input | stopping |
                      // done | failed | stopped | interrupted
  audience            // chat | captain；默认 chat
  data_json           // 附件、blocks、runFrom、review ids 等展示数据
  created_at / edited_at / deleted_at
```

规则：

- 消息先写入时间线，再进入唤醒。
- `mentions` 是解析结果，不是权限。
- `task_id` 只表示上下文关联，不能凭它改 Task 状态。
- 编辑产生新事件，不覆盖历史审计；删除保留墓碑。
- 用户、Agent、系统消息使用同一个 envelope；Captain 的 `author_type` 是 `agent`，用 `is_captain` 标识，不设特殊 author type。
- `system` / `captain_review` 消息可以用 `audience = "captain"`；只进入 Captain 的简报，不进入其他参与者简报，也不计入 `chat.activity_seq`。
- Captain 对 review 的回复也标 `audience = "captain"`（`data_json.reviewReply = true`），同样不计入 activity。
- `assign_in_group` / `post_in_chat` 是 public（`audience = "chat"`），计入 `activity_seq`。
- 追加消息时 `chat.last_seq` 总是前进；只有 public 消息（`audience = "chat"` 且不是 review reply）推进 `chat.activity_seq`。

### 2.2 回复行就是队列

参考 eta `docs/architecture/product-model.md`：

- 一个回复行在入队时就有 `seq`，`status=queued`；
- 文本到达时 `revision` 增加，但 `seq` 不变；
- 运行中 `status=working`；等待用户输入 `waiting_for_input`；
- 结束 `done / failed / stopped / interrupted`；
- 应用重启时，遗留的 `queued` 行继续排队；`working` / `waiting_for_input` 行标记 `interrupted`，等待进程对账，不直接标记 failed（见 6.4）。
- 这是**有意偏离 eta**：eta 的 `failInterrupted` 会把 queued/working 都标失败；Meldwork 让 queued 继续，因为 effect pump 可以在恢复后重新调度。working 不直接 failed，而是 interrupted/unknown，避免在没观察进程退出时伪造失败。

**不单独建唤醒队列表。** 回复行就是唤醒；参与者 session 的串行链就是队列。

### 2.3 Message 与 Task 的关系

- `task_draft` / `task_card` 是 Task 在时间线上的投影，属于提出它的那条回复。
- `report_card` 是 Report 在时间线上的投影。
- Task 的详细状态不重复写进 Message；Message 只存 `task_id` 和展示所需的快照。
- Agent 的 `finish_task` 会在来源 Chat 追加一条 Agent 消息，内容为任务编号 + 标题 + 摘要；这会推进 `chat.activity_seq`，也是 Captain review 看到新活动的来源。
- `captain_review` 是系统 review 行，`audience=captain`；它进入 Captain 的 session，不进入其他参与者简报，也不计入 `chat.activity_seq`。

## 3. Session

### 3.1 三种 Session 作用域

| 类型 | scope | key | 谁使用 |
| --- | --- | --- | --- |
| Chat Session | `chat` | `chat:<chatId>:role:<roleId>` | Chat 内的 Agent 回复、Captain 回复、mention 接收者 |
| Task Executor Session | `task` | `task:<taskId>:role:<executorRoleId>` | Task 的执行者 lane；跨 run 复用 |
| Task Mention Session | `task` | `task:<taskId>:role:<mentionedRoleId>` | 被用户/其他 Agent 在 Task 评论中点名的角色 |

- 一个 Chat × Role 只有一个 Chat Session，第一次被唤醒时创建，之后一直复用。
- 一个 Task 每个 lane（执行者或 mention 角色）各有一个 session；执行者 lane 跨 run 复用；`rerun` 创建新的 generation。
- **不要用 `task:<taskId>` 作为唯一 key**：handoff 到另一个角色时会复用前一个执行者的记忆。Task key 必须带 role。

### 3.2 Session 记录

```text
Session
  id
  scope_type          // chat | task
  scope_id            // chatId 或 taskId
  role_id
  provider            // claude / codex / ...
  native_session_ref  // CLI 自己的 session id / resume token
  baseline_seq        // 这个 session 开始观看的 seq（创建/轮换时设定）
  prompt_revision     // 创建时使用的 Role Prompt revision
  permission_mode     // read-only / read-exec / workspace-write
  workspace_ref       // 创建时的工作目录 realpath
  skill_bindings_json // 创建时的 Skill 绑定快照
  model / thinking_level
  state               // active | rotated | closed
  created_at / rotated_at
```

- `native_session_ref` 是 CLI 的 session 标识，由 runtime adapter 负责 resume/adopt。
- `baseline_seq` 是平台记录的这个 session 从哪条消息开始；**没有 `last_seq`**。
- `last_seq` 属于 Participant / TaskLane：`chat_participants.last_seq`、`task_lanes.last_seq`。
- Session 正文、工具调用历史和模型上下文全部在 CLI 自己的存储里；平台不复制、不解析。

### 3.3 Session 生命周期

**创建**：Participant 第一次被唤醒，或 Task lane 第一次 run。

**复用**：之后每次唤醒，必须同时满足以下条件才 resume 同一个 `native_session_ref`：

- Provider 未变；
- Role Prompt revision 未变；
- `permission_mode` 未变；
- 工作目录 realpath 未变；
- Skill 绑定快照未变；
- 模型 / thinking level 未变；
- CLI 没有报告 native session 不可恢复。

**轮换**：任一条件变化，或原生 session 不可恢复，创建新 session。

轮换时：

- 旧 session `state=rotated`；
- 新 session 的 `baseline_seq` 设为当前 Participant/Lane 的 `last_seq`（或最近窗口的起点）；
- `last_seq` 留在 Participant/Lane，不随 session 重置；
- 生成一次性的 **Session Handoff**（见 3.5），只生成一次，不参与每次唤醒。

**关闭**：Chat 归档、Role 移除、Room 删除。

### 3.4 外部 CLI 的上下文归属

- Claude Code / Codex 等 CLI 自己管理上下文压缩和 session 恢复。
- 平台只负责：
  - 保存 `native_session_ref`；
  - 维护 Participant/Lane 的 `last_seq`；
  - 生成有界增量简报；
  - 在 session 不可恢复或轮换时生成一次性 handoff。
- 平台不读取 CLI 的 journal，也不尝试改写 CLI 的上下文。
- **`last_seq` 是投递水位，不是“模型还记得”的保证。** CLI 自己的压缩可能丢掉平台已经投递过的内容；平台无法可靠观测这一点。缓解方式：
  - 简报有界；
  - session 轮换时重新 handoff；
  - Task/Artifact 作为可重新读取的事实来源；
  - 不承诺“模型看到了全部历史”。

### 3.5 Session Handoff（一次性）

当 session 是新建或轮换时，第一次简报除了增量行，还可以包含一段平台生成的 handoff：

```text
[Session handoff]
You are continuing work in this chat. Earlier messages are not repeated here.
Current goal: <current chat context revision / goal>
Decisions so far: <current chat context revision>
Open tasks: <task list with status>
Recent messages: <the normal incremental briefing>
```

- Handoff 只在 session 第一次唤醒时生成一次。
- 它不是每轮总结；后续唤醒仍然只发 `last_seq` 之后的原文。
- 目标是让新 session 能接上工作，而不是把整段 Chat 重写成摘要。
- Captain 的 handoff 可以额外包含当前 Captain prompt revision 和工作流约定。

## 4. 增量简报

### 4.1 规则

被唤醒的 Agent 只收到：

1. 它自己的 Participant/Lane 上次看到之后（`last_seq`）的消息；
2. 触发它的那条消息（即使已经被包含，也只出现一次）；
3. 与消息关联的附件路径或引用；
4. 如果 session 是新建/轮换，追加一次 Session Handoff；
5. 如果触发是 Captain review，附带 review 的观察数据（assignment/task id、checkpoint、目标状态）和当前 Captain prompt revision；上一环的完整发言仍由上面的增量行给出，review 不重复全文。

简报不包含：

- Agent 自己的发言；
- 还没有写完的回复；
- 已经看过的消息；
- 其他 Chat 的消息；
- `audience=captain` 但接收者不是 Captain 的 system 消息；
- 平台内部 Trace、路径、凭据。

### 4.2 算法

参考 eta `conversations/briefing.ts`：

```text
输入：rows（last_seq 之后的所有行，按 seq 升序）、trigger、me、last_seq、viewerIsCaptain
输出：text、seen

seen = last_seq
blocked = false
earlier = []

for row in rows:
  audience = row.audience ?? 'chat'  // 'chat' | 'captain'
  if audience == 'captain' and not viewerIsCaptain:
    continue
  mine = row.author_type == 'agent' and row.author_id == me
  if row.id == trigger.id or mine:
    if not blocked: seen = max(seen, row.seq)
    continue
  if row.status in {queued, working, waiting_for_input, stopping}:
    blocked = true
    continue
  if not blocked: seen = max(seen, row.seq)
  if row.text 为空且没有附件: continue
  earlier.append("- <author>: <text>" + attachments)

if earlier.length > 100:
  earlier = earlier[-100:]       // 保留最新 100 条
  加一行 "(omitted N earlier messages)"

text = "[chat: <title>]" +
       "Since you last looked:" + earlier +
       "---" +
       "<trigger author> says:" + trigger.text + trigger.attachments

return { text, seen }
```

关键点：

- **未完成的行会阻塞水位**：如果一条回复还在写，水位不能越过它；它后面的已完成消息会先展示，但下次还会再展示，直到它完成。
- **自己的发言不重复**：即使水位没推进，也不会把自己的话再发给自己。
- **最多 100 条、每条最多 2000 字**：超出部分保留最新，旧消息省略并标注。
- **不生成总结**：简报是原文摘录；总结只发生在 Session Handoff 和平台自管运行时的压缩。

### 4.3 附件

- 附件引用随消息一起进入简报。
- 本地 session 给绝对路径；远端 session 给该机器上的副本路径。Meldwork 第一阶段只支持本地 CLI，因此直接给本地路径。
- 图片是否作为模型输入，由 runtime adapter 根据该 CLI/模型能力决定。

### 4.4 Task 的简报

Task Session 不看 Chat 时间线。它的上下文来源是 Task 本身：

- **首次 run**：任务标题、描述、验收标准、来源 Chat、工作目录、如何报告、不要擅自合并主分支。
- **评论续跑**：不重新发任务简报；只告诉它任务当前状态和“下面的评论是针对你的”，因为它已经在同一个 session 里做过上面的工作。
- **rerun**：新 session，重新发首次 run 的简报。
- **handoff 到另一个角色**：新 lane / 新 session，发 task handoff：任务描述、上一次 Report、Artifact 引用；不继承前一个执行者的 session 记忆。

Task 评论的 `last_seq` 使用 Task 自己的活动序号（`task_activities.seq`），不使用 Chat 的 `seq`。

## 5. 唤醒规则

### 5.1 用户消息

参考 eta `conversations/routing.ts`：

```text
named = mentions ∩ chat participants
if named 非空:
    唤醒 named
else if Chat 是 direct:
    唤醒唯一角色
else if 有 Captain:
    唤醒 Captain（如果它还不是 participant，先加入）
else if 只有一个 participant:
    唤醒它
else:
    不唤醒任何人，告诉用户“没有点名，且没有默认接收者”
```

- 用户消息里的每个 @ 都唤醒对应角色；多个 @ 并发，不是串行。
- 没有 @ 时不猜测；Captain 是默认接收者。
- Captain 不是平台调度器；它只是被唤醒后决定是否发可见的工作授权。
- **平台不做隐式串行**：调用方继续往下说，不等待被唤醒者。

### 5.2 Agent mention

Agent 在回复中调用 `mention` 工具：

```json
{
  "names": ["reviewer"],
  "text": "请评审这个笑话的幽默程度，1-10 分。笑话原文：..."
}
```

平台行为：

1. 解析名字/ID，只允许当前 Chat 的 participants；未知名字回给调用者；自己不能被自己唤醒。
2. 追加一条 `kind=mention` 的消息，`root_message_id` 继承当前回复的 root。
3. 为每个目标创建 reply 行（`queued`）。
4. 消耗一次 wake budget。
5. 发起者不等待；它继续完成当前回复。

**`assign_in_group` 不是两行。** eta 的 `captain/service.ts:322` 只调用一次 `engine.send`，写一条带 @ 的可见消息；这条消息就是 assignment。你看到的“回复一行 + mention 一行”是 `mention` 工具在回复还没写完时另记的一行。两者不要混淆。

### 5.3 Wake budget

- 一次用户消息触发的 **`mention` 工具**唤醒，最多 5 次，跨所有分支计数。
- 第 5 次仍然唤醒，但附带提醒；之后 mention 只进入时间线，不唤醒任何人。
- 用户再次发言时重置计数。
- 计数依据 `root_message_id`，平台在写入 mention 时计算，不依赖模型自报。
- 5 次只统计 Agent 通过 `mention` 工具写出的 `kind=mention` 行（eta `timeline.ts:450-457`）。
- Captain 的 `assign_in_group` 是普通消息 + @，不写 `kind=mention`，所以不占这 5 次。
- Captain review 是 system 消息，也不占这 5 次。
- 因此 `assign_in_group` 串阶段不受 5 次限制；5 次只约束 Agent 在回复里主动调用的 `mention`。

### 5.4 串行与并行

- **同一个 participant session 串行**：一次只答一件事。
- **不同 participant session 并行**：三个角色可以同时回答。
- 队列 key 是 participant/lane，不是 session id；session 还没创建时也能排队。
- 新消息可以 `queue`（默认）或 `steer`（并入正在进行的回复）。是否支持 steer 由 runtime adapter 声明；不支持时退回 queue（外部 CLI 默认不支持）。

## 6. 运行、停止与恢复

### 6.1 运行

- Engine 从 queued reply 行取任务，按 participant 串行链执行。
- 执行前：
  - 确认 Chat / Role / Participant 仍存在；
  - 确认工作目录和权限；
  - 获取 session（resume 或 create）；
  - 生成简报；
  - 写 `start_reply` effect；由 effect pump 启动进程。
- 执行中：
  - 流式文本写入 reply 行，`revision` 增加；
  - 工具调用产生 Trace；
  - `waiting_for_input` 时进入等待（仅 runtime 支持时）。
- 执行结束：
  - 写最终 `status`、`text`、`thinking`、`activity` 摘要；
  - 推进 Participant 的 `last_seq` 到 `seen`；
  - 触发 Report / Attention / Task 推导（如有）。

**所有进程启动都走 effect**，包括聊天回复。Engine 不直接 `invokeAgent`。

### 6.2 Steer

- 用户或 Agent 可以在回复运行中追加消息。
- Runtime 支持时，把新内容作为同一 turn 的下一条 user message；不支持时排队为新的 reply。
- 外部 Claude Code / Codex 默认是一次性调用，**不支持 mid-turn steer**；评论和 Attention 回答应排队为 continuation run，而不是假装能送入当前 run。
- Steer 也要生成简报（只带它没看过的内容），并更新水位。

### 6.3 停止

- `queued` reply：直接 `stopped`，不会启动。
- `working` / `waiting_for_input`：转 `stopping`，向 runtime 发 abort；最终 `stopped` 或 `interrupted`。
- 停止 Role：只停止该 Role 在**当前 Chat** 的活动回复；Role 是 Chat 级的，不跨 Chat。
- 停止不撤销已写文件；需要补偿动作。
- Task 停止：Task 标记 `cancelled`（用户意图），运行中的 TaskRun 只有确认退出后才 `cancelled`；无法确认时 `interrupted/unknown` + Attention。

### 6.4 重启恢复

- 消息：
  - `queued` 继续；由 effect pump 在启动恢复后重新调度。
  - `working` / `waiting_for_input` 标记 `interrupted`，不直接标记 `failed`；创建 Attention（如果该 run 可写或可能产生副作用）。
  - 已经提交的最终 Report 保留；可以按 Report 推导 Task 状态。
- Session：CLI 侧保留；平台按 `native_session_ref` 尝试 resume；不可恢复则轮换 + handoff。
- TaskRun：
  - `starting/running` 标记 `interrupted/unknown`；
  - `queued` 继续等待；
  - 在进程对账确认退出之前，不允许为该 lane 启动新的 run。
- Effects：`running` 转 `unknown`，创建 Attention；不自动重放。
- 进程：由 ProcessRegistry 对账；只有平台观察到退出才写 `session_exited`，不根据超时或用户点击猜测。
- **不要**在重启时把所有 `working` 行直接标 failed；这违反“只相信观察到的退出”。

## 7. 上下文压缩

### 7.1 外部 CLI

- 压缩由 CLI 自己做（Claude Code、Codex 等）。
- 平台不注入自己的压缩器，也不读取 CLI 的 journal。
- 平台能做的是：
  - 简报有界（100 条 × 2000 字）；
  - session 轮换时生成一次性 handoff；
  - 上下文溢出时轮换 session，而不是无限重试。
- **平台无法知道 CLI 压缩后模型还保留了什么**；`last_seq` 只保证不重复投递。重要事实应该落在 Task、Report、Artifact 或文件里，方便 Agent 重新读取。

### 7.2 平台自管 runtime（后续可选）

如果后续引入 Meldwork 自己的内置 runtime（而不是外部 CLI），可以移植：

- `eta/packages/eta-core/src/types/config.ts` 的默认值：`reserveTokens=16384`、`keepRecentTokens=20000`、`maxContextTokens=64000`；
- `eta/packages/eta-harness/src/estimation.ts` 的阈值和切点；
- `eta/packages/eta-compaction/src/` 的切分、丢工具噪音、折叠摘要、确定性降级。

这只对平台自管 runtime 生效；外部 CLI 仍然自己管理。

## 8. Captain review（不是 completion wake）

eta 没有“每个 Task 完成就单独唤醒 Captain”的机制。它用 **Captain review supervisor**：

- `captain/supervisor.ts` 每 60 秒 tick 是兜底；领域变化（task board/report/run）会触发 `requestTick()` 的 150ms debounce，通常很快唤醒 Captain，不需要等一分钟。
- `captain/service.ts` 的 `observeReviews()` 检查已结算的 Captain assignment：
  - 目标成员没有 queued/working/stopping；waiting_for_input 归入 blocked 条件；
  - 关联 Task 不能还是 todo/in_progress，也不能还有未结束的 run；
  - `chat.activity_seq` 是否超过上次 checkpoint（有新活动）；
  - 是否 blocked / stalled。
- **没有 Task 也会 review**：目标角色回复结束并空闲、且 Chat 有 public 新活动，就生成 `assignment_settled`，不要求它建 Task。挡住的是还在 queued/working/stopping 的回复，以及关联 Task 仍 todo/in_progress 或还有未结束 run。
- **review 流量不能推进 activity 水位**：`chat.activity_seq` 只统计 public 消息，排除 `audience=captain` 的 review 行和 Captain 为 review 写的回复（`data_json.reviewReply=true`）。否则 review 自己会推进水位，下一轮 tick 又看到“新活动”，形成循环。`assign_in_group` / `post_in_chat` 是 public，计入 `activity_seq`。
- `chat.activity_seq` 只供 supervisor 判断 public 活动；Captain 的 `chat_participants.last_seq` 仍是它的投递水位。review 行不推进 `activity_seq`，但会进入 Captain 的简报。
- `stalled` 判断的 `silentFor` 也只看最新 public 消息的更新时间；review 行和 Captain review 回复不算。
- 满足条件时创建 `captain_review`；checkpoint 用 `activity_seq`，dedupe key 用 conversation + kind + checkpoint，不会对同一段活动反复唤醒。
- 只在 Captain 空闲时批量投递（最多 20 条 / 12k 字符）。
- review 以 `system` 消息进入 Captain 的会话，并创建 queued reply；`mentions: []`，不占 5 次 agent-to-agent 预算。
- review 正文是**观察**：assignment/task id、checkpoint、目标状态；不是上一环全文。Captain 通过正常增量简报读取水位之后、别人已经写完的 public 原文，再按 Prompt 决定下一步。

**触发来源**：`finish_task` 在来源 Chat 追加 Agent 消息，推进 `activity_seq`；目标空闲后 supervisor 生成 review。不是每个 `finish_task` 立刻唤醒，也不是每个聊天回复都唤醒。

**Captain 仍然不建 Task**：review 只是让它看到“上一环结算了”；它按自己的 Prompt 发可见授权，目标 Agent 自己 `create_task`。

**工作流 Prompt**：每个 Chat 一份 Captain Prompt（role_prompt_revisions）。review 消息附带当前 Prompt revision，确保换 Chat / 改 Prompt 在下一轮生效。平台不解析 Prompt，不做状态机。

### 8.1 三阶段工作流示例

Chat-1 的 Captain Prompt：

```text
阶段按顺序只有三个：效果图、架构、实施。
一次只派当前未完成的阶段，只叫醒一个角色。不要提前派后面的阶段。
被唤醒后，根据时间线上已完成的结果决定下一步。
```

流程：

1. 用户只 @ Captain（或不 @，Captain 是默认接收者）。
2. Captain `assign_in_group` 效果图 → 效果图角色被唤醒，自己 `create_task`。
3. 效果图 `finish_task` → 来源 Chat 追加 Agent 消息 → `activity_seq` 前进。
4. supervisor review → `captain_review` → system 消息唤醒 Captain；Captain 的简报包含效果图的完整发言。
5. Captain 按 Prompt 派架构 → 同理派实施。
6. 实施完成 → Captain review → Captain 看到全部完成，发总结，不再派任务。

预算：`assign_in_group` 是普通消息 + @，不写 `kind=mention`，**不占 5 次**；Captain review 是 system 消息，也不占。5 次只统计 Agent 通过 `mention` 工具写出的 `kind=mention` 行（eta `timeline.ts:450-457`）。所以三阶段 workflow 不受这个预算限制；平台仍校验并发、成本和写入边界。

Chat-2 去掉效果图 Prompt 即可，流程自动变成两阶段。平台不需要知道“少了一阶段”。

## 9. 不变量

1. 一条 reply 行只属于一个 participant/lane。
2. 同一 participant/lane 串行，不同 participant/lane 并行。
3. 水位只越过已经完成的、不是自己的行；水位属于 participant/lane，不属于 session。
4. 未完成的行不会从简报里消失，也不会被水位跳过。
5. 简报不生成总结；总结只出现在 Session Handoff 和自管 runtime 的压缩。
6. `mention` 必须带正文；对方读不到尚未完成的回复。
7. wake budget 只统计 Agent 的 `kind=mention` 行，按 root user message 计数；`assign_in_group` 和 Captain review 都不占这个预算。
8. 平台不读取、不改写外部 CLI 的 session 正文。
9. 外部 CLI 的 session 不可恢复时，轮换并生成一次 handoff，不无限重试。
10. 平台不做隐式串行；串行来自每一环的 `mention` 或 Captain review。
11. Captain review 由 supervisor 检查“已结算 assignment”，不是每个 Task 完成一个独立 wake。
12. 所有进程启动（聊天回复和 TaskRun）先写 effect。
