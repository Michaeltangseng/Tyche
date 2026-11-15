const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createSessionSupervisor } = require('../../src/room-engine/session-supervisor.cjs')

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-session-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const roleId = repository.createAgentRole({ chatId, displayName: 'Backend', provider: 'codex', createdBy: 'user' })
  const taskId = repository.createTask({ chatId, objective: 'Implement API', createdBy: 'user' })
  const assignmentId = repository.createAssignment({ taskId, roleId })
  const supervisor = createSessionSupervisor({ roomDb, repository, now: () => new Date('2026-11-15T01:00:00.000Z') })
  return { roomDb, repository, roomId, chatId, taskId, assignmentId, supervisor }
}

test('supervisor records platform liveness facts with supervisor ownership', () => {
  const { roomDb, supervisor, roomId, chatId, assignmentId } = setup()
  supervisor.started({ chatId, assignmentId, runId: 'run-1', observedAt: '2026-11-15T00:00:00.000Z' })
  supervisor.liveness({ chatId, assignmentId, state: 'running', observedAt: '2026-11-15T00:30:00.000Z' })
  supervisor.exited({ chatId, assignmentId, runId: 'run-1', exitCode: 0, reason: 'complete', observedAt: '2026-11-15T01:00:00.000Z' })
  const events = supervisor && roomDb.database.prepare("SELECT * FROM events WHERE room_id = ? ORDER BY sequence").all(roomId)
  assert.deepEqual(events.map((event) => [event.type, event.actor_id]), [
    ['session_started', 'supervisor'], ['session_liveness', 'supervisor'], ['session_exited', 'supervisor'],
  ])
  roomDb.close()
})

test('stale query uses observed liveness and ignores non-running sessions', () => {
  const { roomDb, supervisor, roomId, chatId, assignmentId } = setup()
  supervisor.liveness({ chatId, assignmentId, state: 'running', observedAt: '2026-11-14T23:00:00.000Z' })
  assert.equal(supervisor.listStale({ roomId, timeoutMs: 30 * 60 * 1000 }).length, 1)
  supervisor.liveness({ chatId, assignmentId, state: 'idle', observedAt: '2026-11-15T00:59:00.000Z' })
  assert.equal(supervisor.listStale({ roomId, timeoutMs: 30 * 60 * 1000 }).length, 0)
  roomDb.close()
})

test('stale query ignores an assignment that exited after its last heartbeat', () => {
  const { roomDb, supervisor, roomId, chatId, assignmentId } = setup()
  supervisor.liveness({ chatId, assignmentId, state: 'running', observedAt: '2026-11-14T23:00:00.000Z' })
  supervisor.exited({ chatId, assignmentId, runId: 'run-1', exitCode: 0, reason: 'complete', observedAt: '2026-11-15T00:59:00.000Z' })
  assert.equal(supervisor.listStale({ roomId, timeoutMs: 30 * 60 * 1000 }).length, 0)
  roomDb.close()
})

test('supervisor rejects worker-like state and unknown assignments', () => {
  const { roomDb, supervisor, chatId } = setup()
  assert.throws(() => supervisor.liveness({ chatId, assignmentId: 'missing', state: 'running' }), /NOT_FOUND/)
  assert.throws(() => supervisor.liveness({ chatId, assignmentId: 'missing', state: 'complete' }), /STATE_INVALID/)
  roomDb.close()
})
