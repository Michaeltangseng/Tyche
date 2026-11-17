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
