const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createRoomService } = require('../../src/room-engine/room-service.cjs')

function setup(t, { reportKind, records } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-reconcile-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Recovery', workspace: '/tmp/recovery' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const roleId = repository.createAgentRole({ chatId, displayName: 'Worker', provider: 'codex', createdBy: 'user' })
  const taskId = repository.createTask({ chatId, objective: 'Interrupted', createdBy: 'user' })
  const assignmentId = repository.createAssignment({ taskId, roleId, status: 'running', runId: 'original-run' })
  const effectId = repository.createEffect({ chatId, kind: 'start_assignment', payload: { assignmentId }, idempotencyKey: 'original' })
  roomDb.database.prepare("UPDATE effects SET status = 'running' WHERE id = ?").run(effectId)
  if (reportKind) repository.createReport({ taskId, assignmentId, kind: reportKind, summary: 'Committed Report' })
  const processRecords = records ?? [{ recordId: 'process-1', invocationId: 'original-run', status: 'ended', workdir: '/tmp/recovery', agentKind: 'codex' }]
  const service = createRoomService({ roomDb, repository, locale: () => 'zh', getInvocationRecords: () => processRecords })
  service.recoverRuntime()
  t.after(async () => { await service.close(); roomDb.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { roomDb, repository, service, roomId, chatId, roleId, taskId, assignmentId, effectId, processRecords }
}

test('matching ended process records release quarantine without automatically dispatching work', t => {
  const s = setup(t)
  s.processRecords.push({ ...s.processRecords[0], recordId: 'process-2' })
  assert.deepEqual(s.service.reconcileProcesses(), { resolvedAssignmentIds: [s.assignmentId], unresolvedAssignmentIds: [] })
  assert.equal(s.repository.getAssignmentContext(s.assignmentId).outcome, 'interrupted')
  assert.equal(s.repository.getTask(s.taskId).status, 'waiting')
  assert.equal(s.repository.getEffect(s.effectId).status, 'failed')
  const snapshot = s.service.snapshot({ roomId: s.roomId })
  assert.match(snapshot.attentions[0].question, /已确认原进程结束/)
  const events = s.repository.listEvents(s.roomId)
  assert.equal(events.filter(event => event.type === 'session_exited').length, 1)
  assert.equal(events.filter(event => event.type === 'process_reconciled').length, 1)
  assert.deepEqual(s.service.reconcileProcesses(), { resolvedAssignmentIds: [], unresolvedAssignmentIds: [] })
  assert.equal(s.repository.listEvents(s.roomId).length, events.length)
  assert.equal(snapshot.assignments.length, 1)
})

test('proven process exit resolves an unknown stop effect without reviving the stopped Task', t => {
  const s = setup(t)
  s.roomDb.database.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(s.taskId)
  const effectId = s.repository.createEffect({ chatId: s.chatId, kind: 'stop_assignment',
    payload: { assignmentId: s.assignmentId, runId: 'original-run' }, idempotencyKey: 'stop-recovery' })
  s.roomDb.database.prepare("UPDATE effects SET status='unknown' WHERE id=?").run(effectId)
  s.service.reconcileProcesses()
  assert.equal(s.repository.getEffect(effectId).status, 'succeeded')
  assert.equal(s.repository.getTask(s.taskId).status, 'cancelled')
  assert.equal(s.repository.getAssignmentContext(s.assignmentId).outcome, 'interrupted')
  assert.equal(s.repository.listAssignments(s.taskId).length, 1)
})

test('missing, partial or mismatched process evidence cannot release quarantine', async t => {
  const base = { recordId: 'process-1', invocationId: 'original-run', status: 'ended', workdir: '/tmp/recovery', agentKind: 'codex' }
  for (const records of [[], ...['starting', 'running', 'ending'].map(status => [{ ...base, status }]),
    [{ ...base, invocationId: 'another-run' }], [{ ...base, workdir: '/tmp/another' }],
    [{ ...base, agentKind: 'claude' }], [base, { ...base, recordId: 'process-2', status: 'running' }]]) {
    await t.test(JSON.stringify(records), t => {
      const s = setup(t, { records })
      assert.deepEqual(s.service.reconcileProcesses(), { resolvedAssignmentIds: [], unresolvedAssignmentIds: [s.assignmentId] })
      assert.equal(s.repository.getAssignmentContext(s.assignmentId).outcome, 'unknown')
      assert.equal(s.repository.getEffect(s.effectId).status, 'unknown')
      assert.equal(s.repository.listEvents(s.roomId).some(event => event.type === 'session_exited'), false)
    })
  }
})

test('committed ready Report stays authoritative after process reconciliation', t => {
  const s = setup(t, { reportKind: 'ready' })
  s.service.reconcileProcesses()
  assert.equal(s.repository.getAssignmentContext(s.assignmentId).status, 'completed')
  assert.equal(s.repository.getAssignmentContext(s.assignmentId).outcome, 'ready')
  assert.equal(s.repository.getTask(s.taskId).status, 'done')
  assert.equal(s.repository.getEffect(s.effectId).status, 'failed')
})

test('reconciliation rolls back process facts, state and Attention together on audit failure', t => {
  const s = setup(t)
  const question = s.service.snapshot({ roomId: s.roomId }).attentions[0].question
  s.roomDb.database.exec(`CREATE TRIGGER reject_reconciliation BEFORE INSERT ON events WHEN NEW.type = 'process_reconciled'
    BEGIN SELECT RAISE(ABORT, 'audit failed'); END;`)
  assert.throws(() => s.service.reconcileProcesses(), /audit failed/)
  assert.equal(s.repository.getAssignmentContext(s.assignmentId).outcome, 'unknown')
  assert.equal(s.repository.getEffect(s.effectId).status, 'unknown')
  assert.equal(s.repository.listEvents(s.roomId).some(event => event.type === 'session_exited'), false)
  assert.equal(s.service.snapshot({ roomId: s.roomId }).attentions[0].question, question)
})

test('explicit retry reconciles ended execution and dispatches only one replacement', t => {
  const s = setup(t)
  const command = { type: 'retry_task', chatId: s.chatId, taskId: s.taskId, assignmentId: s.assignmentId, commandId: 'retry-recovered' }
  const result = s.service.applyUserCommand(command)
  assert.equal(s.service.applyUserCommand(command).assignmentId, result.assignmentId)
  assert.equal(s.repository.getAssignmentContext(result.assignmentId).previous_assignment_id, s.assignmentId)
  assert.equal(s.repository.getEffect(s.effectId).status, 'failed')
  assert.equal(s.roomDb.database.prepare("SELECT COUNT(*) AS count FROM effects WHERE status = 'pending'").get().count, 1)
})

test('recovered execution can be retried as a fresh assignment and finish the task', async t => {
  const s = setup(t)
  const service = createRoomService({ roomDb: s.roomDb, repository: s.repository,
    locale: () => 'en', getInvocationRecords: () => s.processRecords,
    resolveGroup: () => ({ id: 'host' }),
    invokeAgent: async () => ({ message: { content: 'done [[MELDWORK_REPORT:{"kind":"ready","summary":"Recovered work completed"}]]' } }) })
  t.after(async () => service.close())
  const command = { type: 'retry_task', chatId: s.chatId, taskId: s.taskId, assignmentId: s.assignmentId, commandId: 'retry-and-finish' }
  const result = service.applyUserCommand(command)
  assert.notEqual(result.assignmentId, s.assignmentId)
  await service.runNextEffect()
  const replacement = s.repository.getAssignmentContext(result.assignmentId)
  assert.equal(replacement.status, 'completed')
  assert.equal(s.repository.getTask(s.taskId).status, 'done')
  const reports = s.repository.getRoomSnapshot(s.roomId).reports.filter(report => report.task_id === s.taskId)
  assert.equal(reports.at(-1).kind, 'ready')
})

test('retry cannot bypass residual processes and failed commands roll reconciliation back', t => {
  const s = setup(t)
  const command = { type: 'retry_task', chatId: s.chatId, taskId: s.taskId, assignmentId: s.assignmentId, commandId: 'retry' }
  s.processRecords[0].status = 'ending'
  assert.throws(() => s.service.applyUserCommand(command), /RECOVERY_UNRESOLVED/)
  s.processRecords[0].status = 'ended'
  s.roomDb.database.exec(`CREATE TRIGGER reject_retry BEFORE INSERT ON effects
    BEGIN SELECT RAISE(ABORT, 'outbox failed'); END;`)
  assert.throws(() => s.service.applyUserCommand(command), /outbox failed/)
  assert.equal(s.repository.getAssignmentContext(s.assignmentId).outcome, 'unknown')
  assert.equal(s.repository.getEffect(s.effectId).status, 'unknown')
  assert.equal(s.repository.listAssignments(s.taskId).length, 1)
  assert.equal(s.repository.listEvents(s.roomId).some(event => event.type === 'session_exited'), false)
})
