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
  assert.equal((await service.flushController(s.chatId)).duplicate, true)
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
  const ids = Array.from({ length: 65 }, () => s.message())
  const calls = []
  const service = s.service({ decideController: async input => { calls.push(input); return { actions: [] } } })
  await service.startRuntime()
  await service.flushController(s.chatId)
  await service.flushController(s.chatId)
  await service.flushController(s.chatId)
  assert.deepEqual(calls.map(input => input.messages.length), [32, 32, 1])
  assert.deepEqual(calls.flatMap(input => input.messages.map(message => message.id)), ids)
  assert.deepEqual(createControllerBacklog({ roomDb: s.roomDb }).list(), [])
})
