const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProjectService, scanNestedRepos } = require('../../src/project-room/project-service.cjs')
const { TemplatesStore } = require('../../src/project-room/templates-store.cjs')
const { emptyProjectState, parseProjectState } = require('../../src/project-room/project-state-schema.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { emptyState } = require('../../src/workspace/local-workspace-message-records.cjs')
const {
  loadWorkspaceState,
  saveWorkspaceState,
} = require('../../src/workspace/local-workspace-state.cjs')

const at = '2026-01-01T00:00:00.000Z'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-project-service-'))
  const workdir = path.join(root, 'work')
  fs.mkdirSync(workdir, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    root,
    workdir,
    privateRoot: path.join(root, 'meldwork-private'),
    storagePath: path.join(root, 'meldwork-workspace.json'),
  }
}

function makeWorkspace(paths, { agents } = {}) {
  let id = 0
  return {
    state: emptyState(),
    detectedAgents: agents || [
      { kind: 'codex', available: true },
      { kind: 'claude', available: true },
    ],
    save() {
      saveWorkspaceState(paths.storagePath, this.state)
    },
    emitChanged() {},
    createId() {
      id += 1
      return `workspace-${id}`
    },
    now() {
      return at
    },
  }
}

async function makeService(t, options = {}) {
  const paths = fixture(t)
  const workspace = options.workspace || makeWorkspace(paths, options)
  const templatesStore = new TemplatesStore({
    storagePath: path.join(paths.privateRoot, 'templates.json'),
    now: () => at,
    createId: (() => {
      let id = 0
      return () => `template-${id += 1}`
    })(),
  })
  await templatesStore.load()
  const scheduler = options.scheduler || new RunScheduler()
  const service = new ProjectService({
    workspace,
    privateRoot: paths.privateRoot,
    scheduler,
    templatesStore,
    checkGitVersionFn: options.checkGitVersionFn || (async () => ({ ok: true, version: '2.39' })),
    createId: (() => {
      let id = 0
      return () => `id-${id += 1}`
    })(),
    now: () => at,
    ...options.serviceOptions,
  })
  return { paths, workspace, templatesStore, scheduler, service }
}

test('create writes state, shadow repo, project record, and main chat in order', async (t) => {
  const { paths, workspace, service } = await makeService(t)
  await service.start()
  fs.mkdirSync(path.join(paths.workdir, 'vendor', 'nested', '.git'), { recursive: true })

  const snapshot = await service.create({ name: 'Project One', workdir: paths.workdir })
  const projectId = snapshot.projectId
  assert.equal(snapshot.name, 'Project One')
  assert.equal(snapshot.readOnly, false)
  assert.equal(snapshot.workdir, fs.realpathSync.native(paths.workdir))
  assert.equal(snapshot.config.seats.length, 2)
  assert.equal(snapshot.gates.length, 0)
  assert.deepEqual(workspace.state.projects.map(project => project.id), [projectId])
  assert.equal(workspace.state.groups.length, 1)
  const main = workspace.state.groups[0]
  assert.equal(main.projectId, projectId)
  assert.equal(main.projectRole, 'main')
  assert.deepEqual(main.agentKinds, ['codex', 'claude'])
  assert.equal(main.allowWrite, true)

  const projectDir = path.join(paths.privateRoot, 'projects', projectId)
  const state = parseProjectState(JSON.parse(
    fs.readFileSync(path.join(projectDir, 'state.json'), 'utf8'),
  ))
  assert.equal(state.schemaVersion, 1)
  assert.deepEqual(state.config.settings.excludedRepos, ['vendor/nested'])
  assert.equal(fs.statSync(path.join(projectDir, 'shadow.git')).isDirectory(), true)
  const exclude = fs.readFileSync(path.join(projectDir, 'shadow.git', 'info', 'exclude'), 'utf8')
  assert.equal(exclude.includes('vendor/nested/'), true)

  const context = service.projects.get(projectId)
  await context.shadowRepo.snapshot({ effectId: 'project-service:1:0' })
  const excludeAfterSnapshot = fs.readFileSync(
    path.join(projectDir, 'shadow.git', 'info', 'exclude'), 'utf8',
  )
  assert.equal(excludeAfterSnapshot.includes('vendor/nested/'), true)

  const reloadedWorkspace = makeWorkspace(paths)
  reloadedWorkspace.state = loadWorkspaceState(paths.storagePath).state
  const reloaded = await makeService(t, {
    workspace: reloadedWorkspace,
    serviceOptions: { privateRoot: paths.privateRoot, privateRootIsFixed: true },
  })
  await reloaded.service.start()
  assert.deepEqual(reloaded.service.list().map(entry => entry.projectId), [projectId])
  assert.equal(reloaded.service.snapshot(projectId).config.seats.length, 2)
})

test('updatePreferences persists drawer width and tab per project', async (t) => {
  const { paths, service } = await makeService(t)
  await service.start()
  const created = await service.create({ name: 'Project One', workdir: paths.workdir })
  const projectId = created.projectId
  const revision = service.snapshot(projectId).revision

  const result = await service.updatePreferences({
    projectId,
    drawerWidth: 520,
    drawerTab: 'trace',
  })
  assert.deepEqual(result.preferences, { drawerWidth: 520, drawerTab: 'trace' })
  const snapshot = service.snapshot(projectId)
  assert.deepEqual(snapshot.preferences, { drawerWidth: 520, drawerTab: 'trace' })
  assert.equal(snapshot.revision, revision + 1)

  const updated = await service.updatePreferences({ projectId, commitToGit: true })
  assert.deepEqual(updated.preferences, {
    drawerWidth: 520,
    drawerTab: 'trace',
    commitToGit: true,
  })

  await assert.rejects(
    service.updatePreferences({ projectId, drawerWidth: 200 }),
    { code: 'PROJECT_INPUT_INVALID', details: { reason: 'drawer-width-invalid' } },
  )
  await assert.rejects(
    service.updatePreferences({ projectId, drawerTab: 'other' }),
    { code: 'PROJECT_INPUT_INVALID', details: { reason: 'drawer-tab-invalid' } },
  )
  assert.deepEqual(service.snapshot(projectId).preferences, {
    drawerWidth: 520,
    drawerTab: 'trace',
    commitToGit: true,
  })
})

test('create rejects duplicate, invalid, or unsupported workdirs', async (t) => {
  const { paths, service } = await makeService(t)
  await service.start()
  const first = await service.create({ name: 'First', workdir: paths.workdir })
  fs.mkdirSync(path.join(paths.workdir, 'nested'))

  await assert.rejects(service.create({ name: 'Again', workdir: paths.workdir }), {
    code: 'PROJECT_WORKDIR_TAKEN',
  })
  await assert.rejects(service.create({
    name: 'Nested', workdir: path.join(paths.workdir, 'nested'),
  }), { code: 'PROJECT_WORKDIR_TAKEN' })
  await assert.rejects(service.create({
    name: 'Missing', workdir: path.join(paths.root, 'missing'),
  }), (error) => {
    assert.equal(error.code, 'PROJECT_INPUT_INVALID')
    assert.equal(error.details.reason, 'workdir-invalid')
    return true
  })
  assert.equal(service.list().length, 1)
  assert.equal(service.list()[0].projectId, first.projectId)
})

test('create reports a missing or too-old git', async (t) => {
  const { paths, service } = await makeService(t, {
    checkGitVersionFn: async () => ({ ok: false, version: '2.31' }),
  })
  await service.start()
  await assert.rejects(service.create({ name: 'Project', workdir: paths.workdir }), (error) => {
    assert.equal(error.code, 'PROJECT_GIT_UNAVAILABLE')
    assert.equal(error.details.version, '2.31')
    return true
  })
  assert.equal(fs.existsSync(path.join(paths.privateRoot, 'projects')), false)
})

test('create refuses when no seat agent is available', async (t) => {
  const paths = fixture(t)
  const workspace = makeWorkspace(paths, {
    agents: [{ kind: 'other', available: true }],
  })
  const { service } = await makeService(t, { workspace })
  await service.start()
  await assert.rejects(service.create({ name: 'Project', workdir: paths.workdir }), {
    code: 'PROJECT_CAPABILITY_UNSUPPORTED',
  })
  assert.equal(fs.existsSync(path.join(paths.privateRoot, 'projects')), false)
  assert.deepEqual(workspace.state.projects, [])
})

test('create removes the project directory when shadow creation or the workspace save fails', async (t) => {
  const failingShadow = class {
    static async create() {
      throw Object.assign(new Error('SHADOW_FAILED'), { code: 'SHADOW_FAILED' })
    }
  }
  const first = await makeService(t, {
    serviceOptions: { ShadowRepoClass: failingShadow },
  })
  await first.service.start()
  await assert.rejects(first.service.create({ name: 'Project', workdir: first.paths.workdir }), {
    message: 'SHADOW_FAILED',
  })
  assert.deepEqual(fs.readdirSync(path.join(first.paths.privateRoot, 'projects')), [])
  assert.deepEqual(first.workspace.state.projects, [])

  const second = await makeService(t)
  await second.service.start()
  second.workspace.save = () => {
    throw Object.assign(new Error('EIO'), { phase: 'before-commit' })
  }
  await assert.rejects(second.service.create({ name: 'Project', workdir: second.paths.workdir }), {
    message: 'EIO',
  })
  assert.deepEqual(fs.readdirSync(path.join(second.paths.privateRoot, 'projects')), [])
  assert.deepEqual(second.workspace.state.projects, [])
  assert.deepEqual(second.workspace.state.groups, [])
})

test('start holds and releases project roots and reports unreadable state', async (t) => {
  const { paths, workspace, service, scheduler } = await makeService(t)
  const project = {
    id: 'project-1',
    name: 'Existing',
    workdir: paths.workdir,
    createdAt: at,
    updatedAt: at,
  }
  workspace.state.projects = [project]
  workspace.save()
  await service.start()
  assert.equal(service.list().length, 1)
  assert.equal(service.list()[0].readOnly, true)
  assert.equal(service.list()[0].readOnlyReason, 'missing')
  assert.deepEqual(scheduler.snapshot().heldRoots, [])

  const second = await makeService(t)
  const projectDir = path.join(second.paths.privateRoot, 'projects', 'project-1')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(
    path.join(projectDir, 'state.json'),
    `${JSON.stringify(emptyProjectState({ projectId: 'project-1' }))}\n`,
  )
  second.workspace.state.projects = [project]
  second.workspace.save()
  await second.service.start()
  assert.equal(second.service.list()[0].readOnly, false)
  assert.deepEqual(second.scheduler.snapshot().heldRoots, [])
})

test('start completes a recovered chat write detection before continuing', async (t) => {
  const { paths, workspace, templatesStore, service } = await makeService(t)
  await service.start()
  const snapshot = await service.create({ name: 'Recovered', workdir: paths.workdir })
  const projectId = snapshot.projectId
  const context = service.projects.get(projectId)
  await context.store.enqueue((state) => {
    state.chatWriteChecks['run-1'] = {
      groupId: 'group-1', status: 'pending-detection',
      snapshotCommit: null, baseVersions: null, failure: null,
    }
    return { next: state }
  })

  const secondScheduler = new RunScheduler()
  const second = new ProjectService({
    workspace,
    privateRoot: paths.privateRoot,
    scheduler: secondScheduler,
    templatesStore,
    checkGitVersionFn: async () => ({ ok: true, version: '2.39' }),
    createId: (() => {
      let id = 0
      return () => `second-${id += 1}`
    })(),
    now: () => at,
  })
  await second.start()
  const recovered = second.projects.get(projectId)
  assert.equal(recovered.readOnly, false)
  assert.equal(recovered.store.current().chatWriteChecks['run-1'], undefined)
  assert.equal(recovered.store.current().projectEffects[0].status, 'consumed')
  assert.equal(recovered.store.current().maintenanceLeaseRequests[0].status, 'released')
})

test('rename updates only the workspace record', async (t) => {
  const { workspace, service } = await makeService(t)
  await service.start()
  const snapshot = await service.create({ name: 'Old', workdir: (await makeServiceWorkdir(t)) })
  const renamed = await service.rename({ projectId: snapshot.projectId, name: 'New' })
  assert.equal(renamed.name, 'New')
  assert.equal(workspace.state.projects[0].name, 'New')
})

async function makeServiceWorkdir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-service-workdir-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('configuration methods validate revisions and keep versions', async (t) => {
  const { service, templatesStore } = await makeService(t)
  await service.start()
  const workdir = await makeServiceWorkdir(t)
  const snapshot = await service.create({ name: 'Project', workdir })
  let configRevision = service.projects.get(snapshot.projectId).store.current().config.configRevision
  const seat = service.projects.get(snapshot.projectId).store.current().config.seats[0]

  const updated = await service.updateSeat({
    projectId: snapshot.projectId,
    seat: { ...seat, roleName: 'Lead writer' },
    configRevision,
  })
  assert.equal(updated.durable, true)
  configRevision = service.projects.get(snapshot.projectId).store.current().config.configRevision
  assert.equal(service.projects.get(snapshot.projectId).store.current().config.seats[0].roleName, 'Lead writer')
  await assert.rejects(service.updateSeat({
    projectId: snapshot.projectId, seat, configRevision: 0,
  }), { code: 'PROJECT_CONFIG_STALE' })

  const added = await service.addSeat({
    projectId: snapshot.projectId,
    seat: {
      id: 'seat-extra',
      roleName: 'Researcher',
      duty: 'Research.',
      agentKind: 'claude',
      capabilities: ['read'],
      checkpointRoles: [],
      profileVersionId: 'unused',
      profileText: 'Research carefully.',
    },
    configRevision,
  })
  assert.equal(added.result.id, 'seat-extra')
  configRevision = service.projects.get(snapshot.projectId).store.current().config.configRevision
  assert.equal(
    service.projects.get(snapshot.projectId).store.current().config.profiles
      .some(profile => profile.seatId === 'seat-extra' && profile.text === 'Research carefully.'),
    true,
  )

  await assert.rejects(service.removeSeat({
    projectId: snapshot.projectId, seatId: seat.id, configRevision,
  }), { code: 'PROJECT_SEAT_IN_USE' })
  const removed = await service.removeSeat({
    projectId: snapshot.projectId, seatId: 'seat-extra', configRevision,
  })
  assert.equal(removed.durable, true)
  configRevision = service.projects.get(snapshot.projectId).store.current().config.configRevision

  const profile = await service.updateProfile({
    projectId: snapshot.projectId, seatId: seat.id, text: 'Second version.', configRevision,
  })
  assert.equal(profile.result.version, 2)
  configRevision = service.projects.get(snapshot.projectId).store.current().config.configRevision
  const firstProfile = service.projects.get(snapshot.projectId).store.current().config.profiles
    .find(item => item.id === seat.profileVersionId)
  const rolledBack = await service.rollbackProfile({
    projectId: snapshot.projectId,
    seatId: seat.id,
    profileId: firstProfile.id,
    configRevision,
  })
  assert.equal(rolledBack.result.source, 'rollback')
  assert.equal(rolledBack.result.version, 3)
  assert.equal(rolledBack.result.text, firstProfile.text)
  configRevision = service.projects.get(snapshot.projectId).store.current().config.configRevision

  const playbook = await service.updatePlaybook({
    projectId: snapshot.projectId,
    patch: { roundLimit: 5, gates: { requirements: 'soft' } },
    configRevision,
  })
  assert.equal(playbook.result.roundLimit, 5)
  assert.equal(playbook.result.checkpointDefs[0].gate, 'soft')

  const template = await service.saveAsTemplate({ projectId: snapshot.projectId, name: 'Saved' })
  assert.equal(template.name, 'Saved')
  assert.deepEqual(templatesStore.list().map(item => item.name), ['Saved'])
})

test('updatePlaybook refuses started checkpoints', async (t) => {
  const { service } = await makeService(t)
  await service.start()
  const workdir = await makeServiceWorkdir(t)
  const snapshot = await service.create({ name: 'Project', workdir })
  const context = service.projects.get(snapshot.projectId)
  await context.store.enqueue((state) => {
    state.instances = [{
      id: 'cp-1', checkpointKey: 'requirements', state: 'leading', seq: 0, epoch: 0,
      round: 0, roundsSinceHuman: 0, continuations: 0, sessionGeneration: 0,
      candidate: null, rounds: [], roundsSummary: [], leaseRequests: [],
      activeInvocations: [], pendingStart: null, drafts: [], interjections: [],
      gate: null, blockedOn: null, effects: [], artifactVersions: [],
      readVersions: {}, decisions: [],
    }]
    state.config.configRevision += 1
    return { next: state }
  })
  const configRevision = context.store.current().config.configRevision
  await assert.rejects(service.updatePlaybook({
    projectId: snapshot.projectId,
    patch: { gates: { requirements: 'soft' } },
    configRevision,
  }), (error) => {
    assert.equal(error.code, 'PROJECT_INPUT_INVALID')
    assert.equal(error.details.reason, 'checkpoint-started')
    return true
  })
})

test('scanNestedRepos lists nested git directories without the root repo', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-nested-repos-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, '.git'))
  fs.mkdirSync(path.join(directory, 'vendor', 'one', '.git'), { recursive: true })
  fs.mkdirSync(path.join(directory, 'vendor', 'two'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'vendor', 'two', '.git'), 'gitdir: ../three')
  fs.mkdirSync(path.join(directory, 'node_modules', 'ignored', '.git'), { recursive: true })
  assert.deepEqual(scanNestedRepos(directory).sort(), ['vendor/one', 'vendor/two'])
})
