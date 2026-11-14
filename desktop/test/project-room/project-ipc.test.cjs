const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { registerProjectIpc } = require('../../src/shell/project-ipc.cjs')

function seat(overrides = {}) {
  return {
    id: 'seat-1',
    roleName: 'Lead',
    duty: 'Write.',
    agentKind: 'codex',
    capabilities: ['read'],
    checkpointRoles: [],
    profileVersionId: 'profile-1',
    ...overrides,
  }
}

function validInputs() {
  return {
    chooseWorkdir: undefined,
    create: { token: 'token-1', name: 'Project' },
    rename: { projectId: 'project-1', name: 'Name' },
    delete: { projectId: 'project-1', keepChats: false },
    retryDeletion: { projectId: 'project-1' },
    snapshot: { projectId: 'project-1' },
    updateSeat: { projectId: 'project-1', seat: seat(), configRevision: 0 },
    addSeat: { projectId: 'project-1', seat: seat(), configRevision: 0 },
    removeSeat: { projectId: 'project-1', seatId: 'seat-1', configRevision: 0 },
    updateProfile: {
      projectId: 'project-1', seatId: 'seat-1', text: 'Text', configRevision: 0,
    },
    rollbackProfile: {
      projectId: 'project-1', seatId: 'seat-1', profileId: 'profile-1', configRevision: 0,
    },
    updatePlaybook: { projectId: 'project-1', patch: { roundLimit: 4 }, configRevision: 0 },
    saveAsTemplate: { projectId: 'project-1', name: 'Template' },
    compact: { projectId: 'project-1' },
    diagnostics: { projectId: 'project-1' },
    start: { projectId: 'project-1', brief: 'Brief' },
    interject: {
      projectId: 'project-1', checkpointId: 'cp-1', purpose: 'interjection', text: 'Text',
    },
    stopAndDeliver: { projectId: 'project-1', checkpointId: 'cp-1' },
    decideGate: {
      projectId: 'project-1', gateId: 'gate-1', gateRevision: 1, outcome: 'accept',
    },
    previewReject: { projectId: 'project-1', checkpointId: 'cp-1', upstreamId: 'cp-0' },
    previewReopen: { projectId: 'project-1', checkpointId: 'cp-1' },
    reopen: {
      projectId: 'project-1', checkpointId: 'cp-1', reason: 'Because', impactHash: 'hash',
    },
    resolveDrift: {
      projectId: 'project-1', items: [{ itemId: 'drift-1', revision: 1 }], choice: 'workdir',
    },
    cancelDriftResolution: { projectId: 'project-1', itemId: 'drift-1', revision: 1 },
    resolveOutOfScope: { projectId: 'project-1', itemIds: ['scope-1'] },
    retryEffect: { projectId: 'project-1', effectId: 'effect-1' },
    residual: { residualId: 'residual-1', action: 'manuallyEnded' },
    unlockDirectory: { projectId: 'project-1', folderName: 'project' },
  }
}

function schemaKeys(schema, keys = new Set(), seen = new Set()) {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return keys
  seen.add(schema)
  if (schema.shape && typeof schema.shape === 'object') {
    for (const [key, value] of Object.entries(schema.shape)) {
      keys.add(key)
      schemaKeys(value, keys, seen)
    }
  }
  for (const value of Object.values(schema._def || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') schemaKeys(item, keys, seen)
      }
    } else if (value && typeof value === 'object' && (value._def || value.shape)) {
      schemaKeys(value, keys, seen)
    }
  }
  return keys
}

async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-project-ipc-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const handlers = new Map()
  let clock = 1000
  let tokenCounter = 0
  const contexts = new Map([['project-1', {
    project: { id: 'project-1' },
    readOnly: false,
    readOnlyReason: '',
    store: {
      current: () => ({ revision: 3 }),
      getStorageFault: () => null,
    },
  }]])
  const service = {
    projects: new Map(),
    contexts,
    calls: [],
    contextFor(id) {
      return this.contexts.get(id) || null
    },
    assertReady(id) {
      const context = this.contexts.get(id)
      if (!context) throw Object.assign(new Error('PROJECT_NOT_FOUND'), { code: 'PROJECT_NOT_FOUND' })
      if (context.readOnly) {
        throw Object.assign(new Error('PROJECT_READ_ONLY'), { code: 'PROJECT_READ_ONLY' })
      }
      return context
    },
    async create(input) {
      this.calls.push(['create', input])
      return { projectId: 'project-1' }
    },
    async rename(input) {
      this.calls.push(['rename', input])
      return input
    },
    async updateSeat(input) { this.calls.push(['updateSeat', input]); return input },
    async addSeat(input) { this.calls.push(['addSeat', input]); return input },
    async removeSeat(input) { this.calls.push(['removeSeat', input]); return input },
    async updateProfile(input) { this.calls.push(['updateProfile', input]); return input },
    async rollbackProfile(input) { this.calls.push(['rollbackProfile', input]); return input },
    async updatePlaybook(input) { this.calls.push(['updatePlaybook', input]); return input },
    async saveAsTemplate(input) { this.calls.push(['saveAsTemplate', input]); return input },
    async compact() { return { revision: 4 } },
    snapshot(id) { return { projectId: id } },
  }
  const deletion = {
    deleting: new Set(),
    calls: [],
    isDeleting(id) { return this.deleting.has(id) },
    progress(id) { return { projectId: id, phase: 'draining' } },
    async delete(input) { this.calls.push(['delete', input]); return { deleted: true } },
    async retryDeletion(id) { this.calls.push(['retryDeletion', id]); return { deleted: true } },
  }
  const dialog = {
    canceled: false,
    filePaths: [directory],
    calls: 0,
    async showOpenDialog() {
      this.calls += 1
      return { canceled: this.canceled, filePaths: this.filePaths }
    },
  }
  const ipc = registerProjectIpc({
    registerTrustedHandle: (channel, handler) => handlers.set(channel, handler),
    getProjectService: () => service,
    getDeletion: () => deletion,
    dialog,
    getMainWindow: () => ({}),
    now: () => clock,
    createToken: () => `token-${tokenCounter += 1}`,
  })
  const invoke = async (method, input) => handlers.get(`project:${method}`)(input)
  return {
    directory, service, deletion, dialog, ipc, invoke,
    advance: ms => { clock += ms },
  }
}

test('every method rejects extra fields before doing any work', async (t) => {
  const { invoke } = await setup(t)
  const inputs = validInputs()
  for (const [method, input] of Object.entries(inputs)) {
    const value = method === 'chooseWorkdir' ? { extra: true } : { ...input, extra: true }
    await assert.rejects(invoke(method, value), (error) => {
      assert.equal(error.code, 'PROJECT_INPUT_INVALID', method)
      return true
    }, method)
  }
})

test('no method schema accepts a filesystem path field', async (t) => {
  const { ipc } = await setup(t)
  const forbidden = new Set([
    'path', 'filePath', 'workdir', 'workdirPath', 'directory', 'folderPath',
    'executable', 'executablePath', 'command', 'commandLine',
  ])
  for (const [method, schema] of Object.entries(ipc.schemas)) {
    for (const key of schemaKeys(schema)) {
      assert.equal(forbidden.has(key), false, `${method} accepts ${key}`)
    }
  }
})

test('rejects overlong text and invalid ids', async (t) => {
  const { invoke } = await setup(t)
  const cases = [
    ['rename', { projectId: 'project-1', name: 'x'.repeat(81) }],
    ['updateProfile', {
      projectId: 'project-1', seatId: 'seat-1', text: 'x'.repeat(16385), configRevision: 0,
    }],
    ['interject', {
      projectId: 'project-1', checkpointId: 'cp-1', purpose: 'interjection', text: 'x'.repeat(32769),
    }],
    ['snapshot', { projectId: 'bad id' }],
    ['delete', { projectId: 'project-1', keepChats: 'no' }],
  ]
  for (const [method, input] of cases) {
    await assert.rejects(invoke(method, input), { code: 'PROJECT_INPUT_INVALID' }, method)
  }
})

test('chooseWorkdir tokens are single-use and expire after ten minutes', async (t) => {
  const { invoke, advance, directory } = await setup(t)
  const chosen = await invoke('chooseWorkdir')
  assert.match(chosen.token, /^token-\d+$/)
  assert.equal(chosen.displayName, path.basename(directory))

  const created = await invoke('create', { token: chosen.token, name: 'Project' })
  assert.equal(created.projectId, 'project-1')
  await assert.rejects(invoke('create', { token: chosen.token, name: 'Project' }), {
    code: 'PROJECT_WORKDIR_TOKEN_INVALID',
  })

  const second = await invoke('chooseWorkdir')
  advance(10 * 60 * 1000 + 1)
  await assert.rejects(invoke('create', { token: second.token, name: 'Project' }), {
    code: 'PROJECT_WORKDIR_TOKEN_INVALID',
  })
})

test('chooseWorkdir reports cancellation and existing projects', async (t) => {
  const { invoke, dialog, service } = await setup(t)
  dialog.canceled = true
  assert.deepEqual(await invoke('chooseWorkdir'), { cancelled: true })

  dialog.canceled = false
  service.projects.set('existing', { project: { id: 'existing', workdir: dialog.filePaths[0] } })
  const existing = await invoke('chooseWorkdir')
  assert.equal(existing.existingProjectId, 'existing')
  assert.equal(existing.token, undefined)
})

test('free text is redacted before it reaches the service', async (t) => {
  const { invoke, service } = await setup(t)
  const chosen = await invoke('chooseWorkdir')
  const secret = 'sk-abcdefghijklmnop'
  await invoke('create', {
    token: chosen.token,
    name: `Project ${secret}`,
    seats: [seat({ roleName: `Lead ${secret}`, duty: `Write ${secret}` })],
  })
  const createCall = service.calls.find(([method]) => method === 'create')[1]
  assert.equal(createCall.name.includes(secret), false)
  assert.equal(createCall.name.includes('[redacted]'), true)
  assert.equal(createCall.seats[0].roleName.includes(secret), false)
  assert.equal(createCall.seats[0].duty.includes(secret), false)

  await invoke('updateProfile', {
    projectId: 'project-1', seatId: 'seat-1', text: `Text ${secret}`, configRevision: 0,
  })
  const profileCall = service.calls.find(([method]) => method === 'updateProfile')[1]
  assert.equal(profileCall.text.includes(secret), false)
  assert.equal(profileCall.text.includes('[redacted]'), true)
})

test('decideGate validates input and project state before reporting the engine unavailable', async (t) => {
  const { invoke, service, deletion } = await setup(t)
  await assert.rejects(invoke('decideGate', {
    projectId: 'missing', gateId: 'gate-1', gateRevision: 1, outcome: 'accept',
  }), { code: 'PROJECT_NOT_FOUND' })

  service.contexts.get('project-1').readOnly = true
  await assert.rejects(invoke('decideGate', {
    projectId: 'project-1', gateId: 'gate-1', gateRevision: 1, outcome: 'accept',
  }), { code: 'PROJECT_READ_ONLY' })
  service.contexts.get('project-1').readOnly = false

  deletion.deleting.add('project-1')
  await assert.rejects(invoke('decideGate', {
    projectId: 'project-1', gateId: 'gate-1', gateRevision: 1, outcome: 'accept',
  }), { code: 'PROJECT_DELETING' })
  deletion.deleting.delete('project-1')

  await assert.rejects(invoke('decideGate', {
    projectId: 'project-1', gateId: 'gate-1', gateRevision: 1, outcome: 'accept',
  }), { code: 'PROJECT_ENGINE_UNAVAILABLE' })
})

test('snapshot reports deletion progress and diagnostics stays narrow', async (t) => {
  const { invoke, deletion } = await setup(t)
  assert.deepEqual(await invoke('snapshot', { projectId: 'project-1' }), { projectId: 'project-1' })
  deletion.deleting.add('project-1')
  const deleting = await invoke('snapshot', { projectId: 'project-1' })
  assert.equal(deleting.deleting, true)
  assert.equal(deleting.deletion.phase, 'draining')

  const diagnostics = await invoke('diagnostics', { projectId: 'project-1' })
  assert.deepEqual(diagnostics, {
    projectId: 'project-1',
    readOnly: false,
    readOnlyReason: '',
    revision: 3,
    storageFault: null,
    deletion: { projectId: 'project-1', phase: 'draining' },
  })
})

test('only the four deletion-safe methods work while a project is deleting', async (t) => {
  const { invoke, deletion } = await setup(t)
  deletion.deleting.add('project-1')
  await assert.rejects(invoke('rename', { projectId: 'project-1', name: 'Name' }), {
    code: 'PROJECT_DELETING',
  })
  await assert.rejects(invoke('compact', { projectId: 'project-1' }), {
    code: 'PROJECT_DELETING',
  })
  assert.equal((await invoke('snapshot', { projectId: 'project-1' })).deleting, true)
  assert.ok(await invoke('diagnostics', { projectId: 'project-1' }))
  assert.deepEqual(await invoke('retryDeletion', { projectId: 'project-1' }), { deleted: true })
})

test('delete and retryDeletion route through the deletion service', async (t) => {
  const { invoke, deletion } = await setup(t)
  assert.deepEqual(await invoke('delete', { projectId: 'project-1', keepChats: true }), {
    deleted: true,
  })
  assert.deepEqual(deletion.calls[0], ['delete', { projectId: 'project-1', keepChats: true }])
  assert.deepEqual(await invoke('retryDeletion', { projectId: 'project-1' }), { deleted: true })
  assert.deepEqual(deletion.calls[1], ['retryDeletion', 'project-1'])
})
