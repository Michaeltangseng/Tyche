// Decisions are committed with their actions/effects. Their input IDs are the
// receipt; the queue is only a transient batching mechanism, never a second ledger.
const TRIGGER_TYPES = new Set([
  'report_received', 'action_create_task', 'action_create_role',
  'user_answer_attention', 'user_accept_artifact', 'user_reject_artifact',
  'user_resume_chat', 'user_retry_task', 'user_handoff_task',
])

function createControllerBacklog({ roomDb }) {
  const db = roomDb.database

  function consumedIds(chatId) {
    const consumed = new Set()
    for (const row of db.prepare('SELECT input_ids_json FROM controller_decisions WHERE chat_id = ?').all(chatId)) {
      for (const id of JSON.parse(row.input_ids_json)) consumed.add(id)
    }
    // Deterministic fallback already dispatched these messages. A subsequently
    // available Controller must not create a second task for the same request.
    for (const row of db.prepare("SELECT payload_json FROM events WHERE chat_id = ? AND type = 'mention_fallback_dispatched'").all(chatId)) {
      consumed.add(JSON.parse(row.payload_json).messageId)
    }
    return consumed
  }

  function filter(input) {
    const consumed = consumedIds(input.chatId)
    return { ...input,
      messageIds: [...new Set(input.messageIds || [])].filter(id => !consumed.has(id)),
      triggerEventIds: [...new Set(input.triggerEventIds || [])].filter(id => !consumed.has(id)),
    }
  }

  function list({ chatId = null } = {}) {
    const chats = db.prepare("SELECT id FROM chats WHERE status = 'active' AND engine_version = 'v2' ORDER BY created_at, id").all()
    const pending = []
    for (const chat of chats) {
      if (chatId !== null && chat.id !== chatId) continue
      const consumed = consumedIds(chat.id)
      const messages = db.prepare("SELECT id FROM messages WHERE chat_id = ? AND deleted_at IS NULL AND author_type IN ('user', 'agent') ORDER BY sequence").all(chat.id)
      const events = db.prepare('SELECT id, type FROM events WHERE chat_id = ? ORDER BY sequence').all(chat.id)
      for (const message of messages) if (!consumed.has(message.id)) pending.push({ chatId: chat.id, messageId: message.id })
      for (const event of events) if (TRIGGER_TYPES.has(event.type) && !consumed.has(event.id)) pending.push({ chatId: chat.id, eventId: event.id })
    }
    return pending
  }

  return { filter, list }
}

module.exports = { createControllerBacklog, TRIGGER_TYPES }
