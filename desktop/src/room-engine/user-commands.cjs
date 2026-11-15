const { encode } = require('./room-db.cjs')
const { createHash } = require('node:crypto')
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
      const eventId = action.commandId ? `user-command-${createHash('sha256').update(encode([action.chatId, actorId, action.commandId])).digest('hex')}` : undefined
      if (eventId) {
        const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId)
        if (existing) {
          const recorded = JSON.parse(existing.payload_json)
          const fields = new Set([...Object.keys(recorded.command), ...Object.keys(action)])
          if ([...fields].some(field => recorded.command[field] !== action[field])) throw new Error('ROOM_USER_COMMAND_ID_REUSED')
          return { ...recorded.result, duplicate: true, event: { eventId, sequence: existing.sequence, createdAt: existing.created_at } }
        }
      }
      if (action.type === 'retry_task' || action.type === 'handoff_task') {
        const previous = repository.getAssignmentContext(action.assignmentId)
        if (!previous || previous.task_id !== action.taskId || previous.chat_id !== action.chatId) throw new Error('ROOM_ASSIGNMENT_NOT_FOUND')
        if (!['failed', 'waiting', 'blocked'].includes(previous.status)) throw new Error('ROOM_ASSIGNMENT_NOT_RETRYABLE')
        if (previous.outcome === 'unknown') throw new Error('ROOM_ASSIGNMENT_RECOVERY_UNRESOLVED')
        if (db.prepare('SELECT id FROM assignments WHERE previous_assignment_id = ?').get(previous.id)) throw new Error('ROOM_ASSIGNMENT_ALREADY_REPLACED')
        if (previous.run_id) {
          const exited = repository.listEvents(chat.room_id, { chatId: action.chatId }).some(event => {
            if (event.type !== 'session_exited') return false
            const payload = parseJson(event.payload_json, {})
            return payload.assignmentId === previous.id && payload.runId === previous.run_id
          })
          if (!exited) throw new Error('ROOM_ASSIGNMENT_PROCESS_NOT_EXITED')
        }
        const roleId = action.type === 'handoff_task' ? action.roleId : previous.role_id
        const role = db.prepare('SELECT * FROM agent_roles WHERE id = ? AND chat_id = ?').get(roleId, action.chatId)
        if (!role || role.status !== 'active') throw new Error('ROOM_ASSIGNMENT_ROLE_INACTIVE')
        const assignmentId = repository.createAssignment({ taskId: previous.task_id, roleId,
          previousAssignmentId: previous.id, attempt: previous.attempt + 1,
          required: Boolean(previous.required), workspaceRef: previous.workspace_ref,
          writeScopes: parseJson(previous.write_scopes_json, []),
        })
        db.prepare("UPDATE tasks SET status = 'active', updated_at = ? WHERE id = ?").run(timestamp, previous.task_id)
        result = { taskId: previous.task_id, assignmentId, previousAssignmentId: previous.id, attempt: previous.attempt + 1 }
      } else if (action.type === 'answer_attention') {
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
        eventId,
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
