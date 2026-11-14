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

async function makeService(t, {
  keys = ['requirements'], diffQuiet = async () => false, snapshot, scheduler: injectedScheduler,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-chat-detection-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.playbook.checkpointDefs = keys.map(key => definition(key))
  state.instances = keys.map((key, index) => acceptedInstance(key, `cp-${index + 1}`))
  const store = new ProjectStore({ projectDir: directory, now: () => at })
  fs.writeFileSync(path.join(directory, 'state.json'), `${JSON.stringify(state)}\n`)
  await store.load()
  const scheduler = injectedScheduler || {
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

function deferredScheduler() {
  return {
    claimGrants: [],
    requestQueue: [],
    request({ requestId, holder, claims, onGranted }) {
      this.requestQueue.push({ requestId, holder, claims, onGranted })
    },
    grantNext() {
      const entry = this.requestQueue.shift()
      if (!entry) return null
      this.claimGrants.push({
        requestId: entry.requestId,
        holder: entry.holder,
        claims: entry.claims,
      })
      entry.onGranted?.(entry.requestId)
      return entry.requestId
    },
    release(requestId) {
      this.claimGrants = this.claimGrants.filter(record => record.requestId !== requestId)
    },
    withdraw() {},
    restoreGranted() {},
    snapshot() {
      return {
        claimGrants: this.claimGrants,
        claimQueue: this.requestQueue,
        residuals: [],
      }
    },
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('condition was not reached')
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

test('a failed snapshot is retried through a maintenance lease', async (t) => {
  const { service, store } = await makeService(t, {
    snapshot: (() => {
      let calls = 0
      return async () => {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('EIO'), { code: 'EIO' })
        return { commit: snapshotCommit, placeholderList: [], skipped: false }
      }
    })(),
    diffQuiet: async () => false,
  })
  await service.beginProjectChatWrite('group-1', 'check-1')
  await service.endProjectChatWrite('group-1', 'check-1')
  assert.equal(store.current().projectBlockedOn, null)
  assert.equal(store.current().chatWriteChecks['check-1'], undefined)
  const maintenance = store.current().maintenanceLeaseRequests
  assert.equal(maintenance.length, 1)
  assert.equal(maintenance[0].status, 'released')
  assert.equal(store.current().instances[0].gate.reason, 'doc-new-version')
})

test('a queued maintenance lease pauses the detection chain without blocking the caller', async (t) => {
  const scheduler = deferredScheduler()
  const { service, store } = await makeService(t, {
    scheduler,
    snapshot: (() => {
      let calls = 0
      return async () => {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('EIO'), { code: 'EIO' })
        return { commit: snapshotCommit, placeholderList: [], skipped: false }
      }
    })(),
    diffQuiet: async () => false,
  })
  await service.beginProjectChatWrite('group-1', 'check-1')
  const result = await service.endProjectChatWrite('group-1', 'check-1')
  assert.equal(result.snapshotCommit, null)
  assert.equal(store.current().chatWriteChecks['check-1'].status, 'pending-detection')
  assert.equal(store.current().maintenanceLeaseRequests[0].status, 'waiting')
  assert.equal(store.current().projectEffects[0].status, 'pending')
  assert.equal(scheduler.requestQueue.length, 1)

  scheduler.grantNext()
  await waitFor(() => store.current().chatWriteChecks['check-1'] === undefined)
  assert.equal(store.current().maintenanceLeaseRequests[0].status, 'released')
  assert.equal(store.current().projectEffects[0].status, 'consumed')
  assert.equal(store.current().instances[0].gate.reason, 'doc-new-version')
  assert.deepEqual(scheduler.claimGrants, [])
})

test('a base change during detection requeues under a maintenance lease', async (t) => {
  let store
  let snapshotCalls = 0
  const snapshot = async () => {
    snapshotCalls += 1
    if (snapshotCalls === 1) {
      await store.enqueue((next) => {
        next.instances[0].artifactVersions.push({
          id: 'av-requirements-2',
          commit: 'c'.repeat(40),
          candidateCommit: null,
          files: ['docs/requirements.md'],
          acceptedAt: at,
          source: 'gate',
          decisionId: null,
        })
        return { next }
      })
    }
    return { commit: snapshotCommit, placeholderList: [], skipped: false }
  }
  const created = await makeService(t, { snapshot, diffQuiet: async () => false })
  store = created.store
  await created.service.beginProjectChatWrite('group-1', 'check-1')
  await created.service.endProjectChatWrite('group-1', 'check-1')
  assert.equal(snapshotCalls, 2)
  assert.equal(store.current().chatWriteChecks['check-1'], undefined)
  assert.equal(store.current().projectEffects[0].status, 'consumed')
  const maintenance = store.current().maintenanceLeaseRequests
  assert.equal(maintenance.length, 1)
  assert.equal(maintenance[0].status, 'released')
  assert.equal(store.current().instances[0].artifactVersions.length, 2)
  assert.equal(store.current().instances[0].gate.reason, 'doc-new-version')
})

test('a recovered unfinished chat write completes its detection on startup', async (t) => {
  const { service, store } = await makeService(t, { diffQuiet: async () => false })
  await store.enqueue((next) => {
    next.chatWriteChecks['run-1'] = {
      groupId: 'group-1', status: 'pending-detection',
      snapshotCommit: null, baseVersions: null, failure: null,
    }
    return { next }
  })
  const context = service.projects.get('project-1')
  await context.engine.recover()
  await service.runProjectEffects('project-1')
  assert.equal(store.current().chatWriteChecks['run-1'], undefined)
  assert.equal(store.current().projectEffects[0].status, 'consumed')
  assert.equal(store.current().maintenanceLeaseRequests.length, 1)
  assert.equal(store.current().maintenanceLeaseRequests[0].status, 'released')
  assert.equal(store.current().instances[0].gate.reason, 'doc-new-version')
})

test('a permanently failing snapshot records a project block and can be retried', async (t) => {
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
