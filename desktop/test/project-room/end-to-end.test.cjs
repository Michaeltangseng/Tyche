const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { ProjectService } = require('../../src/project-room/project-service.cjs')
const { ShadowRepo } = require('../../src/project-room/shadow-git.cjs')
const { CustomAgentStore } = require('../../src/agents/custom-agent-store.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

const at = '2026-01-01T00:00:00.000Z'
const leadKind = `custom-${'a'.repeat(16)}`
const reviewerKind = `custom-${'b'.repeat(16)}`
const fakeAgent = path.join(__dirname, '..', 'fixtures', 'fake-agent', 'fake-agent.cjs')
const checkpointMarker = '[[MELDWORK_CHECKPOINT:{"signal":"ready"}]]'
const reviewMarker = '[[MELDWORK_REVIEW:{"verdict":"pass"}]]'

function definition(kind, name, scriptPath) {
  return {
    kind,
    label: name,
    description: 'scripted end-to-end agent',
    executable: process.execPath,
    args: [fakeAgent, scriptPath],
    promptMode: 'stdin',
    createdAt: at,
  }
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`)
}

function projectState() {
  const state = emptyProjectState({ projectId: 'project-1' })
  state.config.seats = [{
    id: 'seat-lead', roleName: 'Lead', duty: 'Write.', agentKind: leadKind,
    capabilities: ['read', 'write-workdir'], checkpointRoles: [],
    profileVersionId: 'profile-1',
  }, {
    id: 'seat-reviewer', roleName: 'Reviewer', duty: 'Review.', agentKind: reviewerKind,
    capabilities: ['read', 'write-workdir'], checkpointRoles: [],
    profileVersionId: 'profile-2',
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
  return state
}

async function setup(t, scriptsOverride = {}) {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workdir = path.join(directory, 'work')
  fs.mkdirSync(workdir, { recursive: true })
  const privateRoot = path.join(directory, 'private')
  const scriptsDir = path.join(directory, 'scripts')
  fs.mkdirSync(scriptsDir, { recursive: true })
  const leadScript = path.join(scriptsDir, 'lead.json')
  const reviewScript = path.join(scriptsDir, 'review.json')
  writeJson(leadScript, scriptsOverride.lead || {
    steps: [{ op: 'write', path: 'docs/requirements.md', content: 'Version 1\n' }],
    finalText: 'Draft ready',
    marker: checkpointMarker,
  })
  writeJson(reviewScript, scriptsOverride.review || {
    steps: [],
    finalText: 'Summary: looks good.',
    marker: reviewMarker,
  })
  const agentStore = new CustomAgentStore({
    storagePath: path.join(directory, 'agents.json'),
    platform: process.platform,
  })
  agentStore.definitions = [
    definition(leadKind, 'Fake Lead', leadScript),
    definition(reviewerKind, 'Fake Reviewer', reviewScript),
  ]
  const detected = [leadKind, reviewerKind].map((kind, index) => ({
    kind,
    name: index === 0 ? 'Fake Lead' : 'Fake Reviewer',
    executable: process.execPath,
    version: '1',
    available: true,
  }))
  options.detectAgents = async () => detected
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    if (![leadKind, reviewerKind].includes(agent.kind)) throw new Error('LOCAL_AGENT_UNAVAILABLE')
    const result = await agentStore.run(agent.kind, prompt, workdir, {
      sandbox: runOptions.sandbox,
      signal: runOptions.signal,
    })
    return result
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const mainGroup = workspace.createGroup({
    name: 'Main', agentKinds: [leadKind, reviewerKind], workdir,
    allowWrite: true, projectId: 'project-1', projectRole: 'main',
  })
  const projectDir = path.join(privateRoot, 'projects', 'project-1')
  fs.mkdirSync(projectDir, { recursive: true })
  writeJson(path.join(projectDir, 'state.json'),
    scriptsOverride.initialState ? scriptsOverride.initialState() : projectState())
  await ShadowRepo.create({
    gitDir: path.join(projectDir, 'shadow.git'),
    workTree: workdir,
  })
  workspace.state.projects = [{
    id: 'project-1', name: 'Project One', workdir,
    createdAt: at, updatedAt: at,
  }]
  const scheduler = new RunScheduler()
  const service = new ProjectService({
    workspace,
    privateRoot,
    scheduler,
    templatesStore: { templates: [], get: () => null, load: async () => [], save: async () => null },
    createId: (() => { let id = 0; return () => `id-${id += 1}` })(),
    now: () => at,
    effectHooks: {
      appendDecision: async () => null,
      stampChanges: async () => null,
      writeReviewFile: async () => null,
      notify: async () => null,
    },
  })
  await service.start()
  return { service, workspace, directory, workdir, mainGroup }
}

test('a document checkpoint runs from start to acceptance with fake Agents', async (t) => {
  const { service, workspace, workdir } = await setup(t)
  await service.startProject({ projectId: 'project-1', brief: 'Write the requirements.' })
  const engine = service.engineFor('project-1')
  await engine.runUntilIdle()

  let snapshot = service.snapshot('project-1')
  assert.equal(snapshot.progress[0].state, 'gate')
  assert.equal(snapshot.gates.length, 1)
  assert.equal(snapshot.gates[0].reason, 'hard-gate-passed')

  const gate = snapshot.gates[0]
  await service.decideGate({
    projectId: 'project-1',
    gateId: gate.gateId,
    gateRevision: gate.revision,
    candidateCommit: gate.candidateCommit,
    outcome: 'accept',
    comment: 'Accepted.',
  })
  await engine.runUntilIdle()

  snapshot = service.snapshot('project-1')
  assert.equal(snapshot.progress[0].state, 'accepted')
  const state = service.contextFor('project-1').store.current()
  assert.equal(state.instances[0].artifactVersions.length, 1)
  assert.equal(state.instances[0].artifactVersions[0].source, 'gate')
  assert.equal(
    fs.readFileSync(path.join(workdir, 'docs', 'requirements.md'), 'utf8'),
    'Version 1\n',
  )
  assert.equal(
    fs.existsSync(path.join(workdir, 'meldwork', 'reviews', 'requirements', 'r1-seat-reviewer.md')),
    true,
  )
  const messages = workspace.state.messages.filter(message => message.projectRoom)
  assert.ok(messages.some(message => message.role === 'agent' && message.content === 'Draft ready'))
  assert.ok(messages.some(message => message.role === 'agent' && message.content.includes('looks good')))
  const history = service.timelineHistory('project-1')
  assert.ok(history.items.some(item => item.type === 'checkpoint-start'))
  assert.ok(history.items.some(item => item.type === 'gate-decided'))
})

test('a revise round returns to the lead and passes on the second round', async (t) => {
  const { service, workdir } = await setup(t, {
    lead: {
      steps: [{
        op: 'whenPromptIncludes',
        text: '之前的评审文件',
        then: [
          { op: 'write', path: 'docs/requirements.md', content: 'Version 2\n' },
          { op: 'output', text: 'Revised draft' },
        ],
        otherwise: [
          { op: 'write', path: 'docs/requirements.md', content: 'Version 1\n' },
          { op: 'output', text: 'Draft ready' },
        ],
      }],
      marker: checkpointMarker,
    },
    review: {
      steps: [{
        op: 'whenPromptIncludes',
        text: '之前的评审文件',
        then: [
          { op: 'output', text: 'Summary: revised looks good.' },
          { op: 'marker', value: '[[MELDWORK_REVIEW:{"verdict":"pass"}]]' },
        ],
        otherwise: [
          { op: 'output', text: 'Summary: revise the scope.' },
          { op: 'marker', value: '[[MELDWORK_REVIEW:{"verdict":"revise"}]]' },
        ],
      }],
    },
  })
  await service.startProject({ projectId: 'project-1', brief: 'Write it.' })
  const engine = service.engineFor('project-1')
  await engine.runUntilIdle()

  const state = service.contextFor('project-1').store.current()
  const instance = state.instances[0]
  assert.equal(instance.round, 2)
  assert.equal(instance.state, 'gate')
  assert.equal(instance.gate.reason, 'hard-gate-passed')
  assert.equal(
    fs.readFileSync(path.join(workdir, 'docs', 'requirements.md'), 'utf8'),
    'Version 2\n',
  )
  assert.equal(instance.rounds.length, 2)
  assert.equal(instance.rounds[0].reviews[0].verdict, 'revise')
  assert.equal(instance.rounds[1].reviews[0].verdict, 'pass')
})

test('needs-human gate continues the same checkpoint after a person answers', async (t) => {
  const { service, workdir } = await setup(t, {
    lead: {
      steps: [{
        op: 'whenPromptIncludes',
        text: 'Fix the scope.',
        then: [
          { op: 'write', path: 'docs/requirements.md', content: 'Version 2\n' },
          { op: 'output', text: 'Fixed draft' },
        ],
        otherwise: [
          { op: 'write', path: 'docs/requirements.md', content: 'Version 1\n' },
          { op: 'output', text: 'Draft ready' },
        ],
      }],
      marker: checkpointMarker,
    },
    review: {
      steps: [{
        op: 'whenPromptIncludes',
        text: '之前的评审文件',
        then: [
          { op: 'output', text: 'Summary: fixed.' },
          { op: 'marker', value: '[[MELDWORK_REVIEW:{"verdict":"pass"}]]' },
        ],
        otherwise: [
          { op: 'output', text: 'Summary: needs a human.' },
          { op: 'marker', value: '[[MELDWORK_REVIEW:{"verdict":"needs-human"}]]' },
        ],
      }],
    },
  })
  await service.startProject({ projectId: 'project-1', brief: 'Write it.' })
  const engine = service.engineFor('project-1')
  await engine.runUntilIdle()
  let gate = service.snapshot('project-1').gates[0]
  assert.equal(gate.reason, 'needs-human')

  await service.decideGate({
    projectId: 'project-1', gateId: gate.gateId, gateRevision: gate.revision,
    candidateCommit: gate.candidateCommit, outcome: 'continue',
    comment: 'Fix the scope.',
  })
  await engine.runUntilIdle()
  const state = service.contextFor('project-1').store.current()
  assert.equal(state.instances[0].gate.reason, 'hard-gate-passed')
  assert.equal(
    fs.readFileSync(path.join(workdir, 'docs', 'requirements.md'), 'utf8'),
    'Version 2\n',
  )
})

test('a lead question becomes a gate and the answer continues the same checkpoint', async (t) => {
  const { service, workdir } = await setup(t, {
    lead: {
      steps: [{
        op: 'whenPromptIncludes',
        text: 'Keep the scope small.',
        then: [
          { op: 'write', path: 'docs/requirements.md', content: 'Version 1\n' },
          { op: 'output', text: 'Draft ready' },
          { op: 'marker', value: checkpointMarker },
        ],
        otherwise: [
          { op: 'output', text: 'Question: which scope?' },
          { op: 'marker', value: '[[MELDWORK_CHECKPOINT:{"signal":"question"}]]' },
        ],
      }],
    },
  })
  await service.startProject({ projectId: 'project-1', brief: 'Write it.' })
  const engine = service.engineFor('project-1')
  await engine.runUntilIdle()
  let gate = service.snapshot('project-1').gates[0]
  assert.equal(gate.reason, 'question')

  await service.decideGate({
    projectId: 'project-1', gateId: gate.gateId, gateRevision: gate.revision,
    candidateCommit: gate.candidateCommit, outcome: 'continue',
    comment: 'Keep the scope small.',
  })
  await engine.runUntilIdle()
  const state = service.contextFor('project-1').store.current()
  assert.equal(state.instances[0].gate.reason, 'hard-gate-passed')
  assert.equal(
    fs.readFileSync(path.join(workdir, 'docs', 'requirements.md'), 'utf8'),
    'Version 1\n',
  )
})

test('the round limit stops a reviewer that keeps asking for changes', async (t) => {
  const { service } = await setup(t, {
    lead: {
      steps: [{
        op: 'run',
        command: process.execPath,
        args: ['-e', "const fs=require('node:fs');fs.mkdirSync('docs',{recursive:true});fs.appendFileSync('docs/requirements.md','x\\n')"],
      }],
      marker: checkpointMarker,
    },
    review: {
      steps: [
        { op: 'output', text: 'Summary: still changing.' },
        { op: 'marker', value: '[[MELDWORK_REVIEW:{"verdict":"revise"}]]' },
      ],
    },
  })
  await service.startProject({ projectId: 'project-1', brief: 'Write it.' })
  const engine = service.engineFor('project-1')
  await engine.runUntilIdle()
  const state = service.contextFor('project-1').store.current()
  assert.equal(state.instances[0].state, 'gate')
  assert.equal(state.instances[0].gate.reason, 'round-limit')
  assert.equal(state.instances[0].round, 3)
})

test('a rebuttal round that is not accepted goes to a human gate', async (t) => {
  const { service, workdir } = await setup(t, {
    lead: {
      steps: [{
        op: 'whenPromptIncludes',
        text: '之前的评审文件',
        then: [
          { op: 'write', path: 'meldwork/reviews/requirements/r1-response.md', content: 'Rejected all findings.\n' },
          { op: 'output', text: 'Rejected all findings.' },
        ],
        otherwise: [
          { op: 'write', path: 'docs/requirements.md', content: 'Version 1\n' },
          { op: 'output', text: 'Draft ready' },
        ],
      }],
      marker: checkpointMarker,
    },
    review: {
      steps: [{
        op: 'whenPromptIncludes',
        text: '驳回轮',
        then: [
          { op: 'output', text: 'Summary: insist on the changes.' },
          { op: 'marker', value: '[[MELDWORK_REVIEW:{"verdict":"revise"}]]' },
        ],
        otherwise: [
          { op: 'output', text: 'Summary: revise.' },
          { op: 'marker', value: '[[MELDWORK_REVIEW:{"verdict":"revise"}]]' },
        ],
      }],
    },
  })
  await service.startProject({ projectId: 'project-1', brief: 'Write it.' })
  const engine = service.engineFor('project-1')
  await engine.runUntilIdle()
  const state = service.contextFor('project-1').store.current()
  assert.equal(state.instances[0].state, 'gate')
  assert.equal(state.instances[0].gate.reason, 'rebuttal-rejected')
  assert.equal(
    fs.readFileSync(path.join(workdir, 'docs', 'requirements.md'), 'utf8'),
    'Version 1\n',
  )
})

test('an interjection is delivered to the lead before acceptance', async (t) => {
  const { service, workdir } = await setup(t, {
    lead: {
      steps: [{
        op: 'run',
        command: process.execPath,
        args: ['-e', "const fs=require('node:fs');fs.mkdirSync('docs',{recursive:true});fs.appendFileSync('docs/requirements.md','line\\n')"],
      }],
      marker: checkpointMarker,
    },
    review: {
      steps: [],
      finalText: 'Summary: pass.',
      marker: reviewMarker,
    },
  })
  await service.startProject({ projectId: 'project-1', brief: 'Write it.' })
  await service.interject({
    projectId: 'project-1', checkpointId: 'id-1', text: 'Keep it small.',
  })
  const engine = service.engineFor('project-1')
  await engine.runUntilIdle()
  const state = service.contextFor('project-1').store.current()
  assert.equal(state.instances[0].interjections[0].status, 'delivered')
  assert.equal(state.instances[0].gate.reason, 'hard-gate-passed')
  assert.equal(
    fs.readFileSync(path.join(workdir, 'docs', 'requirements.md'), 'utf8'),
    'line\nline\n',
  )
})

test('reopening an accepted checkpoint starts a new generation', async (t) => {
  const { service } = await setup(t)
  await service.startProject({ projectId: 'project-1', brief: 'Write it.' })
  const engine = service.engineFor('project-1')
  await engine.runUntilIdle()
  let gate = service.snapshot('project-1').gates[0]
  await service.decideGate({
    projectId: 'project-1', gateId: gate.gateId, gateRevision: gate.revision,
    candidateCommit: gate.candidateCommit, outcome: 'accept',
  })
  await engine.runUntilIdle()
  const accepted = service.contextFor('project-1').store.current().instances[0]
  assert.equal(accepted.state, 'accepted')

  const preview = service.previewReopen({
    projectId: 'project-1', checkpointId: accepted.id,
  })
  await service.reopen({
    projectId: 'project-1', checkpointId: accepted.id,
    reason: 'Revisit requirements.', impactHash: preview.impactHash,
  })
  await engine.runUntilIdle()
  const reopened = service.contextFor('project-1').store.current().instances[0]
  assert.equal(reopened.state, 'gate')
  assert.equal(reopened.epoch, 1)
  assert.equal(reopened.sessionGeneration, 1)
  assert.ok(reopened.decisions.some(decision => decision.outcome === 'accept'))
})

test('rejecting a gate to an upstream checkpoint reopens the upstream and stales downstream', async (t) => {
  const { service, workdir } = await setup(t, {
    initialState: () => {
      const state = projectState()
      state.config.playbook.checkpointDefs.push({
        key: 'design', name: 'Design', type: 'document',
        targetFiles: ['docs/design.md'], leadSeatId: 'seat-lead',
        reviewerSeatIds: ['seat-reviewer'], draftSeatIds: [], gate: 'hard',
        roundLimit: 3, continuationLimit: 3, producesChecklist: false,
        dependsOn: ['requirements'],
      })
      return state
    },
    lead: {
      steps: [{
        op: 'whenPromptIncludes',
        text: 'design.md',
        then: [
          { op: 'write', path: 'docs/design.md', content: 'Design 1\n' },
          { op: 'output', text: 'Design ready' },
        ],
        otherwise: [
          { op: 'write', path: 'docs/requirements.md', content: 'Version 1\n' },
          { op: 'output', text: 'Draft ready' },
        ],
      }],
      marker: checkpointMarker,
    },
  })
  await service.startProject({ projectId: 'project-1', brief: 'Write it.' })
  const engine = service.engineFor('project-1')
  await engine.runUntilIdle()
  const store = service.contextFor('project-1').store
  const requirementsId = store.current().instances[0].id
  let gate = service.snapshot('project-1').gates[0]
  await service.decideGate({
    projectId: 'project-1', gateId: gate.gateId, gateRevision: gate.revision,
    candidateCommit: gate.candidateCommit, outcome: 'accept',
  })
  await engine.runUntilIdle()

  await store.enqueue((state) => {
    state.instances.push({
      id: 'design-1', checkpointKey: 'design', state: 'pending', seq: 0, epoch: 0,
      round: 0, roundsSinceHuman: 0, continuations: 0, sessionGeneration: 0,
      candidate: null, rounds: [], roundsSummary: [], leaseRequests: [],
      activeInvocations: [], pendingStart: null, drafts: [], interjections: [],
      gate: null, blockedOn: null, effects: [], artifactVersions: [],
      readVersions: {}, decisions: [],
    })
    return { next: state }
  })
  await engine.advanceProgress()
  await engine.runUntilIdle()
  gate = service.snapshot('project-1').gates.find(item => item.checkpointId === 'design-1')
  assert.equal(gate.reason, 'hard-gate-passed')

  const preview = service.previewReject({
    projectId: 'project-1', checkpointId: 'design-1', upstreamId: requirementsId,
  })
  await service.decideGate({
    projectId: 'project-1', gateId: gate.gateId, gateRevision: gate.revision,
    candidateCommit: gate.candidateCommit, outcome: 'reject-upstream',
    upstreamCheckpointId: requirementsId, impactHash: preview.impactHash,
    comment: 'The requirements must change.',
  })
  await engine.runUntilIdle()

  const requirements = store.current().instances.find(item => item.id === requirementsId)
  const design = store.current().instances.find(item => item.id === 'design-1')
  assert.equal(design.state, 'stale')
  assert.equal(requirements.epoch, 1)
  assert.equal(requirements.sessionGeneration, 1)
  assert.ok(['gate', 'leading', 'checking'].includes(requirements.state))
  assert.ok(fs.existsSync(path.join(workdir, 'docs', 'design.md')))
})

test('accepting a diverged candidate records unresolved drift', async (t) => {
  const { service, workdir } = await setup(t)
  await service.startProject({ projectId: 'project-1', brief: 'Write it.' })
  const engine = service.engineFor('project-1')
  await engine.runUntilIdle()
  const gate = service.snapshot('project-1').gates[0]
  fs.appendFileSync(path.join(workdir, 'docs', 'requirements.md'), 'external change\n')

  await assert.rejects(service.decideGate({
    projectId: 'project-1', gateId: gate.gateId, gateRevision: gate.revision,
    candidateCommit: gate.candidateCommit, outcome: 'accept',
  }), { code: 'PROJECT_CANDIDATE_DIVERGED' })

  await service.decideGate({
    projectId: 'project-1', gateId: gate.gateId, gateRevision: gate.revision,
    candidateCommit: gate.candidateCommit, outcome: 'accept', acceptCandidate: true,
  })
  await engine.runUntilIdle()
  const state = service.contextFor('project-1').store.current()
  assert.equal(state.instances[0].state, 'accepted')
  assert.equal(state.driftItems.length, 1)
  assert.equal(state.driftItems[0].path, 'docs/requirements.md')
  assert.equal(state.driftItems[0].source, 'accept-candidate')
  assert.equal(state.driftItems[0].status, 'unresolved')
  assert.equal(state.driftItems[0].acceptedCommit, gate.candidateCommit)
})

test('restarting with an interrupted writable call opens a recovery gate', async (t) => {
  const { service } = await setup(t, {
    initialState: () => {
      const state = projectState()
      state.instances = [{
        id: 'cp-1', checkpointKey: 'requirements', state: 'leading', seq: 1, epoch: 1,
        round: 0, roundsSinceHuman: 0, continuations: 0, sessionGeneration: 0,
        candidate: null, rounds: [], roundsSummary: [], leaseRequests: [],
        activeInvocations: [{
          effectId: 'invoke-started', role: 'lead', seatId: 'seat-lead',
          agentKind: leadKind, round: 0, sessionGeneration: 0, claims: [],
          cancellationRequested: false, processRegistryId: null,
        }],
        pendingStart: null, drafts: [], interjections: [], gate: null,
        blockedOn: null, effects: [{
          id: 'invoke-started', type: 'invoke-lead', category: 'invocation',
          status: 'started', epoch: 1, params: {}, result: null, error: null,
          startedAt: at, finishedAt: null,
        }], artifactVersions: [], readVersions: {}, decisions: [],
      }]
      return state
    },
  })
  const snapshot = service.snapshot('project-1')
  assert.equal(snapshot.progress[0].state, 'gate')
  assert.equal(snapshot.gates[0].reason, 'recovery')
  const state = service.contextFor('project-1').store.current()
  assert.deepEqual(state.instances[0].activeInvocations, [])
})
