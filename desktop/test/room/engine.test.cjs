const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')
const { createSessionStore } = require('../../src/room/session-store.cjs')
const { createOutbox } = require('../../src/room/effects.cjs')
const { createEngine } = require('../../src/room/engine.cjs')
const { createFakeRuntime } = require('./helpers/fake-runtime.cjs')

function setup(t, { deferCompletion = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const roleId = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId })
  const timeline = createTimeline({ roomDb, repository: repo })
  const sessions = createSessionStore({ roomDb, repository: repo })
  const outbox = createOutbox({ roomDb, repository: repo })
  const runtime = createFakeRuntime({ deferCompletion })
  const engine = createEngine({ roomDb, repository: repo, timeline, sessions, outbox, runtime })
  return { roomDb, repo, chatId, roleId, timeline, sessions, outbox, runtime, engine }
}

test('effect succeeds at launch, not after the run completes', async t => {
  const { roomDb, chatId, roleId, timeline, sessions, outbox, runtime, engine } = setup(t)
  const { replies } = engine.submitUserMessage({ chatId, content: '@A hi' })
  const pending = engine.startReply(replies[0].id)
  await pending.launched
  assert.equal(outbox.get(pending.effectId).status, 'succeeded')
  assert.equal(timeline.get(replies[0].id).status, 'working')
  runtime.finish({ status: 'done', text: 'ok' })
  await pending.done
  assert.equal(timeline.get(replies[0].id).status, 'done')
  assert.equal(sessions.getParticipantLastSeq({ chatId, roleId }), 2)
  roomDb.close()
})

test('startQueuedReplies starts queued replies and clientId dedupes the user message', async t => {
  const { roomDb, chatId, timeline, runtime, engine } = setup(t)
  const first = engine.submitUserMessage({ chatId, content: 'hi', clientId: 'u1' })
  const again = engine.submitUserMessage({ chatId, content: 'hi', clientId: 'u1' })
  assert.equal(first.message.id, again.message.id)
  assert.equal(first.replies.length, 1)
  assert.equal(again.replies.length, 1)
  await engine.startQueuedReplies({ chatId })
  assert.equal(timeline.get(first.replies[0].id).status, 'working')
  runtime.finish({ status: 'done', text: 'ok' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(timeline.get(first.replies[0].id).status, 'done')
  roomDb.close()
})

test('stopReply aborts a working reply and finishes it as stopped', async t => {
  const { roomDb, chatId, timeline, runtime, engine } = setup(t)
  const { replies } = engine.submitUserMessage({ chatId, content: 'hi' })
  const pending = engine.startReply(replies[0].id)
  await pending.launched
  const stopping = engine.stopReply({ replyId: replies[0].id })
  runtime.finish({ status: 'stopped', text: 'stopped' })
  await stopping
  assert.equal(timeline.get(replies[0].id).status, 'stopped')
  roomDb.close()
})
