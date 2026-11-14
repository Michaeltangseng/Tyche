const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProjectService } = require('../../src/project-room/project-service.cjs')
const { ProjectStore } = require('../../src/project-room/project-store.cjs')
const { CheckpointEngine } = require('../../src/project-room/checkpoint-engine.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T00:00:00.000Z'
const acceptedCommit = 'a'.repeat(40)
const snapshotCommit = 'b'.repeat(40)

function definition(key, overrides = {}) {
  return {
    key,
    name: key,
    type: 'document',
    targetFiles: [`docs/${key}.md`],
    leadSeatId: 'seat-lead',
    reviewerSeatIds: [],
    draftSeatIds: [],
    gate: 'hard',
    roundLimit: 3,
    continuationLimit: 3,
    producesChecklist: false,
    dependsOn: [],
    ...overrides,
  }
}

function acceptedInstance(key, id) {
  return {
    id,
    checkpointKey: key,
    state: 'accepted',
    seq: 1,
    epoch: 0,
    round: 1,
    roundsSinceHuman: 0,
    continuations: 0,
    sessionGeneration: 0,
    candidate: null,
    rounds: [],
    roundsSummary: [],
    leaseRequests: [],
    activeInvocations: [],
    pendingStart: null,
    drafts: [],
    interjections: [],
    gate: null,
    blockedOn: null,
    effects: [],
    artifactVersions: [{
      id: `av-${key}`,
      commit: acceptedCommit,
      candidateCommit: null,
      files: [`docs/${key}.md`],
      acceptedAt: at,
      source: 'gate',
      decisionId: null,
    }],
    readVersions: {},
    decisions: [],
  }
}

async function makeService(t, { keys = ['requirements'], diffQuiet = async () => false, snapshot } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-chat-detection-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.playbook.checkpointDefs = keys.map(key => definition(key))
  state.instances = keys.map((key, index) => acceptedInstance(key, `cp-${index + 1}`))
  const store = new ProjectStore({ projectDir: directory, now: () => at })
  fs.writeFileSync(path.join(directory, 'state.json'), `${JSON.stringify(state)}\n`)
  await store.load()
  const scheduler = {
    grants: [],
    request({ requestId, holder, claims, onGranted }) {
      this.grants.push({ requestId, holder, claims })
      onGranted?.(requestId)
    },
    release() {},
    withdraw() {},
    restoreGranted() {},
    snapshot() { return { claimGrants: this.grants, claimQueue: [], residuals: [] } },
  }
  const engine = new CheckpointEngine({
    projectId: 'project-1',
    store,
    scheduler,
    handlers: {},
    workdir: '/tmp/project',
    now: () => at,
  })
  const shadowRepo = {
    async snapshot() {
      if (snapshot) return snapshot()
      return { commit: snapshotCommit, placeholderList: [], skipped: false }
    },
    diffQuiet,
  }
  const service = new ProjectService({
    workspace: {
      state: { projects: [], groups: [{
        id: 'group-1', projectId: 'project-1', workGroup: true,
      }] },
      save() {},
      emitChanged() {},
    },
    privateRoot: directory,
    scheduler,
    templatesStore: { templates: [], get: () => null, load: async () => [] },
    createId: (() => { let id = 0; return () => `id-${id += 1}` })(),
    now: () => at,
  })
  service.projects.set('project-1', {
    project: { id: 'project-1', workdir: '/tmp/project' },
    store,
    shadowRepo,
    engine,
    readOnly: false,
    readOnlyReason: '',
  })
  return { service, store }
}

test('a writable project chat is checked, snapshotted, and detected before release', async (t) => {
  const { service, store } = await makeService(t)
  await service.beginProjectChatWrite('group-1', 'check-1')
  assert.equal(store.current().chatWriteChecks['check-1'].status, 'running')

  const result = await service.endProjectChatWrite('group-1', 'check-1')
  assert.equal(result.snapshotCommit, snapshotCommit)
  assert.equal(store.current().chatWriteChecks['check-1'], undefined)
  assert.equal(store.current().projectEffects.length, 1)
  assert.equal(store.current().projectEffects[0].status, 'consumed')
  const instance = store.current().instances[0]
  assert.equal(instance.gate.reason, 'doc-new-version')
  assert.equal(instance.gate.firstScreen.changesHeaderMissing, true)
})

test('non-critical accepted documents form a new artifact version', async (t) => {
  const { service, store } = await makeService(t, { keys: ['notes'] })
  await service.beginProjectChatWrite('group-1', 'check-1')
  await service.endProjectChatWrite('group-1', 'check-1')
  const instance = store.current().instances[0]
  assert.equal(instance.gate, null)
  assert.equal(instance.artifactVersions.length, 2)
  assert.equal(instance.artifactVersions[1].source, 'accepted-doc-change')
  assert.equal(instance.artifactVersions[1].commit, snapshotCommit)
})

test('a failed snapshot records a project block and can be retried', async (t) => {
  const { service, store } = await makeService(t, {
    snapshot: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) },
    diffQuiet: async () => true,
  })
  await service.beginProjectChatWrite('group-1', 'check-1')
  await service.endProjectChatWrite('group-1', 'check-1')
  assert.equal(store.current().projectBlockedOn.error, 'EIO')
  assert.equal(store.current().projectEffects[0].status, 'failed')
  const retried = await service.retryEffect({
    projectId: 'project-1', effectId: store.current().projectEffects[0].id,
  })
  assert.equal(retried.retried, true)
  assert.equal(store.current().projectBlockedOn.error, 'EIO')
})
