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
const commit = 'a'.repeat(40)

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

function gate(reason, candidateCommit = commit) {
  return {
    id: `gate-${reason}`,
    revision: 2,
    reason,
    candidateCommit,
    createdAt: at,
    firstScreen: {
      round: 1, elapsedMs: 1000, signals: [], reviewSummaries: [], changedFiles: [],
      softGateSummary: [], driftItemIds: [], outOfScopeItemIds: [], blockerCheckpointIds: [],
      changesHeaderMissing: false, detectionSkipped: false, candidateDiverged: false,
    },
  }
}

function instance(state, overrides = {}) {
  return {
    id: 'cp-1',
    checkpointKey: 'requirements',
    state,
    seq: 1,
    epoch: 0,
    round: 1,
    roundsSinceHuman: 1,
    continuations: 0,
    sessionGeneration: 0,
    candidate: commit,
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

async function makeService(t, state, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-flows-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new ProjectStore({ projectDir: directory, now: () => at })
  fs.writeFileSync(path.join(directory, 'state.json'), `${JSON.stringify(state)}\n`)
  await store.load()
  const scheduler = options.scheduler || {
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
  const handlers = options.handlers || {
    'drift-check': async () => ({ clean: true }),
    snapshot: async () => ({ commit, placeholderList: [], skipped: false }),
    'evaluate-submission': async () => ({
      bodyChanged: true, newResponse: false, manifestValid: true,
    }),
    'verify-candidate': async () => ({ intact: true, differing: [] }),
    'write-review-file': async () => null,
    'accept-commit': async () => ({ commit }),
    'append-decision': async () => null,
    'stamp-changes': async () => null,
    'drop-snapshot-refs': async () => null,
    notify: async () => null,
    'append-timeline': async () => null,
  }
  const engine = new CheckpointEngine({
    projectId: 'project-1',
    store,
    scheduler,
    handlers,
    invoke: async ({ effect, round, sessionGeneration }) => ({
      role: effect.type === 'invoke-reviewer' ? 'reviewer' : 'lead',
      seatId: effect.params?.seatId || 'seat-lead',
      round: effect.params?.round ?? round ?? 1,
      sessionGeneration: effect.params?.sessionGeneration ?? sessionGeneration ?? 0,
      marker: effect.type === 'invoke-reviewer' ? 'pass' : 'ready',
    }),
    workdir: '/tmp/project',
    now: () => at,
  })
  const inserted = options.inserted || []
  const service = new ProjectService({
    workspace: {
      state: {
        projects: [],
        groups: [{ id: 'main-group', projectId: 'project-1', projectRole: 'main' }],
      },
      inserted,
      save() {},
      emitChanged() {},
      insertProjectRoomMessage(message) { this.inserted.push(message) },
    },
    privateRoot: directory,
    scheduler,
    templatesStore: {
      templates: [], get: () => null, load: async () => [], save: async () => null,
    },
    createId: (() => { let id = 0; return () => `id-${id += 1}` })(),
    now: () => at,
  })
  service.projects.set('project-1', {
    project: { id: 'project-1', workdir: '/tmp/project' },
    store,
    shadowRepo: null,
    engine,
    readOnly: false,
    readOnlyReason: '',
  })
  return { service, store, engine, scheduler, inserted }
}

function gatedState(reason, overrides = {}) {
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.playbook.checkpointDefs = [definition()]
  state.instances = [instance('gate', { gate: gate(reason), ...overrides })]
  return state
}

test('decideGate rejects stale revisions, unavailable outcomes, and missing comments first', async (t) => {
  const { service } = await makeService(t, gatedState('needs-human'))
  await assert.rejects(service.decideGate({
    projectId: 'project-1', gateId: 'gate-needs-human', gateRevision: 1, outcome: 'accept',
  }), { code: 'PROJECT_GATE_STALE' })
  await assert.rejects(service.decideGate({
    projectId: 'project-1', gateId: 'gate-needs-human', gateRevision: 2, outcome: 'accept',
    candidateCommit: 'b'.repeat(40),
  }), { code: 'PROJECT_GATE_STALE' })
  await assert.rejects(service.decideGate({
    projectId: 'project-1', gateId: 'gate-needs-human', gateRevision: 2, outcome: 'continue',
    candidateCommit: commit, comment: '   ',
  }), { code: 'PROJECT_GATE_COMMENT_REQUIRED' })

  const question = await makeService(t, gatedState('question'))
  await assert.rejects(question.service.decideGate({
    projectId: 'project-1', gateId: 'gate-question', gateRevision: 2, outcome: 'accept',
    candidateCommit: commit,
  }), { code: 'PROJECT_GATE_OUTCOME_UNAVAILABLE' })
})

test('gateDetail returns the full first screen and allowed outcomes', async (t) => {
  const state = gatedState('question')
  state.instances[0].gate.firstScreen.reviewSummaries = [{
    seatId: 'seat-reviewer',
    verdict: 'needs-human',
    summary: 'Needs a decision.',
    reviewFile: 'meldwork/reviews/requirements/r1-seat-reviewer.md',
  }]
  const { service } = await makeService(t, state)

  const detail = service.gateDetail({
    projectId: 'project-1', gateId: 'gate-question', gateRevision: 2,
  })
  assert.equal(detail.checkpointId, 'cp-1')
  assert.equal(detail.reason, 'question')
  assert.equal(detail.question, true)
  assert.deepEqual(detail.allowedOutcomes, ['continue', 'reject-upstream'])
  assert.equal(detail.firstScreen.reviewSummaries.length, 1)
  assert.equal(detail.firstScreen.reviewSummaries[0].summary, 'Needs a decision.')

  assert.throws(() => service.gateDetail({
    projectId: 'project-1', gateId: 'gate-question', gateRevision: 1,
  }), { code: 'PROJECT_GATE_STALE' })
})

test('decideGate blocks accept on upstream blockers', async (t) => {
  const state = gatedState('needs-human')
  state.chatWriteChecks = {
    'run-1': {
      groupId: 'group-1', status: 'running', snapshotCommit: null,
      baseVersions: null, failure: null,
    },
  }
  const { service } = await makeService(t, state)
  await assert.rejects(service.decideGate({
    projectId: 'project-1', gateId: 'gate-needs-human', gateRevision: 2,
    outcome: 'accept', candidateCommit: commit,
  }), (error) => {
    assert.equal(error.code, 'PROJECT_ACCEPT_BLOCKED')
    assert.equal(error.details.blockers[0].type, 'detection')
    return true
  })
})

test('decideGate accept dispatches exactly one GATE_DECIDED and reaches accepted', async (t) => {
  const { service, store, engine } = await makeService(t, gatedState('needs-human'))
  const dispatched = []
  const originalDispatch = engine.dispatch.bind(engine)
  engine.dispatch = async (checkpointId, event) => {
    dispatched.push(event.type)
    return originalDispatch(checkpointId, event)
  }
  await service.decideGate({
    projectId: 'project-1', gateId: 'gate-needs-human', gateRevision: 2,
    outcome: 'accept', candidateCommit: commit,
  })
  await engine.runUntilIdle()
  assert.equal(dispatched.filter(type => type === 'GATE_DECIDED').length, 1)
  const current = store.current().instances[0]
  assert.equal(current.state, 'accepted')
  assert.equal(current.artifactVersions.length, 1)
})

test('decideGate reject validates the upstream and impact hash', async (t) => {
  const state = gatedState('needs-human', {
    readVersions: { 'cp-interview': 'av-interview' },
  })
  state.config.playbook.checkpointDefs = [
    definition({ key: 'interview' }),
    definition({ dependsOn: ['interview'] }),
    definition({ key: 'design', dependsOn: ['requirements'] }),
  ]
  state.instances.push(instance('accepted', {
    id: 'cp-interview', checkpointKey: 'interview', state: 'accepted',
  }))
  state.instances.push(instance('accepted', {
    id: 'cp-design', checkpointKey: 'design', state: 'accepted',
  }))
  const { service, store } = await makeService(t, state)
  await assert.rejects(service.decideGate({
    projectId: 'project-1', gateId: 'gate-needs-human', gateRevision: 2,
    outcome: 'reject-upstream', candidateCommit: commit,
    upstreamCheckpointId: 'cp-missing', impactHash: 'hash',
  }), { code: 'PROJECT_IMPACT_CHANGED' })

  const preview = service.previewReject({
    projectId: 'project-1', checkpointId: 'cp-1', upstreamId: 'cp-interview',
  })
  await assert.rejects(service.decideGate({
    projectId: 'project-1', gateId: 'gate-needs-human', gateRevision: 2,
    outcome: 'reject-upstream', candidateCommit: commit,
    upstreamCheckpointId: 'cp-interview', impactHash: 'wrong',
  }), { code: 'PROJECT_IMPACT_CHANGED' })
  await service.decideGate({
    projectId: 'project-1', gateId: 'gate-needs-human', gateRevision: 2,
    outcome: 'reject-upstream', candidateCommit: commit,
    upstreamCheckpointId: 'cp-interview', impactHash: preview.impactHash,
  })
  assert.equal(store.current().instances[0].state, 'stale')
})

test('a gate opinion is stored as a project-room user message', async (t) => {
  const { service, inserted } = await makeService(t, gatedState('needs-human'))
  await service.decideGate({
    projectId: 'project-1', gateId: 'gate-needs-human', gateRevision: 2,
    outcome: 'continue', candidateCommit: commit, comment: 'Please fix the scope.',
  })
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].content, 'Please fix the scope.')
  assert.equal(inserted[0].role, 'user')
  assert.equal(inserted[0].projectRoom.gateId, 'gate-needs-human')
  assert.equal(inserted[0].projectRoom.outcome, 'continue')
})

test('start creates the first instance once and interject targets the active checkpoint', async (t) => {
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.playbook.checkpointDefs = [definition()]
  const { service, store, engine, inserted } = await makeService(t, state)
  const started = await service.startProject({ projectId: 'project-1', brief: 'Build it.' })
  assert.equal(store.current().instances.length, 1)
  assert.equal(store.current().instances[0].state, 'checking')
  await engine.runUntilIdle()
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].content, 'Build it.')
  assert.equal(inserted[0].projectRoom.start, true)
  await assert.rejects(service.startProject({ projectId: 'project-1', brief: 'Again' }), {
    code: 'PROJECT_ALREADY_STARTED',
  })

  const leading = await makeService(t, {
    ...gatedState('needs-human'),
    instances: [instance('leading', { gate: null })],
  })
  await leading.service.interject({
    projectId: 'project-1', checkpointId: 'cp-1', text: 'Consider this.',
  })
  assert.equal(leading.store.current().instances[0].interjections.length, 1)
  await assert.rejects(leading.service.interject({
    projectId: 'project-1', checkpointId: 'missing', text: 'x',
  }), { code: 'PROJECT_NOT_FOUND' })
  void started
})
