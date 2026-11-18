# 02 Target Architecture

## 1. Overview

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Renderer (Vue)                                                                                              │
│  RoomWorkspace · Chat Timeline · Task/Report/Attention/Artifact cards                                       │
│  Captain workflow Prompt editing · Captain Review cards                                                     │
│  Read snapshots, submit messages, and execute user commands only through the narrow IPC exposed by preload  │
└──────────────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                                       │ IPC (main validates origin and DTO)
┌──────────────────────────────────────────────────────▼──────────────────────────────────────────────────────┐
│ Electron main                                                                                               │
│                                                                                                             │
│  Room Domain (new, desktop/src/room/)                                                                       │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                                                         │
│  │ Message      │ │ Router /     │ │ SessionStore │                                                         │
│  │ Timeline     │ │ Briefing     │ │ (SQLite)     │                                                         │
│  └──────────────┘ └──────────────┘ └──────────────┘                                                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                                                         │
│  │ Task Queue   │ │ Report /     │ │ Agent Tools  │                                                         │
│  │ (TaskRun)    │ │ Attention    │ │ (MCP/marker) │                                                         │
│  └──────────────┘ └──────────────┘ └──────────────┘                                                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                                                         │
│  │ Captain      │ │ Captain      │ │ Effects /    │                                                         │
│  │ Assignment   │ │ Review       │ │ Outbox       │                                                         │
│  └──────────────┘ └──────────────┘ └──────────────┘                                                         │
│                                                                                                             │
│  Platform Infrastructure (keep / adapt)                                                                     │
│  RuntimeAdapter · CLI adapters · ProcessRegistry · Trace ·                                                  │
│  Run Ledger · Lease · Permissions · Artifact Snapshots                                                      │
│                                                                                                             │
│  Storage (new)                                                                                              │
│  SQLite ledger (facts / pointers / watermarks) + Trace JSONL + Artifact Git snapshots                       │
└──────────────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                                       │ native child process / stdio / MCP
┌──────────────────────────────────────────────────────▼──────────────────────────────────────────────────────┐
│ Claude Code · Codex · other native Agent CLIs (each manages its own session/context)                        │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Core boundaries:

- **The platform ledger** stores facts, pointers, watermarks, tasks, reports, Attention, and Artifact references.
- **The Agent runtime** stores its own session body and context; the platform does not take that over.
- **The platform does not split tasks**: a Task is created by an Agent; the platform only validates, queues, records, and recovers.
- **The platform does not hide decisions**: Captain authorization, an Agent mention, and every Task/Report land on the Chat timeline.
- **The platform does not impose implicit serialization**: multiple wakes run in parallel; serialization is driven by each link's own `mention` or by Captain review.
- **Every process start goes through an effect**: a chat reply and a TaskRun are the same.

## 2. Layered responsibilities

### 2.1 Room Domain (newly written, `desktop/src/room/`)

| Module | Responsibility |
| --- | --- |
| `timeline.cjs` | Append Messages, allocate sequence numbers, transition status, record edit/delete events, and hold reply-row placeholders |
| `routing.cjs` | Wake rules for user messages; mention parsing; a wake budget of 5 |
| `briefing.cjs` | Build an incremental briefing from the participant/lane watermark; handle in-progress rows, attachments, and the length limit |
| `session-store.cjs` | SQLite pointers, baseline, rotation, and native references for Chat Sessions and Task Sessions |
| `engine.cjs` | Turn a reply row into a run: serial/parallel, steer/queue, stop, and restart recovery |
| `task-queue.cjs` | TaskRun queue, lane, concurrency limits, pump, continuation from a comment, and rerun |
| `captain-review.cjs` | Review queue, checkpoint, batching, and wake for a Captain assignment |
| `reports.cjs` | Parse and import Reports; derive Task status; refuse to guess from free text |
| `attentions.cjs` | Items that need the user; merge, idempotency, and return to the original session after an answer |
| `commands.cjs` | Validation, idempotency, and audit of a UserCommand |
| `effects.cjs` | Durable outbox: start a process, deliver a message, publish an Artifact, and notify |
| `supervisor.cjs` | 150ms debounce fast path on domain changes, plus a 60-second fallback tick; drives Captain review |
| `recovery.cjs` | Startup recovery, process reconciliation, and isolation of unknown |
| `tools/` | Agent tools: mention, create_task, comment_task, finish_task, ask; `captain.cjs` is the Captain-only tool |
| `ipc.cjs` | Narrow IPC; it does not expose paths, native session references, or process handles |

### 2.2 Platform Infrastructure (kept, adapted when necessary)

| Module | Reason to keep |
| --- | --- |
| `workspace/local-workspace-agent-invocation.cjs` | The actual execution chain for a native Agent call |
| `workspace/invocation-session.cjs` | The resume/adopt/discard mechanism for a native session; adapted through the SessionStore port |
| `agents/cli/*` | CLI adapters for Claude Code / Codex and the others |
| `runs/run-ledger.cjs` / `run-journal.cjs` | Run records and crash recovery |
| `runs/path-claims.cjs` | Write lease on the Room root |
| `runs/invocation-watchdog.cjs` | Startup / stall / no-progress windows |
| `project-room/shadow-git.cjs` | Commit/diff snapshots of an Artifact |
| `security/*` | Private files, redaction, and IPC security |
| `attachments/*` | Attachment import, validation, and preview |
| `skills/*` / `knowledge/*` | Skill and knowledge-source capabilities |

These modules may change their interfaces, but their internal implementations should not be rewritten for the new domain model.

### 2.3 Explicitly retired

| Module | Reason |
| --- | --- |
| `project-room/checkpoint-engine.cjs` | A fixed checkpoint state machine; it is no longer the user-facing model |
| `project-room/checkpoint-transitions.cjs` | Same as above |
| `project-room/gate-screen.cjs` | Gate is internal vocabulary and is no longer a top-level screen |
| `workspace/local-workspace-auto-runner-v2/v3/v4-*` | Several collaboration executors, replaced uniformly by the new engine |
| `room-engine/controller-session.cjs` | An in-platform batch scheduler, replaced by Captain + review |
| `room-engine/controller-agent.cjs` | The Controller task-splitting model, retired |
| `room-engine/assignment-runner.cjs` | The Assignment-as-session model, retired |
| `room-engine/mention-fallback.cjs` | A temporary fallback only; ultimately replaced by unified routing |
| old schema of `room-engine/room-db.cjs` | The new ledger uses a clean schema; the old database is for migration only |

> Deletion order and dependencies are in [06 Rewrite and Migration](06-rewrite-and-migration.md). Do not delete `local-workspace-auto-runner*` first: `LocalWorkspace` still depends on it. Extract the runtime primitives first, then connect the new domain.

## 3. New code layout

```text
desktop/src/room/                 # new domain; do not reuse the desktop/src/collaboration/ directory name
  db.cjs                          # SQLite open, WAL, transactions, schema version
  schema.cjs                      # table definitions and migrations
  repository.cjs                  # domain-object reads and writes (or split per object)
  timeline.cjs
  routing.cjs
  briefing.cjs
  session-store.cjs
  engine.cjs
  task-queue.cjs
  captain-review.cjs
  reports.cjs
  attentions.cjs
  commands.cjs
  effects.cjs
  supervisor.cjs
  recovery.cjs
  tools/
    mention.cjs
    tasks.cjs
    ask.cjs
    captain.cjs
  ipc.cjs
```

Names may change, but the boundary does not: **the domain does not start processes directly, and the runtime does not write product tables directly.** Every external side effect is written as an effect first, then executed by the pump.

## 4. Data ownership

| Data | Location | Description |
| --- | --- | --- |
| Room / Chat / Role / Participant | SQLite | Product facts |
| Message / Task / TaskRun / Report / Attention / Artifact reference | SQLite | Product facts |
| Session pointer (native ref, baseline) | SQLite | Store the pointer only, not the body |
| Participant / lane watermark | SQLite | `last_seq` belongs to the participant/lane, not to the session |
| Session body / model context | The Agent CLI's own storage | The platform does not own it and does not parse it |
| Trace | JSONL in the application private area | A read-only execution trace; the DB stores the reference |
| Artifact content | Git / snapshot in the application private area | The DB stores commit / version / metadata |
| Effect / UserCommand idempotency | SQLite | The boundary for external side effects |
| Old workspace JSON / old room DB | Archive in the application private area | Read-only after a one-time migration |

### 4.1 SQLite table draft

> Concrete fields are frozen in the implementation plan; only the semantics are fixed here.

- `rooms`: id, name, workspace, write_authorization (realpath), providers_json, allowed_capabilities_json, created_at, updated_at.
- `chats`: id, room_id, title, status, last_seq (the latest message seq, including review rows), activity_seq (the latest **public** message seq, for Captain review to compare), captain_reviewed_seq, created_at, updated_at.
- `chat_roles`: id, chat_id, display_name, responsibilities, provider, model, capabilities_json, native_permission, is_captain, status, created_at, updated_at.
- `role_prompt_revisions`: role_id, revision, prompt, created_by, created_at.
- `chat_context_revisions`: chat_id, revision, instructions, changes_json, created_by, created_at. Stores the user-editable collaboration agreement (goals, decisions already made, current preferences); each edit appends a new revision and does not overwrite history.
- `chat_participants`: chat_id, role_id, session_id, last_seq, joined_at, left_at. `last_seq` is that Role's authoritative delivery watermark in the Chat.
- `sessions`: id, scope_type (chat/task), scope_id, role_id, provider, native_session_ref, baseline_seq, prompt_revision, permission_mode, workspace_ref, skill_bindings_json, model, thinking_level, state (active/rotated/closed), created_at, rotated_at. **There is no `last_seq`.**
- `messages`: id, chat_id, seq, revision, client_id (unique within the chat), audience (chat/captain; default chat), author_type (user/agent/system), author_id, kind (message/mention/system/task_draft/task_card/report_card/captain_review), content, mentions_json, reply_to, task_id, root_message_id, captain_assignment_id (the authorization bound to the target reply), status (queued/working/waiting_for_input/stopping/done/failed/stopped/interrupted), data_json, created_at, edited_at, deleted_at.
- `tasks`: id, chat_id, number, title, description, acceptance, kind, status (backlog/todo/in_progress/in_review/blocked/done/cancelled), created_by_role_id, assignee_role_id, captain_assignment_id, parent_task_id, blocked_by_task_ids_json, required_artifact_ids_json, optional, source_message_ids_json, context_revision, default_write_scopes_json, created_at, updated_at.
- `task_activities`: id, task_id, seq, kind (comment/report/status/run), author_type, author_id, body, message_id, created_at. The Task's own timeline; a Task lane's `last_seq` uses it.
- `task_lanes`: id, task_id, role_id, kind (executor/mention), session_id, last_seq, active, created_at. One executor lane per Task, plus one lane for each mentioned role.
- `task_runs`: id, task_id, lane_id, role_id, status (queued/starting/running/completed/failed/interrupted/cancelled), outcome (pending/known/unknown), snapshot_state (not_applicable/pending/completed/failed/unknown), session_id, required, continues_run_id, previous_run_id, captain_assignment_id, machine, workspace_ref, write_scopes_json, queued_at, started_at, ended_at, reason.
- `reports`: id, task_id, run_id, lane_id, kind (progress/ready/waiting/blocked/failed/handoff), summary, evidence_json, artifact_ids_json, next_request_json, attention_id, created_at.
- `attentions`: id, chat_id, task_id, type, question, options_json, status, requested_by, answered_by, resolution_json, created_at, answered_at.
- `artifacts`: id, room_id, task_id, run_id, path, kind, version, status (draft/published/accepted/rejected/superseded), commit, created_at, updated_at.
- `captain_assignments`: id, chat_id, message_id, root_message_id, target_role_ids_json, target_reply_ids_json, status (active/cancelled), created_at. The Captain's ledger of visible authorization messages, not an executing Assignment; reply IDs tie the authorization, the target reply, the run, the tool call, and the Task together.
- `captain_reviews`: id, chat_id, assignment_id, kind, dedupe_key, checkpoint_seq, status (pending/running/completed/failed), attempts, next_attempt_at, body, data_json, reply_id, created_at, updated_at. The Captain review queue.
- `events`: id, room_id, chat_id, seq, actor_id, type, payload_json, created_at (append-only audit).
- `effects`: id, chat_id, kind, status (pending/running/succeeded/failed/unknown), payload_json, idempotency_key, attempts, last_error, created_at, started_at, completed_at.
- `user_commands`: id, chat_id, type, payload_json, status, result_json, created_at (idempotent).
- `tool_calls`: id, run_id, call_id, tool_name, args_hash, status, result_json, created_at, updated_at; `UNIQUE(run_id, call_id)`. `call_id` is the logical call ID; a new call with the same arguments uses a new `call_id`.

**No longer kept:** tables and fields centered on "platform dispatch", such as `assignments`, `controller_decisions`, and `reports.assignment_id`. TaskRun replaces Assignment; the Captain's visible messages and Agent tool calls replace ControllerAction batches; `captain_assignments` is only the review ledger of visible authorization.

## 5. One complete run

```text
1. The user sends a message
   → messages appends (seq), and events records message_created
2. The Router decides who to wake
   → create a reply row for each target (status=queued, seq reserved, root_message_id)
3. Start the chat reply
   → write a start_reply effect (durable)
   → the effect pump claims it
   → runtime.invokeAgent({ sessionRef, prompt })
4. The Agent runs
   → it may call mention / create_task / comment_task / finish_task / ask
   → streaming output is written to the reply row
5. End
   → reply status = done/failed/stopped/interrupted
   → participant.last_seq advances to seen
6. If create_task
   → tasks + task_lanes(executor) + task_runs(queued)
   → write a start_run effect → the task queue pump starts the run (task session)
7. If finish_task
   → task_activities + reports (a completion claim; the Task stays in_progress)
   → append an Agent message on the source Chat (advance chat.activity_seq)
   → wait for process-exit confirmation → after snapshot → Artifact merge/validation
   → only then does the Task enter in_review/blocked
8. Captain review supervisor
   → 150ms debounce on any domain change (fast path) + a 60-second fallback
   → check settled Captain assignments
   → hasNew = activity_seq > max(checkpoint, assignment message seq)
   → there is new activity/blocked/stalled and the target is idle
   → merge only captain_reviews(pending) for the same Chat → a system message wakes the Captain
9. If the user is needed
   → attentions + notification/inbox
10. Every external side effect
   → write effects first, then execute; failed/unknown can be recovered
```

### 5.1 Effect lifecycle

`start_reply` / `start_run` must distinguish "startup succeeded" from "the run has ended":

- Effect success means the platform has reliably claimed the effect and confirmed that **the process has started / been registered**. It does not mean the whole Agent invocation has finished.
- The effect pump claims the effect → starts the process → writes the `session_started` / ProcessRegistry record → marks the effect succeeded → releases the pump; **do not await the whole run**.
- A long run is held by the reply row / TaskRun. Participant/lane serialization, the machine slot, and the write lease are recorded on the reply, the TaskRun, and the lease respectively. The run result is written separately as reply status or TaskRun outcome.
- Startup failure → effect failed + reply/TaskRun failed. The process has started but the confirmation was lost → effect unknown + Attention, and the decision comes after process reconciliation.
- Concurrency is controlled by the participant/lane, the machine slot, and the lease, not by serializing the effect pump. Starts for the same participant/lane stay serial. Different participants/lanes may start in parallel.

| Resource held | Holder |
| --- | --- |
| participant/lane serialization | reply row / TaskRun.lane_id |
| machine slot | TaskRun.machine |
| write lease | TaskRun / lease record |

- On restart: a pending start effect may still be consumed; a running effect becomes unknown; a run whose exit is not confirmed stays interrupted/unknown; write operations are not replayed automatically.

## 6. Agent tool transport

Agent tools cannot exist only in the documentation; there must be an explicit channel.

### 6.1 Preferred: local MCP server

- Electron main starts a local MCP server for each run/session, bound to:
  - `runId` / `sessionId`
  - `chatId` or `taskId`
  - `roleId`
  - the allowed tool set
- Tools:
  - `mention(names, text)`
  - `create_task(title, description, acceptance, workspace?, parent_task_id?, blocked_by?, optional?)`
  - `draft_task(...)` (optional)
  - `comment_task(taskId, text)`
  - `finish_task(taskId, summary, status, evidence?, artifact_ids?)`
  - `list_tasks` / `get_task` / `read_task(taskId, beforeSeq?, limit?)`
  - `read_chat(beforeSeq?, limit?)` (limited to the history of the current Chat)
  - `request_attention(question, options?)`
- Identity is bound by the MCP server. **It does not accept author/actor/runId inside tool arguments.**
- Only the current run of the executor lane may call `finish_task`. A mention lane has only read, comment, mention, and ask tools.
- The tool result must be returned to the running session (`create_task` returns taskId, `list_tasks` returns the list, and so on). The MCP server is a full tool loop, not a one-shot marker.
- **The idempotency identity is the `callId` of one logical call, not an argument hash.** The platform/MCP server generates a `callId` the first time it accepts the call and returns it in the result metadata; a retry must reuse that same `callId`. If the transport cannot guarantee that a retry reuses the `callId`, do not promise idempotency across retries: read tools execute every time; write tools fall back to a domain unique key (`finish_task` is unique per task+run; `create_task` is unique per assignment+source message; `comment_task` requires the caller to provide an idempotency key).
- An `args hash` is used only to check that the arguments of the same `callId` are consistent. It is not used to identify a new call. A new call with the same arguments is still a new call, and a read tool must not return an old result because the arguments are the same.
- The MCP server listens only on loopback, and its lifetime follows the run. It does not expose tokens or credentials to the CLI.

### 6.2 Fallback: strict text markers (restricted degradation)

If a CLI does not support MCP:

```text
[[MELDWORK_TOOL:{"name":"mention","callId":"...","args":{"names":["reviewer"],"text":"..."}}]]
```

- **A marker is not an MCP equivalent.** Each reply applies only the last complete marker. There is no tool-result return, so the same reply cannot `create_task` and then `comment_task`, and it cannot continue deciding after `list_tasks`/`get_task`.
- A marker fits only one **terminal action**: one of `mention`, `create_task`, `comment_task`, or `finish_task`. The `finish_task` marker and the Report marker share strict validation.
- Identity is still bound by the platform from the run/session. Fields inside the marker cannot name the author.
- The `callId` inside a marker is only a client retry key and cannot be treated as platform identity. If it is missing or it changes, treat the call as new. Write tools fall back to a domain unique key, and read tools execute every time.
- Captain tools (`assign_in_group`, `post_in_chat`, `proposal`, `control_task`) require MCP. The marker protocol has no closed loop that returns authorization or a result, and it does not support Captain autonomy.
- A CLI that supports neither MCP nor markers can take part only as a read-only discussion participant. It cannot create a Task, mention, or finish_task.

### 6.3 Capability matrix

Phase 2 must record and verify the following for every CLI:

| Capability | Claude Code | Codex | ACP |
| --- | --- | --- | --- |
| resume | to be verified | to be verified | `session/resume` / `session/load` |
| mid-turn steer | unsupported (`--print` is one-shot) | unsupported (`exec -` is one-shot) | queues the next prompt, not a steer |
| wait-for-input | connector path only | to be verified | ask/permission |
| MCP tools | to be verified | to be verified | to be verified |
| tool result return / multi-call loop | to be verified | to be verified | to be verified |
| self-compaction | yes | yes | decided by the runtime |
| cancel | process termination | process termination | `session/cancel` |

A CLI without mid-turn steer always queues comments and Attention answers as a continuation run. Do not pretend they can be "sent into the current run".

## 7. UI targets

- **One RoomWorkspace**, and there is no longer a mode selector for concurrent, sequential, or automatic discussion.
- The Chat timeline shows: user messages, Agent replies, mention rows, Captain assignment, Captain review, Task cards, Report cards, Attention cards, Artifact cards, and system events.
- The role bar shows: role name, Provider, responsibilities, permissions, and whether the role is Captain.
- The Captain workflow Prompt is editable. There is one per Chat, and a change appends a revision.
- A Task card can open the execution record / Trace. A Report card shows the summary, the evidence, and the artifacts.
- An Attention card can be answered directly. The answer returns to the original session, or is queued as a continuation run according to what the runtime can do.
- The old `ProjectRoomGatePanel`, `ProjectRoomSeatSettings`, `ProjectRoomProgress`, and `ProjectRoomOverlay` are no longer the entry to a new Chat.
- All new copy goes into `frontend/src/locales/zh.js` and `en.js`.
- The Renderer receives only display-safe DTOs. Those DTOs do not include native session references, absolute paths, process handles, or credentials. If the Room root must be shown, handle it as a read-only string exception.

## 8. Architecture invariants

1. A Message is written to the ledger first, and only then does it trigger a wake.
2. A reply row belongs to exactly one participant. The same participant is serial, and different participants are parallel.
3. Each lane of a Task has at most one unfinished run at a time. The executor lane and the mention lanes may run in parallel.
4. A Task's session belongs to the Task lane (task × role), not to one particular run. The executor lane is reused across runs, and only a rerun resets it.
5. Without a Report, a Task cannot be derived as done. `accept_task` is the user's acceptance, and Artifact status alone does not decide Task status.
6. Liveness and exited, as observed by the platform, are process facts. An Agent self-report is not.
7. Every external side effect is written as an effect first. A chat reply and a TaskRun are the same.
8. The Renderer never touches a path, a credential, a native session reference, or a process handle.
9. The old engine does not take part in reads or writes of a new Chat. Old data is used only for a one-time migration or archive.
10. Wakes between Agents are asynchronous, and the platform does not impose implicit serialization.
11. Captain review is driven by the supervisor. It is not a separate wake for each completed Task, and it is not a wake at the end of every reply. Review rows and Captain review replies do not count toward `activity_seq`.
12. A Chat reply is read-only by default. A write happens only on an authorized TaskRun. Before workspace isolation, each Room has at most one writing run at a time.
13. Success of a `start_reply` / `start_run` effect means the process has started or been registered, not that the run has ended. The pump does not await the whole run.
14. MCP is a full tool loop. A text marker supports only a single terminal action, and it cannot claim to be equivalent to MCP.
15. `finish_task` is a completion claim. The Task enters `in_review`/`blocked` only after exit confirmation, the after snapshot, and Artifact merge, and `accept_task` is allowed only after settlement.
16. A Captain must not target itself. The authorization message, the assignment, and the target queued reply are one transaction. A reply, a run, and a tool bind `captain_assignment_id`, and they are not inferred from "the most recent one".
17. A briefing is lossy, but it returns `omittedSeqs`/`truncatedIds`. The current Chat can backfill with `read_chat`. An edit appends an event and advances `activity_seq`.
