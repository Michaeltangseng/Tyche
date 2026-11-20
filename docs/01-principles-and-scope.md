# 01 Principles, scope, and constraints

## 1. Intent

Tyche does not try to build a new Agent. It lets the native Agents a person already uses, such as Claude Code and Codex, collaborate in a local room: they share a goal, context, tasks, artifacts, and permissions, and each Agent keeps its own ecosystem.

The room is not a workflow engine. The questions it answers are:

- How do Agents see each other's work?
- Who decides what happens next?
- How is a result recorded, accepted, and followed up?
- Where is the platform allowed to decide for an Agent?

eta is closer to these principles: the platform provides the timeline, wake-up, sessions, tasks, and reports; the Agent decides whether to create a task and how to run it; the Captain only issues a visible work authorization. The previous collaboration engine's Controller was also an Agent, but it was hidden and constrained to emit JSON actions, and it created Tasks and Assignments for the target Agent. What needed correcting was ownership of the work and the session boundary, not "replace a platform algorithm with an Agent."

## 2. Goals

1. **A Chat is a durable team workspace.** User and Agent messages share one timeline. An Agent keeps memory inside the Chat.
2. **The Agent owns the work.** The Agent creates the Task, runs it, and calls `finish_task`. The platform does not decompose the task.
3. **Context is delivered incrementally.** Each Agent receives only messages after the last one it saw, not a replay of the whole chat.
4. **A Task keeps memory.** Each lane of a Task (executor or mentioned role) has one session. The executor lane is reused across runs. Comments continue that session. Only a rerun discards the memory.
5. **Collaboration is visible.** A person can see who was woken, who is working, what the task is, what the report says, and where they are needed.
6. **Platform governance does not regress.** Permissions, write scope, processes, credentials, artifact versions, recovery, and audit stay with the platform.
7. **Rewrite when the model is wrong.** Early on, the old engine and old UI may be deleted. Two semantics are not kept just to support an old Chat.
8. **Wake-up is asynchronous.** Several @ mentions in one message start together. `mention` does not wait. The platform does not insert an implicit sequence.
9. **The Captain coordinates through the review supervisor.** The platform only checks settled Captain assignments and delivers a review. It does not keep a workflow state machine.
10. **Agent tools have a real channel.** `mention`, `create_task`, and `finish_task` must have an MCP channel or a strict marker channel. They cannot exist only in a document.
11. **Chat does not write files.** Chat replies are read-only by default. Writes happen only in an authorized TaskRun. Until workspaces are isolated, a Room has at most one writing run at a time.

## 3. Non-goals

- No required remote service, cloud message channel, or remote participant.
- Tyche is not a general Agent framework, and it does not copy eta's daemon, multi-machine model, or web product.
- No global task-dependency graph across Chats.
- Full traces, chat bodies, and Artifact contents are not stored in SQLite.
- Worktrees are not copied by default. Work stays in the Room's main directory.
- The first stage does not add a new built-in model runtime. External native Agent CLIs remain the workers.
- eta's cordis plugin system, eta-server wire protocol, and web UI are not brought into Tyche.

## 4. Anti-goals

These outcomes count as failure even if the software runs:

- Every Agent run starts from zero, and the platform keeps feeding the same context back to the model.
- The platform secretly splits or edits tasks, or decides the next step, without the user seeing it.
- Attempts of one Task do not know what the others did, and the only continuation is a copied Report.
- Two message sources, two session semantics, or two UIs are kept indefinitely so old Chats still work.
- A prompt or a chat message rewrites permissions, write scope, or credentials.
- Recovery guesses that a process has exited, or replays a write whose result is unknown.
- A person must understand checkpoint, gate, seat, round, or Controller batch in order to use the room.
- The platform keeps a hidden workflow state machine that orders stages for the Agent.
- Every finished chat reply wakes the Captain, creating noise and loops.
- Captain collaboration becomes its own completion-wake budget, stage tool, or scheduler.
- Chat replies are writable by default, and several Tasks edit the same Room directory at once.

## 5. Prefer the correct model over compatibility

The correct model comes before compatibility with old behavior:

- This is early development, so the cost of change is lowest. Do not pile on architecture to keep old logic working.
- When a new architecture is clearly better, rewrite it and drop the old one.
- Old data is migrated once or archived. There is no long-term dual read, dual write, or dual engine.
- Keep a capability because it is still correct in the new architecture, not because the code already exists.
- Deleting old code is part of delivery, not a later cleanup.

This principle is already in effect: the room has one domain model and one UI. The old dual track, one-shot sessions, and checkpoint state machine are not implementation constraints.

## 6. Constraints

### 6.1 Product and security

- A local Electron product with no required server. Agent execution stays in the main process.
- The renderer uses a narrow preload API. It must not receive executable paths, credentials, native session references, or arbitrary filesystem access.
- Writes require an explicit authorization. The write lease still exists.
- User-visible copy must support Chinese and English.
- New overlays dismiss with Escape or back, and they keep the current visual language and responsive behavior.

### 6.2 Runtime

- Workers are external native Agent CLIs. Each CLI manages its own session journal and context compaction.
- The platform stores the native session reference, the watermark, and the metadata it needs. It does not own the CLI's context.
- Incremental briefings are bounded. An ever-growing chat is not stuffed into the prompt.
- The platform does not promise that a model call runs exactly once across a crash. It promises that the committed ledger, effects, and recovery facts agree.
- **Resume must be proved first.** Until Claude Code and Codex resume is shown to continue the previous context, a persistent session is not a product promise. Phase 2 needs a proof.
- **`last_seq` is a delivery watermark, not a guarantee of model memory.** The CLI's own compaction can drop content that was already delivered. Important facts must live in a Task, Report, Artifact, or file.
- **One-shot CLIs do not support mid-turn steer.** Comments and Attention answers queue as continuation runs. They are not injected into the current run.
- **Chat replies are read-only by default.** Writes happen only in a TaskRun that has user authorization and a write scope.
- **Effect success means the process started, not that the run finished.** The pump must not await the whole run. Concurrency is controlled by lanes, machine slots, and leases.
- **MCP is a full tool loop.** A text marker supports one terminating action and is not equivalent to MCP. Captain tools need MCP.
- **`finish_task` is a completion claim, not settlement.** The Task enters `in_review` or `blocked` only after exit confirmation, the snapshot, and Artifact merge.
- **The Captain cannot assign itself.** The authorization message, the assignment, and the target queued reply are one transaction. Replies, runs, and tools bind the assignment id. Reassignment goes through a user command.

### 6.3 Stack

- The main process stays on CommonJS and Node, the Node built into Electron.
- Bun is not a runtime dependency.
- eta's TypeScript and Bun code is not imported. Port pure logic, or rewrite it to the target semantics.
- SQLite uses the existing `node:sqlite`, or the runtime already verified, with WAL, foreign keys, transactions, and migrations.

## 7. Term map

| Tyche term | eta counterpart | Meaning |
| --- | --- | --- |
| Room | project | Workspace, shared directory, artifact ledger, provider and permission boundary |
| Chat | conversation (group) | One independent team work record |
| Role / Participant | agent + participant | A role inside a Chat, bound to a provider, prompt, capabilities, and permissions |
| Captain | captain / steward | The Agent role in a Chat that routes and authorizes work |
| Message | message | A timeline row. A reply row is also the wake-up and the queue |
| Session | session | One per Chat × role. A Task has its own sessions |
| Task | task | A work item created by an Agent |
| TaskRun | task_run | One execution attempt of a Task. The table is the queue |
| Report | report / finish_task | The domain source of truth for a task result |
| Attention / Inbox | attention / inbox | Something the user has to handle |
| Artifact | artifact | A Room-level artifact version. Tasks reference it |
| Trace | session journal / activity | A read-only execution trace. The ledger stores a reference |

## 8. Success criteria

By the end of the first stage, a real Claude Code or Codex run can do all of this:

1. A user @ mentions two roles in one Chat. Each role wakes in its own session and answers.
2. One role hands off to another with `mention`. The recipient sees the handoff text and the messages since it last looked.
3. A role calls `create_task`, runs in a separate task session, and `finish_task` posts the result back to the Chat.
4. The user comments on the Task. The Agent continues in the same task session instead of starting from zero.
5. After a restart, messages, tasks, reports, session pointers, and unfinished runs recover. Tasks are not created twice.
6. The UI shows roles, messages, tasks, reports, Attention, and Artifacts without requiring the user to understand an internal state machine.
7. The user writes "mockup → architecture → implementation" in one Chat's Captain prompt and @ mentions only the Captain. The Captain issues a visible authorization for each stage. After a stage settles, the review supervisor wakes the Captain. The user does not forward each stage by hand.
8. Chat replies are read-only by default. Writes happen only in an authorized Task. Before isolation, one Room does not have two writing runs at once.

## 9. Relation to other documents

- This directory is the design record for the room domain.
- `architecture.md` at the repository root is the short map of code locations and the trust boundary. Domain detail lives here.
