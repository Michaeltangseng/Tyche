const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')
const { createRoomService } = require('../../src/room/room-service.cjs')

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-service-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const roleId = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId })
  return { roomDb, repo, roomId, chatId, roleId }
}

function createFakeAdapter() {
  let disposed = 0
  return {
    get disposed() { return disposed },
    start(input) {
      return {
        launch: Promise.resolve({ nativeSessionRef: `native-${input.runId}` }),
        completion: Promise.resolve({ status: 'done', text: 'ok', thinking: '', activity: [] }),
      }
    },
    startTaskRun(run) {
      return Promise.resolve({ runId: run.id })
    },
    async disposeAll() {
      disposed += 1
      return []
    },
  }
}

test('room service starts queued replies through liveness and disposes the adapter', async t => {
  const { roomDb, repo, chatId } = setup(t)
  const adapter = createFakeAdapter()
  const service = createRoomService({
    roomDb,
    repository: repo,
    adapter,
    livenessDebounceMs: 20,
    supervisorOptions: { debounceMs: 20 },
  })
  t.after(async () => {
    await service.close()
    roomDb.close()
  })

  const { replies } = service.submitUserMessage({ chatId, content: 'hi' })
  await service.waitForChatIdle({ chatId, timeoutMs: 3000 })
  assert.equal(service.timeline.get(replies[0].id).status, 'done')

  await service.close()
  assert.equal(adapter.disposed, 1)
})

test('room service can recover in-flight replies on open', async t => {
  const { roomDb, repo, chatId, roleId } = setup(t)
  const timeline = createTimeline({ roomDb, repository: repo })
  const message = timeline.append({
    chatId,
    authorType: 'agent',
    authorId: roleId,
    content: '',
    status: 'working',
  })
  const adapter = createFakeAdapter()
  const service = createRoomService({
    roomDb,
    repository: repo,
    adapter,
    recoverOnOpen: true,
    liveness: false,
  })
  t.after(async () => {
    await service.close()
    roomDb.close()
  })

  assert.equal(service.timeline.get(message.id).status, 'interrupted')
  assert.equal(service.recovery.interruptedMessages, 1)
})

test('room service builds the runtime adapter through the factory', async t => {
  const { roomDb, repo } = setup(t)
  const adapter = createFakeAdapter()
  let received = null
  const service = createRoomService({
    roomDb,
    repository: repo,
    adapterFactory: deps => {
      received = deps
      return adapter
    },
    liveness: false,
  })
  t.after(async () => {
    await service.close()
    roomDb.close()
  })

  assert.equal(received.roomDb, roomDb)
  assert.equal(received.dispatcher, service.dispatcher)
  assert.equal(received.timeline, service.timeline)
  assert.equal(typeof received.onTaskSettled, 'function')
  assert.equal(service.adapter, adapter)
})
