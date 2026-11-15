const assert = require('node:assert/strict')
const test = require('node:test')
const { createControllerQueue } = require('../../src/room-engine/controller-queue.cjs')

test('queue automatically merges messages and deduplicates IDs within a batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const queue = createControllerQueue({ processBatch: async input => { calls.push(input); return 'routed' }, getContextRevision: () => 3 })
  const a = queue.enqueue({ chatId: 'chat', messageId: 'a' })
  const b = queue.enqueue({ chatId: 'chat', messageId: 'b' })
  const duplicate = queue.enqueue({ chatId: 'chat', messageId: 'a' })
  t.mock.timers.tick(40)
  assert.deepEqual(await Promise.all([a, b, duplicate]), ['routed', 'routed', 'routed'])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].messageIds, ['a', 'b'])
  assert.equal(calls[0].contextRevision, 3)
  await queue.close()
})

test('messages received during evaluation wait for the next batch with fresh context', async () => {
  let finish
  let revision = 0
  const calls = []
  const queue = createControllerQueue({
    getContextRevision: () => revision,
    processBatch: input => {
      calls.push(input)
      return new Promise(resolve => { finish = resolve })
    },
  })
  const firstMessage = queue.enqueue({ chatId: 'chat', messageId: 'a' })
  const firstBatch = queue.flush('chat')
  await Promise.resolve()
  const nextMessage = queue.enqueue({ chatId: 'chat', messageId: 'b' })
  assert.equal(queue.flush('chat'), firstBatch)
  finish('first')
  await firstBatch
  assert.equal(await firstMessage, 'first')
  revision = 1
  const nextBatch = queue.flush('chat')
  await Promise.resolve()
  assert.deepEqual(calls[1].messageIds, ['b'])
  assert.equal(calls[1].contextRevision, 1)
  finish('second')
  await nextBatch
  assert.equal(await nextMessage, 'second')
  await queue.close()
})

test('one chat failure does not block other chats or the next batch', async () => {
  let fail = true
  const queue = createControllerQueue({ getContextRevision: () => 0, processBatch: async input => {
    if (input.chatId === 'broken' && fail) throw new Error('router failed')
    return input.chatId
  } })
  const broken = queue.enqueue({ chatId: 'broken', messageId: 'a' })
  const healthy = queue.enqueue({ chatId: 'healthy', messageId: 'b' })
  const rejected = assert.rejects(broken, /router failed/)
  await assert.rejects(queue.flush('broken'), /router failed/)
  await rejected
  await queue.flush('healthy')
  assert.equal(await healthy, 'healthy')
  fail = false
  const retry = queue.enqueue({ chatId: 'broken', messageId: 'a' })
  await queue.flush('broken')
  assert.equal(await retry, 'broken')
  await queue.close()
})

test('closing aborts active batches, rejects pending messages and stops new enqueues', async () => {
  let signal
  const queue = createControllerQueue({ getContextRevision: () => 0, processBatch: input => {
    signal = input.signal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  } })
  const active = queue.enqueue({ chatId: 'chat', messageId: 'a' })
  const rejectedActive = assert.rejects(active, /cancelled/)
  const running = queue.flush('chat')
  const rejectedRunning = assert.rejects(running, /cancelled/)
  await Promise.resolve()
  const pending = queue.enqueue({ chatId: 'chat', messageId: 'b' })
  const rejectedPending = assert.rejects(pending, /QUEUE_CLOSED/)
  await queue.close()
  await Promise.all([rejectedActive, rejectedRunning, rejectedPending])
  assert.equal(signal.aborted, true)
  await assert.rejects(queue.enqueue({ chatId: 'chat', messageId: 'c' }), /QUEUE_CLOSED/)
})
