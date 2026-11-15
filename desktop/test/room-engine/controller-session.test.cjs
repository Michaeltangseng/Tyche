const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createControllerSession } = require('../../src/room-engine/controller-session.cjs')
const { createRoomActionService } = require('../../src/room-engine/room-actions.cjs')

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-controller-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const message = repository.appendMessage({ chatId, authorType: 'user', authorId: 'user-1', content: '@Backend build' })
  const roleId = repository.createAgentRole({ chatId, displayName: 'Backend', provider: 'codex', createdBy: 'user' })
  return { roomDb, repository, chatId, message, roleId }
}

test('removed retirement action rejects the entire controller proposal', async () => {
  const state = setup()
  const taskId = state.repository.createTask({ chatId: state.chatId, objective: 'Draft', createdBy: 'controller' })
  const actions = createRoomActionService(state)
  const session = createControllerSession({
    ...state, applyAction: actions.applyController,
    decide: async () => ({ actions: [
      { type: 'archive_role', chatId: state.chatId, contextRevision: 0, roleId: state.roleId },
      { type: 'assign', chatId: state.chatId, contextRevision: 0, taskId, roleId: state.roleId },
    ] }),
  })
  await assert.rejects(session.process({ chatId: state.chatId, batchId: 'invalid-retirement', contextRevision: 0 }), /CONTROLLER_ACTION_TYPE_INVALID/)
  assert.equal(state.repository.listAgentRoles(state.chatId)[0].status, 'active')
  assert.deepEqual(state.repository.listAssignments(taskId), [])
  assert.equal(state.repository.getControllerDecision({ chatId: state.chatId, batchId: 'invalid-retirement' }), undefined)
  assert.deepEqual(state.repository.listEvents(state.repository.getChatContext(state.chatId).chat.room_id), [])
  state.roomDb.close()
})

test('controller session processes a message batch once and records its decision', async () => {
  const state = setup()
  let calls = 0
  const session = createControllerSession({
    roomDb: state.roomDb,
    repository: state.repository,
    decide: async input => {
      calls += 1
      assert.equal(input.messages[0].content, '@Backend build')
      return {
        model: 'router-test',
        actions: [{ type: 'create_task', chatId: state.chatId, contextRevision: 0, objective: 'Build', kind: 'implement', sourceMessageIds: [state.message.messageId], blockedByTaskIds: [], requiredArtifactIds: [], optional: false, parentTaskId: null, inputs: [] }],
      }
    },
    applyAction: (action, options) => ({ event: { eventId: 'action-1' }, taskId: state.repository.createTask({ chatId: action.chatId, objective: action.objective, kind: action.kind, createdBy: options.actorId, sourceMessageIds: action.sourceMessageIds, contextRevision: action.contextRevision }) }),
  })
  const first = await session.process({ chatId: state.chatId, batchId: 'batch-1', contextRevision: 0, messageIds: [state.message.messageId] })
  const second = await session.process({ chatId: state.chatId, batchId: 'batch-1', contextRevision: 0, messageIds: [state.message.messageId] })
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.equal(calls, 1)
  assert.equal(state.roomDb.database.prepare('SELECT COUNT(*) AS count FROM controller_decisions').get().count, 1)
  state.roomDb.close()
})

test('context revisions are persisted and supplied to controller decisions', async () => {
  const state = setup()
  const context = state.repository.createChatContextRevision({ chatId: state.chatId, instructions: 'Prefer concise reports', changes: { reviewRequired: true }, createdBy: 'user-1' })
  let received
  const session = createControllerSession({
    roomDb: state.roomDb,
    repository: state.repository,
    decide: async input => { received = input; return { actions: [] } },
    applyAction: () => ({}),
  })
  await session.process({ chatId: state.chatId, batchId: 'batch-context', contextRevision: context.revision, messageIds: [] })
  assert.equal(received.context.instructions, 'Prefer concise reports')
  assert.deepEqual(received.context.changes, { reviewRequired: true })
  state.roomDb.close()
})

test('controller session rejects a stale context before calling the controller', async () => {
  const state = setup()
  let called = false
  const session = createControllerSession({ roomDb: state.roomDb, repository: state.repository, decide: async () => { called = true; return { actions: [] } }, applyAction: () => ({}) })
  await assert.rejects(session.process({ chatId: state.chatId, contextRevision: 1, messageIds: [] }), /CONTEXT_STALE/)
  assert.equal(called, false)
  state.roomDb.close()
})

test('one evaluation runs per chat and failed evaluations release the slot', async () => {
  const state = setup()
  let rejectDecision
  const session = createControllerSession({
    ...state, applyAction: () => ({}),
    decide: () => new Promise((_resolve, reject) => { rejectDecision = reject }),
  })
  const input = { chatId: state.chatId, contextRevision: 0 }
  const running = session.process(input)
  await assert.rejects(session.process(input), /CHAT_BUSY/)
  rejectDecision(new Error('model unavailable'))
  await assert.rejects(running, /model unavailable/)
  const retry = session.process(input)
  rejectDecision(new Error('retry reached model'))
  await assert.rejects(retry, /retry reached model/)
  state.roomDb.close()
})

test('context changes while deciding reject the entire proposal before applying actions', async () => {
  const state = setup()
  let applied = 0
  const session = createControllerSession({
    ...state, applyAction: () => { applied += 1 },
    decide: async () => {
      state.repository.createChatContextRevision({ chatId: state.chatId, instructions: 'New instructions', createdBy: 'user' })
      return { actions: [{ type: 'note', chatId: state.chatId, contextRevision: 0, content: 'outdated' }] }
    },
  })
  await assert.rejects(session.process({ chatId: state.chatId, contextRevision: 0 }), /CONTEXT_STALE/)
  assert.equal(applied, 0)
  state.roomDb.close()
})

test('foreign messages and foreign actions cannot escape the current chat', async () => {
  const state = setup()
  let applied = 0
  const session = createControllerSession({
    ...state, applyAction: () => { applied += 1 },
    decide: async () => ({ actions: [
      { type: 'note', chatId: state.chatId, contextRevision: 0, content: 'valid' },
      { type: 'note', chatId: 'another-chat', contextRevision: 0, content: 'invalid' },
    ] }),
  })
  await assert.rejects(session.process({ chatId: state.chatId, contextRevision: 0 }), /CHAT_MISMATCH/)
  assert.equal(applied, 0)
  const foreignRoom = state.repository.createRoom({ name: 'Other', workspace: '/tmp/other' })
  const foreignChat = state.repository.createChat({ roomId: foreignRoom, title: 'Other' })
  const foreignMessage = state.repository.appendMessage({ chatId: foreignChat, authorType: 'user', authorId: 'user', content: 'private' })
  await assert.rejects(session.process({ chatId: state.chatId, contextRevision: 0, messageIds: [foreignMessage.messageId] }), /MESSAGE_SCOPE_INVALID/)
  state.roomDb.close()
})

test('editing input messages during evaluation invalidates the proposal', async () => {
  const state = setup()
  const session = createControllerSession({
    ...state, applyAction: () => assert.fail('stale action applied'),
    decide: async () => {
      state.repository.editMessage({ messageId: state.message.messageId, content: 'Stop instead' })
      return { actions: [] }
    },
  })
  await assert.rejects(session.process({ chatId: state.chatId, contextRevision: 0, messageIds: [state.message.messageId] }), /MESSAGES_STALE/)
  state.roomDb.close()
})

test('timeout aborts the router, releases the chat and ignores late actions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = setup()
  let routerSignal
  let finish
  let calls = 0
  const session = createControllerSession({
    ...state, timeoutMs: 100,
    applyAction: () => assert.fail('late action applied'),
    decide: input => {
      calls += 1
      if (calls > 1) return { actions: [] }
      routerSignal = input.signal
      return new Promise(resolve => { finish = resolve })
    },
  })
  const running = session.process({ chatId: state.chatId, batchId: 'timeout-batch', contextRevision: 0 })
  const rejected = assert.rejects(running, /ROOM_CONTROLLER_TIMEOUT/)
  t.mock.timers.tick(100)
  await rejected
  assert.equal(routerSignal.aborted, true)
  assert.equal(state.repository.getControllerDecision({ chatId: state.chatId, batchId: 'timeout-batch' }), undefined)
  await session.process({ chatId: state.chatId, batchId: 'retry-batch', contextRevision: 0 })
  finish({ actions: [{ type: 'note', chatId: state.chatId, contextRevision: 0, content: 'too late' }] })
  await Promise.resolve()
  assert.equal(state.roomDb.database.prepare('SELECT COUNT(*) AS count FROM controller_decisions').get().count, 1)
  state.roomDb.close()
})

test('caller cancellation prevents writes even if the router ignores abort', async () => {
  const state = setup()
  const abort = new AbortController()
  let routerSignal
  let fail
  const session = createControllerSession({
    ...state,
    applyAction: () => assert.fail('cancelled action applied'),
    decide: input => {
      routerSignal = input.signal
      return new Promise((_resolve, reject) => { fail = reject })
    },
  })
  const running = session.process({ chatId: state.chatId, contextRevision: 0, signal: abort.signal })
  abort.abort()
  await assert.rejects(running, /ROOM_CONTROLLER_CANCELLED/)
  assert.equal(routerSignal.aborted, true)
  fail(new Error('late failure'))
  await Promise.resolve()
  assert.equal(state.roomDb.database.prepare('SELECT COUNT(*) AS count FROM controller_decisions').get().count, 0)
  state.roomDb.close()
})

test('pre-cancelled batches never call the router', async () => {
  const state = setup()
  const session = createControllerSession({
    ...state, applyAction: () => ({}), decide: () => assert.fail('cancelled router called'),
  })
  await assert.rejects(session.process({ chatId: state.chatId, contextRevision: 0, signal: AbortSignal.abort() }), /ROOM_CONTROLLER_CANCELLED/)
  assert.throws(() => createControllerSession({ ...state, applyAction: () => ({}), decide: () => ({}), timeoutMs: 0 }), /TIMEOUT_INVALID/)
  state.roomDb.close()
})

test('controller events are scoped to the current chat and recorded as decision inputs', async () => {
  const state = setup()
  const roomId = state.repository.getChatContext(state.chatId).chat.room_id
  const event = state.repository.appendEvent({ roomId, chatId: state.chatId, actorId: 'supervisor', type: 'report_received' })
  const session = createControllerSession({
    ...state, applyAction: () => ({}),
    decide: async input => {
      assert.equal(input.events[0].id, event.eventId)
      return { actions: [] }
    },
  })
  const result = await session.process({ chatId: state.chatId, contextRevision: 0, triggerEventIds: [event.eventId] })
  assert.deepEqual(result.decision.inputIds, [event.eventId])
  const otherChat = state.repository.createChat({ roomId, title: 'Other' })
  const foreign = state.repository.appendEvent({ roomId, chatId: otherChat, actorId: 'supervisor', type: 'report_received' })
  await assert.rejects(session.process({ chatId: state.chatId, contextRevision: 0, triggerEventIds: [foreign.eventId] }), /EVENT_SCOPE_INVALID/)
  state.roomDb.close()
})
