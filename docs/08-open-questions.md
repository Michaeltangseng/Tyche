# 08 Open questions

This file records choices that are not yet frozen but will affect implementation. Each item gives a recommendation. After it is approved, write it into `07-decisions.md` or the implementation plan.

## Decided (2026-11-17)

The following 6 items have been confirmed by the user. The implementation plan follows them. The options are kept to record the tradeoff.

### Q1. Worker runtime scope: external CLIs only, or a built-in runtime as well?

**Decided: the first stage connects only external CLIs.**

- **Option A (chosen)**: The first stage connects only external CLIs (Claude Code, Codex, and others). The platform does not own the session body or compaction.
- **Option B**: Also build a platform-managed runtime that uses eta's journal/compaction.
- **Impact**: B significantly increases the amount of implementation, and it introduces a whole set of responsibilities: the platform's own model calls, tools, journal, and compaction. A fits the product position of reusing the Agent the user already has.

### Q2. Captain configuration granularity

**Decided: one Captain Role per Chat.** It is created by default when a Chat is created, and the user can replace it.

- **Option A (chosen)**: One Captain Role per Chat. It is created by default when a Chat is created, and the user can replace it.
- **Option B**: One Captain per Room, with memory across Chats.
- **Impact**: B lets the context and permissions of different Chats contaminate each other. A matches "a Chat is an independent work record."

### Q3. Task creation policy: default to draft, or direct?

**Decided: `create_task` directly by default. `draft_task` stays optional. The first round does not add a user-approval limit on task creation.**

- **Option A**: Default to `draft_task`, and enqueue after the user confirms. When the user explicitly says "do it directly / start implementation" in a message, the Agent may use `create_task`.
- **Option B (chosen)**: Default to `create_task`. Use `draft_task` only when the Agent wants to confirm the goal, scope, or cost first.
- **Reason chosen**: Ship the full capability in the first round, and do not add a human gate on task creation. The platform still keeps the permission, concurrency, cost, and safety boundaries.

### Q4. Keep a platform-level Controller?

**Decided: do not keep a hidden Controller.** The Captain is a visible role. Routing rules are pure functions. User commands and Agent tools all go through public entry points.

- **Option A (chosen)**: Do not keep a hidden Controller. The Captain is a visible role. Routing rules are pure functions. User commands and Agent tools all go through public entry points.
- **Option B**: Keep a platform router that only routes messages, does not create Tasks, and does not split tasks.
- **Reason chosen**: A fits agent-for-agent better. If deterministic routing is later shown to be necessary, add a component that only routes and does not create tasks, and write it into an ADR.

### Q5. How a Report is produced

**Decided: prefer the MCP tool `finish_task`. When it is not supported, use a strict text-marker fallback.**

- **Option A (chosen)**: Prefer injecting the MCP tool `finish_task`. A CLI that does not support MCP uses a strict text-marker fallback.
- **Option B**: Accept text markers only.
- **Option C**: Accept tool calls only.
- **Reason chosen**: A has the best compatibility. B is simple but fragile. C demands more from the CLI.

### Q6. Task acceptance: the user accepts by hand, or it can become done automatically?

**Decided: `ready` → `in_review` → the user accepts → `done`. Human acceptance stays the default.**

- **Option A (chosen)**: `finish_task(ready)` → settlement (exit confirmation + snapshot) → `in_review` → the user calls `accept_task` → `done`. Automatic acceptance is a later option, not the first-round default.
- **Option B**: `ready` goes directly to `done`, and the user can reject afterward.
- **Reason chosen**: One core value of the project room is a result that can be inspected. Human acceptance stays the default.

## Decisions added after review

These are not open. They are already written into `07-decisions.md`. They are listed here so a review can compare them.

### D1. Captain coordination reuses the eta review supervisor, and does not add a completion wake

- Do not add a completion wake, a separate completion budget, or a `stage_complete` tool.
- The supervisor's 60-second tick is the fallback. A 150ms debounce on **any domain change** (message append, Task, run, inbox, conversation state) is the fast path.
- `hasNew` uses `activityBaseline = max(checkpoint, the public message seq of each assignment that has not been cancelled)`, then compares `activity_seq`. The assignment message itself does not count as new activity after the assignment.
- The `assign_in_group` message, `captain_assignments`, and the target queued reply are written in the same transaction, then `requestTick()`.
- An assignment reply that has no Task can still produce `assignment_settled`. `hasNew` compares the whole Chat's `activity_seq` and does not filter by author. A Chat with no assignment does not produce an assignment review. When an assignment that has not been cancelled exists, other public activity can also trigger one. A reply that is still active, a related Task that is still todo/in_progress, or an open run blocks it.
- When there is a Task, the Chat message from `finish_task` advances `activity_seq` first, but the Task stays `in_progress` until settlement. Review fires only after the Task enters `in_review`/`blocked`.
- The review row and **the reply the platform creates to deliver this review** are marked `audience=captain` and are not counted in `activity_seq`. `reviewReply=true` is set only on that reply. `assign_in_group` / `post_in_chat` do not inherit it.
- `post_in_chat` is public. When the target is idle, it can still trigger the next round. The Captain's ordinary summary belongs in the review reply. `post_in_chat` is only for a notice that truly needs to be public.
- The review body is an observation, not the full text of the previous turn. The Captain reads the actual public messages through the incremental briefing.
- Review enters the Captain session as a `system` message and does not consume the agent-to-agent budget of 5. `assign_in_group` does not consume the 5 either. The 5 constrains only `mention` tool calls.
- Merge only pending reviews of the same Chat.
- See ADR-N16. The implementation reference is `eta/apps/eta/src/captain/supervisor.ts` and `captain/service.ts`.

### D2. The watermark belongs to the participant/lane, not the session

- `chat_participants.last_seq` and `task_lanes.last_seq`.
- `sessions.baseline_seq` records only where the session starts.
- Rotating a session does not drop the watermark.

### D3. A Task session is distinguished by lane and role

- `chat:<chatId>:role:<roleId>`.
- `task:<taskId>:role:<roleId>`. The executor lane is reused across runs. The mention lane is independent.
- A handoff to another Role creates a new lane and session, and does not inherit the previous executor's memory.

### D4. Every process start goes through an Effect

- Chat reply: a `start_reply` effect.
- TaskRun: a `start_run` effect.
- Enter running only after the effect succeeds. unknown is not replayed automatically.

### D5. Chat replies are read-only by default. Writes happen only in a TaskRun

- A Chat reply is `read-only` / `read-exec`.
- A write requires Room authorization, Role write permission, non-empty writeScopes, and a lease.
- Before isolation, each Room has at most one writing TaskRun at a time. Read-only runs can run in parallel.

### D6. The Agent tool channel prefers MCP, with a strict marker fallback

- `mention` / `create_task` / `comment_task` / `finish_task` must all have a channel.
- Identity is bound to the run/session. The idempotency identity is a logical `callId` generated by the platform/server. A retry reuses the same ID. The parameter hash only checks that the parameters of the same ID stay consistent.
- Only the active run on the executor lane can call `finish_task`.

### D7. Task acceptance is a user command

- Add `accept_task` / `reject_task`, carrying `commandId`.
- Artifact status is independent of Task status.
- A `handoff` Report only records a suggestion. The actual handoff is the user's `handoff_task`.

### D8. Effect success means the start is confirmed, not that the run has finished

- Success of `start_reply` / `start_run` only means the process has started or been registered. The pump does not await the whole run.
- A long run is held by the reply or the TaskRun. Lane serialization, the machine slot, and the lease are recorded separately.
- See ADR-N20.

### D9. MCP is a full tool loop. A marker is only a limited fallback

- MCP returns the tool result. The idempotency identity is a logical `callId` generated by the platform/server, and a retry reuses the same ID. The parameter hash only checks that the parameters of the same ID stay consistent. A new call with the same parameters is a new call. Read tools do not cache an old result.
- A marker supports only one terminal action per reply, and it returns no result. Captain tools require MCP.
- See ADR-N19.

### D10. finish_task is a completion claim, not settlement

- The Task enters `in_review`/`blocked` only after exit confirmation, the after snapshot, and Artifact merge and validation.
- `accept_task` can be called only after settlement is complete.
- An observed non-zero exit is `failed/outcome=known`. Only an exit that cannot be confirmed is `interrupted/outcome=unknown`. The two must not be merged.
- A read-only task has no snapshot: exit confirmation plus Report validation is enough. The snapshot state is `not_applicable`, determined by the platform. It is not self-reported by the Agent, and it is not a fallback for a failed snapshot.
- See ADR-N11.

### D11. The Captain must not assign to itself. The assignment causal chain is persisted

- `assign_in_group` must not target the Captain itself. If there is no legal target, return an error.
- The authorization message, `captain_assignments`, and the target queued reply are one transaction. The reply stores `captain_assignment_id`.
- A task authorized by the Captain must not change the assignee to another Role. Reassignment goes through the user's `handoff_task`.
- See ADR-N21.

### D12. The briefing is lossy, but there is a catch-up read

- The briefing returns `omittedSeqs` / `truncatedIds`. `read_chat` reads only the current Chat's history.
- An edit appends an event and advances `activity_seq`.
- See ADR-N4.

### D13. Task, TaskRun, and Effect states are separate and closed

- A Task has no `failed` or `interrupted`. Failure is a TaskRun fact.
- A TaskRun uses `status + outcome` to express "exited but not reported" and "exit unknown".
- An Effect uses pending/running/succeeded/failed/unknown to express the side effect.
- See the state-transition table in 04.

### D14. Migration covers v2 and active execution

- Both sources are mapped: the old checkpoint and v2 SQLite.
- Active runs and effects are not migrated as running. Mark them interrupted/unknown, and reconcile processes first. An old pending effect does not become executable merely because of its status. `start_assignment` is archived. `artifact_snapshot` / `stop_assignment` are converted only when the target object and reconciliation are satisfied. An unknown kind is archived.
- Trace, shadow Git, and Artifact references are kept and mapped under the new TaskRun authorization. An old session is restored only when the Provider, scope, directory, and permissions all match.
- See 06 section 2.2.

### D15. The Controller itself is also an Agent

- The v2 Controller is not a deterministic algorithm. It is an Agent that was hidden and constrained into a JSON action generator.
- What the refactor changes is ownership of the work and the session boundary: "the hidden Controller creates the Task" becomes "the visible Captain authorizes, and the executing Role creates the Task itself."
- It is not a simple swap from platform orchestration to Agent orchestration.

### D16. A local sidecar does not necessarily violate local-first

- The sufficient reasons for not choosing the eta host sidecar are the required Bun runtime, the dual model of data and permissions, and the packaging and operations cost. The reason is not that a local process fails to be local-first.
- See option C in the README.

### D17. eta reference snapshot

- This map is fixed to the local eta commit `03197d88`. `apps/eta/src/tasks/session-key.ts` exists in that snapshot.
- When the eta version changes, the paths and mechanisms must be checked again. Do not keep the old citations.

## Must verify before Phase 2

### Q18. Does resume in Claude Code / Codex actually continue the previous context?

This is not a documentation choice. It is a hard gate.

- For each CLI, do this once: prompt A asks the Agent to remember a fact → resume → prompt B asks for the fact.
- Then test after a CLI restart, after a long conversation or compaction, and after a permission or Prompt change.
- Record token use and failure modes.
- If resume is only a new prompt with no memory, stop Phase 2 and change the design:
  - either accept no memory and carry the recent context every time;
  - or the platform generates the handoff and does not promise native memory.

### Q19. MCP server boundary and authentication

- main starts an MCP server for each run or session, and listens only on loopback.
- Still to decide:
  - one server per run, or one per session;
  - how the CLI obtains the endpoint and token;
  - timeout, cancellation, and idempotency of tool calls;
  - the token and credentials must not be exposed in the CLI prompt or in logs.
- Recommendation: one short-lived server per run. Pass the token only through a controlled environment variable. It expires when the run ends.

### Q20. What to do with a CLI that supports neither MCP nor markers

- Recommendation: it participates only as a read-only discussion member. It cannot create a Task, cannot mention, and cannot call `finish_task`.
- The user triggers the next step by hand, or switches to a CLI that supports tools.
- Do not treat a free-text @ as a dispatch.

## Can be decided in Phase 2 or Phase 3

### Q7. How deep old-data migration goes

- **Recommendation**: Import Room, Chat, Message, Task, Report, and Artifact references in one pass. Do not import checkpoint, gate, seat, or round state. Do not fabricate an old native session.
- **Open**: Import every old message, or only the latest N and archive the rest.
- **Impact**: Importing everything makes the new database large. Importing only the latest N loses the ability to read the history.

### Q8. Who generates the Session handoff

- **Recommendation**: A platform template, plus an optional supplement from the Captain. The platform template includes the Chat goal, the current context revision, open Tasks, and recent messages. The Captain can write a handoff paragraph when the session rotates.
- **Open**: Whether a handoff generated by the Captain counts as one model call, and whether it consumes the Captain's review and wake budget.
- **Impact**: A handoff written by the Captain is more natural, but it adds cost and latency.

### Q9. Does an Agent comment wake the executor

- **Recommendation**: A comment from another Agent goes into TaskActivity. The executor lane's session reads it on the next continuation run. Do not wake a one-shot CLI that is already running.
- **Open**: Whether comments between Agents need a rate limit.
- **Impact**: No limit can form a conversation loop. A limit that is too strict slows collaboration.

### Q10. Scope of Task dependencies and subtasks

- **Recommendation**: The first stage supports only `parent_task_id`, `blocked_by_task_ids`, `required_artifact_ids`, and `optional`. Do not build a dependency graph across Chats.
- **Open**: Whether the UI shows a task tree, or only a list.

### Q11. When to isolate the workspace

- **Recommendation**: After Phase 5. First get the Room's main directory, the lease, and Artifacts working.
- **Open**: Whether isolation is a worktree, a temporary directory, or both.
- **Impact**: Introducing it too early pulls environment preparation, merge, and release complexity forward.

### Q12. Default choice of Role and Provider

- **Recommendation**: When a Chat is created, the user explicitly chooses the Provider and the Role. The Captain uses the Provider the user specifies.
- **Open**: When no Provider is available, whether a read-only Role marked unconfigured may be created.

### Q13. Cost and concurrency bounds

- **Decided**: Before isolation, each Room has at most one writing TaskRun at a time. Read-only runs default to at most 2.
- **Open**: The model-call cap for a single Task or run, the maximum number of active Roles, and whether going over the limit creates an Attention or rejects outright.

### Q14. Multi-machine / daemon

- **Recommendation**: Do not build it. Tyche is a local Electron product. Running across machines is outside the first stage.
- **Open**: If it is built later, whether to reuse eta's daemon semantics.

### Q15. Memory and knowledge sources

- **Recommendation**: The first stage does not add memory across sessions. Keep the existing Skill and knowledge-source capability.
- **Open**: Later, whether to adopt the semantics of eta's memory sidecar, or keep Tyche's existing knowledge connector.

### Q21. Cadence of Captain review

- **Recommendation**: Keep eta's 150ms debounce on a domain change as the fast path. The 60-second tick is only the fallback when there is no new event. Batch 20 items / 12k characters.
- **Open**: Whether Tyche needs a faster tick (for example 10 seconds) so it feels more responsive, and whether it is configured per Chat.
- **Note**: Do not fall back to waking as soon as each Task completes, or waking on every chat reply. Review only when the assigned Role's reply has ended and is idle, and the review conditions are met.

### Q22. Task numbers during migration, and which Report they belong to

- **Recommendation**: Keep the old Task numbers. On a conflict, allocate a new number and record the mapping. Migrate a Report by assignment id. Do not fold Reports by task id.
- **Open**: Whether the old checkpoint's gate, seat, and round need to be readable in the archive, or only the raw JSON is kept.

### Q23. Whether the renderer shows the Room root directory

- **Recommendation**: By default, show only the Room name and a relative path. If an absolute path must be shown, show it as an explicit read-only string, and do not provide filesystem capability.
- **Open**: Whether the settings page shows the full path of the current working directory.

### Q24. Concrete format of the MCP call ID and the idempotency key

- **Recommendation**: The idempotency identity is the `callId` of one logical call, not a parameter hash. The MCP server generates it the first time it accepts the call, and returns it in the result metadata. A retry must reuse the same `callId`.
- **If the transport cannot guarantee that a retry reuses `callId`**: a read tool runs every time. A write tool falls back to a domain unique key (`finish_task` per task+run; `create_task` per assignment+source message; `comment_task` needs an idempotency key from the caller).
- **Open**: Whether to keep a call ID supplied by the CLI as an auxiliary field, but not as the unique key.

### Q25. What to do when the snapshot fails after finish_task

- **Writing**: snapshot failure → `snapshot_state=failed`. The Task stays `in_progress`/`blocked`, and the Report is kept. Create an Attention. Do not enter `in_review`, and do not release the lease.
- **Read-only**: there is no snapshot → `snapshot_state=not_applicable` (the platform determines this from the run's permissions). Exit confirmation plus Report validation is enough to enter `in_review`.
- **Open**: For a writing task, whether the user may accept a result that has no snapshot, or must retake the snapshot or abandon this artifact.

### Q26. Pagination and edit policy for read_chat

- **Recommendation**: Page backward by `seq`. Return `omittedSeqs` and `truncatedIds`. An edit appends a `message_edited` event.
- **Open**: Whether an exact read by message ID is needed, and whether an edit keeps the old version for audit.

### Q27. Migration cutover for active v2 execution and unknown effects

- **Recommendation**: Stop starting new runs before migration. Mark active runs and effects `interrupted/unknown`. Reconcile processes first, then let the user retry or hand off.
- **Open**: Whether the user may keep using the old v2 page during the migration window (recommended: no, to avoid dual writes).

### Q28. Final names of the status enums

- **Recommendation**: Task: `backlog/todo/in_progress/in_review/blocked/done/cancelled`. TaskRun: `queued/starting/running/completed/failed/interrupted/cancelled` plus `outcome: pending/known/unknown`. Effect: `pending/running/succeeded/failed/unknown`.
- **Open**: Whether the UI needs an extra "settling" display for the span between the completion claim and settlement, or reuses `in_progress` plus the Report card.

## Naming and documents

### Q16. User-visible terms

- **Recommendation**: Keep using Room / Chat / Role / Task / Report / Attention / Artifact.
- **Avoid**: Internal words such as Controller, Assignment, Checkpoint, Gate, Seat, Round, Batch, Briefing, and Completion wake appearing in the user interface.
- **Open**: In English copy, whether to keep Captain, or call it Coordinator / Lead.

### Q17. What to do with the old documents

- **Decided**: Outdated product definitions and implementation notes have been removed from the repository. This directory is the design description of the room domain. `architecture.md` at the repository root is a short code map.

## Decision record template

After an item is decided, add an ADR to `07-decisions.md`:

```text
## ADR-N<x>: <title>

**Background:** ...
**Decision:** ...
**Consequences:** ...
**Supersedes:** <old document / old ADR>
```
