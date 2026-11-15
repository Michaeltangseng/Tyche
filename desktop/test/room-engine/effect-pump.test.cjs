const assert = require('node:assert/strict')
const test = require('node:test')
const { createEffectPump } = require('../../src/room-engine/effect-pump.cjs')

test('effect pump coalesces requests, drains pending effects and reports failures', async () => {
  const errors = []
  const queue = [{ error: new Error('worker failed') }, { result: 'completed' }]
  let calls = 0
  const pump = createEffectPump({ runNext: async () => { calls += 1; return queue.shift() || null }, onError: error => errors.push(error.message) })
  const first = pump.request()
  assert.equal(pump.request(), first)
  await first
  assert.equal(calls, 3)
  assert.deepEqual(errors, ['worker failed'])
  await pump.close()
  await pump.request()
  assert.equal(calls, 3)
})

test('closing effect pump aborts the running executor without claiming another effect', async () => {
  let signal
  let calls = 0
  const pump = createEffectPump({ runNext: input => {
    calls += 1
    signal = input.signal
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({}), { once: true }))
  } })
  const running = pump.request()
  await Promise.resolve()
  await pump.close()
  await running
  assert.equal(signal.aborted, true)
  assert.equal(calls, 1)
})
