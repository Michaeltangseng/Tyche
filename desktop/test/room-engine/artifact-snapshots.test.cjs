const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const test = require('node:test')
const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createArtifactSnapshots } = require('../../src/room-engine/artifact-snapshots.cjs')
const { createRuntimeRecovery } = require('../../src/room-engine/runtime-recovery.cjs')

function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-artifacts-'))
  const workdir = path.join(root, 'project')
  const privateRoot = path.join(workdir, 'private[records]')
  fs.mkdirSync(workdir)
  const roomDb = openRoomDatabase({ directory: privateRoot })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Project', workspace: workdir })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const roleId = repository.createAgentRole({ chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user' })
  const taskId = repository.createTask({ chatId, objective: 'Write docs', createdBy: 'user' })
  const assignmentId = repository.createAssignment({ taskId, roleId, runId: 'run-1', status: 'running', writeScopes: ['docs/'] })
  const publisher = createArtifactSnapshots({ roomDb, repository, directory: path.join(privateRoot, 'artifacts'), privateRoot, ...options })
  t.after(() => { roomDb.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { roomDb, repository, roomId, taskId, assignmentId, publisher, workdir, privateRoot,
    input: { assignmentId, runId: 'run-1', workdir: fs.realpathSync.native(workdir) } }
}

test('private snapshots publish changed file versions without touching user Git or private records', async t => {
  const s = setup(t)
  execFileSync('git', ['init', '-q'], { cwd: s.workdir })
  fs.writeFileSync(path.join(s.workdir, 'existing.md'), 'original')
  fs.writeFileSync(path.join(s.workdir, 'removed.md'), 'remove me')
  execFileSync('git', ['add', 'existing.md'], { cwd: s.workdir })
  const index = fs.readFileSync(path.join(s.workdir, '.git', 'index'))
  const baseline = await s.publisher.before(s.input)
  fs.writeFileSync(path.join(s.workdir, 'existing.md'), 'updated')
  fs.unlinkSync(path.join(s.workdir, 'removed.md'))
  fs.mkdirSync(path.join(s.workdir, 'docs'))
  fs.writeFileSync(path.join(s.workdir, 'docs', 'requirements.md'), 'Snake MVP')
  const ids = await s.publisher.after({ ...s.input, baseline })
  assert.equal(ids.length, 3)
  assert.deepEqual(await s.publisher.after({ ...s.input, baseline }), ids)
  const snapshot = s.repository.getRoomSnapshot(s.roomId)
  assert.deepEqual(snapshot.artifacts.map(a => a.path).sort(), ['docs/requirements.md', 'existing.md', 'removed.md'])
  assert.equal(snapshot.artifacts.find(a => a.path === 'removed.md').kind, 'deletion')
  assert.ok(snapshot.artifacts.every(a => a.source_assignment_id === s.assignmentId && /^[a-f0-9]{40,64}$/.test(a.version)))
  const receipt = s.repository.listEvents(s.roomId).find(e => JSON.parse(e.payload_json).phase === 'after')
  assert.equal(JSON.parse(receipt.payload_json).baseCommit, baseline.commit)
  assert.deepEqual(fs.readFileSync(path.join(s.workdir, '.git', 'index')), index)
  assert.equal(s.roomDb.database.prepare("SELECT count(*) AS n FROM effects WHERE status='succeeded'").get().n, 2)
})

test('unchanged outputs create no artifacts and capture failure blocks publication with Attention', async t => {
  const s = setup(t)
  fs.writeFileSync(path.join(s.workdir, 'readme.md'), 'same')
  const baseline = await s.publisher.before(s.input)
  assert.deepEqual(await s.publisher.after({ ...s.input, baseline }), [])
  const failed = createArtifactSnapshots({ roomDb: s.roomDb, repository: s.repository,
    directory: path.join(s.workdir, 'private', 'failed'), createShadow: async () => {
      assert.equal(s.roomDb.database.prepare("SELECT count(*) AS n FROM effects WHERE status='running'").get().n, 1)
      throw new Error('disk failure')
    } })
  s.roomDb.database.prepare('UPDATE assignments SET run_id=? WHERE id=?').run('run-2', s.assignmentId)
  await assert.rejects(failed.before({ ...s.input, runId: 'run-2' }), /disk failure/)
  assert.equal(s.repository.getRoomSnapshot(s.roomId).attentions.length, 1)
  assert.equal(s.roomDb.database.prepare("SELECT count(*) AS n FROM effects WHERE status='unknown'").get().n, 1)
  await assert.rejects(failed.before({ ...s.input, runId: 'run-2' }), /UNRESOLVED/)
})

test('restart marks an interrupted snapshot unknown without publishing artifacts', async t => {
  const s = setup(t)
  // Leave an actual interrupted running intent, then use the existing recovery path.
  const createEffect = s.repository.createEffect
  const id = createEffect({ chatId: s.repository.getAssignmentContext(s.assignmentId).chat_id, kind: 'artifact_snapshot',
    payload: { assignmentId: s.assignmentId, runId: 'run-1', phase: 'before' }, idempotencyKey: 'interrupted' })
  s.roomDb.database.prepare("UPDATE effects SET status='running' WHERE id=?").run(id)
  const recovered = createRuntimeRecovery(s).recover()
  assert.ok(recovered.unknownEffectIds.includes(id))
  assert.equal(s.repository.getEffect(id).status, 'unknown')
  assert.equal(s.repository.getRoomSnapshot(s.roomId).artifacts.length, 0)
})

test('cancellation while snapshotting cannot publish artifacts or request an unnecessary decision', async t => {
  const abort = new AbortController()
  const s = setup(t, { createShadow: async () => ({ snapshot: async () => {
    abort.abort()
    return { commit: 'a'.repeat(40), placeholderList: [], skipped: false }
  } }) })
  await assert.rejects(s.publisher.before({ ...s.input, signal: abort.signal }), /CANCELLED/)
  assert.equal(s.repository.getRoomSnapshot(s.roomId).artifacts.length, 0)
  assert.equal(s.repository.getRoomSnapshot(s.roomId).attentions.length, 0)
  assert.equal(s.roomDb.database.prepare('SELECT status FROM effects').get().status, 'cancelled')
})

test('publication failure rolls back all artifacts and leaves the snapshot outcome unknown', async t => {
  const s = setup(t)
  const baseline = await s.publisher.before(s.input)
  fs.writeFileSync(path.join(s.workdir, 'a.md'), 'a')
  fs.writeFileSync(path.join(s.workdir, 'b.md'), 'b')
  const createArtifact = s.repository.createArtifact
  let writes = 0
  s.repository.createArtifact = input => {
    if (++writes === 2) throw new Error('ledger full')
    return createArtifact(input)
  }
  await assert.rejects(s.publisher.after({ ...s.input, baseline }), /ledger full/)
  assert.equal(s.repository.getRoomSnapshot(s.roomId).artifacts.length, 0)
  assert.equal(s.roomDb.database.prepare("SELECT count(*) AS n FROM effects WHERE status='unknown'").get().n, 1)
  assert.equal(s.repository.getRoomSnapshot(s.roomId).attentions.length, 1)
})
