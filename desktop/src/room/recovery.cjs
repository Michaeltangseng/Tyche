const crypto = require('node:crypto')

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function recoverOnStart({ roomDb, repository, now = () => Date.now() }) {
  const { database } = roomDb
  const at = new Date(now()).toISOString()
  return roomDb.withTransaction(() => {
    const interruptedRuns = database.prepare(`
      SELECT r.*, t.chat_id FROM task_runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.status IN ('starting', 'running')
    `).all()
    const messages = database.prepare(`
      UPDATE messages SET status = 'interrupted'
      WHERE status IN ('working', 'waiting_for_input')
    `).run()
    const runs = database.prepare(`
      UPDATE task_runs SET status = 'interrupted', outcome = 'unknown', snapshot_state = 'unknown',
        ended_at = ?, reason = 'restart recovery'
      WHERE status IN ('starting', 'running')
    `).run(at)
    const effects = database.prepare(`
      UPDATE effects SET status = 'unknown', last_error = 'restart recovery', completed_at = ?
      WHERE status = 'running'
    `).run(at)

    const laneIds = [...new Set(interruptedRuns.map(run => run.lane_id))]
    for (const laneId of laneIds) {
      database.prepare('UPDATE task_lanes SET active = 0 WHERE id = ?').run(laneId)
    }

    let attentionsCreated = 0
    for (const run of interruptedRuns) {
      const writeScopes = parseJson(run.write_scopes_json, [])
      if (writeScopes.length === 0) continue
      database.prepare(`
        INSERT INTO attentions (id, chat_id, task_id, type, question, options_json, status, requested_by, created_at)
        VALUES (?, ?, ?, 'run_interrupted_unknown', ?, '[]', 'open', ?, ?)
      `).run(
        crypto.randomUUID(),
        run.chat_id,
        run.task_id,
        `Run ${run.id} was interrupted by a restart and may have written to disk.`,
        run.role_id,
        at,
      )
      attentionsCreated += 1
    }

    return {
      interruptedMessages: messages.changes,
      interruptedRuns: runs.changes,
      unknownEffects: effects.changes,
      attentionsCreated,
      lanesSuspended: laneIds.length,
    }
  })
}

function activateLane({ roomDb, taskId, roleId, kind = 'executor' }) {
  const result = roomDb.database.prepare(`
    UPDATE task_lanes SET active = 1 WHERE task_id = ? AND role_id = ? AND kind = ?
  `).run(taskId, roleId, kind)
  if (result.changes === 0) throw new Error('ROOM_TASK_LANE_NOT_FOUND')
}

function reconcileProcess({ runId, records }) {
  if (!Array.isArray(records) || records.length === 0) return { exited: false, known: false }
  const known = records.every(record => record.identity === runId)
  const exited = known && records.every(record => record.ended === true)
  return { exited, known }
}

module.exports = { recoverOnStart, reconcileProcess, activateLane }
