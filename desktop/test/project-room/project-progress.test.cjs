const test = require('node:test')
const assert = require('node:assert/strict')
const {
  acceptanceBlockers,
  blockersDelta,
  dependenciesAccepted,
  impactHash,
  impactPreview,
  instantiateChecklist,
  startableInstances,
  validateManifest,
} = require('../../src/project-room/project-progress.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T00:00:00.000Z'
const commit = 'a'.repeat(40)

function def(key, overrides = {}) {
  return {
    key,
    name: key,
    type: 'document',
    targetFiles: [`docs/${key}.md`],
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

function instance(id, key, state, overrides = {}) {
  return {
    id,
    checkpointKey: key,
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
  return state
}

function withInstances(state, instances) {
  const next = structuredClone(state)
  next.instances = instances
  return next
}

test('pending instances start only after every upstream is accepted', () => {
  const state = baseState()
  state.config.playbook.checkpointDefs = [
    def('a'),
    def('b', { dependsOn: ['a'] }),
    def('c', { dependsOn: ['b'] }),
    def('loose'),
  ]
  const next = withInstances(state, [
    instance('cp-a', 'a', 'accepted'),
    instance('cp-b', 'b', 'pending'),
    instance('cp-c', 'c', 'pending'),
    instance('cp-loose', 'loose', 'pending'),
    instance('cp-read', 'd', 'pending', { readVersions: { 'cp-a': 'av-1' } }),
  ])
  next.config.playbook.checkpointDefs.push(def('d'))
  assert.deepEqual(startableInstances(next), ['cp-b', 'cp-read', 'cp-loose'])
  assert.equal(dependenciesAccepted(next, next.instances[1]), true)
  assert.equal(dependenciesAccepted(next, next.instances[2]), false)

  next.instances[0].state = 'stale'
  assert.equal(dependenciesAccepted(next, next.instances[1]), false)
})

test('checklist instantiation adds defs and instances idempotently', () => {
  const state = baseState()
  const manifest = [
    {
      key: 'module-1', name: 'Module 1', type: 'document',
      targetFiles: ['docs/module-1.md'], leadSeatId: 'seat-lead',
      reviewerSeatIds: ['seat-reviewer'], draftSeatIds: [],
      gate: 'soft', producesChecklist: false, dependsOn: [],
    },
    {
      key: 'module-2', name: 'Module 2', type: 'document',
      targetFiles: ['docs/module-2.md'], leadSeatId: 'seat-lead',
      reviewerSeatIds: ['seat-reviewer'], draftSeatIds: [],
      gate: 'hard', producesChecklist: false, dependsOn: ['module-1'],
    },
  ]
  assert.deepEqual(validateManifest(state, manifest), { valid: true, issues: [] })
  let id = 0
  const first = instantiateChecklist(state, {
    manifest,
    createId: () => `cp-${id += 1}`,
  })
  assert.deepEqual(first.createdInstanceIds, ['cp-1', 'cp-2'])
  assert.deepEqual(
    first.state.config.playbook.checkpointDefs.map(item => item.key),
    ['module-1', 'module-2'],
  )
  assert.deepEqual(first.state.instances.map(item => item.checkpointKey), ['module-1', 'module-2'])
  assert.equal(first.state.config.configRevision, 1)

  const second = instantiateChecklist(first.state, {
    manifest,
    createId: () => `cp-${id += 1}`,
  })
  assert.deepEqual(second.createdInstanceIds, [])
  assert.equal(second.state.instances.length, 2)
})

test('invalid checklists are rejected before any instance is created', () => {
  const state = baseState()
  const invalid = [
    { key: 'dup', type: 'document', leadSeatId: 'seat-lead' },
    { key: 'dup', type: 'document', leadSeatId: 'seat-lead' },
  ]
  const validation = validateManifest(state, invalid)
  assert.equal(validation.valid, false)
  assert.ok(validation.issues.some(issue => issue.code === 'MANIFEST_KEY_INVALID'))

  const cases = [
    [{ key: 'a', type: 'unknown', leadSeatId: 'seat-lead' }, 'MANIFEST_TYPE_INVALID'],
    [{ key: 'a', type: 'document', leadSeatId: 'missing-seat' }, 'MANIFEST_SEAT_INVALID'],
    [{ key: 'a', type: 'document', leadSeatId: 'seat-lead', dependsOn: ['missing'] }, 'MANIFEST_DEPENDENCY_INVALID'],
  ]
  for (const [item, code] of cases) {
    assert.throws(() => instantiateChecklist(state, { manifest: [item] }), (error) => {
      assert.equal(error.code, 'PROJECT_INPUT_INVALID')
      assert.ok(error.details.issues.some(issue => issue.code === code))
      return true
    })
    assert.equal(state.instances.length, 0)
  }
})

test('impact preview follows dependencies and read versions transitively', () => {
  const state = baseState()
  state.config.playbook.checkpointDefs = [
    def('a'),
    def('b', { dependsOn: ['a'] }),
    def('c', { dependsOn: ['b'] }),
    def('unrelated'),
  ]
  state.instances = [
    instance('cp-a', 'a', 'accepted'),
    instance('cp-b', 'b', 'leading', {
      activeInvocations: [{
        effectId: 'inv-b', role: 'lead', seatId: 'seat-lead', agentKind: 'codex',
        round: 1, sessionGeneration: 0, claims: [], cancellationRequested: false,
        processRegistryId: null,
      }],
    }),
    instance('cp-c', 'c', 'pending'),
    instance('cp-d', 'd', 'accepted', { readVersions: { 'cp-a': 'av-a' } }),
    instance('cp-unrelated', 'unrelated', 'pending'),
  ]
  state.config.playbook.checkpointDefs.push(def('d'))
  const preview = impactPreview(state, 'cp-a')
  assert.deepEqual(preview.affectedCheckpointIds, ['cp-b', 'cp-c', 'cp-d'])
  assert.deepEqual(preview.activeInvocationEffectIds, ['inv-b'])
  assert.match(preview.impactHash, /^[a-f0-9]{64}$/)

  const reordered = structuredClone(state)
  reordered.instances.reverse()
  assert.equal(impactPreview(reordered, 'cp-a').impactHash, preview.impactHash)

  const changed = structuredClone(state)
  changed.instances = changed.instances.filter(item => item.id !== 'cp-d')
  assert.notEqual(impactPreview(changed, 'cp-a').impactHash, preview.impactHash)
  assert.equal(
    impactHash('cp-a', ['cp-b', 'cp-c'], []),
    impactHash('cp-a', ['cp-c', 'cp-b'], []),
  )
  assert.throws(() => impactPreview(state, 'missing'), { code: 'PROJECT_INPUT_INVALID' })
})

test('acceptance blockers include upstream versions, drift, and the detection barrier', () => {
  const state = baseState()
  state.config.playbook.checkpointDefs = [def('a'), def('b', { dependsOn: ['a'] })]
  state.instances = [
    instance('cp-a', 'a', 'accepted', { gate: { id: 'gate-a', revision: 1, reason: 'doc-new-version', candidateCommit: commit, createdAt: at, firstScreen: {} } }),
    instance('cp-b', 'b', 'gate'),
  ]
  let blockers = acceptanceBlockers(state, 'cp-b')
  assert.equal(blockers.blocked, true)
  assert.ok(blockers.blockers.some(item => item.type === 'doc-new-version'))

  state.instances[0].gate = null
  state.driftItems = [{
    id: 'drift-1', revision: 1, path: 'docs/a.md', checkpointId: 'cp-a',
    baseVersionId: null, acceptedCommit: commit, observedCommit: commit,
    foundAt: at, source: 'drift-check', status: 'unresolved', resolvedAt: null,
  }]
  blockers = acceptanceBlockers(state, 'cp-b')
  assert.ok(blockers.blockers.some(item => item.type === 'drift'))

  state.driftItems[0].status = 'resolved'
  blockers = acceptanceBlockers(state, 'cp-b')
  assert.equal(blockers.blocked, false)

  state.chatWriteChecks = {
    'run-1': {
      groupId: 'group-1', status: 'running', snapshotCommit: null,
      baseVersions: null, failure: null,
    },
  }
  blockers = acceptanceBlockers(state, 'cp-b')
  assert.ok(blockers.blockers.some(item => item.type === 'detection'))

  state.chatWriteChecks = {}
  state.projectEffects = [{
    id: 'effect-1', type: 'detect-accepted-changes', category: 'required',
    status: 'pending', params: {}, result: null, error: null,
    startedAt: null, finishedAt: null,
  }]
  blockers = acceptanceBlockers(state, 'cp-b')
  assert.ok(blockers.blockers.some(item => item.type === 'detection'))
})

test('blocker deltas produce upstream blocker events only when signatures change', () => {
  const state = baseState()
  state.config.playbook.checkpointDefs = [def('a'), def('b', { dependsOn: ['a'] })]
  state.instances = [
    instance('cp-a', 'a', 'accepted', { gate: { id: 'gate-a', revision: 1, reason: 'doc-new-version', candidateCommit: commit, createdAt: at, firstScreen: {} } }),
    instance('cp-b', 'b', 'gate'),
    instance('cp-c', 'c', 'pending'),
  ]
  state.config.playbook.checkpointDefs.push(def('c'))

  const cleared = structuredClone(state)
  cleared.instances[0].gate = null
  const delta = blockersDelta(state, cleared)
  assert.deepEqual(delta.changedCheckpointIds, ['cp-b'])
  assert.ok(delta.events.every(event => event.type === 'UPSTREAM_BLOCKERS_CHANGED'))

  const unchanged = blockersDelta(cleared, structuredClone(cleared))
  assert.deepEqual(unchanged.changedCheckpointIds, [])
  assert.deepEqual(unchanged.events, [])

  const added = structuredClone(cleared)
  added.instances.push(instance('cp-new', 'new', 'pending'))
  added.config.playbook.checkpointDefs.push(def('new'))
  const addedDelta = blockersDelta(cleared, added)
  assert.deepEqual(addedDelta.changedCheckpointIds, ['cp-new'])
})
