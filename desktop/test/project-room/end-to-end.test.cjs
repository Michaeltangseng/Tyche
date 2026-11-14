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

async function setup(t) {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const scripts = path.join(directory, 'scripts')
  fs.mkdirSync(scripts, { recursive: true })
  const leadScript = path.join(scripts, 'lead.json')
  const reviewScript = path.join(scripts, 'review.json')
  writeJson(leadScript, {
    steps: [{ op: 'write', path: 'docs/requirements.md', content: 'Version 1\n' }],
    finalText: 'Draft ready',
    marker: checkpointMarker,
  })
  writeJson(reviewScript, {
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
    return agentStore.run(agent.kind, prompt, workdir, {
      sandbox: runOptions.sandbox,
      signal: runOptions.signal,
    })
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const mainGroup = workspace.createGroup({
    name: 'Main', agentKinds: [leadKind, reviewerKind], workdir: directory,
    allowWrite: true, projectId: 'project-1', projectRole: 'main',
  })
  const privateRoot = path.join(directory, 'meldwork-private')
  const projectDir = path.join(privateRoot, 'projects', 'project-1')
  fs.mkdirSync(projectDir, { recursive: true })
  writeJson(path.join(projectDir, 'state.json'), projectState())
  await ShadowRepo.create({
    gitDir: path.join(projectDir, 'shadow.git'),
    workTree: directory,
  })
  workspace.state.projects = [{
    id: 'project-1', name: 'Project One', workdir: directory,
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
  return { service, workspace, directory, mainGroup }
}

test('a document checkpoint runs from start to acceptance with fake Agents', async (t) => {
  const { service, workspace, directory } = await setup(t)
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
    fs.readFileSync(path.join(directory, 'docs', 'requirements.md'), 'utf8'),
    'Version 1\n',
  )
  assert.equal(
    fs.existsSync(path.join(directory, 'meldwork', 'reviews', 'requirements', 'r1-seat-reviewer.md')),
    true,
  )
  const messages = workspace.state.messages.filter(message => message.projectRoom)
  assert.ok(messages.some(message => message.role === 'agent' && message.content === 'Draft ready'))
  assert.ok(messages.some(message => message.role === 'agent' && message.content.includes('looks good')))
  const history = service.timelineHistory('project-1')
  assert.ok(history.items.some(item => item.type === 'checkpoint-start'))
  assert.ok(history.items.some(item => item.type === 'gate-decided'))
})
