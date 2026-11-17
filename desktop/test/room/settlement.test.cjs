const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')
const { createOutbox } = require('../../src/room/effects.cjs')
const { createTaskQueue } = require('../../src/room/task-queue.cjs')
const { createSettlement, registerFinishTaskTool } = require('../../src/room/settlement.cjs')
const { createToolDispatcher } = require('../../src/room/tools/dispatcher.cjs')

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const roleId = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId })
  const timeline = createTimeline({ roomDb, repository: repo })
  const outbox = createOutbox({ roomDb, repository: repo })
  const queue = createTaskQueue({ roomDb, repository: repo, timeline, outbox })
  const settlement = createSettlement({ roomDb, repository: repo, timeline })
  return { roomDb, repo, roomId, chatId, roleId, timeline, outbox, queue, settlement }
}

function seedRunningRun(t, { writeScopes = [] } = {}) {
  const context = setup(t)
  const task = context.queue.createTask({
    chatId: context.chatId,
    roleId: context.roleId,
    title: 'T',
    description: 'D',
    acceptance: 'A',
  })
  const [run] = context.queue.listRuns(task.taskId)
  context.roomDb.database.prepare("UPDATE task_runs SET status = 'running', write_scopes_json = ?, started_at = 't' WHERE id = ?")
    .run(JSON.stringify(writeScopes), run.id)
  context.roomDb.database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.taskId)
  return { ...context, taskId: task.taskId, runId: run.id }
}

test('finish_task claims but does not enter in_review before settlement', t => {
  const { roomDb, settlement, taskId, runId } = seedRunningRun(t, { writeScopes: ['src'] })
  const claim = settlement.claim({ runId, taskId, status: 'ready', summary: 'done' })
  assert.equal(claim.report.kind, 'ready')
  assert.equal(roomDb.database.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status, 'in_progress')
  const settled = settlement.settle({ runId, exit: { observed: true, code: 0 }, snapshot: { state: 'completed' } })
  assert.equal(settled.task.status, 'in_review')
  assert.equal(settled.run.snapshotState, 'completed')
  roomDb.close()
})

test('read-only task settles with snapshot not_applicable', t => {
  const { roomDb, settlement, taskId, runId } = seedRunningRun(t, { writeScopes: [] })
  const claim = settlement.claim({ runId, taskId, status: 'ready', summary: 'done' })
  const settled = settlement.settle({ runId, exit: { observed: true, code: 0 }, snapshot: { state: 'not_applicable' } })
  assert.equal(claim.report.kind, 'ready')
  assert.equal(settled.task.status, 'in_review')
  assert.equal(settled.run.snapshotState, 'not_applicable')
  roomDb.close()
})

test('observed non-zero exit is failed/known, unconfirmed exit is interrupted/unknown', t => {
  const known = seedRunningRun(t, { writeScopes: ['src'] })
  known.settlement.claim({ runId: known.runId, taskId: known.taskId, status: 'ready', summary: 'done' })
  const failed = known.settlement.settle({ runId: known.runId, exit: { observed: true, code: 1 }, snapshot: { state: 'failed' } })
  assert.equal(failed.run.status, 'failed')
  assert.equal(failed.run.outcome, 'known')
  assert.equal(failed.task.status, 'blocked')

  const unknown = seedRunningRun(t, { writeScopes: ['src'] })
  unknown.settlement.claim({ runId: unknown.runId, taskId: unknown.taskId, status: 'ready', summary: 'done' })
  const interrupted = unknown.settlement.settle({ runId: unknown.runId, exit: { observed: false } })
  assert.equal(interrupted.run.status, 'interrupted')
  assert.equal(interrupted.run.outcome, 'unknown')
  assert.equal(interrupted.task.status, 'blocked')
  known.roomDb.close()
  unknown.roomDb.close()
})

test('accept_task refuses before settlement and succeeds after', t => {
  const { roomDb, settlement, taskId, runId } = seedRunningRun(t, { writeScopes: [] })
  settlement.claim({ runId, taskId, status: 'ready', summary: 'done' })
  assert.throws(() => settlement.acceptTask({ taskId, commandId: 'a1' }), /ROOM_TASK_NOT_SETTLED/)
  settlement.settle({ runId, exit: { observed: true, code: 0 }, snapshot: { state: 'not_applicable' } })
  assert.equal(settlement.acceptTask({ taskId, commandId: 'a2' }).status, 'done')
  roomDb.close()
})

test('finish_task tool claims through the bound run', async t => {
  const { roomDb, repo, chatId, roleId, settlement, taskId, runId } = seedRunningRun(t, { writeScopes: [] })
  const dispatcher = createToolDispatcher({ roomDb, repository: repo })
  registerFinishTaskTool({ dispatcher, settlement, roomDb })
  dispatcher.bindRun(runId, { chatId, roleId, allowedTools: ['finish_task'] })
  const result = await dispatcher.invoke({ runId, callId: 'finish-1', name: 'finish_task',
    args: { taskId, status: 'ready', summary: 'done' } })
  assert.equal(result.report.kind, 'ready')
  assert.equal(result.task.status, 'in_progress')
  roomDb.close()
})

test('finish_task is rejected outside the executor lane', async t => {
  const { roomDb, repo, chatId, roleId, queue, settlement, taskId } = seedRunningRun(t, { writeScopes: [] })
  const otherRole = repo.createRole({ chatId, displayName: 'B', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId: otherRole })
  const mentionRun = queue.enqueueRun({
    taskId,
    roleId: otherRole,
    laneKind: 'mention',
    required: false,
  })
  roomDb.database.prepare("UPDATE task_runs SET status = 'running', started_at = 't2' WHERE id = ?")
    .run(mentionRun.id)
  const dispatcher = createToolDispatcher({ roomDb, repository: repo })
  registerFinishTaskTool({ dispatcher, settlement, roomDb })
  dispatcher.bindRun(mentionRun.id, { chatId, roleId: otherRole, allowedTools: ['finish_task'] })
  await assert.rejects(
    dispatcher.invoke({
      runId: mentionRun.id,
      callId: 'finish-mention',
      name: 'finish_task',
      args: { taskId, status: 'ready', summary: 'done' },
    }),
    /ROOM_FINISH_TASK_LANE_INVALID/,
  )
  roomDb.close()
})

test('a progress report keeps the task in_progress', t => {
  const { roomDb, settlement, taskId, runId } = seedRunningRun(t, { writeScopes: [] })
  const claim = settlement.claim({ runId, taskId, status: 'progress', summary: 'half' })
  const settled = settlement.settle({
    runId,
    exit: { observed: true, code: 0 },
    snapshot: { state: 'not_applicable' },
  })
  assert.equal(claim.report.kind, 'progress')
  assert.equal(settled.task.status, 'in_progress')
  assert.equal(settled.run.status, 'completed')
  roomDb.close()
})

test('accept_task requires the latest required run to have a ready report', t => {
  const { roomDb, queue, settlement, taskId, runId, roleId } = seedRunningRun(t, { writeScopes: [] })
  settlement.claim({ runId, taskId, status: 'progress', summary: 'half' })
  settlement.settle({ runId, exit: { observed: true, code: 0 }, snapshot: { state: 'not_applicable' } })
  assert.equal(queue.getTask(taskId).status, 'in_progress')
  assert.throws(() => settlement.acceptTask({ taskId, commandId: 'p1' }), /ROOM_TASK_NOT_SETTLED/)

  const continuation = queue.enqueueRun({ taskId, roleId, required: true })
  roomDb.database.prepare("UPDATE task_runs SET status = 'running', started_at = 't2' WHERE id = ?")
    .run(continuation.id)
  settlement.claim({ runId: continuation.id, taskId, status: 'ready', summary: 'done' })
  settlement.settle({
    runId: continuation.id,
    exit: { observed: true, code: 0 },
    snapshot: { state: 'not_applicable' },
  })
  assert.equal(settlement.acceptTask({ taskId, commandId: 'p2' }).status, 'done')
  roomDb.close()
})

test('accept_task checks required artifacts in the latest ready report', t => {
  const { roomDb, settlement, taskId, runId } = seedRunningRun(t, { writeScopes: [] })
  roomDb.database.prepare('UPDATE tasks SET required_artifact_ids_json = ? WHERE id = ?')
    .run(JSON.stringify(['artifact-1']), taskId)
  settlement.claim({ runId, taskId, status: 'ready', summary: 'done' })
  settlement.settle({
    runId,
    exit: { observed: true, code: 0 },
    snapshot: { state: 'not_applicable' },
  })
  assert.throws(
    () => settlement.acceptTask({ taskId, commandId: 'a1' }),
    /ROOM_TASK_ARTIFACTS_MISSING/,
  )
  roomDb.database.prepare('UPDATE reports SET artifact_ids_json = ? WHERE run_id = ?')
    .run(JSON.stringify(['artifact-1']), runId)
  assert.equal(settlement.acceptTask({ taskId, commandId: 'a2' }).status, 'done')
  roomDb.close()
})
