# 04 Task, Captain, and Report

This document defines how work is created, executed, reported, and accepted. Core principle: **the Agent owns the work; the platform records facts, checks boundaries, and schedules runs, but does not decompose tasks for the Agent.**

## 1. Task ownership

### 1.1 Who creates a Task

- **Only an Agent can create a Task in a Chat.**
- The user does not directly "create a Task". The user states a need in a message, and the Agent decides whether to create a Task.
- The Captain does not create a Task for the target Agent. It only issues a visible work authorization, and the target Agent creates the Task itself.

Agent tools:

```text
create_task(title, description, acceptance, workspace?, parent_task_id?,
            blocked_by?, optional?, assignee_role_id?)
draft_task(title, description, acceptance, workspace?, parent_task_id?,
           blocked_by?, optional?, assignee_role_id?)
list_tasks(filter?)
get_task(taskId)
read_task(taskId, beforeSeq?, limit?)
read_chat(beforeSeq?, limit?)
update_task(taskId, title?, description?, ...)
comment_task(taskId, text)
finish_task(taskId, summary, status, evidence?, artifact_ids?)
            // status=ready|blocked; ready is a completion claim, not in_review
```

### 1.2 create_task and draft_task

- **`create_task` (default)**: when the Agent decides the work needs its own execution, it creates the Task and enqueues it directly. The user does not have to confirm beforehand; this is part of the complete first-round capability. The Agent must state, in the description, the user message that triggered it, the goal, the acceptance criteria, and the workspace.
- **`draft_task` (optional)**: used when the Agent wants the user to look at the goal, the scope, or the cost first. A `task_draft` card appears on the timeline. After the user confirms, it becomes a Task and is enqueued. The platform does not require draft.
- Both require the description to be written for someone who knows none of the prior context. The session that executes the Task cannot see the history of the source Chat.
- The platform still checks Role, Provider, and Chat ownership, permissions, concurrency, and cost. These are safety and resource boundaries, not user approval for creating a task.

### 1.3 Executor

- The default executor is the creator.
- `assignee_role_id` is optional. If it is set, it must be an active Role of the current Chat, and the Provider and capabilities must meet the task.
- **When a Captain authorization triggers it**: the executor is the role that received the authorization. `create_task` cannot change the assignee to another role. Reassignment can go only through the user's `handoff_task`.
- The `captain_assignment_id` of `create_task` is inherited from the current reply row or run. It is not inferred from "that role's most recent assignment". When the same role has several queued authorizations, each reply keeps its own assignment id.
- The platform checks that the Task, the Role, and the Chat belong together. Cross-Chat assignment is always rejected.
- The user can use `handoff_task` to hand an ended failed or waiting attempt to another Role. This is a user command, not a free reassignment by the Agent.
- The Agent may suggest `handoff` in a Report, but that only creates a one-time confirmation or Attention. It does not reassign automatically.

### 1.4 Joining a Role, and permissions

- A Role is one chat record: name, provider, responsibilities, prompt revision, and native permission. The user writes it from the role dialog. The Captain writes it with `create_roles`. Both calls store the same fields. The platform reads that record for the member list, the timeline cards, and later runs. `create_roles` does not wake the new members. `assign_in_group` in that same turn is rejected. The next user message can assign them.
- A Role binds a Provider and model, a Prompt revision, capabilities, a native permission mode, and Skill bindings.
- After a Role joins a Chat it becomes a Participant. Each Chat has its own session and does not share context with other Chats.
- A Role belongs to one Chat and is not shared across Chats. If the same Provider appears in two Chats, those are two Roles and two sessions.
- Removing a Role does not delete history. Its in-progress reply stops. Messages and Reports already written are kept.
- When the user changes a Role Prompt or its permissions, only runs created afterward are affected. Historical runs keep the original revision. An existing session decides reuse/rotate on the next wake, according to the conditions in 3.3.

## 2. Task lifecycle

```text
create_task ─────────────────────▶ todo ──(queue starts)──▶ in_progress
draft_task ──(user confirms)─────▶ todo
backlog (optional, not run now)──▶ todo
                                    │
                                    ├─ finish_task(ready) ──▶ completion claim (still in_progress) ──▶ settlement: exit confirmation + snapshot ──▶ in_review ──(user accept_task)──▶ done
                                    ├─ finish_task(blocked) ─▶ settlement complete ──▶ blocked ──(user answer/comment)──▶ todo
                                    ├─ required run failed ──▶ blocked + Attention (or todo, if a retry is already queued)
                                    └─(user stop_task)──▶ cancelled
                                    │
                                    └─(user handoff_task)──▶ todo (new role / new run)
```

- Task status is derived by the platform from the Report, TaskRun facts, and user commands. The Agent cannot set `done/cancelled` directly.
- `in_review` means the platform has finished settlement (exit confirmation + snapshot + Report/Artifact checks) and is waiting for the user to accept. `done` requires the user's `accept_task`.
- `blocked` means the Agent needs input from the user. A comment or an answer from the user pushes it back onto the queue.
- `cancelled` means the user no longer wants it executed. A run that is still going must stop first, and its exit must be confirmed.
- A Task has no separate `failed` status. Failure is a fact of the TaskRun. After a required run fails, the Task may be `blocked` + Attention, or stay `todo` when a retry is already queued.

### 2.1 State transition table

| Current | Event | Next status | Condition |
| --- | --- | --- | --- |
| — | `create_task` | todo | Default; backlog is optional |
| — | `draft_task` + user confirmation | todo | The user confirms |
| todo | TaskRun start | in_progress | effect success = the process has started or been registered, not run completion |
| in_progress | `finish_task(ready)` | in_progress | The active run of the executor lane; a completion claim, waiting for exit and the snapshot |
| in_progress | Settlement complete: exit confirmation + snapshot + Report check | in_review | A ready Report; Artifact IDs have been merged |
| in_progress | `finish_task(blocked)` | in_progress | A completion claim, waiting for exit and the snapshot |
| in_progress | Settlement complete: blocked Report | blocked | Exit confirmation + snapshot are complete |
| in_progress | required run failed (known) | blocked | Create a failure Attention; todo if a retry is queued |
| in_progress | Process exit unknown | blocked | TaskRun interrupted/outcome=unknown + Attention |
| in_review | `accept_task` | done | Settlement is complete; the latest required run has a ready Report; required Artifacts are accepted/published |
| in_review | `reject_task` | todo | Create a revision comment; a continuation run may be queued |
| blocked | User comment/answer | todo | The platform delivers the comment into the task session, or queues a continuation run |
| todo/in_progress/in_review/blocked | `stop_task` | cancelled | A user command; stopping the TaskRun is confirmed separately |
| blocked | `handoff_task` | todo | The target Role belongs to the same Chat; the original run has ended (TaskRun failed/interrupted is a fact, not a Task status) |
| cancelled | — | — | Terminal; the user must reopen it explicitly |

- Artifact status is independent of Task status: `draft | published | accepted | rejected | superseded`. Accepting an Artifact does not set the Task to `done`. `accept_task` is a Task-level command.
- `accept_task` / `reject_task` must carry a `commandId` and are idempotent. Replaying the same command returns the original result.
- `finish_task` can be called only by the current active run of the executor lane. A mention lane cannot call it.

### 2.2 Task numbers

- `number` increases inside a Room and is not reused. Deleting or cancelling does not recycle it.
- When old data is migrated, the original numbers are kept. On a conflict, a new number is allocated and the mapping is recorded.

## 3. TaskRun and lanes

### 3.1 The table is the queue

```text
TaskRun
  id
  task_id
  lane_id
  role_id
  status          // queued | starting | running | completed | failed | interrupted | cancelled
  outcome         // pending | known | unknown
  snapshot_state  // not_applicable | pending | completed | failed | unknown
  session_id
  required        // whether this run blocks Task completion
  continues_run_id
  previous_run_id
  machine
  workspace_ref
  write_scopes_json
  queued_at / started_at / ended_at
  reason
```

- The executor lane of a Task has at most one unfinished run at a time.
- Each mentioned role has its own lane and may have its own run. The executor lane and mention lanes may run in parallel.
- The queue is ordered by `queued_at`.
- Start conditions: the previous run of that lane has ended; the target machine is online; that machine has a free slot; the Room's write lease is available (for a writing run).
- Each machine allows at most 2 concurrent runs by default. **Before workspace isolation, each Room has at most 1 writing run at a time.** Read-only runs may run in parallel.
- `pump()` is called at these moments: a new run is enqueued, a run ends, a machine comes online, the concurrency limit changes, or Task status or dependencies change.
- TaskRun is the business queue. Starting the native process is an effect. A queued TaskRun first writes a `start_run` effect. **Effect success = the process has started or been registered, not that the whole run is finished.** After the effect pump starts the process, it marks the effect succeeded and releases it. It must not await the whole run. The run's outcome is recorded separately on the TaskRun.
- Concurrency is controlled by lanes, machine slots, and the write lease, not by running the effect pump serially. Runs on the same lane are serial. Different lanes may start in parallel.
- When an effect result is unknown, keep the run as `interrupted/outcome=unknown`, and decide after process reconciliation. Do not replay it automatically.

### 3.2 Task session and lanes

- Executor lane: `task:<taskId>:role:<executorRoleId>`, reused across runs. `rerun` creates a new generation.
- Mention lane: `task:<taskId>:role:<mentionedRoleId>`, one per role.
- A Task has one session per lane. `last_seq` belongs to the lane, not to the session.
- A Task session cannot see the history of the source Chat. It receives only the Task itself, TaskActivity, and comments.

### 3.3 Prompt for the first run

```text
Task #<number>: <title>

Goal:
<description>

Acceptance:
<acceptance>

Source chat: <chat title> (<chatId>)
Workspace: <path or worktree>
Report with finish_task when done, or when you are blocked.

Do not merge into the main branch unless the task says so.
```

### 3.4 Comment continuation

- While a run is in progress:
  - If the runtime supports mid-turn input: the comment is delivered into that run as a user message.
  - One-shot CLIs such as Claude Code and Codex cannot deliver into the current run. The comment is queued as a continuation run, or waits as TaskActivity for the next run.
- When no run is in progress: the comment creates a continuation run. `continues_run_id` points at the run it continues. The same lane session is reused.
- A comment means "continue", not "start over". The Agent already knows what happened above.
- An Agent's own comments are not fed back to itself, and they do not wake it.
- A retry with the same `clientId` is delivered once and wakes once.
- Task comments go into `task_activities` and have their own `seq`. The Chat may optionally project one message, but the lane watermark uses the TaskActivity seq.

### 3.5 rerun

- `rerun` means "discard memory and start over": create a new generation of the lane session, and send the first-run prompt again.
- The old run and the old session stay in history. Evidence is not deleted.
- `rerun` is a user command. The Captain's `control_task` can only continue/pause. It cannot rerun, stop, or delete.

### 3.6 Completion claim and settlement

`finish_task` is a **completion claim**, not the completion of settlement.

1. The Agent calls `finish_task(taskId, summary, status)` with `status=ready|blocked`:
   - Write a Report (kind=ready/blocked).
   - The summary becomes a TaskActivity comment.
   - The platform, acting as the Agent, sends "#number title + summary" back to the source Chat and advances `chat.activity_seq`.
   - The Task stays `in_progress` (or in a waiting state) and **does not enter `in_review` immediately**.
2. The platform waits for process-exit confirmation.
3. After exit is confirmed, settle by run type:
   - **Writing run**: complete the after snapshot inside the lease, generate Artifact IDs, and merge them into the Report. `snapshot_state=completed`.
   - **Read-only run**: there is no write lease and no snapshot. The platform writes `snapshot_state=not_applicable` from the run permissions, and checks only the Report. `not_applicable` cannot be self-reported by the Agent, and it cannot be a fallback for snapshot failure.
   - **Snapshot failure**: `snapshot_state=failed`. The Task does not enter `in_review`/`blocked`. It stays `in_progress`/`blocked` + Attention.
4. Only after Report ownership, Artifact scope, and the snapshot result are checked does the Task enter `in_review` (ready) or `blocked`, and the lane, the machine slot, and the write lease are released.
5. `accept_task` may be called only after settlement is complete. The user cannot accept while the process is still running or the snapshot is not finished.

Boundaries:

- The Agent cannot cite an Artifact ID that this run has not generated yet. The platform fills it in after the snapshot.
- If a non-zero process exit is observed after `finish_task`: run → `failed/outcome=known`; Task → `blocked` + Attention; the Report is kept but cannot be accepted. Whether a snapshot or artifacts can still be produced is judged separately, and that must not change the exit fact to unknown.
- If it cannot be confirmed, after `finish_task`, whether the process exited: run → `interrupted/outcome=unknown`; the lane stays blocked until process reconciliation finishes; Task → `blocked` + Attention. There is no automatic retry, and no fabricated exit.
- If a run ends quietly with no `finish_task`: the platform reminds once. If there is still no report, the run is failed (known), and Task → `blocked` + Attention.

## 4. Report

### 4.1 Report is the domain source of truth

```text
Report
  id
  task_id
  run_id
  lane_id
  kind            // progress | ready | waiting | blocked | failed | handoff
  summary
  evidence[]
  artifact_ids[]
  next_request?   // for example, request a review from another role
  attention_id?
  created_at
```

- A Report is the domain source of truth for a task result. An Event only references the Report. It does not keep a second copy of the state.
- Task status is derived by the platform from the Report of the latest required run, TaskRun facts, and user commands.
- Without a Report, a Task cannot be derived as `done`.
- `next_request` is only a suggestion and is not dispatched automatically. It needs the Agent itself to `mention`, the Captain to issue a visible authorization, or a user command.
- A `handoff` Report only records a "suggested handoff". The actual handoff is the user's `handoff_task` (or a Captain proposal that the user confirms).
- `artifact_ids` supplied by the Agent may reference only Artifacts that already exist in the same Room. Artifacts of this run are generated and merged by the platform after the after snapshot. The Agent cannot cite an ID that does not exist yet.

### 4.2 Report channel

- Prefer the MCP tool `finish_task`. The identity of the tool call is bound to the run/session.
- A CLI that does not support MCP uses a strict text-marker fallback:

```text
[[TYCHE_REPORT:{"kind":"ready","summary":"...","evidence":[],"artifacts":[]}]]
```

- Only the last marker is accepted. Fields, kind, summary, and Artifact ownership are checked strictly.
- Natural language after the marker may supplement the report, but it cannot override the structured fields.
- The marker is stripped from the visible body and from briefings, so it does not enter context a second time.
- When there is no structured report, the platform does not guess a completion status. If the process is still running, the run stays `running`. If the process has exited, it is `failed` (known). If the exit is unknown, it is `interrupted/outcome=unknown`, and it is left to the user or the Captain.

### 4.3 Deriving Task status

```text
Report of the latest required run:
  progress  → in_progress
  ready     → in_progress (completion claim) → in_review after settlement completes
  waiting   → blocked (may stay in_progress while the run is still active)
  blocked   → blocked (after settlement completes)
  failed    → blocked / todo (depending on retry)
  handoff   → blocked (waiting for the user or the Captain to decide)
```

- `waiting` is not a Task status. It maps to `blocked` (the user is needed) or `in_progress` (the run is still in progress).
- `ready` cannot enter `in_review` before exit confirmation, snapshot completion, and the Report/Artifact checks are done.

- Failure of an optional run does not block required work.
- On a replacement-run chain (retry/handoff), only the latest required run counts. An old failure and a late Report do not override the new result.
- After the user calls `accept_task` and required Artifacts are accepted/published, Task → `done`.
- A repeated `finish_task` is idempotent. A late Report from an old run is rejected and does not override the new run.

## 5. Agent tool transport

Agent tools cannot exist only in a document. There must be an explicit channel.

### 5.1 Preferred: local MCP server

- main starts a local MCP server for each run/session, bound to `runId`, `sessionId`, `chatId`/`taskId`, `roleId`, and the allowed tool set.
- Tools: `mention`, `create_task`, `draft_task`, `comment_task`, `finish_task`, `list_tasks`, `get_task`, `read_task`, `read_chat`, `request_attention`.
- Identity is bound by the server. It does not accept author, actor, or runId inside tool arguments.
- Only the active run of the executor lane can call `finish_task`. A mention lane has only read, comment, mention, and ask tools.
- Tool results must be returned to the running session (`create_task` returns the taskId, `list_tasks` returns the list, and so on). The MCP server is a full tool loop, not a one-shot marker.
- **The idempotency identity is the `callId` of one logical call, not an argument hash.** The platform or MCP server generates a `callId` the first time it accepts the call, and returns it in the result metadata. A retry must reuse the same `callId`. If the transport cannot guarantee that a retry reuses the `callId`, do not promise idempotency across retries: read tools run every time; write tools fall back on a domain unique key (`finish_task` is unique per task+run; `create_task` is unique per assignment+source message; `comment_task` requires the caller to supply an idempotency key).
- `args hash` is used only to check that the arguments of the same `callId` are consistent, not to identify a new call. A new call with the same arguments is still a new call. A read tool must not return an old result just because the arguments match.
- The MCP server listens only on loopback, and its lifetime follows the run. Tokens and credentials are not exposed to the CLI.

### 5.2 Fallback: strict text marker (restricted degradation)

```text
[[TYCHE_TOOL:{"name":"mention","callId":"...","args":{"names":["reviewer"],"text":"..."}}]]
```

- **A marker is not the equivalent of MCP.** Each reply applies only the last complete marker. There is no tool result returned, so it cannot `create_task` and then `comment_task`, and it cannot keep deciding after `list_tasks` or `get_task`.
- A marker supports only one **terminating action**: one of `mention`, `create_task`, `comment_task`, or `finish_task`. `finish_task` and the Report marker share the same strict checks.
- Identity is still bound by the platform from the run/session. Fields inside the marker cannot name the author.
- The `callId` inside the marker is only a client retry key. It cannot be treated as a platform identity. If it is missing or it changes, treat the call as new. Write tools fall back on a domain unique key. Read tools run every time.
- Captain tools (`assign_in_group`, `post_in_chat`, `proposal`, `control_task`) need MCP. The marker protocol has no closed loop that returns an authorization or a result, and it does not support Captain autonomy.
- A CLI that supports neither MCP nor markers can take part only as a read-only discussion participant. It cannot create a Task, mention, or finish_task.

### 5.3 Capability matrix

Phase 2 must record and verify, for every CLI: resume, mid-turn steer, wait-for-input, MCP, tool result return / multi-call loop, compaction, cancel, and concurrent sessions. For a CLI without mid-turn steer, comments and Attention answers are always queued as continuation runs.

## 6. Captain

### 6.1 What the Captain is

- A Captain is a **Role** inside a Chat, with `is_captain=1`.
- It has its own Participant Session. Like an ordinary Agent, it is woken, it has memory, and it is bound by permissions.
- The Captain is not a hidden scheduler inside the platform. What it says, the authorizations it sends, and the suggestions it makes all land on the Chat timeline.
- The Captain's `author_type` is `agent`. The UI marks it with an `is_captain` badge and does not invent a special author type.
- A Chat has one Captain by default. When there is no Captain, routing falls back to "explicit @mention / the only participant".

### 6.2 Captain tools (limited to the owning Chat)

```text
assign_in_group(chatId, text, roleIds?, mode?)
post_in_chat(chatId, text)
list_roles()
read_role(roleId)
list_tasks(filter?)
read_task(taskId)
read_chat(beforeSeq?, limit?)     // history pagination of the current Chat only
read_inbox(pendingOnly?)
request_attention(taskId?, type, question, options?)
control_task(taskId, action, text?)   // continue/pause only; stop/rerun/delete need a user command
create_roles(roles)                   // writes chat roles directly; same fields as the role dialog
set_role_prompt(...)                  // usually needs user confirmation
```

- `chatId` must equal the Captain's own Chat. A cross-Chat call is always rejected.
- `list_roles` / `read_role` / `list_tasks` / `read_task` / `read_chat` / `read_inbox` can access only objects of the owning Chat. A roleId, taskId, or messageId from another Chat is always rejected.
- There is no cross-Chat `list_chats` / `read_chat`. The Captain can see only its own Chat.
- It cannot read the tasks, messages, Reports, Traces, or Attentions of another Chat.
- It cannot grant a new Provider, capability, write scope, or credential.
- It cannot set a Task to `done/cancelled` directly. It cannot rerun or delete a Task.
- continue/pause of `control_task` also go through platform checks and audit.

### 6.3 assign_in_group

- **One visible message**, carrying @mentions. That message is the assignment. It is an ordinary message, not `kind=mention`, and it does not consume the budget of 5 mentions.
- The named Agents are woken. They decide for themselves whether to `create_task` and how to run.
- The Captain does not create the Task, and it does not name an executor or a TaskRun for the target Agent.
- **The Captain must not be its own target.** If `roleIds` is absent, default to the non-Captain active role only when there is exactly one. Zero, or more than one, both return an error. It does not fall back to the Captain, and it does not guess.
- **Written in one transaction**: the assignment message, the `captain_assignments` record (including `target_reply_ids`), and the target's queued reply row are committed together, then `requestTick()`. Do not write the message first and enqueue asynchronously, or the 150ms fast path may treat the assignment just sent as `assignment_settled`.
- What the woken Agent reads is the body of this assignment message, not a Captain reply that has not finished being written.

**Note**: `assign_in_group` is not "one reply line plus one mention line". eta's `captain/service.ts:322` calls `engine.send` only once and writes one message that contains @. The two-line result comes from the `mention` tool, not from assign.

### 6.4 Captain review supervisor (reusing eta)

eta has no mechanism that wakes the Captain on its own every time a Task finishes. It uses a supervisor:

- The tick every 60 seconds in `captain/supervisor.ts` is the fallback. **Any domain change** (a message append, a Task, a run, inbox, conversation state) triggers the 150ms debounce of `requestTick()` through `changed()`. Do not hook only the task board. A chat phase with no Task must also take the fast path.
- `observeReviews()` in `captain/service.ts` checks Captain assignments that have settled:
  - The target member has no queued/working/stopping. waiting_for_input is included in the blocked condition.
  - The linked Task must not still be todo/in_progress, and must not still have an unfinished run.
  - `hasNew`. The comparison baseline must include the assignment-message watermark (see below).
  - Or blocked / stalled.
- **Comparing `hasNew`** (aligned with eta `captain/service.ts:965-973`):

```text
activityBaseline = max(checkpoint, public message seq of each non-cancelled assignment)
hasNew = chat.activity_seq > activityBaseline
```

  The assignment message itself is not "new activity after the assignment". The visible message of `assign_in_group`, the `captain_assignments` record, and the target's queued reply row are written in the same transaction, then `requestTick()`. The target is queued immediately and is blocked by "the target is still busy".

- **Review also happens when there is no Task**: once the target role's reply has ended and it is idle, and the Chat has new public activity, generate `assignment_settled`. It is not required to have created a Task. `hasNew` compares the `activity_seq` of the whole Chat and does not filter by author. A Chat with no assignment produces no assignment review, but while a non-cancelled assignment exists, other public activity may also trigger one. What blocks it is a reply still queued/working/stopping, and a linked Task that is still todo/in_progress or still has an unfinished run.
- **When there is a Task, wait for settlement**: the Chat message of `finish_task` advances `activity_seq` first, but the Task stays `in_progress` until settlement is complete. Review fires only after the Task enters `in_review`/`blocked`. A Task status change caused by settlement must also `requestTick()`.
- **Review traffic does not advance the activity watermark**: `chat.activity_seq` counts only public messages. It excludes review rows with `audience=captain` and the reply the platform creates to deliver this review (`data_json.reviewReply=true`). `reviewReply=true` **is set only on the reply delivered for the review**. `assign_in_group` / `post_in_chat` are separate messages. They do not inherit this flag, they are public, and they count toward `activity_seq`.
- `post_in_chat` is public. When the target is already idle, it may still open another round of `assignment_settled`. The Captain's ordinary summary belongs in the review reply (`audience=captain`). `post_in_chat` is only for a notification that must be public.
- `chat.activity_seq` is only for the supervisor to judge public activity. The Captain's `chat_participants.last_seq` is still its delivery watermark. Review rows do not advance `activity_seq`, but they do enter the Captain's briefing.
- The `silentFor` used to judge `stalled` also looks only at the update time of the latest public message. Review rows and Captain review replies do not count.
- When the conditions are met, create `captain_review`. `checkpoint_seq` uses `activity_seq`. The dedupe key is conversation + kind + checkpoint.
- Deliver pending reviews of **the same Chat** in a batch only while the Captain is idle (at most 20 items / 12k characters). Do not merge across Chats.
- A review enters the Captain's session as a `system` message and creates one queued reply. `mentions: []`. It does not consume the budget of 5 agent-to-agent mentions.
- The review body is an **observation**: assignment/task id, checkpoint, and target status. It is not the full text of the previous round. Through the normal incremental briefing, the Captain reads the public originals that others have already finished writing after the watermark, then decides the next step from the Prompt.
- The Captain's summary goes in the review reply (`audience=captain`). `post_in_chat` is public, counts toward `activity_seq`, and may trigger the next review. Use it only for a notification that must be public.

**Trigger timing**: the Chat message of `finish_task` advances `activity_seq` first, but the Task stays `in_progress` until settlement is complete, so review does not fire before the snapshot. After exit confirmation + the after snapshot + Artifact merge, the Task enters `in_review`/`blocked`. That status change triggers `requestTick()`, and only then does the supervisor review. `in_review` / `done` / `cancelled` are not busy. `blocked` goes through `assignment_blocked`, not `assignment_settled`.

`hasNew` compares the `activity_seq` of the whole Chat. A Chat with no assignment produces no assignment review. But as long as a non-cancelled assignment exists, other public activity may also advance `activity_seq` and trigger `hasNew` (the same as eta; it does not filter by author). A reply still queued/working/stopping, or a linked Task still todo/in_progress or still having an unfinished run, blocks the review.

**Do not** add `completion wake`, a separate completion budget, or `stage_complete`. Loop protection comes from `activity_seq` excluding review rows and the review reply. `post_in_chat` is public and may still open another round. That is platform behavior, and the Prompt cannot guarantee it. checkpoint, dedupe, and idle cover only review traffic.

### 6.5 Captain workflow prompt

- Each Chat has one Captain Prompt (`role_prompt_revisions`), and the user can edit it.
- The platform does not parse the Prompt, does not run a state machine, and does not check stage order.
- The review message carries the current Prompt revision (or rotates the Captain session), so switching Chat or editing the Prompt takes effect on the next turn.
- Example:

```text
There are only three stages, in order: mockup, architecture, implementation.
Assign only the current unfinished stage, and wake only one role. Do not assign later stages early.
After being woken, decide the next step from results already completed on the timeline.
```

- The user @ mentions only the Captain (or @ mentions no one, and the Captain is the default recipient). @ mentioning an executor role directly bypasses the Captain workflow.
- `assign_in_group` is an ordinary message plus @. It does not write `kind=mention`, and it **does not consume the budget of 5 mentions**. The 5 applies only to the Agent's `mention` tool calls. The number of Captain stages is not limited by this budget. The platform still checks concurrency, cost, and write boundaries.
- A review is a system message, and it does not consume the 5 either. 3 stages = 3 assigns + 3 reviews, and that can run through.

### 6.6 Differences from the v2 Controller

| v2 Controller | Target Captain |
| --- | --- |
| It is also an Agent, but it is hidden and constrained to a JSON action generator. It has a role badge/`note`, and it is not a collaborative role that can converse freely | An Agent role inside the Chat. Every utterance is visible |
| It can `create_task` / `assign` | It only issues a visible authorization. The Task is created by the target Agent |
| Each batch of actions is bound to `controller_decisions` | Tool calls write events/trace. The review queue is separate |
| On failure, it automatically falls back to creating a task | On failure, only explicit @mention routing remains. It does not guess a task |
| Driven by structured JSON actions | Driven by natural language plus tool calls |

What is kept is **platform checks and audit**: Role/Provider/Chat ownership, permissions, idempotency, Task status derivation, and effects. What is discarded is **the platform decomposing tasks for the Agent**.

## 7. Attention and Inbox

An Attention is something the user has to handle:

- A Task is `blocked`.
- A Task is `in_review` and waiting to be accepted.
- A question from an Agent (ask).
- An execution result of unknown, or a termination that is not confirmed.
- A request to change permissions, cost, or the Provider.
- Accepting or rejecting an Artifact.
- The Captain suggests a handoff or a retry.

Rules:

- Open only one Attention for the same question. Dedupe with a deterministic ID.
- After an Attention is answered, return to the original session and continue the original turn. If the runtime does not support waiting for input, the answer is queued as a continuation run.
- Several Attentions are merged into the Inbox. Notifications may be merged, so that not every Report pops once.
- The Attention body does not contain sensitive paths, the Prompt, or credentials.
- The user may ignore or archive. Ignoring is not agreement.
- Every answer or command that changes state must carry a `commandId` and be idempotent.

## 8. Workspace, permissions, and Artifacts

### 8.1 Workspace

- By default every role works in the Room's main directory.
- **Chat replies are read-only by default.** The default is `read-only`. Allow `read-exec` only when the CLI can guarantee it will not write files. Writes happen only in a TaskRun that has been authorized.
- A write needs an explicit authorization from the user. The authorization is bound to the realpath of the current Room root.
- Writes in the same Room are serialized by an exclusive lease. While one role is writing, other writers wait.
- Before workspace isolation, each Room has at most one writing TaskRun at a time. Read-only analysis may run in parallel.
- Parallel thinking may proceed in each role's own draft files, but the final delivery file has only one writer. That is the user's collaboration convention. The platform uses the lease to guarantee that writes do not run concurrently.

### 8.2 Per-seat permissions

- Each Role has a native permission mode: `read-only`, `read-exec`, `workspace-write`, and so on.
- The user configures them per role. The platform checks them before starting a run. The Prompt cannot rewrite them.
- `task_runs.write_scopes_json` is frozen at creation. It must be non-empty, lie inside the realpath of the Room root, and be writable under the Role's permissions.
- When scopes are omitted, the Task's default scopes are used. The default is the Room root (`.`), but the user must already have authorized Room writes.
- Room write authorization cannot be changed while a run is in progress or while outcome=unknown.
- Controller and Captain are read-only by default. The Captain does not gain write permission for being the lead.

### 8.3 Artifact

- An Artifact belongs to the Room, not to the Chat.
- A writing run takes a shadow Git snapshot inside the lease. It produces commit/diff references. `snapshot_state=completed`.
- A read-only run has no write lease and no snapshot. The platform writes `snapshot_state=not_applicable` from the run permissions, and does not require an Artifact.
- On snapshot failure, `snapshot_state=failed`. The Task cannot enter `in_review`. An Attention is created. The failure is not treated as `not_applicable`.
- Artifact status: `draft | published | accepted | rejected | superseded`. It is independent of Task status.
- A Report may reference an Artifact that already exists. The Agent cannot create a version from a path or a forged ID.
- `accept_task` can be called only after settlement is complete: process exit has been confirmed, the after snapshot is complete, and Artifact IDs have been merged and checked. It may require that required Artifacts are accepted/published. Accepting an Artifact by itself does not complete the Task.
- Whether acceptance restores the working directory is defined separately later. The first stage only updates ledger state.

## 9. Invariants

1. A Task can be created only by an Agent inside a Chat. The platform does not create a Task for the Agent.
2. The Captain only issues a visible authorization. The target Agent creates the Task itself and executes it itself.
3. Each lane of a Task has at most one unfinished run at a time. The executor lane and mention lanes may run in parallel.
4. A Task has one session per lane. The executor lane is reused across runs, and only rerun resets it. A handoff to another role uses a new lane and a new session.
5. A Report is the domain source of truth for a task result. Without a Report it cannot be done. `accept_task` is the user accepting, and Artifact status does not by itself decide Task status.
6. Neither user commands nor Agent tools can bypass permissions, the lease, or Report derivation.
7. An Attention answer returns to the original session. A CLI that does not support waiting for input queues a continuation run.
8. Every external side effect is written as an effect first. A chat reply and the process start of a TaskRun are the same.
9. Agent tools must have an MCP channel or a strict marker channel. Identity is bound to the run/session, and calls are idempotent.
10. Captain tools are limited to the owning Chat. They cannot read or write across Chats.
11. Captain review is driven by the supervisor. It is not an independent wake for each finished Task, and it does not wake at the end of every reply.
12. Chat replies are read-only. Writes happen only in a TaskRun. Before isolation, each Room has at most one writing run at a time.
