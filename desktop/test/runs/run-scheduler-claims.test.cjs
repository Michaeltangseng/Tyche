const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { makeClaim } = require('../../src/runs/path-claims.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-scheduler-claims-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function request(scheduler, requestId, claims, grants) {
  scheduler.request({
    requestId,
    holder: { kind: 'checkpoint-scope', ownerId: requestId },
    claims,
    onGranted: id => grants.push(id),
  })
}

function deferredState(promise) {
  const state = { settled: false, value: null }
  promise.then(
    value => { state.settled = true; state.value = value },
    error => { state.settled = true; state.value = error },
  )
  return state
}

test('explicit Room roots remain exclusive across suspension without legacy project registration', async t => {
  const root = fixture(t)
  const scheduler = new RunScheduler()
  const input = { taskId: 'room', workspaceKey: 'room', permissionMode: 'workspace-write', workdirRoot: root, exclusiveRoot: true }
  await scheduler.withLease(input, async lease => {
    assert.equal(lease.claims[0].mode, 'exclusive')
    assert.equal(Object.isFrozen(lease.claims), true)
    assert.equal(Object.isFrozen(lease.claims[0]), true)
    await lease.suspend(async () => {
      const temporary = await scheduler.acquire({ ...input, taskId: 'temporary' })
      temporary.release()
    })
    assert.equal(lease.claims[0].mode, 'exclusive')
    const abort = new AbortController()
    const waiting = scheduler.acquire({ ...input, taskId: 'waiting', workspaceKey: 'waiting', signal: abort.signal })
    const state = deferredState(waiting)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.settled, false)
    abort.abort()
    await assert.rejects(waiting)
  })
  const released = await scheduler.acquire(input)
  released.release()
})

test('all claims are granted together or none are', async (t) => {
  const root = fixture(t)
  const a = await makeClaim({ root, path: 'a' })
  const b = await makeClaim({ root, path: 'b' })
  const scheduler = new RunScheduler()
  const grants = []
  request(scheduler, 'hold-a', [a], grants)
  request(scheduler, 'both', [a, b], grants)
  assert.deepEqual(grants, ['hold-a'])
  assert.equal(scheduler.snapshot().claimGrants.some(record => record.requestId === 'both'), false)

  scheduler.release('hold-a')
  assert.deepEqual(grants, ['hold-a', 'both'])
  assert.equal(scheduler.snapshot().claimGrants.some(record => record.requestId === 'both'), true)
})

test('earlier conflicting claims block later requests but unrelated claims may pass', async (t) => {
  const root = fixture(t)
  const other = fixture(t)
  const aFile = await makeClaim({ root, path: 'a/file' })
  const whole = await makeClaim({ root, path: '' })
  const aFile2 = await makeClaim({ root, path: 'a/file2' })
  const otherFile = await makeClaim({ root: other, path: 'other/file' })
  const scheduler = new RunScheduler()
  const grants = []
  request(scheduler, 'A', [aFile], grants)
  request(scheduler, 'B', [whole], grants)
  request(scheduler, 'C', [aFile2], grants)
  request(scheduler, 'D', [otherFile], grants)
  assert.deepEqual(grants, ['A', 'D'])

  scheduler.release('A')
  assert.deepEqual(grants, ['A', 'D', 'B'])
  assert.deepEqual(
    scheduler.snapshot().claimQueue.map(entry => entry.requestId),
    ['C'],
  )
})

test('opposite two-claim requests never split the claims', async (t) => {
  const root = fixture(t)
  const a = await makeClaim({ root, path: 'a' })
  const b = await makeClaim({ root, path: 'b' })
  const scheduler = new RunScheduler()
  const grants = []
  request(scheduler, 'first', [a, b], grants)
  request(scheduler, 'second', [b, a], grants)
  assert.deepEqual(grants, ['first'])
  assert.deepEqual(
    scheduler.snapshot().claimGrants.map(record => record.requestId),
    ['first'],
  )
  assert.equal(scheduler.snapshot().claimGrants[0].claims.length, 2)

  scheduler.release('first')
  assert.deepEqual(grants, ['first', 'second'])
  assert.equal(scheduler.snapshot().claimGrants[0].claims.length, 2)
})

test('residual occupancy blocks shared and exclusive claims until cleared', async (t) => {
  const root = fixture(t)
  const a = await makeClaim({ root, path: 'a' })
  const shared = await makeClaim({ root, path: 'a', mode: 'shared-legacy' })
  const scheduler = new RunScheduler()
  const grants = []
  scheduler.registerResidual({ residualId: 'residual-1', claims: [a] })
  request(scheduler, 'exclusive', [a], grants)
  request(scheduler, 'shared', [shared], grants)
  assert.deepEqual(grants, [])
  scheduler.clearResidual('residual-1')
  assert.deepEqual(grants, ['exclusive'])
  assert.deepEqual(
    scheduler.snapshot().claimQueue.map(entry => entry.requestId),
    ['shared'],
  )
})

test('held roots pause overlapping grants until opened', async (t) => {
  const root = fixture(t)
  const a = await makeClaim({ root, path: 'a' })
  const scheduler = new RunScheduler()
  const grants = []
  await scheduler.holdRoot(root)
  request(scheduler, 'A', [a], grants)
  assert.deepEqual(grants, [])
  await scheduler.openRoot(root)
  assert.deepEqual(grants, ['A'])
  scheduler.release('A')
})

test('recovery mode grants only requests without claims', async (t) => {
  const root = fixture(t)
  const a = await makeClaim({ root, path: 'a' })
  const scheduler = new RunScheduler()
  const grants = []
  scheduler.enterRecoveryMode()
  request(scheduler, 'no-claims', [], grants)
  request(scheduler, 'claims', [a], grants)
  assert.deepEqual(grants, ['no-claims'])

  const readOnly = await scheduler.acquire({ taskId: 'read', workspaceKey: 'read' })
  const writablePromise = scheduler.acquire({
    taskId: 'write',
    workspaceKey: 'write',
    permissionMode: 'workspace-write',
  })
  const writableState = deferredState(writablePromise)
  await Promise.resolve()
  assert.equal(writableState.settled, false)
  readOnly.release()

  scheduler.exitRecoveryMode()
  const writable = await writablePromise
  assert.deepEqual(grants, ['no-claims', 'claims'])
  writable.release()
  scheduler.release('no-claims')
  scheduler.release('claims')
})

test('restoreGranted rejects the whole batch on any overlap', async (t) => {
  const root = fixture(t)
  const a = await makeClaim({ root, path: 'a' })
  const b = await makeClaim({ root, path: 'b' })
  const scheduler = new RunScheduler()
  const rejected = scheduler.restoreGranted([
    { requestId: 'restore-a', holder: { kind: 'checkpoint-scope' }, claims: [a] },
    { requestId: 'restore-b', holder: { kind: 'checkpoint-scope' }, claims: [a] },
  ])
  assert.equal(rejected.restored, false)
  assert.ok(rejected.conflicts.length > 0)
  assert.deepEqual(scheduler.snapshot().claimGrants, [])

  const restored = scheduler.restoreGranted([
    { requestId: 'restore-a', holder: { kind: 'checkpoint-scope' }, claims: [a] },
    { requestId: 'restore-b', holder: { kind: 'checkpoint-scope' }, claims: [b] },
  ])
  assert.equal(restored.restored, true)
  assert.equal(scheduler.snapshot().claimGrants.length, 2)

  const conflict = scheduler.restoreGranted([
    { requestId: 'restore-c', holder: { kind: 'checkpoint-scope' }, claims: [a] },
  ])
  assert.equal(conflict.restored, false)
  assert.equal(scheduler.snapshot().claimGrants.length, 2)
})

test('legacy workdir claims are shared unless they overlap a project room', async (t) => {
  const root = fixture(t)
  const project = fixture(t)
  const projectSubdirectory = path.join(project, 'sub')
  fs.mkdirSync(projectSubdirectory)

  const shared = new RunScheduler()
  const first = await shared.acquire({
    taskId: 'first', workspaceKey: 'first', permissionMode: 'workspace-write', workdirRoot: root,
  })
  const second = await shared.acquire({
    taskId: 'second', workspaceKey: 'second', permissionMode: 'workspace-write', workdirRoot: root,
  })
  first.release()
  second.release()

  const projectScoped = new RunScheduler({ projectRootsProvider: () => [project] })
  const owner = await projectScoped.acquire({
    taskId: 'owner',
    workspaceKey: 'owner',
    permissionMode: 'workspace-write',
    workdirRoot: projectSubdirectory,
  })
  const waitingPromise = projectScoped.acquire({
    taskId: 'waiting',
    workspaceKey: 'waiting',
    permissionMode: 'workspace-write',
    workdirRoot: projectSubdirectory,
  })
  const waitingState = deferredState(waitingPromise)
  await Promise.resolve()
  assert.equal(waitingState.settled, false)
  owner.release()
  const waiting = await waitingPromise
  waiting.release()
})

test('residuals block ordinary workdir claims and unresolved roots fail closed', async (t) => {
  const root = fixture(t)
  const claim = await makeClaim({ root, path: '' })
  const scheduler = new RunScheduler()
  scheduler.registerResidual({ residualId: 'residual-workdir', claims: [claim] })
  const waitingPromise = scheduler.acquire({
    taskId: 'workdir',
    workspaceKey: 'workdir',
    permissionMode: 'workspace-write',
    workdirRoot: root,
  })
  const waitingState = deferredState(waitingPromise)
  await Promise.resolve()
  assert.equal(waitingState.settled, false)
  scheduler.clearResidual('residual-workdir')
  const lease = await waitingPromise
  lease.release()

  await assert.rejects(
    scheduler.acquire({
      taskId: 'missing',
      workspaceKey: 'missing',
      permissionMode: 'workspace-write',
      workdirRoot: path.join(root, 'does-not-exist'),
    }),
    (error) => error.code === 'SCHEDULER_CLAIM_ROOT_INVALID',
  )
})
