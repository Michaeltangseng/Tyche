const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { ProjectService } = require('../../src/project-room/project-service.cjs')
const { ProjectStore } = require('../../src/project-room/project-store.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

const at = '2026-01-01T00:00:00.000Z'
const commit = 'a'.repeat(40)

function projectState() {
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.seats = [
    {
      id: 'seat-lead', roleName: 'Lead', duty: 'Write.', agentKind: 'codex',
      capabilities: ['read', 'write-workdir'], checkpointRoles: [],
      profileVersionId: 'profile-1',
    },
    {
      id: 'seat-reviewer', roleName: 'Reviewer', duty: 'Review.', agentKind: 'codex',
      capabilities: ['read'], checkpointRoles: [], profileVersionId: 'profile-2',
    },
  ]
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
    candidate: commit, rounds: [], roundsSummary: [], leaseRequests: [],
    activeInvocations: [], pendingStart: null, drafts: [], interjections: [],
    gate: null, blockedOn: null, effects: [], artifactVersions: [],
    readVersions: {}, decisions: [],
  }]
  return state
}

async function setup(t, replies) {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const calls = []
  let index = 0
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent: agent.kind, prompt, runOptions })
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    return { text: reply, sessionRef: 'session-1', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Main', agentKinds: ['codex'], workdir: directory,
    allowWrite: true, projectId: 'project-1', projectRole: 'main',
  })
  const privateRoot = path.join(directory, 'meldwork-private')
  const projectDir = path.join(privateRoot, 'projects', 'project-1')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'state.json'), `${JSON.stringify(projectState())}\n`)
  const store = new ProjectStore({ projectDir, now: () => at })
  await store.load()
  const service = new ProjectService({
    workspace,
    privateRoot,
    scheduler: new RunScheduler(),
    templatesStore: { templates: [], get: () => null, load: async () => [], save: async () => null },
    createId: (() => { let id = 0; return () => `id-${id += 1}` })(),
    now: () => at,
  })
  service.projects.set('project-1', {
    project: { id: 'project-1', workdir: directory },
    store,
    shadowRepo: null,
    engine: null,
    readOnly: false,
    readOnlyReason: '',
  })
  return { service, workspace, group, directory, calls }
}

test('the project-room invoke adapter builds prompts and parses lead markers', async (t) => {
  const { service, calls } = await setup(t, [
    'Lead answer\n[[MELDWORK_CHECKPOINT:{"signal":"ready"}]]',
  ])
  const result = await service.invokeProjectAgent({
    effect: { id: 'effect-lead' },
    projectId: 'project-1',
    checkpointId: 'cp-1',
    role: 'lead',
    seatId: 'seat-lead',
    round: 1,
    sessionGeneration: 0,
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0].prompt, /主笔/)
  assert.match(calls[0].prompt, /Care about scope/)
  assert.equal(calls[0].runOptions.sandbox, 'workspace-write')
  assert.equal(result.marker, 'ready')
  assert.equal(result.pendingMessage.body, 'Lead answer')
  assert.equal(result.pendingMessage.metadata.projectRoom.role, 'lead')
  assert.equal(result.pendingMessage.metadata.projectRoom.signal, 'ready')
})

test('the project-room invoke adapter writes reviewer files and parses verdicts', async (t) => {
  const { service, directory } = await setup(t, [
    'Summary: looks good.\n[[MELDWORK_REVIEW:{"verdict":"pass"}]]',
  ])
  // The reviewer uses the second Agent kind; make the leader call unused.
  const result = await service.invokeProjectAgent({
    effect: { id: 'effect-review' },
    projectId: 'project-1',
    checkpointId: 'cp-1',
    role: 'reviewer',
    seatId: 'seat-reviewer',
    round: 1,
    sessionGeneration: 0,
  })
  assert.equal(result.marker, 'pass')
  assert.equal(result.pendingMessage.body, 'Summary: looks good.')
  assert.equal(
    result.pendingMessage.metadata.projectRoom.reviewFile,
    'meldwork/reviews/requirements/r1-seat-reviewer.md',
  )
  const review = fs.readFileSync(
    path.join(directory, 'meldwork', 'reviews', 'requirements', 'r1-seat-reviewer.md'),
    'utf8',
  )
  assert.equal(review, 'Summary: looks good.\n')
})
