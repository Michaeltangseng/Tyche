const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createRoomService } = require('../../src/room-engine/room-service.cjs')
const { createControllerAgent, parseControllerResponse } = require('../../src/room-engine/controller-agent.cjs')
const { normalizeContextPackId } = require('../../src/collaboration/context-pack-records.cjs')

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-controller-agent-'))
  const roomDb = openRoomDatabase({ directory })
  t.after(() => { roomDb.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo', providers: ['codex'], allowedCapabilities: ['text'] })
  const chatId = repository.createChat({ roomId, title: 'Team' })
  return { roomDb, repository, chatId }
}

test('controller response accepts only a bounded JSON object with actions', () => {
  assert.deepEqual(parseControllerResponse('{"actions":[]}'), { actions: [] })
  assert.deepEqual(parseControllerResponse('```json\n{"actions":[]}\n```'), { actions: [] })
  for (const content of ['Done: {"actions":[]}', '{"actions":[],"permission":"admin"}', '[]', '{"actions":{}}', JSON.stringify({ actions: Array(51).fill({}) })]) {
    assert.throws(() => parseControllerResponse(content), /ROOM_CONTROLLER_RESPONSE/)
  }
})

test('message queue invokes a read-only native controller and commits its actions', async t => {
  const state = setup(t)
  let invocation
  const decideController = createControllerAgent({
    repository: state.repository,
    resolveGroup: ({ assignment }) => {
      assert.equal(assignment.provider, 'codex')
      assert.equal(assignment.workspace, '/tmp/demo')
      return { id: 'native-host', workdir: '/tmp/demo' }
    },
    invokeAgent: async (...args) => {
      invocation = args
      return { pendingMessage: { content: JSON.stringify({ actions: [
        { type: 'create_task', chatId: state.chatId, contextRevision: 0, objective: 'Write requirements', kind: 'draft' },
      ] }) } }
    },
  })
  const service = createRoomService({ ...state, decideController, onControllerError: error => assert.fail(error) })
  t.after(() => service.close())
  const submitted = service.submitMessage({ chatId: state.chatId, author: { type: 'user', id: 'user' }, content: 'First write requirements' })
  await service.flushController(state.chatId)
  const context = invocation[5]
  assert.equal(invocation[1], 'codex')
  assert.equal(context.permissionMode, 'read-only')
  assert.equal(context.deferMessage, true)
  assert.equal(context.saveSession, false)
  assert.equal(normalizeContextPackId(context.contextPackId), context.contextPackId)
  assert.ok(context.promptOverride.includes(submitted.message.messageId))
  assert.equal(state.roomDb.database.prepare('SELECT objective FROM tasks').get().objective, 'Write requirements')
  assert.equal(state.roomDb.database.prepare('SELECT COUNT(*) AS count FROM controller_decisions').get().count, 1)
  await service.close()
})

test('unavailable native controller leaves explicit user mentions on the fallback path', async t => {
  const state = setup(t)
  const roleId = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user' })
  const decideController = createControllerAgent({
    repository: state.repository, resolveGroup: () => null,
    invokeAgent: () => assert.fail('unavailable controller invoked'),
  })
  const service = createRoomService({ ...state, decideController })
  const result = service.submitMessage({ chatId: state.chatId, author: { type: 'user', id: 'user' }, content: '@Writer write' })
  assert.deepEqual(result.dispatch.roleIds, [roleId])
  await service.close()
})

test('native controller forwards cancellation and rejects malformed output', async t => {
  const state = setup(t)
  const abort = new AbortController()
  const decide = createControllerAgent({
    repository: state.repository, resolveGroup: () => ({ id: 'host' }),
    invokeAgent: async (...args) => {
      assert.equal(args[3], abort.signal)
      return { pendingMessage: { content: 'I would assign someone' } }
    },
  })
  const input = { chatId: state.chatId, batchId: 'batch-test', contextRevision: 0, messages: [], roles: [], signal: abort.signal }
  await assert.rejects(decide(input), /RESPONSE_JSON_INVALID/)
  abort.abort()
  await assert.rejects(decide(input), /CONTROLLER_CANCELLED/)
})
