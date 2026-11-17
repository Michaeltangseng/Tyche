const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')
const { createOutbox } = require('../../src/room/effects.cjs')
const { createTaskQueue } = require('../../src/room/task-queue.cjs')
const { recoverOnStart, reconcileProcess, activateLane } = require('../../src/room/recovery.cjs')

test('restart keeps queued, interrupts working, marks runs unknown, and never replays unknown effects', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const roleId = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId })
  const timeline = createTimeline({ roomDb, repository: repo })
  const outbox = createOutbox({ roomDb, repository: repo })
  const queue = createTaskQueue({ roomDb, repository: repo, timeline, outbox })

  const queued = timeline.append({ chatId, authorType: 'agent', authorId: roleId, content: '', status: 'queued' })
  const working = timeline.append({ chatId, authorType: 'agent', authorId: roleId, content: '', status: 'working' })
  const waiting = timeline.append({ chatId, authorType: 'agent', authorId: roleId, content: '', status: 'waiting_for_input' })

  const writeTask = queue.createTask({ chatId, roleId, title: 'W', description: 'D', acceptance: 'A' })
  const writeRunId = writeTask.runId
  roomDb.database.prepare("UPDATE task_runs SET status='running', write_scopes_json='[\"src\"]' WHERE id=?").run(writeRunId)
  const readTask = queue.createTask({ chatId, roleId, title: 'R', description: 'D', acceptance: 'A' })
  const readRunId = readTask.runId
  roomDb.database.prepare("UPDATE task_runs SET status='running' WHERE id=?").run(readRunId)

  const effect = outbox.enqueue({ chatId, kind: 'start_run', payload: { runId: writeRunId }, idempotencyKey: 'running-effect' })
  outbox.claim(effect.id)

  const recovered = recoverOnStart({ roomDb, repository: repo })
  assert.equal(recovered.interruptedMessages, 2)
  assert.equal(recovered.interruptedRuns, 2)
  assert.equal(recovered.unknownEffects, 1)
  assert.equal(timeline.get(queued.id).status, 'queued')
  assert.equal(timeline.get(working.id).status, 'interrupted')
  assert.equal(timeline.get(waiting.id).status, 'interrupted')
  const writeRun = roomDb.database.prepare('SELECT * FROM task_runs WHERE id=?').get(writeRunId)
  assert.equal(writeRun.status, 'interrupted')
  assert.equal(writeRun.outcome, 'unknown')
  assert.equal(roomDb.database.prepare('SELECT * FROM effects WHERE id=?').get(effect.id).status, 'unknown')
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM attentions WHERE task_id=?').get(writeTask.taskId).n, 1)
  assert.equal(roomDb.database.prepare('SELECT COUNT(*) AS n FROM attentions WHERE task_id=?').get(readTask.taskId).n, 0)
  assert.equal(queue.getLane({ taskId: writeTask.taskId, roleId }).active, false)

  const restarted = []
  const runnable = createTaskQueue({ roomDb, repository: repo, timeline, outbox,
    startRun: async run => { restarted.push(run.id) } })
  runnable.enqueueRun({ taskId: writeTask.taskId, roleId, laneKind: 'executor' })
  assert.equal((await runnable.pump({ roomId })).length, 0)
  activateLane({ roomDb, taskId: writeTask.taskId, roleId })
  assert.equal(queue.getLane({ taskId: writeTask.taskId, roleId }).active, true)
  assert.equal((await runnable.pump({ roomId })).length, 1)
  assert.equal(restarted.length, 1)
  roomDb.close()
})

test('reconcileProcess requires every record to match and be ended', () => {
  assert.deepEqual(reconcileProcess({ runId: 'r1', records: [{ runId: 'r1', identity: 'r1', ended: true }] }),
    { exited: true, known: true })
  assert.deepEqual(reconcileProcess({ runId: 'r1', records: [{ runId: 'r1', identity: 'r1', ended: false }] }),
    { exited: false, known: true })
  assert.deepEqual(reconcileProcess({ runId: 'r1', records: [{ runId: 'r1', identity: 'other', ended: true }] }),
    { exited: false, known: false })
  assert.deepEqual(reconcileProcess({ runId: 'r1', records: [] }), { exited: false, known: false })
})
