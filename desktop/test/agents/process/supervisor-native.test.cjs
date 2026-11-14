const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DESKTOP = path.join(__dirname, '..', '..', '..')
const SUPERVISOR = path.join(DESKTOP, 'native', 'build', 'meldwork-supervisor')
const BUILD_SCRIPT = path.join(DESKTOP, 'scripts', 'build-native.cjs')
const AGENT = path.join(__dirname, '..', '..', 'fixtures', 'agents', 'supervisor-agent.cjs')

if (!fs.existsSync(SUPERVISOR)) {
  execFileSync(process.execPath, [BUILD_SCRIPT], { stdio: 'inherit' })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitUntil(predicate, timeoutMs = 12000, intervalMs = 50) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('timed out waiting for condition'))
      }
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

function waitExit(child, timeoutMs = 12000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    delay(timeoutMs).then(() => ({ timedOut: true })),
  ])
}

function groupEmpty(pgid) {
  try {
    process.kill(-pgid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

function fileSize(filename) {
  try { return fs.statSync(filename).size } catch { return 0 }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-supervisor-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function startSupervisor(t) {
  const child = spawn(SUPERVISOR, [], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  const state = {
    child,
    events: [],
    stdout: '',
    stderr: '',
    channelBuffer: '',
    controlInode: null,
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { state.stdout += chunk })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { state.stderr += chunk })
  const channel = child.stdio[3]
  channel.setEncoding('utf8')
  channel.on('data', (chunk) => {
    state.channelBuffer += chunk
    let index
    while ((index = state.channelBuffer.indexOf('\n')) >= 0) {
      const line = state.channelBuffer.slice(0, index)
      state.channelBuffer = state.channelBuffer.slice(index + 1)
      if (!line.trim()) continue
      try {
        state.events.push(JSON.parse(line))
      } catch {
        state.events.push({ invalid: line })
      }
    }
  })
  const controlFd = channel._handle?.fd ?? channel.fd
  try { state.controlInode = fs.fstatSync(controlFd).ino || null } catch { state.controlInode = null }
  state.channel = channel
  t.after(async () => {
    try { channel.end() } catch { /* already closed */ }
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    await waitExit(child, 2000)
  })
  return state
}

function sendGo(state, environment) {
  const message = {
    go: {
      command: process.execPath,
      args: [AGENT],
      cwd: environment.OUT,
      env: environment,
    },
  }
  state.channel.write(`${JSON.stringify(message)}\n`)
}

function event(state, key) {
  return state.events.find((entry) => entry && entry[key])
}

function testEnvironment(out, overrides = {}) {
  return {
    PATH: '/usr/bin:/bin',
    MELDWORK_CONTAINER: `supervisor-test-${process.pid}-${Date.now()}`,
    OUT: out,
    MODE: 'normal',
    LOOPS: '3',
    CUSTOM: 'value',
    ...overrides,
  }
}

test('before go, closing the control channel exits without starting the Agent', async (t) => {
  const state = startSupervisor(t)
  state.channel.end()
  const exit = await waitExit(state.child, 4000)
  assert.deepEqual(exit, { code: 0, signal: null })
  assert.equal(state.events.length, 0)
  assert.equal(state.stdout, '')
  assert.ok(groupEmpty(state.child.pid))
})

test('runs an Agent, reports its exit and empties the container', async (t) => {
  const out = fixture(t)
  const environment = testEnvironment(out)
  const state = startSupervisor(t)
  sendGo(state, environment)
  await waitUntil(() => Boolean(event(state, 'finalKill')))
  const exit = await waitExit(state.child, 6000)
  assert.equal(exit.signal, 'SIGKILL')

  const started = event(state, 'started')
  const agentExit = event(state, 'agentExit')
  const finalKill = event(state, 'finalKill')
  assert.ok(started.started.agentPid > 0)
  assert.equal(agentExit.agentExit.code, 0)
  assert.equal(agentExit.agentExit.signal, null)
  assert.equal(finalKill.finalKill.agentAlive, false)
  assert.match(state.stdout, /STARTED/)
  assert.match(state.stdout, /FINAL-ANSWER/)

  const recordedEnvironment = JSON.parse(fs.readFileSync(path.join(out, 'env.json'), 'utf8'))
  for (const [key, value] of Object.entries(environment)) {
    assert.equal(recordedEnvironment[key], value)
  }
  // Node/CoreFoundation on macOS adds __CF_USER_TEXT_ENCODING after execve.
  // The supervisor itself passes the go environment exactly; the dedicated
  // /usr/bin/env test below proves that without runtime additions.
  const extraKeys = Object.keys(recordedEnvironment).filter((key) => !Object.hasOwn(environment, key))
  assert.deepEqual(extraKeys, process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])

  const descriptors = JSON.parse(fs.readFileSync(path.join(out, 'fds.json'), 'utf8'))
  assert.ok(
    Number.isInteger(state.controlInode) && state.controlInode > 0,
    'the control channel inode must be readable so inheritance can be checked',
  )
  assert.equal(
    descriptors.some((descriptor) => descriptor.ino === state.controlInode),
    false,
    'the control channel descriptor must not be inherited by the Agent',
  )

  const sizeAtExit = fileSize(path.join(out, 'bg.txt'))
  await delay(500)
  assert.equal(fileSize(path.join(out, 'bg.txt')), sizeAtExit)
  assert.ok(groupEmpty(state.child.pid))
})

test('closing the control channel after go cleans up the whole container', async (t) => {
  const out = fixture(t)
  const environment = testEnvironment(out, { LOOPS: '50' })
  const state = startSupervisor(t)
  sendGo(state, environment)
  await waitUntil(() => Boolean(event(state, 'started')))
  await delay(300)
  // The supervisor treats fd 3 EOF as "main died" and stops sending messages;
  // this test therefore observes cleanup through the child exit and the
  // container state instead of finalKill.
  state.channel.end()
  const exit = await waitExit(state.child, 10000)
  assert.equal(exit.signal, 'SIGKILL')
  const sizeAtExit = fileSize(path.join(out, 'bg.txt'))
  await delay(500)
  assert.equal(fileSize(path.join(out, 'bg.txt')), sizeAtExit)
  assert.ok(groupEmpty(state.child.pid))
})

test('a detached child escapes the container and is left for the caller', async (t) => {
  const out = fixture(t)
  const environment = testEnvironment(out, { MODE: 'escape' })
  const state = startSupervisor(t)
  let escapedPid = null
  try {
    sendGo(state, environment)
    await waitUntil(() => Boolean(event(state, 'finalKill')))
    await waitExit(state.child, 6000)
    escapedPid = Number(fs.readFileSync(path.join(out, 'escaped.pid'), 'utf8'))
    assert.ok(Number.isInteger(escapedPid) && escapedPid > 0)
    const sizeAtExit = fileSize(path.join(out, 'escaped.txt'))
    await delay(500)
    assert.ok(fileSize(path.join(out, 'escaped.txt')) > sizeAtExit)
  } finally {
    if (escapedPid) {
      try { process.kill(-escapedPid, 'SIGKILL') } catch { try { process.kill(escapedPid, 'SIGKILL') } catch { /* gone */ } }
      await delay(200)
      assert.equal(processAlive(escapedPid), false)
    }
  }
  assert.ok(groupEmpty(state.child.pid))
})

test('an unparseable control message reports a protocol error and cleans up', async (t) => {
  const state = startSupervisor(t)
  state.channel.write('not-json\n')
  await waitUntil(() => Boolean(event(state, 'finalKill')))
  const exit = await waitExit(state.child, 6000)
  assert.equal(exit.signal, 'SIGKILL')
  assert.equal(event(state, 'started'), undefined)
  assert.equal(event(state, 'error').error.code, 'SUPERVISOR_PROTOCOL')
  assert.equal(event(state, 'finalKill').finalKill.agentAlive, true)
  assert.ok(groupEmpty(state.child.pid))
})

test('passes the go environment to the Agent exactly', async (t) => {
  const out = fixture(t)
  const environment = {
    PATH: '/usr/bin:/bin',
    MELDWORK_CONTAINER: `supervisor-env-${process.pid}-${Date.now()}`,
    CUSTOM: 'value',
    EMPTY: '',
  }
  const state = startSupervisor(t)
  const message = {
    go: {
      command: '/usr/bin/env',
      args: [],
      cwd: out,
      env: environment,
    },
  }
  state.channel.write(`${JSON.stringify(message)}\n`)
  await waitUntil(() => Boolean(event(state, 'finalKill')))
  await waitExit(state.child, 6000)
  const recorded = {}
  for (const line of state.stdout.split('\n')) {
    if (!line) continue
    const separator = line.indexOf('=')
    if (separator > 0) recorded[line.slice(0, separator)] = line.slice(separator + 1)
  }
  assert.deepEqual(recorded, environment)
  assert.equal(event(state, 'agentExit').agentExit.code, 0)
})

test('an execve failure is reported as an Agent exit code 127', async (t) => {
  const out = fixture(t)
  const state = startSupervisor(t)
  const message = {
    go: {
      command: '/nonexistent/meldwork-supervisor-agent',
      args: [],
      cwd: out,
      env: { PATH: '/usr/bin:/bin', MELDWORK_CONTAINER: 'exec-failure' },
    },
  }
  state.channel.write(`${JSON.stringify(message)}\n`)
  await waitUntil(() => Boolean(event(state, 'finalKill')))
  await waitExit(state.child, 6000)
  assert.ok(event(state, 'started').started.agentPid > 0)
  assert.equal(event(state, 'agentExit').agentExit.code, 127)
  assert.equal(event(state, 'finalKill').finalKill.agentAlive, false)
  assert.ok(groupEmpty(state.child.pid))
})
