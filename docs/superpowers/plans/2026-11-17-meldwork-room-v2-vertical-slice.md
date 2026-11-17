# Meldwork Room v2 Conversation and Review Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first end-to-end slice of the new project-room engine: persistent sessions, incremental briefings, agent tools, task settlement, and Captain review, proven against real Claude Code/Codex before UI or legacy migration.

**Architecture:** A new CommonJS domain under `desktop/src/room/` owns a clean SQLite ledger, message timeline, session pointers, task lanes, settlement, and Captain review. It reuses Meldwork's existing native CLI invocation, permissions, ProcessRegistry, leases, trace, and shadow Git infrastructure; it does not read or write the old `room-engine/` or checkpoint engines.

**Tech Stack:** Electron main process, CommonJS, `node:sqlite`, `node:test`, existing `LocalWorkspace`/`invokeAgent` CLI adapters, local MCP server (`@modelcontextprotocol/sdk`, add to `desktop/package.json`) with a restricted text-marker fallback.

**Spec:** `docs-new2/README.md`, `docs-new2/02-target-architecture.md`, `docs-new2/03-conversation-session-and-briefing.md`, `docs-new2/04-task-captain-and-report.md`, `docs-new2/06-rewrite-and-migration.md`, `docs-new2/07-decisions.md`, `docs-new2/08-open-questions.md`

## Global Constraints

- All product code runs in Electron main; no renderer or preload changes in this slice.
- New domain lives under `desktop/src/room/`; do not reuse `desktop/src/collaboration/` or `desktop/src/room-engine/`.
- No Bun runtime, no ESM-only dependency, no Required external server.
- SQLite uses `node:sqlite`, WAL, foreign keys, `busy_timeout`, and private writes (`0700` dirs, `0600` files; Windows exempt).
- New Chat path never reads/writes `meldwork-workspace.json` for sessions.
- `last_seq` belongs to `chat_participants` / `task_lanes`, never to `sessions`.
- `hasNew = chat.activity_seq > max(checkpoint, each non-cancelled assignment public message seq)`.
- `activity_seq` excludes `audience=captain` review rows and the reply created by review delivery (`reviewReply=true`); `assign_in_group` / `post_in_chat` are public and count.
- `assign_in_group` and Captain review do not consume the 5-wake budget; only Agent `mention` tool calls do.
- Chat replies are read-only. Writes only in a TaskRun with user-authorized Room root, Role write permission, non-empty frozen `write_scopes`, and the Room write lease.
- Before isolated workspaces: at most one write-capable TaskRun per Room; read-only runs may run in parallel.
- Tool idempotency uses a logical `callId`, never an args hash. Same args with a new `callId` is a new call. Read tools never cache by args.
- `finish_task` is a completion claim. `in_review`/`blocked` only after exit confirmation and settlement. `accept_task` only after settlement.
- Write-capable settlement = exit confirmed + snapshot completed + Artifact/Report validation. Read-only settlement = exit confirmed + Report validation + platform-set `snapshot_state=not_applicable`.
- Observed non-zero exit = `failed/outcome=known`; unconfirmed exit = `interrupted/outcome=unknown`.
- Captain must never target itself; `assign_in_group` assignment message + `captain_assignments` + target queued replies are one transaction.
- No completion wake, no independent completion budget, no `stage_complete` tool.
- Every task ends with a focused test and a commit. Run `node --test` from `desktop/` for the listed test file.

## Review Focus

1. **CLI resume is not memory.** A CLI may return a new session or lose context after compaction. The engine must not claim memory it does not have; the proof script must expose this before Phase 3.
2. **MCP is not guaranteed.** A CLI may not expose MCP tools, or may expose them without result return. Marker fallback is one terminal action only; Captain tools require MCP.
3. **Finish is not settlement.** A process can submit `finish_task(ready)` then exit non-zero or keep running. Task must not enter `in_review` before exit/snapshot settlement.
4. **Read-only tasks have no snapshot.** They must settle with `snapshot_state=not_applicable`, not fail as “missing snapshot” and not accept an Agent claim of “no files”.
5. **Review must not feed itself.** Review rows and review replies must not advance `activity_seq`; `post_in_chat` is public and may re-trigger. Assignment-message baseline must prevent a just-sent assignment from looking like new activity.

## File Structure

Create:

```text
desktop/src/room/
  db.cjs
  schema.cjs
  repository.cjs
  timeline.cjs
  session-store.cjs
  routing.cjs
  briefing.cjs
  effects.cjs
  engine.cjs
  runtime-adapter.cjs
  tools/
    captain.cjs
    dispatcher.cjs
    mcp-server.cjs
    mention.cjs
    read.cjs
    tasks.cjs
  task-queue.cjs
  settlement.cjs
  captain-review.cjs
  supervisor.cjs
  recovery.cjs
desktop/scripts/
  room-resume-proof.cjs
  room-mcp-proof.cjs
  room-seam-smoke.cjs
desktop/test/room/
  db.test.cjs
  repository.test.cjs
  timeline.test.cjs
  session-store.test.cjs
  routing.test.cjs
  briefing.test.cjs
  effects.test.cjs
  engine.test.cjs
  dispatcher.test.cjs
  mention.test.cjs
  task-queue.test.cjs
  settlement.test.cjs
  captain-review.test.cjs
  recovery.test.cjs
  helpers/fake-runtime.cjs
```

Do not modify `desktop/src/room-engine/`, `desktop/src/project-room/`, or `desktop/src/workspace/` in this slice except for imports needed by proof scripts.

---

### Task 1: Room database and schema

**Files:**
- Create: `desktop/src/room/db.cjs`
- Create: `desktop/src/room/schema.cjs`
- Test: `desktop/test/room/db.test.cjs`

**Interfaces:**
- Produces: `ROOM_SCHEMA_VERSION = 1`
- Produces: `openRoomDatabase({ directory, filename = 'room.sqlite', onCommit = () => {} }) -> { database, databasePath, onCommit(listener), withTransaction(callback), close() }`
- Produces: `ensureRoomSchema(database)` for tests and future migrations.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase, ROOM_SCHEMA_VERSION } = require('../../src/room/db.cjs')

function tempDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-')) }

test('room database creates private schema and version 1', t => {
  const directory = tempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  assert.equal(roomDb.database.prepare('PRAGMA user_version').get().user_version, ROOM_SCHEMA_VERSION)
  const tables = roomDb.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
  for (const name of ['rooms', 'chats', 'chat_roles', 'chat_participants', 'messages', 'sessions',
    'tasks', 'task_lanes', 'task_runs', 'task_activities', 'reports', 'artifacts',
    'captain_assignments', 'captain_reviews', 'events', 'effects', 'tool_calls']) {
    assert.ok(tables.includes(name), `missing table ${name}`)
  }
  if (process.platform !== 'win32') assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
  roomDb.close()
})

test('room database rolls back a failed transaction', t => {
  const directory = tempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  assert.throws(() => roomDb.withTransaction(() => { roomDb.database.prepare("INSERT INTO rooms (id,name,workspace,created_at,updated_at) VALUES ('r','R','/tmp','t','t')").run(); throw new Error('boom') }), /boom/)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM rooms').get().n, 0)
  roomDb.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/db.test.cjs`
Expected: FAIL because `desktop/src/room/db.cjs` does not exist.

- [ ] **Step 3: Implement `openRoomDatabase` and schema**

`db.cjs` mirrors `desktop/src/room-engine/room-db.cjs` setup: `DatabaseSync`, WAL, foreign keys, busy timeout, `ensurePrivateDirectory`, `chmod 0600`, synchronous transaction with savepoints, commit listeners. `schema.cjs` creates the tables from `docs-new2/02-target-architecture.md` section 4.1, using `TEXT` ids and JSON text columns. Include the exact columns for `messages.audience`, `messages.captain_assignment_id`, `sessions.baseline_seq`, `chat_participants.last_seq`, `task_lanes.last_seq`, `task_runs.outcome`, `task_runs.snapshot_state`, `tasks.captain_assignment_id`, `captain_assignments.target_reply_ids_json`, `captain_reviews.checkpoint_seq`, `tool_calls.call_id`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/db.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/db.cjs desktop/src/room/schema.cjs desktop/test/room/db.test.cjs
git commit -m "feat(room): add clean sqlite ledger"
```

---

### Task 2: Room, chat, role, and participant repository

**Files:**
- Create: `desktop/src/room/repository.cjs`
- Test: `desktop/test/room/repository.test.cjs`

**Interfaces:**
- Produces: `createRoomRepository(roomDb) -> { createRoom, getRoom, createChat, getChat, createRole, getRole, addParticipant, getParticipant, listParticipants }`
- `createRoom({ name, workspace, providers = [], allowedCapabilities = [] }) -> roomId`
- `createChat({ roomId, title, status = 'active' }) -> chatId`
- `createRole({ chatId, displayName, provider, prompt, isCaptain = false, nativePermission = 'read-only', capabilities = [], model = null }) -> roleId`
- `addParticipant({ chatId, roleId }) -> { chatId, roleId }`
- `getParticipant(chatId, roleId) -> { chatId, roleId, sessionId, lastSeq } | undefined`

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')

test('creates room, chat, role, prompt revision and participant', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'Room', workspace: directory, providers: ['claude'] })
  const chatId = repo.createChat({ roomId, title: 'Chat' })
  const roleId = repo.createRole({ chatId, displayName: 'Captain', provider: 'claude', prompt: 'route', isCaptain: true })
  repo.addParticipant({ chatId, roleId })
  assert.equal(repo.getRoom(roomId).name, 'Room')
  assert.equal(repo.getRole(roleId).isCaptain, true)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM role_prompt_revisions WHERE role_id = ?').get(roleId).n, 1)
  assert.equal(repo.getParticipant(chatId, roleId).lastSeq, 0)
  assert.throws(() => repo.addParticipant({ chatId, roleId }), /ROOM_PARTICIPANT_EXISTS/)
  roomDb.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/repository.test.cjs`
Expected: FAIL because `repository.cjs` does not exist.

- [ ] **Step 3: Implement repository methods**

Use `crypto.randomUUID()` for ids and `now().toISOString()` for timestamps. `createRole` inserts `chat_roles` and `role_prompt_revisions` revision 1 in one transaction. Validate chat/role/room ownership; reject cross-room chat creation and duplicate participants with stable error codes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/repository.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/repository.cjs desktop/test/room/repository.test.cjs
git commit -m "feat(room): add room and participant repository"
```

---

### Task 3: Message timeline

**Files:**
- Create: `desktop/src/room/timeline.cjs`
- Test: `desktop/test/room/timeline.test.cjs`

**Interfaces:**
- Produces: `createTimeline({ roomDb, repository, now = () => Date.now() })`
- `append({ chatId, authorType, authorId, kind = 'message', content, mentions = [], replyTo = null, taskId = null, rootMessageId = null, captainAssignmentId = null, audience = 'chat', status = 'queued', clientId = null, data = null }) -> MessageView`
- `transition(messageId, fromStatuses, toStatus, patch = {}) -> MessageView | undefined`
- `finish(messageId, { status, text = '', thinking = '', data = null }) -> MessageView`
- `edit(messageId, { content, data = null }) -> { message, event }`
- `get(messageId) -> MessageView | undefined`
- `after(chatId, seq) -> MessageView[]`
- `latest(chatId) -> MessageView | undefined`
- `activitySeq(chatId) -> number`

MessageView fields: `id, chatId, seq, revision, clientId, audience, authorType, authorId, kind, content, mentions, replyTo, taskId, rootMessageId, captainAssignmentId, status, data, createdAt, editedAt`.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  return { roomDb, repo, chatId, timeline: createTimeline({ roomDb, repository: repo }) }
}

test('append assigns seq, dedupes clientId, and advances activity only for public rows', t => {
  const { roomDb, chatId, timeline } = setup(t)
  const first = timeline.append({ chatId, authorType: 'user', authorId: 'user', content: 'hi', clientId: 'c1' })
  const again = timeline.append({ chatId, authorType: 'user', authorId: 'user', content: 'hi', clientId: 'c1' })
  assert.equal(first.id, again.id)
  const review = timeline.append({ chatId, authorType: 'system', authorId: 'system', kind: 'captain_review', content: 'review', audience: 'captain', status: 'done' })
  assert.equal(timeline.activitySeq(chatId), 1)
  assert.equal(timeline.latest(chatId).seq, review.seq)
  const edited = timeline.edit(first.id, { content: 'hello' })
  assert.equal(edited.message.content, 'hello')
  assert.equal(timeline.activitySeq(chatId), 3)
  roomDb.close()
})

test('finish and transition enforce status changes', t => {
  const { roomDb, chatId, timeline } = setup(t)
  const row = timeline.append({ chatId, authorType: 'agent', authorId: 'a', content: '' })
  assert.equal(timeline.transition(row.id, ['queued'], 'working').status, 'working')
  assert.equal(timeline.finish(row.id, { status: 'done', text: 'ok' }).status, 'done')
  assert.equal(timeline.transition(row.id, ['working'], 'failed'), undefined)
  roomDb.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/timeline.test.cjs`
Expected: FAIL because `timeline.cjs` does not exist.

- [ ] **Step 3: Implement timeline**

On append, allocate `seq = chats.last_seq + 1`, write the row, update `chats.last_seq`; if `audience === 'chat'` and `data.reviewReply !== true`, also update `chats.activity_seq = seq`. `clientId` is unique per chat; return the existing row. `edit` appends a public system event row with `data.event = 'message_edited'` and `data.messageId`, then updates the message content and increments `revision`. `activitySeq` reads `chats.activity_seq`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/timeline.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/timeline.cjs desktop/test/room/timeline.test.cjs
git commit -m "feat(room): add message timeline and activity watermark"
```

---

### Task 4: Session store and participant watermarks

**Files:**
- Create: `desktop/src/room/session-store.cjs`
- Test: `desktop/test/room/session-store.test.cjs`

**Interfaces:**
- Produces: `createSessionStore({ roomDb, repository, now = () => Date.now() })`
- `ensureSession({ scopeType, scopeId, roleId, provider, promptRevision, permissionMode, workspaceRef, skillBindings = [], model, thinkingLevel, created }) -> { sessionId, reused, baselineSeq }`
- `saveNativeRef({ sessionId, nativeSessionRef }) -> void`
- `rotateSession({ sessionId, reason }) -> void`
- `getParticipantLastSeq({ chatId, roleId }) -> number`
- `setParticipantLastSeq({ chatId, roleId, seq }) -> void`

For Task 4, only `scopeType: 'chat'` is required; Task 9 adds task lane support.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createSessionStore } = require('../../src/room/session-store.cjs')

test('reuses a matching chat session and preserves participant watermark on rotation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const roleId = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p1' })
  repo.addParticipant({ chatId, roleId })
  const store = createSessionStore({ roomDb, repository: repo })
  const base = { scopeType: 'chat', scopeId: chatId, roleId, provider: 'claude', promptRevision: 1,
    permissionMode: 'read-only', workspaceRef: directory, model: 'claude', thinkingLevel: 'off', created: () => {} }
  const first = store.ensureSession(base)
  const second = store.ensureSession(base)
  assert.equal(first.sessionId, second.sessionId)
  assert.equal(second.reused, true)
  store.setParticipantLastSeq({ chatId, roleId, seq: 7 })
  store.rotateSession({ sessionId: first.sessionId, reason: 'prompt-changed' })
  const third = store.ensureSession({ ...base, promptRevision: 2 })
  assert.notEqual(third.sessionId, first.sessionId)
  assert.equal(store.getParticipantLastSeq({ chatId, roleId }), 7)
  assert.equal(third.baselineSeq, 7)
  roomDb.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/session-store.test.cjs`
Expected: FAIL because `session-store.cjs` does not exist.

- [ ] **Step 3: Implement session store**

Match all fields on an active session: `provider`, `prompt_revision`, `permission_mode`, `workspace_ref`, `skill_bindings_json`, `model`, `thinking_level`. On create, set `baseline_seq = participant.last_seq`, write `session_id` to `chat_participants`, and call `created(sessionId)`. On rotation, set `state='rotated'`, `rotated_at`; the next ensure creates a new row with `baseline_seq` equal to the participant's current `last_seq`. Never write a session's `last_seq`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/session-store.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/session-store.cjs desktop/test/room/session-store.test.cjs
git commit -m "feat(room): add persistent session store"
```

---

### Task 5: Routing and wake budget

**Files:**
- Create: `desktop/src/room/routing.cjs`
- Test: `desktop/test/room/routing.test.cjs`

**Interfaces:**
- Produces: `WAKE_BUDGET = 5`
- Produces: `routeUserMessage({ kind, members, mentions, steward }) -> { targets, addSteward, named }`
- Produces: `judgeMention(spent) -> 'wake' | 'wake_last' | 'capped'`
- Produces: `resolveNamed(wanted, members, self) -> { ids, unknown }`

Members are `{ id, name, systemRole? }`.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict')
const test = require('node:test')
const { routeUserMessage, judgeMention, resolveNamed } = require('../../src/room/routing.cjs')

test('routes named members, then steward, then a single member', () => {
  assert.deepEqual(routeUserMessage({ kind: 'group', members: ['a', 'b'], mentions: ['b'], steward: 'a' }).targets, ['b'])
  assert.deepEqual(routeUserMessage({ kind: 'group', members: ['a', 'b'], mentions: [], steward: 'a' }).targets, ['a'])
  assert.deepEqual(routeUserMessage({ kind: 'group', members: ['a'], mentions: [], steward: null }).targets, ['a'])
  assert.deepEqual(routeUserMessage({ kind: 'group', members: ['a', 'b'], mentions: [], steward: null }).targets, [])
})

test('caps mention wakes at five', () => {
  assert.equal(judgeMention(1), 'wake')
  assert.equal(judgeMention(5), 'wake_last')
  assert.equal(judgeMention(6), 'capped')
})

test('resolves names case-insensitively and excludes self', () => {
  const members = [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]
  assert.deepEqual(resolveNamed(['alice', 'nobody'], members, '2'), { ids: ['1'], unknown: ['nobody'] })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/routing.test.cjs`
Expected: FAIL because `routing.cjs` does not exist.

- [ ] **Step 3: Implement pure routing**

Port the rules from `docs-new2/03-conversation-session-and-briefing.md` section 5 and `docs-new2/04-task-captain-and-report.md` section 6.3. No DB access.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/routing.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/routing.cjs desktop/test/room/routing.test.cjs
git commit -m "feat(room): add routing and wake budget"
```

---

### Task 6: Incremental briefing

**Files:**
- Create: `desktop/src/room/briefing.cjs`
- Test: `desktop/test/room/briefing.test.cjs`

**Interfaces:**
- Produces: `briefing({ chatTitle, me, lastSeq, rows, trigger, nameOf, filesOf = () => [], viewerIsCaptain = false }) -> { text, seen, omittedSeqs, truncatedIds }`
- Constants: `MAX_EARLIER = 100`, `MAX_TEXT = 2000`.

`rows` are MessageView-like objects with `seq`, `id`, `authorType`, `authorId`, `status`, `content`, `audience`, `data`, `kind`.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict')
const test = require('node:test')
const { briefing } = require('../../src/room/briefing.cjs')

const row = (seq, extra = {}) => ({ id: `m${seq}`, seq, authorType: 'agent', authorId: 'a', status: 'done', content: `c${seq}`, audience: 'chat', data: {}, ...extra })

test('includes unseen completed rows, skips own and in-flight, and blocks the watermark', () => {
  const trigger = row(4, { content: 'trigger' })
  const result = briefing({ chatTitle: 'C', me: 'a', lastSeq: 0, trigger, nameOf: m => m.authorId,
    rows: [row(1), row(2, { authorId: 'a' }), row(3, { status: 'working' }), trigger] })
  assert.equal(result.text.includes('c1'), true)
  assert.equal(result.text.includes('c2'), false)
  assert.equal(result.text.includes('trigger'), true)
  assert.equal(result.seen, 2)
  assert.equal(result.omittedSeqs.includes(3), true)
})

test('hides captain-only rows from non-captains and keeps them for the captain', () => {
  const trigger = row(2, { authorType: 'system', authorId: 'system', kind: 'captain_review', audience: 'captain' })
  const hidden = briefing({ chatTitle: 'C', me: 'a', lastSeq: 0, trigger, nameOf: m => m.authorId, rows: [row(1), trigger] })
  const shown = briefing({ chatTitle: 'C', me: 'captain', lastSeq: 0, trigger, nameOf: m => m.authorId, viewerIsCaptain: true, rows: [row(1), trigger] })
  assert.equal(hidden.text.includes('review'), false)
  assert.equal(shown.text.includes('review'), true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/briefing.test.cjs`
Expected: FAIL because `briefing.cjs` does not exist.

- [ ] **Step 3: Implement briefing**

Use the exact algorithm in `docs-new2/03-conversation-session-and-briefing.md` section 4.2. `seen` advances only over completed rows, the trigger, and own rows, never past an in-flight row. Cap earlier lines at 100 and each text at 2000; return omitted seqs and truncated ids. `audience='captain'` is invisible unless `viewerIsCaptain`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/briefing.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/briefing.cjs desktop/test/room/briefing.test.cjs
git commit -m "feat(room): add incremental briefing"
```

---

### Task 7: Effects and reply engine

**Files:**
- Create: `desktop/src/room/effects.cjs`
- Create: `desktop/src/room/engine.cjs`
- Create: `desktop/test/room/helpers/fake-runtime.cjs`
- Test: `desktop/test/room/effects.test.cjs`
- Test: `desktop/test/room/engine.test.cjs`

**Interfaces:**
- `createOutbox({ roomDb, repository, now = () => Date.now() })`
  - `enqueue({ chatId, kind, payload, idempotencyKey }) -> effect`
  - `claimNext(kind) -> effect | undefined`
  - `succeed(id, result = null) -> effect`
  - `fail(id, error) -> effect`
  - `unknown(id, error) -> effect`
  - `get(id) -> effect | undefined`
- `createEngine({ roomDb, repository, timeline, sessions, outbox, runtime, now })`
  - `submitUserMessage({ chatId, authorId = 'user', content, clientId }) -> { message, replies }`
  - `startReply(replyId) -> { effectId, launched: Promise<effect>, done: Promise<void> }`
  - `startQueuedReplies({ chatId }) -> Promise<void>` starts every queued reply.
  - `stopReply({ replyId }) -> Promise<void>`
- Runtime interface:
  - `start({ runId, chatId, roleId, prompt, nativeSessionRef, signal, onEvent }) -> { launch: Promise<{ nativeSessionRef }>, completion: Promise<{ status: 'done'|'failed'|'stopped', text, thinking, activity? }> }`
- `createFakeRuntime({ deferCompletion = false }) -> { start(input), finish(outcome) }` test helper.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')
const { createSessionStore } = require('../../src/room/session-store.cjs')
const { createOutbox } = require('../../src/room/effects.cjs')
const { createEngine } = require('../../src/room/engine.cjs')
const { createFakeRuntime } = require('./helpers/fake-runtime.cjs')

test('effect succeeds at launch, not after the run completes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const roleId = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId })
  const timeline = createTimeline({ roomDb, repository: repo })
  const sessions = createSessionStore({ roomDb, repository: repo })
  const outbox = createOutbox({ roomDb, repository: repo })
  const runtime = createFakeRuntime({ deferCompletion: true })
  const engine = createEngine({ roomDb, repository: repo, timeline, sessions, outbox, runtime })
  const { replies } = engine.submitUserMessage({ chatId, content: '@A hi' })
  const pending = engine.startReply(replies[0].id)
  await pending.launched
  assert.equal(outbox.get(pending.effectId).status, 'succeeded')
  assert.equal(timeline.get(replies[0].id).status, 'working')
  runtime.finish({ status: 'done', text: 'ok' })
  await pending.done
  assert.equal(timeline.get(replies[0].id).status, 'done')
  assert.equal(sessions.getParticipantLastSeq({ chatId, roleId }), 2)
  roomDb.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/effects.test.cjs test/room/engine.test.cjs`
Expected: FAIL because `effects.cjs` / `engine.cjs` do not exist.

- [ ] **Step 3: Implement outbox and engine**

Outbox uses `effects` with `status pending/running/succeeded/failed/unknown`, idempotency by `idempotency_key`; never auto-replays failed/unknown. Engine:

1. append user message via timeline;
2. route targets;
3. queue reply rows (`clientId` optional) in the same transaction;
4. create a `start_reply` effect per reply;
5. `startQueuedReplies` claims each effect, ensures session, builds briefing, marks effect succeeded **after** `runtime.start().launch` resolves, transitions reply to `working`, and awaits `completion` separately;
6. on completion update reply status and participant `last_seq`;
7. on stop, abort and finish as `stopped`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/effects.test.cjs test/room/engine.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/effects.cjs desktop/src/room/engine.cjs desktop/test/room/helpers/fake-runtime.cjs desktop/test/room/effects.test.cjs desktop/test/room/engine.test.cjs
git commit -m "feat(room): add effects and reply engine"
```

---

### Task 8: Tool dispatcher, callId idempotency, and mention

**Files:**
- Create: `desktop/src/room/tools/dispatcher.cjs`
- Create: `desktop/src/room/tools/mcp-server.cjs`
- Create: `desktop/src/room/tools/mention.cjs`
- Create: `desktop/src/room/tools/read.cjs`
- Test: `desktop/test/room/dispatcher.test.cjs`
- Test: `desktop/test/room/mcp-server.test.cjs`
- Test: `desktop/test/room/mention.test.cjs`
- Test: `desktop/test/room/read.test.cjs`

**Interfaces:**
- `createToolDispatcher({ roomDb, repository, now })`
  - `bindRun(runId, { chatId, roleId, allowedTools, captainAssignmentId = null })`
  - `register(name, handler, { readOnly = false } = {})`
  - `listTools() -> [{ name, description, inputSchema }]`
  - `invoke({ runId, callId, name, args }) -> Promise<result>`
- `createMcpHttpServer({ dispatcher, host = '127.0.0.1', port = 0 }) -> Promise<{ url, close }>`
- `registerMentionTool({ dispatcher, roomDb, repository, timeline, queueReply })`
  - `queueReply({ chatId, roleId, trigger, rootMessageId, captainAssignmentId }) -> MessageView`
- `registerReadChatTool({ dispatcher, timeline })`
  - `read_chat({ beforeSeq = null, limit = 50 }) -> { messages, hasMore }` (current Chat only)

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')
const { createToolDispatcher } = require('../../src/room/tools/dispatcher.cjs')
const { createMcpHttpServer } = require('../../src/room/tools/mcp-server.cjs')
const { registerMentionTool } = require('../../src/room/tools/mention.cjs')
const { registerReadChatTool } = require('../../src/room/tools/read.cjs')

test('same callId returns the original result; same args with a new callId executes again', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const a = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p' })
  const b = repo.createRole({ chatId, displayName: 'B', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId: a }); repo.addParticipant({ chatId, roleId: b })
  const timeline = createTimeline({ roomDb, repository: repo })
  const dispatcher = createToolDispatcher({ roomDb, repository: repo, now: () => Date.now() })
  let calls = 0
  dispatcher.register('echo', async args => { calls += 1; return { n: calls, args } })
  dispatcher.bindRun('run1', { chatId, roleId: a, allowedTools: ['echo'] })
  const first = await dispatcher.invoke({ runId: 'run1', callId: 'call1', name: 'echo', args: { x: 1 } })
  const retry = await dispatcher.invoke({ runId: 'run1', callId: 'call1', name: 'echo', args: { x: 1 } })
  const next = await dispatcher.invoke({ runId: 'run1', callId: 'call2', name: 'echo', args: { x: 1 } })
  assert.deepEqual(retry, first)
  assert.equal(next.n, 2)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM tool_calls').get().n, 2)
  roomDb.close()
})

test('mention appends a mention row and queues target replies', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const a = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p' })
  const b = repo.createRole({ chatId, displayName: 'B', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId: a }); repo.addParticipant({ chatId, roleId: b })
  const timeline = createTimeline({ roomDb, repository: repo })
  const dispatcher = createToolDispatcher({ roomDb, repository: repo })
  const queued = []
  registerMentionTool({ dispatcher, roomDb, repository: repo, timeline,
    queueReply: input => { queued.push(input); return input.trigger } })
  dispatcher.bindRun('run1', { chatId, roleId: a, allowedTools: ['mention'] })
  const trigger = timeline.append({ chatId, authorType: 'user', authorId: 'user', content: '@A hi' })
  await dispatcher.invoke({ runId: 'run1', callId: 'mention-1', name: 'mention',
    args: { names: ['B'], text: 'please review' } })
  const row = timeline.latest(chatId)
  assert.equal(row.kind, 'mention')
  assert.deepEqual(row.mentions, [b])
  assert.equal(queued.length, 1)
  assert.equal(queued[0].roleId, b)
  assert.equal(trigger.seq < row.seq, true)
  roomDb.close()
})

test('mcp server lists and calls the bound tools', async t => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
  // seed room/chat/role as above; register echo; bind run
  const server = await createMcpHttpServer({ dispatcher })
  t.after(() => server.close())
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  const tools = await client.listTools()
  assert.equal(tools.tools.some(tool => tool.name === 'echo'), true)
  const result = await client.callTool({ name: 'echo', arguments: { x: 1 } })
  assert.deepEqual(result.structuredContent, { n: 1, args: { x: 1 } })
  await client.close()
})

test('read_chat returns a page and sees messages appended after a prior call', async t => {
  // seed room/chat/role; create dispatcher; registerReadChatTool; bind run with read_chat
  const first = await dispatcher.invoke({ runId: 'run1', callId: 'read-1', name: 'read_chat', args: { limit: 10 } })
  timeline.append({ chatId, authorType: 'user', authorId: 'user', content: 'later' })
  const second = await dispatcher.invoke({ runId: 'run1', callId: 'read-2', name: 'read_chat', args: { limit: 10 } })
  assert.equal(first.hasMore, false)
  assert.equal(second.messages.some(message => message.content === 'later'), true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/dispatcher.test.cjs test/room/mcp-server.test.cjs test/room/mention.test.cjs test/room/read.test.cjs`
Expected: FAIL because dispatcher/mcp-server/mention/read do not exist.

- [ ] **Step 3: Implement dispatcher, MCP server, mention, and read_chat**

Dispatcher stores `tool_calls` by `(run_id, call_id)`; on duplicate returns original `result_json`. If a different `args_hash` arrives with the same `callId`, throw `ROOM_TOOL_CALL_ARGS_MISMATCH`. `allowedTools` enforced. Read tools are not cached: register them with `{ readOnly: true }`; the dispatcher executes every time and records an audit row without dedupe.

`mcp-server.cjs` exposes `listTools`/`invoke` over the MCP SDK Streamable HTTP transport on loopback; the run binding is passed by the engine when the process starts, and tool arguments never contain identity.

Mention handler:

- resolve names/ids within chat participants; exclude self;
- append `kind='mention'` with `rootMessageId` from the current reply;
- call `queueReply` for each target;
- enforce `judgeMention(countMentionsForRoot)`; never count `assign_in_group` rows.

`read_chat` returns messages below `beforeSeq` (or latest), newest-first/oldest-first as pinned by the test, only for the bound Chat, with `hasMore`. It is registered as `readOnly: true` so the dispatcher never dedupes it by args.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/dispatcher.test.cjs test/room/mcp-server.test.cjs test/room/mention.test.cjs test/room/read.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/tools/dispatcher.cjs desktop/src/room/tools/mcp-server.cjs desktop/src/room/tools/mention.cjs desktop/src/room/tools/read.cjs desktop/package.json desktop/package-lock.json desktop/test/room/dispatcher.test.cjs desktop/test/room/mcp-server.test.cjs desktop/test/room/mention.test.cjs desktop/test/room/read.test.cjs
git commit -m "feat(room): add tool dispatcher, mcp server, mention, and read_chat"
```

---

### Task 9: Task creation, lanes, and run queue

**Files:**
- Create: `desktop/src/room/tools/tasks.cjs`
- Create: `desktop/src/room/task-queue.cjs`
- Test: `desktop/test/room/task-queue.test.cjs`

**Interfaces:**
- `registerTaskTools({ dispatcher, roomDb, repository, timeline, queueRun })`
  - `create_task({ title, description, acceptance, workspace?, parent_task_id?, blocked_by?, optional?, assignee_role_id? })`
  - `comment_task({ taskId, text })`
- `createTaskQueue({ roomDb, repository, timeline, outbox, now })`
  - `createTask({ chatId, roleId, title, description, acceptance, parentTaskId = null, blockedBy = [], optional = false, assigneeRoleId = null }) -> { taskId, runId }`
  - `enqueueRun({ taskId, roleId, laneKind = 'executor', required = true, continuesRunId = null, writeScopes = [] }) -> run`
  - `listRuns(taskId) -> run[]`
  - `pump({ roomId }) -> Promise<run[]>`
  - `getLane({ taskId, roleId })`

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')
const { createOutbox } = require('../../src/room/effects.cjs')
const { createTaskQueue } = require('../../src/room/task-queue.cjs')

test('create_task creates a task, executor lane, and one queued run', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const roleId = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId })
  const timeline = createTimeline({ roomDb, repository: repo })
  const outbox = createOutbox({ roomDb, repository: repo })
  const queue = createTaskQueue({ roomDb, repository: repo, timeline, outbox })
  const task = queue.createTask({ chatId, roleId, title: 'T', description: 'D', acceptance: 'A' })
  const runs = queue.listRuns(task.taskId)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'queued')
  assert.equal(queue.getLane({ taskId: task.taskId, roleId }).kind, 'executor')
  roomDb.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/task-queue.test.cjs`
Expected: FAIL because task-queue/tasks do not exist.

- [ ] **Step 3: Implement task tools and queue**

`create_task` writes `tasks`, `task_lanes(executor)`, `task_runs(queued)`, and a `start_run` effect in one transaction. `comment_task` inserts `task_activities` and, if no run is active, creates a continuation run in the same lane. `pump` starts at most one unfinished run per lane and one write-capable run per Room; it consumes `start_run` effects and marks effect succeeded after launch.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/task-queue.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/tools/tasks.cjs desktop/src/room/task-queue.cjs desktop/test/room/task-queue.test.cjs
git commit -m "feat(room): add task lanes and run queue"
```

---

### Task 10: finish_task and settlement

**Files:**
- Create: `desktop/src/room/settlement.cjs`
- Test: `desktop/test/room/settlement.test.cjs`

**Interfaces:**
- `createSettlement({ roomDb, repository, timeline, now })`
  - `claim({ runId, taskId, status, summary, evidence = [], artifactIds = [] }) -> { report, task }`
  - `settle({ runId, exit: { observed: true|false, code }, snapshot: { state: 'completed'|'not_applicable'|'failed', artifactIds? } }) -> { task, run }`
  - `acceptTask({ taskId, commandId }) -> task`
- `registerFinishTaskTool({ dispatcher, settlement })` calls `claim`.

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createSettlement } = require('../../src/room/settlement.cjs')

test('finish_task claims but does not enter in_review before settlement', t => {
  // seed room/chat/role/task/run with run.status='running'
  const claim = settlement.claim({ runId, taskId, status: 'ready', summary: 'done' })
  assert.equal(claim.report.kind, 'ready')
  assert.equal(roomDb.database.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status, 'in_progress')
  const settled = settlement.settle({ runId, exit: { observed: true, code: 0 }, snapshot: { state: 'completed' } })
  assert.equal(settled.task.status, 'in_review')
  assert.equal(settled.run.snapshotState, 'completed')
})

test('read-only task settles with snapshot not_applicable', () => {
  // same seed with run.permissionMode='read-only'
  const claim = settlement.claim({ runId, taskId, status: 'ready', summary: 'done' })
  const settled = settlement.settle({ runId, exit: { observed: true, code: 0 }, snapshot: { state: 'not_applicable' } })
  assert.equal(claim.report.kind, 'ready')
  assert.equal(settled.task.status, 'in_review')
  assert.equal(settled.run.snapshotState, 'not_applicable')
})

test('observed non-zero exit is failed/known, unconfirmed exit is interrupted/unknown', () => {
  // seed two running runs
  const failed = settlement.settle({ runId: knownRun, exit: { observed: true, code: 1 }, snapshot: { state: 'failed' } })
  const unknown = settlement.settle({ runId: unknownRun, exit: { observed: false } })
  assert.equal(failed.run.status, 'failed')
  assert.equal(failed.run.outcome, 'known')
  assert.equal(failed.task.status, 'blocked')
  assert.equal(unknown.run.status, 'interrupted')
  assert.equal(unknown.run.outcome, 'unknown')
  assert.equal(unknown.task.status, 'blocked')
})

test('accept_task refuses before settlement and succeeds after', () => {
  // seed task in_progress + ready claim, no settlement yet
  assert.throws(() => settlement.acceptTask({ taskId, commandId: 'a1' }), /ROOM_TASK_NOT_SETTLED/)
  // settle with exit observed + snapshot completed, then accept
  settlement.settle({ runId, exit: { observed: true, code: 0 }, snapshot: { state: 'completed' } })
  assert.equal(settlement.acceptTask({ taskId, commandId: 'a2' }).status, 'done')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/settlement.test.cjs`
Expected: FAIL because `settlement.cjs` does not exist.

- [ ] **Step 3: Implement claim and settlement**

`claim` writes `reports` and `task_activities`, posts the Chat message, and keeps Task `in_progress`. `settle`:

- write-capable: require exit observed + snapshot completed; merge platform artifact IDs into report; Task `in_review`/`blocked`; `snapshot_state=completed`.
- read-only: require exit observed + snapshot `not_applicable`; Task `in_review`/`blocked`.
- observed non-zero exit: `run.status=failed, outcome=known`, Task `blocked`, Attention; report kept.
- exit unconfirmed: `run.status=interrupted, outcome=unknown`, Task `blocked`, Attention.
- snapshot failed: `snapshot_state=failed`, no `in_review`, Attention.
`acceptTask` requires `in_review` + settlement complete.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/settlement.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/settlement.cjs desktop/test/room/settlement.test.cjs
git commit -m "feat(room): add finish claim and settlement"
```

---

### Task 11: Captain review supervisor

**Files:**
- Create: `desktop/src/room/captain-review.cjs`
- Create: `desktop/src/room/supervisor.cjs`
- Create: `desktop/src/room/tools/captain.cjs`
- Test: `desktop/test/room/captain-review.test.cjs`

**Interfaces:**
- `createCaptainReview({ roomDb, repository, timeline, now })`
  - `recordAssignment({ chatId, messageId, rootMessageId, targetRoleIds, targetReplyIds }) -> assignment`
  - `review({ chatId }) -> CaptainReview[]` creates pending reviews
  - `deliver({ chatId }) -> ReviewDelivery[]` sends system review message + queues Captain reply
- `createCaptainAssignment({ roomDb, repository, timeline, review, queueReply, requestTick })`
  - `assign({ chatId, captainRoleId, text, roleIds = [] }) -> { message, assignment, replies }`
- `createSupervisor({ captainReview, now, tickMs = 60_000, debounceMs = 150 })`
  - `requestTick(chatId?)`
  - `start()`, `stop()`

- [ ] **Step 1: Write the failing test**

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')
const { createCaptainReview } = require('../../src/room/captain-review.cjs')
const { createCaptainAssignment } = require('../../src/room/tools/captain.cjs')

// test-only helper: seedTaskInProgress(roomDb, chatId, roleId) inserts a tasks row
// and a task_runs row with status='in_progress', then returns the task id.

test('captain review waits for settlement and review traffic does not advance activity', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const captainRoleId = repo.createRole({ chatId, displayName: 'Captain', provider: 'claude', prompt: 'route', isCaptain: true })
  const a = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'work' })
  repo.addParticipant({ chatId, roleId: captainRoleId }); repo.addParticipant({ chatId, roleId: a })
  const timeline = createTimeline({ roomDb, repository: repo })
  const assignmentMessage = timeline.append({ chatId, authorType: 'agent', authorId: captainRoleId,
    content: '@A do it', mentions: [a] })
  const reply = timeline.append({ chatId, authorType: 'agent', authorId: a, content: '' })
  timeline.finish(reply.id, { status: 'done', text: 'done' })
  const taskId = seedTaskInProgress(roomDb, chatId, a) // helper: inserts Task + TaskRun in_progress
  const review = createCaptainReview({ roomDb, repository: repo, timeline })
  review.recordAssignment({ chatId, messageId: assignmentMessage.id, rootMessageId: assignmentMessage.id,
    targetRoleIds: [a], targetReplyIds: [reply.id] })
  assert.equal(review.review({ chatId }).length, 0) // Task still in_progress
  roomDb.database.prepare("UPDATE tasks SET status='in_review' WHERE id=?").run(taskId)
  const pending = review.review({ chatId })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].kind, 'assignment_settled')
  const activityBefore = timeline.activitySeq(chatId)
  review.deliver({ chatId })
  assert.equal(timeline.activitySeq(chatId), activityBefore)
  const reviewRow = timeline.latest(chatId)
  assert.equal(reviewRow.audience, 'captain')
  const captainReply = timeline.after(chatId, activityBefore).find(row => row.authorId === captainRoleId)
  assert.equal(captainReply.audience, 'captain')
  assert.equal(captainReply.data.reviewReply, true)
  timeline.append({ chatId, authorType: 'agent', authorId: captainRoleId, content: 'public notice' })
  assert.equal(timeline.activitySeq(chatId) > activityBefore, true)
  roomDb.close()
})

test('assign_in_group writes one message, one assignment, and target queued replies; rejects self', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const captainRoleId = repo.createRole({ chatId, displayName: 'Captain', provider: 'claude', prompt: 'route', isCaptain: true })
  const a = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'work' })
  repo.addParticipant({ chatId, roleId: captainRoleId }); repo.addParticipant({ chatId, roleId: a })
  const timeline = createTimeline({ roomDb, repository: repo })
  const review = createCaptainReview({ roomDb, repository: repo, timeline })
  const queued = []
  const assign = createCaptainAssignment({ roomDb, repository: repo, timeline, review,
    queueReply: input => { queued.push(input); return timeline.append({ chatId, authorType: 'agent', authorId: input.roleId, content: '' }) },
    requestTick: () => {} })
  const result = assign.assign({ chatId, captainRoleId, text: '@A do it', roleIds: [a] })
  assert.equal(result.message.authorId, captainRoleId)
  assert.deepEqual(result.message.mentions, [a])
  assert.equal(result.replies.length, 1)
  assert.equal(queued.length, 1)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM captain_assignments').get().n, 1)
  assert.throws(() => assign.assign({ chatId, captainRoleId, text: 'self', roleIds: [captainRoleId] }), /ROOM_CAPTAIN_SELF_TARGET/)
  roomDb.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/captain-review.test.cjs`
Expected: FAIL because files do not exist.

- [ ] **Step 3: Implement review and supervisor**

Use `docs-new2/03-conversation-session-and-briefing.md` section 8 and `docs-new2/04-task-captain-and-report.md` section 6.4 exactly:

- `activityBaseline = max(checkpoint, non-cancelled assignment public message seq)`;
- `hasNew = chats.activity_seq > activityBaseline`;
- skip active targets (`queued/working/stopping`) and tasks `todo/in_progress` or with open runs;
- no Task required;
- create review with dedupe key `conversation:kind:checkpoint`;
- deliver only when Captain idle, batch same Chat pending reviews, create `captain_review` system row (`audience=captain`) + queued reply (`reviewReply=true`);
- `activity_seq` excludes both;
- `post_in_chat` public; `blocked` -> `assignment_blocked`;
- `reviewReply` only on the delivery reply;
- `assign_in_group`: write the public message + `captain_assignments` (target reply ids) + target queued replies in one transaction; never target Captain; no `roleIds` -> exactly one non-Captain active role or error; `requestTick()` after commit.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/captain-review.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/captain-review.cjs desktop/src/room/supervisor.cjs desktop/src/room/tools/captain.cjs desktop/test/room/captain-review.test.cjs
git commit -m "feat(room): add captain assignment and review supervisor"
```

---

### Task 12: Restart recovery

**Files:**
- Create: `desktop/src/room/recovery.cjs`
- Test: `desktop/test/room/recovery.test.cjs`

**Interfaces:**
- `recoverOnStart({ roomDb, repository, now }) -> { interruptedMessages, interruptedRuns, unknownEffects }`
- `reconcileProcess({ runId, records }) -> { exited: boolean, known: boolean }`

- [ ] **Step 1: Write the failing test**

```js
test('restart keeps queued, interrupts working, marks runs unknown, and never replays unknown effects', () => {
  // seed queued/working messages, running TaskRun, running effect
  // recoverOnStart
  // queued remains, working interrupted, run interrupted/outcome=unknown, effect unknown
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && node --test test/room/recovery.test.cjs`
Expected: FAIL because `recovery.cjs` does not exist.

- [ ] **Step 3: Implement recovery**

On start, `queued` stays; `working/waiting_for_input` -> `interrupted`; TaskRun `starting/running` -> `status=interrupted, outcome=unknown`; `effects running` -> `unknown`; create Attention for potentially side-effecting runs. Do not auto-start a lane until process reconciliation. `reconcileProcess` only reports exited when all records are ended and identity matches.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop && node --test test/room/recovery.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/room/recovery.cjs desktop/test/room/recovery.test.cjs
git commit -m "feat(room): add restart recovery"
```

---

### Task 13: Real CLI proofs and seam smoke

**Files:**
- Create: `desktop/scripts/room-resume-proof.cjs`
- Create: `desktop/scripts/room-mcp-proof.cjs`
- Create: `desktop/scripts/room-seam-smoke.cjs`

**Interfaces:**
- Resume proof accepts `--run --provider claude|codex`, writes `userData/room-resume-proof.json`.
- MCP proof starts the local tool server and uses the MCP client to list/call tools; writes `userData/room-mcp-proof.json`.
- Seam smoke accepts `--run --provider claude|codex`, runs the full chain, writes `userData/room-seam-result.json`.

- [ ] **Step 1: Write the resume proof script**

Use the `LocalWorkspace` + `runAgent` pattern in `desktop/scripts/smoke-room.cjs`. First prompt: “Remember the number 47; do not repeat it.” Second prompt after resume: “What number did I ask you to remember?” Expected answer contains `47`. Record `{ provider, resumed: boolean, remembered: boolean, sessionRefChanged, error }`.

- [ ] **Step 2: Run it with Claude Code**

Run: `cd desktop && npm run build:frontend && ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/room-resume-proof.cjs --run --provider claude`
Expected: `remembered: true`, `resumed: true`. If not, stop and revise the session design; do not proceed.

- [ ] **Step 3: Run it with Codex**

Run: same with `--provider codex`.
Expected: same. If Codex cannot resume, record the failure and keep it read-only in the slice.

- [ ] **Step 4: Write and run the MCP proof**

Start the local MCP server, list tools, call `mention`/`create_task`/`finish_task`, and assert results are returned to the client. Run with a real CLI if it supports MCP; otherwise assert the CLI is read-only and marker fallback is limited.

- [ ] **Step 5: Write and run the seam smoke**

Chain: persistent session → `create_task` → task session → `finish_task` → exit → snapshot/`not_applicable` → settlement → Captain review. Assert Task reaches `in_review` only after settlement and the review row does not advance `activity_seq`.

- [ ] **Step 6: Commit**

```bash
git add desktop/scripts/room-resume-proof.cjs desktop/scripts/room-mcp-proof.cjs desktop/scripts/room-seam-smoke.cjs
git commit -m "test(room): add real cli resume and seam proofs"
```

---

## Self-Review

- **Spec coverage:** Tasks 1–4 cover ledger, participants, timeline, sessions; 5–6 cover routing and briefing; 7–8 cover effects, engine, tools, mention; 9–10 cover tasks, runs, finish, settlement; 11 covers Captain review; 12 covers recovery; 13 covers resume/MCP/seam proofs. UI, legacy migration, and full schema fields remain for later plans as specified in `docs-new2/06`.
- **Step scan:** Each task ends with a failing test, implementation, passing test, and commit. Tests pin input, output, and error codes. No task asks the implementer to guess a workflow.
- **Type consistency:** `MessageView`, `sessionId`, `lastSeq`, `activitySeq`, `snapshot_state`, `outcome`, `callId`, `captain_assignment_id` are used consistently with `docs-new2/02` and `03`.
- **Review Focus mapping:** resume -> Task 13 Step 2/3; MCP -> Task 8/13 Step 4; finish settlement -> Task 10; read-only snapshot -> Task 10; review loop -> Task 11.
- **Proportion:** This plan covers the first vertical slice only. Full UI, migration, and legacy deletion are separate plans.
