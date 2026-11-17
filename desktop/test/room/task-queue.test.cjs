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
const { createToolDispatcher } = require('../../src/room/tools/dispatcher.cjs')
const { registerTaskTools } = require('../../src/room/tools/tasks.cjs')

function setup(t, options = {}) {
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
  const queue = createTaskQueue({ roomDb, repository: repo, timeline, outbox, ...options })
  return { roomDb, repo, roomId, chatId, roleId, timeline, outbox, queue }
}

test('create_task creates a task, executor lane, and one queued run', t => {
  const { roomDb, chatId, roleId, queue } = setup(t)
  const task = queue.createTask({ chatId, roleId, title: 'T', description: 'D', acceptance: 'A' })
  const runs = queue.listRuns(task.taskId)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'queued')
  assert.equal(queue.getLane({ taskId: task.taskId, roleId }).kind, 'executor')
  roomDb.close()
})

test('pump starts one run per lane and marks the start effect succeeded', async t => {
  const started = []
  const { roomDb, roomId, chatId, roleId, queue } = setup(t, {
    startRun: async run => { started.push(run.id) },
  })
  const task = queue.createTask({ chatId, roleId, title: 'T', description: 'D', acceptance: 'A' })
  const runs = await queue.pump({ roomId })
  assert.equal(runs.length, 1)
  assert.equal(started[0], runs[0].id)
  assert.equal(queue.listRuns(task.taskId)[0].status, 'running')
  assert.equal(roomDb.database.prepare('SELECT status FROM tasks WHERE id = ?').get(task.taskId).status, 'in_progress')
  roomDb.close()
})

test('create_task rejects foreign assignees and forces the caller under a captain assignment', t => {
  const { roomDb, repo, chatId, roleId, queue } = setup(t)
  const foreignRoom = repo.createRoom({ name: 'Other', workspace: '/tmp' })
  const foreignChat = repo.createChat({ roomId: foreignRoom, title: 'Other' })
  const foreignRole = repo.createRole({ chatId: foreignChat, displayName: 'Foreign', provider: 'claude', prompt: 'p' })
  assert.throws(() => queue.createTask({ chatId, roleId, title: 'T', description: 'D', acceptance: 'A',
    assigneeRoleId: foreignRole }), /ROOM_TASK_ASSIGNEE_INVALID/)
  const otherRole = repo.createRole({ chatId, displayName: 'B', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId: otherRole })
  const task = queue.createTask({ chatId, roleId, title: 'T', description: 'D', acceptance: 'A',
    assigneeRoleId: otherRole, captainAssignmentId: 'cap-1' })
  assert.equal(queue.getTask(task.taskId).assigneeRoleId, roleId)
  roomDb.close()
})

test('task tools create a task and add a continuation run for a comment', async t => {
  const { roomDb, repo, chatId, roleId, queue } = setup(t)
  const dispatcher = createToolDispatcher({ roomDb, repository: repo })
  registerTaskTools({ dispatcher, roomDb, repository: repo, timeline: {}, queueRun: queue })
  dispatcher.bindRun('run1', { chatId, roleId, allowedTools: ['create_task', 'comment_task'] })
  const created = await dispatcher.invoke({ runId: 'run1', callId: 'c1', name: 'create_task',
    args: { title: 'T', description: 'D', acceptance: 'A' } })
  assert.equal(queue.listRuns(created.taskId).length, 1)
  const comment = await dispatcher.invoke({ runId: 'run1', callId: 'c2', name: 'comment_task',
    args: { taskId: created.taskId, text: 'more' } })
  assert.equal(comment.runId === created.runId, false)
  assert.equal(queue.listRuns(created.taskId).length, 2)
  roomDb.close()
})

test('pump does not overwrite a run that settled while starting', async t => {
  const { roomDb, roomId, chatId, roleId, queue } = setup(t, {
    startRun: async run => {
      roomDb.database.prepare("UPDATE task_runs SET status = 'completed', outcome = 'known' WHERE id = ?").run(run.id)
      roomDb.database.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(run.taskId)
    },
  })
  const task = queue.createTask({ chatId, roleId, title: 'T', description: 'D', acceptance: 'A' })
  const started = await queue.pump({ roomId })
  assert.equal(started.length, 1)
  assert.equal(queue.listRuns(task.taskId)[0].status, 'completed')
  assert.equal(queue.getTask(task.taskId).status, 'in_review')
  roomDb.close()
})

test('create_task is idempotent per assignment and source message', async t => {
  const { roomDb, repo, chatId, roleId, queue } = setup(t)
  const dispatcher = createToolDispatcher({ roomDb, repository: repo })
  registerTaskTools({ dispatcher, roomDb, repository: repo, timeline: {}, queueRun: queue })
  dispatcher.bindRun('run1', {
    chatId,
    roleId,
    allowedTools: ['create_task'],
    captainAssignmentId: 'assignment-1',
    rootMessageId: 'message-1',
  })
  const args = { title: 'T', description: 'D', acceptance: 'A' }
  const first = await dispatcher.invoke({ runId: 'run1', callId: 'c1', name: 'create_task', args })
  const second = await dispatcher.invoke({ runId: 'run1', callId: 'c2', name: 'create_task', args })
  assert.deepEqual(second, first)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE chat_id = ?').get(chatId).n, 1)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?').get(first.taskId).n, 1)
  assert.equal(roomDb.database.prepare("SELECT COUNT(*) AS n FROM domain_idempotency WHERE kind = 'create_task'").get().n, 1)
  roomDb.close()
})

test('create_task retries dedupe by run and args without an assignment', async t => {
  const { roomDb, repo, chatId, roleId, queue } = setup(t)
  const dispatcher = createToolDispatcher({ roomDb, repository: repo })
  registerTaskTools({ dispatcher, roomDb, repository: repo, timeline: {}, queueRun: queue })
  dispatcher.bindRun('run2', { chatId, roleId, allowedTools: ['create_task'] })
  const args = { title: 'T', description: 'D', acceptance: 'A' }
  const first = await dispatcher.invoke({ runId: 'run2', callId: 'c1', name: 'create_task', args })
  const second = await dispatcher.invoke({ runId: 'run2', callId: 'c2', name: 'create_task', args })
  assert.deepEqual(second, first)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM tasks WHERE chat_id = ?').get(chatId).n, 1)
  roomDb.close()
})

test('comment_task dedupes by caller key or source and text', async t => {
  const { roomDb, repo, chatId, roleId, queue } = setup(t)
  const dispatcher = createToolDispatcher({ roomDb, repository: repo })
  registerTaskTools({ dispatcher, roomDb, repository: repo, timeline: {}, queueRun: queue })
  dispatcher.bindRun('run3', { chatId, roleId, allowedTools: ['create_task', 'comment_task'] })
  const created = await dispatcher.invoke({ runId: 'run3', callId: 'c1', name: 'create_task',
    args: { title: 'T', description: 'D', acceptance: 'A' } })

  const fallback = { taskId: created.taskId, text: 'more' }
  const first = await dispatcher.invoke({ runId: 'run3', callId: 'x1', name: 'comment_task', args: fallback })
  const second = await dispatcher.invoke({ runId: 'run3', callId: 'x2', name: 'comment_task', args: fallback })
  assert.deepEqual(second, first)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM task_activities WHERE task_id = ?').get(created.taskId).n, 1)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?').get(created.taskId).n, 2)

  const keyed = { taskId: created.taskId, text: 'more', idempotency_key: 'comment-1' }
  const keyedFirst = await dispatcher.invoke({ runId: 'run3', callId: 'x3', name: 'comment_task', args: keyed })
  const keyedSecond = await dispatcher.invoke({ runId: 'run3', callId: 'x4', name: 'comment_task', args: keyed })
  assert.deepEqual(keyedSecond, keyedFirst)
  assert.notEqual(keyedFirst.activityId, first.activityId)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM task_activities WHERE task_id = ?').get(created.taskId).n, 2)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?').get(created.taskId).n, 3)
  roomDb.close()
})

test('a non-executor comment continues in the commenter mention lane', async t => {
  const { roomDb, repo, roomId, chatId, roleId, timeline, outbox, queue } = setup(t)
  const otherRole = repo.createRole({ chatId, displayName: 'B', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId: otherRole })
  const dispatcher = createToolDispatcher({ roomDb, repository: repo })
  registerTaskTools({ dispatcher, roomDb, repository: repo, timeline, queueRun: queue })
  dispatcher.bindRun('run-a', { chatId, roleId, allowedTools: ['create_task'] })
  const created = await dispatcher.invoke({
    runId: 'run-a',
    callId: 'c1',
    name: 'create_task',
    args: { title: 'T', description: 'D', acceptance: 'A' },
  })
  dispatcher.bindRun('run-b', { chatId, roleId: otherRole, allowedTools: ['comment_task'] })
  const comment = await dispatcher.invoke({
    runId: 'run-b',
    callId: 'c2',
    name: 'comment_task',
    args: { taskId: created.taskId, text: 'please adjust' },
  })
  assert.ok(comment.runId)

  const runs = queue.listRuns(created.taskId)
  const mentionRun = runs.find(run => run.id === comment.runId)
  assert.equal(mentionRun.roleId, otherRole)
  assert.equal(mentionRun.required, false)
  const lane = roomDb.database.prepare('SELECT kind FROM task_lanes WHERE id = ?').get(mentionRun.laneId)
  assert.equal(lane.kind, 'mention')
  assert.equal(runs.filter(run => run.roleId === roleId).length, 1)

  const seen = []
  const runnable = createTaskQueue({
    roomDb,
    repository: repo,
    timeline,
    outbox,
    startRun: async (run, task) => { seen.push([run.id, task.laneKind]) },
  })
  await runnable.pump({ roomId })
  assert.equal(seen.find(([id]) => id === comment.runId)?.[1], 'mention')
  roomDb.close()
})

test('a mention lane run does not reopen an in_review task', async t => {
  const { roomDb, repo, roomId, chatId, roleId, timeline, outbox, queue } = setup(t)
  const otherRole = repo.createRole({ chatId, displayName: 'B', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId: otherRole })
  const task = queue.createTask({ chatId, roleId, title: 'T', description: 'D', acceptance: 'A' })
  const [executorRun] = queue.listRuns(task.taskId)
  roomDb.database.prepare("UPDATE task_runs SET status = 'completed', outcome = 'known' WHERE id = ?")
    .run(executorRun.id)
  roomDb.database.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(task.taskId)
  const mentionRun = queue.enqueueRun({
    taskId: task.taskId,
    roleId: otherRole,
    laneKind: 'mention',
    required: false,
  })
  const runnable = createTaskQueue({
    roomDb,
    repository: repo,
    timeline,
    outbox,
    startRun: async () => {},
  })
  const started = await runnable.pump({ roomId })
  assert.equal(started.length, 1)
  assert.equal(started[0].id, mentionRun.id)
  assert.equal(queue.getTask(task.taskId).status, 'in_review')
  roomDb.close()
})

test('task numbers are allocated per room, not per chat', t => {
  const { roomDb, repo, roomId, chatId, roleId, queue } = setup(t)
  const first = queue.createTask({ chatId, roleId, title: 'One', description: 'D', acceptance: 'A' })
  const otherChat = repo.createChat({ roomId, title: 'Other' })
  const otherRole = repo.createRole({ chatId: otherChat, displayName: 'B', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId: otherChat, roleId: otherRole })
  const second = queue.createTask({
    chatId: otherChat,
    roleId: otherRole,
    title: 'Two',
    description: 'D',
    acceptance: 'A',
  })
  assert.equal(queue.getTask(first.taskId).number, 1)
  assert.equal(queue.getTask(second.taskId).number, 2)
  roomDb.close()
})
