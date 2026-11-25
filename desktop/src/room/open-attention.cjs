const crypto = require('node:crypto')

/**
 * Open a user-facing Attention once per distinct question. Role/agent
 * availability can be noticed by several paths (roster creation, assignment,
 * mention, direct user @), so dedupe on chat + type + question instead of
 * stacking identical cards.
 */
function openAttention({
  roomDb,
  chatId,
  taskId = null,
  type,
  question,
  requestedBy = 'system',
  options = [],
  now = () => Date.now(),
}) {
  if (!roomDb?.database) throw new TypeError('ROOM_ATTENTION_DATABASE_REQUIRED')
  if (typeof chatId !== 'string' || chatId.length === 0) throw new TypeError('ROOM_ATTENTION_CHAT_REQUIRED')
  if (typeof type !== 'string' || type.length === 0) throw new TypeError('ROOM_ATTENTION_TYPE_REQUIRED')
  if (typeof question !== 'string' || question.length === 0) throw new TypeError('ROOM_ATTENTION_QUESTION_REQUIRED')
  const { database } = roomDb
  const existing = database.prepare(`
    SELECT id FROM attentions
    WHERE chat_id = ? AND type = ? AND status = 'open' AND question = ?
    ORDER BY created_at ASC, rowid ASC LIMIT 1
  `).get(chatId, type, question)
  if (existing?.id) return existing.id
  const id = crypto.randomUUID()
  database.prepare(`
    INSERT INTO attentions
      (id, chat_id, task_id, type, question, options_json, status, requested_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    id,
    chatId,
    taskId,
    type,
    question,
    JSON.stringify(Array.isArray(options) ? options : []),
    requestedBy,
    new Date(now()).toISOString(),
  )
  return id
}

function unavailableRoleQuestion(roles) {
  const names = (Array.isArray(roles) ? roles : [])
    .map(role => {
      const name = role?.displayName || role?.name || role?.id || 'Agent'
      const provider = role?.provider || 'unknown'
      return `${name} (${provider})`
    })
    .filter(Boolean)
  const list = names.join(', ')
  const verb = names.length > 1 ? 'are' : 'is'
  return `${list} ${verb} not available on this machine. Install or configure the Agent, or reassign the work. / ${list} 在本机不可用，请安装或配置该 Agent，或改派其他成员。`
}

module.exports = { openAttention, unavailableRoleQuestion }
