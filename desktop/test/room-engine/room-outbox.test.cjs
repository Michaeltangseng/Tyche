const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createRoomOutbox } = require('../../src/room-engine/room-outbox.cjs')

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-outbox-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  return { roomDb, repository, chatId, outbox: createRoomOutbox({ roomDb, repository }) }
}

test('enqueue is idempotent and stores the payload before execution', () => {
  const { roomDb, outbox, chatId } = setup()
  const first = outbox.enqueue({ chatId, kind: 'start_assignment', payload: { taskId: 'task-1' }, idempotencyKey: 'start:task-1' })
  const second = outbox.enqueue({ chatId, kind: 'different', payload: { ignored: true }, idempotencyKey: 'start:task-1' })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.effect.id, first.effect.id)
  assert.deepEqual(first.effect.payload, { taskId: 'task-1' })
  roomDb.close()
})

test('claim and terminal transitions enforce the outbox state machine', () => {
  const { roomDb, outbox, chatId } = setup()
  const { effect } = outbox.enqueue({ chatId, kind: 'write_message', payload: {}, idempotencyKey: 'write:1' })
  const claimed = outbox.claimPending()
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].status, 'running')
  assert.equal(claimed[0].attempts, 1)
  assert.equal(outbox.markSucceeded(effect.id).status, 'succeeded')
  assert.deepEqual(outbox.claimPending(), [])
  assert.equal(outbox.markSucceeded(effect.id).status, 'succeeded')
  roomDb.close()
})

test('runOnce records failed and unknown effects, and unknown can be retried', async () => {
  const { roomDb, outbox, chatId } = setup()
  const failed = outbox.enqueue({ chatId, kind: 'fail', payload: {}, idempotencyKey: 'fail:1' }).effect
  const failedResult = await outbox.runOnce(async () => { throw new Error('boom') })
  assert.equal(failedResult.effect.id, failed.id)
  assert.equal(failedResult.effect.status, 'failed')

  const unknown = outbox.enqueue({ chatId, kind: 'ambiguous', payload: {}, idempotencyKey: 'unknown:1' }).effect
  const unknownResult = await outbox.runOnce(async () => { throw Object.assign(new Error('lost'), { unknown: true }) })
  assert.equal(unknownResult.effect.id, unknown.id)
  assert.equal(unknownResult.effect.status, 'unknown')
  assert.equal(outbox.retryUnknown(unknown.id).status, 'pending')
  assert.equal((await outbox.runOnce(async () => 'ok')).effect.status, 'succeeded')
  roomDb.close()
})

test('outbox refuses invalid recovery transitions', () => {
  const { roomDb, outbox, chatId } = setup()
  const { effect } = outbox.enqueue({ chatId, kind: 'queued', payload: {}, idempotencyKey: 'queued:1' })
  assert.throws(() => outbox.markSucceeded(effect.id), /ROOM_EFFECT_NOT_RUNNING/)
  assert.throws(() => outbox.retryUnknown(effect.id), /ROOM_EFFECT_NOT_RECOVERABLE/)
  roomDb.close()
})
