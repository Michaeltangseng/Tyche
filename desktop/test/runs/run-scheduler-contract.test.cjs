const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { makeClaim } = require('../../src/runs/path-claims.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-scheduler-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function fakeEngine(scheduler) {
  const table = new Map()
  function request(requestId, claims) {
    table.set(requestId, { state: 'waiting' })
    scheduler.request({
      requestId,
      holder: { kind: 'checkpoint-scope', ownerId: requestId },
      claims,
      onGranted: grantedId => {
        const record = table.get(grantedId)
        if (!record) return
        if (record.state === 'withdrawn') {
          // The persisted record was withdrawn before this grant arrived;
          // release immediately so the scheduler never holds a dead lease.
          scheduler.release(grantedId)
          record.state = 'released'
          return
        }
        if (record.state === 'waiting') record.state = 'granted'
      },
    })
  }
  function release(requestId) {
    const record = table.get(requestId)
    if (record) record.state = 'released'
    return scheduler.release(requestId)
  }
  function withdraw(requestId) {
    const record = table.get(requestId)
    if (record) record.state = 'withdrawn'
    return scheduler.withdraw(requestId)
  }
  function markWithdrawnWithoutNotifying(requestId) {
    const record = table.get(requestId)
    if (record) record.state = 'withdrawn'
  }
  return { table, request, release, withdraw, markWithdrawnWithoutNotifying }
}

test('a conflicting request is not granted before the current holder releases', async (t) => {
  const root = fixture(t)
  const a = await makeClaim({ root, path: 'a' })
  const scheduler = new RunScheduler()
  const engine = fakeEngine(scheduler)
  engine.request('A', [a])
  engine.request('B', [a])
  assert.equal(engine.table.get('A').state, 'granted')
  assert.equal(engine.table.get('B').state, 'waiting')
  assert.equal(scheduler.snapshot().claimGrants.some(record => record.requestId === 'B'), false)

  engine.release('A')
  assert.equal(engine.table.get('B').state, 'granted')
  engine.release('B')
})

test('a grant that arrives after the record was withdrawn is released immediately', async (t) => {
  const root = fixture(t)
  const a = await makeClaim({ root, path: 'a' })
  const scheduler = new RunScheduler()
  const engine = fakeEngine(scheduler)
  engine.request('blocker', [a])
  engine.request('A', [a])
  assert.equal(engine.table.get('A').state, 'waiting')

  engine.markWithdrawnWithoutNotifying('A')
  engine.release('blocker')
  assert.equal(engine.table.get('A').state, 'released')
  assert.equal(scheduler.snapshot().claimGrants.some(record => record.requestId === 'A'), false)
})

test('withdraw and grant may arrive in either order without leaving a lease', async (t) => {
  const root = fixture(t)
  const a = await makeClaim({ root, path: 'a' })
  const scheduler = new RunScheduler()
  const engine = fakeEngine(scheduler)
  engine.request('blocker', [a])
  engine.request('B', [a])
  engine.withdraw('B')
  engine.release('blocker')
  assert.equal(engine.table.get('B').state, 'withdrawn')
  assert.equal(scheduler.snapshot().claimGrants.some(record => record.requestId === 'B'), false)

  engine.request('C', [a])
  assert.equal(engine.table.get('C').state, 'granted')
  engine.withdraw('C')
  assert.equal(engine.table.get('C').state, 'withdrawn')
  assert.equal(scheduler.snapshot().claimGrants.some(record => record.requestId === 'C'), false)
})

test('restoreGranted works while a root is held and survives openRoot/exitRecoveryMode', async (t) => {
  const root = fixture(t)
  const a = await makeClaim({ root, path: 'a' })
  const scheduler = new RunScheduler()
  const engine = fakeEngine(scheduler)
  scheduler.enterRecoveryMode()
  await scheduler.holdRoot(root)
  const restored = scheduler.restoreGranted([
    { requestId: 'restored', holder: { kind: 'checkpoint-scope' }, claims: [a] },
  ])
  assert.equal(restored.restored, true)
  assert.equal(scheduler.snapshot().claimGrants.some(record => record.requestId === 'restored'), true)

  engine.request('new', [a])
  assert.equal(engine.table.get('new').state, 'waiting')
  await scheduler.openRoot(root)
  scheduler.exitRecoveryMode()
  assert.equal(engine.table.get('new').state, 'waiting')

  engine.release('restored')
  assert.equal(engine.table.get('new').state, 'granted')
  engine.release('new')
})
