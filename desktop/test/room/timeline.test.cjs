const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  return { roomDb, repo, chatId, timeline: createTimeline({ roomDb, repository: repo }) }
}

test('append assigns seq, dedupes clientId, and advances activity only for public rows', t => {
  const { roomDb, chatId, timeline } = setup(t)
  const first = timeline.append({ chatId, authorType: 'user', authorId: 'user', content: 'hi', clientId: 'c1' })
  const again = timeline.append({ chatId, authorType: 'user', authorId: 'user', content: 'hi', clientId: 'c1' })
  assert.equal(first.id, again.id)
  const review = timeline.append({ chatId, authorType: 'system', authorId: 'system', kind: 'captain_review', content: 'review', audience: 'captain', status: 'done' })
  assert.equal(timeline.activitySeq(chatId), 1)
  assert.equal(timeline.latest(chatId).seq, review.seq)
  const edited = timeline.edit(first.id, { content: 'hello' })
  assert.equal(edited.message.content, 'hello')
  assert.equal(timeline.activitySeq(chatId), 3)
  roomDb.close()
})

test('finish and transition enforce status changes', t => {
  const { roomDb, chatId, timeline } = setup(t)
  const row = timeline.append({ chatId, authorType: 'agent', authorId: 'a', content: '' })
  assert.equal(timeline.transition(row.id, ['queued'], 'working').status, 'working')
  assert.equal(timeline.finish(row.id, { status: 'done', text: 'ok' }).status, 'done')
  assert.equal(timeline.transition(row.id, ['working'], 'failed'), undefined)
  roomDb.close()
})
