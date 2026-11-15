const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createRuntimeRecovery } = require('../../src/room-engine/runtime-recovery.cjs')
const { createRoomService } = require('../../src/room-engine/room-service.cjs')

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-recovery-'))
  let roomDb = openRoomDatabase({ directory })
  let repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Recovery', workspace: '/tmp/recovery' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const roleId = repository.createAgentRole({ chatId, displayName: 'Worker', provider: 'codex', createdBy: 'user' })
  t.after(() => { roomDb.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return {
    get roomDb() { return roomDb }, get repository() { return repository }, roomId, chatId, roleId,
    reopen() { roomDb.close(); roomDb = openRoomDatabase({ directory }); repository = createRoomRepository(roomDb) },
    task({ reportKind, required = true, effect = true } = {}) {
      const taskId = repository.createTask({ chatId, objective: 'Interrupted', createdBy: 'user' })
      const assignmentId = repository.createAssignment({ taskId, roleId, status: 'running', runId: `run-${taskId}`, required })
      const effectId = effect ? repository.createEffect({ chatId, kind: 'start_assignment', payload: { assignmentId, prompt: 'Work' }, idempotencyKey: `start:${assignmentId}` }) : null
      if (effectId) roomDb.database.prepare("UPDATE effects SET status = 'running' WHERE id = ?").run(effectId)
      if (reportKind) repository.createReport({ taskId, assignmentId, kind: reportKind, summary: 'Persisted Report' })
      return { taskId, assignmentId, effectId }
    },
  }
}

test('reopened runtime quarantines unknown execution once and does not automatically replay it', async t => {
  const state = setup(t)
  const interrupted = state.task({ reportKind: 'progress' })
  const queuedTaskId = state.repository.createTask({ chatId: state.chatId, objective: 'Queued', createdBy: 'user' })
  const queuedId = state.repository.createAssignment({ taskId: queuedTaskId, roleId: state.roleId })
  const pendingId = state.repository.createEffect({ chatId: state.chatId, kind: 'start_assignment', payload: { assignmentId: queuedId, prompt: 'Work' }, idempotencyKey: 'pending' })
  state.reopen()
  let invocations = 0
  const service = createRoomService({
    roomDb: state.roomDb, repository: state.repository, autoRunEffects: true, locale: () => 'zh',
    resolveGroup: () => ({ id: 'host' }), invokeAgent: async () => { invocations += 1; return {} },
  })
  try {
    const recovered = service.recoverRuntime()
    assert.deepEqual(recovered.unknownEffectIds, [interrupted.effectId])
    assert.equal(recovered.attentionIds.length, 1)
    assert.equal(state.repository.getEffect(interrupted.effectId).status, 'unknown')
    assert.equal(state.repository.getAssignmentContext(interrupted.assignmentId).status, 'waiting')
    assert.equal(state.repository.getTask(interrupted.taskId).status, 'waiting')
    assert.equal(state.repository.getRoomSnapshot(state.roomId).attentions[0].options_json[0].label, '已知悉')
    assert.equal(state.repository.listEvents(state.roomId).some(event => event.type === 'session_exited'), false)
    assert.deepEqual(service.recoverRuntime(), { unknownEffectIds: [], interruptedAssignmentIds: [], attentionIds: [], eventIds: [] })
    await service.startRuntime()
    assert.throws(() => service.recoverRuntime(), /REQUIRES_STARTUP/)
    assert.equal(invocations, 1)
    assert.equal(state.repository.getEffect(pendingId).status, 'succeeded')
    assert.equal(state.repository.getEffect(interrupted.effectId).status, 'unknown')
  } finally { await service.close() }
})

test('committed final Reports survive recovery while effect outcomes remain unknown', t => {
  const state = setup(t)
  const ready = state.task({ reportKind: 'ready' })
  const blocked = state.task({ reportKind: 'blocked' })
  state.reopen()
  const recovery = createRuntimeRecovery({ roomDb: state.roomDb, repository: state.repository })
  const result = recovery.recover()
  assert.equal(result.unknownEffectIds.length, 2)
  assert.deepEqual(result.interruptedAssignmentIds, [])
  assert.equal(state.repository.getAssignmentContext(ready.assignmentId).status, 'completed')
  assert.equal(state.repository.getTask(ready.taskId).status, 'done')
  assert.equal(state.repository.getAssignmentContext(blocked.assignmentId).status, 'blocked')
  assert.equal(state.repository.getTask(blocked.taskId).status, 'waiting')
  assert.equal(result.attentionIds.length, 2)
  assert.equal(state.roomDb.database.prepare('SELECT COUNT(*) AS count FROM reports').get().count, 2)
})

test('orphan execution gets a recovery attention; optional interruption does not block required work', t => {
  const state = setup(t)
  const interrupted = state.task({ effect: false, required: false })
  const required = state.repository.createAssignment({ taskId: interrupted.taskId, roleId: state.roleId, status: 'completed' })
  state.repository.createReport({ taskId: interrupted.taskId, assignmentId: required, kind: 'ready', summary: 'Required done' })
  const recovery = createRuntimeRecovery({ roomDb: state.roomDb, repository: state.repository })
  const first = recovery.recover()
  assert.equal(first.attentionIds.length, 1)
  assert.equal(state.repository.getTask(interrupted.taskId).status, 'done')
  assert.equal(state.repository.getAssignmentContext(interrupted.assignmentId).status, 'waiting')
  assert.equal(recovery.recover().attentionIds.length, 0)
})

test('recovery rolls back unknown states if Attention persistence fails', t => {
  const state = setup(t)
  const interrupted = state.task()
  state.roomDb.database.exec(`CREATE TRIGGER reject_attention BEFORE INSERT ON attentions
    BEGIN SELECT RAISE(ABORT, 'attention storage failed'); END;`)
  const recovery = createRuntimeRecovery({ roomDb: state.roomDb, repository: state.repository })
  assert.throws(() => recovery.recover(), /attention storage failed/)
  assert.equal(state.repository.getEffect(interrupted.effectId).status, 'running')
  assert.equal(state.repository.getAssignmentContext(interrupted.assignmentId).status, 'running')
  assert.equal(state.repository.listEvents(state.roomId).length, 0)
})
