const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  MANAGED_PROCESS,
  createManagedSpawn,
} = require('../../../src/agents/process/managed-spawn.cjs')

const DESKTOP = path.join(__dirname, '..', '..', '..')
const SUPERVISOR = path.join(DESKTOP, 'native', 'build', 'meldwork-supervisor')
const AGENT = path.join(__dirname, '..', '..', 'fixtures', 'agents', 'supervisor-agent.cjs')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-managed-spawn-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function testEnvironment(out, overrides = {}) {
  return {
    PATH: '/usr/bin:/bin',
    OUT: out,
    MODE: 'normal',
    LOOPS: '3',
    CUSTOM: 'value',
    ...overrides,
  }
}

function fakeRegistry() {
  const calls = { begin: [], markRunning: [], markEnding: [], markEnded: [] }
  return {
    calls,
    async begin(record) {
      calls.begin.push(record)
      return 'record-1'
    },
    async markRunning(recordId, info) {
      calls.markRunning.push({ recordId, ...info })
    },
    async markEnding(recordId, info) {
      calls.markEnding.push({ recordId, ...info })
    },
    async markEnded(recordId) {
      calls.markEnded.push(recordId)
    },
  }
}

function waitFor(predicate, timeoutMs = 15000, intervalMs = 25) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for condition'))
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

function createHarness(t, { envOverrides = {}, closeTimeoutMs = 5000 } = {}) {
  const out = fixture(t)
  const registry = fakeRegistry()
  const invocation = {
    invocationId: 'invocation-1',
    groupId: 'group-1',
    projectId: null,
    workdir: out,
    permission: 'workspace-write',
    claims: [{ root: out, path: '', mode: 'exclusive' }],
    agentKind: 'claude',
  }
  const spawnFn = createManagedSpawn({
    registry,
    invocation,
    supervisorPath: SUPERVISOR,
    platform: process.platform,
    closeTimeoutMs,
  })
  const child = spawnFn(process.execPath, [AGENT], {
    cwd: out,
    env: testEnvironment(out, envOverrides),
  })
  const state = {
    out,
    registry,
    invocation,
    child,
    stdout: '',
    stderr: '',
    events: [],
    controlInode: null,
  }
  try {
    const controlFd = child.controlChannel._handle?.fd ?? child.controlChannel.fd
    state.controlInode = fs.fstatSync(controlFd).ino || null
  } catch {
    state.controlInode = null
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { state.stdout += chunk })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { state.stderr += chunk })
  child.on('exit', (code, signal, info) => state.events.push({ type: 'exit', code, signal, info }))
  child.on('close', (code, signal, info) => state.events.push({ type: 'close', code, signal, info }))
  child.on('container-empty', () => state.events.push({ type: 'container-empty' }))
  child.on('error', (error) => state.events.push({ type: 'error', code: error.code }))
  t.after(async () => {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    try { child.supervisor.kill('SIGKILL') } catch { /* already gone */ }
    await delay(100)
  })
  return state
}

function event(state, type) {
  return state.events.find((entry) => entry.type === type)
}

test('normal run reports exit, close and container-empty in order', async (t) => {
  const state = createHarness(t)
  await waitFor(() => Boolean(event(state, 'container-empty')))
  await waitFor(() => state.registry.calls.markEnded.length > 0)

  assert.equal(state.child[MANAGED_PROCESS], true)
  assert.equal(state.child.pid > 0, true)
  const exit = event(state, 'exit')
  const close = event(state, 'close')
  const empty = event(state, 'container-empty')
  assert.deepEqual(exit, { type: 'exit', code: 0, signal: null, info: {} })
  assert.equal(close.code, 0)
  assert.equal(close.signal, null)
  assert.equal(close.info.outputTruncated, undefined)
  assert.ok(state.events.indexOf(exit) < state.events.indexOf(close))
  assert.ok(state.events.indexOf(close) < state.events.indexOf(empty))
  assert.equal(state.events.filter((entry) => entry.type === 'exit').length, 1)
  assert.equal(state.events.filter((entry) => entry.type === 'close').length, 1)
  assert.match(state.stdout, /STARTED/)
  assert.match(state.stdout, /FINAL-ANSWER/)

  const begin = state.registry.calls.begin[0]
  assert.equal(begin.workdir, state.out)
  assert.equal(begin.permission, 'workspace-write')
  assert.equal(begin.agentKind, 'claude')
  assert.match(begin.containerMarker, /^[a-f0-9]{32}$/)
  assert.deepEqual(state.registry.calls.markRunning[0].pgid, state.child.pid)
  assert.ok(state.registry.calls.markRunning[0].leaderStartTime)
  assert.deepEqual(state.registry.calls.markEnded, ['record-1'])

  const recordedEnvironment = JSON.parse(fs.readFileSync(path.join(state.out, 'env.json'), 'utf8'))
  assert.equal(recordedEnvironment.MELDWORK_CONTAINER, begin.containerMarker)
  assert.equal(recordedEnvironment.CUSTOM, 'value')
  assert.equal(recordedEnvironment.PATH, '/usr/bin:/bin')

  const descriptors = JSON.parse(fs.readFileSync(path.join(state.out, 'fds.json'), 'utf8'))
  assert.ok(state.controlInode > 0)
  assert.equal(
    descriptors.some((descriptor) => descriptor.ino === state.controlInode),
    false,
    'the Agent must not inherit the control channel',
  )
})

test('stop waits for an Agent that ignores SIGTERM and reports cleanup kill', async (t) => {
  const state = createHarness(t, { envOverrides: { MODE: 'ignore-term', LOOPS: '50' } })
  await delay(300)
  assert.equal(state.child.stop({ force: false }), true)
  await waitFor(() => Boolean(event(state, 'container-empty')))
  const exit = event(state, 'exit')
  const close = event(state, 'close')
  assert.equal(exit.signal, 'SIGKILL')
  assert.equal(exit.info.terminatedBy, 'cleanup')
  assert.equal(close.signal, 'SIGKILL')
  assert.deepEqual(state.registry.calls.markEnded, ['record-1'])
})

test('stop force skips the grace period and still empties the container', async (t) => {
  const state = createHarness(t, { envOverrides: { MODE: 'ignore-term', LOOPS: '50' } })
  await delay(300)
  assert.equal(state.child.stop({ force: true }), true)
  await waitFor(() => Boolean(event(state, 'container-empty')))
  const exit = event(state, 'exit')
  assert.equal(exit.signal, 'SIGKILL')
  assert.equal(exit.info.terminatedBy, 'cleanup')
})

test('a supervisor that dies before finalKill reports a failure and marks the container ending', async (t) => {
  const state = createHarness(t, { envOverrides: { LOOPS: '100' }, closeTimeoutMs: 1000 })
  await delay(300)
  process.kill(state.child.pid, 'SIGKILL')
  await waitFor(() => Boolean(event(state, 'close')))
  const exit = event(state, 'exit')
  const close = event(state, 'close')
  assert.equal(exit.code, null)
  assert.equal(exit.signal, null)
  assert.equal(exit.info.failureCode, 'LOCAL_AGENT_SUPERVISOR_LOST')
  assert.equal(close.info.outputTruncated, true)
  assert.equal(event(state, 'container-empty'), undefined)
  await waitFor(() => state.registry.calls.markEnding.length > 0)
  assert.deepEqual(state.registry.calls.markEnded, [])
})

test('large output is fully readable before close', async (t) => {
  const state = createHarness(t, {
    envOverrides: { LOOPS: '1', OUTPUT_BYTES: String(1024 * 1024) },
  })
  await waitFor(() => Boolean(event(state, 'container-empty')))
  assert.ok(state.stdout.length >= 1024 * 1024)
  assert.equal(event(state, 'exit').code, 0)
  assert.equal(event(state, 'close').info.outputTruncated, undefined)
})

test('delayed control-channel reads still yield the real Agent result', async (t) => {
  const state = createHarness(t, { envOverrides: { LOOPS: '1' } })
  state.child.controlChannel.pause()
  await delay(3000)
  state.child.controlChannel.resume()
  await waitFor(() => Boolean(event(state, 'container-empty')))
  const exit = event(state, 'exit')
  assert.equal(exit.code, 0)
  assert.equal(exit.signal, null)
  assert.equal(exit.info.failureCode, undefined)
})

test('a missing supervisor fails closed with LOCAL_MANAGED_PROCESS_UNAVAILABLE', () => {
  const spawnFn = createManagedSpawn({
    registry: fakeRegistry(),
    invocation: { workdir: '/tmp', permission: 'workspace-write' },
    supervisorPath: '/nonexistent/meldwork-supervisor',
    platform: process.platform,
  })
  assert.throws(
    () => spawnFn(process.execPath, [], { cwd: '/tmp', env: {} }),
    (error) => error.code === 'LOCAL_MANAGED_PROCESS_UNAVAILABLE',
  )
})
