const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CheckpointEngine } = require('../../src/project-room/checkpoint-engine.cjs')
const { ProjectStore } = require('../../src/project-room/project-store.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T00:00:00.000Z'
const commit = 'a'.repeat(40)

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-engine-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function definition(overrides = {}) {
  return {
    key: 'requirements',
    name: 'Requirements',
    type: 'document',
    targetFiles: ['docs/requirements.md'],
    leadSeatId: 'seat-lead',
    reviewerSeatIds: ['seat-reviewer'],
    draftSeatIds: [],
    gate: 'hard',
    roundLimit: 3,
    continuationLimit: 3,
    producesChecklist: false,
    dependsOn: [],
    ...overrides,
  }
}

function baseState() {
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.seats = [
    {
      id: 'seat-lead', roleName: 'Lead', duty: 'Write.', agentKind: 'codex',
      capabilities: ['read'], checkpointRoles: [], profileVersionId: 'profile-1',
    },
    {
      id: 'seat-reviewer', roleName: 'Reviewer', duty: 'Review.', agentKind: 'claude',
      capabilities: ['read'], checkpointRoles: [], profileVersionId: 'profile-2',
    },
  ]
  state.config.profiles = [
    { id: 'profile-1', seatId: 'seat-lead', version: 1, text: '', createdAt: at, source: 'default' },
    { id: 'profile-2', seatId: 'seat-reviewer', version: 1, text: '', createdAt: at, source: 'default' },
  ]
  state.config.playbook.checkpointDefs = [definition()]
  return state
}

function instance(state, overrides = {}) {
  return {
    id: 'cp-1',
    checkpointKey: 'requirements',
    state,
    seq: 0,
    epoch: 0,
    round: 0,
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
    artifactVersions: [],
    readVersions: {},
    decisions: [],
    ...overrides,
  }
}

function effect(id, type, overrides = {}) {
  return {
    id,
    type,
    category: overrides.category || 'required',
    status: overrides.status || 'pending',
    epoch: overrides.epoch ?? 0,
    params: overrides.params || {},
    result: null,
    error: null,
    startedAt: overrides.startedAt ?? null,
    finishedAt: null,
  }
}

function fakeScheduler() {
  const grants = []
  const queue = []
  const withdrawn = []
  const released = []
  return {
    grants,
    queue,
    withdrawn,
    released,
    request({ requestId, holder, claims, onGranted }) {
      const entry = { requestId, holder, claims }
      grants.push(entry)
      onGranted?.(requestId)
    },
    release(requestId) {
      released.push(requestId)
      const index = grants.findIndex(entry => entry.requestId === requestId)
      if (index >= 0) grants.splice(index, 1)
    },
    withdraw(requestId) {
      withdrawn.push(requestId)
      const index = grants.findIndex(entry => entry.requestId === requestId)
      if (index >= 0) grants.splice(index, 1)
      const queued = queue.findIndex(entry => entry.requestId === requestId)
      if (queued >= 0) queue.splice(queued, 1)
    },
    restoreGranted(requests) {
      for (const request of requests) {
        grants.push({ requestId: request.requestId, holder: request.holder, claims: request.claims })
      }
    },
    snapshot() {
      return { claimGrants: [...grants], claimQueue: [...queue] }
    },
  }
}

function handlers() {
  return {
    'drift-check': async () => ({ clean: true }),
    snapshot: async () => ({ commit }),
    'evaluate-submission': async () => ({
      bodyChanged: true,
      newResponse: false,
      manifestValid: true,
    }),
    'verify-candidate': async () => ({ intact: true }),
    'write-review-file': async () => null,
    'accept-commit': async () => ({ commit }),
  }
}

function invocation(marker) {
  return async ({ effect: value, round, sessionGeneration }) => ({
    role: value.type === 'invoke-reviewer' ? 'reviewer' : 'lead',
    seatId: value.type === 'invoke-reviewer' ? 'seat-reviewer' : 'seat-lead',
    round: value.params?.round ?? round ?? 0,
    sessionGeneration: value.params?.sessionGeneration ?? sessionGeneration ?? 0,
    marker: value.type === 'invoke-reviewer' ? marker : 'ready',
  })
}

async function engineFixture(t, state) {
  const directory = fixture(t)
  const store = new ProjectStore({ projectDir: directory, now: () => at })
  fs.writeFileSync(path.join(directory, 'state.json'), `${JSON.stringify(state)}\n`)
  await store.load()
  const scheduler = fakeScheduler()
  const engine = new CheckpointEngine({
    projectId: 'project-1',
    store,
    scheduler,
    handlers: handlers(),
    invoke: invocation('pass'),
    workdir: '/tmp/project',
    now: () => at,
  })
  return { store, scheduler, engine, directory }
}

test('the engine drives a checkpoint from pending to a hard gate', async (t) => {
  const state = baseState()
  state.instances = [instance('pending')]
  const { store, scheduler, engine } = await engineFixture(t, state)

  await engine.dispatch('cp-1', { type: 'DEPS_READY', at })
  await engine.runUntilIdle()

  const current = store.current().instances[0]
  assert.equal(current.state, 'gate')
  assert.equal(current.gate.reason, 'hard-gate-passed')
  assert.ok(current.rounds.length > 0)
  assert.ok(current.effects.every(effect => ['consumed', 'voided', 'failed'].includes(effect.status)))
  assert.deepEqual(scheduler.grants, [])
  assert.equal(scheduler.released.length > 0, true)
})

test('an acquire-scope request waits for LEASE_GRANTED before continuing', async (t) => {
  const state = baseState()
  state.instances = [instance('pending')]
  const { store, engine, scheduler } = await engineFixture(t, state)
  const queued = []
  scheduler.request = ({ requestId, holder, claims, onGranted }) => {
    queued.push({ requestId, holder, claims, onGranted })
  }
  await engine.dispatch('cp-1', { type: 'DEPS_READY', at })
  await engine.runUntilIdle()

  const current = store.current().instances[0]
  assert.equal(current.state, 'leading')
  assert.ok(current.effects.some(effect => effect.type === 'acquire-scope' && effect.status === 'pending'))
  assert.equal(queued.length, 1)
  assert.equal(current.effects.some(effect => effect.type === 'snapshot' && effect.status === 'pending'), true)

  scheduler.snapshot = () => ({ claimGrants: [{ requestId: queued[0].requestId }], claimQueue: [] })
  queued[0].onGranted(queued[0].requestId)
  await engine.runUntilIdle()
  const after = store.current().instances[0]
  assert.equal(after.effects.some(effect => effect.type === 'acquire-scope' && effect.status === 'consumed'), true)
})

test('recovery turns an interrupted writable call into a recovery gate', async (t) => {
  const state = baseState()
  state.instances = [instance('leading', {
    epoch: 1,
    activeInvocations: [{
      effectId: 'invoke-started',
      role: 'lead',
      seatId: 'seat-lead',
      agentKind: 'codex',
      round: 1,
      sessionGeneration: 0,
      claims: [],
      cancellationRequested: false,
      processRegistryId: null,
    }],
    effects: [effect('invoke-started', 'invoke-lead', {
      category: 'invocation', status: 'started', epoch: 1,
    })],
  })]
  const { store, engine } = await engineFixture(t, state)
  await engine.recover()
  const current = store.current().instances[0]
  assert.equal(current.state, 'gate')
  assert.equal(current.gate.reason, 'recovery')
  assert.deepEqual(current.activeInvocations, [])
  assert.equal(current.effects[0].status, 'consumed')
})

test('recovery replays read-only calls, voids expired effects, and resets drift', async (t) => {
  const state = baseState()
  state.instances = [instance('reviewing', {
    epoch: 2,
    round: 1,
    rounds: [{
      round: 1, candidate: commit, rebuttal: false, bodyChanged: true,
      startedAt: at, reviews: [],
    }],
    activeInvocations: [{
      effectId: 'invoke-review',
      role: 'reviewer',
      seatId: 'seat-reviewer',
      agentKind: 'claude',
      round: 1,
      sessionGeneration: 0,
      claims: [],
      cancellationRequested: false,
      processRegistryId: null,
    }],
    effects: [
      effect('invoke-review', 'invoke-reviewer', {
        category: 'invocation', status: 'started', epoch: 2,
      }),
      effect('expired-snapshot', 'snapshot', { epoch: 1 }),
    ],
  })]
  state.driftItems = [{
    id: 'drift-1', revision: 1, path: 'docs/requirements.md', checkpointId: 'cp-1',
    baseVersionId: null, acceptedCommit: commit, observedCommit: commit,
    foundAt: at, source: 'drift-check', status: 'resolving', resolvedAt: null,
  }]
  const { store, engine } = await engineFixture(t, state)
  await engine.recover()
  const current = store.current()
  assert.equal(current.driftItems[0].status, 'unresolved')
  assert.equal(current.instances[0].effects.find(item => item.id === 'expired-snapshot').status, 'voided')
  assert.equal(current.instances[0].effects.find(item => item.id === 'invoke-review').status, 'consumed')
  assert.equal(current.instances[0].rounds[0].reviews.length, 1)
})

test('recovery restores granted leases and requeues waiting requests', async (t) => {
  const request = {
    id: 'lease-1',
    holder: { kind: 'checkpoint-scope', projectId: 'project-1', ownerId: 'cp-1' },
    chainEffectId: 'lease-1',
    claims: [{ root: '/tmp/project', path: 'docs/requirements.md', mode: 'exclusive' }],
    epoch: 0,
    requestedAt: at,
    status: 'granted',
    grantedAt: at,
    releasedAt: null,
  }
  const waiting = { ...request, id: 'lease-2', status: 'waiting', grantedAt: null }
  const state = baseState()
  state.instances = [instance('leading', { leaseRequests: [request, waiting] })]
  const { scheduler, engine } = await engineFixture(t, state)
  await engine.recover()
  assert.ok(scheduler.grants.some(entry => entry.requestId === 'lease-1'))
})

test('beginDraining voids business effects, abandons leases, and cancels calls', () => {
  const state = baseState()
  state.instances = [instance('leading', {
    activeInvocations: [{
      effectId: 'invoke-lead',
      role: 'lead',
      seatId: 'seat-lead',
      agentKind: 'codex',
      round: 1,
      sessionGeneration: 0,
      claims: [],
      cancellationRequested: false,
      processRegistryId: null,
    }],
    leaseRequests: [
      {
        id: 'waiting', holder: { kind: 'checkpoint-scope', projectId: 'project-1', ownerId: 'cp-1' },
        chainEffectId: 'waiting', claims: [], epoch: 0, requestedAt: at,
        status: 'waiting', grantedAt: null, releasedAt: null,
      },
      {
        id: 'granted', holder: { kind: 'checkpoint-scope', projectId: 'project-1', ownerId: 'cp-1' },
        chainEffectId: 'granted', claims: [], epoch: 0, requestedAt: at,
        status: 'granted', grantedAt: at, releasedAt: null,
      },
    ],
    effects: [
      effect('business', 'snapshot'),
      effect('cleanup', 'release-scope', { category: 'cleanup' }),
    ],
  })]
  state.projectEffects = [{
    id: 'detect', type: 'detect-accepted-changes', category: 'required',
    status: 'pending', params: {}, result: null, error: null, startedAt: null, finishedAt: null,
  }]
  const engine = new CheckpointEngine({
    projectId: 'project-1',
    store: { current: () => state, enqueue: async () => {} },
    scheduler: fakeScheduler(),
    workdir: '/tmp/project',
  })
  const next = engine.beginDraining(state)
  const instanceValue = next.instances[0]
  assert.equal(instanceValue.epoch, 1)
  assert.equal(instanceValue.activeInvocations[0].cancellationRequested, true)
  assert.ok(instanceValue.effects.some(effect => effect.type === 'cancel-invocation'))
  assert.equal(instanceValue.effects.find(effect => effect.id === 'business').status, 'voided')
  assert.equal(instanceValue.effects.find(effect => effect.id === 'cleanup').status, 'pending')
  assert.equal(instanceValue.leaseRequests.find(item => item.id === 'waiting').status, 'withdrawn')
  assert.equal(instanceValue.leaseRequests.find(item => item.id === 'granted').status, 'releasing')
  assert.equal(next.projectEffects[0].status, 'voided')
  assert.equal(next.deletion.phase, 'draining')
  assert.equal(engine.isDrained(next), false)
  assert.equal(engine.isDrained({
    ...next,
    instances: next.instances.map(item => ({
      ...item,
      activeInvocations: [],
      effects: item.effects.map(effect => ({ ...effect, status: 'voided' })),
      leaseRequests: item.leaseRequests.map(lease => ({ ...lease, status: 'released' })),
    })),
    projectEffects: next.projectEffects.map(effect => ({ ...effect, status: 'voided' })),
  }), true)
})
