const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createReportStateService } = require('../../src/room-engine/report-state.cjs')

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-report-state-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const roleA = repository.createAgentRole({ chatId, displayName: 'A', provider: 'codex', createdBy: 'user' })
  const roleB = repository.createAgentRole({ chatId, displayName: 'B', provider: 'pi', createdBy: 'user' })
  const roleC = repository.createAgentRole({ chatId, displayName: 'C', provider: 'gemini', createdBy: 'user' })
  const taskId = repository.createTask({ chatId, objective: 'Review', createdBy: 'user' })
  const assignmentA = repository.createAssignment({ taskId, roleId: roleA, required: true })
  const assignmentB = repository.createAssignment({ taskId, roleId: roleB, required: true })
  return { roomDb, repository, taskId, assignmentA, assignmentB, roleC, state: createReportStateService({ roomDb }) }
}

test('required assignments become done only after every required report is ready', () => {
  const { roomDb, repository, taskId, assignmentA, assignmentB, state } = setup()
  repository.createReport({ taskId, assignmentId: assignmentA, kind: 'ready', summary: 'A ready' })
  assert.equal(state.reconcileTask(taskId).status, 'active')
  repository.createReport({ taskId, assignmentId: assignmentB, kind: 'ready', summary: 'B ready' })
  assert.equal(state.reconcileTask(taskId).status, 'done')
  assert.equal(repository.getTask(taskId).status, 'done')
  roomDb.close()
})

test('blocked or failed required reports wait for attention, while optional failures do not block', () => {
  const first = setup()
  first.repository.createReport({ taskId: first.taskId, assignmentId: first.assignmentA, kind: 'blocked', summary: 'Needs decision' })
  first.repository.createReport({ taskId: first.taskId, assignmentId: first.assignmentB, kind: 'ready', summary: 'B ready' })
  assert.equal(first.state.reconcileTask(first.taskId).status, 'waiting')
  first.roomDb.close()

  const second = setup()
  const optional = second.repository.createAssignment({ taskId: second.taskId, roleId: second.roleC, required: false })
  second.repository.createReport({ taskId: second.taskId, assignmentId: second.assignmentA, kind: 'ready', summary: 'A ready' })
  second.repository.createReport({ taskId: second.taskId, assignmentId: second.assignmentB, kind: 'ready', summary: 'B ready' })
  second.repository.createReport({ taskId: second.taskId, assignmentId: optional, kind: 'failed', summary: 'Optional failure' })
  assert.equal(second.state.reconcileTask(second.taskId).status, 'done')
  second.roomDb.close()
})

test('latest report per assignment controls the derived state', () => {
  const { roomDb, repository, taskId, assignmentA, assignmentB, state } = setup()
  repository.createReport({ taskId, assignmentId: assignmentA, kind: 'progress', summary: 'working' })
  repository.createReport({ taskId, assignmentId: assignmentB, kind: 'ready', summary: 'B ready' })
  assert.equal(state.reconcileTask(taskId).status, 'active')
  repository.createReport({ taskId, assignmentId: assignmentA, kind: 'ready', summary: 'A ready' })
  assert.equal(state.reconcileTask(taskId).status, 'done')
  roomDb.close()
})
