const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createRoomService } = require('../../src/room-engine/room-service.cjs')
const { createControllerBacklog } = require('../../src/room-engine/controller-backlog.cjs')

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-backlog-'))
  let roomDb = openRoomDatabase({ directory })
  let repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Recovery', workspace: '/tmp/recovery' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const services = []
  t.after(async () => {
    for (const service of services) await service.close()
    roomDb.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    get roomDb() { return roomDb }, get repository() { return repository }, roomId, chatId,
    reopen() { roomDb.close(); roomDb = openRoomDatabase({ directory }); repository = createRoomRepository(roomDb) },
    service(options = {}) {
      const service = createRoomService({ roomDb, repository, controllerBatchDelayMs: 60_000, ...options })
      services.push(service)
      return service
    },
    message(chat = chatId, content = 'Continue') { return repository.appendMessage({ chatId: chat, authorType: 'user', authorId: 'user', content }).messageId },
    event(type, chat = chatId) { return repository.appendEvent({ roomId, chatId: chat, actorId: 'platform', type }).eventId },
  }
}

test('startup recovers persisted messages and business events once across database reopens', async t => {
  const s = setup(t)
  const messageId = s.message()
  const reportEvent = s.event('report_received')
  const attentionEvent = s.event('user_answer_attention')
  s.event('session_liveness')
  s.event('session_exited')
  s.reopen()
  const calls = []
  const service = s.service({ decideController: async input => { calls.push(input); return { actions: [] } } })
  await service.startRuntime()
  await service.startRuntime() // repeated startup scans may enqueue the same IDs
  await service.flushController(s.chatId)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].messages.map(message => message.id), [messageId])
  assert.deepEqual(calls[0].events.map(event => event.id), [reportEvent, attentionEvent])
  await service.close()
  s.reopen()
  const restarted = s.service({ decideController: () => assert.fail('committed inputs were replayed') })
  await restarted.startRuntime()
  assert.equal(await restarted.flushController(s.chatId), null)
})

test('failed model evaluation remains recoverable and does not create duplicate actions', async t => {
  const s = setup(t)
  const messageId = s.message()
  const errors = []
  const first = s.service({ onControllerError: error => errors.push(error), decideController: async () => { throw new Error('offline') } })
  await first.startRuntime()
  await assert.rejects(first.flushController(s.chatId), /offline/)
  assert.equal(errors.length, 1)
  await first.close()
  s.reopen()
  const restarted = s.service({ decideController: async input => ({ actions: [{
    type: 'create_task', chatId: input.chatId, contextRevision: input.contextRevision, objective: 'Recovered task', sourceMessageIds: [messageId],
  }] }) })
  await restarted.startRuntime()
  await restarted.flushController(s.chatId)
  assert.equal(s.roomDb.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1)
  // A repeated input with a new batch ID must not call the model or apply again.
  const duplicate = await restarted.processControllerBatch({ chatId: s.chatId, batchId: 'new-batch', contextRevision: 0, messageIds: [messageId] })
  assert.equal(duplicate.duplicate, true)
  assert.equal(s.roomDb.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1)
})

test('committed action events are recovered even when their originating decision is consumed', async t => {
  const s = setup(t)
  const messageId = s.message()
  const eventId = s.event('action_create_task')
  s.repository.createControllerDecision({ chatId: s.chatId, batchId: 'before-crash', contextRevision: 0, inputIds: [messageId], actionIds: [eventId] })
  s.reopen()
  const calls = []
  const service = s.service({ decideController: async input => { calls.push(input); return { actions: [] } } })
  await service.startRuntime()
  await service.flushController(s.chatId)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].messages.length, 0)
  assert.deepEqual(calls[0].events.map(event => event.id), [eventId])
})

test('context-only changes wake subsequent routing and their events survive a restart', async t => {
  const s = setup(t)
  const calls = []
  const messageId = s.message(s.chatId, 'From now on write concise reports')
  const service = s.service({ decideController: async input => {
    calls.push(input)
    return { actions: input.messages.length ? [{ type: 'update_context', chatId: s.chatId,
      contextRevision: input.contextRevision, instructions: 'Write concise reports.', sourceMessageIds: [messageId] }] : [] }
  } })
  await service.startRuntime()
  await service.flushController(s.chatId)
  await service.flushController(s.chatId)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].contextRevision, 1)
  assert.equal(calls[1].context.instructions, 'Write concise reports.')
  assert.equal(calls[1].events[0].type, 'action_update_context')
  await service.close()
  const recoveryEvent = s.event('action_update_context')
  s.reopen()
  const recovered = []
  const restarted = s.service({ decideController: async input => { recovered.push(input); return { actions: [] } } })
  await restarted.startRuntime()
  await restarted.flushController(s.chatId)
  assert.deepEqual(recovered[0].events.map(event => event.id), [recoveryEvent])
  assert.equal(recovered[0].context.instructions, 'Write concise reports.')
})

test('paused chats wait for resume; archived and legacy chats are excluded', async t => {
  const s = setup(t)
  const messageId = s.message()
  s.roomDb.database.prepare("UPDATE chats SET status = 'paused' WHERE id = ?").run(s.chatId)
  const archived = s.repository.createChat({ roomId: s.roomId, title: 'Archived' })
  s.roomDb.database.prepare("UPDATE chats SET status = 'archived' WHERE id = ?").run(archived)
  const legacy = s.repository.createChat({ roomId: s.roomId, title: 'Legacy', engineVersion: 'legacy' })
  s.message(archived)
  s.message(legacy)
  const calls = []
  const service = s.service({ decideController: async input => { calls.push(input); return { actions: [] } } })
  await service.startRuntime()
  assert.equal(await service.flushController(s.chatId), null)
  service.applyUserCommand({ type: 'resume_chat', chatId: s.chatId })
  await service.flushController(s.chatId)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].messages.map(message => message.id), [messageId])
  assert.equal(calls[0].events[0].type, 'user_resume_chat')
})

test('fallback-dispatched, deleted and system messages are not recovered', async t => {
  const s = setup(t)
  s.repository.createAgentRole({ chatId: s.chatId, displayName: 'Worker', provider: 'codex', createdBy: 'user' })
  const offline = s.service()
  const submitted = offline.submitMessage({ chatId: s.chatId, author: { type: 'user', id: 'user' }, content: '@Worker build' })
  assert.equal(submitted.dispatch.created, true)
  s.repository.deleteMessage({ messageId: s.message() })
  s.repository.appendMessage({ chatId: s.chatId, authorType: 'system', authorId: 'system', content: 'Info' })
  await offline.close()
  s.reopen()
  const service = s.service({ decideController: () => assert.fail('fallback request duplicated') })
  await service.startRuntime()
  assert.equal(await service.flushController(s.chatId), null)
  assert.equal(s.roomDb.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1)
})

test('unavailable controller leaves the backlog intact until runtime is started again', async t => {
  const s = setup(t)
  s.message()
  let available = false
  const calls = []
  const decide = async input => { calls.push(input); return { actions: [] } }
  decide.isAvailable = () => available
  const service = s.service({ decideController: decide })
  await service.startRuntime()
  assert.equal(await service.flushController(s.chatId), null)
  assert.equal(createControllerBacklog({ roomDb: s.roomDb }).list().length, 1)
  available = true
  await service.startRuntime()
  await service.flushController(s.chatId)
  assert.equal(calls.length, 1)
})

test('pending input redelivered during evaluation is filtered after its first decision commits', async t => {
  const s = setup(t)
  s.message()
  let finish
  let calls = 0
  const service = s.service({ decideController: () => { calls += 1; return new Promise(resolve => { finish = resolve }) } })
  await service.startRuntime()
  const running = service.flushController(s.chatId)
  await Promise.resolve()
  await service.startRuntime()
  finish({ actions: [] })
  await running
  assert.equal(await service.flushController(s.chatId), null)
  assert.equal(calls, 1)
})

test('failed decision commit leaves inputs pending together with rolled-back actions', async t => {
  const s = setup(t)
  const messageId = s.message()
  s.roomDb.database.exec(`CREATE TRIGGER reject_decision BEFORE INSERT ON controller_decisions
    BEGIN SELECT RAISE(ABORT, 'decision write failed'); END;`)
  const decideController = async input => ({ actions: [{
    type: 'create_task', chatId: input.chatId, contextRevision: input.contextRevision, objective: 'Atomic recovery',
  }] })
  const failed = s.service({ decideController, onControllerError: () => {} })
  await failed.startRuntime()
  await assert.rejects(failed.flushController(s.chatId), /decision write failed/)
  assert.equal(s.roomDb.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0)
  assert.deepEqual(createControllerBacklog({ roomDb: s.roomDb }).list(), [{ chatId: s.chatId, messageId }])
  await failed.close()
  s.roomDb.database.exec('DROP TRIGGER reject_decision')
  s.reopen()
  const restarted = s.service({ decideController })
  await restarted.startRuntime()
  await restarted.flushController(s.chatId)
  assert.equal(s.roomDb.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1)
})

test('service automatically retries transient controller failure and commits its input only once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = setup(t)
  const messageId = s.message()
  const errors = []
  let calls = 0
  const service = s.service({ onControllerError: error => errors.push(error), decideController: async input => {
    calls += 1
    if (calls === 1) throw new Error('ROOM_CONTROLLER_TIMEOUT')
    assert.deepEqual(input.messages.map(message => message.id), [messageId])
    return { actions: [] }
  } })
  await service.startRuntime()
  await assert.rejects(service.flushController(s.chatId), /TIMEOUT/)
  assert.equal(s.roomDb.database.prepare('SELECT COUNT(*) AS count FROM controller_decisions').get().count, 0)
  assert.equal(await service.flushController(s.chatId), null)
  t.mock.timers.tick(1000)
  await service.flushController(s.chatId)
  assert.equal(calls, 2)
  assert.equal(errors.length, 1)
  assert.equal(s.roomDb.database.prepare('SELECT COUNT(*) AS count FROM controller_decisions').get().count, 1)
  assert.deepEqual(createControllerBacklog({ roomDb: s.roomDb }).list(), [])
})

test('service does not automatically retry malformed controller actions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = setup(t)
  s.message()
  let calls = 0
  const service = s.service({ onControllerError: () => {}, decideController: async input => {
    calls += 1
    return { actions: [{ type: 'stop_task', chatId: input.chatId, contextRevision: input.contextRevision }] }
  } })
  await service.startRuntime()
  await assert.rejects(service.flushController(s.chatId), /ACTION_TYPE_INVALID/)
  t.mock.timers.tick(30_000)
  assert.equal(await service.flushController(s.chatId), null)
  assert.equal(calls, 1)
  assert.equal(createControllerBacklog({ roomDb: s.roomDb }).list().length, 1)
})

test('startup backlog drains through bounded controller batches', async t => {
  const s = setup(t)
  const ids = s.roomDb.withTransaction(() => Array.from({ length: 600 }, () => s.message()))
  assert.equal(createControllerBacklog({ roomDb: s.roomDb }).list().length, 256)
  const calls = []
  const service = s.service({ decideController: async input => { calls.push(input); return { actions: [] } } })
  await service.startRuntime()
  for (let batch = 0; batch < 20; batch += 1) {
    if (await service.flushController(s.chatId) === null) break
  }
  assert.deepEqual(calls.map(input => input.messages.length), [...Array(18).fill(32), 24])
  assert.deepEqual(calls.flatMap(input => input.messages.map(message => message.id)), ids)
  assert.deepEqual(createControllerBacklog({ roomDb: s.roomDb }).list(), [])
})

test('backlog pages exclude queued keys without losing later messages or business events', t => {
  const s = setup(t)
  const messages = Array.from({ length: 5 }, () => s.message())
  const eventId = s.event('report_received')
  const backlog = createControllerBacklog({ roomDb: s.roomDb })
  const first = backlog.list({ chatId: s.chatId, limit: 3 })
  assert.deepEqual(first.map(input => input.messageId), messages.slice(0, 3))
  const second = backlog.list({ chatId: s.chatId, limit: 3, excludeKeys: first.map(input => `message:${input.messageId}`) })
  assert.deepEqual(second, [{ chatId: s.chatId, messageId: messages[3] }, { chatId: s.chatId, messageId: messages[4] }, { chatId: s.chatId, eventId }])
  for (const limit of [0, -1, 4097, 1.5]) assert.throws(() => backlog.list({ limit }), /LIMIT_INVALID/)
})

test('terminal controller failures stop automatic refill until an explicit resume', async t => {
  const s = setup(t)
  const messageId = s.message()
  const calls = []
  const service = s.service({ onControllerError: () => {}, decideController: async input => {
    calls.push(input)
    if (calls.length === 1) throw new Error('non-retryable failure')
    return { actions: [] }
  } })
  await service.startRuntime()
  await assert.rejects(service.flushController(s.chatId), /non-retryable failure/)
  assert.equal(service.snapshot({ roomId: s.roomId }).chats[0].controller_blocked, true)
  service.submitMessage({ chatId: s.chatId, author: { type: 'user', id: 'user' }, content: 'Additional input' })
  assert.equal(await service.flushController(s.chatId), null)
  assert.equal(calls.length, 1)
  service.applyUserCommand({ type: 'resume_chat', chatId: s.chatId })
  assert.equal(service.snapshot({ roomId: s.roomId }).chats[0].controller_blocked, false)
  await service.flushController(s.chatId)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].messages[0].id, messageId)
  assert.equal(calls[1].messages.length, 2)
})

test('live messages exceeding chat capacity remain durable and drain without a restart', async t => {
  const s = setup(t)
  const ids = []
  const routed = []
  const errors = []
  const service = s.service({ onControllerError: error => errors.push(error), decideController: async input => {
    routed.push(...input.messages.map(message => message.id))
    return { actions: [] }
  } })
  for (let index = 0; index < 150; index += 1) {
    ids.push(service.submitMessage({ chatId: s.chatId, author: { type: 'user', id: 'user' }, content: `Input ${index}` }).message.messageId)
  }
  for (let batch = 0; batch < 6; batch += 1) if (await service.flushController(s.chatId) === null) break
  assert.deepEqual(routed, ids)
  assert.deepEqual(errors, [])
  assert.deepEqual(createControllerBacklog({ roomDb: s.roomDb }).list(), [])
})
