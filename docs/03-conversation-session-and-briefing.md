# 03 Session, briefing, and wake-up

This document defines session semantics for a project Room. It references eta's `conversations/engine.ts`, `routing.ts`, `briefing.ts`, and `captain/supervisor.ts`, but adapts them to Tyche's Electron boundary and to external native Agent CLIs.

## 1. Objects

```text
Room
  └─ Chat (one team work record)
       ├─ Role (a role inside the Chat, bound to Provider / Prompt / capabilities / permissions)
       ├─ Participant (record of a Role joining the Chat + session pointer + last_seq)
       ├─ Message (timeline; a reply row is both the wake-up and the queue)
       ├─ Task (a work item created by an Agent)
       │    ├─ TaskActivity (the Task's own comment / report / status timeline)
       │    ├─ TaskLane (executor lane / one lane per mentioned role)
       │    └─ TaskRun (one execution attempt)
       ├─ Report (task result)
       ├─ CaptainAssignment (ledger of visible authorization messages)
       ├─ CaptainReview (the Captain's review queue)
       └─ Attention (something the user has to handle)
```

- **Room**: workspace, shared directory, artifact ledger, and the Provider and permission boundary.
- **Chat**: one independent team work record. Roles, tasks, and context of different Chats do not contaminate each other.
- **Role**: the Agent identity inside a Chat. It binds a Provider, a Prompt revision, capabilities, a native permission mode, and Skills. `is_captain` marks the coordinating role.
- **Participant**: the record of a Role taking part in a Chat. Each Participant has one persistent Session and one authoritative `last_seq` watermark.
- **Message**: the unified timeline row for the user, an Agent, and the system.
- **Session**: an Agent's continuing context. The platform stores only the pointer and the baseline. The body is managed by the Agent CLI itself.

## 2. The Message timeline

### 2.1 Field semantics

```text
Message
  id
  chat_id
  seq                 // monotonically increasing within the Chat; read order
  revision            // streaming output version; seq does not change
  client_id           // send idempotency key; a retry of the same clientId is not duplicated
  author_type         // user | agent | system
  author_id           // the user is fixed as the local user; an Agent is role_id
  kind                // message | mention | system | task_draft | task_card |
                      // report_card | captain_review
  content
  mentions[]          // parsed role_id
  reply_to            // the user or Agent message being replied to
  task_id             // a contextual link; not authorization to change status
  root_message_id     // root of this round of discussion; used for wake budget and the reference chain
  status              // queued | working | waiting_for_input | stopping |
                      // done | failed | stopped | interrupted
  audience            // chat | captain; default chat
  data_json           // display data such as attachments, blocks, runFrom, and review ids
  created_at / edited_at / deleted_at
```

Rules:

- A message is written to the timeline first, then it enters wake-up.
- `mentions` is a parse result, not a permission.
- `task_id` only means a contextual link. It is not authority to change Task status.
- An edit produces a new event and does not overwrite the audit history. Deletion keeps a tombstone.
- User, Agent, and system messages use the same envelope. A Captain's `author_type` is `agent`, identified by `is_captain`. There is no special author type.
- A `system` or `captain_review` message may use `audience = "captain"`. It enters only the Captain's briefing. It does not enter other participants' briefings, and it does not count toward `chat.activity_seq`.
- **Only the reply the platform creates to deliver this review** is marked `audience = "captain"` + `data_json.reviewReply = true`, and it does not count toward activity. The Captain's other replies do not inherit this mark automatically.
- `assign_in_group` and `post_in_chat` are public (`audience = "chat"`) and count toward `activity_seq`.
- Appending a message always advances `chat.last_seq`. Only a public message (`audience = "chat"` and not a review reply) advances `chat.activity_seq`.

### 2.2 The reply row is the queue

Following eta `docs/architecture/product-model.md`:

- A reply row already has a `seq` when it is enqueued, with `status=queued`.
- When text arrives, `revision` increases and `seq` does not change.
- While running, `status=working`. Waiting for user input is `waiting_for_input`.
- The end states are `done / failed / stopped / interrupted`.
- On application restart, leftover `queued` rows keep their place in the queue. `working` / `waiting_for_input` rows are marked `interrupted` and wait for process reconciliation. They are not marked failed directly (see 6.4).
- This is an **intentional departure from eta**: eta's `failInterrupted` marks both queued and working as failed. Tyche lets queued continue, because the effect pump can schedule it again after recovery. working is not failed directly. It becomes interrupted/unknown, so a failure is not fabricated when process exit has not been observed.

**Do not build a separate wake-up queue table.** The reply row is the wake-up. The participant session's serial chain is the queue.

### 2.3 How Message and Task relate

- `task_draft` / `task_card` are the Task's projection on the timeline. They belong to the reply that proposed the Task.
- `report_card` is the Report's projection on the timeline.
- A Task's detailed status is not written into the Message again. The Message stores only `task_id` and the snapshot needed for display.
- An Agent's `finish_task` appends an Agent message to the source Chat. The content is the task number + title + summary. This advances `chat.activity_seq`, and it is what lets Captain review see new activity after settlement. Before settlement the Task is still `in_progress`, and review is blocked by task busy.
- `captain_review` is a system review row, with `audience=captain`. It enters the Captain's session. It does not enter other participants' briefings, and it does not count toward `chat.activity_seq`.

## 3. Session

### 3.1 Three Session scopes

| Type | scope | key | Who uses it |
| --- | --- | --- | --- |
| Chat Session | `chat` | `chat:<chatId>:role:<roleId>` | Agent replies in the Chat, Captain replies, and mention recipients |
| Task Executor Session | `task` | `task:<taskId>:role:<executorRoleId>` | The Task's executor lane; reused across runs |
| Task Mention Session | `task` | `task:<taskId>:role:<mentionedRoleId>` | A role named by the user or another Agent in a Task comment |

- A Chat × Role has exactly one Chat Session. It is created the first time that pair is woken, and reused after that.
- A Task has one session per lane (the executor, or a mentioned role). The executor lane is reused across runs. `rerun` creates a new generation.
- **Do not use `task:<taskId>` as the only key**: a handoff to another role would reuse the previous executor's memory. The Task key must include the role.

### 3.2 The Session record

```text
Session
  id
  scope_type          // chat | task
  scope_id            // chatId or taskId
  role_id
  provider            // claude / codex / ...
  native_session_ref  // the CLI's own session id / resume token
  baseline_seq        // the seq where this session starts watching (set on create or rotate)
  prompt_revision     // the Role Prompt revision used at creation
  permission_mode     // read-only / read-exec / workspace-write
  workspace_ref       // working-directory realpath at creation
  skill_bindings_json // Skill-binding snapshot at creation
  model / thinking_level
  state               // active | rotated | closed
  created_at / rotated_at
```

- `native_session_ref` is the CLI's session id. The runtime adapter is responsible for resume/adopt.
- `baseline_seq` is the platform's record of which message this session starts from. **There is no `last_seq`.**
- `last_seq` belongs to the Participant / TaskLane: `chat_participants.last_seq` and `task_lanes.last_seq`.
- The session body, tool-call history, and model context all live in the CLI's own storage. The platform does not copy them and does not parse them.

### 3.3 Session lifecycle

**Create**: the first time a Participant is woken, or the first run of a Task lane.

**Reuse**: on every later wake-up, resume the same `native_session_ref` only when all of the following hold:

- The Provider has not changed.
- The Role Prompt revision has not changed.
- `permission_mode` has not changed.
- The working-directory realpath has not changed.
- The Skill-binding snapshot has not changed.
- The model / thinking level has not changed.
- The CLI has not reported the native session as unrecoverable.

**Rotate**: if any condition changes, or the native session cannot be recovered, create a new session.

On rotation:

- The old session has `state=rotated`.
- The new session's `baseline_seq` is set to the current Participant/Lane `last_seq` (or to the start of the recent window).
- `last_seq` stays on the Participant/Lane and is not reset with the session.
- Generate a one-time **Session Handoff** (see 3.5). It is generated once, and it is not part of every wake-up.

**Close**: the Chat is archived, the Role is removed, or the Room is deleted.

### 3.4 Who owns context for an external CLI

- CLIs such as Claude Code / Codex manage their own context compaction and session recovery.
- The platform is responsible only for:
  - saving `native_session_ref`;
  - maintaining the Participant/Lane `last_seq`;
  - generating a bounded incremental briefing;
  - generating a one-time handoff when the session cannot be recovered or is rotated.
- The platform does not read the CLI's journal, and it does not try to rewrite the CLI's context.
- **`last_seq` is a delivery watermark, not a guarantee that "the model still remembers."** The CLI's own compaction may drop content the platform has already delivered. The platform cannot reliably observe that. Mitigations:
  - The briefing is bounded.
  - Handoff again when the session rotates.
  - Task/Artifact remain facts that can be read again.
  - Do not promise that "the model has seen the whole history."

### 3.5 Session Handoff (once)

When a session is newly created or rotated, the first briefing may include a platform-generated handoff in addition to the incremental rows:

```text
[Session handoff]
You are continuing work in this chat. Earlier messages are not repeated here.
Current goal: <current chat context revision / goal>
Decisions so far: <current chat context revision>
Open tasks: <task list with status>
Recent messages: <the normal incremental briefing>
```

- A handoff is generated once, on the session's first wake-up.
- It is not a summary of every turn. Later wake-ups still send only the original text after `last_seq`.
- The goal is to let the new session pick up the work, not to rewrite the whole Chat as a summary.
- A Captain handoff may also include the current Captain prompt revision and the workflow conventions.

## 4. The incremental briefing

### 4.1 Rules

A woken Agent receives only:

1. Messages after what its own Participant/Lane last saw (`last_seq`).
2. The message that triggered it (if it is already included, it still appears only once).
3. Attachment paths or references associated with the messages.
4. If the session is new or was just rotated, one Session Handoff.
5. If the trigger is a Captain review, the review's observation data (assignment/task id, checkpoint, target status) and the current Captain prompt revision. The previous turn's full utterance still comes from the incremental rows above. The review does not repeat the full text.

A briefing does not include:

- The Agent's own utterances.
- Replies that have not finished writing.
- Messages already seen.
- Messages from other Chats.
- A system message with `audience=captain` whose recipient is not the Captain.
- The platform's internal Trace, paths, and credentials.

### 4.2 Algorithm

Following eta `conversations/briefing.ts`:

```text
input: rows (every row after last_seq, in ascending seq), trigger, me, last_seq, viewerIsCaptain
output: text, seen

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
  if row.text is empty and there are no attachments: continue
  earlier.append("- <author>: <text>" + attachments)

if earlier.length > 100:
  earlier = earlier[-100:]       // keep the latest 100
  add one line "(omitted N earlier messages)"

text = "[chat: <title>]" +
       "Since you last looked:" + earlier +
       "---" +
       "<trigger author> says:" + trigger.text + trigger.attachments

return { text, seen, omittedSeqs, truncatedIds }
```

Key points:

- **An unfinished row blocks the watermark**: if a reply is still being written, the watermark cannot pass it. Completed messages after it are shown first, but they are shown again next time, until that row finishes.
- **One's own words are not repeated**: even if the watermark did not advance, the Agent's own words are not sent back to it.
- **At most 100 messages, and at most 2000 characters each**: when there is overflow, keep the newest. Omit older messages and mark the omission.
- **An omission can be read back**: the briefing returns the omitted message id/seq ranges and truncation marks. The Agent can call `read_chat(beforeSeq, limit)` to read history of the current Chat. `read_chat` allows only the current Chat. It cannot cross Chats.
- **An edit must re-enter delivery**: editing a message appends a `message_edited` event or message and advances `activity_seq`. Updating only the old row's `revision` is not discovered by `seq > last_seq`.
- **Do not generate a summary**: a briefing is an excerpt of the original text. A summary happens only in a Session Handoff and in compaction of a platform-managed runtime.

### 4.3 Attachments

- An attachment reference enters the briefing with the message.
- A local session is given an absolute path. A remote session is given the copy path on that machine. Tyche's first stage supports only a local CLI, so it gives the local path directly.
- Whether an image is model input is decided by the runtime adapter from that CLI's and model's capabilities.

### 4.4 Briefing for a Task

A Task Session does not read the Chat timeline. Its context comes from the Task itself:

- **First run**: task title, description, acceptance criteria, source Chat, working directory, how to report, and do not merge the main branch on your own.
- **Continuation from comments**: do not send the task briefing again. Tell it only the task's current status and that "the comments below are addressed to you," because it already did the work above in the same session.
- **rerun**: a new session, and send the first-run briefing again.
- **Handoff to another role**: a new lane / a new session. Send a task handoff: the task description, the previous Report, and Artifact references. Do not inherit the previous executor's session memory.

The `last_seq` of a Task comment uses the Task's own activity sequence (`task_activities.seq`), not the Chat's `seq`.

## 5. Wake-up rules

### 5.1 User messages

Following eta `conversations/routing.ts`:

```text
named = mentions ∩ chat participants
if named is non-empty:
    wake named
else if the Chat is direct:
    wake the only role
else if there is a Captain:
    wake the Captain (if it is not a participant yet, join it first)
else if there is only one participant:
    wake it
else:
    wake nobody, and tell the user "no one was named, and there is no default recipient"
```

- Every @ in a user message wakes the corresponding role. Several @s run concurrently, not in series.
- When there is no @, do not guess. The Captain is the default recipient.
- The Captain is not the platform scheduler. After it is woken, it only decides whether to issue a visible work authorization.
- **The platform does not insert an implicit sequence**: the caller keeps talking and does not wait for the one who was woken.

### 5.2 Agent mention

An Agent calls the `mention` tool inside a reply:

```json
{
  "names": ["reviewer"],
  "text": "Please review how funny this joke is, on a scale of 1-10. Original joke: ..."
}
```

What the platform does:

1. Resolve the name or id. Allow only participants of the current Chat. Return an unknown name to the caller. A role cannot wake itself.
2. Append a message with `kind=mention`. `root_message_id` inherits the root of the current reply.
3. Create a reply row (`queued`) for each target.
4. Consume one wake budget.
5. The initiator does not wait. It goes on and finishes the current reply.

**`assign_in_group` is not two rows.** eta's `captain/service.ts:322` calls `engine.send` once and writes one visible message that carries @. That message is the assignment. The "one reply row + one mention row" you see is an extra row the `mention` tool records while the reply has not finished writing. Do not confuse the two.

### 5.3 Wake budget

- Wake-ups from the **`mention` tool** that one user message triggers are at most 5, counted across every branch.
- The 5th still wakes, with a reminder attached. After that, a mention only enters the timeline and wakes nobody.
- The count resets when the user speaks again.
- The count is based on `root_message_id`. The platform computes it when it writes the mention. It does not depend on the model reporting the count.
- The 5 counts only `kind=mention` rows that an Agent writes through the `mention` tool (eta `timeline.ts:450-457`).
- The Captain's `assign_in_group` is an ordinary message + @. It does not write `kind=mention`, so it does not use these 5.
- A Captain review is a system message, and it does not use these 5 either.
- A chain of `assign_in_group` stages is therefore not limited by the 5. The 5 limits only a `mention` that an Agent calls on its own inside a reply.

### 5.4 Serial and parallel

- **The same participant session is serial**: it answers one thing at a time.
- **Different participant sessions are parallel**: three roles can answer at the same time.
- The queue key is the participant/lane, not the session id. A message can queue before the session has been created.
- A new message may `queue` (the default) or `steer` (fold into the reply in progress). The runtime adapter declares whether steer is supported. If it is not, fall back to queue (an external CLI does not support it by default).

## 6. Running, stopping, and recovery

### 6.1 Running

- The Engine takes work from queued reply rows and runs it on the participant's serial chain.
- Before running:
  - Confirm the Chat / Role / Participant still exist.
  - Confirm the working directory and the permissions.
  - Get the session (resume or create).
  - Generate the briefing.
  - Write a `start_reply` effect. The effect pump starts the process. **Effect success means the process has been started or registered, not that the reply is finished.** Once the pump has started it, the pump releases and does not await the whole run. The reply row records the final status on its own.
- While running:
  - Streaming text is written to the reply row, and `revision` increases.
  - Tool calls produce a Trace.
  - On `waiting_for_input`, enter the wait (only when the runtime supports it).
- When the run ends:
  - Write the final `status`, `text`, `thinking`, and `activity` summary.
  - Advance the Participant's `last_seq` to `seen`.
  - Derive Report / Attention / Task changes, if any.

**Every process start goes through an effect**, including a chat reply. The Engine does not call `invokeAgent` directly.

### 6.2 Steer

- A user or an Agent can append a message while a reply is running.
- When the runtime supports it, the new content is the next user message of the same turn. When it does not, queue a new reply.
- External Claude Code / Codex are one-shot calls by default and **do not support mid-turn steer**. Comments and Attention answers should queue as a continuation run, rather than pretending they can be delivered into the current run.
- Steer also generates a briefing (carrying only what it has not seen) and updates the watermark.

### 6.3 Stopping

- A `queued` reply: mark it `stopped` directly. It will not start.
- `working` / `waiting_for_input`: move to `stopping` and send abort to the runtime. The final status is `stopped` or `interrupted`.
- Stopping a Role: stop only that Role's active replies in the **current Chat**. A Role is scoped to a Chat and does not cross Chats.
- Stopping does not undo files already written. A compensating action is required.
- Stopping a Task: the Task is marked `cancelled` (the user's intent). A running TaskRun is `cancelled` only after exit is confirmed. If exit cannot be confirmed, use `status=interrupted, outcome=unknown` + Attention.

### 6.4 Recovery after restart

- Messages:
  - `queued` continues. The effect pump schedules it again after startup recovery.
  - `working` / `waiting_for_input` are marked `interrupted`, not marked `failed` directly. Create an Attention if that run can write or may have side effects.
  - A final Report that is already committed is kept. Task status can be derived from the Report.
- Session: it remains on the CLI side. The platform tries to resume it by `native_session_ref`. If it cannot be recovered, rotate + handoff.
- TaskRun:
  - `starting/running` is marked `status=interrupted, outcome=unknown`.
  - `queued` keeps waiting.
  - Do not start a new run for that lane until process reconciliation has confirmed exit.
- Effects: `running` becomes `unknown`, and an Attention is created. Do not replay them automatically.
- Processes: ProcessRegistry reconciles them. Write `session_exited` only when the platform has observed the exit. Do not guess from a timeout or a user click.
- **Do not** mark every `working` row failed directly on restart. That violates "trust only an observed exit."

## 7. Context compaction

### 7.1 External CLI

- Compaction is done by the CLI itself (Claude Code, Codex, and others).
- The platform does not inject its own compactor, and it does not read the CLI's journal.
- What the platform can do is:
  - Bound the briefing (100 messages × 2000 characters).
  - Generate a one-time handoff when the session rotates.
  - On context overflow, rotate the session instead of retrying without limit.
- **The platform cannot know what the model still holds after the CLI compacts.** `last_seq` only guarantees that delivery is not repeated. Important facts should land in a Task, Report, Artifact, or file, so the Agent can read them again.

### 7.2 Platform-managed runtime (optional, later)

If Tyche later adds its own built-in runtime (instead of an external CLI), these can be ported:

- Defaults from `eta/packages/eta-core/src/types/config.ts`: `reserveTokens=16384`, `keepRecentTokens=20000`, `maxContextTokens=64000`.
- Thresholds and cut points from `eta/packages/eta-harness/src/estimation.ts`.
- Splitting, dropping tool noise, folding summaries, and deterministic degradation from `eta/packages/eta-compaction/src/`.

This applies only to a platform-managed runtime. An external CLI still manages itself.

## 8. Captain review (not a completion wake)

eta has no mechanism that "wakes the Captain on its own every time a Task finishes." It uses a **Captain review supervisor**:

- A tick every 60 seconds in `captain/supervisor.ts` is the fallback. **Any domain change** (a message append, a Task, a run, inbox, or conversation state) goes through `changed()` and triggers the 150ms debounce of `requestTick()`. Do not attach this only to the task board. A chat stage with no Task must also take the fast path.
- `observeReviews()` in `captain/service.ts` checks Captain assignments that have settled:
  - The target member has no queued/working/stopping. `waiting_for_input` counts as a blocked condition.
  - The linked Task must not still be todo/in_progress, and it must not still have an unfinished run.
  - `hasNew`, but the baseline of the comparison must include the assignment message's watermark (see below).
  - Whether it is blocked / stalled.
- **The `hasNew` comparison** (aligned with eta `captain/service.ts:965-973`):

```text
activityBaseline = max(checkpoint, the public message seq of each non-cancelled assignment)
hasNew = chat.activity_seq > activityBaseline
```

  The assignment message itself is not "new activity after the assignment." The visible message of `assign_in_group`, the `captain_assignments` record, and the target's queued reply row must be written in the **same transaction**, and only then `requestTick()`. The target is then immediately queued, so it is blocked by "the target is still busy," and the assignment just sent is not treated as `assignment_settled`.

- **There is a review even when there is no Task**: when the target role's reply has ended and the role is idle, and the Chat has new public activity, generate `assignment_settled`. The role is not required to create a Task. `hasNew` compares the whole Chat's `activity_seq` and does not filter by author. A Chat with no assignment produces no assignment review, but when a non-cancelled assignment exists, other public activity can also trigger one. What blocks it is a reply still queued/working/stopping, and a linked Task that is still todo/in_progress or still has an unfinished run.
- **When there is a Task, wait until it settles**: the Chat message of `finish_task` advances `activity_seq` first, but the Task stays `in_progress` until settlement finishes. Review fires only after the Task enters `in_review`/`blocked`. A Task status change caused by settlement must also `requestTick()`.
- **Review traffic must not advance the activity watermark**: `chat.activity_seq` counts only public messages. It excludes review rows with `audience=captain` and the reply the platform creates to deliver this review (`data_json.reviewReply=true`). `reviewReply=true` **is set only on the reply delivered for the review**. `assign_in_group` / `post_in_chat` are different messages, do not inherit this mark, are public, and count toward `activity_seq`.
- `post_in_chat` is public. When the target is already idle, it can still open another round of `assignment_settled`. The Captain's ordinary summary belongs in the review reply (`audience=captain`). `post_in_chat` is only for a notice that has to be public.
- `chat.activity_seq` is only for the supervisor to judge public activity. The Captain's `chat_participants.last_seq` is still its delivery watermark. A review row does not advance `activity_seq`, but it does enter the Captain's briefing.
- `silentFor` in the `stalled` check also looks only at the update time of the latest public message. Review rows and Captain review replies do not count.
- When the conditions hold, create `captain_review`. `checkpoint_seq` uses `activity_seq`. The dedupe key uses conversation + kind + checkpoint, so the same stretch of activity is not woken over and over.
- Batch-deliver pending reviews of **the same Chat** only while the Captain is idle (at most 20 items / 12k characters). Do not merge across Chats.
- A review enters the Captain's conversation as a `system` message and creates a queued reply. `mentions: []`. It does not consume the budget of 5 agent-to-agent wake-ups.
- The review body is an **observation**: assignment/task id, checkpoint, and target status. It is not the full text of the previous turn. Through the normal incremental briefing, the Captain reads the public original text that others have already finished writing after the watermark, then decides the next step from the Prompt.

**Trigger order**: the Chat message of `finish_task` advances `activity_seq` first, but the Task stays `in_progress` until settlement finishes, so review does not fire before the snapshot. After exit confirmation + the after snapshot + Artifact merge, the Task enters `in_review`/`blocked`. That status change triggers `requestTick()`, and only then does the supervisor review. `in_review` / `done` / `cancelled` are not busy. `blocked` takes `assignment_blocked` and does not take `assignment_settled`.

`hasNew` compares the whole Chat's `activity_seq`. A Chat with no assignment produces no assignment review. As long as a non-cancelled assignment exists, other public activity can also advance `activity_seq` and trigger `hasNew` (the same as eta, with no filter by author). A reply still queued/working/stopping, and a linked Task that is still todo/in_progress or still has an unfinished run, block the review.

**The Captain still does not create the Task**: review only lets it see that "the previous turn has settled." It issues a visible authorization from its own Prompt, and the target Agent calls `create_task` itself.

**Workflow Prompt**: each Chat has one Captain Prompt (role_prompt_revisions). The review message carries the current Prompt revision, so switching Chat or editing the Prompt takes effect on the next turn. The platform does not parse the Prompt and does not run a state machine.

### 8.1 Example of a three-stage workflow

Captain Prompt for Chat-1:

```text
There are only three stages, in order: mockup, architecture, implementation.
Assign only the current unfinished stage, and wake only one role. Do not assign a later stage early.
After being woken, decide the next step from results already completed on the timeline.
```

Flow:

1. The user @ mentions only the Captain (or @ mentions nobody; the Captain is the default recipient).
2. The Captain `assign_in_group` for the mockup → the message, `captain_assignments`, and the target queued reply are written in the same transaction → the mockup role is woken and calls `create_task` itself.
3. The mockup `finish_task` → a completion claim. An Agent message is appended to the source Chat → `activity_seq` advances, but the Task is still `in_progress`.
4. Process-exit confirmation + after snapshot + Artifact merge → the Task enters `in_review`. The Task status change triggers `requestTick()`.
5. The supervisor reviews → `captain_review` → a system message wakes the Captain. The Captain's briefing includes the mockup's full utterance. `in_review` is not busy, so the Captain can assign architecture without waiting for the user to accept.
6. If the user calls `accept_task` before the tick, the Task is already `done`. `done` is not busy, and the review must still be sent, or the next stage will not be assigned.
7. If finish_task is `blocked`, settlement takes `assignment_blocked`. Do not mix that with `assignment_settled` for `in_review` as the same kind of trigger.
8. The Captain assigns architecture from the Prompt → assigns implementation the same way. When implementation finishes → Captain review → a summary, and no further task is assigned.

Budget: `assign_in_group` is an ordinary message + @ and does not write `kind=mention`, so it **does not use the 5**. A Captain review is a system message and does not use them either. The 5 counts only `kind=mention` rows an Agent writes through the `mention` tool (eta `timeline.ts:450-457`). A three-stage workflow is therefore not limited by this budget. The platform still checks concurrency, cost, and write boundaries.

For Chat-2, drop the mockup from the Prompt and the flow becomes two stages on its own. The platform does not need to know that "one stage is missing."

## 9. Invariants

1. A reply row belongs to exactly one participant/lane.
2. The same participant/lane is serial. Different participant/lanes are parallel.
3. The watermark passes only rows that are already finished and are not the Agent's own. The watermark belongs to the participant/lane, not to the session.
4. An unfinished row does not disappear from the briefing, and the watermark does not skip it.
5. A briefing does not generate a summary. A summary appears only in a Session Handoff and in compaction of a platform-managed runtime.
6. `mention` must carry body text. The other party cannot read a reply that is not finished yet.
7. Wake budget counts only an Agent's `kind=mention` rows, counted per root user message. Neither `assign_in_group` nor Captain review uses this budget.
8. The platform does not read or rewrite the session body of an external CLI.
9. When an external CLI's session cannot be recovered, rotate and generate one handoff. Do not retry without limit.
10. The platform does not insert an implicit sequence. Sequence comes from each turn's `mention` or from Captain review.
11. Captain review is the supervisor checking "assignments that have settled," not a separate wake for every finished Task.
12. Every process start (a chat reply and a TaskRun) writes an effect first.
