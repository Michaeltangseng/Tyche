/**
 * Domain idempotency for write tools whose transport may not preserve callId.
 *
 * dispatcher.invoke already dedupes a repeated callId. That only covers a
 * client that reuses the id. docs/04 §5.1 asks for a domain key as the
 * fallback: create_task is unique per assignment + source message, comment_task
 * takes a caller key (and otherwise derives one from the source and text).
 *
 * The key row and the domain object are written in one transaction. Nested
 * room transactions use savepoints, so createTask / comment_task can keep
 * their own transaction boundaries.
 */
function parseJson(value) {
  try { return JSON.parse(value) } catch { return null }
}

function createDomainIdempotency({ roomDb, now = () => Date.now() }) {
  const { database } = roomDb

  function at() {
    return new Date(now()).toISOString()
  }

  return {
    /**
     * Run `create` once per key. A replay returns the first result without
     * calling `create` again. `create` must be synchronous because the room
     * transaction contract is synchronous.
     */
    runOnce({ key, chatId, kind, create }) {
      if (typeof key !== 'string' || key.length === 0) throw new TypeError('ROOM_IDEMPOTENCY_KEY_REQUIRED')
      if (typeof chatId !== 'string' || chatId.length === 0) throw new TypeError('ROOM_IDEMPOTENCY_CHAT_REQUIRED')
      if (typeof kind !== 'string' || kind.length === 0) throw new TypeError('ROOM_IDEMPOTENCY_KIND_REQUIRED')
      if (typeof create !== 'function') throw new TypeError('ROOM_IDEMPOTENCY_CREATE_REQUIRED')
      return roomDb.withTransaction(() => {
        const existing = database.prepare('SELECT result_json FROM domain_idempotency WHERE key = ?').get(key)
        if (existing) return parseJson(existing.result_json)
        const result = create()
        if (result && typeof result.then === 'function') {
          throw new TypeError('ROOM_IDEMPOTENCY_CREATE_MUST_BE_SYNCHRONOUS')
        }
        database.prepare(`
          INSERT INTO domain_idempotency (key, chat_id, kind, result_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(key, chatId, kind, JSON.stringify(result ?? null), at())
        return result
      })
    },

    get(key) {
      const row = database.prepare('SELECT result_json FROM domain_idempotency WHERE key = ?').get(key)
      return row ? parseJson(row.result_json) : undefined
    },
  }
}

module.exports = { createDomainIdempotency }
