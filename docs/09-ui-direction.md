# 09 UI direction and information architecture

> 2026-11-17. Based on an audit of the current `RoomWorkspace` and the old Project Room UI, and an audit of the eta Web UI.
>
> **Conclusion: keep the visual shell and card patterns of RoomWorkspace, and rewrite the data adapter layer. Delete the entire old Project Room preview and the checkpoint/gate/seat/round state machine. Do not reuse the old `room-engine` assignment/artifact/trace/files/context contract. Rebuild against the new room domain.**

## 1. Current state: three stacks sit side by side

| Layer | Location | Status |
| --- | --- | --- |
| Old Project Room preview | `desktop/src/project-room/` + `ProjectRoom*.vue` + `useProjectRoom*.js` | ProjectService/checkpoint/gate/seat/round. Controlled by the `projectRoomPreview` flag. Delete the whole thing |
| Current `RoomWorkspace` | `frontend/src/components/RoomWorkspace.vue` + `useRoomWorkspace.js` | A standalone `rooms` page. The visual layer is usable. Data comes from the old `desktop/src/room-engine/`. Keep the visuals and rewrite the data layer |
| New room domain | `desktop/src/room/` + `read-model.cjs` | The domain, runtime, liveness, idempotency, and events are ready. **There is no IPC, preload, or UI.** It is the only future data source |

The target UI is already written in `02` and `06`: one `RoomWorkspace` that shows only messages, Agent replies, mentions, Captain assignment and review, Task/Report/Attention/Artifact cards, and Trace. The words checkpoint, gate, seat, and round do not appear.

## 2. How the current RoomWorkspace works

### 2.1 Layout

```text
Left sidebar
  Agent list
  Team rooms
    Room
      Chat (primary Chat + other Chats)
  Old Project rooms / Legacy projects (preview flag)

Center RoomWorkspace
  header
    Room name / Chat name / working-directory basename
    Role chips (avatar, name, Controller badge, +)
    Attention count / files / Work panel / new Room
  timeline
    Load earlier
    User messages (right), Agent messages (left), Controller highlight
    Report card (evidence + artifact)
    Assignment Trace (expandable)
    Live assignment output
    Attention card (answerable)
  composer
  Work panel (tasks/assignments/artifacts/stale)
Right
  RoomFilesDrawer (directory tree + file preview; becomes a dialog on a narrow screen)
Dialogs
  Create Room / Project settings / Chat settings / Role settings
```

Problems visible in the screenshots:

- The file panel on the right reports `room:files-list ... SCHEDULER_CLAIM_ROOT_INVALID`. That is the old scheduler and room-engine root-directory logic, a typical leftover from the old engine.
- Workspace write authorization is explained by the Captain in chat as `workspace.writeAuthorized=false`. That is platform configuration, and it should not be conveyed through an Agent conversation.
- There is no streaming process, tool-call card, token or context display, or a separate Task board or Inbox. Reports are mixed into the message stream, and Trace has only one collapsed entry.

### 2.2 Role and Chat

- A Room is the working directory, the Provider, the artifact ledger, and the shared engineering facts.
- A Chat is an independent team record: messages, Roles, Tasks, Reports, Attention, and the collaboration agreement.
- Role chips come from the current Chat's roles. A click opens Role settings. `is_controller` is the old word. The new domain uses `is_captain`.
- Chat settings include the collaboration agreement and Skill bindings. The current `sendContext` only sends an ordinary message. It is not a context revision.

### 2.3 Old Project Room preview (should be deleted)

- Gate: accept / accept as-is / continue / reject, changed files, review summaries, and commit to git.
- Drift: use the workspace or restore accepted, and the diff.
- Out-of-scope, residual process confirmation, error-bar retry, compact, and diagnostics.
- Seat, Profile, Playbook, Template, Round, and Checkpoint configuration.
- Reject upstream / reopen / impact preview.
- The sidebar entries "Project rooms / Legacy projects" and the pending-decisions list.
- All of these are bound to `ProjectService`, the checkpoint engine, and workspace JSON. They have nothing to do with the new Room, Chat, Role, TaskRun, and Report model.

### 2.4 UI that is already dead or broken (easy to leave behind)

| Item | Evidence | Conclusion |
| --- | --- | --- |
| `ProjectRoomProgress.vue` | The progress chain and the summary are commented out in full. `expanded` defaults to false, and there is no expand button | Delete |
| "View diff" in `ProjectRoomStatus` | `openDriftDiff` only writes `selectedDiff`, and nothing consumes it | Delete |
| FileDiff in `ProjectRoomDrawer` | It is in the template, but nothing calls `loadDiff` | Delete (use the new file drawer) |
| add/remove in `ProjectRoomSeatSettings` | Commented out in the template. The underlying commands are still there | Delete (new Role editor) |
| `project:open` event | Exposed by preload. The frontend does not consume it | Delete |
| `projectRoomPreview` flag | Migration scaffolding | Delete |
| Old `room:files-list` | The screenshot reports a scheduler root error | Rewrite the files API |

## 3. Data-shape mismatch (what the new domain must rewrite)

The new `read-model.cjs` already provides a display-safe snapshot, but the old UI still consumes room-engine fields:

| Old UI | New domain |
| --- | --- |
| `assignments[]` (execution assignment) | `runs[]` (TaskRun) + `assignments[]` (Captain assignment) |
| `role.is_controller` | `role.is_captain` |
| `room.workspace` absolute path | `room.workspace_label` + `write_authorized` |
| `task.objective` | `task.title/description/acceptance` |
| `report.assignment_id` | `report.run_id/lane_id/kind` |
| `attention.options_json` | `attention.options` |
| `role.current_prompt` / `skill_bindings` | `role.prompt/prompt_revision` (skills still to be added) |
| `liveAssignments` (assignment-event) | `runtime_events` + the run event stream (IPC still to be added) |
| `assignmentTrace` | run trace / runtime events (still to be added) |
| `artifactDiff` / `filesList` | new artifact/files contract (still to be added) |
| `chat.current_context` / `skill_bindings` | `chat_context_revisions` (read model still to be added) |

**Easiest mistake**: in the new domain, `assignments` is the Captain assignment, not the execution record. The execution record is `runs`.

## 4. eta's UI logic, and what is worth borrowing

### 4.1 Top-level structure

eta is a conversation cockpit plus a context panel on the right:

- Left: Captain, global entries (Chat/Tasks/Email/Routines), Conversations grouped by project, the Agent list, and Settings.
- Center: the Conversation timeline and the composer.
- Right: Context / Tasks / Pending / Artifacts.
- Detail and edit use a popover or a drawer, and they do not leave the current context. On a narrow screen they become a drawer or a full screen.
- There is no global Artifact page and no global Inbox page. Artifact and Inbox are part of the conversation panel.

Tyche does not need to copy a global Captain, project grouping, or machines. It can borrow the structure of a conversation in the center, a panel for the current context on the right, and editing in a popover.

### 4.2 Ten things worth borrowing

1. **Reply-row state machine**: `queued → working → waiting_for_input → done/failed/stopping/stopped`. A reply takes a `seq` as soon as it is created, and streaming content only increases `revision`. Tyche's Message already has status, seq, and revision. A TaskRun uses its own status.
2. **Separate the persistent timeline from the live stream**: while a run is in progress, render from the session event stream. After it ends, read the stable snapshot stored on the timeline row. Tyche uses `RuntimeEvent` for live state, and `Message`, `TaskRun`, and `Report` for facts after they are committed.
3. **Separate process from answer**: fold thinking, tool, and process text, and keep the answer separate. A tool card is collapsed by default, and it renders by command, diff, write, plan, JSON, image, or substep. A fixed-size Transcript drawer shows the full content.
4. **TaskRun log plus a time bar or waterfall**: the run log reuses the same tool cards. The header shows status, duration, attempt, and workspace. The time bar is colored by model, shell, read, edit, or other, and a click jumps to the log.
5. **Context occupancy plus a Session inspector**: the outer ring of the avatar is split into system, context, user, assistant, toolDefs, and tool. Inspect shows the prompt and the tools. The member row shows in, out, cache, tools, and tok/s.
6. **Attention lists only what truly blocks**: a pending question or approval, a blocked or in_review task, and an unseen report or failure. It can be answered inline. There is no notification center and no automatic popup.
7. **Optimistic outbox, idempotent send, and held messages**: the message shows Sending immediately. On failure, the actions are Retry, Edit, and Discard. `clientId` makes the send idempotent. When every lane is busy, held messages sit above the composer. Drafts and the outbox are restored on refresh.
8. **Task and Artifact cards, and provenance**: a task draft or card belongs to the turn that wrote it. The task card shows status, run, comments, summary, artifacts, and progress. An artifact has a version, a publisher, a task link, and a sandbox preview.
9. **Role and Agent configuration**: General, Instructions, and Tools tabs. Models are grouped by provider, and an unavailable item explains why. Thinking level has a model-default choice. A field error points at its tab.
10. **Adaptive three columns, and local UI memory**: a panel can be dragged wider. Width, collapsed state, and the rail are stored in localStorage. A narrow screen becomes a drawer. Detail and edit use a popover.

### 4.3 What eta did not do well, and Tyche should do better

- **Report**: eta has no first-class Report. The `finish_task` summary only becomes a comment. Tyche must have a separate Report card: kind, summary, evidence, artifact_ids, next_request, and attention.
- **Usage and tokens**: eta shows this only under Settings, then Agents, on the member row, and in the context ring. There is no global usage page, no per-run cost, and `cost` is not rendered. Tyche should show token and cost at three levels, Role, TaskRun, and Room, and distinguish provider-reported from estimated.
- **Streaming status**: eta has a reconnect hint, but the desktop should also show the runtime connection status, interrupted and unknown, and why something is queued.
- **Task creation**: eta Web has a user `+ New`, but a Tyche Task is created only by an Agent. Do not copy a user-created task, or dragging a task to done.
- **Captain review**: eta has an XML text fallback. Tyche consumes only structured `reviews`. Do not parse natural language.

### 4.4 Do not copy

- A globally unique Captain, or a session that belongs only to the Captain. Tyche has one Captain Role per Chat.
- machines, daemon, Tailscale, phone link, and max active runs.
- The memory sidecar, routines, the LLM gateway, and Email.
- The wire, cordis, target-action, and WebSocket protocols. Use Electron IPC and SQLite, but the revision, snapshot, and event semantics can be borrowed.
- An Agent as global configuration, and a Project as a machine plus a directory. Tyche is Room, Chat, and Role.
- Interaction built only for a TUI or a phone, 4 characters per token treated as billing, and shortcut copy that does not match.

## 5. Delete, keep, and rewrite

### 5.1 Delete (the old Project Room as a whole)

| Scope | Files |
| --- | --- |
| Old UI components | `ProjectRoomStatus.vue`, `ProjectRoomGatePanel.vue`, `ProjectRoomProgress.vue`, `ProjectRoomComposer.vue`, `ProjectRoomTimelineCard.vue`, `ProjectRoomCreateDialog.vue`, `ProjectRoomSeatSettings.vue`, `ProjectRoomOverlay.vue`, `ProjectRoomDrawer.vue` |
| Old composables | `useProjectRoomView.js`, `useProjectRoom.js` |
| App assembly | The old project room controllers, watches, timeline props, sidebar props, overlay, and dialog in `App.vue` |
| Sidebar entries | Project rooms, Legacy projects, and pending decisions in `WorkspaceSidebar.vue` |
| Preview flag | `GeneralSettingsPanel.vue` + the `projectRoomPreview` preference + locale |
| IPC and preload | `project:*`, `projectRoom.*`, and the old methods in `desktop.js` |
| Backend | Every ProjectService, checkpoint, gate, seat, round, projection, and store under `desktop/src/project-room/` |
| workspace JSON | `state.projects[]`, `groups[].projectId/projectRole`, `snapshot.projectRooms/pendingDecisions` |
| i18n, CSS, and tests | The old `projectRoom.*` groups, the old project-room CSS, and the old `projectRoom*.spec.js` |

Deletion order: remove the UI entries first, then delete the composables and controllers, then delete preload and the project IPC, then decouple and delete ProjectService and checkpoint, then clean up the workspace JSON fields and the tests.

### 5.2 Keep (visuals and interaction that can be reused)

- The page shell of `RoomWorkspace.vue`, the header, the Role chips, the timeline message hierarchy, the Report, evidence, and artifact cards, the Attention cards, the live output rows, the Work panel, the simple composer, the settings dialog shell, and the create-Room dialog shell.
- `RoomFilesDrawer.vue` + `WorkdirTree` + `FilePreview` (switch to the new files API).
- The expand and step visuals of `RoomAssignmentTrace` (change the key from assignmentId to runId, and switch the data to runtime_events).
- The diff visuals of `RoomArtifactDiff` (the backend switches to the new artifact contract).
- Role editor visuals: two columns, an avatar, the Provider, permission chips, and the Prompt.
- Visual tokens: the user on the right, the Agent on the left, the Captain accent, the content max width, color variables, spacing, responsive layout, and Escape, aria, and focus.
- The i18n pattern: `room.*` copy, error-code mapping, and a fallback when a key is missing.

### 5.3 Rewrite (the concept stays, the data and the interface change)

- `useRoomWorkspace.js` moves to the new read model: `assignments` to `runs`, `is_controller` to `is_captain`, `workspace_label` and `write_authorized`, `report.run_id`, and `attention.options`.
- The Room header and Role chips move to a Room-level roles filter, the Captain, and write-authorization status.
- Project settings become the Room directory label, the Captain, and write authorization. Delete Controller.
- Chat settings make `chat_context_revisions` actually persist the collaboration agreement. Skills connect to the new domain.
- Role settings use `is_captain`, prompt revision, native permission, and capabilities. Delete checkpointRoles.
- The Work panel becomes Task, TaskRun, and lane. Rewrite stop, retry, and handoff to the new semantics. Do not copy the assignment commands.
- Report and Attention cards use the new fields.
- Artifact, Trace, Files, Context, and Skills use the new IPC and read-model contract.
- Sidebar Team rooms use `chat_count` and `primary_chat_id`. Drop the `is_primary` assumption.
- Create Room uses the new bootstrap (workspace + roles). Delete template and seat.
- The composer supports @ member and file, # task, attachments, and reply/root. Connect it to the new routing and briefing.

### 5.4 The new UI must add what the old UI does not have

- A Captain review card (`read-model.reviews`).
- A Captain assignment row, and the review reply.
- Task number, title, and acceptance criteria, plus TaskRun, lane, required, and writeScopes.
- A Room-level write-authorization toggle, and a read-only hint.
- A mention row, system events, and Task, Report, Artifact, and Attention cards.
- A streaming process, tool cards, and a Trace drawer.
- A token and context display.
- A single "Needs you" Attention panel, a Task board, and Room-level Artifacts.

## 6. Target information architecture

```text
Left
  Team rooms
    Room (attention badge, running count)
      Chat (unread/working/waiting)
  Agents (global Agent list; keep the DM entry)
  Inbox / Usage / Settings

Center
  Room header: Room name + workspace label + write authorization + Room-level Tasks/Artifacts
  Chat header: Chat name + member chips (click to configure the Role) + model/thinking/context chip + stop
  Timeline:
    User message / Agent reply / mention / system
    process box (thinking + tool cards, collapsed)
    answer
    Task card / Report card / Artifact card / Captain review card / Attention card
    streaming, queued, waiting, failed, and stopped states
  Composer: @ member/file, # task, attachments, send/queue

Right (can be dragged wider; a drawer on a narrow screen)
  Files / Tasks / Pending / Artifacts / Trace

Room-level pages
  Task board (Tasks created by Agents; status todo/in_progress/in_review/blocked/done)
  Artifact ledger (version, publisher, task link)
  Usage (Role/TaskRun/Room token and cost)
```

### 6.1 Streaming

- `RuntimeEvent` drives the live view: text, thinking, tool start, update, and end, turn end, exit, and permission. Render in batches of 30–60ms.
- Show a skeleton before the first token. The process has a fixed height, scrolls inside itself, and follows automatically. If the reader scrolls up, following stops.
- Keep the answer separate from the process. After it ends, the process collapses, and the full content goes into the Transcript drawer.
- Make `streaming / waiting_for_input / reconnecting / interrupted` explicit. The desktop shows the runtime connection status.

### 6.2 Token, usage, and context

- **Role level**: the member chip and the member row on the right show in, out, cache, and tok/s. Hover expands 5h, 24h, and 7d.
- **TaskRun level**: the run header and the Report card show this run's tokens, cost (optional), duration, and attempt count.
- **Room level**: the Usage panel shows today and this week, a breakdown by Role and Provider, the failure rate, and the budget.
- **Context**: the Chat header has a compact chip ("72% · 145k/200k"). A click opens the Session inspector: the segments, provider-reported and estimated, before and after the last compaction, and the prompt revision.
- When the budget or the failure rate is exceeded, or the model is unavailable, create an Attention. Do not hide it only on the settings page.
- Distinguish exact usage reported by the provider from a 4-characters-per-token estimate. Do not treat the estimate as billing.

### 6.3 Attention

- One "Needs you" list: question or approval, a blocked or in_review task, failure or unknown, and a report that is ready.
- Each item shows the source Chat, Task, Run, and Role, why you are needed, the options and the impact, the age, and whether it is blocking.
- Answer inline: single choice, multiple choice, free text, or give up. Update optimistically, and retry on failure.
- There is no notification center and no automatic popup. An optional system notification or tray dot shares its source with Inbox.
- One badge system: Room attention, Chat unread or working, and Task blocked or in_review. Do not split the definitions the way eta does.
- A draft that already has a confirm entry where it lives is not counted in Attention again.

### 6.4 Role configuration

- General: display name, Provider, model, thinking level, and the Captain toggle.
- Instructions: Prompt editing, plus revision history and diff. After save, it takes effect for new runs.
- Permissions: the native permission mode (YOLO still follows the POC decision), capabilities, and writeScopes at Task level.
- Tools and Skills: Skill bindings, and which tools are visible.
- Point at the field that failed. If save fails, keep the input.

## 7. Implementation slices

The slices below have already landed in the current code. The old Project Room preview and the old `room-engine` have been deleted, and `RoomWorkspace` uses the room domain directly.

1. **Delete the old Project Room preview**: UI entries, composables, project IPC, ProjectService, checkpoint, workspace JSON fields, i18n, CSS, and tests. It is independent and low risk, and it immediately reduces noise.
2. **New Room host, IPC, and preload**: the new SQLite, the OAR adapter, wrapper and state, startupSweep, and closing on app quit. Narrow `room:*` handlers. Fill in the missing contracts together: files, artifacts, trace, context, skills, usage, write auth, and accept task.
3. **Rewrite the data layer of `useRoomWorkspace` and `RoomWorkspace`**: keep the visual shell and switch to the new read model. First get the Room and Chat timeline, send, streaming, Task, Report, Review, and Attention working.
4. **Add the UI cards and the right rail**: process and tool trace, the Task board, Artifact, Needs you, Usage and Context, and Role editing.
5. **Delete the old `room-engine` IPC, service, and UI data path**: after the new UI has switched over, so two engines are not left in place.
6. **Electron desktop verification, i18n, and a full check**.

## 8. Criteria

- The user collaborates only through messages, Roles, Tasks, Reports, Attention, and Artifacts.
- Old words such as checkpoint, gate, seat, round, controller, and pending decision do not appear.
- The renderer does not receive an absolute workspace path, a session or native ref, a PID, a token, or a raw tool path.
- Streaming, failure, queued, waiting for input, and interrupted each have an explicit status.
- Token and context are something a person can look up, explain, and act on. They are not decorative numbers.
- After the old UI is deleted, the code keeps one Room UI, one data source, and one state machine.
