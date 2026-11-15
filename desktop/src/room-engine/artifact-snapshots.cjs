const path = require('node:path')
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { ShadowRepo } = require('../project-room/shadow-git.cjs')
const { ensurePrivateDirectory } = require('../security/private-file.cjs')

const hash = value => createHash('sha256').update(value).digest('hex')

// Called only by main, under the native invocation's exclusive directory lease.
// Git writes have durable intents; publication and effect completion commit together.
function createArtifactSnapshots({ roomDb, repository, directory, privateRoot = directory, locale = () => 'en', createShadow = options => ShadowRepo.create(options) }) {
  if (!roomDb || !repository || !path.isAbsolute(directory || '')) throw new TypeError('ROOM_ARTIFACT_SNAPSHOTS_DEPENDENCIES_REQUIRED')
  const db = roomDb.database

  async function capture({ assignmentId, runId, workdir, phase, baseline, signal }) {
    const assignment = repository.getAssignmentContext(assignmentId)
    if (!assignment || assignment.run_id !== runId || assignment.status !== 'running'
        || fs.realpathSync.native(assignment.workspace) !== workdir) throw new Error('ROOM_ARTIFACT_ASSIGNMENT_INVALID')
    const assertActive = () => {
      if (signal?.aborted || repository.getTask(assignment.task_id)?.status === 'cancelled') throw new Error('ROOM_NATIVE_CANCELLED')
    }
    assertActive()
    if (phase === 'after' && (!baseline?.commit || !Array.isArray(baseline.placeholderList))) throw new Error('ROOM_ARTIFACT_BASELINE_REQUIRED')
    const key = `artifact-snapshot:${hash(JSON.stringify([assignmentId, runId, phase]))}`
    const effect = roomDb.withTransaction(() => {
      const existing = db.prepare('SELECT * FROM effects WHERE idempotency_key=?').get(key)
      if (existing) {
        if (existing.status !== 'succeeded') throw new Error('ROOM_ARTIFACT_SNAPSHOT_UNRESOLVED')
        return existing
      }
      const id = repository.createEffect({ chatId: assignment.chat_id, kind: 'artifact_snapshot',
        payload: { assignmentId, runId, phase, baseCommit: baseline?.commit || null }, idempotencyKey: key })
      db.prepare("UPDATE effects SET status='running', attempts=1, started_at=? WHERE id=?").run(new Date().toISOString(), id)
      return repository.getEffect(id)
    })
    const eventId = `snapshot:${effect.id}`
    if (effect.status === 'succeeded') {
      const event = db.prepare('SELECT payload_json FROM events WHERE id=?').get(eventId)
      if (!event) throw new Error('ROOM_ARTIFACT_SNAPSHOT_RECEIPT_MISSING')
      return JSON.parse(event.payload_json)
    }
    // Unknown/failed effects require inspection, never blind replay after a crash.
    if (effect.status !== 'running' || effect.attempts !== 1) throw new Error('ROOM_ARTIFACT_SNAPSHOT_UNRESOLVED')
    try {
      ensurePrivateDirectory(directory)
      const gitDir = path.join(directory, hash(assignment.room_id))
      ensurePrivateDirectory(gitDir)
      const relativePrivate = path.relative(workdir, fs.realpathSync.native(privateRoot)).split(path.sep).join('/')
      if (!relativePrivate) throw new Error('ROOM_ARTIFACT_PRIVATE_DIRECTORY_OVERLAP')
      // Character classes preserve literal names through ShadowRepo's slash
      // normalization, which intentionally treats backslashes as separators.
      const excludedPrivate = relativePrivate.replace(/\*|\?|\[/g, character => `[${character}]`)
      const shadow = await createShadow({ gitDir, workTree: workdir,
        excludePaths: !relativePrivate.startsWith('../') && !path.isAbsolute(relativePrivate) ? [`/${excludedPrivate}/`] : [] })
      const snapshot = await shadow.snapshot({ effectId: effect.id, placeholderList: baseline?.placeholderList || [] })
      if (snapshot.skipped) throw new Error('ROOM_ARTIFACT_SNAPSHOT_SKIPPED')
      assertActive()
      const changes = phase === 'after' ? await shadow.nameStatus(baseline.commit, snapshot.commit) : []
      const placeholders = new Set(snapshot.placeholderList.map(item => item.path))
      if (changes.some(change => placeholders.has(change.path))) throw new Error('ROOM_ARTIFACT_PLACEHOLDER_NOT_PUBLISHABLE')
      return roomDb.withTransaction(() => {
        assertActive()
        const artifactIds = changes.map(change => repository.createArtifact({
          artifactId: `artifact-${hash(`${effect.id}\0${change.path}`)}`,
          roomId: assignment.room_id, sourceTaskId: assignment.task_id, sourceAssignmentId: assignment.id,
          path: change.path, kind: change.status === 'D' ? 'deletion' : 'file', version: snapshot.commit,
        }))
        const receipt = { commit: snapshot.commit, baseCommit: baseline?.commit || null,
          placeholderList: snapshot.placeholderList, artifactIds, changes, assignmentId, runId, phase }
        repository.appendEvent({ eventId, roomId: assignment.room_id, chatId: assignment.chat_id,
          actorId: 'platform', type: 'artifact_snapshot_created', payload: receipt })
        db.prepare("UPDATE effects SET status='succeeded', completed_at=? WHERE id=?").run(new Date().toISOString(), effect.id)
        return receipt
      })
    } catch (error) {
      roomDb.withTransaction(() => {
        const cancelled = signal?.aborted || repository.getTask(assignment.task_id)?.status === 'cancelled'
        db.prepare('UPDATE effects SET status=?, last_error=? WHERE id=?')
          .run(cancelled ? 'cancelled' : 'unknown', String(error?.code || error?.message || error).slice(0, 2000), effect.id)
        if (!cancelled) {
          const zh = String(locale()).startsWith('zh')
          repository.createAttention({ attentionId: `snapshot-failure:${effect.id}`, chatId: assignment.chat_id,
            taskId: assignment.task_id, type: 'failure', requestedBy: 'platform',
            question: zh ? '产物版本保存未完成，请检查文件和快照记录后再继续。' : 'Output version capture did not complete. Inspect files and snapshot records before continuing.',
            options: [{ id: 'acknowledge', label: zh ? '已知悉' : 'Acknowledge' }] })
        }
      })
      throw error
    }
  }

  return {
    before: input => capture({ ...input, phase: 'before' }),
    after: async input => (await capture({ ...input, phase: 'after' })).artifactIds,
  }
}

module.exports = { createArtifactSnapshots }
