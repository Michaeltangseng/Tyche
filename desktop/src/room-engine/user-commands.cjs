const { encode } = require('./room-db.cjs')
const { validateUserCommand } = require('./room-actions.cjs')

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function createUserCommandService({ roomDb, repository }) {
  if (!roomDb || typeof roomDb.withTransaction !== 'function' || !repository) throw new TypeError('ROOM_USER_COMMAND_DEPENDENCIES_REQUIRED')
  const db = roomDb.database

  function chatContext(chatId) {
    const row = db.prepare('SELECT room_id, status FROM chats WHERE id = ?').get(chatId)
    if (!row) throw new Error('ROOM_CHAT_NOT_FOUND')
    return row
  }

  function apply(command, { actorId = 'user' } = {}) {
    const action = validateUserCommand(command)
    return roomDb.withTransaction(() => {
      const chat = chatContext(action.chatId)
      let result = {}
      const timestamp = new Date().toISOString()
      if (action.type === 'answer_attention') {
        const attention = db.prepare('SELECT * FROM attentions WHERE id = ? AND chat_id = ?').get(action.attentionId, action.chatId)
        if (!attention) throw new Error('ROOM_ATTENTION_NOT_FOUND')
        if (attention.status !== 'open') throw new Error('ROOM_ATTENTION_ALREADY_ANSWERED')
        const options = parseJson(attention.options_json, [])
        if (action.optionId && options.length > 0 && !options.some((option) => (typeof option === 'string' ? option : option.id) === action.optionId)) {
          throw new Error('ROOM_ATTENTION_OPTION_INVALID')
        }
        const resolution = { optionId: action.optionId || null, comment: action.comment || null }
        db.prepare(`UPDATE attentions SET status = 'answered', resolution_json = ?, answered_by = ?, answered_at = ? WHERE id = ?`)
          .run(encode(resolution), actorId, timestamp, action.attentionId)
        result = { attentionId: action.attentionId, resolution }
      } else if (action.type === 'accept_artifact' || action.type === 'reject_artifact') {
        const artifact = db.prepare(`SELECT a.* FROM artifacts a JOIN rooms r ON r.id = a.room_id
          JOIN chats c ON c.room_id = r.id WHERE a.id = ? AND c.id = ?`).get(action.artifactId, action.chatId)
        if (!artifact) throw new Error('ROOM_ARTIFACT_NOT_FOUND')
        const status = action.type === 'accept_artifact' ? 'accepted' : 'rejected'
        db.prepare('UPDATE artifacts SET status = ?, updated_at = ? WHERE id = ?').run(status, timestamp, action.artifactId)
        result = { artifactId: action.artifactId, status }
      } else if (action.type === 'pause_chat' || action.type === 'resume_chat') {
        const status = action.type === 'pause_chat' ? 'paused' : 'active'
        db.prepare('UPDATE chats SET status = ?, updated_at = ? WHERE id = ?').run(status, timestamp, action.chatId)
        result = { chatId: action.chatId, status }
      } else {
        throw new Error('ROOM_USER_COMMAND_UNSUPPORTED')
      }
      const event = repository.appendEvent({
        roomId: chat.room_id,
        chatId: action.chatId,
        actorId,
        type: `user_${action.type}`,
        payload: { command: action, result },
      })
      return { ...result, event }
    })
  }

  return { apply }
}

module.exports = { createUserCommandService }
