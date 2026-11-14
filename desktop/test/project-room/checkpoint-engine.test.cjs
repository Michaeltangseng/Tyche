const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CheckpointEngine, detectionEffectId } = require('../../src/project-room/checkpoint-engine.cjs')
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
    'append-timeline': async () => null,
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

async function engineFixture(t, state, options = {}) {
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
    ...options.engineOptions,
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
  assert.equal(current.gate.firstScreen.round, 1)
  assert.equal(current.gate.firstScreen.reviewSummaries.length, 1)
  assert.equal(current.gate.firstScreen.reviewSummaries[0].seatId, 'seat-reviewer')
  assert.equal(current.gate.firstScreen.reviewSummaries[0].verdict, 'pass')
  assert.deepEqual(current.gate.firstScreen.changedFiles, [])
})

test('UPSTREAM_BLOCKERS_CHANGED refreshes the gate screen without changing the gate', async (t) => {
  const state = baseState()
  state.config.playbook.checkpointDefs.push(definition({
    key: 'research',
    name: 'Research',
    targetFiles: ['docs/research.md'],
  }))
  const upstream = instance('accepted', {
    id: 'cp-research',
    checkpointKey: 'research',
    artifactVersions: [{
      id: 'av-research',
      commit,
      candidateCommit: null,
      files: ['docs/research.md'],
      acceptedAt: at,
      source: 'gate',
      decisionId: null,
    }],
  })
  const current = instance('gate', {
    readVersions: { 'cp-research': 'av-research' },
    gate: {
      id: 'gate-1',
      revision: 1,
      reason: 'needs-human',
      candidateCommit: commit,
      createdAt: at,
      firstScreen: {
        round: 1,
        elapsedMs: 0,
        signals: [],
        reviewSummaries: [],
        changedFiles: [],
        softGateSummary: [],
        driftItemIds: [],
        outOfScopeItemIds: [],
        blockerCheckpointIds: [],
        changesHeaderMissing: false,
        detectionSkipped: false,
        candidateDiverged: false,
      },
    },
  })
  state.instances = [upstream, current]
  state.driftItems = [{
    id: 'drift-1',
    revision: 1,
    path: 'docs/research.md',
    checkpointId: 'cp-research',
    baseVersionId: null,
    acceptedCommit: commit,
    observedCommit: commit,
    foundAt: at,
    source: 'drift-check',
    status: 'unresolved',
    resolvedAt: null,
  }]
  const { store, engine } = await engineFixture(t, state)
  await engine.dispatch('cp-1', { type: 'UPSTREAM_BLOCKERS_CHANGED', at })

  const gate = store.current().instances.find(item => item.id === 'cp-1').gate
  assert.equal(gate.id, 'gate-1')
  assert.equal(gate.revision, 1)
  assert.ok(gate.firstScreen.signals.some(signal => signal.kind === 'upstream-drift'))
  assert.deepEqual(gate.firstScreen.blockerCheckpointIds, ['cp-research'])
})

test('a dirty drift check persists unresolved drift items with the gate', async (t) => {
  const state = baseState()
  state.instances = [instance('pending')]
  const directory = fixture(t)
  const store = new ProjectStore({ projectDir: directory, now: () => at })
  fs.writeFileSync(path.join(directory, 'state.json'), `${JSON.stringify(state)}\n`)
  await store.load()
  const engine = new CheckpointEngine({
    projectId: 'project-1',
    store,
    scheduler: fakeScheduler(),
    handlers: {
      ...handlers(),
      'drift-check': async () => ({
        clean: false,
        drifted: ['docs/requirements.md'],
        snapshotCommit: commit,
      }),
    },
    invoke: invocation('pass'),
    workdir: '/tmp/project',
    now: () => at,
  })

  await engine.dispatch('cp-1', { type: 'DEPS_READY', at })
  await engine.runUntilIdle()

  const current = store.current()
  assert.equal(current.instances[0].state, 'gate')
  assert.equal(current.instances[0].gate.reason, 'drift')
  assert.equal(current.driftItems.length, 1)
  assert.deepEqual({
    path: current.driftItems[0].path,
    source: current.driftItems[0].source,
    status: current.driftItems[0].status,
    observedCommit: current.driftItems[0].observedCommit,
  }, {
    path: 'docs/requirements.md',
    source: 'drift-check',
    status: 'unresolved',
    observedCommit: commit,
  })
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

test('a writable call records its time window and out-of-scope changes', async (t) => {
  const state = baseState()
  state.instances = [instance('pending')]
  const directory = fixture(t)
  const store = new ProjectStore({ projectDir: directory, now: () => at })
  fs.writeFileSync(path.join(directory, 'state.json'), `${JSON.stringify(state)}\n`)
  await store.load()
  const shadowRepo = {
    async snapshot({ effectId }) {
      return {
        commit: effectId.endsWith(':before') ? 'b'.repeat(40) : 'c'.repeat(40),
        skipped: false,
        placeholderList: [],
      }
    },
    async nameStatus() {
      return [{ status: 'M', path: 'src/out-of-scope.js' }]
    },
  }
  const engine = new CheckpointEngine({
    projectId: 'project-1',
    store,
    scheduler: fakeScheduler(),
    handlers: handlers(),
    invoke: invocation('pass'),
    workdir: '/tmp/project',
    shadowRepo,
    snapshotLimits: {},
    now: () => at,
  })
  await engine.dispatch('cp-1', { type: 'DEPS_READY', at })
  await engine.runUntilIdle()

  const current = store.current()
  const window = current.callWindows[0]
  assert.ok(window, 'call window recorded')
  assert.equal(window.skipped, false)
  assert.equal(current.outOfScopeItems.length, 1)
  assert.deepEqual({
    path: current.outOfScopeItems[0].path,
    attribution: current.outOfScopeItems[0].attribution,
    status: current.outOfScopeItems[0].status,
  }, {
    path: 'src/out-of-scope.js',
    attribution: 'unattributed',
    status: 'unresolved',
  })
})

test('the engine stages invocation answers and appends them as messages', async (t) => {
  const state = baseState()
  state.instances = [instance('leading', {
    activeInvocations: [{
      effectId: 'invoke-lead', role: 'lead', seatId: 'seat-lead', agentKind: 'codex',
      round: 0, sessionGeneration: 0, claims: [], cancellationRequested: false,
      processRegistryId: null,
    }],
    effects: [effect('invoke-lead', 'invoke-lead', {
      category: 'invocation', params: { seatId: 'seat-lead', round: 0, sessionGeneration: 0 },
    })],
  })]
  const staged = []
  const { store, engine } = await engineFixture(t, state, {
    engineOptions: {
      invoke: async ({ effect: value, round, sessionGeneration }) => ({
        role: 'lead',
        seatId: 'seat-lead',
        round: value.params?.round ?? round ?? 0,
        sessionGeneration: value.params?.sessionGeneration ?? sessionGeneration ?? 0,
        marker: value.type === 'invoke-reviewer' ? 'pass' : 'ready',
        ...(value.type === 'invoke-lead' ? {
          pendingMessage: {
            sourceKey: ['project-1', 'invoke', value.id],
            body: 'Answer',
            metadata: { id: 'message-1', groupId: 'group-1', role: 'agent', agentKind: 'codex' },
          },
        } : {}),
      }),
      stageMessage: async (input) => {
        staged.push(input)
        return { ref: 'pending-ref' }
      },
      handlers: {
        ...handlers(),
        'append-message': async () => null,
      },
    },
  })
  await engine.runUntilIdle()
  assert.equal(staged.length, 1)
  assert.equal(staged[0].body, 'Answer')
  const current = store.current().instances[0]
  assert.notEqual(current.state, 'leading')
  const append = current.effects.find(item => item.type === 'append-message')
  assert.equal(append.status, 'consumed')
  assert.equal(append.params.ref, 'pending-ref')
})

test('a detection barrier turns a soft pass into a hard gate', async (t) => {
  const state = baseState()
  state.config.playbook.checkpointDefs[0].gate = 'soft'
  state.instances = [instance('pending')]
  state.chatWriteChecks = {
    'run-1': {
      groupId: 'group-1', status: 'running', snapshotCommit: null,
      baseVersions: null, failure: null,
    },
  }
  const { store, engine } = await engineFixture(t, state, {
    engineOptions: {
      softBlockers: projectState => (
        Object.keys(projectState.chatWriteChecks || {}).length ? { detection: true } : {}
      ),
    },
  })
  await engine.dispatch('cp-1', { type: 'DEPS_READY', at })
  await engine.runUntilIdle()
  const current = store.current().instances[0]
  assert.equal(current.state, 'gate')
  assert.equal(current.gate.reason, 'hard-gate-passed')
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

test('recovery persists supplementary detection for unfinished chat write checks', async (t) => {
  const state = baseState()
  state.chatWriteChecks = {
    'run-1': {
      groupId: 'group-1', status: 'pending-detection',
      snapshotCommit: null, baseVersions: null, failure: 'SHADOW_SNAPSHOT_FAILED',
    },
    'run-2': {
      groupId: 'group-1', status: 'pending-detection',
      snapshotCommit: commit,
      baseVersions: [{ checkpointId: 'cp-1', artifactVersionId: 'av-1', instanceEpoch: 1 }],
      failure: null,
    },
    'run-3': {
      groupId: 'group-1', status: 'running',
      snapshotCommit: null, baseVersions: null, failure: null,
    },
  }
  state.projectEffects = [{
    id: 'detect-existing', type: 'detect-accepted-changes', category: 'required',
    status: 'pending', params: { checkId: 'run-3' }, result: null, error: null,
    startedAt: null, finishedAt: null,
  }]
  state.maintenanceLeaseRequests = [{
    id: 'maintenance-old',
    holder: { kind: 'project-maintenance', projectId: 'project-1', ownerId: 'maintenance-old' },
    chainEffectId: 'detect-old',
    claims: [{ root: '/tmp/project', path: '', mode: 'exclusive' }],
    epoch: 0, requestedAt: at, status: 'waiting', grantedAt: null, releasedAt: null,
  }]
  const { store, scheduler, engine } = await engineFixture(t, state)
  await engine.recover()
  const current = store.current()
  assert.equal(current.maintenanceLeaseRequests[0].status, 'released')
  assert.ok(scheduler.withdrawn.includes('maintenance-old'))
  assert.deepEqual(Object.keys(current.chatWriteChecks).sort(), ['run-1', 'run-2', 'run-3'])
  const detections = current.projectEffects.filter(effect => (
    effect.type === 'detect-accepted-changes'
  ))
  assert.equal(detections.length, 3)
  const first = detections.find(effect => effect.params.checkId === 'run-1')
  assert.equal(first.id, detectionEffectId('project-1', 'run-1'))
  assert.equal(first.params.snapshotCommit, null)
  assert.equal(first.params.baseVersions, null)
  assert.equal(first.params.failure, 'SHADOW_SNAPSHOT_FAILED')
  const second = detections.find(effect => effect.params.checkId === 'run-2')
  assert.equal(second.id, detectionEffectId('project-1', 'run-2'))
  assert.equal(second.params.snapshotCommit, commit)
  assert.equal(second.params.baseVersions.length, 1)
  assert.equal(detections.filter(effect => effect.params.checkId === 'run-3').length, 1)
})

test('recovery leaves failed detections for retry instead of duplicating them', async (t) => {
  const state = baseState()
  state.chatWriteChecks = {
    'run-1': {
      groupId: 'group-1', status: 'pending-detection',
      snapshotCommit: null, baseVersions: null, failure: 'EIO',
    },
  }
  state.projectEffects = [{
    id: detectionEffectId('project-1', 'run-1'),
    type: 'detect-accepted-changes', category: 'required',
    status: 'failed', params: { checkId: 'run-1' }, result: null, error: 'EIO',
    startedAt: null, finishedAt: at,
  }]
  const { store, engine } = await engineFixture(t, state)
  await engine.recover()
  const current = store.current()
  assert.equal(current.projectEffects.length, 1)
  assert.equal(current.projectEffects[0].status, 'failed')
  assert.ok(current.chatWriteChecks['run-1'])
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
