const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DEFAULT_SNAPSHOT_LIMITS,
  PROJECT_STATE_SCHEMA_VERSION,
  emptyProjectState,
  parseProjectState,
} = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T00:00:00.000Z'
const commit = 'a'.repeat(40)
const sha256 = 'b'.repeat(64)

function validState() {
  const claim = { root: '/tmp/project', path: 'docs/requirements.md', mode: 'exclusive' }
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.configRevision = 2
  state.config.seats = [{
    id: 'seat-1',
    roleName: 'Lead writer',
    duty: 'Writes the requirements document.',
    agentKind: 'codex',
    capabilities: ['read', 'write-workdir'],
    checkpointRoles: [{ checkpointKey: 'requirements', role: 'lead' }],
    profileVersionId: 'profile-1',
  }]
  state.config.profiles = [{
    id: 'profile-1',
    seatId: 'seat-1',
    version: 1,
    text: 'Care about contradictions.',
    createdAt: at,
    source: 'default',
  }]
  state.config.playbook = {
    templateId: 'builtin-default',
    templateVersion: 1,
    checkpointDefs: [{
      key: 'requirements',
      name: 'Requirements',
      type: 'document',
      targetFiles: ['docs/requirements.md'],
      leadSeatId: 'seat-1',
      reviewerSeatIds: ['seat-2'],
      draftSeatIds: [],
      gate: 'hard',
      roundLimit: 3,
      continuationLimit: 2,
      producesChecklist: false,
      dependsOn: [],
    }],
    roundLimit: 3,
    continuationLimit: 3,
  }
  state.instances = [{
    id: 'cp-1',
    checkpointKey: 'requirements',
    state: 'gate',
    seq: 5,
    epoch: 1,
    round: 1,
    roundsSinceHuman: 1,
    continuations: 0,
    sessionGeneration: 1,
    candidate: commit,
    rounds: [{
      round: 1,
      candidate: commit,
      rebuttal: false,
      bodyChanged: true,
      startedAt: at,
      reviews: [{
        seatId: 'seat-2',
        verdict: 'revise',
        reviewFile: 'meldwork/reviews/requirements/r1-seat-2.md',
        finishedAt: at,
      }],
    }],
    roundsSummary: [],
    leaseRequests: [{
      id: 'req-1',
      holder: { kind: 'checkpoint-scope', projectId: 'project-1', ownerId: 'cp-1' },
      chainEffectId: 'cp-1:5:0',
      claims: [claim],
      epoch: 1,
      requestedAt: at,
      status: 'granted',
      grantedAt: at,
      releasedAt: null,
    }],
    activeInvocations: [{
      effectId: 'cp-1:5:1',
      role: 'reviewer',
      seatId: 'seat-2',
      agentKind: 'claude',
      round: 1,
      sessionGeneration: 1,
      claims: [],
      cancellationRequested: false,
      processRegistryId: 'registry-1',
    }],
    pendingStart: {
      kind: 'invocation',
      effectId: 'cp-1:5:2',
      role: 'lead',
      seatId: 'seat-1',
      round: 1,
      sessionGeneration: 1,
      claims: [claim],
    },
    drafts: [{
      seatId: 'seat-3',
      status: 'ready',
      effectId: 'cp-1:5:3',
      sessionGeneration: 1,
    }],
    interjections: [{
      id: 'interjection-1',
      content: 'Please keep the scope small.',
      status: 'queued',
      createdAt: at,
      deliveredAt: null,
    }],
    gate: {
      id: 'gate-1',
      revision: 1,
      reason: 'needs-human',
      candidateCommit: commit,
      createdAt: at,
      firstScreen: {
        round: 1,
        elapsedMs: 1200,
        signals: [{ kind: 'candidate-diverged', checkpointId: null, count: 1 }],
        reviewSummaries: [{
          seatId: 'seat-2',
          verdict: 'revise',
          summary: 'Two contradictions remain.',
          reviewFile: 'meldwork/reviews/requirements/r1-seat-2.md',
        }],
        changedFiles: [{ path: 'docs/requirements.md', added: 12, removed: 3, binary: false }],
        softGateSummary: [],
        driftItemIds: ['drift-1'],
        outOfScopeItemIds: ['scope-1'],
        blockerCheckpointIds: ['cp-0'],
        changesHeaderMissing: false,
        detectionSkipped: false,
        candidateDiverged: true,
      },
    },
    blockedOn: null,
    effects: [{
      id: 'cp-1:5:4',
      type: 'snapshot',
      category: 'required',
      status: 'pending',
      epoch: 1,
      params: { targets: ['docs/requirements.md'] },
      result: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    }],
    artifactVersions: [{
      id: 'av-1',
      commit,
      candidateCommit: commit,
      files: ['docs/requirements.md'],
      acceptedAt: at,
      source: 'gate',
      decisionId: null,
    }],
    readVersions: { 'cp-0': 'av-0' },
    decisions: [{
      gateId: 'gate-0',
      gateRevision: 1,
      reason: 'hard-gate-passed',
      outcome: 'accept',
      comment: 'Looks good.',
      candidateCommit: commit,
      upstreamCheckpointId: null,
      impactHash: null,
      driftChoice: null,
      commitToGit: false,
      decidedAt: at,
    }],
  }]
  state.driftItems = [{
    id: 'drift-1',
    revision: 1,
    path: 'docs/requirements.md',
    checkpointId: 'cp-1',
    baseVersionId: 'av-1',
    acceptedCommit: commit,
    observedCommit: commit,
    foundAt: at,
    source: 'drift-check',
    status: 'unresolved',
    resolvedAt: null,
  }]
  state.outOfScopeItems = [{
    id: 'scope-1',
    path: 'src/app.js',
    attribution: 'attributed',
    effectId: 'cp-1:5:1',
    overlappingEffectIds: [],
    detectedAt: at,
    status: 'unresolved',
    resolvedAt: null,
  }]
  state.callWindows = [{
    id: 'window-1',
    effectId: 'cp-1:5:1',
    groupId: null,
    claims: [claim],
    startedAt: at,
    endedAt: at,
    skipped: false,
  }]
  state.placeholders = [{
    path: 'assets/video.bin',
    reason: 'oversize',
    mode: '100644',
    size: 104857600,
    sha256,
    device: 1,
    inode: 2,
    mtimeMs: 1000,
    ctimeMs: 1000,
    recordedAt: 1000,
  }]
  state.metrics = {
    gateDecisions: [{
      gateId: 'gate-1',
      checkpointId: 'cp-1',
      reason: 'needs-human',
      outcome: 'continue',
      gateCreatedAt: at,
      decidedAt: at,
      durationMs: 500,
      requestedChangesAfterPass: false,
      acceptedAsIs: false,
    }],
    gateDecisionMonths: [{
      month: '2025-12',
      count: 2,
      outcomes: { continue: 1, accept: 1, 'reject-upstream': 0 },
      durationMs: 900,
      requestedChangesAfterPass: 1,
      acceptedAsIs: 0,
    }],
    reopenings: [{ checkpointId: 'cp-1', source: 'reopen', reason: 'Revisit.', at }],
    reopeningMonths: [{ month: '2025-12', count: 1 }],
    finalReviewFindings: [{ id: 'finding-1', checkpointId: 'cp-1', text: 'Missed risk.', createdAt: at }],
  }
  state.preferences = { drawerWidth: 480, drawerTab: 'files', commitToGit: true }
  state.chatReads = { 'group-1': { 'cp-1': 'av-1' } }
  state.projectEffects = [{
    id: 'project-effect-1',
    type: 'append-message',
    category: 'required',
    status: 'pending',
    params: { source: 'start' },
    result: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  }]
  state.projectBlockedOn = { effectId: 'project-effect-1', error: 'LOCAL_STORAGE_UNAVAILABLE', time: at }
  state.chatWriteChecks = {
    'agent-run-1': {
      groupId: 'group-1',
      status: 'pending-detection',
      snapshotCommit: commit,
      baseVersions: [{ checkpointId: 'cp-1', artifactVersionId: 'av-1', instanceEpoch: 1 }],
      failure: null,
    },
  }
  state.maintenanceLeaseRequests = [{
    id: 'maintenance-1',
    holder: { kind: 'project-maintenance', projectId: 'project-1', ownerId: 'maintenance-1' },
    chainEffectId: 'project-effect-2',
    claims: [{ root: '/tmp/project', path: '', mode: 'exclusive' }],
    epoch: 0,
    requestedAt: at,
    status: 'waiting',
    grantedAt: null,
    releasedAt: null,
  }]
  state.deletion = { phase: 'draining', startedAt: at }
  return state
}

test('emptyProjectState returns the documented defaults', () => {
  const state = emptyProjectState({ projectId: 'project-1' })
  assert.equal(PROJECT_STATE_SCHEMA_VERSION, 1)
  assert.equal(state.schemaVersion, 1)
  assert.equal(state.projectId, 'project-1')
  assert.equal(state.revision, 0)
  assert.deepEqual(state.instances, [])
  assert.deepEqual(state.driftItems, [])
  assert.deepEqual(state.projectEffects, [])
  assert.equal(state.config.playbook.roundLimit, 3)
  assert.equal(state.config.playbook.continuationLimit, 3)
  assert.equal(state.config.settings.docsRoot, 'meldwork/')
  assert.deepEqual(state.config.settings.snapshotLimits, DEFAULT_SNAPSHOT_LIMITS)
  assert.equal(state.projectBlockedOn, null)
  assert.deepEqual(parseProjectState(state), state)
})

test('a state with every collection parses and round-trips', () => {
  const state = validState()
  assert.deepEqual(parseProjectState(state), state)
})

test('each malformed collection entry is rejected with a zod path', () => {
  const cases = [
    ['invalid projectId', value => { value.projectId = 'bad id' }, 'projectId'],
    ['negative revision', value => { value.revision = -1 }, 'revision'],
    ['long role name', value => { value.config.seats[0].roleName = 'x'.repeat(41) }, 'config.seats.0.roleName'],
    ['long seat duty', value => { value.config.seats[0].duty = 'x'.repeat(201) }, 'config.seats.0.duty'],
    ['unknown capability', value => { value.config.seats[0].capabilities = ['teleport'] }, 'config.seats.0.capabilities.0'],
    ['long profile', value => { value.config.profiles[0].text = 'x'.repeat(16385) }, 'config.profiles.0.text'],
    ['unknown checkpoint type', value => { value.config.playbook.checkpointDefs[0].type = 'unknown' }, 'config.playbook.checkpointDefs.0.type'],
    ['unknown instance state', value => { value.instances[0].state = 'paused' }, 'instances.0.state'],
    ['unknown effect type', value => { value.instances[0].effects[0].type = 'unknown' }, 'instances.0.effects.0.type'],
    ['unknown lease status', value => { value.instances[0].leaseRequests[0].status = 'expired' }, 'instances.0.leaseRequests.0.status'],
    ['absolute claim path', value => { value.instances[0].leaseRequests[0].claims[0].path = '/etc/passwd' }, 'instances.0.leaseRequests.0.claims.0.path'],
    ['parent segment in claim', value => { value.instances[0].leaseRequests[0].claims[0].path = '../outside' }, 'instances.0.leaseRequests.0.claims.0.path'],
    ['unknown gate reason', value => { value.instances[0].gate.reason = 'surprise' }, 'instances.0.gate.reason'],
    ['unknown drift status', value => { value.driftItems[0].status = 'open' }, 'driftItems.0.status'],
    ['unknown attribution', value => { value.outOfScopeItems[0].attribution = 'maybe' }, 'outOfScopeItems.0.attribution'],
    ['short placeholder hash', value => { value.placeholders[0].sha256 = 'abc' }, 'placeholders.0.sha256'],
    ['unknown chat write status', value => { value.chatWriteChecks['agent-run-1'].status = 'done' }, 'chatWriteChecks.agent-run-1.status'],
    ['unknown deletion phase', value => { value.deletion.phase = 'removing' }, 'deletion.phase'],
  ]
  for (const [name, mutate, expectedPath] of cases) {
    const state = validState()
    mutate(state)
    assert.throws(() => parseProjectState(state), (error) => {
      assert.equal(error.code, 'PROJECT_STATE_INVALID', name)
      assert.equal(error.message, 'PROJECT_STATE_INVALID', name)
      assert.equal(error.details.issues[0].path, expectedPath, name)
      return true
    }, name)
  }
})

test('strict objects reject unknown fields at every level', () => {
  const cases = [
    ['top level', value => { value.extra = true }, ''],
    ['config', value => { value.config.extra = true }, 'config'],
    ['seat', value => { value.config.seats[0].extra = true }, 'config.seats.0'],
    ['instance', value => { value.instances[0].extra = true }, 'instances.0'],
    ['gate first screen', value => { value.instances[0].gate.firstScreen.extra = true }, 'instances.0.gate.firstScreen'],
    ['chat write check', value => { value.chatWriteChecks['agent-run-1'].extra = true }, 'chatWriteChecks.agent-run-1'],
    ['effect params keep known fields', value => { value.instances[0].effects[0].params.extra = true }, null],
  ]
  for (const [name, mutate, expectedPath] of cases) {
    const state = validState()
    mutate(state)
    if (expectedPath === null) {
      assert.deepEqual(parseProjectState(state), state, name)
      continue
    }
    assert.throws(() => parseProjectState(state), (error) => {
      assert.equal(error.code, 'PROJECT_STATE_INVALID', name)
      assert.equal(error.details.issues[0].path, expectedPath, name)
      assert.deepEqual(error.details.issues[0].keys, ['extra'], name)
      return true
    }, name)
  }
})

test('emptyProjectState validates the project id', () => {
  assert.throws(() => emptyProjectState({ projectId: 'bad id' }), {
    code: 'PROJECT_STATE_INVALID',
  })
})
