const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { encodeId } = require('../../../src/runs/trace/trace-ids.cjs')
const { RunLedger } = require('../../../src/runs/run-ledger.cjs')
const {
  cleanupOrphanTraces,
  createTraceStore,
  pruneTraces,
  removeTracesForGroup,
  traceDiskUsage,
} = require('../../../src/runs/trace/trace-store.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-trace-store-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    root,
    tracesRoot: path.join(root, 'traces'),
  }
}

function makeTrace(paths, runId, groupId, createdAt = '2026-11-14T08:00:00.000Z', bytes = 10) {
  const directory = path.join(paths.tracesRoot, encodeId(runId))
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'meta.json'), `${JSON.stringify({
    runId, groupId, projectId: null, createdAt,
  })}\n`)
  fs.writeFileSync(path.join(directory, 'agent.jsonl'), 'x'.repeat(bytes))
  return directory
}

test('removing a group removes only its trace directories', (t) => {
  const paths = fixture(t)
  const first = makeTrace(paths, 'run-1', 'group-1')
  const second = makeTrace(paths, 'run-2', 'group-2')
  assert.equal(removeTracesForGroup(paths.tracesRoot, 'group-1'), 1)
  assert.equal(fs.existsSync(first), false)
  assert.equal(fs.existsSync(second), true)
})

test('orphan cleanup removes missing, unknown, and broken directories', (t) => {
  const paths = fixture(t)
  const known = makeTrace(paths, 'run-known', 'group-known')
  const unknown = makeTrace(paths, 'run-unknown', 'group-unknown')
  const missingMeta = path.join(paths.tracesRoot, encodeId('run-missing'))
  fs.mkdirSync(missingMeta, { recursive: true })
  const broken = path.join(paths.tracesRoot, encodeId('run-broken'))
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(path.join(broken, 'meta.json'), '{not json')
  assert.equal(cleanupOrphanTraces(paths.tracesRoot, id => id === 'group-known'), 3)
  assert.equal(fs.existsSync(known), true)
  assert.equal(fs.existsSync(unknown), false)
  assert.equal(fs.existsSync(missingMeta), false)
  assert.equal(fs.existsSync(broken), false)
})

test('disk usage counts runs and bytes', (t) => {
  const paths = fixture(t)
  makeTrace(paths, 'run-1', 'group-1', '2026-11-14T08:00:00.000Z', 11)
  makeTrace(paths, 'run-2', 'group-2', '2026-11-14T08:00:00.000Z', 13)
  const usage = traceDiskUsage(paths.tracesRoot)
  assert.equal(usage.runs, 2)
  assert.ok(usage.bytes >= 24)
})

test('pruning filters by group and creation time', (t) => {
  const paths = fixture(t)
  const old = makeTrace(paths, 'run-old', 'group-1', '2026-01-01T00:00:00.000Z')
  const recent = makeTrace(paths, 'run-recent', 'group-1', '2026-11-14T08:00:00.000Z')
  const other = makeTrace(paths, 'run-other', 'group-2', '2026-01-01T00:00:00.000Z')

  const byGroup = pruneTraces(paths.tracesRoot, { groupId: 'group-2' })
  assert.equal(byGroup.removed, 1)
  assert.ok(byGroup.bytes >= 10)
  assert.equal(fs.existsSync(other), false)
  assert.equal(fs.existsSync(old), true)
  assert.equal(fs.existsSync(recent), true)

  const cutoff = Date.parse('2026-06-01T00:00:00.000Z')
  const byTime = pruneTraces(paths.tracesRoot, { olderThan: cutoff })
  assert.equal(byTime.removed, 1)
  assert.ok(byTime.bytes >= 10)
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(recent), true)
})

test('the trace store exposes the same operations', (t) => {
  const paths = fixture(t)
  makeTrace(paths, 'run-1', 'group-1')
  const store = createTraceStore({ tracesRoot: paths.tracesRoot })
  assert.equal(store.diskUsage().runs, 1)
  assert.equal(store.removeForGroup('group-1'), 1)
  assert.equal(store.diskUsage().runs, 0)
})

test('run ledger retention does not delete trace directories', (t) => {
  const paths = fixture(t)
  const directory = makeTrace(paths, 'run-1', 'group-1')
  const ledger = new RunLedger({
    storagePath: path.join(paths.root, 'run-ledger.json'),
    maxRuns: 1,
    now: () => 1000,
  })
  const record = (runId, groupId) => ({
    runId,
    taskId: `${runId}-task`,
    contextPackId: `context-pack-${'a'.repeat(64)}`,
    contextPackState: 'captured',
    groupId,
    threadRootId: `${groupId}-root`,
    mode: 'manual',
    targetKinds: ['codex'],
    status: 'running',
    permissionMode: 'read-only',
    agentRuns: [],
  })
  ledger.checkpoint(record('run-1', 'group-1'))
  ledger.finish('run-1', 'completed')
  ledger.checkpoint(record('run-2', 'group-2'))
  ledger.finish('run-2', 'completed')
  assert.equal(ledger.list().length, 1)
  assert.equal(fs.existsSync(directory), true)
})
