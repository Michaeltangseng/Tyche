/**
 * Bounded per-run runtime event log for the room trace.
 *
 * The adapter emits OAR events with a run/chat/task context. Text and
 * reasoning deltas are intentionally not stored here: the final reply text and
 * thinking already live on the message row. Tool/turn/usage/failure/exit
 * events are kept so the future trace view can show what happened without
 * duplicating the transcript.
 */
const crypto = require('node:crypto')

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function payloadJson(event, maxBytes) {
  let json
  try {
    json = JSON.stringify(event ?? null)
  } catch {
    json = JSON.stringify({ unserializable: true })
  }
  if (json.length <= maxBytes) return json
  return JSON.stringify({ truncated: true, preview: json.slice(0, maxBytes) })
}

function eventView(row) {
  return {
    id: row.id,
    runId: row.run_id,
    chatId: row.chat_id,
    taskId: row.task_id ?? null,
    mode: row.mode,
    seq: row.seq,
    kind: row.kind,
    payload: parseJson(row.payload_json, null),
    createdAt: row.created_at,
  }
}

function createRuntimeEvents({ roomDb, now = () => Date.now(), maxPayloadBytes = 16 * 1024 }) {
  const { database } = roomDb

  function at() {
    return new Date(now()).toISOString()
  }

  return {
    record({ runId, chatId, taskId = null, mode, event }) {
      if (typeof runId !== 'string' || runId.length === 0) throw new TypeError('ROOM_RUNTIME_EVENT_RUN_REQUIRED')
      if (typeof chatId !== 'string' || chatId.length === 0) throw new TypeError('ROOM_RUNTIME_EVENT_CHAT_REQUIRED')
      if (mode !== 'chat' && mode !== 'task') throw new TypeError('ROOM_RUNTIME_EVENT_MODE_INVALID')
      const id = crypto.randomUUID()
      const seq = Number.isInteger(event?.seq) ? event.seq : null
      const kind = typeof event?.kind === 'string' && event.kind.length > 0 ? event.kind : 'unknown'
      const createdAt = at()
      database.prepare(`
        INSERT INTO runtime_events
          (id, run_id, chat_id, task_id, mode, seq, kind, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, runId, chatId, taskId ?? null, mode, seq, kind, payloadJson(event, maxPayloadBytes), createdAt)
      return { id, runId, chatId, taskId: taskId ?? null, mode, seq, kind, payload: event ?? null, createdAt }
    },

    list({ runId = null, chatId = null, limit = 200 } = {}) {
      const bounded = Math.max(1, Math.min(1000, Number(limit) || 200))
      const clauses = []
      const parameters = []
      if (typeof runId === 'string' && runId.length > 0) {
        clauses.push('run_id = ?')
        parameters.push(runId)
      }
      if (typeof chatId === 'string' && chatId.length > 0) {
        clauses.push('chat_id = ?')
        parameters.push(chatId)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      return database.prepare(`
        SELECT * FROM runtime_events ${where}
        ORDER BY created_at ASC, rowid ASC LIMIT ?
      `).all(...parameters, bounded).map(eventView)
    },

    count({ runId = null, chatId = null } = {}) {
      const clauses = []
      const parameters = []
      if (typeof runId === 'string' && runId.length > 0) {
        clauses.push('run_id = ?')
        parameters.push(runId)
      }
      if (typeof chatId === 'string' && chatId.length > 0) {
        clauses.push('chat_id = ?')
        parameters.push(chatId)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      return database.prepare(`SELECT COUNT(*) AS n FROM runtime_events ${where}`).get(...parameters).n
    },
  }
}

module.exports = { createRuntimeEvents }
