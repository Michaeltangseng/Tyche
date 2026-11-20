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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-room-v2-'))
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

test('startQueuedReplies surfaces a queued reply without a start effect', async t => {
  const { roomDb, chatId, roleId, timeline, engine } = setup(t)
  timeline.append({ chatId, authorType: 'agent', authorId: roleId, content: '', status: 'queued' })
  await assert.rejects(engine.startQueuedReplies({ chatId }), /ROOM_REPLY_EFFECT_NOT_FOUND/)
  roomDb.close()
})

test('the captain briefing lists every provider that can speak', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory, providers: ['claude'] })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const captainRoleId = repo.createRole({ chatId, displayName: 'Captain', provider: 'claude', prompt: 'route', isCaptain: true })
  repo.addParticipant({ chatId, roleId: captainRoleId })
  const timeline = createTimeline({ roomDb, repository: repo })
  const sessions = createSessionStore({ roomDb, repository: repo })
  const outbox = createOutbox({ roomDb, repository: repo })
  const runtime = createFakeRuntime({ deferCompletion: true })
  const engine = createEngine({
    roomDb,
    repository: repo,
    timeline,
    sessions,
    outbox,
    runtime,
    launchProviders: () => ['claude', 'codex', 'hermes'],
  })
  const { replies } = engine.submitUserMessage({ chatId, content: '做一个首页' })
  const pending = engine.startReply(replies[0].id)
  await pending.launched
  const prompt = runtime.starts[0].prompt
  assert.match(prompt, /Providers that can speak: claude, codex, hermes\n/)
  runtime.finish({ status: 'done', text: 'ok' }, replies[0].id)
  await pending.done
  roomDb.close()
})

test('the captain receives captain-only review rows in its briefing', async t => {
  const { roomDb, repo, chatId, timeline } = setup(t)
  const captainRoleId = repo.createRole({ chatId, displayName: 'Captain', provider: 'claude', prompt: 'route', isCaptain: true })
  repo.addParticipant({ chatId, roleId: captainRoleId })
  const sessions = createSessionStore({ roomDb, repository: repo })
  const outbox = createOutbox({ roomDb, repository: repo })
  const runtime = createFakeRuntime({ deferCompletion: true })
  const engine = createEngine({ roomDb, repository: repo, timeline, sessions, outbox, runtime })
  const reviewRow = timeline.append({ chatId, authorType: 'system', authorId: 'system',
    kind: 'captain_review', content: 'review body', audience: 'captain', status: 'done' })
  const reply = engine.queueReply({ chatId, roleId: captainRoleId, trigger: reviewRow })
  const pending = engine.startReply(reply.id)
  await pending.launched
  assert.equal(runtime.starts[0].prompt.includes('review body'), true)
  runtime.finish({ status: 'done', text: 'ok' }, reply.id)
  await pending.done
  roomDb.close()
})

test('completion watermark does not jump over an in-flight peer reply', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const a = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p' })
  const b = repo.createRole({ chatId, displayName: 'B', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId: a }); repo.addParticipant({ chatId, roleId: b })
  const timeline = createTimeline({ roomDb, repository: repo })
  const sessions = createSessionStore({ roomDb, repository: repo })
  const outbox = createOutbox({ roomDb, repository: repo })
  const runtime = createFakeRuntime({ deferCompletion: true })
  const engine = createEngine({ roomDb, repository: repo, timeline, sessions, outbox, runtime })

  const first = engine.submitUserMessage({ chatId, content: '@B @A hi' })
  const pendingB = engine.startReply(first.replies[0].id)
  const pendingA = engine.startReply(first.replies[1].id)
  await Promise.all([pendingA.launched, pendingB.launched])
  runtime.finish({ status: 'done', text: 'a done' }, first.replies[1].id)
  await pendingA.done
  assert.equal(sessions.getParticipantLastSeq({ chatId, roleId: a }), 1)
  runtime.finish({ status: 'done', text: 'b done' }, first.replies[0].id)
  await pendingB.done

  const second = engine.submitUserMessage({ chatId, content: '@A again' })
  const pendingA2 = engine.startReply(second.replies[0].id)
  await pendingA2.launched
  assert.equal(runtime.starts.at(-1).prompt.includes('b done'), true)
  runtime.finish({ status: 'done', text: 'ok' }, second.replies[0].id)
  await pendingA2.done
  roomDb.close()
})

test('finishing a reply preserves existing data flags such as reviewReply', async t => {
  const { roomDb, chatId, roleId, timeline, outbox, runtime, engine } = setup(t)
  const trigger = timeline.append({
    chatId, authorType: 'user', authorId: 'user', content: 'review', status: 'done',
  })
  const reply = timeline.append({
    chatId,
    authorType: 'agent',
    authorId: roleId,
    content: '',
    replyTo: trigger.id,
    rootMessageId: trigger.id,
    status: 'queued',
    data: { reviewReply: true },
  })
  outbox.enqueue({
    chatId,
    kind: 'start_reply',
    payload: { replyId: reply.id, roleId, triggerId: trigger.id },
    idempotencyKey: `start_reply:${reply.id}`,
  })
  const pending = engine.startReply(reply.id)
  await pending.launched
  runtime.finish({
    status: 'done',
    text: 'ok',
    activity: [{ name: 'read_chat', status: 'completed' }],
  })
  await pending.done
  const finished = timeline.get(reply.id)
  assert.equal(finished.data.reviewReply, true)
  assert.deepEqual(finished.data.activity, [{ name: 'read_chat', status: 'completed' }])
  roomDb.close()
})

test('startQueuedReplies keeps a participant session serial', async t => {
  const { roomDb, chatId, timeline, runtime, engine } = setup(t)
  const first = engine.submitUserMessage({ chatId, content: '@A one', clientId: 'm1' })
  const second = engine.submitUserMessage({ chatId, content: '@A two', clientId: 'm2' })
  const pending = engine.startReply(first.replies[0].id)
  await pending.launched
  await engine.startQueuedReplies({ chatId })
  assert.equal(timeline.get(second.replies[0].id).status, 'queued')

  runtime.finish({ status: 'done', text: 'ok' }, first.replies[0].id)
  await pending.done
  await engine.startQueuedReplies({ chatId })
  assert.equal(timeline.get(second.replies[0].id).status, 'working')

  runtime.finish({ status: 'done', text: 'ok' }, second.replies[0].id)
  await new Promise(resolve => setImmediate(resolve))
  roomDb.close()
})
