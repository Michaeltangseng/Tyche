const test = require('node:test')
const assert = require('node:assert/strict')
const { buildGateScreen } = require('../../src/project-room/gate-screen.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T09:00:00.000Z'
const now = Date.parse('2026-01-01T09:10:00.000Z')
const commit = 'a'.repeat(40)

function definition(key, overrides = {}) {
  return {
    key,
    name: key,
    type: 'document',
    targetFiles: [`docs/${key}.md`],
    leadSeatId: 'seat-lead',
    reviewerSeatIds: ['seat-reviewer'],
    draftSeatIds: [],
    gate: 'soft',
    roundLimit: 3,
    continuationLimit: 3,
    producesChecklist: false,
    dependsOn: [],
    ...overrides,
  }
}

function instance(id, checkpointKey, overrides = {}) {
  return {
    id,
    checkpointKey,
    state: 'accepted',
    seq: 1,
    epoch: 0,
    round: 1,
    roundsSinceHuman: 1,
    continuations: 0,
    sessionGeneration: 0,
    candidate: null,
    rounds: [{
      round: 1,
      candidate: commit,
      rebuttal: false,
      bodyChanged: true,
      startedAt: at,
      reviews: [{
        seatId: 'seat-reviewer',
        verdict: 'revise',
        reviewFile: `meldwork/reviews/${checkpointKey}/r1-seat-reviewer.md`,
        summary: 'Review summary.',
        finishedAt: at,
      }],
    }],
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

function stateWithData() {
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.seats = [
    {
      id: 'seat-lead', roleName: 'Lead', duty: 'Lead.', agentKind: 'codex',
      capabilities: ['read'], checkpointRoles: [], profileVersionId: 'profile-1',
    },
    {
      id: 'seat-reviewer', roleName: 'Reviewer', duty: 'Review.', agentKind: 'codex',
      capabilities: ['read'], checkpointRoles: [], profileVersionId: 'profile-2',
    },
  ]
  state.config.playbook.checkpointDefs = [
    definition('research'),
    definition('requirements', { dependsOn: ['research'] }),
  ]
  const research = instance('cp-research', 'research', {
    lastGateSignals: [{ kind: 'out-of-scope', checkpointId: null, count: 2 }],
    gate: {
      id: 'gate-research',
      revision: 1,
      reason: 'doc-new-version',
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
  const upstream = instance('cp-upstream', 'requirements', {
    gate: {
      id: 'gate-upstream',
      revision: 1,
      reason: 'doc-new-version',
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
    state: 'accepted',
  })
  const current = instance('cp-current', 'requirements', {
    state: 'gate',
    round: 2,
    rounds: [{
      round: 2,
      candidate: commit,
      rebuttal: true,
      bodyChanged: true,
      startedAt: at,
      reviews: [
        {
          seatId: 'seat-reviewer',
          verdict: 'revise',
          reviewFile: 'meldwork/reviews/requirements/r2-seat-reviewer.md',
          summary: 'First line.\nSecond line.\nThird line.\nFourth line.\nFifth line.',
          finishedAt: at,
        },
      ],
    }],
    readVersions: { 'cp-research': 'av-1' },
    effects: [{ id: 'invoke-1', type: 'invoke-lead', category: 'invocation', status: 'consumed', epoch: 0, params: {}, result: null, error: null, startedAt: null, finishedAt: null }],
    gate: {
      id: 'gate-current',
      revision: 1,
      reason: 'round-limit',
      candidateCommit: commit,
      createdAt: at,
      firstScreen: {
        round: 2,
        elapsedMs: 0,
        signals: [],
        reviewSummaries: [],
        changedFiles: [],
        softGateSummary: [],
        driftItemIds: [],
        outOfScopeItemIds: [],
        blockerCheckpointIds: [],
        changesHeaderMissing: true,
        detectionSkipped: true,
        candidateDiverged: true,
      },
    },
  })
  state.instances = [research, upstream, current]
  state.driftItems = [{
    id: 'drift-upstream', revision: 1, path: 'docs/research.md', checkpointId: 'cp-research',
    baseVersionId: null, acceptedCommit: commit, observedCommit: commit, foundAt: at,
    source: 'drift-check', status: 'unresolved', resolvedAt: null,
  }, {
    id: 'drift-current', revision: 1, path: 'docs/requirements.md', checkpointId: 'cp-current',
    baseVersionId: null, acceptedCommit: commit, observedCommit: commit, foundAt: at,
    source: 'drift-check', status: 'unresolved', resolvedAt: null,
  }]
  state.outOfScopeItems = [{
    id: 'scope-1', path: 'src/a.js', attribution: 'attributed', effectId: 'invoke-1',
    overlappingEffectIds: [], detectedAt: at, status: 'unresolved', resolvedAt: null,
  }]
  return { state, current: state.instances[2], def: state.config.playbook.checkpointDefs[1] }
}

test('builds the gate first screen from state and the current round', () => {
  const { state, current, def } = stateWithData()
  const screen = buildGateScreen({
    state,
    instance: current,
    def,
    gate: current.gate,
    changedFiles: [
      { path: 'docs/requirements.md', added: 5, removed: 2, binary: false },
      { path: 'assets/logo.png', added: null, removed: null, binary: true },
    ],
    now,
  })

  assert.equal(screen.round, 2)
  assert.equal(screen.elapsedMs, 10 * 60 * 1000)
  assert.equal(screen.reviewSummaries.length, 1)
  assert.equal(screen.reviewSummaries[0].summary, 'First line.\nSecond line.\nThird line.\nFourth line.\nFifth line.')
  assert.equal(screen.changedFiles[0].added, 5)
  assert.equal(screen.changedFiles[1].added, 0)
  assert.equal(screen.changedFiles[1].binary, true)
  assert.deepEqual(screen.driftItemIds, ['drift-current'])
  assert.deepEqual(screen.outOfScopeItemIds, ['scope-1'])
  assert.deepEqual(screen.blockerCheckpointIds.sort(), ['cp-research'])
  assert.equal(screen.softGateSummary.length, 1)
  assert.equal(screen.softGateSummary[0].checkpointId, 'cp-research')
  assert.deepEqual(screen.softGateSummary[0].signals, [{ kind: 'out-of-scope', checkpointId: null, count: 2 }])
  assert.equal(screen.changesHeaderMissing, true)
  assert.equal(screen.detectionSkipped, true)
  assert.equal(screen.candidateDiverged, true)

  const kinds = screen.signals.map(signal => signal.kind)
  for (const kind of [
    'upstream-pending-version', 'upstream-drift', 'candidate-diverged', 'out-of-scope',
    'changes-header-missing', 'detection-skipped', 'same-agent-kind', 'round-limit', 'rebuttal',
  ]) {
    assert.ok(kinds.includes(kind), `missing signal ${kind}`)
  }
  assert.deepEqual(screen.signals, screen.signals.slice(0, 16))
})
