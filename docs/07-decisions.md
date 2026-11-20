# 07 Architecture decision records

This file records the directional decisions for the room domain. On conflict, this file wins.

## ADR-N1: One target architecture, and a rewrite is allowed

**Context:** There are two generations of engines (the old checkpoint/V4 engine and the v2 room-engine). Keeping both tracks would give messages, sessions, tasks, and the UI two sets of semantics. This is the early stage, when the cost of change is lowest.

**Decision:** Keep one target architecture. When the new architecture is clearly better, delete the runtime dependencies of the old engine, the old UI, and the old schema. Do not build a long-term compatibility layer.

**Consequences:**
- Old data is migrated once or archived. There is no dual read.
- An old Chat does not keep a "legacy mode".
- Deleting old code is part of delivery.
- Every item that is kept must be justified because it is still correct in the new architecture, not because it has already been written.

**Supersedes:** Running the old and new engines together, and the dual-track strategy that keeps old Chats on legacy behavior.

## ADR-N2: The Agent owns the work; the platform does not decompose a large task

**Context:** v2 lets the Controller `create_task` / `assign` inside the platform, and the Worker only executes. That conflicts with the principle that a single Agent completes a large task inside its own ecosystem and the platform does not track the internal steps.

**Decision:**
- A Task can be created only by an Agent, in a Chat.
- The Captain issues only a visible work authorization. It does not create a Task for the target Agent.
- The platform validates, queues, records the Report, derives status, recovers, and audits.
- The platform does not guess a task split or completion from free text.

**Consequences:**
- `create_task` is an Agent tool, not an internal scheduling action of the platform.
- `create_task` / `assign` inside ControllerAction are retired. The Captain's `assign_in_group` only writes a message.
- The Agent decides the granularity of a Task. The platform only constrains permissions, cost, and concurrency.

**Supersedes:** The Controller creating and dispatching Tasks.

## ADR-N3: One persistent Session per Chat × Role; one Session per Task lane

**Context:** v2 starts a new native invocation for every Assignment, with `saveSession: false`. The Agent does not remember what it did last time.

**Decision:**
- Chat Session: `chat:<chatId>:role:<roleId>`. It is created on the first wake-up and reused after that.
- Task Session: `task:<taskId>:role:<roleId>`, distinguished by lane. The executor lane is reused across runs. The mention lane is independent. A rerun creates a new generation.
- The Session body is owned by the Agent runtime. The platform stores only `native_session_ref`, `baseline_seq`, `prompt_revision`, `permission_mode`, `workspace_ref`, and `skill_bindings`.
- **`last_seq` belongs to the Participant / TaskLane, not to the Session.** When a session rotates, the watermark stays on the participant or lane.

**Consequences:**
- Retry and handoff no longer stay alive by copying a Report. A later run on the same Task lane can see what it has already done.
- Rotate the session when the Provider, Prompt, permissions, working directory, or Skill changes. Rotation generates a one-time handoff.
- The platform does not read or rewrite an external CLI's journal.

**Supersedes:** Starting a new native session on every invocation and not persisting the session pointer.

## ADR-N4: Incremental briefings; do not summarize every turn

**Context:** Every time, v2 rebuilds the task, the role, and the collaboration agreement into a full prompt. The old V4 already had a delivery watermark, and v2 does not. eta shows that sending only the new messages since last time is enough, and it saves tokens.

**Decision:**
- Each participant or lane has a `last_seq`.
- On wake-up, send only messages after `last_seq` that are already complete and were written by someone else. The triggering message is always included.
- An unfinished row blocks the watermark. At most 100 messages, and 2000 characters each.
- The briefing returns the omitted `omittedSeqs` / `truncatedIds`. The Agent may call `read_chat(beforeSeq, limit)` to catch up on the current Chat. It cannot cross Chats.
- An edit appends a `message_edited` event or message and advances `activity_seq`. Changing only the revision of an old row is not visible to incremental delivery.
- A briefing is an excerpt of the original text, not a summary.
- A Session Handoff is generated only when a session is created or rotated.
- **`last_seq` is a delivery watermark, not a guarantee of model memory.** Compaction in an external CLI can drop content that was already delivered. The platform cannot observe that reliably.

**Consequences:**
- The watermark and the in-progress state have to be maintained.
- A long Chat needs a briefing cap and a handoff. The briefing is lossy, but `read_chat` is the catch-up entry. The platform cannot promise that the full history is delivered automatically every time.
- The platform does not own the external CLI's full context, and it cannot promise that the model saw the entire history.
- Important facts should land in a Task, Report, Artifact, or file, so they can be read again.

## ADR-N5: The reply row is the wake-up and the queue

**Context:** v2 uses an Assignment/effect queue table. eta uses the status of a message row as the queue as well. Two queues create status-sync problems.

**Decision:**
- One kind of reply row in the Message table is the wake-up, the queue, and the result carrier at the same time.
- Enqueue assigns `seq` immediately, with `status=queued`. While running it is `working`. When it ends it is `done/failed/stopped/interrupted`.
- `revision` increases with streaming output. `seq` does not change.
- The same participant or lane is serial. Different participants or lanes are parallel.
- On restart, queued continues. `working` / `waiting_for_input` becomes `interrupted` and waits for process reconciliation. It is not failed directly.

**Consequences:**
- The message table carries the queue. seq, status transitions, and concurrency have to be handled carefully.
- A separate business wake-up queue table is no longer needed.
- The frontend can render progress directly from the message row.

## ADR-N6: The Captain is a visible Agent role, not a platform Controller

**Context:** The v2 Controller is itself also an Agent, but it is hidden and constrained to emit JSON actions, and it owns actions such as `create_task/assign/create_role`. The user cannot see how it splits tasks, and this does not match agent-for-agent.

**Decision:**
- The Captain is a Role inside the Chat, with `is_captain=1` and its own Participant Session. `author_type=agent`, and a badge identifies it.
- Its tools are `assign_in_group`, `post_in_chat`, `create_roles`, the read tools, `request_attention`, `control_task` (continue/pause), and `set_role_prompt`.
- `create_roles` writes the same chat-role fields the user writes from the role dialog. The platform reads that record. It does not treat either writer as the sole owner of the team.
- `assign_in_group` writes one visible message and @s the target. The target Agent creates the Task itself. The Captain must not target itself. The assignment causal chain is in ADR-N21.
- Captain tools are limited to the Chat they belong to. They cannot read or write across Chats. There is no cross-Chat `list_chats` / `read_chat`. `read_chat(beforeSeq, limit)` for the current Chat is allowed.
- The Captain cannot grant permissions, change the workspace, set a Task to done or cancelled directly, or rerun or delete a Task.
- When there is no Captain, routing falls back to an explicit @mention or to the sole participant.

**Consequences:**
- The v2 `controller_decisions` batch model is retired.
- Platform validation, audit, idempotency, and effects stay, bound to visible Agent tools and user commands.
- A Captain failure does not trigger a fallback in which the platform creates a task automatically.
- One Captain per Chat is a Tyche adaptation. eta's global Captain cannot be copied as-is.

## ADR-N7: SQLite stores facts and pointers; the Session body belongs to the Runtime

**Context:** v2 puts product facts in SQLite but has no session. The old engine puts sessionRef in the workspace JSON. eta uses SQLite plus a file journal. The three approaches are mixed together.

**Decision:**
- SQLite stores Room, Chat, Role, Participant, Message, Task, TaskLane, TaskRun, Report, Attention, Artifact, Session pointers, Event, Effect, and UserCommand.
- The external CLI's session body stays in the CLI's own storage. The platform does not copy it.
- Trace is JSONL in the application private area. The database stores only a reference.
- Artifact content is a Git snapshot in the application private area. The database stores only version metadata.
- The new Chat path uses the **SessionStore port** to write SQLite. It no longer writes the session mapping in the old workspace JSON.
- `InvocationSession` stays as the native session primitive, adapted by SessionStore.

**Consequences:**
- Backup and migration have to handle SQLite, Trace, Artifacts, and the CLI's own session together.
- The platform cannot assume it can replay an Agent's full context.
- A platform-owned journal is needed only if a built-in runtime is introduced later. Define it then.

## ADR-N8: Keep the existing governance and security infrastructure

**Context:** eta's permission model is looser (ACP allows by default), and it does not have this product's Room lease, per-seat permissions, or Artifact ledger. Copying it directly would break the security boundary of the local product.

**Decision:**
- Keep the Electron main / preload / renderer trust boundary.
- Keep native permission modes, write authorization, the Room root lease, and writeScopes checks.
- Keep Artifact snapshot and diff, Report and Attention, effects and the outbox, the Supervisor, and process reconciliation.
- The new domain can only call this infrastructure. It cannot bypass it.
- The renderer receives only a display-safe DTO. It does not expose a native session reference, an absolute path, a process handle, or credentials.

**Consequences:**
- The new architecture is eta's session semantics plus this product's governance boundary.
- Tests for permissions, leases, and processes remain valid.
- The UI still does not expose sensitive execution details. If the Room root directory must be shown, that is an explicit read-only exception.

## ADR-N9: The external CLI owns its Session and its compaction

**Context:** Tyche's Worker is an external CLI such as Claude Code or Codex, not eta's built-in kernel. The platform cannot read or rewrite their context.

**Decision:**
- The platform stores only `native_session_ref`, the Provider, the baseline, and the watermark.
- resume is the runtime adapter calling the CLI's own restore mechanism.
- The CLI does its own compaction. The platform only does a bounded briefing, session rotation, and a one-time handoff.
- On context overflow, rotate the session. Do not retry without a limit.
- **Phase 2 must include a resume proof.** Claude Code and Codex each have to show that resume continues the previous context. On failure, stop and change the design.
- Port eta-compaction only when a platform-managed runtime is introduced later.

**Consequences:**
- CLIs differ in session, steer, and compaction, so a capability matrix is required.
- The platform cannot guarantee that every Agent sees the same complete history. It guarantees that each Agent receives the new messages it has not seen.
- `last_seq` is only a delivery watermark, not a memory guarantee.

## ADR-N10: One-time migration, then retire the old engine

**Context:** The old workspace JSON, the old room database, and the old checkpoint state all contain fields that do not fit the target model.

**Decision:**
- The new ledger uses a clean schema, in the directory `desktop/src/room/`.
- A one-time migration tool imports or archives the old data. After migration, the old database is read-only.
- The old engine, the old runner, and the old UI entry points are deleted after migration completes.
- If migration fails, roll back the new database. Leave the old database untouched.
- Migration must support dry-run, be idempotent, be able to roll back, and have a source→target matrix.

**Consequences:**
- A backup and a migration report are required.
- When an old session cannot be restored, the new Task starts from a new session.
- Compatibility code for the old data format is no longer maintained.

## ADR-N11: The Report is the domain source of truth for a task result; acceptance is a user command

**Context:** v2 already has a Report and status derivation. eta uses `finish_task`. The two can be aligned, but two questions have to be settled: whether accepting an Artifact equals done, and who creates the next run on `handoff`.

**Decision:**
- A Report kind includes at least `progress/ready/waiting/blocked/failed/handoff`.
- Task status is derived from the Report of the latest required run, from TaskRun facts, and from user commands.
- Without a Report, a Task cannot be set to `done`.
- Free text cannot be the basis for completion. Tools come first. A strict marker is the fallback.
- `finish_task` is a completion claim, not settlement. The Task stays `in_progress` until process exit is confirmed, the after snapshot is done, and the Artifact IDs are merged and checked. Only then does it enter `in_review` (ready) or `blocked`.
- The user's `accept_task` can be called only after settlement is complete. `reject_task` returns the Task to `todo`.
- An observed non-zero exit is `failed/outcome=known` (the exit fact is confirmed). `interrupted/outcome=unknown` is only for the case where it cannot be confirmed whether the process exited. The two cannot be merged.
- Settlement has two paths. A writing run needs exit confirmation, a completed snapshot, and Artifact/Report checks. A read-only run needs exit confirmation, Report checks, and `snapshot_state=not_applicable`. The platform sets `not_applicable` from the run's permissions. The Agent cannot report it for itself, and it cannot be a fallback for a failed snapshot.
- Artifact status (draft/published/accepted/rejected/superseded) is independent of Task status. Accepting an Artifact does not automatically mean done.
- A `handoff` Report only records a suggestion. The actual `handoff_task` is a user command.

**Consequences:**
- Report parsing and ownership checks have to be stable.
- The user commands `accept_task` and `reject_task` are required, and they carry a `commandId`.
- The user is still the one who accepts the result.

## ADR-N12: Attention/Inbox is the only channel that interrupts the user

**Context:** v2 has Attention, a Human Gate, and notifications. eta has an Inbox. Several channels leave the user unsure where to handle something.

**Decision:**
- Everything the user has to handle (blocked, in_review, a question, unknown, a permission or cost request, Artifact acceptance) goes into one Attention/Inbox.
- The same question is deduplicated deterministically. The answer returns to the original session, or a continuation run is queued according to what the runtime can do.
- Notifications may be merged. They are not popped up one by one.
- The Attention body does not contain a sensitive path, a Prompt, or credentials.
- Every answer or command that changes state carries a `commandId`.

**Consequences:**
- The UI needs one inbox, the Attention panel.
- The Attention lifecycle and idempotent answers have to be defined.
- When the user leaves the current Chat, pending items are still visible.

## ADR-N13: The Room main directory is the default workspace; Chat replies are read-only

**Context:** The user's principle is that parallel thinking may each keep a draft and the lead merges, and that two writers never write the same document. Copying a worktree by default would move the complexity of preparing the environment, merging, and publishing onto the platform.

**Decision:**
- By default, every Agent works in the Room main directory. Writes are serialized by an exclusive lease.
- **Chat replies are read-only by default** (`read-only` or `read-exec`). A write happens only in a TaskRun that has user authorization and writeScopes.
- Per-seat permissions decide who can write. `task_runs.write_scopes_json` is frozen at creation.
- An isolated worktree or a temporary workspace is a later, optional capability, used only for exploration or for a high-risk task.
- An Artifact records versions with a shadow Git commit and diff.

**Consequences:**
- Writes from different Chats in a shared directory may still contend. The platform guarantees the write lease of one Room.
- Artifact publish and accept semantics have to be clear.
- Worktree automation is not part of the first phase.

## ADR-N14: Reuse eta's mechanisms, not its runtime

**Context:** eta is TypeScript/Bun plus cordis, WebSocket, and a daemon. Tyche is CJS/Electron plus preload and a local CLI.

**Decision:**
- Port pure logic, or rewrite it to the semantics: routing, briefing, session keys, the task queue, report derivation, and the Captain review supervisor.
- Do not bring in eta's server, wire protocol, web UI, daemon, memory sidecar, or cordis plugin system.
- Do not run eta as a subprocess or a sidecar.
- Ported code keeps the MIT license notice and is recorded in NOTICE.

**Consequences:**
- It cannot be reused with a one-line import. Tests and adaptation are required.
- The product boundary, the permission model, and the UI stay Tyche's.
- eta's documents are a semantic reference, not an architecture constraint.

## ADR-N15: A Task is created directly by default; draft is optional

**Context:** The first-round goal is the full capability, without a human gate on task creation. `draft_task` is still useful, but it is not the default.

**Decision:**
- `create_task` is the default entry. When the Agent decides that the work needs its own execution, it creates the Task and enqueues it directly.
- `draft_task` stays optional. The Agent uses it when it wants the goal, the scope, or the cost confirmed first.
- The platform does not require the user to confirm a Task in advance. It still checks Role, Provider, and Chat ownership, plus permissions, concurrency, and cost.
- The result of a Task is still decided by the Report and by user acceptance. "It was not confirmed at creation" is not a reason to skip acceptance.

**Consequences:**
- The Agent has full autonomy and may create a task the user does not need. The user corrects it with stop, cancel, or a comment.
- Platform approval is not added in the name of preventing a mistaken task. If abuse shows up later, handle it through the Prompt, a concurrency or cost cap, or an optional draft policy.

## ADR-N16: Captain review reuses eta's supervisor; there is no completion wake

**Context:** A workflow defined by the Captain Prompt has to advance reliably across stages. Outside discussion proposed waking the Captain once each time a stage completes. eta already has a simpler and more mature mechanism.

**Decision:**
- Do not add a "Captain completion wake", a separate completion budget, or a `stage_complete` tool.
- Reuse eta's Captain review supervisor:
  - The 60-second tick is the fallback. **Any domain change** (a message append, a Task, a run, inbox, conversation state) triggers a 150ms debounce through `changed()`.
  - Check Captain assignments that have settled: the target has nothing queued, working, or stopping; the related Task is not still todo or in_progress and has no unfinished run; blocked and stalled are included.
  - The `hasNew` comparison:

```text
activityBaseline = max(checkpoint, public message seq of each assignment that was not cancelled)
hasNew = chat.activity_seq > activityBaseline
```

  - The `assign_in_group` message, the `captain_assignments` record, and the target's queued reply row are written in the same transaction, then `requestTick()`. The assignment message itself does not count as new activity after the assignment.
  - An assignment reply with no Task can still produce `assignment_settled`.
  - When there is a Task, the Chat message of `finish_task` advances `activity_seq` first, but the Task stays `in_progress` until settlement is complete. Review fires only after the Task enters `in_review` or `blocked`. A settlement status change also calls `requestTick()`.
  - The review row and **the reply the platform creates for this review delivery** are marked `audience=captain` and **do not count toward `chat.activity_seq`**. `reviewReply=true` is set only on that reply. `assign_in_group` and `post_in_chat` are separate public messages and do not inherit the flag.
  - Batching, checkpoint, dedupe, and attempts/backoff. Merge only pending reviews in the same Chat.
  - A review enters the Captain session as a `system` message and creates one queued reply. `mentions: []`. It does not count against the budget of 5 agent-to-agent wakes.
  - Deliver only when the Captain is idle.
- `finish_task` appends an Agent message in the source Chat and advances `chat.activity_seq`. The Task stays `in_progress` until settlement is complete, and review does not fire before the snapshot. After exit confirmation, the after snapshot, and Artifact merge, the Task enters `in_review` or `blocked`. That status change triggers `requestTick()`, and only then does the supervisor review. `in_review`, `done`, and `cancelled` are not busy, so the Captain may dispatch the next stage before the user accepts. If the user calls `accept_task` before the tick, `done` is still reviewed. `blocked` goes through `assignment_blocked`.
- The review body is an observation, not the full text of the previous stage. The Captain reads the actual public messages through the incremental briefing.
- The Captain Prompt stores a revision per Chat. The review attaches the current revision. The platform does not parse the Prompt and does not run a state machine.

**Consequences:**
- In a three-stage workflow, three `assign_in_group` calls are ordinary messages plus @. They do not write `kind=mention`, and they **do not count against the 5**. Three system reviews do not count either. The 5 constrains only the Agent's `mention` tool calls. It does not limit how many `assign_in_group` stages there are. The platform still checks concurrency and cost.
- Review rows and the review reply do not advance `activity_seq`, so they do not by themselves trigger `assignment_settled` again. `post_in_chat` is public, and it can open another round when the target is idle. An ordinary Captain summary belongs in the review reply. `post_in_chat` is only for a notice that really has to be public.
- `hasNew` compares the whole Chat's `activity_seq` and does not filter by author. A Chat with no assignment does not produce an assignment review. When an assignment that was not cancelled exists, other public activity can trigger a review too. A reply that is still queued, working, or stopping blocks review, as does a related Task that is still todo or in_progress or that still has an unfinished run.
- Loop protection comes from `activity_seq` excluding review rows and the review reply. That is not eta's direct-chat semantics. It is a necessary adaptation for Tyche delivering inside the same Chat. `post_in_chat` is public and can still open another round. That is platform behavior, and the Captain Prompt cannot guarantee it away. checkpoint, dedupe, and idle cover review traffic only.

## ADR-N17: Wake-ups between Agents are asynchronous; the platform does not serialize them implicitly

**Context:** "The Captain finishes, then calls Claude; Claude finishes, then calls Codex," which showed up in user testing, is not eta's behavior. Several @s in one message start together, and `mention` does not wait either.

**Decision:**
- Several @s wake concurrently. The same participant or lane is serial. Different participants or lanes are parallel.
- `mention` and `assign_in_group` do not wait for the other party. The caller goes on and finishes the current reply.
- The platform does not provide an implicit serial chain. Serial order comes from each stage's own `mention`, or from the Captain review supervisor waking the Captain after an assignment settles.
- The wake budget of 5 counts only `kind=mention`, per root user message. `assign_in_group` and Captain review do not count against this budget.
- The review supervisor is not a synchronous wait. It is event-driven notification.

**Consequences:**
- The user cannot expect the Captain to wait automatically for the previous stage unless the Prompt or a mention says so.
- A multi-stage workflow needs Captain review.
- The user needs to understand that @ing an executor role directly bypasses the Captain workflow.

## ADR-N18: Before isolation, one writing run per Room at a time

**Context:** A group-chat session carries the full tool set. An external CLI has Bash and can write files. Several Tasks in parallel may change the same directory. A write lease alone is not obvious enough, and it is a poor fit for the early stage.

**Decision:**
- Before workspace isolation, each Room has at most one writing TaskRun at a time.
- Read-only runs may run in parallel (at most 2 by default).
- Chat replies are read-only by default. They do not take part in write concurrency.
- Write scopes are frozen when the run is created. They must lie inside the Room root realpath. The Role's permission must allow writes. The user must already have authorized writes for the Room.
- Room write authorization cannot change while a run is in progress or while outcome=unknown.

**Consequences:**
- Early on, two Agents do not modify the same directory at the same time.
- Parallel exploration can still happen through read-only runs.
- After an isolated workspace exists, write concurrency can be relaxed.

## ADR-N19: Agent tools prefer MCP, with a strict marker as the fallback

**Context:** The design uses `mention`, `create_task`, and `finish_task` as tools, but the current code has no MCP server. The only structured protocol is the v2 Report marker. If only the Report has a channel, handoff and Task creation break.

**Decision:**
- main starts a local MCP server for each run or session. The tools include `mention`, `create_task`, `comment_task`, `finish_task`, `list_tasks`, `get_task`, `read_task`, `read_chat`, and `request_attention`.
- Identity is bound by the MCP server. author, actor, and runId inside tool arguments are not accepted.
- A tool result must be returned to the running session. MCP is a full tool loop, not a one-shot marker.
- The idempotency identity is the `callId` of one logical call, not an argument hash. The platform or MCP server generates it the first time it accepts the call and returns it in the result metadata. A retry must reuse the same `callId`.
- If the transport cannot guarantee that a retry reuses `callId`, do not promise idempotency across retries. A read tool runs every time. A write tool falls back to a domain unique key (`finish_task` per task+run; `create_task` per assignment+source message; `comment_task` needs an idempotency key from the caller).
- `args hash` only checks that the arguments of the same `callId` are consistent. A new call with the same arguments is a new call. A read tool must not return an old cache.
- Only the active run of the executor lane may call `finish_task`. The mention lane has only read, comment, mention, and ask tools.
- A CLI that does not support MCP may use a strict text marker only as a **restricted fallback**: one reply applies only one terminating action, there is no tool result to return, it cannot keep deciding after `list_tasks` or `get_task`, and the same reply cannot `create_task` and then `comment_task`.
- Captain tools (`assign_in_group`, `post_in_chat`, proposal, `control_task`) need MCP. The marker protocol has no closed loop that returns an authorization or a result.
- A CLI with no tool channel can only be a read-only discussion participant, or the user triggers the next step by hand.

**Consequences:**
- An MCP server, tool-result return, and identity binding have to be implemented. This is a hard dependency of Phase 2 and Phase 3.
- MCP support in Codex and Claude Code has to be verified. On failure, only the restricted marker can be used, and full autonomy cannot be claimed.
- Tool-call idempotency and author binding are platform invariants.

## ADR-N20: Effect success means the start is confirmed, not that the run has finished

**Context:** The design requires several roles to run at once, and every start goes through an effect. The current pump awaits the whole run. Reusing it directly would serialize concurrency and would confuse "the start succeeded" with "the run finished".

**Decision:**
- Success of a `start_reply` or `start_run` effect means only that the platform has claimed it and confirmed that **the process has started or been registered**.
- The effect pump starts the process, writes the `session_started` / ProcessRegistry record, marks the effect succeeded, and releases. It does not await the whole run.
- A long run is held by the reply row or the TaskRun. Participant or lane seriality, machine slots, and the write lease are recorded separately.
- A failed start makes the effect failed. A process that started but whose confirmation was lost makes the effect unknown and raises an Attention. The run result is written separately as reply status or TaskRun outcome.
- Concurrency is controlled by participant or lane, by machine slots, and by leases. It is not controlled by serializing the pump.
- On restart, a pending start effect may still be consumed. A running effect becomes unknown. A run whose exit is unconfirmed stays interrupted/unknown. Write operations are not replayed automatically.

**Consequences:**
- Start and run are two lifecycles. The current pump's await-the-whole-run cannot be carried over as it is.
- Who owns concurrency, recovery, and leases has to be written down before implementation.

## ADR-N21: The causal chain of a Captain assignment, and the boundary against self-assignment

**Context:** The Captain's visible authorization, the target reply, the native invocation, the tool call, and the Task need a binding that can be traced. The same role may receive several queued authorizations. The Captain might also use itself as the default target.

**Decision:**
- The visible message of `assign_in_group`, the `captain_assignments` record, and the target's queued reply row are written in the same transaction, then `requestTick()`.
- Each target reply row stores `captain_assignment_id`. The run, the MCP tool server, and `create_task` inherit the assignment id from that reply or run. They do not infer it from "that role's most recent assignment".
- A Task triggered by a Captain assignment is executed by the receiver. `create_task` cannot change the assignee to another role. The user can reassign later with `handoff_task`.
- `assign_in_group` must not target the Captain. When the target is omitted, it defaults to the other role only when there is exactly one active role that is not the Captain. Zero or more than one both return an error. It does not fall back to the Captain.
- When the same role has several queued assignments, each reply row keeps its own assignment id. After a restart, the source chain can still be recovered.

**Consequences:**
- A Task is not attached to the wrong authorization because of "the most recent assignment".
- There is no loop in which the Captain wakes itself or assigns itself.
- The authorization source chain is a persistent fact of the Task and the Run. It is not a guess from the Prompt.

## First-round implementation choices (2026-11-17)

| Question | Choice | ADR |
| --- | --- | --- |
| 1. Worker runtime | The first phase connects only external CLIs | ADR-N9 |
| 2. Captain granularity | One Captain Role per Chat | ADR-N6 |
| 3. Task creation | `create_task` directly by default; `draft_task` is optional; no extra user approval | ADR-N2 / ADR-N15 |
| 4. Platform Controller | Do not keep a hidden Controller | ADR-N2 / ADR-N6 |
| 5. Report channel | MCP `finish_task` first; a marker is only a restricted fallback | ADR-N11 / ADR-N19 |
| 6. Task acceptance | completion claim → settlement (exit + snapshot) → `in_review` → the user accepts → `done` | ADR-N11 / ADR-N12 |
| 7. Captain coordination | the eta review supervisor; no completion wake | ADR-N16 / ADR-N17 |
| 8. Watermark ownership | the participant or lane, not the session | ADR-N3 / ADR-N4 |
| 9. Chat permissions | read-only by default; writes only in a TaskRun | ADR-N13 / ADR-N18 |
| 10. Tool channel | a full MCP loop; a marker supports only a single terminating action | ADR-N19 |
| 11. Effect lifecycle | success means the start is confirmed, not that the run has finished; the pump does not await the whole run | ADR-N20 |
| 12. Assignment causality | the authorization message, the assignment, and the queued reply are one transaction; the reply stores the assignment id; self-assignment and changing the assignee are forbidden | ADR-N21 |
| 13. finish_task | the completion claim is separate from settlement; `in_review` only after exit confirmation and the snapshot | ADR-N11 |
| 14. A CLI that does not support MCP | read-only participation, or a restricted marker terminating action; full autonomy cannot be claimed | ADR-N19 |

## Absorbed review comments

| Review issue | Resolution |
| --- | --- |
| Agent tools have no transport channel | ADR-N19. Documents 02 and 04 add the MCP and marker sections. |
| Restart recovery conflicts with the anti-goal | 03 section 6.4 is changed to interrupted/unknown plus Attention. Start again only after process reconciliation. |
| The Task acceptance state machine contradicts itself | ADR-N11. Document 04 adds the state-transition table, accept_task, reject_task, and Artifact independence. |
| Ownership of the session pointer is split | ADR-N7. The SessionStore port writes SQLite. The new path does not write workspace JSON. |
| The schema lacks TaskActivity, revision, client_id, lane, required, and writeScopes | The schema in 02 is filled in. |
| An external CLI does not support a comment or answer in the same turn | 03 and 04 specify a queued continuation run, and a capability matrix. |
| The Captain can reach across Chats | ADR-N6. Tools are limited to the Chat they belong to. |
| The deletion plan does not close | 06 adds the dependency order, the directory change, and the LocalWorkspace/ProjectService decoupling. |
| Tool and Report idempotency, and author binding | ADR-N19. Document 04 covers tool transport. Document 05 explains it. |
| Migration is only a sketch | 06 adds the source→target matrix, dry-run, and rollback. |
| The renderer path invariant | ADR-N8. Documents 02 and 07 define the display-safe DTO. |
| The two-line description of `assign_in_group` is wrong | 03, 04, and 05 are corrected to one message that carries @. |
| The table that holds `last_seq` is inconsistent | ADR-N3 and ADR-N4. It is unified onto the participant or lane. |
| A Chat reply calls invokeAgent directly | 02 and 03 are changed to a start_reply effect. |
| The completion wake is over-designed | ADR-N16. It is changed to the eta review supervisor. |
| resume is unproven | ADR-N9. Phase 2 proof gate. |
| `hasNew` is missing the assignment-message watermark | 03, 04, 07, and 08 are changed to `activityBaseline = max(checkpoint, assignment message seq)`. |
| The 150ms trigger was written too narrowly | Changed to any domain change (message append, Task, run, inbox, conversation state). |
| Batching across Chats | Changed to merge only pending reviews in the same Chat. |
| Review traffic and the `post_in_chat` exception | `reviewReply=true` is set only on the reply delivered for the review. `post_in_chat` is public and may trigger again. |
| The moment of Effect success is undefined | ADR-N20. Success means the process has started or been registered, and the pump does not await the whole run. |
| The marker protocol cannot stand in for a full tool | ADR-N19. MCP is a full loop. A marker supports only a single terminating action and returns no result. |
| Settlement for `finish_task`, exit, and snapshot is missing | ADR-N11. Completion claim → exit confirmation → snapshot → settlement → in_review / accept_task. |
| The Captain assigns itself | ADR-N21. The Captain must not be the target. If there is no legal target, return an error. |
| The assignment causal chain is incomplete | ADR-N21. The authorization message, the assignment, and the queued reply are one transaction. The reply, the run, and the tool bind the assignment id. Changing the assignee is forbidden. |
| After the briefing is cut, there is no way to catch up | 02 and 04 add paginated `read_chat` for the current Chat. An edit produces new activity. |
| Task, TaskRun, and Effect statuses do not close | 04 unifies Task status, TaskRun status plus outcome, and the Effect lifecycle. |
| Migration does not cover v2, a live execution, Trace, or Artifact | 06 adds v2 source→target, handling for unknown and active, and checks for Trace, shadow Git, and the session. |
| An old pending effect cannot be migrated by status alone | 06 adds the effect kind migration table. An old pending effect does not gain new execution eligibility by default. |
| The Controller was described as a platform algorithm | Correction: the Controller itself is also an Agent, hidden and constrained to emit JSON. |
| The wording about sidecar and local-first is inaccurate | Correction: a local sidecar does not necessarily violate local-first. It is not chosen because of the cost in runtime, data, permissions, and packaging. |
| The path of eta `session-key.ts` was questioned | The file exists in the local eta snapshot `03197d88`. Document 05 pins the reference commit. |
| The review trigger sentence still fires at `finish_task` | 03, 04, and ADR-N16 are changed: `finish_task` only advances activity_seq. After the Task settles it enters in_review or blocked, and only that status change reviews. |
| ADR-N16 said "checkpoint already covers loop protection" | Changed to platform protection in which activity_seq excludes review traffic. post_in_chat may still trigger again. |
| 03 section 2.1 said every Captain review reply is marked reviewReply | Changed so that only the reply the platform creates for the review delivery is marked. |
| ADR-N6 said "do not provide read_chat" | Changed to: do not provide a cross-Chat read. `read_chat` of the current Chat is allowed. |
| Phase 2.5 lacks Task, Report, and Artifact tables | Phase 1 creates the thin versions first. Phase 2.5 names the minimal tables. |
| Tool idempotency by argument hash would swallow a legal repeated call | Changed to a logical callId. The argument hash checks only the same call. Read tools are not cached. |
| A known failure was classified as an unknown exit | An observed non-zero exit is failed/outcome=known. unknown is only when the exit cannot be confirmed. |
| A read-only Task has no snapshot settlement branch | A writing run takes a snapshot. A read-only run uses snapshot_state=not_applicable, set by the platform. |
| "A reply from a role that was not assigned does not trigger" promises more than the algorithm | Changed to eta's behavior: hasNew compares the whole Chat activity_seq and does not filter by author. |
| An old pending effect is migrated and executed directly | 06 adds the effect kind migration table. An old pending effect does not gain new execution eligibility by default. |

## Superseded decisions

| Old decision | New decision | Reason |
| --- | --- | --- |
| The Controller creates and dispatches Tasks | ADR-N2 / ADR-N6 | The platform does not decompose a large task |
| A one-shot native invocation, with no persisted session pointer | ADR-N3 / ADR-N4 | The Agent needs continuous memory and incremental context |
| The old and new engines coexist for a while | ADR-N1 / ADR-N10 | This is the early stage; avoid a dual track |
| An old Chat keeps legacy behavior | ADR-N1 / ADR-N10 | One target architecture |
| The first version does not add cross-Chat dependencies | Kept | This file does not change that scope |
| Room main directory plus a hidden auxiliary directory | ADR-N13 / ADR-N18 | Keep the main directory. Add read-only Chat replies and a write concurrency of 1. |
| An invented Captain completion wake | ADR-N16 | Reuse the eta review supervisor and avoid over-design |
