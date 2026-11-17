const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createRuntimeEvents } = require('../../src/room/runtime-events.cjs')

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-runtime-events-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  return { roomDb, chatId }
}

test('runtime events truncate oversized payloads and filter by run', t => {
  const { roomDb, chatId } = setup(t)
  const events = createRuntimeEvents({ roomDb, maxPayloadBytes: 64 })

  events.record({
    runId: 'r1',
    chatId,
    mode: 'chat',
    event: { kind: 'tool_call_ended', seq: 1, output: 'x'.repeat(200) },
  })
  events.record({
    runId: 'r2',
    chatId,
    taskId: 't1',
    mode: 'task',
    event: { kind: 'turn_ended', seq: 2, outcome: { kind: 'completed' } },
  })

  const first = events.list({ runId: 'r1' })
  assert.equal(first.length, 1)
  assert.equal(first[0].kind, 'tool_call_ended')
  assert.equal(first[0].mode, 'chat')
  assert.equal(first[0].payload.truncated, true)
  assert.equal(first[0].payload.preview.length <= 64, true)
  assert.equal(events.list({ chatId }).length, 2)
  assert.equal(events.count({ runId: 'r2' }), 1)
  assert.throws(() => events.record({
    runId: 'r3', chatId, mode: 'other', event: { kind: 'x' },
  }), /ROOM_RUNTIME_EVENT_MODE_INVALID/)

  roomDb.close()
})
