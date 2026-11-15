const EFFECT_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'unknown', 'cancelled'])
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

function clone(row) {
  if (!row) return row
  const value = { ...row }
  try { value.payload = JSON.parse(value.payload_json) } catch { value.payload = null }
  delete value.payload_json
  return value
}

function errorText(error) {
  return String(error?.code || error?.message || error || 'EFFECT_FAILED').slice(0, 2000)
}

function createRoomOutbox({ roomDb, repository }) {
  if (!roomDb || typeof roomDb.withTransaction !== 'function' || !repository) {
    throw new TypeError('ROOM_OUTBOX_DEPENDENCIES_REQUIRED')
  }
  const db = roomDb.database

  function getById(effectId) {
    return clone(db.prepare('SELECT * FROM effects WHERE id = ?').get(effectId))
  }

  function enqueue({ chatId, actionId = null, kind, payload = {}, idempotencyKey }) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) throw new TypeError('ROOM_EFFECT_IDEMPOTENCY_KEY_REQUIRED')
    return roomDb.withTransaction(() => {
      const existing = db.prepare('SELECT * FROM effects WHERE idempotency_key = ?').get(idempotencyKey)
      if (existing) return { effect: clone(existing), created: false }
      const effectId = repository.createEffect({ chatId, actionId, kind, payload, idempotencyKey })
      return { effect: getById(effectId), created: true }
    })
  }

  function claimPending({ limit = 10, kind = null, includePaused = false } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('ROOM_OUTBOX_LIMIT_INVALID')
    return roomDb.withTransaction(() => {
      const rows = db.prepare(`SELECT e.* FROM effects e JOIN chats c ON c.id = e.chat_id
        WHERE e.status = 'pending' AND (c.status = 'active' OR (? = 1 AND c.status = 'paused'))
        AND (? IS NULL OR e.kind = ?)
        ORDER BY e.created_at, e.id LIMIT ?`).all(includePaused ? 1 : 0, kind, kind, limit)
      const claimed = []
      const timestamp = new Date().toISOString()
      for (const row of rows) {
        const result = db.prepare(`UPDATE effects SET status = 'running', attempts = attempts + 1, started_at = ?
          WHERE id = ? AND status = 'pending'`).run(timestamp, row.id)
        if (result.changes === 1) claimed.push(getById(row.id))
      }
      return claimed
    })
  }

  function transition(effectId, status, { error = null } = {}) {
    if (!EFFECT_STATUSES.has(status)) throw new TypeError('ROOM_EFFECT_STATUS_INVALID')
    return roomDb.withTransaction(() => {
      const current = getById(effectId)
      if (!current) throw new Error('ROOM_EFFECT_NOT_FOUND')
      if (TERMINAL_STATUSES.has(current.status)) return current
      if (status === 'succeeded' && current.status !== 'running') throw new Error('ROOM_EFFECT_NOT_RUNNING')
      if (status === 'failed' && !['running', 'unknown'].includes(current.status)) throw new Error('ROOM_EFFECT_NOT_FAILURE_STATE')
      if (status === 'pending' && current.status !== 'unknown') throw new Error('ROOM_EFFECT_NOT_RECOVERABLE')
      const completedAt = TERMINAL_STATUSES.has(status) ? new Date().toISOString() : null
      db.prepare(`UPDATE effects SET status = ?, last_error = ?, completed_at = ? WHERE id = ?`).run(
        status, error ? errorText(error) : null, completedAt, effectId,
      )
      return getById(effectId)
    })
  }

  async function runOnce(executor, options = {}) {
    if (typeof executor !== 'function') throw new TypeError('ROOM_OUTBOX_EXECUTOR_REQUIRED')
    const [effect] = claimPending({ ...options, limit: 1 })
    if (!effect) return null
    try {
      const result = await executor(effect)
      return { effect: transition(effect.id, 'succeeded'), result }
    } catch (error) {
      if (error?.code === 'ROOM_ASSIGNMENT_CANCELLED') return { effect: transition(effect.id, 'cancelled') }
      const unknown = error?.unknown === true || error?.code === 'EFFECT_UNKNOWN'
      return { effect: transition(effect.id, unknown ? 'unknown' : 'failed', { error }), error }
    }
  }

  return {
    enqueue,
    claimPending,
    get: getById,
    markSucceeded: (effectId) => transition(effectId, 'succeeded'),
    markFailed: (effectId, error) => transition(effectId, 'failed', { error }),
    markUnknown: (effectId, error) => transition(effectId, 'unknown', { error }),
    retryUnknown: (effectId) => transition(effectId, 'pending'),
    runOnce,
  }
}

module.exports = { EFFECT_STATUSES, createRoomOutbox }
