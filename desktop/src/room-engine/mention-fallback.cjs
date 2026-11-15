const { encode } = require('./room-db.cjs')

function normalize(value) { return String(value).trim().toLowerCase() }

function createMentionFallback({ roomDb, repository }) {
  if (!roomDb || typeof roomDb.withTransaction !== 'function' || !repository) throw new TypeError('ROOM_MENTION_FALLBACK_DEPENDENCIES_REQUIRED')
  const db = roomDb.database

  function resolveRoles(chatId, mentions) {
    const roles = db.prepare('SELECT * FROM agent_roles WHERE chat_id = ? AND status = \'active\'').all(chatId)
    const wanted = new Set((mentions || []).map(normalize))
    return roles.filter((role) => wanted.has(normalize(role.id)) || wanted.has(normalize(role.display_name)))
  }

  function dispatch({ chatId, messageId, content, mentions, createdBy }) {
    if (typeof messageId !== 'string' || messageId.length === 0) throw new TypeError('ROOM_MESSAGE_ID_REQUIRED')
    if (typeof content !== 'string' || content.trim().length === 0) throw new TypeError('ROOM_TASK_OBJECTIVE_REQUIRED')
    if (typeof createdBy !== 'string' || createdBy.length === 0) throw new TypeError('ROOM_TASK_CREATOR_REQUIRED')
    return roomDb.withTransaction(() => {
      const chat = db.prepare('SELECT room_id, context_revision FROM chats WHERE id = ?').get(chatId)
      if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
      const existing = db.prepare('SELECT * FROM tasks WHERE chat_id = ?').all(chatId).find((task) => {
        try { return JSON.parse(task.source_message_ids_json).includes(messageId) } catch { return false }
      })
      if (existing) return { created: false, taskId: existing.id, assignmentIds: [] }
      const roles = resolveRoles(chatId, mentions)
      if (roles.length === 0) return { created: false, taskId: null, assignmentIds: [], reason: 'NO_ACTIVE_MENTIONED_ROLE' }
      const objective = content.replace(/@([A-Za-z0-9][A-Za-z0-9._-]*)/g, '').replace(/\s+/g, ' ').trim()
      const taskId = repository.createTask({ chatId, objective: objective || content.trim(), kind: 'general', createdBy, sourceMessageIds: [messageId], contextRevision: chat.context_revision })
      const assignmentIds = roles.map((role) => repository.createAssignment({ taskId, roleId: role.id, required: true }))
      repository.appendEvent({
        roomId: chat.room_id, chatId, actorId: 'fallback', type: 'mention_fallback_dispatched',
        payload: { messageId, taskId, roleIds: roles.map((role) => role.id) },
      })
      return { created: true, taskId, assignmentIds, roleIds: roles.map((role) => role.id) }
    })
  }

  return { dispatch, resolveRoles }
}

module.exports = { createMentionFallback }
