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

test('batch capacity splits messages and events without dropping or reordering inputs', async () => {
  const calls = []
  const queue = createControllerQueue({ maxBatchSize: 2, getContextRevision: () => 0,
    processBatch: async input => { calls.push(input); return calls.length } })
  const results = [
    queue.enqueue({ chatId: 'chat', messageId: 'a' }),
    queue.enqueue({ chatId: 'chat', eventId: 'event' }),
    queue.enqueue({ chatId: 'chat', messageId: 'b' }),
    queue.enqueue({ chatId: 'chat', messageId: 'c' }),
    queue.enqueue({ chatId: 'chat', messageId: 'd' }),
  ]
  await queue.flush('chat')
  await queue.flush('chat')
  await queue.flush('chat')
  assert.deepEqual(await Promise.all(results), [1, 1, 2, 2, 3])
  assert.deepEqual(calls.map(input => [input.messageIds, input.triggerEventIds]), [
    [['a'], ['event']], [['b', 'c'], []], [['d'], []],
  ])
  await queue.close()
})

test('transient failures retry the same inputs after exponential cooldown with fresh context', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const retryErrors = []
  let revision = 0
  const queue = createControllerQueue({
    getContextRevision: () => revision, retryBaseMs: 100, retryMaxMs: 150,
    shouldRetry: error => error.message === 'timeout', onRetryError: error => retryErrors.push(error),
    processBatch: async input => { calls.push(input); if (calls.length < 3) throw new Error('timeout'); return 'ok' },
  })
  const first = queue.enqueue({ chatId: 'chat', messageId: 'a' })
  const rejected = assert.rejects(first, /timeout/)
  await assert.rejects(queue.flush('chat'), /timeout/)
  await rejected
  const next = queue.enqueue({ chatId: 'chat', messageId: 'b' })
  assert.equal(await queue.flush('chat'), null)
  t.mock.timers.tick(99)
  assert.equal(calls.length, 1)
  revision = 1
  t.mock.timers.tick(1)
  await assert.rejects(queue.flush('chat'), /timeout/)
  assert.equal(calls[1].contextRevision, 1)
  assert.deepEqual(calls[1].messageIds, ['a'])
  t.mock.timers.tick(149)
  assert.equal(calls.length, 2)
  t.mock.timers.tick(1)
  assert.equal(await queue.flush('chat'), 'ok')
  assert.deepEqual(calls[2].messageIds, ['a'])
  await queue.flush('chat')
  assert.equal(await next, 'ok')
  assert.deepEqual(calls[3].messageIds, ['b'])
  assert.equal(new Set(calls.map(call => call.batchId)).size, 4)
  assert.equal(retryErrors.length, 1)
  await queue.close()
})

test('retry exhaustion stops timers and duplicate arrivals cannot reset the budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const queue = createControllerQueue({ maxRetries: 2, retryBaseMs: 100, getContextRevision: () => 0,
    shouldRetry: () => true, processBatch: async () => { calls += 1; throw new Error('offline') } })
  const initial = queue.enqueue({ chatId: 'chat', messageId: 'a' })
  const rejected = assert.rejects(initial, /offline/)
  await assert.rejects(queue.flush('chat'), /offline/)
  await rejected
  const duplicate = queue.enqueue({ chatId: 'chat', messageId: 'a' })
  const rejectedDuplicate = assert.rejects(duplicate, /offline/)
  t.mock.timers.tick(100)
  await assert.rejects(queue.flush('chat'), /offline/)
  t.mock.timers.tick(200)
  await assert.rejects(queue.flush('chat'), /offline/)
  await rejectedDuplicate
  t.mock.timers.tick(60_000)
  assert.equal(await queue.flush('chat'), null)
  assert.equal(calls, 3)
  await queue.close()
})

test('a cooling chat does not block others and close cancels scheduled retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const queue = createControllerQueue({ getContextRevision: () => 0, shouldRetry: () => true,
    processBatch: async input => { calls.push(input.chatId); if (input.chatId === 'broken') throw new Error('offline'); return 'ok' } })
  const failed = queue.enqueue({ chatId: 'broken', messageId: 'a' })
  const rejected = assert.rejects(failed, /offline/)
  await assert.rejects(queue.flush('broken'), /offline/)
  await rejected
  const healthy = queue.enqueue({ chatId: 'healthy', eventId: 'report' })
  await queue.flush('healthy')
  assert.equal(await healthy, 'ok')
  await queue.close()
  t.mock.timers.tick(60_000)
  assert.deepEqual(calls, ['broken', 'healthy'])
})

test('queue rejects invalid capacity and retry configuration', () => {
  const options = { processBatch: async () => ({}), getContextRevision: () => 0 }
  for (const maxBatchSize of [0, 1001, 1.5]) assert.throws(() => createControllerQueue({ ...options, maxBatchSize }), /BATCH_SIZE_INVALID/)
  for (const invalid of [{ maxRetries: -1 }, { maxRetries: 11 }, { retryBaseMs: 0 }, { retryMaxMs: 1 }, { shouldRetry: null }]) {
    assert.throws(() => createControllerQueue({ ...options, ...invalid }), /RETRY_INVALID/)
  }
})
