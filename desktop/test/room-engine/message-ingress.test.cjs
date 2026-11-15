const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createMessageIngress, mentionsFrom } = require('../../src/room-engine/message-ingress.cjs')

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-ingress-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat', isPrimary: true })
  return { roomDb, repository, roomId, chatId, ingress: createMessageIngress(roomDb, repository) }
}

test('mentions are deduplicated while preserving message order', () => {
  assert.deepEqual(mentionsFrom('@codex review @pi and @codex again @pi-2'), ['codex', 'pi', 'pi-2'])
})

test('message ingress writes message and event atomically', () => {
  const { roomDb, repository, roomId, chatId, ingress } = setup()
  const result = ingress.submit({ chatId, author: { type: 'user', id: 'user-1' }, content: '@codex inspect @pi' })
  assert.deepEqual(result.mentions, ['codex', 'pi'])
  assert.equal(repository.getMessage(result.message.messageId).author_id, 'user-1')
  assert.deepEqual(repository.listEvents(roomId).map((event) => ({ type: event.type, sequence: event.sequence })), [
    { type: 'message_created', sequence: 1 },
  ])
  roomDb.close()
})

test('only the author can edit or delete a message and each mutation emits an event', () => {
  const { roomDb, repository, roomId, chatId, ingress } = setup()
  const created = ingress.submit({ chatId, author: { type: 'agent', id: 'codex' }, content: 'draft' })
  assert.throws(() => ingress.edit({ messageId: created.message.messageId, author: { type: 'user', id: 'other' }, content: 'tamper' }), /ROOM_MESSAGE_EDIT_FORBIDDEN/)
  const edited = ingress.edit({ messageId: created.message.messageId, author: { type: 'agent', id: 'codex' }, content: '@pi revised' })
  assert.deepEqual(edited.mentions, ['pi'])
  const removed = ingress.remove({ messageId: created.message.messageId, author: { type: 'agent', id: 'codex' } })
  assert.equal(repository.getMessage(created.message.messageId).deleted_at !== null, true)
  assert.deepEqual(repository.listEvents(roomId).map((event) => event.type), [
    'message_created', 'message_edited', 'message_deleted',
  ])
  assert.equal(removed.event.sequence, 3)
  roomDb.close()
})

test('invalid message input is rejected before persistence', () => {
  const { roomDb, repository, chatId, ingress } = setup()
  assert.throws(() => ingress.submit({ chatId, author: { type: 'worker', id: 'x' }, content: 'bad' }), /ROOM_MESSAGE_AUTHOR_INVALID/)
  assert.throws(() => ingress.submit({ chatId, author: { type: 'user', id: 'x' }, content: '' }), /ROOM_MESSAGE_CONTENT_INVALID/)
  assert.equal(repository.listMessages(chatId).length, 0)
  roomDb.close()
})
