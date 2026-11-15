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
const { createUserCommandService } = require('../../src/room-engine/user-commands.cjs')

test('worker writes require a persisted grant and scopes; controller remains read-only', async t => {
  const s = await setup(t)
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user' })
  const commands = createUserCommandService({ roomDb: s.roomDb, repository: s.repository })
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  t.after(() => service.close())
  const create = scopes => {
    const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Write', createdBy: 'user' })
    return s.repository.createAssignment({ taskId, roleId, writeScopes: scopes })
  }
  await assert.rejects(service.startAssignment({ assignmentId: create(['src/']), prompt: 'Write' }).promise, /WRITE_NOT_AUTHORIZED/)
  assert.equal(s.calls.length, 0)
  commands.apply({ type: 'set_workspace_write', chatId: s.chatId, allowWrite: true, commandId: 'grant' })
  await service.startAssignment({ assignmentId: create(['src/']), prompt: 'Write' }).promise
  assert.equal(s.calls[0].runOptions.sandbox, 'workspace-write')
  assert.equal(s.calls[0].workdir, fs.realpathSync.native(s.directory))
  await service.startAssignment({ assignmentId: create([]), prompt: 'Read' }).promise
  assert.equal(s.calls[1].runOptions.sandbox, 'read-only')
  const target = s.runtime.resolveTarget({ roomId: s.roomId, chatId: s.chatId, assignment: { workspace: s.directory, provider: 'codex' } })
  await s.runtime.invokeAgent(target, 'codex', 'plain', null, s.chatId, { roomId: s.roomId, chatId: s.chatId, traceRunId: 'controller-read', sessionKey: 'controller-read', promptOverride: 'Read', contextPackId: `context-pack-${'a'.repeat(64)}` })
  assert.equal(s.calls[2].runOptions.sandbox, 'read-only')
})

test('native write authorization is rechecked after waiting for the directory lease', async t => {
  const s = await setup(t)
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user' })
  const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Write', createdBy: 'user' })
  const assignmentId = s.repository.createAssignment({ taskId, roleId, status: 'running', runId: 'run-write', writeScopes: ['src/'] })
  s.roomDb.database.prepare('UPDATE rooms SET write_authorized_root=? WHERE id=?').run(fs.realpathSync.native(s.directory), s.roomId)
  const target = s.runtime.resolveTarget({ roomId: s.roomId, chatId: s.chatId, assignment: { workspace: s.directory, provider: 'codex' } })
  const context = { roomId: s.roomId, chatId: s.chatId, taskId, assignmentId, traceRunId: 'run-write', sessionKey: 'worker-write', promptOverride: 'Write', contextPackId: `context-pack-${'b'.repeat(64)}` }
  await assert.rejects(s.runtime.invokeAgent(target, 'codex', 'plain', null, taskId, { ...context, traceRunId: 'foreign' }), /ASSIGNMENT_SCOPE_INVALID/)
  const scheduler = s.workspace.agentInvocation.runScheduler
  const blocker = await scheduler.acquire({ taskId: 'blocker', workspaceKey: 'blocker', permissionMode: 'workspace-write', workdirRoot: s.directory, exclusiveRoot: true })
  const pending = s.runtime.invokeAgent(target, 'codex', 'plain', null, taskId, context)
  const rejected = assert.rejects(pending, /WRITE_AUTHORIZATION_CHANGED/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(s.calls.length, 0)
  s.roomDb.database.prepare('UPDATE rooms SET write_authorized_root=NULL WHERE id=?').run(s.roomId)
  blocker.release()
  await rejected
  assert.equal(s.calls.length, 0)
})

test('Room writers serialize in the native pipeline and a queued cancellation never starts CLI', async t => {
  let releaseFirst
  let enteredFirst
  const entered = new Promise(resolve => { enteredFirst = resolve })
  const hold = new Promise(resolve => { releaseFirst = resolve })
  const s = await setup(t, async () => { enteredFirst(); await hold })
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user' })
  createUserCommandService({ roomDb: s.roomDb, repository: s.repository }).apply({ type: 'set_workspace_write', chatId: s.chatId, allowWrite: true, commandId: 'grant' })
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

async function setup(t, beforeReply = async () => {}) {
  const { directory, options } = fixture()
  const calls = []
  options.tracesRoot = path.join(directory, 'traces')
  options.runAgent = async (agent, prompt, workdir, runOptions) => {
    calls.push({ agent, prompt, workdir, runOptions })
    await beforeReply({ agent, prompt, workdir, runOptions })
    return { text: prompt.startsWith('You are the Meldwork collaboration controller')
      ? '{"actions":[]}' : 'Done [[MELDWORK_REPORT:{"kind":"ready","summary":"completed"}]]',
    sessionRef: 'native-session', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const roomDb = openRoomDatabase({ directory: path.join(directory, 'room-db') })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Independent', workspace: directory, providers: ['codex'] })
  const chatId = repository.createChat({ roomId, title: 'Team' })
  const runtime = createRoomNativeRuntime({ repository, workspace })
  t.after(() => { roomDb.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { directory, calls, workspace, roomDb, repository, roomId, chatId, runtime }
}

test('durable stop reaches the native CLI signal and releases the writer lease after exit', async t => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const s = await setup(t, async ({ runOptions }) => {
    entered()
    await new Promise(resolve => runOptions.signal.addEventListener('abort', resolve, { once: true }))
  })
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user' })
  const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Write', createdBy: 'user' })
  const assignmentId = s.repository.createAssignment({ taskId, roleId, writeScopes: ['src/'] })
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  try {
    service.applyUserCommand({ type: 'set_workspace_write', chatId: s.chatId, allowWrite: true, commandId: 'grant' })
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
    assert.equal(service.applyUserCommand({ type: 'set_workspace_write', chatId: s.chatId, allowWrite: false, commandId: 'revoke' }).allowWrite, false)
  } finally { await service.close() }
})

test('unsettled native termination retains the writer lease until the actual invocation settles', async t => {
  let entered
  let release
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const s = await setup(t, async () => { entered(); await pending })
  s.workspace.agentInvocation.runAbortGraceMs = 5
  const roleId = s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user' })
  const taskId = s.repository.createTask({ chatId: s.chatId, objective: 'Write', createdBy: 'user' })
  const assignmentId = s.repository.createAssignment({ taskId, roleId, writeScopes: ['src/'] })
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    invokeAgent: s.runtime.invokeAgent, resolveGroup: s.runtime.resolveTarget })
  try {
    service.applyUserCommand({ type: 'set_workspace_write', chatId: s.chatId, allowWrite: true, commandId: 'grant' })
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
  s.workspace.agentInvocation.getProjectRoom = () => ({ projectChatContext: () => assert.fail('legacy project context read') })
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

test('native invocation rejects scope mismatch, write escalation and cancellation before execution', async t => {
  const s = await setup(t)
  const target = s.runtime.resolveTarget({ roomId: s.roomId, chatId: s.chatId, assignment: { workspace: s.directory, provider: 'codex' } })
  const context = { roomId: s.roomId, chatId: s.chatId, traceRunId: 'run-test' }
  await assert.rejects(s.runtime.invokeAgent(target, 'codex', 'plain', null, 'task', { ...context, chatId: 'foreign' }), /TARGET_SCOPE_INVALID/)
  await assert.rejects(s.runtime.invokeAgent(target, 'codex', 'plain', null, 'task', { ...context, permissionMode: 'workspace-write' }), /WRITE_NOT_AUTHORIZED/)
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
