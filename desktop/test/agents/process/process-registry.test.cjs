const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  ENDED_RETENTION_MS,
  ProcessRegistry,
  STORE_VERSION,
} = require('../../../src/agents/process/process-registry.cjs')

const FIXED_NOW = new Date('2026-11-14T01:00:00.000Z')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-process-registry-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    storagePath: path.join(directory, 'process-registry.json'),
  }
}

function defaultRecord(overrides = {}) {
  return {
    recordId: 'record-1',
    invocationId: 'invocation-1',
    groupId: 'group-1',
    projectId: null,
    workdir: '/tmp/work',
    permission: 'workspace-write',
    claims: [{ root: '/tmp/work', path: '', mode: 'exclusive' }],
    containerMarker: 'marker-1',
    agentKind: 'claude',
    createdAt: '2026-11-14T00:00:00.000Z',
    status: 'running',
    pgid: 123,
    leaderStartTime: 'START',
    finalKillMembers: null,
    endedAt: null,
    ...overrides,
  }
}

function fakeInspect(overrides = {}) {
  return {
    groupEmpty: () => false,
    groupMembers: () => [],
    processStartTime: () => null,
    processGroupOf: () => null,
    processProgramName: () => 'node',
    readEnvironmentMarker: () => 'present',
    ...overrides,
  }
}

function writeStore(storagePath, records) {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  fs.writeFileSync(storagePath, `${JSON.stringify({ version: STORE_VERSION, records }, null, 2)}\n`)
}

function persistentWrite(filename, text) {
  fs.writeFileSync(filename, text)
}

function makeRegistry(t, options = {}) {
  const { storagePath } = fixture(t)
  if (options.records) writeStore(storagePath, options.records)
  return new ProcessRegistry({
    storagePath,
    now: options.now || (() => FIXED_NOW),
    inspect: options.inspect || fakeInspect(),
    writeFile: options.writeFile || persistentWrite,
    sleepFn: options.sleepFn || (async () => {}),
    leaderWaitMs: options.leaderWaitMs == null ? 0 : options.leaderWaitMs,
  })
}

test('begin writes a starting record and returns its id', async (t) => {
  const registry = makeRegistry(t)
  const recordId = await registry.begin({
    workdir: '/tmp/work',
    containerMarker: 'marker-1',
    agentKind: 'claude',
  })
  assert.match(recordId, /^process-/)
  assert.equal(registry.records.length, 1)
  assert.equal(registry.records[0].status, 'starting')
  assert.equal(registry.records[0].createdAt, FIXED_NOW.toISOString())
  const stored = JSON.parse(fs.readFileSync(registry.storagePath, 'utf8'))
  assert.deepEqual(stored.records, registry.records)
})

test('before-commit failures leave the in-memory state unchanged', async (t) => {
  const registry = makeRegistry(t, {
    writeFile: async () => {
      throw Object.assign(new Error('WRITE_FAILED'), { phase: 'before-commit' })
    },
  })
  await assert.rejects(
    registry.begin({ workdir: '/tmp/work', containerMarker: 'marker-1' }),
    (error) => error.phase === 'before-commit',
  )
  assert.deepEqual(registry.records, [])
})

test('markRunning rewrites once after an after-commit failure', async (t) => {
  const { storagePath } = fixture(t)
  let calls = 0
  const writeFile = async (filename, text) => {
    calls += 1
    fs.writeFileSync(filename, text)
    if (calls === 1) {
      throw Object.assign(new Error('DIRECTORY_SYNC_FAILED'), { phase: 'after-commit' })
    }
  }
  const registry = new ProcessRegistry({
    storagePath,
    now: () => FIXED_NOW,
    inspect: fakeInspect(),
    writeFile,
  })
  const recordId = await registry.begin({ workdir: '/tmp/work', containerMarker: 'marker-1' })
  calls = 0
  await registry.markRunning(recordId, { pgid: 321, leaderStartTime: 'START' })
  assert.equal(calls, 2)
  assert.equal(registry.records[0].status, 'running')
  assert.equal(registry.records[0].pgid, 321)
  const stored = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  assert.equal(stored.records[0].status, 'running')
  assert.equal(stored.records[0].pgid, 321)
})

test('markRunning throws when the after-commit rewrite also fails', async (t) => {
  const { storagePath } = fixture(t)
  const writeFile = async (filename, text) => {
    fs.writeFileSync(filename, text)
    throw Object.assign(new Error('DIRECTORY_SYNC_FAILED'), { phase: 'after-commit' })
  }
  const registry = new ProcessRegistry({
    storagePath,
    now: () => FIXED_NOW,
    inspect: fakeInspect(),
    writeFile,
  })
  // Seed the file with persistent writes first.
  registry.writeFile = persistentWrite
  const recordId = await registry.begin({ workdir: '/tmp/work', containerMarker: 'marker-1' })
  registry.writeFile = writeFile
  await assert.rejects(
    registry.markRunning(recordId, { pgid: 321, leaderStartTime: 'START' }),
    (error) => error.phase === 'after-commit',
  )
  // The rename in the first attempt already committed the new contents.
  assert.equal(registry.records[0].status, 'running')
  const stored = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  assert.equal(stored.records[0].status, 'running')
})

test('markEnded prunes ended records older than 24 hours', async (t) => {
  const oldEndedAt = new Date(FIXED_NOW.getTime() - ENDED_RETENTION_MS - 1000).toISOString()
  const registry = makeRegistry(t, {
    records: [
      defaultRecord({ recordId: 'old', status: 'ended', endedAt: oldEndedAt }),
      defaultRecord({ recordId: 'running', status: 'running' }),
    ],
  })
  await registry.markEnded('running')
  assert.deepEqual(registry.records.map((record) => record.recordId), ['running'])
  assert.equal(registry.records[0].status, 'ended')
})

test('a corrupt registry is quarantined and starts empty', (t) => {
  const { directory, storagePath } = fixture(t)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(storagePath, '{not json')
  const registry = new ProcessRegistry({ storagePath, now: () => FIXED_NOW })
  assert.deepEqual(registry.records, [])
  assert.ok(registry.diagnostics.some((entry) => entry.code === 'PROCESS_REGISTRY_CORRUPT'))
  const quarantined = fs.readdirSync(directory).filter((name) => name.includes('.corrupt-'))
  assert.equal(quarantined.length, 1)
})

test('recover marks a starting record without a pgid as ended', async (t) => {
  const registry = makeRegistry(t, {
    records: [defaultRecord({ status: 'starting', pgid: null, leaderStartTime: null })],
  })
  const results = await registry.recover()
  assert.deepEqual(results, [{ recordId: 'record-1', outcome: 'ended' }])
  assert.equal(registry.records[0].status, 'ended')
})

test('recover ends a container whose group is empty', async (t) => {
  const registry = makeRegistry(t, {
    records: [defaultRecord()],
    inspect: fakeInspect({ groupEmpty: () => true }),
  })
  const results = await registry.recover()
  assert.equal(results[0].outcome, 'ended')
})

test('recover keeps a live leader with the recorded start time as residual', async (t) => {
  const members = [{ pid: 124, startTime: '2026-11-14T00:00:00.000Z' }]
  const registry = makeRegistry(t, {
    records: [defaultRecord()],
    inspect: fakeInspect({
      groupEmpty: () => false,
      processStartTime: () => 'START',
      processGroupOf: () => 123,
      groupMembers: () => members,
      readEnvironmentMarker: () => 'present',
      processProgramName: () => 'node',
    }),
  })
  const results = await registry.recover()
  assert.equal(results[0].outcome, 'residual')
  assert.deepEqual(results[0].residual.members, [{
    pid: 124,
    startTime: '2026-11-14T00:00:00.000Z',
    agentKind: 'claude',
    programName: 'node',
    marker: 'present',
  }])
  assert.deepEqual(results[0].residual.claims, defaultRecord().claims)
})

test('recover ends a group whose leader start time differs', async (t) => {
  const registry = makeRegistry(t, {
    records: [defaultRecord()],
    inspect: fakeInspect({
      groupEmpty: () => false,
      processStartTime: () => 'OTHER',
      processGroupOf: () => 123,
    }),
  })
  const results = await registry.recover()
  assert.equal(results[0].outcome, 'ended')
})

test('recover keeps members with a marker, without a marker, or with unreadable environments as residual', async (t) => {
  for (const marker of ['present', 'absent', 'unreadable']) {
    const registry = makeRegistry(t, {
      records: [defaultRecord({ pgid: 200, leaderStartTime: 'OLD' })],
      inspect: fakeInspect({
        groupEmpty: () => false,
        processStartTime: () => null,
        groupMembers: () => [{ pid: 201, startTime: '2026-11-14T00:00:00.000Z' }],
        readEnvironmentMarker: () => marker,
        processProgramName: () => 'node',
      }),
    })
    const results = await registry.recover()
    assert.equal(results[0].outcome, 'residual', `marker=${marker}`)
    assert.equal(results[0].residual.members[0].marker, marker)
  }
})

test('recover ends when every member started before the container was created', async (t) => {
  const registry = makeRegistry(t, {
    records: [defaultRecord({ pgid: 300, leaderStartTime: 'OLD' })],
    inspect: fakeInspect({
      groupEmpty: () => false,
      processStartTime: () => null,
      groupMembers: () => [{ pid: 301, startTime: '2026-11-13T00:00:00.000Z' }],
    }),
  })
  const results = await registry.recover()
  assert.equal(results[0].outcome, 'ended')
})

test('recover ends an ending record whose group is empty and never signals', async (t) => {
  const signals = []
  const registry = makeRegistry(t, {
    records: [defaultRecord({
      status: 'ending',
      finalKillMembers: [{ pid: 124, startTime: 'START' }],
    })],
    inspect: fakeInspect({
      groupEmpty: () => true,
      kill: (...args) => { signals.push(args) },
      signal: (...args) => { signals.push(args) },
    }),
  })
  const results = await registry.recover()
  assert.equal(results[0].outcome, 'ended')
  assert.deepEqual(signals, [])
})

test('invocation lookup returns only copied process identity facts', t => {
  const registry = makeRegistry(t, { records: [defaultRecord(), defaultRecord({ recordId: 'other', invocationId: 'other' })] })
  const records = registry.getInvocationRecords('invocation-1')
  assert.deepEqual(records, [{ recordId: 'record-1', invocationId: 'invocation-1', workdir: '/tmp/work', agentKind: 'claude', status: 'running' }])
  records[0].status = 'ended'
  assert.equal(registry.getInvocationRecords('invocation-1')[0].status, 'running')
  assert.deepEqual(registry.getInvocationRecords('missing'), [])
  assert.throws(() => registry.getInvocationRecords(''), /INVOCATION_ID_REQUIRED/)
})

test('concurrent writes are serialized in arrival order', async (t) => {
  const registry = makeRegistry(t)
  await Promise.all([
    registry.begin({ workdir: '/tmp/work', containerMarker: 'marker-1' }),
    registry.begin({ workdir: '/tmp/work', containerMarker: 'marker-2' }),
    registry.begin({ workdir: '/tmp/work', containerMarker: 'marker-3' }),
  ])
  assert.equal(registry.records.length, 3)
  const stored = JSON.parse(fs.readFileSync(registry.storagePath, 'utf8'))
  assert.equal(stored.records.length, 3)
  assert.deepEqual(stored.records.map((record) => record.containerMarker), ['marker-1', 'marker-2', 'marker-3'])
})
