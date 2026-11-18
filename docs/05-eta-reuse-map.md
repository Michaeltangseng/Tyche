# 05 eta reuse map

> The eta source lives in the sibling directory `eta/eta/` of this repository. This map is fixed to the local snapshot commit `03197d88`. Paths in the tables below are relative to the eta source root (for example `apps/eta/src/...` and `packages/eta-core/...`), not paths inside the Tyche repository. `apps/eta/src/tasks/session-key.ts` exists in that snapshot. If another eta version is used, the paths must be checked again.

This document answers two questions:

1. Which eta mechanisms are worth reusing?
2. How should they be reused: port the pure logic, rewrite to the semantics, use only as a reference, or not use them?

## 1. Reuse modes

| Mode | Meaning |
| --- | --- |
| **Port** | The logic is pure enough and has few dependencies. Port it directly into `desktop/src/room/`, rewrite it in CJS, and add tests |
| **Adapt** | Adopt eta's semantics, but rewrite the interface, storage, permissions, or UI to Tyche's boundaries |
| **Reference** | Read eta's implementation only to understand the boundaries and the pitfalls. Do not copy the code |
| **Reject** | It does not fit Tyche's product boundary or runtime. Do not introduce it |

## 2. Mechanism map

### 2.1 Session and context

| Mechanism | eta location | Tyche target | Mode | Notes |
| --- | --- | --- | --- | --- |
| One persistent session per (agent × conversation) | `apps/eta/src/conversations/places.ts:199-243`, `engine.ts:1081-1104` | `room/session-store.cjs` + `sessions` table | **Adapt** | Early room-engine already had `InvocationSession`. The new domain owns the SQLite pointer and the watermark |
| Create the session on the first wake, then reuse it | `docs/architecture/product-model.md` | same as above | **Port semantics** | Chat key: `chat:<chatId>:role:<roleId>` |
| Participant `last_seq` watermark | `docs/architecture/product-model.md` | `chat_participants.last_seq` | **Port** | The watermark belongs to the participant, not the session |
| Incremental briefing (original text, not a summary) | `conversations/briefing.ts` | `room/briefing.cjs` | **Port** | 100 messages × 2000 characters. An unfinished row blocks the watermark |
| Serial inside one session, parallel across sessions | `conversations/engine.ts:1011-1023` | `room/engine.cjs` | **Adapt** | Use a participant chain. An external CLI does not support mid-turn steer by default |
| Session rotation | `places.ts:214-224`, `engine.ts:1089-1103` | `room/session-store.cjs` | **Adapt** | The watermark stays on the participant/lane. Rotation does a one-shot handoff |
| Task session key | `tasks/session-key.ts` | `room/session-store.cjs` | **Adapt** | Change it to `task:<taskId>:role:<roleId>`. The executor lane is reused across runs |
| A comment continues the same task session | `tasks/runner.ts:22-53` | `room/task-queue.cjs` | **Adapt** | A one-shot CLI cannot steer. A comment queues a continuation run |
| A rerun discards memory | `tasks.md:63` | `room/task-queue.cjs` | **Adapt** | Create a new generation. Keep the old run/session |

### 2.2 Messages, wake-up, and handoff

| Mechanism | eta location | Tyche target | Mode | Notes |
| --- | --- | --- | --- | --- |
| The reply row is the wake-up and the queue | `timeline.ts`, `product-model.md` | `room/timeline.cjs` + `messages` table | **Adapt** | Add `revision`, `client_id`, `status`, and `root_message_id` |
| User-message routing (@ / steward / single member / do not guess) | `conversations/routing.ts:24-55` | `room/routing.cjs` | **Port** | The rules are pure functions. Port them directly |
| Agent mention tool | `engine.ts:811-899` | `room/tools/mention.cjs` | **Adapt** | MCP first, with a strict marker fallback. Identity is bound to the run/session |
| Wake budget of 5 | `routing.ts:13,57-67`, `timeline.ts:450-457` | `room/routing.cjs` | **Port** | Count only `kind=mention`. `assign_in_group` and Captain review do not consume this budget |
| The mention body is the handoff content | `tasks.md:99`, `engine.ts:853-884` | `mention` tool arguments | **Port semantics** | The other side cannot read a reply that is not finished yet, so the body must carry the content itself |
| Paged catch-up read of the current conversation | `read_conversation` in `captain/tools.ts` | `read_chat(beforeSeq, limit)` | **Adapt** | Limited to the current Chat. Return omitted ranges and truncation. It cannot cross Chats |
| `assign_in_group` is one visible message that includes @ | `captain/service.ts:322` | `room/captain-review.cjs` / `room/tools` | **Adapt** | Do not write it as one reply row plus one mention row. Two rows are what the `mention` tool does |
| Steer is merged into the current turn | `engine.ts:774-807` | `room/engine.cjs` | **Adapt** | Runtime capability decides queue or steer. Claude and Codex default to queue |
| Recovery after stop or restart | `engine.ts:925-1006`, `data.md` | `room/engine.cjs`, `room/recovery.cjs` | **Adapt** | Message working → interrupted. TaskRun status=interrupted, outcome=unknown. Start again only after process reconciliation |
| A chat reply also goes through an effect | (a Tyche constraint, not an eta mechanism) | `room/effects.cjs` | **Adapt** | Every process start writes an effect first |

### 2.3 Task, Captain, and review

| Mechanism | eta location | Tyche target | Mode | Notes |
| --- | --- | --- | --- | --- |
| The Agent creates the Task itself | `tasks.md:5-9` | `room/tools/tasks.cjs` | **Adapt** | Hook up Role, Provider, and permission checks |
| `create_task` creates directly | `tasks.md:5-9` | `create_task` as the default entry | **Port semantics** | `draft_task` is optional. Do not add user approval |
| The TaskRun table is the queue | `tasks/runner.ts:22-53` | `room/task-queue.cjs` + `task_runs` | **Port semantics** | Order by lane + `queued_at` + machine slot |
| Task lane (executor / mention) | `tasks/runner.ts:187-196`, `tasks/runs.ts:214-222` | `task_lanes` + `task_runs.lane_id` | **Adapt** | The executor lane and the mention lane can run in parallel. Each lane has one run at a time |
| Per-machine concurrency cap | `tasks.md:53` | Room / machine configuration | **Adapt** | Default 2. Before isolation, one writing run per Room |
| finish_task → completion claim → settlement → in_review/blocked | `tasks.md:55` | `room/tools/tasks.cjs`, `room/reports.cjs` | **Adapt** | Enter in_review only after exit confirmation and the snapshot. It becomes done only when the user calls `accept_task` |
| A comment wakes a continuation | `tasks.md:56-62` | `room/task-queue.cjs` | **Adapt** | Create a continuation run when there is no run. A one-shot CLI cannot steer |
| Captain `assign_in_group` only posts a visible authorization | `captain/tools.ts:348-376`, `tasks.md:9` | `room/tools/captain.cjs` | **Adapt** | The target Agent calls `create_task` itself |
| Captain review supervisor | `captain/supervisor.ts:28,59,77,122-127`, `captain/service.ts:863-870,946-1050,1152-1215` | `room/captain-review.cjs` + `captain_reviews` table | **Port/Adapt** | A 150ms debounce fast path on any domain change, plus a 60-second fallback. The `hasNew` baseline includes the assignment message seq. Review is allowed with no Task. Merge only reviews in the same Chat. Wake through a system message. Review traffic is not counted in activity_seq. It does not consume the budget of 5 |
| Captain proposals (new Role / group) | `captain/propose-*.ts` | `propose_role` in `room/tools/captain.cjs` | **Reference** | A Tyche Role is scoped to a Chat. The Captain cannot create one directly |
| Captain review queue | `captain/store.ts`, migrations 0047 | `captain_reviews` | **Adapt** | Borrow checkpoint, dedupe, retry, and backoff. Do not copy the global Captain |
| Inbox/ask | `inbox/*` | Attention/Inbox | **Adapt** | An answer for a one-shot CLI queues a continuation run |
| Task dependencies and subtasks | `migrations/0051/0052` | Task dependency fields | **Reference** | The first stage keeps only lightweight dependencies |

**Important distinction**: eta's Captain is globally unique (`migrations/0046-captain.sql`). Tyche uses one Captain per Chat. That is **Adapt**, not a direct reuse. Captain tools must therefore be limited to their own Chat, and must not copy `list_chats` / `read_chat`.

### 2.4 Context compaction

| Mechanism | eta location | Tyche target | Mode | Notes |
| --- | --- | --- | --- | --- |
| Threshold `min(window-16384, 64000)`, keep 20000 | `packages/eta-core/src/types/config.ts:75-79`, `eta-harness/src/estimation.ts:155-171` | Future built-in runtime | **Reference / Port** | Applies only to sessions the platform manages itself |
| Compaction plan / fold / digest | `packages/eta-compaction/src/index.ts` | Future built-in runtime | **Port** | Mostly pure algorithms. It depends on `@eta/core` types and must be decoupled from that dependency |
| The external runtime compacts itself | `docs/architecture/runtimes.md`, `manager.ts:592-593` | runtime adapter | **Reference** | The platform does not take over the CLI journal |
| Recovery from context overflow | `runs/failure-signals.cjs` | `room/engine.cjs` | **Adapt** | Rotate the session and do a one-shot handoff. Do not retry without a bound |

### 2.5 Storage, runtime, and tools

| Mechanism | eta location | Tyche target | Mode | Notes |
| --- | --- | --- | --- | --- |
| SQLite product ledger + file session | `docs/architecture/data.md` | SQLite ledger + a session owned by the CLI | **Adapt** | Reuse only the split where the DB stores the pointer and the body belongs to the runtime |
| FileSessionStore `meta.json + journal.jsonl` | `packages/eta-server/src/file-store.ts` | Future built-in runtime | **Reject (for now)** | An external CLI's session lives with the CLI. The platform must not pretend to own it |
| JsonlStorage | `packages/eta-storage-jsonl/src/index.ts` | Future built-in runtime | **Reject (for now)** | Same as above |
| Session runtime seam (OAR/ACP) | `docs/architecture/runtimes.md` | Existing CLI adapter | **Reference** | Tyche already has `invokeAgent`. ACP can be evaluated later |
| Agent tool injection | eta host tools / MCP | `room/tools` + local MCP server | **Adapt** | eta has host tools. Tyche needs its own MCP bridge or marker protocol |
| daemon / multi-machine | `apps/daemon`, `docs/architecture/machines.md` | Do not build | **Reject** | Local-first, with no required server |
| Memory sidecar | `apps/memory` | Do not build (optional later) | **Reject (for now)** | Python/PostgreSQL dependencies. Outside the first-stage boundary |
| Web UI / wire protocol / cordis | `apps/web`, `packages/eta-server` | Do not build | **Reject** | Different from the Electron/Vue architecture |

## 3. What to keep from the existing infrastructure

| Capability | Current location | Role in the new architecture |
| --- | --- | --- |
| Electron trust boundary | `main.cjs`, `preload.cjs`, `shell/*` | Unchanged |
| Native Agent invocation | `workspace/local-workspace-agent-invocation.cjs` | The layer under RuntimeAdapter |
| session resume/adopt/discard | `workspace/invocation-session.cjs` | Underlying primitives of the SessionStore port |
| CLI adapters | `agents/cli/*` | runtime adapter |
| Process registration and observation | `runs/*`, `agents/*` | Supervisor / recovery |
| Run Ledger | `runs/run-ledger.cjs` | Run records and crash recovery |
| Write lease | `runs/path-claims.cjs` | Writes under the Room root |
| Permission modes | `agents/native-permission-modes.cjs`, `agent-permission-policy.cjs` | per-seat permissions |
| Artifact snapshot/diff | `project-room/shadow-git.cjs` | Artifact |
| Report import and state derivation | `room-engine/report-importer.cjs`, `report-state.cjs` | Keep the idea, and rewrite it for the new Task/Run |
| effects/outbox | `room-engine/room-outbox.cjs`, `effect-pump.cjs` | Keep the idea, and rewrite it for the new domain |
| Supervisor liveness | `room-engine/session-supervisor.cjs` | Keep the idea, and rewrite it for the new session |
| Process reconciliation | `room-engine/process-reconciliation.cjs` | Keep |
| IPC security | `room-engine/room-ipc.cjs`, `security/*` | Keep the pattern, and rewire it |

## 4. Explicitly not reused

- eta's cordis plugin system;
- eta's WebSocket wire protocol;
- eta's Web/TUI/mobile UI;
- eta's daemon / multi-machine support;
- eta's LLM gateway / provider account system;
- eta's memory sidecar;
- eta's global Agent / project / conversation table structure (the semantics may be used as a reference; the tables must not be copied);
- eta's routine scheduler (if a routine is built later, evaluate it on its own);
- eta's globally unique Captain constraint (Tyche has one Captain per Chat).

## 5. Porting notes

1. **Language and module system**: eta is TypeScript + ESM + Bun. Tyche is CJS + Electron Node. When porting, keep only pure functions and explicit dependencies. Do not introduce a runtime dependency on `cordis`, `@eta/server`, or `@eta/core`.
2. **Types**: eta's TypeBox/Zod types cannot be used directly. Rewrite them on the Tyche side with the existing validation approach.
3. **Storage**: Do not copy eta's SQLite schema. Reuse only field semantics and constraints (for example `seq`, `last_seq`, `session_key`, and `checkpoint`).
4. **Permissions**: eta's ACP permissions default to allow-all. Tyche must keep per-seat permissions, the write lease, and main-process checks.
5. **Prompt**: eta's Prompt is product text. The structure can be borrowed, but rewrite it for Tyche's Role, Captain, and Report context. Do not expose eta's internal vocabulary to users as-is.
6. **Captain review**: eta sends the review to the Captain's direct chat and does not advance the group's `lastSeq`. Tyche has no equivalent direct chat, so it can post a Chat `system` message marked `audience=captain`. It must also maintain `chat.activity_seq`, counting only public messages, and excluding review rows with `audience=captain` and **the reply the platform creates to deliver the review** (`reviewReply=true`). `assign_in_group` / `post_in_chat` do not inherit that mark, and `post_in_chat` is public, so it may trigger review again. The `hasNew` baseline must also include the assignment message seq, or an assignment that was just sent is treated as new activity. The review body is an observation, not the full text of the previous turn. The Captain reads the actual messages through the incremental briefing. Merge only pending reviews of the same Chat.
7. **License**: eta is MIT. Tyche is Apache-2.0. When porting pure logic, keep eta's copyright and license notice, and record it in `NOTICE` / `THIRD_PARTY_NOTICES`.

## 6. Reuse priority

```text
First priority (directly determines correctness)
  routing / briefing / participant watermark / reply-row queue / task session key /
  MCP tool bridge (tool injection, result return, identity binding)

Second priority (determines usability)
  task run queue + lanes / finish_task / report / attention /
  captain review supervisor / assign_in_group

Third priority (determines long-term cost)
  compaction (managed runtime only) / inbox aggregation / captain patrol for failures/stuck

Not now
  daemon / memory / eta web / cordis / multi-machine / a completion wake of our own
```
