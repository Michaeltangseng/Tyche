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
