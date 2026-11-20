const crypto = require('node:crypto')

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function effectView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    chatId: row.chat_id,
    kind: row.kind,
    status: row.status,
    payload: parseJson(row.payload_json, {}),
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function createOutbox({ roomDb, repository, now = () => Date.now() }) {
  const { database } = roomDb

  function at() {
    return new Date(now()).toISOString()
  }

  function get(id) {
    return effectView(database.prepare('SELECT * FROM effects WHERE id = ?').get(id))
  }

  function findByIdempotencyKey(idempotencyKey) {
    return effectView(database.prepare('SELECT * FROM effects WHERE idempotency_key = ?').get(idempotencyKey))
  }

  function claim(id) {
    return roomDb.withTransaction(() => {
      const row = database.prepare('SELECT * FROM effects WHERE id = ?').get(id)
      if (!row || row.status !== 'pending') return undefined
      database.prepare('UPDATE effects SET status = ?, started_at = ?, attempts = attempts + 1 WHERE id = ?')
        .run('running', at(), id)
      return get(id)
    })
  }

  return {
    enqueue({ chatId, kind, payload, idempotencyKey }) {
      const existing = findByIdempotencyKey(idempotencyKey)
      if (existing) return existing
      const id = crypto.randomUUID()
      database.prepare(`
        INSERT INTO effects (id, chat_id, kind, status, payload_json, idempotency_key, created_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?)
      `).run(id, chatId, kind, JSON.stringify(payload ?? {}), idempotencyKey, at())
      return get(id)
    },

    claim,

    claimNext(kind) {
      return roomDb.withTransaction(() => {
        const row = database.prepare(`
          SELECT id FROM effects WHERE kind = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1
        `).get(kind)
        return row ? claim(row.id) : undefined
      })
    },

    succeed(id) {
      database.prepare("UPDATE effects SET status = 'succeeded', completed_at = ?, last_error = NULL WHERE id = ?")
        .run(at(), id)
      return get(id)
    },

    fail(id, error) {
      const message = error instanceof Error ? error.message : String(error)
      database.prepare("UPDATE effects SET status = 'failed', completed_at = ?, last_error = ? WHERE id = ?")
        .run(at(), message, id)
      return get(id)
    },

    unknown(id, error) {
      const message = error instanceof Error ? error.message : String(error)
      database.prepare("UPDATE effects SET status = 'unknown', completed_at = ?, last_error = ? WHERE id = ?")
        .run(at(), message, id)
      return get(id)
    },

    get,
    findByIdempotencyKey,
  }
}

module.exports = { createOutbox }
