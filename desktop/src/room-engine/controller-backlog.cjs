// Decisions are committed with their actions/effects. Their input IDs are the
// receipt; the queue is only a transient batching mechanism, never a second ledger.
const TRIGGER_TYPES = new Set([
  'report_received', 'action_create_task', 'action_create_role',
  'user_answer_attention', 'user_accept_artifact', 'user_reject_artifact',
  'user_resume_chat', 'user_retry_task', 'user_handoff_task',
  'user_set_workspace_write',
])

function createControllerBacklog({ roomDb }) {
  const db = roomDb.database

  const unconsumed = `NOT EXISTS (
    SELECT 1 FROM controller_decisions d, json_each(d.input_ids_json) receipt
    WHERE d.chat_id = input.chat_id AND receipt.value = input.id
  ) AND NOT EXISTS (
    SELECT 1 FROM events f WHERE f.chat_id = input.chat_id AND f.type = 'mention_fallback_dispatched'
    AND json_extract(f.payload_json, '$.messageId') = input.id
  )`

  function filter(input) {
    const pending = db.prepare(`SELECT id FROM (SELECT ? AS chat_id, ? AS id) input WHERE ${unconsumed}`)
    const keep = id => Boolean(pending.get(input.chatId, id))
    return { ...input,
      messageIds: [...new Set(input.messageIds || [])].filter(keep),
      triggerEventIds: [...new Set(input.triggerEventIds || [])].filter(keep),
    }
  }

  function chats(chatId = null) {
    return db.prepare("SELECT id FROM chats WHERE status = 'active' AND engine_version = 'v2' AND (? IS NULL OR id = ?) ORDER BY created_at, id").iterate(chatId, chatId)
  }

  function list({ chatId = null, limit = 256, excludeKeys = [] } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4096) throw new TypeError('ROOM_CONTROLLER_BACKLOG_LIMIT_INVALID')
    const pending = []
    for (const chat of chats(chatId)) {
      const rows = db.prepare(`SELECT id, kind FROM (
        SELECT id, chat_id, sequence, 'message' AS kind, 0 AS category FROM messages
        WHERE chat_id = ? AND deleted_at IS NULL AND author_type IN ('user', 'agent')
        UNION ALL
        SELECT id, chat_id, sequence, 'event' AS kind, 1 AS category FROM events
        WHERE chat_id = ? AND type IN (SELECT value FROM json_each(?))
      ) input WHERE ${unconsumed}
        AND NOT EXISTS (SELECT 1 FROM json_each(?) excluded WHERE excluded.value = input.kind || ':' || input.id)
      ORDER BY category, sequence LIMIT ?`).all(chat.id, chat.id, JSON.stringify([...TRIGGER_TYPES]), JSON.stringify(excludeKeys), limit - pending.length)
      for (const row of rows) pending.push({ chatId: chat.id, [row.kind === 'message' ? 'messageId' : 'eventId']: row.id })
      if (pending.length === limit) break
    }
    return pending
  }

  return { filter, list, chats }
}

module.exports = { createControllerBacklog, TRIGGER_TYPES }
