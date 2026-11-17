const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { ShadowRepo } = require('./shadow-git.cjs')

function createArtifactReader({ roomDb, directory }) {
  if (!roomDb || !path.isAbsolute(directory || '')) throw new TypeError('ROOM_ARTIFACT_READER_DEPENDENCIES_REQUIRED')
  const db = roomDb.database
  return async function artifactDiff({ roomId, artifactId }) {
    const artifact = db.prepare('SELECT * FROM artifacts WHERE id=? AND room_id=?').get(artifactId, roomId)
    if (!artifact) throw new Error('ROOM_ARTIFACT_NOT_FOUND')
    const event = db.prepare(`SELECT payload_json FROM events WHERE room_id=? AND type='artifact_snapshot_created'
      AND json_extract(payload_json, '$.phase')='after'
      AND EXISTS (SELECT 1 FROM json_each(events.payload_json, '$.artifactIds') WHERE value=?) LIMIT 1`).get(roomId, artifactId)
    const receipt = event ? JSON.parse(event.payload_json) : null
    const commit = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
    if (!receipt || receipt.commit !== artifact.version || receipt.assignmentId !== artifact.source_assignment_id
        || !commit.test(receipt.commit) || !commit.test(receipt.baseCommit)) throw new Error('ROOM_ARTIFACT_DIFF_UNAVAILABLE')
    const relative = artifact.path
    if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.posix.isAbsolute(relative)
        || path.win32.isAbsolute(relative) || relative.split('/').some(part => part === '..')) throw new Error('ROOM_ARTIFACT_PATH_INVALID')
    const gitDir = path.join(directory, createHash('sha256').update(roomId).digest('hex'))
    if (!fs.existsSync(gitDir)) throw new Error('ROOM_ARTIFACT_DIFF_UNAVAILABLE')
    // Both commits are immutable. Reading does not require the current project
    // directory to exist and does not initialize or mutate any repository.
    const shadow = new ShadowRepo({ gitDir, workTree: gitDir })
    // Reserve room for a UTF-8 replacement character if Git output is cut
    // inside a multibyte sequence, keeping the returned string within 256 KiB.
    const diff = await shadow.fileDiff(receipt.baseCommit, receipt.commit, `:(literal)${relative}`, { maxBytes: 256 * 1024 - 3 })
    return { artifactId, path: relative, baseVersion: receipt.baseCommit, version: receipt.commit, ...diff }
  }
}

module.exports = { createArtifactReader }
