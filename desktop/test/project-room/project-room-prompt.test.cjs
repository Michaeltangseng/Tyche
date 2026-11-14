const test = require('node:test')
const assert = require('node:assert/strict')
const { buildProjectRoomPrompt } = require('../../src/project-room/project-room-prompt.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T00:00:00.000Z'
const commit = 'a'.repeat(40)

function stateFor(language = 'zh') {
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.settings.language = language
  state.config.seats = [{
    id: 'seat-lead', roleName: 'Lead', duty: 'Write.', agentKind: 'codex',
    capabilities: ['read', 'write-workdir'], checkpointRoles: [], profileVersionId: 'profile-1',
  }, {
    id: 'seat-reviewer', roleName: 'Reviewer', duty: 'Review.', agentKind: 'claude',
    capabilities: ['read'], checkpointRoles: [], profileVersionId: 'profile-2',
  }]
  state.config.profiles = [
    { id: 'profile-1', seatId: 'seat-lead', version: 1, text: 'Care about scope.', createdAt: at, source: 'default' },
    { id: 'profile-2', seatId: 'seat-reviewer', version: 1, text: 'Find contradictions.', createdAt: at, source: 'default' },
  ]
  state.config.playbook.checkpointDefs = [{
    key: 'requirements', name: 'Requirements', type: 'document',
    targetFiles: ['docs/requirements.md'], leadSeatId: 'seat-lead',
    reviewerSeatIds: ['seat-reviewer'], draftSeatIds: [], gate: 'hard',
    roundLimit: 3, continuationLimit: 3, producesChecklist: false, dependsOn: [],
  }]
  state.instances = [{
    id: 'cp-1', checkpointKey: 'requirements', state: 'leading', seq: 1, epoch: 0,
    round: 1, roundsSinceHuman: 1, continuations: 0, sessionGeneration: 0,
    candidate: commit, rounds: [{
      round: 1, candidate: commit, rebuttal: true, bodyChanged: false,
      startedAt: at, reviews: [{ seatId: 'seat-reviewer', verdict: 'revise', reviewFile: 'meldwork/reviews/requirements/r1-seat-reviewer.md', finishedAt: at }],
    }], roundsSummary: [], leaseRequests: [], activeInvocations: [], pendingStart: null,
    drafts: [], interjections: [{
      id: 'i-1', content: 'Keep it small.', status: 'queued', createdAt: at, deliveredAt: null,
    }], gate: null, blockedOn: null, effects: [], artifactVersions: [], readVersions: {}, decisions: [],
  }]
  state.driftItems = [{
    id: 'drift-1', revision: 1, path: 'docs/old.md', checkpointId: 'cp-1',
    baseVersionId: null, acceptedCommit: commit, observedCommit: commit,
    foundAt: at, source: 'drift-check', status: 'unresolved', resolvedAt: null,
  }]
  return state
}

test('the lead prompt contains stance, profile, target, and interjections', () => {
  const state = stateFor('zh')
  const prompt = buildProjectRoomPrompt({
    project: { name: 'Project One' },
    state,
    instance: state.instances[0],
    def: state.config.playbook.checkpointDefs[0],
    seat: state.config.seats[0],
    role: 'lead',
    round: 1,
    brief: 'Build a todo app.',
  })
  assert.match(prompt, /主笔/)
  assert.match(prompt, /Care about scope/)
  assert.match(prompt, /docs\/requirements\.md/)
  assert.match(prompt, /Keep it small/)
  assert.match(prompt, /Build a todo app\./)
  assert.match(prompt, /MELDWORK_CHECKPOINT/)
  assert.match(prompt, /未解决漂移/)
})

test('the reviewer prompt explains rebuttal rounds and asks for a summary', () => {
  const state = stateFor('en')
  const prompt = buildProjectRoomPrompt({
    project: { name: 'Project One' },
    state,
    instance: state.instances[0],
    def: state.config.playbook.checkpointDefs[0],
    seat: state.config.seats[1],
    role: 'review',
    round: 1,
  })
  assert.match(prompt, /reviewer/)
  assert.match(prompt, /rebuttal round/)
  assert.match(prompt, /Passing is a valid conclusion/)
  assert.match(prompt, /MELDWORK_REVIEW/)
  assert.match(prompt, /Prior review files/)
  assert.match(prompt, /Candidate commit/)
})
