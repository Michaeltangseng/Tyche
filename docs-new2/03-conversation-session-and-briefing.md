# 03 会话、简报与唤醒

本文档定义项目室的会话语义。它参考 eta 的 `conversations/engine.ts`、`routing.ts`、`briefing.ts`，但适配 Meldwork 的 Electron 边界和外部原生 Agent CLI。

## 1. 对象

```text
Room
  └─ Chat（一次团队工作记录）
       ├─ Role（Chat 内角色，绑定 Provider / Prompt / 能力 / 权限）
       ├─ Participant（Role 加入 Chat 的记录 + session 指针 + 水位）
       ├─ Message（时间线；回复行同时是唤醒和队列）
       ├─ Task（Agent 创建的工作项）
       │    └─ TaskRun（一次执行尝试）
       ├─ Report（任务结果）
       └─ Attention（需要用户处理的事项）
```

- **Room**：工作空间、共享目录、产物账本、Provider/权限边界。
- **Chat**：一次独立的团队工作记录。不同 Chat 的角色、任务、上下文互不污染。
- **Role**：Chat 内的 Agent 身份。绑定 Provider、Prompt revision、能力、原生权限模式、Skill。`is_captain` 标记主控角色。
- **Participant**：Role 在 Chat 中的参与记录。每个 Participant 对应一个持久 Session 和一个 `last_seq` 水位。
- **Message**：用户、Agent、Captain、系统的统一时间线行。
- **Session**：Agent 的持续上下文。平台只存指针和水位，正文由 Agent CLI 自己管理。

## 2. Message 时间线

### 2.1 字段语义

```text
Message
  id
  chat_id
  seq                 // Chat 内单调递增，读取顺序
  author_type         // user | agent | captain | system
  author_id           // 用户固定为本地用户；Agent 为 role_id
  kind                // message | mention | system | task_draft | task_card | report_card
  content
  mentions[]          // 解析后的 role_id
  reply_to            // 回复的用户/Agent 消息
  task_id             // 上下文关联，不等于状态变更授权
  root_message_id     // 本轮讨论根；用于 wake budget 和引用链
  status              // queued | working | waiting_for_input | done | failed | stopping | stopped
  created_at / edited_at / deleted_at
```

规则：

- 消息先写入时间线，再进入唤醒。
- `mentions` 是解析结果，不是权限。
- `task_id` 只表示上下文关联，不能凭它改 Task 状态。
- 编辑产生新事件，不覆盖历史审计；删除保留墓碑。
- 用户、Agent、Captain、系统消息使用同一个 envelope。

### 2.2 回复行就是队列

参考 eta `docs/architecture/product-model.md`：

- 一个回复行在入队时就有 `seq`，`status=queued`；
- 文本到达时 `revision` 增加，但 `seq` 不变；
- 运行中 `status=working`；等待用户输入 `waiting_for_input`；
- 结束 `done / failed / stopped`；
- 应用重启时，遗留的 `queued` 行继续排队，`working` 行标记失败（“服务重启，回复未完成”）。

**不单独建唤醒队列表。** 回复行就是唤醒；参与者 session 的串行链就是队列。

### 2.3 Message 与 Task 的关系

- `task_draft` / `task_card` 是 Task 在时间线上的投影，属于提出它的那条回复。
- `report_card` 是 Report 在时间线上的投影。
- Task 的详细状态不重复写进 Message；Message 只存 `task_id` 和展示所需的快照。
- Agent 的 `finish_task` 会在来源 Chat 追加一条 Agent 消息，内容为任务编号 + 标题 + 摘要。

## 3. Session

### 3.1 两种 Session

| 类型 | scope | key | 谁使用 |
| --- | --- | --- | --- |
| Chat Session | `chat` | `chat:<chatId>:role:<roleId>` | Chat 内的 Agent 回复、Captain 回复、mention 接收者 |
| Task Session | `task` | `task:<taskId>` | Task 的执行者；评论续跑复用 |
| Task Mention Session | `task` | `task:<taskId>:role:<roleId>` | 被用户/其他 Agent 在 Task 评论中点名的角色 |

- 一个 Chat × Role 只有一个 Chat Session，第一次被唤醒时创建，之后一直复用。
- 一个 Task 只有一个 Task Session，第一次 run 创建；评论续跑复用它；`rerun` 创建新的 generation。
- 被 mention 到 Task 上的其他角色有自己独立的 session，仍然以 Task 为 scope。

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
  last_seq            // 已经交给这个 Agent 的最后一条完成消息的 seq
  state               // active | rotated | closed
  created_at / rotated_at
```

- `native_session_ref` 是 CLI 的 session 标识，由 runtime adapter 负责 resume/adopt。
- `baseline_seq` 和 `last_seq` 是平台的水位，不依赖 CLI 的内部上下文。
- Session 正文、工具调用历史和模型上下文全部在 CLI 自己的存储里；平台不复制、不解析。

### 3.3 Session 生命周期

**创建**：Participant 第一次被唤醒，或 Task 第一次 run。

**复用**：之后每次唤醒，只要 Provider、Role Prompt revision、工作目录、权限模式没有变化，就 resume 同一个 `native_session_ref`。

**轮换**：发生以下情况时创建新 session：

- Provider 改变；
- Role 的 Prompt / Persona / Skill 绑定改变，且旧 session 无法同步；
- 工作目录改变；
- 原生 session 被 CLI 报告为不可恢复；
- 用户显式要求“重新开始”或 Task `rerun`。

轮换时：

- 旧 session `state=rotated`；
- 新 session 的 `baseline_seq` 设为 `max(0, 当前完成 seq - 最近窗口)`，让新 session 通过正常简报拿到最近上下文；
- 如果 Chat 很长，平台生成一次性的 **Session Handoff**（见 3.5），只生成一次，不参与每次唤醒。

**关闭**：Chat 归档、Role 移除、Room 删除。

### 3.4 外部 CLI 的上下文归属

- Claude Code / Codex 等 CLI 自己管理上下文压缩和 session 恢复。
- 平台只负责：
  - 保存 `native_session_ref`；
  - 维护 `baseline_seq` / `last_seq`；
  - 生成有界增量简报；
  - 在 session 不可恢复时轮换并生成一次性 handoff。
- 平台不读取 CLI 的 journal，也不尝试改写 CLI 的上下文。

### 3.5 Session Handoff（一次性）

当 session 是新建或轮换时，第一次简报除了增量行，还可以包含一段平台生成的 handoff：

```text
[Session handoff]
You are continuing work in this chat. Earlier messages are not repeated here.
Current goal: <Chat goal>
Decisions so far: <from Chat context / latest decisions>
Open tasks: <task list with status>
Recent messages: <the normal incremental briefing>
```

- Handoff 只在 session 第一次唤醒时生成一次。
- 它不是每轮总结；后续唤醒仍然只发 `last_seq` 之后的原文。
- 目标是让新 session 能接上工作，而不是把整段 Chat 重写成摘要。

## 4. 增量简报

### 4.1 规则

被唤醒的 Agent 只收到：

1. 它自己的 session 上次看到之后（`last_seq`）的消息；
2. 触发它的那条消息（即使已经被包含，也只出现一次）；
3. 与消息关联的附件路径或引用；
4. 如果 session 是新建/轮换，追加一次 Session Handoff。

简报不包含：

- Agent 自己的发言；
- 还没有写完的回复；
- 已经看过的消息；
- 其他 Chat 的消息；
- 平台内部 Trace、路径、凭据。

### 4.2 算法

参考 eta `conversations/briefing.ts`：

```text
输入：rows（last_seq 之后的所有行，按 seq 升序）、trigger、me、last_seq
输出：text、seen

seen = last_seq
blocked = false
earlier = []

for row in rows:
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

Task 评论的 `last_seq` 使用 Task 自己的活动序号（评论、Report、状态变化），不使用 Chat 的 `seq`。

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

### 5.3 Wake budget

- 一次用户消息触发的 agent-to-agent 唤醒，最多 5 次，跨所有分支计数。
- 第 5 次仍然唤醒，但附带提醒；之后 mention 只进入时间线，不唤醒任何人。
- 用户再次发言时重置计数。
- 计数依据 `root_message_id`，平台在写入 mention 时计算，不依赖模型自报。

### 5.4 串行与并行

- **同一个 participant session 串行**：一次只答一件事。
- **不同 participant session 并行**：三个角色可以同时回答。
- 队列 key 是 participant，不是 session id；session 还没创建时也能排队。
- 新消息可以 `queue`（默认）或 `steer`（并入正在进行的回复）。是否支持 steer 由 runtime adapter 声明；不支持时退回 queue。

## 6. 运行、停止与恢复

### 6.1 运行

- Engine 从 queued reply 行取任务，按 participant 串行链执行。
- 执行前：
  - 确认 Chat / Role / Participant 仍存在；
  - 确认工作目录和权限；
  - 获取 session（resume 或 create）；
  - 生成简报；
  - 写 `runFrom` 到 reply 行数据，便于前端把流式输出和 session journal 对齐。
- 执行中：
  - 流式文本写入 reply 行；
  - 工具调用产生 Trace；
  - `waiting_for_input` 时进入等待。
- 执行结束：
  - 写最终 `status`、`text`、`thinking`、`activity` 摘要；
  - 推进 `last_seq` 到 `seen`；
  - 触发 Report / Attention / Task 推导（如有）。

### 6.2 Steer

- 用户或 Agent 可以在回复运行中追加消息。
- Runtime 支持时，把新内容作为同一 turn 的下一条 user message；不支持时排队为新的 reply。
- Steer 也要生成简报（只带它没看过的内容），并更新水位。

### 6.3 停止

- `queued` reply：直接 `stopped`，不会启动。
- `working` / `waiting_for_input`：转 `stopping`，向 runtime 发 abort；最终 `stopped` 或 `failed`。
- 停止 Role：该 Role 在所有 Chat 中的活动回复都停止。
- 停止不撤销已写文件；需要补偿动作。

### 6.4 重启恢复

- 消息：`queued` 继续；`working` 标记 `failed`，文案说明重启。
- Session：文件/CLI 侧保留；平台按 `native_session_ref` 尝试 resume；不可恢复则轮换。
- TaskRun：`starting/running` 标记 `failed/interrupted`；`queued` 继续等待。
- Effects：`running` 转 `unknown`，创建 Attention；不自动重放。
- 进程：由 ProcessRegistry 对账；只有平台观察到退出才写 `session_exited`，不根据超时或用户点击猜测。

## 7. 上下文压缩

### 7.1 外部 CLI

- 压缩由 CLI 自己做（Claude Code、Codex 等）。
- 平台不注入自己的压缩器，也不读取 CLI 的 journal。
- 平台能做的是：
  - 简报有界（100 条 × 2000 字）；
  - session 轮换时生成一次性 handoff；
  - 上下文溢出时轮换 session，而不是无限重试。

### 7.2 平台自管 runtime（后续可选）

如果后续引入 Meldwork 自己的内置 runtime（而不是外部 CLI），可以移植：

- `eta/packages/eta-core/src/types/config.ts` 的默认值：`reserveTokens=16384`、`keepRecentTokens=20000`、`maxContextTokens=64000`；
- `eta/packages/eta-harness/src/estimation.ts` 的阈值和切点；
- `eta/packages/eta-compaction/src/` 的切分、丢工具噪音、折叠摘要、确定性降级。

这只对平台自管 runtime 生效；外部 CLI 仍然自己管理。

## 8. 不变量

1. 一条 reply 行只属于一个 participant session。
2. 同一 session 串行，不同 session 并行。
3. 水位只越过已经完成的、不是自己的行。
4. 未完成的行不会从简报里消失，也不会被水位跳过。
5. 简报不生成总结；总结只出现在 Session Handoff 和自管 runtime 的压缩。
6. mention 必须带正文；对方读不到尚未完成的回复。
7. wake budget 按 root user message 计数，用户再次发言才重置。
8. 平台不读取、不改写外部 CLI 的 session 正文。
9. 外部 CLI 的 session 不可恢复时，轮换并生成一次 handoff，不无限重试。
