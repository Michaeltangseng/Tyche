// Exhaustive data for M2 section 5.1 (main table), section 6 (gate outcomes),
// and section 7 (interjections). Each row is one test case; `condition`
// describes the scenario the test builder must construct.

const at = '2026-01-01T00:00:00.000Z'
const commit = 'a'.repeat(40)

const rows = []

function row(value) {
  rows.push({
    expectState: value.state,
    expectEffects: [],
    expectGate: null,
    expect: {},
    ...value,
  })
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

function config(condition = {}) {
  const reviewerSeatIds = condition.reviewerSeatIds || ['seat-reviewer']
  return {
    checkpoint: {
      key: 'requirements',
      name: 'Requirements',
      type: 'document',
      targetFiles: ['docs/requirements.md'],
      leadSeatId: 'seat-lead',
      reviewerSeatIds,
      draftSeatIds: condition.hasDrafts
        ? (condition.draftSeatIds || ['seat-draft'])
        : (condition.draftSeatIds || []),
      gate: condition.softGate ? 'soft' : 'hard',
      roundLimit: condition.roundLimit ?? 3,
      continuationLimit: condition.continuationLimit ?? 3,
      producesChecklist: false,
      dependsOn: [],
    },
    readExecSeatIds: condition.readExecSeatIds || [],
    softBlockers: condition.softBlocked ? { outOfScope: true } : {},
  }
}

function gate(reason) {
  return {
    id: `gate-${reason}`,
    revision: 1,
    reason,
    candidateCommit: commit,
    createdAt: at,
    firstScreen: {
      round: 0,
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
  }
}

function leadInvocation(overrides = {}) {
  return {
    effectId: 'cp-1:1:0',
    role: 'lead',
    seatId: 'seat-lead',
    agentKind: 'codex',
    round: 1,
    sessionGeneration: 0,
    claims: [],
    cancellationRequested: false,
    processRegistryId: null,
    ...overrides,
  }
}

function draftInvocation(seatId, overrides = {}) {
  return { ...leadInvocation(overrides), role: 'draft', seatId }
}

function reviewerInvocation(seatId, overrides = {}) {
  return { ...leadInvocation(overrides), role: 'reviewer', seatId }
}

function reviewRound(number, overrides = {}) {
  return {
    round: number,
    candidate: commit,
    rebuttal: false,
    bodyChanged: true,
    startedAt: at,
    reviews: [],
    ...overrides,
  }
}

function scenario(value) {
  const condition = value.condition || {}
  const interjections = condition.interjections
    ? [...condition.interjections]
    : (condition.queuedInterjection
      ? [{ id: 'interjection-1', content: 'Consider this.', status: 'queued', createdAt: at, deliveredAt: null }]
      : [])
  const instanceValue = instance(value.state, {
    round: condition.round ?? 0,
    roundsSinceHuman: condition.roundsSinceHuman ?? 0,
    continuations: condition.continuations ?? 0,
    sessionGeneration: condition.sessionGeneration ?? 0,
    epoch: condition.epoch ?? 0,
    candidate: condition.candidate === false ? null : commit,
    gate: condition.gateReason ? gate(condition.gateReason) : null,
    drafts: condition.drafts || [],
    activeInvocations: condition.activeInvocations || [],
    interjections,
    pendingStart: condition.pendingStart || null,
    rounds: condition.rounds || [],
    leaseRequests: condition.leaseRequests || [],
    ...(condition.blocked
      ? { blockedOn: { effectId: condition.blocked, error: 'EIO', time: at } }
      : {}),
  })
  let event = value.event
  if (typeof event === 'string') event = { type: event }
  if (event.type === 'INVOCATION_ENDED' && !event.payload) {
    const role = condition.role || 'lead'
    const result = condition.result || 'ready'
    event = {
      type: 'INVOCATION_ENDED',
      payload: {
        effectId: condition.effectId || 'cp-1:1:0',
        role,
        seatId: condition.seatId || (role === 'lead' ? 'seat-lead' : 'seat-reviewer'),
        round: condition.invocationRound ?? 1,
        sessionGeneration: condition.sessionGeneration ?? 0,
        ...(result === 'failed' ? { failed: { code: 'LOCAL_AGENT_EXIT' } } : {}),
        ...(result === 'cancelled' ? { cancelled: true } : {}),
        ...(result === 'missing' ? {} : { marker: result }),
      },
    }
  }
  return { instance: instanceValue, config: config(condition), event, condition }
}

// ---------------------------------------------------------------------------
// M2 5.1 main table
// ---------------------------------------------------------------------------

row({
  state: 'pending',
  event: 'DEPS_READY',
  expectState: 'checking',
  expectEffects: ['drift-check'],
})

row({
  state: 'checking',
  event: { type: 'EFFECT_RESULT', payload: { type: 'drift-check', result: { clean: true } } },
  condition: { effectType: 'drift-check', hasDrafts: true },
  expectState: 'drafting',
  expectEffects: ['acquire-scope', 'snapshot', 'invoke-draft'],
})

row({
  state: 'checking',
  event: { type: 'EFFECT_RESULT', payload: { type: 'drift-check', result: { clean: true } } },
  condition: { effectType: 'drift-check', hasDrafts: false },
  expectState: 'leading',
  expectEffects: ['acquire-scope', 'snapshot', 'invoke-lead'],
})

row({
  state: 'checking',
  event: {
    type: 'EFFECT_RESULT',
    payload: { type: 'drift-check', result: { clean: false, drifted: ['docs/a.md'] } },
  },
  condition: { effectType: 'drift-check', driftDirty: true },
  expectState: 'gate',
  expectGate: 'drift',
})

row({
  state: 'drafting',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'draft', result: 'continue', underContinuationLimit: true,
    activeInvocations: [draftInvocation('seat-draft')],
  },
  expectState: 'drafting',
  expectEffects: ['invoke-draft'],
  expect: { continuations: 1 },
})

row({
  state: 'drafting',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'draft', result: 'ready', draftsRunning: true,
    activeInvocations: [draftInvocation('seat-draft'), draftInvocation('seat-draft-2')],
  },
  expectState: 'drafting',
  expect: { draftsRecorded: 1 },
})

row({
  state: 'drafting',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'draft', result: 'ready', allDraftsReady: true,
    activeInvocations: [draftInvocation('seat-draft')],
  },
  expectState: 'leading',
  expectEffects: ['release-scope', 'acquire-scope', 'snapshot', 'invoke-lead'],
})

row({
  state: 'drafting',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'draft', result: 'question',
    activeInvocations: [draftInvocation('seat-draft')],
  },
  expectState: 'gate',
  expectGate: 'draft-question',
  expectEffects: ['release-scope'],
})

row({
  state: 'leading',
  event: 'INVOCATION_ENDED',
  condition: { role: 'lead', result: 'ready', activeInvocations: [leadInvocation()] },
  expectState: 'submitted',
  expectEffects: ['snapshot', 'evaluate-submission'],
})

row({
  state: 'leading',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'lead', result: 'continue', underContinuationLimit: true,
    activeInvocations: [leadInvocation()],
  },
  expectState: 'leading',
  expectEffects: ['invoke-lead'],
  expect: { continuations: 1 },
})

row({
  state: 'leading',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'lead', result: 'continue', underContinuationLimit: false,
    continuations: 3, activeInvocations: [leadInvocation()],
  },
  expectState: 'gate',
  expectGate: 'continuation-limit',
  expectEffects: ['snapshot', 'release-scope'],
})

row({
  state: 'leading',
  event: 'INVOCATION_ENDED',
  condition: { role: 'lead', result: 'question', activeInvocations: [leadInvocation()] },
  expectState: 'gate',
  expectGate: 'question',
  expectEffects: ['snapshot', 'release-scope'],
})

row({
  state: 'leading',
  event: 'INVOCATION_ENDED',
  condition: { role: 'lead', result: 'missing', activeInvocations: [leadInvocation()] },
  expectState: 'gate',
  expectGate: 'marker-missing',
  expectEffects: ['snapshot', 'release-scope'],
})

row({
  state: 'leading',
  event: 'INVOCATION_ENDED',
  condition: { role: 'lead', result: 'failed', activeInvocations: [leadInvocation()] },
  expectState: 'gate',
  expectGate: 'failure',
  expectEffects: ['snapshot', 'release-scope'],
})

row({
  state: 'submitted',
  event: { type: 'EFFECT_RESULT', payload: { type: 'snapshot', result: { commit } } },
  condition: { effectType: 'snapshot', candidateRecorded: true },
  expectState: 'submitted',
  expect: { candidate: commit },
})

row({
  state: 'submitted',
  event: { type: 'EFFECT_RESULT', payload: { type: 'evaluate-submission', result: {} } },
  condition: {
    effectType: 'evaluate-submission', queuedInterjection: true,
    rounds: [reviewRound(0)],
  },
  expectState: 'leading',
  expect: { interjectionsDelivered: 1 },
})

row({
  state: 'submitted',
  event: { type: 'EFFECT_RESULT', payload: { type: 'evaluate-submission', result: { manifestValid: false } } },
  condition: { effectType: 'evaluate-submission', manifestValid: false },
  expectState: 'gate',
  expectGate: 'manifest-invalid',
  expectEffects: ['release-scope'],
})

row({
  state: 'submitted',
  event: { type: 'EFFECT_RESULT', payload: { type: 'evaluate-submission', result: { bodyChanged: true } } },
  condition: { effectType: 'evaluate-submission', bodyChanged: true, firstRound: true },
  expectState: 'reviewing',
  expectEffects: ['invoke-reviewer'],
  expect: { round: 1, roundsSinceHuman: 1 },
})

row({
  state: 'submitted',
  event: {
    type: 'EFFECT_RESULT',
    payload: { type: 'evaluate-submission', result: { bodyChanged: false, newResponse: true } },
  },
  condition: {
    effectType: 'evaluate-submission', bodyChanged: false, newResponse: true,
    round: 1, rounds: [reviewRound(1)],
  },
  expectState: 'reviewing',
  expectEffects: ['invoke-reviewer'],
  expect: { round: 2, rebuttal: true },
})

row({
  state: 'submitted',
  event: {
    type: 'EFFECT_RESULT',
    payload: { type: 'evaluate-submission', result: { bodyChanged: false, newResponse: false } },
  },
  condition: {
    effectType: 'evaluate-submission', bodyChanged: false, newResponse: false,
    round: 1, rounds: [reviewRound(1)],
  },
  expectState: 'gate',
  expectGate: 'artifact-unchanged',
  expectEffects: ['release-scope'],
})

row({
  state: 'reviewing',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'reviewer', result: 'needs-human',
    activeInvocations: [reviewerInvocation('seat-reviewer')],
  },
  expectState: 'gate',
  expectGate: 'needs-human',
  expectEffects: ['cancel-invocation', 'write-review-file', 'release-scope'],
})

row({
  state: 'reviewing',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'reviewer', result: 'missing',
    activeInvocations: [reviewerInvocation('seat-reviewer')],
  },
  expectState: 'gate',
  expectGate: 'needs-human',
  expectEffects: ['cancel-invocation', 'write-review-file', 'release-scope'],
})

row({
  state: 'reviewing',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'reviewer', result: 'failed',
    activeInvocations: [reviewerInvocation('seat-reviewer')],
  },
  expectState: 'gate',
  expectGate: 'review-failed',
  expectEffects: ['cancel-invocation', 'write-review-file', 'release-scope'],
})

row({
  state: 'reviewing',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'reviewer', result: 'pass', reviewsPending: true,
    activeInvocations: [reviewerInvocation('seat-reviewer'), reviewerInvocation('seat-reviewer-2')],
  },
  expectState: 'reviewing',
  expectEffects: ['write-review-file'],
})

row({
  state: 'reviewing',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'reviewer', result: 'pass', readOnlyDone: true, readExecRemaining: true,
    readExecSeatIds: ['seat-reviewer-exec'],
    activeInvocations: [reviewerInvocation('seat-reviewer')],
  },
  expectState: 'reviewing',
  expectEffects: ['write-review-file', 'snapshot', 'invoke-reviewer'],
})

row({
  state: 'reviewing',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'reviewer', result: 'pass', readExecReturned: true,
    seatId: 'seat-reviewer-exec', readExecSeatIds: ['seat-reviewer-exec'],
    activeInvocations: [reviewerInvocation('seat-reviewer-exec')],
  },
  expectState: 'reviewing',
  expectEffects: ['snapshot', 'verify-candidate'],
})

row({
  state: 'reviewing',
  event: {
    type: 'EFFECT_RESULT',
    payload: { type: 'verify-candidate', result: { intact: false, differing: ['docs/requirements.md'] } },
  },
  condition: {
    effectType: 'verify-candidate', candidateIntact: false,
    readExecSeatIds: ['seat-reviewer-exec'],
  },
  expectState: 'gate',
  expectGate: 'review-failed',
  expectEffects: ['release-scope'],
})

row({
  state: 'reviewing',
  event: {
    type: 'EFFECT_RESULT',
    payload: { type: 'verify-candidate', result: { intact: true } },
  },
  condition: {
    effectType: 'verify-candidate', candidateIntact: true, readExecRemaining: true,
    readExecSeatIds: ['seat-reviewer-exec', 'seat-reviewer-exec-2'],
  },
  expectState: 'reviewing',
  expectEffects: ['write-review-file', 'invoke-reviewer'],
})

row({
  state: 'reviewing',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'reviewer', result: 'revise', lastReviewer: true, rebuttal: true,
    rounds: [reviewRound(1, { rebuttal: true })],
    activeInvocations: [reviewerInvocation('seat-reviewer')],
  },
  expectState: 'gate',
  expectGate: 'rebuttal-rejected',
  expectEffects: ['release-scope'],
})

row({
  state: 'reviewing',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'reviewer', result: 'revise', lastReviewer: true,
    queuedInterjection: true, rounds: [reviewRound(1)],
    activeInvocations: [reviewerInvocation('seat-reviewer')],
  },
  expectState: 'leading',
  expect: { interjectionsDelivered: 1 },
})

row({
  state: 'reviewing',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'reviewer', result: 'revise', lastReviewer: true,
    roundsSinceHuman: 3, roundLimit: 3, rounds: [reviewRound(1)],
    activeInvocations: [reviewerInvocation('seat-reviewer')],
  },
  expectState: 'gate',
  expectGate: 'round-limit',
  expectEffects: ['release-scope'],
})

row({
  state: 'reviewing',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'reviewer', result: 'revise', lastReviewer: true,
    roundsSinceHuman: 1, roundLimit: 3, rounds: [reviewRound(1)],
    activeInvocations: [reviewerInvocation('seat-reviewer')],
  },
  expectState: 'leading',
  expectEffects: ['snapshot', 'invoke-lead'],
})

row({
  state: 'reviewing',
  event: 'INVOCATION_ENDED',
  condition: {
    role: 'reviewer', result: 'pass', lastReviewer: true, allPass: true,
    rounds: [reviewRound(1)],
    activeInvocations: [reviewerInvocation('seat-reviewer')],
  },
  expectState: 'reviewing',
  expectEffects: ['verify-candidate', 'write-review-file'],
})

row({
  state: 'reviewing',
  event: {
    type: 'EFFECT_RESULT',
    payload: { type: 'verify-candidate', result: { intact: true } },
  },
  condition: {
    effectType: 'verify-candidate', candidateIntact: true, queuedInterjection: true,
    allPass: true,
    rounds: [reviewRound(1, {
      reviews: [{
        seatId: 'seat-reviewer',
        verdict: 'pass',
        reviewFile: 'meldwork/reviews/requirements/r1-seat-reviewer.md',
        finishedAt: at,
      }],
    })],
  },
  expectState: 'leading',
  expect: { interjectionsDelivered: 1, passInvalidated: true },
})

row({
  state: 'reviewing',
  event: {
    type: 'EFFECT_RESULT',
    payload: { type: 'verify-candidate', result: { intact: true } },
  },
  condition: { effectType: 'verify-candidate', candidateIntact: true, softGate: false },
  expectState: 'gate',
  expectGate: 'hard-gate-passed',
  expectEffects: ['release-scope'],
})

row({
  state: 'reviewing',
  event: {
    type: 'EFFECT_RESULT',
    payload: { type: 'verify-candidate', result: { intact: true } },
  },
  condition: { effectType: 'verify-candidate', candidateIntact: true, softGate: true, softBlocked: true },
  expectState: 'gate',
  expectGate: 'hard-gate-passed',
  expectEffects: ['release-scope'],
})

row({
  state: 'reviewing',
  event: {
    type: 'EFFECT_RESULT',
    payload: { type: 'verify-candidate', result: { intact: true } },
  },
  condition: { effectType: 'verify-candidate', candidateIntact: true, softGate: true, softBlocked: false },
  expectState: 'accepting',
  expectEffects: ['append-decision', 'stamp-changes', 'accept-commit', 'drop-snapshot-refs', 'notify'],
})

row({
  state: 'accepting',
  event: {
    type: 'EFFECT_RESULT',
    payload: { type: 'accept-commit', result: { commit } },
  },
  condition: { effectType: 'accept-commit' },
  expectState: 'accepted',
  expect: { artifactVersions: 1 },
})

row({
  state: 'accepted',
  event: {
    type: 'ACCEPTED_DOC_CHANGED',
    payload: { file: 'docs/requirements.md', critical: true, snapshot: commit },
  },
  condition: { docChange: 'requirements' },
  expectState: 'accepted',
  expectGate: 'doc-new-version',
})

row({
  state: 'accepted',
  event: {
    type: 'ACCEPTED_DOC_CHANGED',
    payload: { file: 'docs/notes.md', critical: false, snapshot: commit },
  },
  condition: { docChange: 'other' },
  expectState: 'accepted',
  expect: { artifactVersions: 1 },
})

row({
  state: 'accepted',
  event: { type: 'REOPEN', payload: { reason: 'Revisit.' } },
  condition: { gateReason: 'hard-gate-passed' },
  expectState: 'checking',
  expectEffects: ['withdraw-lease'],
  expect: { epoch: 1, sessionGeneration: 1, gateVoided: true },
})

for (const state of ['pending', 'checking', 'submitted', 'gate', 'accepted']) {
  row({
    state,
    event: { type: 'UPSTREAM_REOPENED', payload: { checkpointId: 'cp-0' } },
    condition: { gateReason: state === 'gate' ? 'needs-human' : null },
    expectState: 'stale',
    expectEffects: ['withdraw-lease'],
    expect: { epoch: 1, gateVoided: state === 'gate' },
  })
}

for (const state of ['drafting', 'leading', 'reviewing']) {
  row({
    state,
    event: { type: 'UPSTREAM_REOPENED', payload: { checkpointId: 'cp-0' } },
    condition: {
      activeInvocations: state === 'drafting'
        ? [draftInvocation('seat-draft')]
        : (state === 'leading' ? [leadInvocation()] : [reviewerInvocation('seat-reviewer')]),
    },
    expectState: 'stale',
    expectEffects: ['cancel-invocation', 'withdraw-lease'],
    expect: { epoch: 1 },
  })
}

row({
  state: 'accepting',
  event: { type: 'UPSTREAM_REOPENED', payload: { checkpointId: 'cp-0' } },
  expectState: 'accepting',
  expect: { epoch: 0, reopenAfterAccept: true },
})

row({
  state: 'stale',
  event: 'DEPS_READY',
  condition: { activeInvocations: [] },
  expectState: 'checking',
  expectEffects: ['drift-check'],
  expect: { sessionGeneration: 1 },
})

row({
  state: 'stale',
  event: 'DEPS_READY',
  condition: {
    activeInvocations: [leadInvocation({ cancellationRequested: true })],
    writableEnding: true,
  },
  expectState: 'stale',
  expect: { pendingStart: true },
})

row({
  state: 'leading',
  event: { type: 'EFFECT_FAILED', payload: { effectId: 'cp-1:4:0', error: 'EIO' } },
  expectState: 'leading',
  expectEffects: [],
  expect: { blockedOn: 'cp-1:4:0' },
})

row({
  state: 'leading',
  event: { type: 'RETRY_EFFECT', payload: { effectId: 'cp-1:4:0' } },
  condition: { blocked: 'cp-1:4:0' },
  expectState: 'leading',
  expect: { blockedOn: null },
})

row({
  state: 'leading',
  event: { type: 'RESTORED', payload: { effectId: 'cp-1:4:0' } },
  condition: { blocked: 'cp-1:4:0' },
  expectState: 'leading',
  expect: { blockedOn: null },
})

row({
  state: 'gate',
  event: { type: 'UPSTREAM_BLOCKERS_CHANGED', payload: {} },
  condition: { gateReason: 'drift' },
  expectState: 'checking',
  expectEffects: ['drift-check'],
  expect: { gateVoided: true },
})

row({
  state: 'leading',
  event: { type: 'LEASE_GRANTED', payload: { requestId: 'req-1' } },
  condition: {
    leaseRequests: [{
      id: 'req-1',
      holder: { kind: 'checkpoint-scope', projectId: 'project-1', ownerId: 'cp-1' },
      chainEffectId: 'cp-1:1:0',
      claims: [{ root: '/tmp/project', path: 'docs/requirements.md', mode: 'exclusive' }],
      epoch: 0,
      requestedAt: at,
      status: 'waiting',
      grantedAt: null,
      releasedAt: null,
    }],
  },
  expectState: 'leading',
  expect: { leaseStatus: 'granted' },
})

// ---------------------------------------------------------------------------
// M2 section 6: gate outcomes (reason x outcome)
// ---------------------------------------------------------------------------

const gateMatrix = {
  'doc-new-version': { continue: 'checking', accept: 'accepted', reject: 'stale', acceptEffect: 'artifact-version' },
  drift: { continue: null, accept: 'checking', reject: 'stale' },
  failure: { continue: 'leading', accept: 'submitted', reject: 'stale' },
  recovery: { continue: 'leading', accept: 'submitted', reject: 'stale' },
  question: { continue: 'leading', accept: null, reject: 'stale' },
  'draft-question': { continue: 'drafting', accept: null, reject: 'stale' },
  'continuation-limit': { continue: 'leading', accept: 'submitted', reject: 'stale' },
  'marker-missing': { continue: 'leading', accept: 'submitted', reject: 'stale' },
  'manifest-invalid': { continue: 'leading', accept: null, reject: 'stale' },
  'needs-human': { continue: 'leading', accept: 'accepting', reject: 'stale' },
  'review-failed': { continue: 'leading', accept: 'accepting', reject: 'stale' },
  'rebuttal-rejected': { continue: 'leading', accept: 'accepting', reject: 'stale' },
  'round-limit': { continue: 'leading', accept: 'accepting', reject: 'stale' },
  'artifact-unchanged': { continue: 'leading', accept: 'accepting', reject: 'stale' },
  'hard-gate-passed': { continue: 'leading', accept: 'accepting', reject: 'stale' },
}

const outcomeKeys = { continue: 'continue', accept: 'accept', reject: 'reject-upstream' }
for (const [reason, outcomes] of Object.entries(gateMatrix)) {
  for (const [key, expectState] of Object.entries(outcomes)) {
    if (key === 'acceptEffect') continue
    row({
      state: reason === 'doc-new-version' ? 'accepted' : 'gate',
      event: {
        type: 'GATE_DECIDED',
        payload: {
          gateId: `gate-${reason}`,
          gateRevision: 1,
          outcome: outcomeKeys[key],
          comment: key === 'continue' ? 'Please continue.' : '',
          candidateCommit: commit,
          impactHash: key === 'reject' ? 'impact-1' : null,
        },
      },
      condition: { gateReason: reason, gateOutcome: outcomeKeys[key] },
      expectState: expectState || (reason === 'doc-new-version' ? 'accepted' : 'gate'),
      expectGate: expectState ? null : reason,
      expect: {
        outcomeUnavailable: expectState === null,
        gateVoided: Boolean(expectState),
      },
    })
  }
}

// ---------------------------------------------------------------------------
// M2 section 7: interjections and stop-and-deliver
// ---------------------------------------------------------------------------

const interjectionStates = [
  'pending', 'checking', 'drafting', 'leading', 'submitted', 'reviewing',
  'gate', 'accepting', 'accepted', 'stale',
]
for (const state of interjectionStates) {
  const accepted = ['pending', 'checking', 'drafting', 'leading', 'submitted', 'reviewing'].includes(state)
  row({
    state,
    event: { type: 'INTERJECT', payload: { content: 'Consider this.' } },
    condition: { gateReason: state === 'gate' ? 'needs-human' : null },
    expectState: state === 'submitted' && accepted ? 'leading' : state,
    expect: accepted
      ? (state === 'submitted'
        ? { interjectionDelivered: 1 }
        : { interjectionQueued: 1 })
      : { ignored: true },
  })
  const stopAccepted = ['drafting', 'leading', 'submitted', 'reviewing'].includes(state)
  row({
    state,
    event: { type: 'STOP_AND_DELIVER', payload: {} },
    condition: { gateReason: state === 'gate' ? 'needs-human' : null },
    expectState: state === 'submitted' ? 'leading' : state,
    expect: stopAccepted
      ? { stopAccepted: true }
      : { ignored: true },
  })
}

for (const state of interjectionStates) {
  row({
    state,
    event: { type: 'EFFECT_FAILED', payload: { effectId: 'effect-failed', error: 'EIO' } },
    expectState: state,
    expect: { blockedOn: 'effect-failed' },
  })
  row({
    state,
    event: { type: 'RETRY_EFFECT', payload: { effectId: 'effect-failed' } },
    condition: { blocked: 'effect-failed' },
    expectState: state,
    expect: { blockedOn: null },
  })
  row({
    state,
    event: { type: 'RESTORED', payload: { effectId: 'effect-failed' } },
    condition: { blocked: 'effect-failed' },
    expectState: state,
    expect: { blockedOn: null },
  })
}

const events = [
  'DEPS_READY', 'INVOCATION_ENDED', 'EFFECT_RESULT', 'EFFECT_FAILED', 'RETRY_EFFECT',
  'GATE_DECIDED', 'REOPEN', 'INTERJECT', 'STOP_AND_DELIVER', 'UPSTREAM_REOPENED',
  'UPSTREAM_BLOCKERS_CHANGED', 'ACCEPTED_DOC_CHANGED', 'RESTORED', 'LEASE_GRANTED',
]
const states = interjectionStates

module.exports = {
  at,
  build: scenario,
  commit,
  events,
  rows,
  states,
}
