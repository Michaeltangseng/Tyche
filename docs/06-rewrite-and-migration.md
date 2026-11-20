# 06 Rewrite and migration

This document explains how to move from the two existing engines to the target architecture. The core principle is: **one target architecture; old data is migrated once or archived; there is no long-term dual engine, dual read, or dual write.**

## 1. Rewrite scope

### 1.1 Keep (infrastructure)

| Module | Handling |
| --- | --- |
| Electron main / preload / renderer trust boundary | Keep |
| `workspace/local-workspace-agent-invocation.cjs` | Keep, as the substrate of RuntimeAdapter |
| `workspace/invocation-session.cjs` | Keep the primitive; adapt it to SQLite through the SessionStore port |
| `agents/cli/*` | Keep, adapted to the runtime adapter interface |
| `runs/run-ledger.cjs`, `runs/run-journal.cjs` | Keep |
| `runs/path-claims.cjs` | Keep |
| `runs/invocation-watchdog.cjs` | Keep |
| `agents/native-permission-modes.cjs`, `agent-permission-policy.cjs` | Keep |
| `project-room/shadow-git.cjs` | Keep |
| `security/*`, `attachments/*`, `skills/*`, `knowledge/*` | Keep |

### 1.2 Rewrite (collaboration domain)

| New module | Replaces |
| --- | --- |
| `room/timeline.cjs` | `room-engine/message-ingress.cjs` plus a rewrite of the messages table |
| `room/routing.cjs` | Controller routing + `mention-fallback.cjs` |
| `room/briefing.cjs` | v2 full-text `promptOverride` |
| `room/session-store.cjs` | the one-shot session in v2 `assignment-runner`; the session mapping in the old workspace JSON |
| `room/engine.cjs` | v2 Controller batches + the assignment runner |
| `room/task-queue.cjs` | v2 Assignment/effect dispatch |
| `room/captain-review.cjs` | none (a new mechanism; reuses the eta review supervisor) |
| `room/reports.cjs` | a rewrite of the approach in `room-engine/report-importer.cjs` / `report-state.cjs` |
| `room/attentions.cjs` | a rewrite of v2 Attention reads and writes |
| `room/commands.cjs` | a semantic rewrite of `room-engine/user-commands.cjs` |
| `room/effects.cjs` | a rewrite of the approach in `room-engine/room-outbox.cjs` / `effect-pump.cjs` |
| `room/supervisor.cjs` | a rewrite of the approach in `room-engine/session-supervisor.cjs`, plus the Captain review tick |
| `room/recovery.cjs` | `room-engine/runtime-recovery.cjs` / `process-reconciliation.cjs` |

### 1.3 Retire (in dependency order)

**Do not delete everything at once.** Decouple first, then delete:

1. **The new domain uses the new directory `desktop/src/room/`.** Do not reuse `desktop/src/collaboration/`. The existing `collaboration/` holds modules such as context-pack, outcome, and answer-marker. `InvocationSession` still depends on `collaboration/context-pack-records.cjs` and cannot be deleted.
2. **Decouple `LocalWorkspace` from `LocalWorkspaceAutoRunner`.** `local-workspace.cjs:21` still requires the auto-runner. `local-workspace-auto-runner.cjs:8-22` in turn requires the V4 files. First extract the invocation, session, trace, and run-ledger primitives into `runtime/`, so the new domain does not depend on the auto-runner. Then delete V2, V3, and V4.
3. **Decouple `ProjectService` from the checkpoint engine.** `project-service.cjs:18,39` still requires `checkpoint-engine.cjs` / `checkpoint-transitions.cjs`. `project-projection.cjs:2` also requires the transition module. Remove the old UI entry points and the old service usage first, then delete.
4. **Rewrite `artifact-snapshots.cjs` and Trace authorization.** They are currently keyed by Assignment (`artifact-snapshots.cjs:15-24,63-67`, `room-service.cjs:282-287`). Rekey them by TaskRun/runId plus Room ownership, then connect them to the new domain.
5. **Delete the old UI entry points.** After `ProjectRoomGatePanel.vue`, `ProjectRoomSeatSettings.vue`, `ProjectRoomProgress.vue`, and `ProjectRoomOverlay.vue` are removed from navigation, delete the components.

Deletion list:

- `desktop/src/project-room/checkpoint-engine.cjs`
- `desktop/src/project-room/checkpoint-transitions.cjs`
- `desktop/src/project-room/gate-screen.cjs`
- The parts of `desktop/src/project-room/project-*-prompt.cjs` bound to checkpoint/seat/round
- `desktop/src/workspace/local-workspace-auto-runner-v2/v3/v4-*`
- The parts of `desktop/src/workspace/local-workspace-auto-runner-natural-*` bound to the old orchestration
- `desktop/src/room-engine/controller-agent.cjs`
- `desktop/src/room-engine/controller-session.cjs`
- `desktop/src/room-engine/controller-queue.cjs`
- `desktop/src/room-engine/controller-backlog.cjs`
- `desktop/src/room-engine/assignment-runner.cjs`
- `desktop/src/room-engine/mention-fallback.cjs`
- The ControllerAction portion of `desktop/src/room-engine/room-actions.cjs` (validation of UserCommand/PlatformTransition may be kept or rewritten)
- The new Chat entry points of the old `ProjectRoomGatePanel.vue`, `ProjectRoomSeatSettings.vue`, `ProjectRoomProgress.vue`, and `ProjectRoomOverlay.vue`

## 2. Data migration

### 2.1 New database

- New ledger: `userData/tyche-private/room/room.sqlite`
- Old ledgers: `userData/tyche-private/room-engine/` and `tyche-workspace.json`
- The new architecture reads and writes only the new ledger. After migration, the old ledgers are archived read-only and no longer take part in the runtime.
- New code directory: `desktop/src/room/`. The old `room-engine/` is only a reference for the historical implementation.

### 2.2 Source → Target matrix

| Old source | New target | Rule |
| --- | --- | --- |
| checkpoint project | `rooms` + primary `chats` | One project has at least one Room. Create a primary Chat when one is needed. |
| project messages / rounds | `messages` | Generate `seq` in the original order. Keep the original id references. |
| seats / roles | `chat_roles` | Keep the name, Provider, and capabilities. The Prompt goes into `role_prompt_revisions`. |
| checkpoint tasks | `tasks` | Keep the original numbers. On conflict, allocate a new number and record the mapping. |
| old assignments | `task_runs` | Map by assignment id. Do not collapse by task id. Keep attempt/status. |
| old reports | `reports` | Associate by assignment id. Do not merge multiple attempts. |
| artifactVersions | `artifacts` | Keep path/version/commit. Map the acceptance status. |
| attentions / gates | `attentions` | Keep the question, options, and answer. Discard internal gate details. |
| checkpoint/gate/seat/round state | archive | Do not migrate this as runtime state. When needed, attach it as read-only JSON. |
| v2 rooms | `rooms` | Keep workspace/providers/capabilities. Re-check write authorization against the current realpath. |
| v2 chats | `chats` | Keep title/status. The legacy mark is read-only and does not enter the new runtime path. |
| v2 agent_roles | `chat_roles` + `role_prompt_revisions` | Keep Provider/Prompt/capabilities/native_permission. Map is_captain. |
| v2 chat_context_revisions | `chat_context_revisions` | Keep revision/instructions. Keep the source IDs. |
| v2 messages | `messages` | Map author_type/status/mentions/data. A Controller note becomes a historical message. |
| v2 tasks / reports / attentions / artifacts | new tables of the same name | Map by assignment/run ownership. An Artifact keeps commit/version. |
| v2 assignments | `task_runs` | Map by assignment id. Associate the report by assignment. Do not rebuild the old Assignment model. |
| v2 controller_decisions | `events` / archive | Do not keep a decisions table. Decisions become historical audit events. |
| v2 effects | archive / convert by kind | Status alone cannot be migrated. The handler and payload of an old kind differ from the new engine. An old pending effect does not gain execution eligibility in the new engine by default. Convert according to the kind table below. |
| Trace JSONL | keep the original files | The new database stores only a reference. Re-authorize by the new Room/TaskRun. Do not rewrite historical Trace. |
| shadow Git | keep the original repository | Keep Artifact commit/diff references. Do not rewrite history. Reads follow the new Artifact authorization. |

- Old sessionRef: a Provider match alone is not enough to restore it. Scope, the working-directory realpath, the permission mode, and the Role must all be checked. Write it into `sessions` only when every check matches. Otherwise start a new session.
- Task numbers: keep the original numbers. On conflict, record a mapping table.
- Before migration, stop starting new runs. Mark an active run `status=interrupted, outcome=unknown`, and mark an active effect `unknown`. Allow retry/handoff only after process reconciliation finishes. Do not dual-write during the migration window.
- The migration tool must support dry-run, be idempotent, and be able to roll back. Write the migration report into the private area.

**v2 effect kind migration table**

| v2 kind | Handling |
| --- | --- |
| `start_assignment` | **Archive only.** The new engine creates a new `start_run` only when the migrated TaskRun is still active and the user explicitly retries. It does not consume the old effect. |
| `artifact_snapshot` | Archive by default. Convert it to a new snapshot intent only when the corresponding new TaskRun/Artifact already exists and the run has settled. Otherwise archive it and report it. |
| `stop_assignment` | Archive by default. Create a new stop intent only when the migrated TaskRun is still active/unknown and process reconciliation has confirmed it. Otherwise archive it. |
| other / unknown | Archive it and add it to the migration report. Do not execute it automatically. |

An old `pending` effect does not gain execution eligibility in the new engine just because its status is pending. Conversion must also pass the kind allowlist, confirm that the target object exists, and pass the permission, lease, and idempotency-key checks.

### 2.3 One-time migration steps

1. Stop starting new runs. Wait for in-flight writes and leases to close. Do not dual-write during the migration window.
2. Back up the old checkpoint ledger and the v2 SQLite database (copy them into a timestamped directory).
3. Read both old structures and generate a migration plan (dry-run).
4. Write the new Room/Chat/Role/Participant/Message/Task/TaskRun/Report/Artifact/Attention. Mark an active run `status=interrupted, outcome=unknown` and mark an effect `unknown`. Archive or convert old effects according to the kind table. Do not execute them by default.
5. Write the `legacy_imported` mark and the migration report.
6. Check counts, numbers, Report ownership, and Artifact/Trace references. Allow retry/handoff only after process reconciliation finishes.
7. If migration fails, roll back the new database. Leave the old database untouched.
8. After a successful migration, the old database is read-only. The UI shows only the new database.

### 2.4 What this migration does not do

- It does not dual-read old JSON and new SQLite.
- It does not run the old checkpoint engine and the new engine together.
- It does not keep a long-term "legacy mode" for an old Chat.
- It does not add old fields to the new tables in order to stay compatible with the old message format.
- It does not forge a native session restore for an old session. If a session cannot be restored, start a new session.
- It does not migrate checkpoint/gate/seat/round into the new state machine.

### 2.5 UI after migration

- Show only the new ledger.
- If old data must be shown, mark it "archived/imported" and keep it read-only.
- Remove the old project-room entry points from navigation. Delete the old components, or demote them to a history viewer.

## 3. Implementation phases

> The core loop of the room domain has already landed in `desktop/src/room/` and `RoomWorkspace`. The phases below are kept as a design record. They are no longer a plan waiting to be executed.

### Phase 0: Freeze the target and the cleanup boundary

- Freeze the target model in this directory.
- Name the old ADRs and documents that are superseded.
- List what to keep, rewrite, and delete, and the dependency order.
- Build a test skeleton for the pure functions: routing, briefing, session key, task state, and the captain review checkpoint.
- Do not write product code.

**Exit criteria:** the target model, tables, module boundaries, deletion order, and test skeleton are unambiguous.

### Phase 1: New ledger, timeline, routing, and briefing

- Create `room.sqlite` together with the schema and migrations. **Create the minimal tables first** (Room/Chat/Role/Participant/Message/Session/TaskLane/Event/Effect). Also create thin versions of the minimal Task/TaskRun/Report/Artifact/CaptainReview tables that Phase 2.5 needs. Fill in the full fields and the migration incrementally in Phase 3 and Phase 4. Do not lay all of it out at once.
- Implement repositories for Room/Chat/Role/Participant/Message/Session/TaskLane.
- Implement Message append, seq, revision, client_id, status, and edit/delete events.
- Implement routing and briefing as pure functions, with targeted tests. The briefing returns `omittedSeqs`/`truncatedIds`. Implement paginated `read_chat` for the current Chat.
- Implement the SessionStore key, baseline, and watermark. Do not connect a real CLI yet.
- Freeze the status enums and outcome definitions for Task, TaskRun, and Effect, and keep them consistent throughout the documents.

**Exit criteria:** given a set of messages and participant watermarks, the incremental briefing is correct; the same message is not delivered twice; an unfinished row blocks the watermark; session rotation does not drop the participant watermark; the status enums do not mix `failed/interrupted/waiting/unknown`.

### Phase 2: Engine, RuntimeAdapter, and resume proof

- Turn a queued reply row into a run.
- Connect the existing `invokeAgent` and `InvocationSession`. Write SQLite through the SessionStore port.
- Implement resume, create, and rotate.
- Implement the `mention` tool and the wake budget. MCP is a full tool loop. A marker supports only a single terminating action.
- Implement recovery for stop, steer, and restart (`interrupted/unknown`).
- Every process start goes through a `start_reply` effect. Effect success means the process has started or been registered. The pump does not await the whole run.
- Implement paginated catch-up through `read_chat` for the current Chat. An edit appends an event and advances `activity_seq`.

**Resume proof (hard gate):**
- Claude Code: the first prompt asks the Agent to remember a fact. The second prompt resumes the same native session and asks for that fact. Confirm that it continues the previous context. Test once after a CLI restart, and once after a long conversation or compaction.
- Codex: the same.
- Record token use, whether resume succeeded or failed, and whether context was lost after compaction.
- **If resume fails, stop Phase 2 and do not enter Phase 3. Either change back to a mode without memory, or do the platform handoff first.**

**Exit criteria:** two roles can answer at the same time; one role can mention another; after a restart, queued continues, working becomes interrupted, and the session pointer is kept; resume proof passes for both CLIs; a tool result can be returned to the running session.

### Phase 2.5: Vertical check of the architecture seam (before the full UI and schema)

Check only the hardest external CLI seam. Do not build the full UI:

```text
persistent Session
→ a real MCP tool call, with the result returned
→ create an independent Task session
→ finish_task completion claim
→ process-exit confirmation
→ Artifact snapshot/settlement
→ Captain review
```

- First create the minimal tables this chain uses: Task / TaskRun / Report / Artifact / CaptainReview / CaptainAssignment / Effect. A full UI or a full migration is not required.
- Do not use a stand-in to simulate every model response. At least one real CLI must run this chain through.
- If MCP is unavailable, verify the terminating action of the restricted marker, and state clearly that it cannot replace a full tool loop.
- Do not finish the full UI or the old-data migration before this chain runs through.

**Exit criteria:** a real CLI can complete the seam "session → tool → Task → settlement → review"; effects do not serialize concurrency; `finish_task` does not enter `in_review` before exit and snapshot.

### Phase 3: Task, TaskRun, lane, and Report

- Agent tools: `create_task`, `draft_task`, `list_tasks`, `get_task`, `read_task`, `comment_task`, `finish_task`.
- TaskRun queue, lane, writeScopes, concurrency, pump, comment continuation, and rerun. Success of a `start_run` effect means the process has started, not that the run has finished.
- Report import and Task status derivation; `accept_task` / `reject_task`.
- Separate the `finish_task` completion claim from settlement. A writing run reaches `in_review`/`blocked` only after exit confirmation, the after snapshot, and Artifact merge. A read-only run requires exit confirmation, Report validation, and `snapshot_state=not_applicable`.
- A minimal UI read model for the Task card and the Report card.
- Comments and answers for a one-shot CLI queue a continuation run.

**Exit criteria:** an Agent calls `create_task` directly by default; the Task runs in its own lane session; a comment continues the same lane; `finish_task` returns to the Chat; a Task cannot be done without a Report; a writing run cannot reach `in_review` or `accept_task` before exit and snapshot finish; a read-only run has `snapshot_state=not_applicable` and reaches `in_review` only after Report validation; writeScopes checks pass; a TaskRun outcome can express known and unknown.

### Phase 4: Captain, Captain review supervisor, and Attention

- Captain Role, Prompt revision, and the tool surface, limited to the Chat.
- `assign_in_group` sends only one visible authorization. It must not target the Captain. If there is no legal target, return an error.
- The authorization message, `captain_assignments`, and the target's queued reply are one transaction. The reply stores `captain_assignment_id`. The target creates the Task itself and cannot change the assignee.
- `captain_assignments` / `captain_reviews`. A 150ms debounce on any domain change (the fast path) plus a 60-second fallback tick. Merge only pending reviews in the same Chat. Checkpoint, dedupe, and backoff.
- Attention/Inbox aggregation, answers returned to the source, and merged notifications.
- User commands: pause/resume/stop/retry/handoff/accept_task/reject_task/answer_attention.

**Exit criteria:** when the user does not @, the message goes to the Captain; after the Captain authorizes work, the target Agent creates the Task itself; after the Task settles, the review supervisor wakes the Captain; `hasNew` uses the baseline `max(checkpoint, assignment message seq)`; an assignment reply with no Task can still produce `assignment_settled`; only reviews in the same Chat are merged; review traffic does not advance `activity_seq`; the three-stage Prompt workflow can run; neither `assign_in_group` nor review counts against the budget of 5 mentions; there is no completion wake and no separate budget.

### Phase 5: UI rewrite

- A new `RoomWorkspace`: Chat timeline, role bar, Captain Prompt editor, Captain review card, Task/Report/Attention/Artifact cards, and a Trace entry.
- Remove the selectors for concurrency, order, and automatic discussion mode.
- Remove the checkpoint/gate/seat/round entry points.
- A read-only hint on Chat replies. Show Task write authorization and writeScopes.
- Chinese and English copy, Escape/back, and a responsive layout.
- Verify Electron desktop mode.

**Exit criteria:** the user completes collaboration only through messages, roles, Tasks, Reports, Attentions, and Artifacts; old internal vocabulary does not appear; the renderer does not receive a native session reference, an absolute path, or a process handle.

### Phase 6: Migrate old data and delete the old engine

- Run the migration tool: back up, dry-run, import, check, and write a report.
- The new UI reads only the new ledger.
- Decouple and delete the old engine, the old runner, the old UI entry points, and the old schema code, in dependency order.
- Delete tests and samples that are no longer used.

**Exit criteria:** `rg` no longer finds a call site of the old engine; the full test and build suite passes; old data can be viewed read-only; `desktop/src/collaboration/` has not been overwritten by the new domain.

### Phase 7: Acceptance on real Providers

- Claude Code: a multi-role group Chat, a mention chain, Captain review, Task create and finish, comment continuation, restart recovery, and resume proof.
- Codex: at least one of the same closed loops. If the tool channel is unavailable, verify the marker fallback.
- Full checks, as in `AGENTS.md`:

```bash
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run build:desktop
npm --prefix desktop test
npm --prefix desktop run pack
```

**Exit criteria:** each target Provider has at least one real closed loop; recovery and the permission boundary pass; the old engine does not take part; there is no completion wake.

## 4. Acceptance criteria

### 4.1 Behavior

- The user @s several roles → they wake concurrently, and each answers in its own session.
- Role A mentions Role B → B receives A's body and the new messages since last time.
- A role creates a Task itself → the task lane session runs it → `finish_task` → the Chat sees the result.
- The user comments on a Task → the same lane session continues, and does not reread the task briefing. A one-shot CLI queues a continuation run.
- rerun → a new lane session, starting from zero.
- Restart → messages, tasks, reports, session pointers, and unfinished runs can be recovered. A message in `working` becomes `interrupted`. A TaskRun is `status=interrupted, outcome=unknown`. Do not forge an exit.
- Context that is too long → the briefing is bounded. Session rotation has a one-time handoff. Do not retry without a limit.
- A three-stage Captain Prompt → the review supervisor wakes the Captain stage by stage. `hasNew` uses the baseline `max(checkpoint, assignment message seq)`. Three `assign_in_group` calls are ordinary messages and do not count against the 5 mentions. Three reviews are system messages and do not count either. The 5 constrains only the Agent's `mention` tool calls. Only pending reviews in the same Chat are merged. Review rows and the review reply do not advance `activity_seq`. `post_in_chat` is the exception.

### 4.2 Governance

- Task, Role, and Chat ownership checks pass. A cross-Chat reference is rejected.
- User commands are idempotent. A repeated click does not write again. Every command that changes state carries a `commandId`.
- A Prompt cannot rewrite permissions. A write needs authorization, writeScopes, and a lease.
- The Report is the only basis for completion. Free text cannot set a Task to done. Artifact status does not complete a Task by itself.
- Attention is not duplicated. The answer returns to the original session, or to a continuation run.
- Captain tools are limited to the Chat they belong to. They cannot read or write across Chats.

### 4.3 Architecture

- The new Chat does not depend on checkpoint, gate, seat, or round.
- The new Chat does not depend on Controller batches.
- The new Chat does not read or write the old workspace JSON.
- The old engine is not on the runtime path of the new Chat.
- There is one session semantics, one message source of truth, and one UI entry.
- There is no invented completion wake, no separate completion budget, and no `stage_complete`.

## 5. Risks and responses

| Risk | Response |
| --- | --- |
| External CLI resume is unreliable | Phase 2 resume proof. On failure, stop and change the design. |
| CLI compaction drops content the platform already delivered | `last_seq` only guarantees delivery. Important facts land in a Task, Report, or Artifact. Rotation uses a handoff. |
| The tool channel is unavailable | Prefer the full MCP loop. A marker supports only a single terminating action and returns no result. An unsupported CLI is only a read-only participant. |
| The briefing cuts out something important | A 100×2000 cap, plus `omittedSeqs`/`truncatedIds`, plus `read_chat` catch-up, plus a Session Handoff, plus Task/Artifact. |
| Report parsing is unreliable | Prefer MCP tools. Markers are validated strictly. With no report, do not guess that the work is complete. |
| The effect pump serializes concurrency | ADR-N20: start success means the process has started or been registered, and the pump does not await the whole run. Concurrency is controlled by lane, machine, and lease. |
| `finish_task` settles too early | Separate the completion claim from settlement. A writing run needs exit, snapshot, and Artifact. A read-only run needs exit, Report, and `snapshot_state=not_applicable`. A failed snapshot does not settle. `accept_task` is allowed only after settlement. |
| Migration loses data | Backup, dry-run, a source→target matrix, a migration report, and rollback on failure. Handle v2, active, and unknown separately. |
| Permission or lease regression | Keep the existing security tests. The new domain can call only the existing permission layer. |
| The design grows back into a Controller | The ADRs forbid the platform from splitting tasks. `create_task` can be triggered only by an Agent tool. |
| Deleting old code causes collateral damage | Follow the dependency-order table. Decouple LocalWorkspace and ProjectService first. Each phase can be rolled back. |
| A Chat reply writes files | Chat is read-only by default. Writes happen only in a TaskRun. Before isolation, write concurrency is 1. |
| The Captain assigns itself | The Captain must not be the target. If there is no legal target, return an error. Persist the assignment causal chain. |
| A Captain review loop | The assignment-message baseline, plus checkpoint, dedupe, and idle, plus `activity_seq` excluding review traffic. The `post_in_chat` exception is constrained by the Prompt. |
| Status meanings disagree | Define Task, TaskRun, and Effect separately. A TaskRun uses outcome to express unknown. A known exit with no Report stays separate from an unknown exit. |

## 6. What this work does not do

- It does not keep a long-term dual track in which the new engine runs new Chats and the old engine runs old Chats.
- It does not keep compatibility fields whose purpose is to preserve the old schema for old data.
- It does not keep a hidden batch compatibility layer for the Controller.
- It does not keep both an Assignment model and a TaskRun model.
- It does not forge a restore of an old sessionRef.
- It does not execute an old pending effect by default. Conversion follows the kind allowlist only.
- It does not invent a Captain completion wake, a separate completion budget, or a `stage_complete` tool.
- It does not treat a text marker as a full tool loop, and it does not treat `finish_task` as settlement complete.
- The first phase does not add an isolated worktree, cross-Chat dependencies, a built-in model runtime, or a memory sidecar.
