const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  ProjectDeletion,
  allowedDuringDeletion,
} = require('../../src/project-room/project-deletion.cjs')
const { ProjectStore } = require('../../src/project-room/project-store.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { emptyState } = require('../../src/workspace/local-workspace-message-records.cjs')
const { saveWorkspaceState } = require('../../src/workspace/local-workspace-state.cjs')

const at = '2026-01-01T00:00:00.000Z'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-project-deletion-'))
  const workdir = path.join(root, 'work')
  fs.mkdirSync(workdir, { recursive: true })
  const privateRoot = path.join(root, 'meldwork-private')
  const projectDir = path.join(privateRoot, 'projects', 'project-1')
  fs.mkdirSync(path.join(projectDir, 'shadow.git'), { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    root,
    workdir,
    privateRoot,
    projectDir,
    storagePath: path.join(root, 'meldwork-workspace.json'),
  }
}

function writeProjectState(paths, phase) {
  const state = emptyProjectState({ projectId: 'project-1' })
  if (phase) state.deletion = { phase, startedAt: at }
  fs.mkdirSync(paths.projectDir, { recursive: true })
  fs.writeFileSync(
    path.join(paths.projectDir, 'state.json'),
    `${JSON.stringify(state)}\n`,
  )
}

function workspaceState(paths, { deleting = null } = {}) {
  const state = emptyState()
  state.projects = [{
    id: 'project-1',
    name: 'Project',
    workdir: paths.workdir,
    createdAt: at,
    updatedAt: at,
    ...(deleting ? { deleting } : {}),
  }]
  state.groups = [
    {
      id: 'main', name: 'Main', agentKinds: ['codex'], workdir: paths.workdir,
      allowWrite: true, projectId: 'project-1', projectRole: 'main',
    },
    {
      id: 'chat', name: 'Chat', agentKinds: ['codex'], workdir: paths.workdir,
      allowWrite: true, projectId: 'project-1',
    },
    {
      id: 'other', name: 'Other', agentKinds: ['codex'], workdir: '/tmp/other',
      allowWrite: false,
    },
  ]
  state.messages = [
    { id: 'm-main', groupId: 'main', role: 'user', content: 'main' },
    { id: 'm-chat', groupId: 'chat', role: 'user', content: 'chat' },
    { id: 'm-other', groupId: 'other', role: 'user', content: 'other' },
  ]
  state.sessions = {
    'project:project-1:cp:1:seat:1:codex:g0': 'session-1',
    'group:other': 'session-2',
  }
  state.sessionMeta = {
    'project:project-1:cp:1:seat:1:codex:g0': { turns: 1 },
    'group:other': { turns: 2 },
  }
  return state
}

function fakeEffects() {
  const listeners = new Map()
  return {
    idle: true,
    isIdle() {
      return this.idle
    },
    onIdle(projectId, callback) {
      listeners.set(projectId, callback)
    },
    removeIdleListener(projectId, callback) {
      if (listeners.get(projectId) === callback) listeners.delete(projectId)
    },
    setIdle(value) {
      this.idle = value
      if (value) listeners.get('project-1')?.()
    },
  }
}

function fakeInvocations() {
  const listeners = new Map()
  let active = 0
  return {
    cancelled: false,
    activeInvocations() {
      return active
    },
    onInvocationEnded(projectId, callback) {
      listeners.set(projectId, callback)
    },
    removeInvocationEndedListener(projectId, callback) {
      if (listeners.get(projectId) === callback) listeners.delete(projectId)
    },
    cancelAll() {
      this.cancelled = true
    },
    setActive(value) {
      active = value
    },
    end() {
      active = 0
      listeners.get('project-1')?.()
    },
  }
}

function fakeEngine() {
  return {
    drained: true,
    isDrained() {
      return this.drained
    },
    beginDraining(state) {
      return state
    },
    async reconcileScheduler() {},
  }
}

function fakeTimers() {
  let callback = null
  const cleared = []
  const delays = []
  return {
    clearIntervalFn(handle) {
      cleared.push(handle)
    },
    setIntervalFn(fn, delay) {
      callback = fn
      delays.push(delay)
      return { id: delays.length }
    },
    fire() {
      callback?.()
    },
    delays,
    cleared,
  }
}

async function makeDeletion(t, options = {}) {
  const paths = fixture(t)
  if (options.writeState !== false) writeProjectState(paths, options.phase)
  const deleting = options.deleting
    || (options.phase || options.writeState === false
      ? { requestedAt: at, keepChats: false }
      : null)
  const workspace = {
    state: options.state || workspaceState(paths, { deleting }),
    save() {
      saveWorkspaceState(paths.storagePath, this.state)
    },
    emitChanged() {},
  }
  let store = null
  if (fs.existsSync(path.join(paths.projectDir, 'state.json'))) {
    store = new ProjectStore({ projectDir: paths.projectDir, now: () => at })
    await store.load()
  }
  const timers = fakeTimers()
  const effects = fakeEffects()
  const invocations = fakeInvocations()
  const engine = fakeEngine()
  if (options.invocationsActive) invocations.setActive(options.invocationsActive)
  const drained = []
  let deletedResolve
  const deleted = new Promise((resolve) => { deletedResolve = resolve })
  const deletion = new ProjectDeletion({
    workspace,
    privateRoot: paths.privateRoot,
    scheduler: new RunScheduler(),
    getContext: (projectId) => (
      projectId === 'project-1' ? { project: workspace.state.projects?.[0], store } : null
    ),
    engine,
    effects,
    invocations,
    now: () => at,
    removeProjectDir: options.removeProjectDir || ((projectId) => {
      fs.rmSync(path.join(paths.privateRoot, 'projects', projectId), {
        recursive: true, force: true,
      })
    }),
    hasResidual: options.hasResidual,
    onDeleted: () => deletedResolve(),
    onDrainCheck: (projectId, cause) => drained.push(cause),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  })
  return {
    paths, workspace, store, deletion, timers, effects, invocations, engine,
    drained, deleted,
  }
}

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('delete removes sessions, chats, the project directory, and the workspace record', async (t) => {
  const f = await makeDeletion(t)
  const result = await f.deletion.delete({ projectId: 'project-1', keepChats: false })

  assert.equal(result.deleted, true)
  assert.equal(f.deletion.isDeleting('project-1'), false)
  assert.deepEqual(f.workspace.state.projects, [])
  assert.deepEqual(f.workspace.state.groups.map(group => group.id), ['other'])
  assert.deepEqual(f.workspace.state.messages.map(message => message.id), ['m-other'])
  assert.deepEqual(Object.keys(f.workspace.state.sessions), ['group:other'])
  assert.deepEqual(Object.keys(f.workspace.state.sessionMeta), ['group:other'])
  assert.equal(fs.existsSync(f.paths.projectDir), false)
  assert.equal(f.effects.idle, true)
  assert.equal(f.invocations.cancelled, true)
  assert.equal(f.timers.delays[0], 30000)
  assert.equal(f.timers.cleared.length, 1)
})

test('keepChats turns project chats into normal chats and keeps their messages', async (t) => {
  const f = await makeDeletion(t)
  const result = await f.deletion.delete({ projectId: 'project-1', keepChats: true })

  assert.equal(result.deleted, true)
  const chat = f.workspace.state.groups.find(group => group.id === 'chat')
  assert.equal(chat.projectId, undefined)
  assert.equal(chat.projectRole, undefined)
  assert.equal(f.workspace.state.groups.some(group => group.id === 'main'), false)
  assert.deepEqual(f.workspace.state.messages.map(message => message.id), ['m-chat', 'm-other'])
})

test('deletion waits for the effect runner and project chat invocations', async (t) => {
  const f = await makeDeletion(t, { invocationsActive: 1 })
  f.effects.idle = false
  const result = await f.deletion.delete({ projectId: 'project-1' })
  assert.equal(result.deleted, false)
  assert.equal(f.deletion.progress('project-1').waitingOn.effects, true)
  assert.equal(f.deletion.progress('project-1').waitingOn.invocations, true)
  assert.deepEqual(f.workspace.state.projects.map(project => project.id), ['project-1'])

  f.effects.idle = true
  f.effects.setIdle(true)
  f.invocations.end()
  await f.deleted
  assert.equal(f.workspace.state.projects.length, 0)
  assert.equal(fs.existsSync(f.paths.projectDir), false)
  assert.ok(f.drained.includes('invocation-ended'))
})

test('a last chat invocation with no later event completes deletion through DRAIN_CHECK', async (t) => {
  const f = await makeDeletion(t, { invocationsActive: 1 })
  const result = await f.deletion.delete({ projectId: 'project-1' })
  assert.equal(result.deleted, false)

  f.invocations.end()
  await f.deleted
  assert.ok(f.drained.includes('invocation-ended'))
  assert.equal(f.workspace.state.projects.length, 0)
})

test('the fallback timer completes deletion when the invocation trigger is missed', async (t) => {
  const f = await makeDeletion(t, { invocationsActive: 1 })
  await f.deletion.delete({ projectId: 'project-1' })
  f.invocations.setActive(0)
  f.timers.fire()
  await f.deleted
  assert.ok(f.drained.includes('fallback'))
})

test('deletion resumes from every persisted phase', async (t) => {
  const draining = await makeDeletion(t, { phase: 'draining' })
  await draining.deletion.start()
  assert.equal(draining.workspace.state.projects.length, 0)
  assert.equal(fs.existsSync(draining.paths.projectDir), false)

  const drained = await makeDeletion(t, { phase: 'drained' })
  await drained.deletion.start()
  assert.equal(drained.workspace.state.projects.length, 0)
  assert.equal(fs.existsSync(drained.paths.projectDir), false)

  const missing = await makeDeletion(t, { writeState: false })
  await missing.deletion.start()
  assert.equal(missing.workspace.state.projects.length, 0)
  assert.equal(fs.existsSync(missing.paths.projectDir), false)
})

test('a failed directory removal keeps deleting and retryDeletion finishes', async (t) => {
  let fail = true
  const f = await makeDeletion(t, {
    removeProjectDir: (projectId) => {
      if (fail) throw new Error('EACCES')
      fs.rmSync(path.join(f.paths.privateRoot, 'projects', projectId), {
        recursive: true, force: true,
      })
    },
  })
  await assert.rejects(f.deletion.delete({ projectId: 'project-1' }), (error) => {
    assert.equal(error.code, 'PROJECT_STORAGE_FAULT')
    assert.equal(error.details.reason, 'directory-removal-failed')
    return true
  })
  assert.equal(f.deletion.isDeleting('project-1'), true)
  assert.equal(f.workspace.state.projects.length, 1)
  fail = false
  const result = await f.deletion.retryDeletion('project-1')
  assert.equal(result.deleted, true)
  assert.equal(f.workspace.state.projects.length, 0)
})

test('an unresolved residual blocks deletion before the marker is written', async (t) => {
  const f = await makeDeletion(t, { hasResidual: () => true })
  await assert.rejects(f.deletion.delete({ projectId: 'project-1' }), {
    code: 'PROJECT_RESIDUAL_UNRESOLVED',
  })
  assert.equal(f.workspace.state.projects[0].deleting, undefined)
  assert.equal(f.deletion.isDeleting('project-1'), false)
})

test('during deletion only snapshot, diagnostics, residual, and retryDeletion are allowed', () => {
  for (const method of ['snapshot', 'diagnostics', 'residual', 'retryDeletion']) {
    assert.equal(allowedDuringDeletion(method), true)
  }
  for (const method of ['start', 'interject', 'decideGate', 'rename', 'delete', 'compact']) {
    assert.equal(allowedDuringDeletion(method), false)
  }
})
