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
  const listed = service.listRooms()
  assert.equal(listed[0].chats.length, 1)
  assert.equal(listed[0].chats[0].id, created.chatId)
  assert.equal(listed[0].chats[0].title, 'Team chat')
  assert.equal(listed[0].chats[0].is_primary, true)
  roomDb.close()
})

test('bootstrap and new chats keep provider availability without auto-adding roles', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-default-seats-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const service = createRoomService({ roomDb, repository })
  t.after(async () => {
    await service.close()
    roomDb.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const created = service.bootstrap({ name: 'Team', workspace: '/tmp/team', providers: ['codex', 'claude'], createdBy: 'user-1' })
  assert.equal(repository.listAgentRoles(created.chatId).length, 0)
  assert.deepEqual(JSON.parse(repository.getRoom(created.roomId).providers_json), ['codex', 'claude'])
  const next = service.createChat({ roomId: created.roomId, title: 'Second chat' })
  assert.equal(repository.listAgentRoles(next.chatId).length, 0)
})

test('deleting a primary chat promotes the oldest remaining chat and cascades its ledger', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-delete-chat-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const service = createRoomService({ roomDb, repository })
  const created = service.bootstrap({ name: 'Team', workspace: '/tmp/team', providers: ['codex'], createdBy: 'user-1' })
  const second = service.createChat({ roomId: created.roomId, title: 'Second chat' })
  repository.appendMessage({ chatId: created.chatId, authorType: 'user', authorId: 'user-1', content: 'hello' })
  repository.createAgentRole({ chatId: created.chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user-1' })
  const result = service.deleteChat({ roomId: created.roomId, chatId: created.chatId })
  assert.equal(result.chatId, created.chatId)
  assert.equal(result.promotedChatId, second.chatId)
  const snapshot = service.snapshot({ roomId: created.roomId })
  assert.equal(snapshot.chats.length, 1)
  assert.equal(snapshot.chats[0].id, second.chatId)
  assert.equal(snapshot.room.primary_chat_id, second.chatId)
  assert.equal(snapshot.roles.filter(role => role.chat_id === created.chatId).length, 0)
  assert.equal(snapshot.roles.filter(role => role.chat_id === second.chatId).length, 0)
  assert.equal(snapshot.messages.length, 0)
  assert.equal(repository.listEvents(created.roomId).at(-1).type, 'chat_deleted')
  assert.throws(() => service.deleteChat({ roomId: created.roomId, chatId: second.chatId }), /PRIMARY_CHAT_UNDELETABLE/)
  roomDb.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

test('chat and room deletion are blocked while work is queued or running', () => {
  const { roomDb, service, repository, roomId, chatId, roleId } = setup()
  assert.throws(() => service.deleteChat({ roomId, chatId }), /CHAT_DELETE_BUSY/)
  assert.throws(() => service.deleteRoom({ roomId }), /ROOM_DELETE_BUSY/)
  const taskId = repository.createTask({ chatId, objective: 'Done', createdBy: 'user' })
  repository.createAssignment({ taskId, roleId, status: 'running' })
  assert.throws(() => service.deleteChat({ roomId, chatId }), /CHAT_DELETE_BUSY/)
  state(roomDb, "UPDATE assignments SET status='completed', outcome='ready'")
  const otherChat = service.createChat({ roomId, title: 'Other' })
  const result = service.deleteRoom({ roomId })
  assert.equal(result.deleted, true)
  assert.deepEqual(service.listRooms(), [])
  assert.throws(() => service.snapshot({ roomId }), /ROOM_NOT_FOUND/)
  assert.equal(repository.getChat(otherChat.chatId), undefined)
  roomDb.close()
})

function state(roomDb, sql) {
  roomDb.database.exec(sql)
}

test('snapshot returns the v2 room ledger grouped by chat', () => {
  const { roomDb, service, repository, roomId, chatId, roleId } = setup()
  repository.createChatContextRevision({ chatId, instructions: 'Prefer concise reports and record every request.', createdBy: 'user-1' })
  const message = repository.appendMessage({ chatId, authorType: 'user', authorId: 'user-1', content: 'draft' })
  const taskId = repository.createTask({ chatId, objective: 'Draft', createdBy: 'user-1', sourceMessageIds: [message.messageId] })
  repository.createAssignment({ taskId, roleId, required: false })
  const snapshot = service.snapshot({ roomId })
  assert.equal(snapshot.room.id, roomId)
  assert.equal(snapshot.chats[0].id, chatId)
  assert.equal(snapshot.chats[0].current_context.revision, 1)
  assert.match(snapshot.chats[0].current_context.instructions, /record every request/)
  const draftTask = snapshot.tasks.find(task => task.objective === 'Draft')
  assert.deepEqual(draftTask.source_message_ids_json, [message.messageId])
  const draftAssignment = snapshot.assignments.find(assignment => assignment.task_id === draftTask.id)
  assert.equal(draftAssignment.required, 0)
  roomDb.close()
})

test('skill bindings are captured by main, frozen on assignment, and snapshots expose no private refs', async () => {
  const state = setup()
  const hash = 'a'.repeat(64)
  const ref = { algorithm: 'sha256', hash: 'b'.repeat(64), size: 10, mediaType: 'application/json' }
  const service = createRoomService({
    roomDb: state.roomDb,
    repository: state.repository,
    prepareSkillBindings: async ({ selections, provider }) => {
      assert.equal(provider, 'codex')
      assert.equal(selections[0].slug, 'review')
      const result = {
        targetKind: 'codex', namespace: 'team', slug: 'review', name: 'Review',
        snapshotId: `skill-snapshot-${hash}`, manifestHash: hash, snapshotRef: ref,
      }
      Object.defineProperty(result, 'entryPath', { value: '/private/skills/review/SKILL.md' })
      return [result]
    },
  })
  const saved = await service.updateSkillBindings({ chatId: state.chatId, roleId: state.roleId, selections: [
    { targetKind: 'codex', namespace: 'team', slug: 'review', name: 'Review' },
  ] })
  assert.equal(saved.skillBindings[0].snapshotRef, undefined)
  assert.equal(saved.skillBindings[0].entryPath, undefined)
  const frozenTaskId = state.repository.createTask({ chatId: state.chatId, objective: 'Review', createdBy: 'user' })
  const frozenAssignmentId = state.repository.createAssignment({ taskId: frozenTaskId, roleId: state.roleId })
  const snapshot = service.snapshot({ roomId: state.roomId })
  assert.equal(snapshot.roles[0].skill_bindings_json[0].snapshotRef, undefined)
  const assignment = snapshot.assignments.find(item => item.id === frozenAssignmentId)
  assert.equal(assignment.skill_hints_json[0].snapshotRef, undefined)
  const persistedHints = JSON.parse(state.repository.getAssignmentContext(frozenAssignmentId).skill_hints_json)
  assert.equal(persistedHints[0].snapshotRef.hash, ref.hash)
  const inherited = await service.updateSkillBindings({ chatId: state.chatId, roleId: state.roleId, inheritChat: true })
  assert.equal(inherited.skillBindings, null)
  assert.equal(state.roomDb.database.prepare('SELECT skill_bindings_json FROM agent_roles WHERE id = ?').get(state.roleId).skill_bindings_json, null)
  state.roomDb.close()
})

test('room UI snapshot returns only the latest message page and older pages stay scoped to the chat', () => {
  const { roomDb, service, repository, roomId, chatId } = setup()
  for (let index = 1; index <= 205; index++) repository.appendMessage({ chatId, authorType: 'user', authorId: 'user', content: `message-${index}` })
  const snapshot = service.snapshot({ roomId })
  assert.equal(snapshot.messages.length, 100)
  assert.equal(snapshot.messages[0].sequence, 106)
  assert.equal(snapshot.messages[99].sequence, 205)
  assert.deepEqual(snapshot.messages_have_older, [chatId])
  const page = service.listChatMessages({ roomId, chatId, beforeSequence: 106, limit: 100 })
  assert.equal(page.messages.length, 100)
  assert.equal(page.messages[0].sequence, 6)
  assert.equal(page.messages[99].sequence, 105)
  assert.equal(page.hasMore, true)
  const finalPage = service.listChatMessages({ roomId, chatId, beforeSequence: 6, limit: 100 })
  assert.deepEqual(finalPage.messages.map(message => message.sequence), [1, 2, 3, 4, 5])
  assert.equal(finalPage.hasMore, false)
  assert.throws(() => service.listChatMessages({ roomId: 'another-room', chatId }), /ROOM_CHAT_NOT_FOUND/)
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

test('controller batch rolls back assignments, effects and audit when a later action fails', async () => {
  const state = setup()
  let fail = true
  const service = createRoomService({
    roomDb: state.roomDb, repository: state.repository,
    decideController: async () => ({ actions: [
      { type: 'assign', chatId: state.chatId, contextRevision: 0, taskId: state.taskId, roleId: state.roleId },
      ...(fail ? [{ type: 'assign', chatId: state.chatId, contextRevision: 0, taskId: 'missing-task', roleId: state.roleId }] : []),
    ] }),
  })
  const input = { chatId: state.chatId, batchId: 'atomic-batch', contextRevision: 0 }
  await assert.rejects(service.processControllerBatch(input), /ROOM_TASK_NOT_FOUND/)
  assert.equal(state.repository.listAssignments(state.taskId).length, 1)
  for (const table of ['effects', 'events', 'controller_decisions']) {
    assert.equal(state.roomDb.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0)
  }
  fail = false
  const result = await service.processControllerBatch(input)
  assert.equal(result.duplicate, false)
  assert.equal(state.repository.listAssignments(state.taskId).length, 2)
  assert.equal(state.roomDb.database.prepare('SELECT COUNT(*) AS count FROM effects').get().count, 1)
  const duplicate = await service.processControllerBatch(input)
  assert.equal(duplicate.duplicate, true)
  assert.equal(state.repository.listAssignments(state.taskId).length, 2)
  state.roomDb.close()
})

test('failed decision audit persistence rolls back all batch actions and effects', async () => {
  const state = setup()
  state.roomDb.database.exec(`CREATE TRIGGER reject_decision BEFORE INSERT ON controller_decisions
    BEGIN SELECT RAISE(ABORT, 'decision storage failed'); END;`)
  const service = createRoomService({
    roomDb: state.roomDb, repository: state.repository,
    decideController: async () => ({ actions: [
      { type: 'assign', chatId: state.chatId, contextRevision: 0, taskId: state.taskId, roleId: state.roleId },
    ] }),
  })
  await assert.rejects(service.processControllerBatch({ chatId: state.chatId, batchId: 'audit-failure', contextRevision: 0 }), /decision storage failed/)
  assert.equal(state.repository.listAssignments(state.taskId).length, 1)
  assert.equal(state.roomDb.database.prepare('SELECT COUNT(*) AS count FROM effects').get().count, 0)
  assert.equal(state.repository.listEvents(state.roomId).length, 0)
  state.roomDb.close()
})

test('configured controller batches user and agent messages without duplicate fallback dispatch', async () => {
  const state = setup()
  const calls = []
  const service = createRoomService({
    roomDb: state.roomDb, repository: state.repository,
    decideController: async input => { calls.push(input); return { actions: [] } },
    onControllerError: error => assert.fail(error),
  })
  const first = service.submitMessage({ chatId: state.chatId, author: { type: 'user', id: 'user' }, content: '@Backend build' })
  const second = service.submitMessage({ chatId: state.chatId, author: { type: 'agent', id: state.roleId }, content: '@Backend review' })
  assert.equal(first.dispatch, null)
  await service.flushController(state.chatId)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].messages.map(message => message.id), [first.message.messageId, second.message.messageId])
  assert.equal(state.repository.listAssignments(state.taskId).length, 1)
  await service.close()
  state.roomDb.close()
})

test('runtime routes task creation, automatic worker execution and Report follow-up to Attention', async () => {
  const state = setup()
  const calls = []
  const errors = []
  const service = createRoomService({
    roomDb: state.roomDb, repository: state.repository, autoRunEffects: true,
    onControllerError: error => errors.push(error), onEffectError: error => errors.push(error),
    resolveGroup: () => ({ id: 'host', workdir: '/tmp/demo' }),
    invokeAgent: async () => ({ pendingMessage: { content: 'Done [[MELDWORK_REPORT:{"reportId":"runtime-report","kind":"ready","summary":"Draft ready"}]]' } }),
    decideController: async input => {
      calls.push(input)
      const base = { chatId: input.chatId, contextRevision: input.contextRevision }
      if (input.messages.length) return { actions: [{ ...base, type: 'create_task', objective: 'Runtime draft', kind: 'draft' }] }
      if (input.events.some(event => event.type === 'action_create_task')) {
        const task = service.snapshot({ roomId: state.roomId }).tasks.find(task => task.objective === 'Runtime draft')
        return { actions: [{ ...base, type: 'assign', taskId: task.id, roleId: state.roleId }] }
      }
      if (input.events.some(event => event.type === 'report_received')) return { actions: [{
        ...base, type: 'request_attention', taskId: state.repository.getReport('runtime-report').task_id,
        attentionType: 'approval', question: 'Accept draft?', options: [{ id: 'yes', label: 'Accept' }],
      }] }
      if (input.events.some(event => event.type === 'user_answer_attention')) return { actions: [{
        ...base, type: 'create_task', objective: 'Implement the accepted draft', kind: 'implementation',
      }] }
      return { actions: [] }
    },
  })
  try {
    service.submitMessage({ chatId: state.chatId, author: { type: 'user', id: 'user' }, content: 'Write a draft' })
    await service.flushController(state.chatId)
    await service.flushController(state.chatId)
    await service.startRuntime()
    await service.flushController(state.chatId)
    const snapshot = service.snapshot({ roomId: state.roomId })
    const task = snapshot.tasks.find(task => task.objective === 'Runtime draft')
    assert.equal(task.status, 'done')
    assert.equal(snapshot.attentions[0].question, 'Accept draft?')
    assert.equal(state.roomDb.database.prepare('SELECT status FROM effects').get().status, 'succeeded')
    assert.equal(calls.length, 3)
    const assignment = snapshot.assignments.find(assignment => assignment.task_id === task.id)
    const duplicate = service.importReport({ chatId: state.chatId, taskId: task.id, assignmentId: assignment.id, actorId: state.roleId, content: '[[MELDWORK_REPORT:{"reportId":"runtime-report","kind":"ready","summary":"Draft ready"}]]' })
    assert.equal(duplicate.duplicate, true)
    assert.equal(await service.flushController(state.chatId), null)
    assert.equal(calls.length, 3)
    assert.deepEqual(errors, [])
    service.applyUserCommand({ type: 'answer_attention', chatId: state.chatId, attentionId: snapshot.attentions[0].id, optionId: 'yes' })
    await service.flushController(state.chatId)
    assert.equal(calls.length, 4)
    assert.equal(calls[3].events[0].type, 'user_answer_attention')
    assert.equal(service.snapshot({ roomId: state.roomId }).tasks.some(task => task.objective === 'Implement the accepted draft'), true)
  } finally {
    await service.close()
    state.roomDb.close()
  }
})

test('runtime defers paused chat effects and automatically wakes on resume', async () => {
  const state = setup()
  let invocations = 0
  const service = createRoomService({
    roomDb: state.roomDb, repository: state.repository, autoRunEffects: true,
    resolveGroup: () => ({ id: 'host' }), invokeAgent: async () => { invocations += 1; return {} },
  })
  service.applyUserCommand({ type: 'pause_chat', chatId: state.chatId })
  service.submitMessage({ chatId: state.chatId, author: { type: 'user', id: 'user' }, content: '@Backend build' })
  await service.startRuntime()
  assert.equal(invocations, 0)
  service.applyUserCommand({ type: 'resume_chat', chatId: state.chatId })
  await service.startRuntime()
  assert.equal(invocations, 1)
  await service.close()
  state.roomDb.close()
})

test('user retry dispatches one new attempt and old failure no longer prevents task completion', async () => {
  const state = setup()
  let invocations = 0
  const service = createRoomService({
    roomDb: state.roomDb, repository: state.repository,
    resolveGroup: () => ({ id: 'host' }),
    invokeAgent: async () => {
      invocations += 1
      if (invocations === 1) throw new Error('first attempt failed')
      return { pendingMessage: { content: '[[MELDWORK_REPORT:{"kind":"ready","summary":"retry worked"}]]' } }
    },
  })
  try {
    await assert.rejects(service.startAssignment({ assignmentId: state.assignmentId, prompt: 'Build' }).promise, /first attempt failed/)
    const command = { type: 'retry_task', chatId: state.chatId, taskId: state.taskId, assignmentId: state.assignmentId, commandId: 'retry-once' }
    const retried = service.applyUserCommand(command)
    assert.equal(service.applyUserCommand(command).assignmentId, retried.assignmentId)
    assert.equal(state.roomDb.database.prepare('SELECT COUNT(*) AS count FROM effects').get().count, 1)
    const executed = await service.runNextEffect()
    assert.equal(executed.effect.status, 'succeeded')
    assert.equal(state.repository.getTask(state.taskId).status, 'done')
    assert.equal(state.repository.getAssignmentContext(state.assignmentId).status, 'failed')
    assert.equal(state.repository.getAssignmentContext(retried.assignmentId).status, 'completed')
    assert.equal(await service.runNextEffect(), null)
    assert.equal(invocations, 2)
  } finally { await service.close(); state.roomDb.close() }
})

test('retry command, new assignment and audit roll back if outbox persistence fails', async () => {
  const state = setup()
  state.roomDb.database.prepare("UPDATE assignments SET status = 'failed' WHERE id = ?").run(state.assignmentId)
  state.roomDb.database.exec(`CREATE TRIGGER reject_retry_effect BEFORE INSERT ON effects
    BEGIN SELECT RAISE(ABORT, 'effect storage failed'); END;`)
  const command = { type: 'retry_task', chatId: state.chatId, taskId: state.taskId, assignmentId: state.assignmentId, commandId: 'retry-rollback' }
  assert.throws(() => state.service.applyUserCommand(command), /effect storage failed/)
  assert.equal(state.repository.listAssignments(state.taskId).length, 1)
  assert.equal(state.repository.listEvents(state.roomId).length, 0)
  state.roomDb.database.exec('DROP TRIGGER reject_retry_effect')
  assert.equal(state.service.applyUserCommand(command).attempt, 2)
  await state.service.close()
  state.roomDb.close()
})
