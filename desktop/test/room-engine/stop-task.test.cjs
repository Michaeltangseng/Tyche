const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createRoomService } = require('../../src/room-engine/room-service.cjs')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-stop-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Stop test', workspace: directory })
  const chatId = repository.createChat({ roomId, title: 'Team' })
  const roleId = repository.createAgentRole({ chatId, displayName: 'Worker', provider: 'codex', createdBy: 'user' })
  const taskId = repository.createTask({ chatId, objective: 'Build', createdBy: 'user' })
  const assignmentId = repository.createAssignment({ taskId, roleId })
  const service = createRoomService({ roomDb, repository, resolveGroup: () => ({ id: 'host' }), ...options })
  t.after(async () => { await service.close(); roomDb.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const command = { type: 'stop_task', chatId, taskId, commandId: 'stop-once' }
  return { roomDb, repository, roomId, chatId, roleId, taskId, assignmentId, service, command }
}

test('queued stop cancels durable dispatch, is replay-safe and cannot be undone by controller assignment', async t => {
  let calls = 0
  const s = setup(t, { invokeAgent: async () => { calls++ } })
  s.service.applyControllerAction({ type: 'assign', chatId: s.chatId, contextRevision: 0, taskId: s.taskId, roleId: s.roleId })
  const stopped = s.service.applyUserCommand(s.command)
  assert.equal(stopped.cancelledAssignmentIds.length, 2)
  assert.equal(s.service.applyUserCommand(s.command).duplicate, true)
  assert.throws(() => s.service.applyUserCommand({ ...s.command, reason: 'changed' }), /COMMAND_ID_REUSED/)
  assert.equal(await s.service.runNextEffect(), null)
  assert.equal(s.roomDb.database.prepare('SELECT status FROM effects').get().status, 'cancelled')
  assert.equal(s.repository.getTask(s.taskId).status, 'cancelled')
  assert.throws(() => s.service.applyControllerAction({ type: 'assign', chatId: s.chatId, contextRevision: 0, taskId: s.taskId, roleId: s.roleId }), /TASK_CANCELLED/)
  assert.equal(calls, 0)
  const otherChat = s.repository.createChat({ roomId: s.roomId, title: 'Other' })
  assert.throws(() => s.service.applyUserCommand({ ...s.command, chatId: otherChat }), /TASK_NOT_FOUND/)
})

test('startup quarantines a persisted stop request without reviving the Task or claiming process exit', async t => {
  const s = setup(t, { invokeAgent: async () => assert.fail('must not replay worker') })
  s.roomDb.database.prepare("UPDATE assignments SET status='running', run_id='lost-run' WHERE id=?").run(s.assignmentId)
  s.service.applyUserCommand(s.command)
  s.service.recoverRuntime()
  assert.equal(s.repository.getTask(s.taskId).status, 'cancelled')
  assert.equal(s.repository.getAssignmentContext(s.assignmentId).outcome, 'unknown')
  const control = await s.service.runNextControlEffect()
  assert.equal(control.effect.status, 'unknown')
  assert.equal(s.repository.listEvents(s.roomId).some(event => event.type === 'session_exited'), false)
  assert.equal(await s.service.runNextEffect(), null)
})

test('stop command rolls back all cancellation when durable stop storage fails', async t => {
  const entered = deferred()
  const s = setup(t, { invokeAgent: async (_group, _provider, _mode, signal) => {
    entered.resolve()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  } })
  const run = s.service.startAssignment({ assignmentId: s.assignmentId, prompt: 'Build' })
  const ended = assert.rejects(run.promise, /CANCELLED/)
  await entered.promise
  s.roomDb.database.exec("CREATE TRIGGER reject_stop BEFORE INSERT ON effects BEGIN SELECT RAISE(ABORT, 'stop storage failed'); END;")
  assert.throws(() => s.service.applyUserCommand(s.command), /stop storage failed/)
  assert.notEqual(s.repository.getTask(s.taskId).status, 'cancelled')
  assert.equal(s.repository.listEvents(s.roomId).filter(event => event.type === 'user_stop_task').length, 0)
  assert.equal(s.repository.getAssignmentContext(s.assignmentId).status, 'running')
  s.roomDb.database.exec('DROP TRIGGER reject_stop')
  s.service.applyUserCommand(s.command)
  await s.service.runNextControlEffect()
  await ended
})

test('control pump stops running work in a paused Chat and handoff waits for confirmed exit', async t => {
  const entered = deferred()
  const sawAbort = deferred()
  const exit = deferred()
  const errors = []
  let calls = 0
  const s = setup(t, { autoRunEffects: true, onEffectError: error => errors.push(error),
    invokeAgent: async (_group, _provider, _mode, signal) => {
      calls++
      if (calls === 1) {
        entered.resolve()
        await new Promise(resolve => signal.addEventListener('abort', () => { sawAbort.resolve(); resolve() }, { once: true }))
        await exit.promise
      }
      return { pendingMessage: { content: '[[MELDWORK_REPORT:{"kind":"ready","summary":"finished"}]]' } }
    } })
  // The first fixture assignment is dispatched through the same durable path as controller work.
  s.roomDb.database.prepare('UPDATE assignments SET required=0 WHERE id=?').run(s.assignmentId)
  const active = s.service.applyControllerAction({ type: 'assign', chatId: s.chatId, contextRevision: 0, taskId: s.taskId, roleId: s.roleId })
  await entered.promise
  s.service.applyUserCommand({ type: 'pause_chat', chatId: s.chatId })
  s.service.applyUserCommand(s.command)
  await sawAbort.promise
  const handoff = { type: 'handoff_task', chatId: s.chatId, taskId: s.taskId, assignmentId: active.assignmentId, roleId: s.roleId, commandId: 'handoff' }
  assert.throws(() => s.service.applyUserCommand(handoff), /NOT_RETRYABLE/)
  assert.equal(s.repository.listEvents(s.roomId).filter(event => event.type === 'session_exited').length, 0)
  assert.equal(s.repository.getAssignmentContext(active.assignmentId).status, 'running')
  exit.resolve()
  await s.service.startRuntime()
  assert.equal(s.repository.getAssignmentContext(active.assignmentId).status, 'cancelled')
  assert.equal(s.repository.getAssignmentLatestReport(active.assignmentId), undefined)
  const next = s.service.applyUserCommand(handoff)
  assert.equal(next.attempt, 2)
  assert.equal(s.service.applyUserCommand(handoff).assignmentId, next.assignmentId)
  assert.equal(calls, 1)
  s.service.applyUserCommand({ type: 'resume_chat', chatId: s.chatId })
  await s.service.startRuntime()
  assert.equal(calls, 2)
  assert.equal(s.repository.getTask(s.taskId).status, 'done')
  assert.deepEqual(errors, [])
})

test('unconfirmed termination stays unknown, never emits exit, and blocks handoff and permission changes', async t => {
  const entered = deferred()
  const s = setup(t, { locale: () => 'zh-CN', invokeAgent: async (_group, _provider, _mode, signal) => {
    entered.resolve()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    throw Object.assign(new Error('LOCAL_AGENT_TERMINATION_FAILED'), { code: 'LOCAL_AGENT_TERMINATION_FAILED' })
  } })
  const run = s.service.startAssignment({ assignmentId: s.assignmentId, prompt: 'Build' })
  const failed = assert.rejects(run.promise, /TERMINATION_FAILED/)
  await entered.promise
  s.service.applyUserCommand(s.command)
  const control = await s.service.runNextControlEffect()
  await failed
  assert.equal(control.effect.status, 'unknown')
  assert.equal(s.repository.getAssignmentContext(s.assignmentId).outcome, 'unknown')
  assert.equal(s.repository.listEvents(s.roomId).filter(event => event.type === 'session_exited').length, 0)
  assert.match(s.repository.getRoomSnapshot(s.roomId).attentions[0].question, /未能确认/)
  assert.throws(() => s.service.applyUserCommand({ type: 'retry_task', chatId: s.chatId, taskId: s.taskId, assignmentId: s.assignmentId, commandId: 'retry' }), /RECOVERY_UNRESOLVED/)
  assert.throws(() => s.service.applyUserCommand({ type: 'set_workspace_write', chatId: s.chatId, commandId: 'grant', allowWrite: true }), /PERMISSION_BUSY/)
})
