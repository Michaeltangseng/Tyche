const test = require('node:test')
const assert = require('node:assert/strict')
const { buildProjectChatContext } = require('../../src/project-room/project-chat-context.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T00:00:00.000Z'
const commit = 'a'.repeat(40)

function stateWithDocs() {
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.playbook.checkpointDefs = [
    {
      key: 'requirements', name: 'Requirements', type: 'document',
      targetFiles: ['docs/requirements.md'], leadSeatId: 'seat-1', reviewerSeatIds: [],
      draftSeatIds: [], gate: 'hard', roundLimit: 3, continuationLimit: 3,
      producesChecklist: false, dependsOn: [],
    },
    {
      key: 'design', name: 'Design', type: 'document',
      targetFiles: ['docs/design.md'], leadSeatId: 'seat-1', reviewerSeatIds: [],
      draftSeatIds: [], gate: 'hard', roundLimit: 3, continuationLimit: 3,
      producesChecklist: false, dependsOn: [],
    },
  ]
  state.instances = [
    {
      id: 'cp-1', checkpointKey: 'requirements', state: 'accepted', seq: 1, epoch: 0,
      round: 1, roundsSinceHuman: 1, continuations: 0, sessionGeneration: 0,
      candidate: null, rounds: [], roundsSummary: [], leaseRequests: [],
      activeInvocations: [], pendingStart: null, drafts: [], interjections: [],
      gate: null, blockedOn: null, effects: [],
      artifactVersions: [{
        id: 'av-1', commit, candidateCommit: null, files: ['docs/requirements.md'],
        acceptedAt: at, source: 'gate', decisionId: null,
      }],
      readVersions: {}, decisions: [],
    },
    {
      id: 'cp-2', checkpointKey: 'design', state: 'accepted', seq: 1, epoch: 0,
      round: 1, roundsSinceHuman: 1, continuations: 0, sessionGeneration: 0,
      candidate: null, rounds: [], roundsSummary: [], leaseRequests: [],
      activeInvocations: [], pendingStart: null, drafts: [], interjections: [],
      gate: {
        id: 'gate-1', revision: 1, reason: 'doc-new-version', candidateCommit: null,
        createdAt: at, firstScreen: {
          round: 0, elapsedMs: 0, signals: [], reviewSummaries: [], changedFiles: [],
          softGateSummary: [], driftItemIds: [], outOfScopeItemIds: [],
          blockerCheckpointIds: [], changesHeaderMissing: false,
          detectionSkipped: false, candidateDiverged: false,
        },
      },
      blockedOn: null, effects: [],
      artifactVersions: [{
        id: 'av-2', commit, candidateCommit: null, files: ['docs/design.md'],
        acceptedAt: at, source: 'gate', decisionId: null,
      }],
      readVersions: {}, decisions: [],
    },
  ]
  state.driftItems = [{
    id: 'drift-1', revision: 1, path: 'docs/requirements.md', checkpointId: 'cp-1',
    baseVersionId: 'av-1', acceptedCommit: commit, observedCommit: commit,
    foundAt: at, source: 'drift-check', status: 'unresolved', resolvedAt: null,
  }]
  return state
}

test('the project chat context lists accepted documents and changes since the last read', () => {
  const state = stateWithDocs()
  state.chatReads = { 'group-1': { 'cp-1': 'av-old' } }
  const context = buildProjectChatContext({
    project: { id: 'project-1', name: 'Project One' },
    state,
    groupId: 'group-1',
    language: 'zh',
  })
  assert.match(context.text, /项目室：Project One/)
  assert.match(context.text, /docs\/requirements\.md/)
  assert.match(context.text, /docs\/design\.md/)
  assert.match(context.text, /待确认的新版本/)
  assert.match(context.text, /有未解决漂移/)
  assert.match(context.text, /自这个群聊上次读取以来的变化/)
  assert.deepEqual(context.versions, { 'cp-1': 'av-1', 'cp-2': 'av-2' })
  assert.equal(context.changeCount, 2)
})

test('the context is bilingual and caps documents and changes', () => {
  const state = stateWithDocs()
  const english = buildProjectChatContext({
    project: { id: 'project-1', name: 'Project One' },
    state,
    groupId: 'group-1',
    language: 'en',
  })
  assert.match(english.text, /Project room context/)
  assert.match(english.text, /Accepted documents/)
  assert.match(english.text, /Changes since this chat last read them/)

  state.chatReads = { 'group-1': { 'cp-1': 'av-1', 'cp-2': 'av-2' } }
  const unchanged = buildProjectChatContext({
    project: { id: 'project-1', name: 'Project One' },
    state,
    groupId: 'group-1',
  })
  assert.equal(unchanged.changeCount, 0)
  assert.equal(unchanged.text.includes('自这个群聊上次读取以来的变化'), false)
})
