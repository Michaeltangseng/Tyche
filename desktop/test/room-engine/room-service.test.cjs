const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createRoomService } = require('../../src/room-engine/room-service.cjs')

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-service-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const roleId = repository.createAgentRole({ chatId, displayName: 'Backend', provider: 'codex', createdBy: 'user' })
  const taskId = repository.createTask({ chatId, objective: 'Build', createdBy: 'user' })
  const assignmentId = repository.createAssignment({ taskId, roleId })
  return { roomDb, repository, roomId, chatId, roleId, taskId, assignmentId, service: createRoomService({ roomDb, repository }) }
}

test('bootstrap creates an independent v2 room and primary chat atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-bootstrap-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const service = createRoomService({ roomDb, repository })
  const created = service.bootstrap({ name: 'New work', workspace: '/tmp/new-work', title: 'Team chat', createdBy: 'user-1' })
  assert.equal(repository.listMessages(created.chatId).length, 0)
  const room = roomDb.database.prepare('SELECT primary_chat_id FROM rooms WHERE id = ?').get(created.roomId)
  const event = repository.listEvents(created.roomId)[0]
  assert.equal(room.primary_chat_id, created.chatId)
  assert.equal(event.type, 'chat_bootstrapped')
  roomDb.close()
})

test('snapshot returns the v2 room ledger grouped by chat', () => {
  const { roomDb, service, repository, roomId, chatId, roleId } = setup()
  const message = repository.appendMessage({ chatId, authorType: 'user', authorId: 'user-1', content: 'draft' })
  const taskId = repository.createTask({ chatId, objective: 'Draft', createdBy: 'user-1', sourceMessageIds: [message.messageId] })
  repository.createAssignment({ taskId, roleId, required: false })
  const snapshot = service.snapshot({ roomId })
  assert.equal(snapshot.room.id, roomId)
  assert.equal(snapshot.chats[0].id, chatId)
  const draftTask = snapshot.tasks.find(task => task.objective === 'Draft')
  assert.deepEqual(draftTask.source_message_ids_json, [message.messageId])
  const draftAssignment = snapshot.assignments.find(assignment => assignment.task_id === draftTask.id)
  assert.equal(draftAssignment.required, 0)
  roomDb.close()
})

test('room service composes message ingress and explicit user mention fallback', () => {
  const { roomDb, service, chatId, roleId } = setup()
  const result = service.submitMessage({ chatId, author: { type: 'user', id: 'user-1' }, content: '@Backend build API' })
  assert.equal(result.dispatch.created, true)
  assert.equal(result.dispatch.roleIds[0], roleId)
  assert.equal(service.repository.listMessages(chatId).length, 1)
  roomDb.close()
})

test('agent mentions remain messages and do not directly authorize dispatch', () => {
  const { roomDb, service, chatId, repository } = setup()
  const result = service.submitMessage({ chatId, author: { type: 'agent', id: 'backend' }, content: '@Backend ask for review' })
  assert.equal(result.dispatch, null)
  assert.equal(repository.getTask('missing'), undefined)
  roomDb.close()
})

test('importReport composes report persistence and derived task state', () => {
  const { roomDb, service, repository, chatId, roleId } = setup()
  const taskId = repository.createTask({ chatId, objective: 'Build', createdBy: 'user-1' })
  const assignmentId = repository.createAssignment({ taskId, roleId })
  const result = service.importReport({ chatId, taskId, assignmentId, actorId: 'backend', content: 'done [[MELDWORK_REPORT:{"kind":"ready","summary":"done"}]]' })
  assert.equal(result.state.status, 'done')
  roomDb.close()
})

test('room service exposes assignment start only when the main process supplies a group bridge', async () => {
  const state = setup()
  const bridged = []
  const service = createRoomService({
    roomDb: state.roomDb,
    repository: state.repository,
    resolveGroup: () => ({ id: 'group-1', workdir: '/tmp/demo' }),
    invokeAgent: async (...args) => { bridged.push(args); return { ok: true } },
  })
  const run = service.startAssignment({ assignmentId: state.assignmentId, prompt: 'Build' })
  await run.promise
  assert.equal(bridged[0][0].id, 'group-1')
  assert.equal(bridged[0][5].chatId, state.chatId)
  state.roomDb.close()
})

test('controller assignment is persisted as an outbox effect and can be executed', async () => {
  const state = setup()
  const taskId = state.repository.createTask({ chatId: state.chatId, objective: 'Ship API', createdBy: 'user-1' })
  const service = createRoomService({
    roomDb: state.roomDb,
    repository: state.repository,
    resolveGroup: () => ({ id: 'group-1', workdir: '/tmp/demo' }),
    invokeAgent: async () => ({ message: { content: 'ready [[MELDWORK_REPORT:{"kind":"ready","summary":"shipped"}]]' } }),
  })
  const assigned = service.applyControllerAction({
    type: 'assign', chatId: state.chatId, contextRevision: 0, taskId, roleId: state.roleId,
    required: true, writeScopes: [],
  })
  assert.equal(assigned.assignmentId.length > 0, true)
  const effects = state.roomDb.database.prepare('SELECT * FROM effects WHERE action_id = ?').all(assigned.event.eventId)
  assert.equal(effects.length, 1)
  const execution = await service.runNextEffect()
  assert.equal(execution.effect.status, 'succeeded')
  assert.equal(state.repository.getAssignmentContext(assigned.assignmentId).status, 'completed')
  state.roomDb.close()
})
