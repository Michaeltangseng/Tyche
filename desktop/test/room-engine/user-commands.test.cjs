const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createUserCommandService } = require('../../src/room-engine/user-commands.cjs')

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-user-command-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const attentionId = repository.createAttention({ chatId, type: 'decision', question: 'Accept?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], requestedBy: 'controller' })
  const artifactId = repository.createArtifact({ roomId, path: 'docs/draft.md', kind: 'document', version: 'v1' })
  return { roomDb, repository, chatId, attentionId, artifactId, commands: createUserCommandService({ roomDb, repository }) }
}

test('user can answer an open attention and the command is audited', () => {
  const { roomDb, commands, chatId, attentionId } = setup()
  const result = commands.apply({ type: 'answer_attention', chatId, attentionId, optionId: 'yes', comment: 'Looks good' }, { actorId: 'user-1' })
  assert.equal(result.resolution.optionId, 'yes')
  const row = roomDb.database.prepare('SELECT status, answered_by FROM attentions WHERE id = ?').get(attentionId)
  assert.equal(row.status, 'answered')
  assert.equal(row.answered_by, 'user-1')
  assert.equal(roomDb.database.prepare('SELECT type FROM events WHERE id = ?').get(result.event.eventId).type, 'user_answer_attention')
  roomDb.close()
})

test('artifact decisions and chat pause/resume update platform-owned state', () => {
  const { roomDb, commands, chatId, artifactId } = setup()
  assert.equal(commands.apply({ type: 'accept_artifact', chatId, artifactId }).status, 'accepted')
  assert.equal(commands.apply({ type: 'pause_chat', chatId }).status, 'paused')
  assert.equal(commands.apply({ type: 'resume_chat', chatId }).status, 'active')
  assert.equal(roomDb.database.prepare('SELECT status FROM artifacts WHERE id = ?').get(artifactId).status, 'accepted')
  roomDb.close()
})

test('invalid attention option and unsupported lifecycle command are rejected', () => {
  const { roomDb, commands, chatId, attentionId } = setup()
  assert.throws(() => commands.apply({ type: 'answer_attention', chatId, attentionId, optionId: 'maybe' }), /OPTION_INVALID/)
  assert.throws(() => commands.apply({ type: 'stop_task', chatId, taskId: 'task-1', reason: 'cancel' }), /UNSUPPORTED/)
  roomDb.close()
})
