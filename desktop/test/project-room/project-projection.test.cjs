const test = require('node:test')
const assert = require('node:assert/strict')
const {
  pendingDecisions,
  projectSnapshot,
  sidebarEntry,
} = require('../../src/project-room/project-projection.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T00:00:00.000Z'
const now = Date.parse('2026-01-01T01:00:00.000Z')
const commit = 'a'.repeat(40)
const secrets = [
  '/secret/bin/agent',
  'session-secret-123',
  'PROMPT_SECRET_TEXT',
  'COMMAND_SECRET',
  'CONTEXT_SECRET',
  'OLD_PROFILE_SECRET',
  'EFFECT_PROMPT_SECRET',
  'EFFECT_COMMAND_SECRET',
  'REGISTRY_SECRET',
  '/secret/codex',
  'codex --SECRET',
]

function sensitiveProject(overrides = {}) {
  return {
    id: 'project-1',
    name: 'Project One',
    workdir: '/Users/example/Projects/project-one',
    readOnly: false,
    executablePath: '/secret/bin/agent',
    sessionRef: 'session-secret-123',
    prompt: 'PROMPT_SECRET_TEXT',
    commandLine: 'agent --token COMMAND_SECRET',
    contextPack: 'CONTEXT_SECRET',
    residuals: [{
      residualId: 'residual-1',
      pid: 123,
      startedAt: '2025-12-31T20:00:00.000Z',
      agentKind: 'codex',
      programName: 'codex',
      containerMarked: false,
      commandLine: 'codex --SECRET',
      executablePath: '/secret/codex',
    }],
    ...overrides,
  }
}

function signal(kind) {
  return { kind, checkpointId: null, count: null }
}

function stateWithData() {
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.seats = [{
    id: 'seat-1',
    roleName: 'Lead',
    duty: 'Write.',
    agentKind: 'codex',
    capabilities: ['read'],
    checkpointRoles: [{ checkpointKey: 'requirements', role: 'lead' }],
    profileVersionId: 'profile-2',
  }]
  state.config.profiles = [
    {
      id: 'profile-1',
      seatId: 'seat-1',
      version: 1,
      text: 'OLD_PROFILE_SECRET',
      createdAt: at,
      source: 'default',
    },
    {
      id: 'profile-2',
      seatId: 'seat-1',
      version: 2,
      text: 'Current profile.',
      createdAt: at,
      source: 'user-edit',
    },
  ]
  state.config.playbook.checkpointDefs = [{
    key: 'requirements',
    name: 'Requirements',
    type: 'document',
    targetFiles: ['docs/requirements.md'],
    leadSeatId: 'seat-1',
    reviewerSeatIds: ['seat-2'],
    draftSeatIds: [],
    gate: 'hard',
    roundLimit: 3,
    continuationLimit: 3,
    producesChecklist: false,
    dependsOn: [],
  }]
  state.instances = [{
    id: 'cp-1',
    checkpointKey: 'requirements',
    state: 'gate',
    seq: 1,
    epoch: 0,
    round: 2,
    roundsSinceHuman: 2,
    continuations: 0,
    sessionGeneration: 0,
    candidate: commit,
    rounds: [],
    roundsSummary: [],
    leaseRequests: [],
    activeInvocations: [{
      effectId: 'inv-1',
      role: 'reviewer',
      seatId: 'seat-2',
      agentKind: 'claude',
      round: 2,
      sessionGeneration: 0,
      claims: [],
      cancellationRequested: false,
      processRegistryId: 'REGISTRY_SECRET',
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
        round: 2,
        elapsedMs: 5000,
        signals: [
          signal('rebuttal'),
          signal('upstream-drift'),
          signal('candidate-diverged'),
          signal('out-of-scope'),
          signal('upstream-pending-version'),
          signal('round-limit'),
        ],
        reviewSummaries: [
          {
            seatId: 'seat-2',
            verdict: 'pass',
            summary: 'Passing summary.',
            reviewFile: 'meldwork/reviews/requirements/r2-seat-2.md',
          },
          {
            seatId: 'seat-3',
            verdict: 'revise',
            summary: 'Line one.\nLine two.\nLine three.\nLine four.\nLine five.',
            reviewFile: 'meldwork/reviews/requirements/r2-seat-3.md',
          },
          {
            seatId: 'seat-4',
            verdict: 'needs-human',
            summary: 'Needs a human decision.',
            reviewFile: 'meldwork/reviews/requirements/r2-seat-4.md',
          },
        ],
        changedFiles: [
          { path: 'docs/a.md', added: 1, removed: 1, binary: false },
          { path: 'docs/b.md', added: 10, removed: 0, binary: false },
          { path: 'docs/c.md', added: 2, removed: 3, binary: false },
          { path: 'docs/d.md', added: 0, removed: 0, binary: true },
          { path: 'docs/e.md', added: 5, removed: 5, binary: false },
          { path: 'docs/f.md', added: 8, removed: 1, binary: false },
          { path: 'docs/g.md', added: 1, removed: 0, binary: false },
          { path: 'docs/h.md', added: 0, removed: 2, binary: false },
        ],
        softGateSummary: [
          {
            checkpointId: 'cp-0', name: 'Research', rounds: 1,
            signals: [],
          },
          ...Array.from({ length: 5 }, (_, index) => ({
            checkpointId: `cp-soft-${index}`,
            name: `Soft ${index}`,
            rounds: 2,
            signals: [signal('out-of-scope')],
          })),
        ],
        driftItemIds: ['drift-1'],
        outOfScopeItemIds: ['scope-1'],
        blockerCheckpointIds: ['cp-0'],
        changesHeaderMissing: true,
        detectionSkipped: true,
        candidateDiverged: true,
      },
    },
    blockedOn: null,
    effects: [],
    artifactVersions: [],
    readVersions: {},
    decisions: [],
  }]
  state.driftItems = [{
    id: 'drift-1',
    revision: 1,
    path: 'docs/requirements.md',
    checkpointId: 'cp-1',
    baseVersionId: null,
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
    attribution: 'uncertain',
    effectId: 'inv-1',
    overlappingEffectIds: [],
    detectedAt: at,
    status: 'unresolved',
    resolvedAt: null,
  }]
  state.projectEffects = [{
    id: 'effect-1',
    type: 'append-message',
    category: 'required',
    status: 'pending',
    params: {
      prompt: 'EFFECT_PROMPT_SECRET',
      commandLine: 'EFFECT_COMMAND_SECRET',
    },
    result: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  }]
  return state
}

function assertNoSecrets(value) {
  const text = JSON.stringify(value)
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `projection leaked ${secret}`)
  }
}

test('the sidebar entry carries counts and only the workdir display name', () => {
  const project = sensitiveProject()
  const entry = sidebarEntry(project, stateWithData())
  assert.equal(entry.projectId, 'project-1')
  assert.equal(entry.name, 'Project One')
  assert.equal(entry.displayName, 'project-one')
  assert.equal(entry.readOnly, false)
  assert.equal(entry.pendingGateCount, 1)
  assert.equal(entry.unresolvedDriftCount, 1)
  assert.equal(entry.residualCount, 1)
  assert.equal(entry.deleting, null)
  assert.equal(JSON.stringify(entry).includes(project.workdir), false)
  assertNoSecrets(entry)

  const missing = sidebarEntry(project, null)
  assert.equal(missing.readOnly, true)
  assert.equal(missing.readOnlyReason, 'state-unavailable')
  assert.equal(missing.pendingGateCount, 0)
  assert.equal(missing.unresolvedDriftCount, 0)
  assert.equal(missing.residualCount, 1)
})

test('pending decisions are sorted by waiting time, capped, and counted', () => {
  const state = stateWithData()
  state.instances[0].blockedOn = {
    effectId: 'blocked-effect', error: 'PROJECT_STORAGE_FAULT', time: '2025-12-31T23:00:00.000Z',
  }
  state.projectBlockedOn = {
    effectId: 'project-blocked', error: 'PROJECT_STORAGE_FAULT', time: '2025-12-31T23:30:00.000Z',
  }
  const emptyProject = { ...sensitiveProject(), id: 'project-2', name: 'Project Two', residuals: [] }
  const emptyState = emptyProjectState({ projectId: 'project-2' })
  const result = pendingDecisions([
    { project: sensitiveProject(), state },
    { project: emptyProject, state: emptyState },
  ], now)

  assert.equal(result.total, 5)
  assert.equal(result.items.length, 5)
  assert.deepEqual(result.items.map(item => item.type), [
    'residual', 'suspended', 'suspended', 'drift', 'gate',
  ])
  assert.equal(result.items[0].waitingMs, 5 * 60 * 60 * 1000)
  for (let index = 1; index < result.items.length; index += 1) {
    assert.ok(result.items[index - 1].waitingMs >= result.items[index].waitingMs)
  }
  assertNoSecrets(result)

  const crowded = stateWithData()
  crowded.driftItems = []
  crowded.outOfScopeItems = []
  crowded.instances = Array.from({ length: 101 }, (_, index) => ({
    ...structuredClone(crowded.instances[0]),
    id: `cp-${index}`,
    gate: {
      ...structuredClone(crowded.instances[0].gate),
      id: `gate-${index}`,
    },
  }))
  const capped = pendingDecisions([{
    project: { ...sensitiveProject(), residuals: [] },
    state: crowded,
  }], now)
  assert.equal(capped.total, 101)
  assert.equal(capped.items.length, 100)
})

test('the project snapshot applies first-screen budgets and hides internals', () => {
  const project = sensitiveProject()
  const state = stateWithData()
  state.chatWriteChecks = {
    'run-1': {
      groupId: 'group-1', status: 'running', snapshotCommit: null,
      baseVersions: null, failure: null,
    },
  }
  state.placeholders = [{ path: 'docs/requirements.md', reason: 'oversize' }]
  state.instances[0].sessionGeneration = 3
  state.instances[0].interjections = [{
    id: 'interjection-1', content: 'A note', status: 'queued',
    createdAt: at, deliveredAt: null,
  }]
  const snapshot = projectSnapshot(project, state)

  assert.equal(snapshot.projectId, 'project-1')
  assert.equal(snapshot.workdir, project.workdir)
  assert.equal(snapshot.revision, 0)
  assert.equal(snapshot.readOnly, false)
  assert.equal(snapshot.progress.length, 1)
  assert.equal(snapshot.progress[0].leadSeatName, 'Lead')
  assert.equal(snapshot.progress[0].waitingOn, 'human')
  assert.equal(snapshot.progress[0].generation, 3)
  assert.deepEqual(snapshot.progress[0].pendingInterjections.map(item => item.id), ['interjection-1'])
  assert.equal(snapshot.gates.length, 1)

  const gate = snapshot.gates[0]
  assert.equal(gate.gateId, 'gate-1')
  assert.deepEqual(gate.allowedOutcomes, ['continue', 'accept', 'reject-upstream'])
  assert.ok(gate.acceptBlockers.some(blocker => blocker.type === 'detection'))
  assert.deepEqual(gate.signals.map(item => item.kind), [
    'upstream-pending-version', 'upstream-drift', 'candidate-diverged', 'out-of-scope',
  ])
  assert.equal(gate.signalCount, 6)
  assert.deepEqual(gate.reviewSummaries.map(item => item.verdict), ['needs-human', 'revise'])
  assert.equal(gate.reviewSummaryCount, 3)
  assert.equal(gate.reviewSummaries[1].summary.split('\n').length, 4)
  assert.deepEqual(gate.changedFiles.map(item => item.path), [
    'docs/b.md', 'docs/e.md', 'docs/f.md', 'docs/c.md', 'docs/a.md', 'docs/h.md',
  ])
  assert.equal(gate.changedFileCount, 8)
  assert.equal(gate.softGateSummary.length, 5)
  assert.equal(gate.softGateCount, 6)
  assert.equal(gate.changesHeaderMissing, true)
  assert.equal(gate.detectionSkipped, true)
  assert.equal(gate.candidateDiverged, true)

  assert.deepEqual(snapshot.driftItems.map(item => item.id), ['drift-1'])
  assert.equal(snapshot.driftItems[0].placeholder, 'oversize')
  assert.equal(snapshot.driftItems[0].restorable, false)
  assert.deepEqual(snapshot.outOfScopeItems.map(item => item.id), ['scope-1'])
  assert.equal(snapshot.errorBar, null)
  assert.equal(snapshot.residuals.length, 1)
  assert.deepEqual(snapshot.residuals[0], {
    residualId: 'residual-1',
    pid: 123,
    startedAt: '2025-12-31T20:00:00.000Z',
    agentKind: 'codex',
    programName: 'codex',
    containerMarked: false,
  })

  assert.equal(snapshot.config.seats[0].profile.text, 'Current profile.')
  assert.equal(snapshot.config.seats.length, 1)
  assert.equal(snapshot.config.profiles, undefined)
  assertNoSecrets(snapshot)
})

test('the project snapshot reports project and instance storage errors', () => {
  const project = sensitiveProject()
  const state = stateWithData()
  state.projectBlockedOn = {
    effectId: 'project-blocked', error: 'PROJECT_STORAGE_FAULT', time: at,
  }
  const projectError = projectSnapshot(project, state).errorBar
  assert.equal(projectError.scope, 'project')
  assert.equal(projectError.effectId, 'project-blocked')
  assert.equal(projectError.retryable, true)

  state.projectBlockedOn = null
  state.instances[0].blockedOn = {
    effectId: 'instance-blocked', error: 'SHADOW_SNAPSHOT_LIMIT', time: at,
  }
  const instanceError = projectSnapshot(project, state).errorBar
  assert.equal(instanceError.scope, 'instance')
  assert.equal(instanceError.checkpointId, 'cp-1')
  assert.equal(instanceError.retryable, true)
})

test('a project without readable state still projects a read-only shell', () => {
  const project = sensitiveProject({ readOnly: true, readOnlyReason: 'corrupt' })
  const snapshot = projectSnapshot(project, null)
  assert.equal(snapshot.readOnly, true)
  assert.equal(snapshot.readOnlyReason, 'corrupt')
  assert.deepEqual(snapshot.progress, [])
  assert.deepEqual(snapshot.gates, [])
  assert.deepEqual(snapshot.driftItems, [])
  assert.deepEqual(snapshot.outOfScopeItems, [])
  assert.equal(snapshot.errorBar, null)
  assert.equal(snapshot.config, null)
  assertNoSecrets(snapshot)
})
