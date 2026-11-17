const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createToolDispatcher } = require('../../src/room/tools/dispatcher.cjs')

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const a = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p' })
  const b = repo.createRole({ chatId, displayName: 'B', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId: a })
  repo.addParticipant({ chatId, roleId: b })
  const dispatcher = createToolDispatcher({ roomDb, repository: repo })
  return { roomDb, repo, chatId, a, b, dispatcher }
}

test('same callId returns the original result; same args with a new callId executes again', async t => {
  const { roomDb, chatId, a, dispatcher } = setup(t)
  let calls = 0
  dispatcher.register('echo', async args => { calls += 1; return { n: calls, args } })
  dispatcher.bindRun('run1', { chatId, roleId: a, allowedTools: ['echo'] })
  const first = await dispatcher.invoke({ runId: 'run1', callId: 'call1', name: 'echo', args: { x: 1 } })
  const retry = await dispatcher.invoke({ runId: 'run1', callId: 'call1', name: 'echo', args: { x: 1 } })
  const next = await dispatcher.invoke({ runId: 'run1', callId: 'call2', name: 'echo', args: { x: 1 } })
  assert.deepEqual(retry, first)
  assert.equal(next.n, 2)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM tool_calls').get().n, 2)
  await assert.rejects(
    dispatcher.invoke({ runId: 'run1', callId: 'call1', name: 'echo', args: { x: 2 } }),
    /ROOM_TOOL_CALL_ARGS_MISMATCH/,
  )
  await assert.rejects(
    dispatcher.invoke({ runId: 'run1', callId: 'call3', name: 'other', args: {} }),
    /ROOM_TOOL_NOT_ALLOWED/,
  )
  roomDb.close()
})

test('read-only tools execute every time and record audit rows', async t => {
  const { roomDb, chatId, a, dispatcher } = setup(t)
  let calls = 0
  dispatcher.register('look', async () => { calls += 1; return { calls } }, { readOnly: true })
  dispatcher.bindRun('run1', { chatId, roleId: a, allowedTools: ['look'] })
  const first = await dispatcher.invoke({ runId: 'run1', callId: 'same', name: 'look', args: {} })
  const second = await dispatcher.invoke({ runId: 'run1', callId: 'same', name: 'look', args: {} })
  assert.equal(first.calls, 1)
  assert.equal(second.calls, 2)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM tool_calls').get().n, 2)
  roomDb.close()
})
