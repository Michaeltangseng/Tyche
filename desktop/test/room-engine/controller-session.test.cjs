const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createControllerSession } = require('../../src/room-engine/controller-session.cjs')

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

test('controller session rejects a stale context before calling the controller', async () => {
  const state = setup()
  let called = false
  const session = createControllerSession({ roomDb: state.roomDb, repository: state.repository, decide: async () => { called = true; return { actions: [] } }, applyAction: () => ({}) })
  await assert.rejects(session.process({ chatId: state.chatId, contextRevision: 1, messageIds: [] }), /CONTEXT_STALE/)
  assert.equal(called, false)
  state.roomDb.close()
})
