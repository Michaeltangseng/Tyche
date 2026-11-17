const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')
const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createRoomService } = require('../../src/room-engine/room-service.cjs')
const { createControllerAgent } = require('../../src/room-engine/controller-agent.cjs')
const { createRoomNativeRuntime } = require('../../src/room-engine/native-runtime.cjs')
const { createArtifactSnapshots } = require('../../src/room-engine/artifact-snapshots.cjs')

test('native role permissions select workspace-write or read-only execution', async t => {
  const s = await setup(t)
  const writerId = s.repository.createAgentRole({
    chatId: s.chatId, displayName: 'Writer', provider: 'codex',
    nativePermission: 'workspace-write', createdBy: 'user',
  })
  const readerId = s.repository.createAgentRole({
    chatId: s.chatId, displayName: 'Reader', provider: 'codex',
    nativePermission: 'read-only', createdBy: 'user',
  })
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  t.after(() => service.close())
  const create = roleId => {
    const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Work', createdBy: 'user' })
    return s.repository.createAssignment({ taskId, roleId })
  }
  await service.startAssignment({ assignmentId: create(writerId), prompt: 'Write' }).promise
  await service.startAssignment({ assignmentId: create(readerId), prompt: 'Read' }).promise
  assert.equal(s.calls[0].runOptions.sandbox, 'workspace-write')
  assert.equal(s.calls[0].runOptions.nativePermission, 'workspace-write')
  assert.equal(s.calls[0].workdir, fs.realpathSync.native(s.directory))
  assert.equal(s.calls[1].runOptions.sandbox, 'read-only')
  assert.equal(s.calls[1].runOptions.nativePermission, 'read-only')
  const target = s.runtime.resolveTarget({ roomId: s.roomId, chatId: s.chatId, assignment: { workspace: s.directory, provider: 'codex' } })
  await s.runtime.invokeAgent(target, 'codex', 'plain', null, s.chatId, { roomId: s.roomId, chatId: s.chatId, traceRunId: 'controller-read', sessionKey: 'controller-read', promptOverride: 'Read', contextPackId: `context-pack-${'a'.repeat(64)}` })
  assert.equal(s.calls[2].runOptions.sandbox, 'read-only')
})

test('openclaw and kimi roles default to platform-enforced read-only execution', async t => {
  const s = await setup(t)
  s.roomDb.database.prepare('UPDATE rooms SET providers_json = ? WHERE id = ?')
    .run(JSON.stringify(['codex', 'openclaw', 'kimi']), s.roomId)
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  t.after(() => service.close())
  const start = provider => {
    const roleId = s.repository.createAgentRole({
      chatId: s.chatId, displayName: provider, provider, createdBy: 'user',
    })
    const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Inspect', createdBy: 'user' })
    return { roleId, run: service.startAssignment({
      assignmentId: s.repository.createAssignment({ taskId, roleId }), prompt: 'Inspect',
    }).promise }
  }
  const openclaw = start('openclaw')
  await openclaw.run
  const kimi = start('kimi')
  await kimi.run
  assert.equal(s.repository.getAgentRole(openclaw.roleId).native_permission, 'read-only')
  assert.equal(s.repository.getAgentRole(kimi.roleId).native_permission, 'read-only')
  assert.equal(s.calls[0].runOptions.sandbox, 'read-only')
  assert.equal(s.calls[0].runOptions.nativePermission, 'read-only')
  assert.equal(s.calls[1].runOptions.sandbox, 'read-only')
  assert.equal(s.calls[1].runOptions.nativePermission, 'read-only')
})

test('Room writers serialize in the native pipeline and a queued cancellation never starts CLI', async t => {
  let releaseFirst
  let enteredFirst
  const entered = new Promise(resolve => { enteredFirst = resolve })
  const hold = new Promise(resolve => { releaseFirst = resolve })
  const s = await setup(t, async () => { enteredFirst(); await hold })
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Writer', provider: 'codex', nativePermission: 'workspace-write', createdBy: 'user' })
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  const create = () => {
    const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Write', createdBy: 'user' })
    return s.repository.createAssignment({ taskId, roleId, writeScopes: ['src/'] })
  }
  try {
    const first = service.startAssignment({ assignmentId: create(), prompt: 'First' }).promise
    await entered
    const abort = new AbortController()
    const second = service.startAssignment({ assignmentId: create(), prompt: 'Second', signal: abort.signal }).promise
    const rejected = assert.rejects(second)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(s.calls.length, 1)
    assert.equal(s.workspace.agentInvocation.runScheduler.snapshot().claimGrants[0].claims[0].mode, 'exclusive')
    abort.abort()
    await rejected
    assert.equal(s.calls.length, 1)
    releaseFirst()
    await first
  } finally { releaseFirst(); await service.close() }
})

async function setup(t, beforeReply = async () => {}, snapshots = false) {
  const { directory, options } = fixture()
  const calls = []
  const privateRoot = path.join(directory, 'room-private')
  options.storagePath = path.join(privateRoot, 'workspace.json')
  options.tracesRoot = path.join(privateRoot, 'traces')
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    await beforeReply({ agent, prompt, workdir, runOptions })
    return { text: prompt.startsWith('You are the Meldwork collaboration controller')
      ? '{"actions":[]}' : 'Done [[MELDWORK_REPORT:{"kind":"ready","summary":"completed"}]]',
    sessionRef: 'native-session', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const roomDb = openRoomDatabase({ directory: path.join(privateRoot, 'room-db') })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Independent', workspace: directory, providers: ['codex'] })
  const chatId = repository.createChat({ roomId, title: 'Team' })
  const runtime = createRoomNativeRuntime({ repository, workspace,
    artifactSnapshots: snapshots && typeof snapshots === 'object' ? snapshots : snapshots ? createArtifactSnapshots({ roomDb, repository,
      directory: path.join(privateRoot, 'artifacts'), privateRoot }) : undefined })
  t.after(() => { roomDb.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { directory, calls, workspace, roomDb, repository, roomId, chatId, runtime }
}

test('native writer captures versions under its lease and associates platform artifacts with its Report', async t => {
  const s = await setup(t, async ({ workdir }) => {
    assert.equal(s.workspace.agentInvocation.runScheduler.snapshot().claimGrants.length, 1)
    fs.mkdirSync(path.join(workdir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(workdir, 'docs', 'requirements.md'), 'Snake MVP requirements')
  }, true)
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Writer', provider: 'codex', nativePermission: 'workspace-write', createdBy: 'user' })
  const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Write requirements', createdBy: 'user' })
  const assignmentId = s.repository.createAssignment({ taskId, roleId, writeScopes: ['docs/'] })
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  try {
    const result = await service.startAssignment({ assignmentId, prompt: 'Write' }).promise
    assert.equal(s.repository.getTask(taskId).status, 'done')
    const artifacts = s.repository.getRoomSnapshot(s.roomId).artifacts
    assert.equal(artifacts.length, 1, JSON.stringify(artifacts.map(item => item.path)))
    assert.equal(artifacts[0].path, 'docs/requirements.md')
    assert.equal(artifacts[0].source_assignment_id, assignmentId)
    assert.deepEqual(JSON.parse(result.roomReport.artifact_ids_json), [artifacts[0].id])
    assert.equal(s.workspace.agentInvocation.runScheduler.snapshot().claimGrants.length, 0)
  } finally { await service.close() }
})

test('a second native writer waits until the first output capture completes', async t => {
  let captured
  let finish
  const entered = new Promise(resolve => { captured = resolve })
  const hold = new Promise(resolve => { finish = resolve })
  let count = 0
  const s = await setup(t, async () => {}, {
    before: async () => ({ commit: 'baseline' }),
    after: async () => { if (++count === 1) { captured(); await hold }; return [] },
  })
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Writer', provider: 'codex', nativePermission: 'workspace-write', createdBy: 'user' })
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  const start = () => {
    const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Write', createdBy: 'user' })
    const assignmentId = s.repository.createAssignment({ taskId, roleId, writeScopes: ['docs/'] })
    return service.startAssignment({ assignmentId, prompt: 'Write' }).promise
  }
  try {
    const first = start()
    await entered
    const second = start()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(s.calls.length, 1)
    assert.equal(s.workspace.agentInvocation.runScheduler.snapshot().claimGrants.length, 1)
    finish()
    await Promise.all([first, second])
    assert.equal(s.calls.length, 2)
  } finally { finish(); await service.close() }
})

test('durable stop reaches the native CLI signal and releases the writer lease after exit', async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const s = await setup(t, async ({ runOptions }) => {
    entered()
    await new Promise(resolve => runOptions.signal.addEventListener('abort', resolve, { once: true }))
  })
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Writer', provider: 'codex', nativePermission: 'workspace-write', createdBy: 'user' })
  const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Write', createdBy: 'user' })
  const assignmentId = s.repository.createAssignment({ taskId, roleId, writeScopes: ['src/'] })
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  try {
    const run = service.startAssignment({ assignmentId, prompt: 'Write' })
    const cancelled = assert.rejects(run.promise, /CANCELLED/)
    await started
    service.applyUserCommand({ type: 'stop_task', chatId: s.chatId, taskId, commandId: 'stop' })
    assert.equal((await service.runNextControlEffect()).effect.status, 'succeeded')
    await cancelled
    assert.equal(s.repository.getAssignmentContext(assignmentId).status, 'cancelled')
    assert.equal(s.repository.getTask(taskId).status, 'cancelled')
    assert.equal(s.repository.getAssignmentLatestReport(assignmentId), undefined)
    assert.equal(s.workspace.agentInvocation.runScheduler.snapshot().claimGrants.length, 0)
  } finally { await service.close() }
})

test('unsettled native termination retains the writer lease until the actual invocation settles', async t => {
  let entered
  let release
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const s = await setup(t, async () => { entered(); await pending })
  s.workspace.agentInvocation.runAbortGraceMs = 5
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Writer', provider: 'codex', nativePermission: 'workspace-write', createdBy: 'user' })
  const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Write', createdBy: 'user' })
  const assignmentId = s.repository.createAssignment({ taskId, roleId, writeScopes: ['src/'] })
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  try {
    const run = service.startAssignment({ assignmentId, prompt: 'Write' })
    const failed = assert.rejects(run.promise, /TERMINATION_FAILED/)
    await started
    service.applyUserCommand({ type: 'stop_task', chatId: s.chatId, taskId, commandId: 'stop' })
    assert.equal((await service.runNextControlEffect()).effect.status, 'unknown')
    await failed
    assert.equal(s.repository.getAssignmentContext(assignmentId).outcome, 'unknown')
    assert.equal(s.workspace.agentInvocation.runScheduler.snapshot().claimGrants.length, 1)
    assert.equal(s.repository.listEvents(s.roomId).some(event => event.type === 'session_exited'), false)
    release()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(s.workspace.agentInvocation.runScheduler.snapshot().claimGrants.length, 0)
    assert.equal(s.repository.getAssignmentLatestReport(assignmentId), undefined)
  } finally { release(); await service.close() }
})

test('worker reaches the native invocation pipeline without a legacy group or ContextPack', async t => {
  const s = await setup(t)
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Worker', provider: 'codex', createdBy: 'user' })
  const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Independent task', createdBy: 'user' })
  const assignmentId = s.repository.createAssignment({ taskId, roleId })
  s.workspace.packedPromptContext = () => assert.fail('legacy conversation context read')
  s.workspace.contextPackStore.get = () => assert.fail('legacy ContextPack read')
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  try {
    const result = await service.startAssignment({ assignmentId, prompt: 'Complete it' }).promise
    assert.equal(result.roomReport.kind, 'ready')
    assert.equal(s.repository.getTask(taskId).status, 'done')
    assert.equal(s.calls.length, 1)
    assert.equal(s.calls[0].workdir, s.directory)
    assert.equal(s.calls[0].runOptions.sandbox, 'read-only')
    assert.ok(s.calls[0].runOptions.traceSink)
    assert.match(result.pendingMessage.groupId, /^room-native-/)
    assert.match(result.pendingMessage.metadata.trace.agentRunId, /^room-agent-/)
    assert.equal(s.workspace.state.groups.length, 0)
    assert.equal(s.workspace.state.messages.length, 0)
    assert.deepEqual(s.workspace.state.sessions, {})
    assert.equal(s.workspace.activeRuns.size, 0)
    assert.equal(s.workspace.agentInvocation.activeAgentSnapshots.size, 0)
  } finally { await service.close() }
})

test('controller invokes its room provider without any existing group', async t => {
  const s = await setup(t)
  const decideController = createControllerAgent({ repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  assert.equal(decideController.isAvailable({ chatId: s.chatId }), true)
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository, decideController })
  try {
    service.submitMessage({ chatId: s.chatId, author: { type: 'user', id: 'user' }, content: 'Plan work' })
    await service.flushController(s.chatId)
    assert.equal(s.calls.length, 1)
    assert.equal(s.calls[0].runOptions.sandbox, 'read-only')
    assert.equal(s.roomDb.database.prepare('SELECT COUNT(*) AS count FROM controller_decisions').get().count, 1)
    assert.equal(s.workspace.state.groups.length, 0)
    assert.equal(s.workspace.state.messages.length, 0)
    assert.deepEqual(s.workspace.state.sessions, {})
  } finally { await service.close() }
})

test('native target enforces room, chat, workspace and installed provider membership', async t => {
  const s = await setup(t)
  const request = { roomId: s.roomId, chatId: s.chatId, assignment: { workspace: s.directory, provider: 'codex' } }
  assert.ok(s.runtime.resolveTarget(request))
  const otherRoom = s.repository.createRoom({ name: 'Other', workspace: s.directory, providers: ['codex'] })
  assert.equal(s.runtime.resolveTarget({ ...request, roomId: otherRoom }), null)
  assert.equal(s.runtime.resolveTarget({ ...request, assignment: { workspace: '/tmp/other', provider: 'codex' } }), null)
  assert.equal(s.runtime.resolveTarget({ ...request, assignment: { workspace: s.directory, provider: 'hermes' } }), null)
  s.workspace.detectedAgents = []
  assert.equal(s.runtime.resolveTarget(request), null)
  assert.deepEqual(s.calls, [])
})

test('native invocation rejects scope mismatch, cancellation and unavailable targets', async t => {
  const s = await setup(t)
  const target = s.runtime.resolveTarget({ roomId: s.roomId, chatId: s.chatId, assignment: { workspace: s.directory, provider: 'codex' } })
  const context = { roomId: s.roomId, chatId: s.chatId, traceRunId: 'run-test' }
  await assert.rejects(s.runtime.invokeAgent(target, 'codex', 'plain', null, 'task', { ...context, chatId: 'foreign' }), /TARGET_SCOPE_INVALID/)
  await assert.rejects(s.runtime.invokeAgent(target, 'codex', 'plain', AbortSignal.abort(), 'task', context), /CANCELLED/)
  s.workspace.detectedAgents = []
  await assert.rejects(s.runtime.invokeAgent(target, 'codex', 'plain', null, 'task', context), /TARGET_UNAVAILABLE/)
  assert.deepEqual(s.calls, [])
})

test('parallel assignments have independent operation and trace identities without legacy sessions', async t => {
  const s = await setup(t)
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Worker', provider: 'codex', createdBy: 'user' })
  const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Independent analyses', createdBy: 'user' })
  const assignments = Array.from({ length: 2 }, () => s.repository.createAssignment({ taskId, roleId }))
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  try {
    const results = await Promise.all(assignments.map(assignmentId => service.startAssignment({ assignmentId, prompt: 'Analyze' }).promise))
    assert.equal(new Set(s.calls.map(call => call.runOptions.operationId)).size, 2)
    assert.equal(new Set(results.map(result => result.pendingMessage.metadata.trace.agentRunId)).size, 2)
    assert.deepEqual(s.calls.map(call => call.runOptions.sessionRef), ['', ''])
    assert.equal(s.repository.getTask(taskId).status, 'done')
    assert.deepEqual(s.workspace.state.sessions, {})
    assert.equal(s.workspace.agentInvocation.activeAgentSnapshots.size, 0)
  } finally { await service.close() }
})

test('Room assignments use one bounded native invocation and never persist legacy session state', async t => {
  const s = await setup(t)
  const nativeCalls = []
  const invokeNative = s.workspace.invokeAgent.bind(s.workspace)
  s.workspace.invokeAgent = (...args) => {
    nativeCalls.push(args)
    return invokeNative(...args)
  }
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Worker', provider: 'codex', createdBy: 'user' })
  const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Bounded work', createdBy: 'user' })
  const assignmentId = s.repository.createAssignment({ taskId, roleId })
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  try {
    const result = await service.startAssignment({ assignmentId, prompt: 'Complete once' }).promise
    assert.equal(s.calls.length, 1)
    assert.equal(nativeCalls[0][5].sessionPolicy, 'room')
    assert.equal(nativeCalls[0][5].saveSession, false)
    assert.match(nativeCalls[0][5].sessionKey, new RegExp(`:${assignmentId}:1$`))
    assert.match(result.pendingMessage.metadata.trace.agentRunId, /^room-agent-/)
    assert.deepEqual(s.workspace.state.sessions, {})
    assert.equal(s.workspace.state.groups.length, 0)
  } finally { await service.close() }
})
