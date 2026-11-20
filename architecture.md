# Architecture

Tyche is a local Electron desktop application. People collaborate in a Room: a Room is bound to a local directory and contains Chats. Each Chat has roles, and one of them is the Captain. The platform stores the room, messages, tasks, reports, permissions, and recovery facts. An Agent decides whether to create a task and how to carry it out.

There is no account system, tenant model, required application server, or remote conversation store. Optional Agent and Connector capabilities stay behind the main-process trust boundary and stay disabled until configured.

## Trust boundary

| Layer | Responsibility |
| --- | --- |
| Vue renderer | Room workspace: timeline, roles, tasks, reports, Attention, files, trace, and usage. It does not hold executable paths, credentials, or native session references. |
| Preload | Exposes only narrow, validated APIs such as `teamRoom`. Returns display-safe DTOs. |
| Electron main | IPC authorization, the SQLite ledger, processes, write scope, credentials, and recovery. Agents start only here. |
| Native Agent CLI | Claude Code, Codex, and the other CLIs keep their own session text and model context. The platform stores pointers and watermarks only. |

The renderer cannot start a process from a path, and it never receives a token or an unrestricted shell. Secrets go only to operating-system secure storage.

## Collaboration model

The platform owns these facts: Room, Chat, Role, Participant, Message, Task, TaskRun, Report, Attention, Artifact references, Session pointers, Captain review, and Effect.

The platform does not:

- split a large task for an Agent, or track the Agent's internal steps;
- hide a scheduler. The Captain is a role in the Chat, and its authorization is written on the timeline;
- treat one task attempt as a brand-new session. Each Chat × role has a persistent session, and each Task lane has its own session;
- replay the whole chat on every wake. Each participant or lane has a `last_seq` and receives only what arrived after that watermark;
- keep a checkpoint, gate, seat, or round state machine.

One collaboration runs like this:

```text
User message / Agent mention / Captain authorization
  → the message is written to the Chat timeline first
  → wake rules (@ member / Captain / single member)
  → that participant's or lane's persistent session
  → incremental briefing after the watermark
  → the Agent create_task / runs / finish_task itself
  → TaskRun queue, continued on the task lane session
  → the Report is recorded and the Task status is derived from it
  → Attention or Artifact
  → after a Captain assignment settles, the review supervisor wakes the Captain
```

Chat replies are read-only by default. Writes happen in an authorized TaskRun. The Room `write_authorized` flag is wired to the host and the UI. It is not yet wired to the execution lease. Current run permissions are still a development setting and need a separate review before production.

The room runtime adapter launches any provider in OAR's default runtime registry. Providers outside that registry stay on the local-workspace path and cannot speak in a chat.

## Where the code lives

The room domain is `desktop/src/room/`:

| Module | Responsibility |
| --- | --- |
| `db.cjs` / `schema.cjs` / `repository.cjs` | SQLite ledger, tables, and domain reads and writes |
| `timeline.cjs` / `routing.cjs` / `briefing.cjs` | Message sequence, wake rules, incremental briefing |
| `session-store.cjs` | Pointers for Chat sessions and Task sessions |
| `engine.cjs` / `task-queue.cjs` / `settlement.cjs` | Reply runs, the task queue, and settlement |
| `captain-review.cjs` / `supervisor.cjs` | Captain review and wakes after domain changes |
| `effects.cjs` / `recovery.cjs` / `domain-idempotency.cjs` | External side effects, restart recovery, idempotency |
| `runtime-adapter.cjs` / `runtime-events.cjs` / `runtime-processes.cjs` | Native CLI runs, live events, process reaping |
| `read-model.cjs` / `room-host.cjs` / `room-service.cjs` | Display read model, production assembly, liveness and recovery |
| `tools/` | `mention`, `create_task`, `finish_task`, Captain tools, and MCP |
| `workdir-access.cjs` | Safe read-only access to the Room workspace |

The main process registers the narrow IPC in `desktop/src/shell/team-room-ipc.cjs`. The UI is `frontend/src/components/RoomWorkspace.vue`. Its data comes from the preload `teamRoom` API.

Domain code does not start processes. The runtime does not write product tables directly. An external side effect is written as an effect first, then executed.

## Where data lives

| Data | Location |
| --- | --- |
| Room, Chat, roles, messages, tasks, reports, Attention, artifact references | SQLite |
| Session pointers and participant / lane watermarks | SQLite. The watermark does not belong to the session |
| Session text and model context | The Agent CLI's own storage |
| Live events | Runtime events in SQLite, passed to the UI through an allowlist |
| Attachments and secrets | Private app storage. Secrets use OS secure storage |

A new trace field must be added to the `runtime-event-view` allowlist in the same change. The read model does not send absolute paths, session references, PIDs, or tokens.

## More detail

Principles, sessions, tasks, decisions, and UI direction are in [docs/README.md](docs/README.md). Those notes describe the room model that is already in the tree. They are not a plan that is still waiting to be implemented.
