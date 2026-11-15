const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')

function tempDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-')) }

test('v2 migration preserves rooms and defaults existing workspaces to read-only', t => {
  const directory = tempDirectory()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const first = openRoomDatabase({ directory })
  const roomId = createRoomRepository(first).createRoom({ name: 'Existing', workspace: directory })
  first.database.exec('ALTER TABLE rooms DROP COLUMN write_authorized_root; PRAGMA user_version = 2;')
  first.close()
  const migrated = openRoomDatabase({ directory })
  assert.equal(migrated.database.prepare('PRAGMA user_version').get().user_version, 3)
  assert.equal(migrated.database.prepare('SELECT write_authorized_root FROM rooms WHERE id=?').get(roomId).write_authorized_root, null)
  migrated.database.prepare('UPDATE rooms SET write_authorized_root=? WHERE id=?').run(directory, roomId)
  migrated.close()
  const reopened = openRoomDatabase({ directory })
  assert.equal(reopened.database.prepare('SELECT write_authorized_root FROM rooms WHERE id=?').get(roomId).write_authorized_root, directory)
  reopened.close()
})

test('room database creates private schema and persists the message/task/effect ledger', () => {
  const directory = tempDirectory()
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo', providers: ['codex'] })
  const chatId = repository.createChat({ roomId, title: 'New chat', isPrimary: true })
  assert.deepEqual({ ...roomDb.database.prepare('SELECT title, status, is_primary FROM chats WHERE id = ?').get(chatId) }, {
    title: 'New chat', status: 'active', is_primary: 1,
  })
  const message = repository.appendMessage({ chatId, authorType: 'user', authorId: 'user-1', content: '@codex inspect' })
  const taskId = repository.createTask({ chatId, objective: 'Inspect project', createdBy: 'user-1', sourceMessageIds: [message.messageId] })
  const effectId = repository.createEffect({ chatId, kind: 'start_assignment', payload: { taskId }, idempotencyKey: 'start:1' })

  assert.equal(repository.listMessages(chatId).length, 1)
  assert.equal(repository.getTask(taskId).status, 'open')
  assert.equal(repository.getEffect(effectId).status, 'pending')
  assert.equal(roomDb.database.prepare('PRAGMA user_version').get().user_version, 3)
  roomDb.close()
})

test('room database transaction rolls back all writes on failure', () => {
  const directory = tempDirectory()
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  assert.throws(() => roomDb.withTransaction(() => {
    repository.createChat({ roomId, title: 'Will rollback' })
    throw new Error('stop')
  }), /stop/)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS count FROM chats').get().count, 0)
  roomDb.close()
})

test('room database is private and survives close/reopen', () => {
  const directory = tempDirectory()
  const first = openRoomDatabase({ directory })
  const repository = createRoomRepository(first)
  const roomId = repository.createRoom({ name: 'Persistent room', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Persistent chat' })
  repository.appendMessage({ chatId, authorType: 'user', authorId: 'user-1', content: 'keep this' })
  const databasePath = path.join(directory, 'db.sqlite')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
    assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600)
  }
  first.close()

  const reopened = openRoomDatabase({ directory })
  const messages = reopened.database.prepare('SELECT content FROM messages WHERE chat_id = ?').all(chatId)
    .map((message) => ({ ...message }))
  assert.deepEqual(messages, [{ content: 'keep this' }])
  reopened.close()
})

test('nested transactions isolate failures and remain part of the outer transaction', () => {
  const roomDb = openRoomDatabase({ directory: tempDirectory() })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Nested', workspace: '/tmp/demo' })
  assert.throws(() => roomDb.withTransaction(() => {
    roomDb.withTransaction(() => repository.createChat({ roomId, title: 'Inner committed' }))
    throw new Error('outer failed')
  }), /outer failed/)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS count FROM chats').get().count, 0)
  roomDb.withTransaction(() => {
    assert.throws(() => roomDb.withTransaction(() => {
      repository.createChat({ roomId, title: 'Inner failed' })
      throw new Error('inner failed')
    }), /inner failed/)
    repository.createChat({ roomId, title: 'Outer survived' })
  })
  assert.deepEqual(roomDb.database.prepare('SELECT title FROM chats').all().map(row => row.title), ['Outer survived'])
  assert.throws(() => roomDb.withTransaction(() => Promise.resolve()), /MUST_BE_SYNCHRONOUS/)
  roomDb.close()
})

test('room database rejects a path-like filename', () => {
  const directory = tempDirectory()
  assert.throws(() => openRoomDatabase({ directory, filename: '../db.sqlite' }), /ROOM_DATABASE_FILENAME_MUST_BE_BASENAME/)
})

test('repository records roles, assignments, reports, artifacts, and attentions', () => {
  const directory = tempDirectory()
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const roleId = repository.createAgentRole({
    chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user-1', capabilities: ['documents'],
  })
  const taskId = repository.createTask({ chatId, objective: 'Draft', createdBy: 'user-1' })
  const assignmentId = repository.createAssignment({ taskId, roleId, required: true })
  const artifactId = repository.createArtifact({ roomId, sourceTaskId: taskId, sourceAssignmentId: assignmentId, path: 'docs/draft.md', kind: 'document', version: 'v1' })
  const attentionId = repository.createAttention({ chatId, taskId, type: 'approval', question: 'Accept?', options: [{ id: 'yes', label: 'Yes' }], requestedBy: 'controller' })
  const reportId = repository.createReport({ taskId, assignmentId, kind: 'ready', summary: 'Draft ready', artifactIds: [artifactId], attentionId })

  assert.equal(repository.getTask(taskId).latest_report_id, reportId)
  assert.equal(repository.getReport(reportId).kind, 'ready')
  assert.equal(repository.listAssignments(taskId).length, 1)
  assert.throws(() => repository.createReport({ taskId, assignmentId, kind: 'done', summary: 'invalid' }), /ROOM_REPORT_KIND_INVALID/)
  roomDb.close()
})
