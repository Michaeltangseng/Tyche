const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createMentionFallback } = require('../../src/room-engine/mention-fallback.cjs')

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-mention-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat', contextRevision: 3 })
  const roleId = repository.createAgentRole({ chatId, displayName: 'Backend', provider: 'codex', createdBy: 'user' })
  return { roomDb, repository, chatId, roleId, fallback: createMentionFallback({ roomDb, repository }) }
}

test('explicit mention fallback creates one task and assignment', () => {
  const { roomDb, repository, chatId, roleId, fallback } = setup()
  const result = fallback.dispatch({ chatId, messageId: 'msg-1', content: '@Backend implement the API', mentions: ['Backend'], createdBy: 'user-1' })
  assert.equal(result.created, true)
  assert.equal(result.roleIds[0], roleId)
  assert.equal(repository.getTask(result.taskId).objective, 'implement the API')
  assert.equal(repository.listAssignments(result.taskId).length, 1)
  roomDb.close()
})

test('fallback is idempotent and ignores unknown mentions', () => {
  const first = setup()
  const input = { chatId: first.chatId, messageId: 'msg-1', content: '@backend review', mentions: ['backend'], createdBy: 'user-1' }
  const created = first.fallback.dispatch(input)
  const duplicate = first.fallback.dispatch(input)
  assert.equal(created.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.taskId, created.taskId)
  first.roomDb.close()

  const second = setup()
  const ignored = second.fallback.dispatch({ ...input, chatId: second.chatId, messageId: 'msg-2', mentions: ['unknown'] })
  assert.equal(ignored.reason, 'NO_ACTIVE_MENTIONED_ROLE')
  second.roomDb.close()
})

test('fallback does not dispatch archived roles', () => {
  const { roomDb, repository, chatId, roleId, fallback } = setup()
  roomDb.database.prepare('UPDATE agent_roles SET status = \'archived\' WHERE id = ?').run(roleId)
  const result = fallback.dispatch({ chatId, messageId: 'msg-3', content: '@Backend inspect', mentions: ['Backend'], createdBy: 'user-1' })
  assert.equal(result.reason, 'NO_ACTIVE_MENTIONED_ROLE')
  roomDb.close()
})
