const test = require('node:test')
const assert = require('node:assert/strict')
const { EffectRunner } = require('../../src/project-room/effect-runner.cjs')

function instance(overrides = {}) {
  return {
    id: 'cp-1',
    epoch: 2,
    blockedOn: null,
    ...overrides,
  }
}

function effect(overrides = {}) {
  return {
    id: 'cp-1:1:0',
    type: 'snapshot',
    category: 'required',
    epoch: 2,
    status: 'pending',
    ...overrides,
  }
}

function runnerFor(overrides = {}) {
  const calls = []
  const sleeps = []
  const runner = new EffectRunner({
    scheduler: overrides.scheduler,
    handlers: {
      snapshot: async ({ effect: value }) => {
        calls.push(['snapshot', value.id])
        return { commit: 'a'.repeat(40) }
      },
      'drop-snapshot-refs': async ({ effect: value }) => {
        calls.push(['drop-snapshot-refs', value.id])
        return null
      },
      ...overrides.handlers,
    },
    invoke: overrides.invoke,
    cancelInvocation: overrides.cancelInvocation,
    markStarted: overrides.markStarted,
    isStorageDurable: overrides.isStorageDurable,
    sleep: async (ms) => { sleeps.push(ms) },
    retryDelays: overrides.retryDelays,
  })
  return { runner, calls, sleeps }
}

test('epoch mismatches void normal effects but not release, withdraw, or cancel', async () => {
  const { runner, calls } = runnerFor({
    cancelInvocation: async ({ effect: value }) => calls.push(['cancel', value.id]),
    handlers: {
      'release-scope': async ({ effect: value }) => { calls.push(['release', value.id]); return null },
      'withdraw-lease': async ({ effect: value }) => { calls.push(['withdraw', value.id]); return null },
    },
  })
  const current = instance()
  assert.deepEqual(await runner.run(current, effect({ epoch: 1 })), {
    type: 'EFFECT_VOIDED',
    effectId: 'cp-1:1:0',
    effectType: 'snapshot',
  })
  assert.deepEqual(calls, [])

  for (const type of ['release-scope', 'withdraw-lease']) {
    const result = await runner.run(current, effect({ type, epoch: 1, id: `effect-${type}` }))
    assert.equal(result.type, 'EFFECT_RESULT')
  }
  const cancel = await runner.run(current, effect({
    type: 'cancel-invocation', category: 'cleanup', epoch: 1, id: 'effect-cancel',
  }))
  assert.equal(cancel.type, 'EFFECT_RESULT')
  assert.deepEqual(calls.map(call => call[0]), ['release', 'withdraw', 'cancel'])
})

test('required effects retry three times with the documented delays', async () => {
  let attempts = 0
  const { runner, sleeps } = runnerFor({
    handlers: {
      snapshot: async () => {
        attempts += 1
        if (attempts < 4) throw Object.assign(new Error('EIO'), { code: 'EIO' })
        return { commit: 'b'.repeat(40) }
      },
    },
  })
  const result = await runner.run(instance(), effect())
  assert.equal(result.type, 'EFFECT_RESULT')
  assert.equal(attempts, 4)
  assert.deepEqual(sleeps, [1000, 5000, 30000])

  attempts = 0
  const failing = runnerFor({
    handlers: {
      snapshot: async () => {
        attempts += 1
        throw Object.assign(new Error('EIO'), { code: 'EIO' })
      },
    },
  })
  const failed = await failing.runner.run(instance(), effect())
  assert.equal(failed.type, 'EFFECT_FAILED')
  assert.equal(failed.error.code, 'EIO')
  assert.equal(attempts, 4)
  assert.deepEqual(failing.sleeps, [1000, 5000, 30000])
})

test('non-required effects do not retry', async () => {
  let attempts = 0
  const { runner, sleeps } = runnerFor({
    handlers: {
      snapshot: async () => {
        attempts += 1
        throw new Error('EIO')
      },
    },
  })
  const result = await runner.run(instance(), effect({ category: 'external' }))
  assert.equal(result.type, 'EFFECT_FAILED')
  assert.equal(attempts, 1)
  assert.deepEqual(sleeps, [])
})

test('a blocked instance pauses non-cleanup effects while cleanup still runs', async () => {
  const { runner, calls } = runnerFor()
  const blocked = instance({ blockedOn: { effectId: 'failed', error: 'EIO', time: 1 } })
  assert.deepEqual(await runner.run(blocked, effect()), {
    type: 'EFFECT_PAUSED',
    effectId: 'cp-1:1:0',
    effectType: 'snapshot',
    reason: 'blocked',
  })
  const cleanup = await runner.run(blocked, effect({
    type: 'drop-snapshot-refs', category: 'cleanup', id: 'effect-cleanup',
  }))
  assert.equal(cleanup.type, 'EFFECT_RESULT')
  assert.deepEqual(calls, [['drop-snapshot-refs', 'effect-cleanup']])
})

test('non-durable storage pauses every effect, including cleanup', async () => {
  const { runner } = runnerFor({ isStorageDurable: () => false })
  const blocked = await runner.run(instance(), effect())
  assert.equal(blocked.type, 'EFFECT_PAUSED')
  assert.equal(blocked.reason, 'storage')
  const cleanup = await runner.run(instance(), effect({
    type: 'drop-snapshot-refs', category: 'cleanup',
  }))
  assert.equal(cleanup.type, 'EFFECT_PAUSED')
  assert.equal(cleanup.reason, 'storage')
})

test('invocations are marked started before running and return INVOCATION_ENDED', async () => {
  const order = []
  const { runner } = runnerFor({
    markStarted: async (value) => order.push(['started', value.id]),
    invoke: async ({ effect: value }) => {
      order.push(['invoked', value.id])
      return {
        role: 'lead',
        seatId: 'seat-lead',
        round: 1,
        sessionGeneration: 0,
        marker: 'ready',
      }
    },
  })
  const result = await runner.run(instance(), effect({
    type: 'invoke-lead', category: 'invocation', id: 'effect-invoke',
  }))
  assert.deepEqual(order, [['started', 'effect-invoke'], ['invoked', 'effect-invoke']])
  assert.deepEqual(result, {
    type: 'INVOCATION_ENDED',
    effectId: 'effect-invoke',
    effectType: 'invoke-lead',
    role: 'lead',
    seatId: 'seat-lead',
    round: 1,
    sessionGeneration: 0,
    marker: 'ready',
  })
})

test('best-effort failures are consumed without retry', async () => {
  let attempts = 0
  const { runner } = runnerFor({
    handlers: {
      notify: async () => {
        attempts += 1
        throw new Error('NO_NOTIFICATION')
      },
    },
  })
  const result = await runner.run(instance(), effect({
    type: 'notify', category: 'best-effort',
  }))
  assert.equal(result.type, 'EFFECT_RESULT')
  assert.equal(result.error.code, 'EFFECT_FAILED')
  assert.equal(attempts, 1)
})

test('scheduler reconciliation only withdraws checkpoint and maintenance holders', () => {
  const withdrawn = []
  const scheduler = {
    snapshot: () => ({
      claimGrants: [
        { requestId: 'grant-keep', holder: { kind: 'checkpoint-scope', projectId: 'project-1' } },
        { requestId: 'grant-stale', holder: { kind: 'checkpoint-scope', projectId: 'project-1' } },
        { requestId: 'grant-invocation', holder: { kind: 'invocation', projectId: 'project-1' } },
        { requestId: 'grant-other-project', holder: { kind: 'project-maintenance', projectId: 'project-2' } },
      ],
      claimQueue: [
        { requestId: 'queue-keep', holder: { kind: 'project-maintenance', projectId: 'project-1' } },
        { requestId: 'queue-stale', holder: { kind: 'project-maintenance', projectId: 'project-1' } },
      ],
    }),
    withdraw: requestId => withdrawn.push(requestId),
  }
  const { runner } = runnerFor({ scheduler })
  const result = runner.reconcileScheduler({
    projectId: 'project-1',
    expectedRequestIds: ['grant-keep', 'queue-keep'],
  })
  assert.deepEqual(result.withdrawn.sort(), ['grant-stale', 'queue-stale'])
  assert.deepEqual(withdrawn.sort(), ['grant-stale', 'queue-stale'])
})
