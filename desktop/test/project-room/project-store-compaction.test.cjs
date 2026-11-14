const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProjectStore, compact } = require('../../src/project-room/project-store.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')

const nowMs = Date.parse('2026-03-01T00:00:00.000Z')
const at = '2026-03-01T00:00:00.000Z'
const oldOne = '2026-01-05T00:00:00.000Z'
const oldTwo = '2026-01-20T00:00:00.000Z'
const recent = '2026-02-20T00:00:00.000Z'
const commit = 'a'.repeat(40)
const claim = { root: '/tmp/project', path: 'docs/requirements.md', mode: 'exclusive' }

function byteSize(state) {
  return Buffer.byteLength(`${JSON.stringify(state)}\n`, 'utf8')
}

function instanceEffect(id, status) {
  return {
    id,
    type: 'snapshot',
    category: 'required',
    status,
    epoch: 1,
    params: {},
    result: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  }
}

function projectEffect(id, status) {
  return {
    id,
    type: 'append-message',
    category: 'required',
    status,
    params: {},
    result: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  }
}

function lease(id, status) {
  return {
    id,
    holder: { kind: 'checkpoint-scope', projectId: 'project-1', ownerId: 'cp-1' },
    chainEffectId: `${id}-chain`,
    claims: [claim],
    epoch: 1,
    requestedAt: at,
    status,
    grantedAt: status === 'granted' || status === 'releasing' ? at : null,
    releasedAt: status === 'released' ? at : null,
  }
}

function decision(index) {
  return {
    gateId: `gate-${index}`,
    gateRevision: 1,
    reason: 'hard-gate-passed',
    outcome: 'accept',
    comment: '',
    candidateCommit: commit,
    upstreamCheckpointId: null,
    impactHash: null,
    driftChoice: null,
    commitToGit: false,
    decidedAt: at,
  }
}

function round(number, verdict) {
  return {
    round: number,
    candidate: commit,
    rebuttal: false,
    bodyChanged: true,
    startedAt: at,
    reviews: [{
      seatId: 'seat-1',
      verdict,
      reviewFile: `meldwork/reviews/requirements/r${number}-seat-1.md`,
      finishedAt: at,
    }],
  }
}

function gateMetric(id, decidedAt, outcome, overrides = {}) {
  return {
    gateId: id,
    checkpointId: 'cp-1',
    reason: 'needs-human',
    outcome,
    gateCreatedAt: decidedAt,
    decidedAt,
    durationMs: 100,
    requestedChangesAfterPass: false,
    acceptedAsIs: false,
    ...overrides,
  }
}

function fullState() {
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.seats = [{
    id: 'seat-1',
    roleName: 'Lead',
    duty: 'Write.',
    agentKind: 'codex',
    capabilities: ['read'],
    checkpointRoles: [{ checkpointKey: 'requirements', role: 'lead' }],
    profileVersionId: 'profile-1',
  }]
  state.config.profiles = [{
    id: 'profile-1',
    seatId: 'seat-1',
    version: 1,
    text: 'Profile text.',
    createdAt: at,
    source: 'default',
  }]
  state.instances = [{
    id: 'cp-1',
    checkpointKey: 'requirements',
    state: 'gate',
    seq: 10,
    epoch: 1,
    round: 8,
    roundsSinceHuman: 8,
    continuations: 0,
    sessionGeneration: 1,
    candidate: commit,
    rounds: [
      round(1, 'pass'), round(2, 'revise'), round(3, 'pass'),
      round(4, 'pass'), round(5, 'pass'), round(6, 'revise'),
      round(7, 'pass'), round(8, 'pass'),
    ],
    roundsSummary: [],
    leaseRequests: [
      lease('lease-waiting', 'waiting'),
      lease('lease-granted', 'granted'),
      lease('lease-releasing', 'releasing'),
      lease('lease-withdrawn', 'withdrawn'),
      lease('lease-released', 'released'),
    ],
    activeInvocations: [{
      effectId: 'invocation-1',
      role: 'reviewer',
      seatId: 'seat-1',
      agentKind: 'claude',
      round: 8,
      sessionGeneration: 1,
      claims: [],
      cancellationRequested: false,
      processRegistryId: null,
    }],
    pendingStart: null,
    drafts: [],
    interjections: [],
    gate: {
      id: 'gate-1',
      revision: 1,
      reason: 'needs-human',
      candidateCommit: commit,
      createdAt: at,
      firstScreen: {
        round: 8,
        elapsedMs: 1000,
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
    blockedOn: null,
    effects: [
      ...Array.from({ length: 30 }, (_, index) => instanceEffect(`effect-${index}`, 'consumed')),
      instanceEffect('effect-pending', 'pending'),
      instanceEffect('effect-started', 'started'),
      instanceEffect('effect-failed', 'failed'),
    ],
    artifactVersions: [],
    readVersions: {},
    decisions: Array.from({ length: 60 }, (_, index) => decision(index)),
  }]
  state.driftItems = [
    {
      id: 'drift-unresolved', revision: 1, path: 'docs/a.md', checkpointId: 'cp-1',
      baseVersionId: null, acceptedCommit: commit, observedCommit: commit,
      foundAt: at, source: 'drift-check', status: 'unresolved', resolvedAt: null,
    },
    {
      id: 'drift-resolving', revision: 1, path: 'docs/b.md', checkpointId: 'cp-1',
      baseVersionId: null, acceptedCommit: commit, observedCommit: commit,
      foundAt: at, source: 'drift-check', status: 'resolving', resolvedAt: null,
    },
    {
      id: 'drift-resolved', revision: 1, path: 'docs/c.md', checkpointId: 'cp-1',
      baseVersionId: null, acceptedCommit: commit, observedCommit: commit,
      foundAt: at, source: 'drift-check', status: 'resolved', resolvedAt: at,
    },
    {
      id: 'drift-voided', revision: 1, path: 'docs/d.md', checkpointId: 'cp-1',
      baseVersionId: null, acceptedCommit: commit, observedCommit: commit,
      foundAt: at, source: 'drift-check', status: 'voided', resolvedAt: at,
    },
  ]
  state.outOfScopeItems = [
    {
      id: 'scope-unresolved', path: 'src/a.js', attribution: 'uncertain', effectId: null,
      overlappingEffectIds: [], detectedAt: at, status: 'unresolved', resolvedAt: null,
    },
    {
      id: 'scope-resolved', path: 'src/b.js', attribution: 'attributed', effectId: 'effect-1',
      overlappingEffectIds: [], detectedAt: at, status: 'resolved', resolvedAt: at,
    },
  ]
  state.metrics = {
    gateDecisions: [
      gateMetric('metric-old-1', oldOne, 'continue', { durationMs: 100 }),
      gateMetric('metric-old-2', oldTwo, 'accept', {
        durationMs: 200, requestedChangesAfterPass: true, acceptedAsIs: true,
      }),
      gateMetric('metric-recent', recent, 'reject-upstream', { durationMs: 300 }),
    ],
    gateDecisionMonths: [],
    reopenings: [
      { checkpointId: 'cp-1', source: 'reopen', reason: 'Old reason.', at: '2026-01-10T00:00:00.000Z' },
      { checkpointId: 'cp-1', source: 'reject', reason: 'Recent reason.', at: recent },
    ],
    reopeningMonths: [],
    finalReviewFindings: [{ id: 'finding-1', checkpointId: 'cp-1', text: 'Keep me.', createdAt: at }],
  }
  state.projectEffects = [
    ...Array.from({ length: 30 }, (_, index) => projectEffect(`project-effect-${index}`, 'consumed')),
    projectEffect('project-effect-pending', 'pending'),
  ]
  state.maintenanceLeaseRequests = [
    lease('maintenance-waiting', 'waiting'),
    lease('maintenance-withdrawn', 'withdrawn'),
    lease('maintenance-released', 'released'),
  ]
  state.placeholders = [{
    path: 'assets/video.bin',
    reason: 'oversize',
    mode: '100644',
    size: 104857600,
    sha256: 'b'.repeat(64),
    device: 1,
    inode: 2,
    mtimeMs: 1000,
    ctimeMs: 1000,
    recordedAt: 1000,
  }]
  return state
}

test('compaction applies the M1/M5 4.6 retention rules', () => {
  const state = fullState()
  const original = structuredClone(state)
  const compacted = compact(state, nowMs)

  assert.deepEqual(state, original, 'compact must not mutate its input')
  assert.ok(byteSize(compacted) < byteSize(state), 'compaction must reduce the serialized size')

  const instance = compacted.instances[0]
  assert.deepEqual(instance.rounds.map(item => item.round), [4, 5, 6, 7, 8])
  assert.deepEqual(instance.roundsSummary, [{
    from: 1,
    to: 3,
    verdicts: { pass: 2, revise: 1, 'needs-human': 0, missing: 0, failed: 0, cancelled: 0 },
  }])
  assert.deepEqual(instance.decisions.map(item => item.gateId),
    Array.from({ length: 50 }, (_, index) => `gate-${index + 10}`))
  assert.deepEqual(instance.leaseRequests.map(item => item.status), ['waiting', 'granted', 'releasing'])
  assert.deepEqual(
    instance.effects.filter(item => item.status === 'consumed').map(item => item.id),
    Array.from({ length: 20 }, (_, index) => `effect-${index + 10}`),
  )
  assert.deepEqual(
    instance.effects.filter(item => item.status !== 'consumed').map(item => item.id),
    ['effect-pending', 'effect-started', 'effect-failed'],
  )

  assert.deepEqual(compacted.driftItems.map(item => item.status), ['unresolved', 'resolving'])
  assert.deepEqual(compacted.outOfScopeItems.map(item => item.status), ['unresolved'])
  assert.deepEqual(
    compacted.projectEffects.filter(item => item.status === 'consumed').map(item => item.id),
    Array.from({ length: 20 }, (_, index) => `project-effect-${index + 10}`),
  )
  assert.equal(compacted.projectEffects.find(item => item.id === 'project-effect-pending').status, 'pending')
  assert.deepEqual(compacted.maintenanceLeaseRequests.map(item => item.status), ['waiting'])

  assert.deepEqual(compacted.metrics.gateDecisions.map(item => item.gateId), ['metric-recent'])
  assert.deepEqual(compacted.metrics.gateDecisionMonths, [{
    month: '2026-01',
    count: 2,
    outcomes: { continue: 1, accept: 1, 'reject-upstream': 0 },
    durationMs: 300,
    requestedChangesAfterPass: 1,
    acceptedAsIs: 1,
  }])
  assert.deepEqual(compacted.metrics.reopenings.map(item => item.reason), ['Recent reason.'])
  assert.deepEqual(compacted.metrics.reopeningMonths, [{ month: '2026-01', count: 1 }])
  assert.deepEqual(compacted.metrics.finalReviewFindings, state.metrics.finalReviewFindings)
})

test('compaction never removes active records', () => {
  const state = fullState()
  const compacted = compact(state, nowMs)
  const instance = compacted.instances[0]
  assert.equal(instance.activeInvocations.length, 1)
  assert.equal(instance.gate.id, 'gate-1')
  assert.equal(compacted.config.seats.length, 1)
  assert.equal(compacted.config.profiles.length, 1)
  assert.equal(compacted.placeholders.length, 1)
  assert.equal(instance.effects.filter(item => item.status === 'pending').length, 1)
  assert.equal(instance.effects.filter(item => item.status === 'started').length, 1)
  assert.equal(instance.effects.filter(item => item.status === 'failed').length, 1)
  assert.equal(compacted.driftItems.filter(item => item.status === 'unresolved').length, 1)
  assert.equal(compacted.driftItems.filter(item => item.status === 'resolving').length, 1)
  assert.equal(compacted.outOfScopeItems.filter(item => item.status === 'unresolved').length, 1)
  assert.deepEqual(
    instance.leaseRequests.filter(item => !['withdrawn', 'released'].includes(item.status))
      .map(item => item.status),
    ['waiting', 'granted', 'releasing'],
  )
})

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-project-compaction-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function writeState(directory, state) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'state.json'), `${JSON.stringify(state)}\n`)
}

test('compactNow commits the compacted state through the project queue', async (t) => {
  const directory = fixture(t)
  const state = fullState()
  writeState(directory, state)
  const store = new ProjectStore({
    projectDir: directory,
    now: () => at,
  })
  await store.load()

  const result = await store.compactNow()
  assert.equal(result.durable, true)
  assert.equal(result.revision, 1)
  assert.equal(store.current().instances[0].rounds.length, 5)
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'))
  assert.equal(saved.revision, 1)
  assert.equal(saved.instances[0].rounds.length, 5)
  assert.equal(saved.instances[0].decisions.length, 50)
})

test('automatic compaction lets an over-limit regular write fit', async (t) => {
  const directory = fixture(t)
  const state = fullState()
  const compacted = compact(state, nowMs)
  const regularLimit = byteSize(compacted) + 50
  const controlLimit = byteSize(state) + 1000
  assert.ok(byteSize(state) > regularLimit)
  assert.ok(byteSize(compacted) <= regularLimit)
  writeState(directory, state)
  const store = new ProjectStore({
    projectDir: directory,
    now: () => at,
    limits: { regular: regularLimit, control: controlLimit },
  })
  await store.load()

  const result = await store.enqueue(next => ({ next }))
  assert.equal(result.durable, true)
  assert.equal(result.revision, 1)
  assert.equal(store.current().instances[0].rounds.length, 5)
  assert.equal(store.current().instances[0].decisions.length, 50)
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'))
  assert.equal(saved.instances[0].rounds.length, 5)
})
