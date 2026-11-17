const crypto = require('node:crypto')

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function messageView(row) {
  if (!row) return undefined
  return {
    id: row.id,
    chatId: row.chat_id,
    seq: row.seq,
    revision: row.revision,
    clientId: row.client_id,
    audience: row.audience,
    authorType: row.author_type,
    authorId: row.author_id,
    kind: row.kind,
    content: row.content,
    mentions: parseJson(row.mentions_json, []),
    replyTo: row.reply_to,
    taskId: row.task_id,
    rootMessageId: row.root_message_id,
    captainAssignmentId: row.captain_assignment_id,
    status: row.status,
    data: parseJson(row.data_json, null),
    createdAt: row.created_at,
    editedAt: row.edited_at,
  }
}

function createTimeline({ roomDb, repository, now = () => Date.now() }) {
  const { database } = roomDb

  function at() {
    return new Date(now()).toISOString()
  }

  function getRow(messageId) {
    return database.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)
  }

  function get(messageId) {
    return messageView(getRow(messageId))
  }

  function appendInternal(input) {
    const {
      chatId, authorType, authorId, kind = 'message', content,
      mentions = [], replyTo = null, taskId = null, rootMessageId = null,
      captainAssignmentId = null, audience = 'chat', status = 'queued',
      clientId = null, data = null,
    } = input
    if (clientId !== null && clientId !== undefined) {
      const existing = database.prepare('SELECT * FROM messages WHERE chat_id = ? AND client_id = ?').get(chatId, clientId)
      if (existing) return messageView(existing)
    }
    const chat = database.prepare('SELECT last_seq FROM chats WHERE id = ?').get(chatId)
    if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
    const seq = chat.last_seq + 1
    const id = crypto.randomUUID()
    const createdAt = at()
    database.prepare(`
      INSERT INTO messages
        (id, chat_id, seq, revision, client_id, audience, author_type, author_id, kind, content,
         mentions_json, reply_to, task_id, root_message_id, captain_assignment_id, status, data_json, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, chatId, seq, clientId ?? null, audience, authorType, authorId, kind, content ?? '',
      JSON.stringify(mentions), replyTo, taskId, rootMessageId, captainAssignmentId, status,
      data === null || data === undefined ? null : JSON.stringify(data), createdAt,
    )
    database.prepare('UPDATE chats SET last_seq = ?, updated_at = ? WHERE id = ?').run(seq, createdAt, chatId)
    const isPublic = audience === 'chat' && !(data && data.reviewReply === true)
    if (isPublic) {
      database.prepare('UPDATE chats SET activity_seq = ?, updated_at = ? WHERE id = ?').run(seq, createdAt, chatId)
    }
    return messageView(getRow(id))
  }

  return {
    append(input) {
      return roomDb.withTransaction(() => appendInternal(input))
    },

    transition(messageId, fromStatuses, toStatus, patch = {}) {
      return roomDb.withTransaction(() => {
        const row = getRow(messageId)
        if (!row) return undefined
        if (!fromStatuses.includes(row.status)) return undefined
        const assignments = ['status = ?']
        const values = [toStatus]
        if (Object.prototype.hasOwnProperty.call(patch, 'content')) {
          assignments.push('content = ?')
          values.push(patch.content ?? '')
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'data')) {
          assignments.push('data_json = ?')
          values.push(patch.data === null || patch.data === undefined ? null : JSON.stringify(patch.data))
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'mentions')) {
          assignments.push('mentions_json = ?')
          values.push(JSON.stringify(patch.mentions ?? []))
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'editedAt')) {
          assignments.push('edited_at = ?')
          values.push(patch.editedAt)
        }
        values.push(messageId)
        database.prepare(`UPDATE messages SET ${assignments.join(', ')} WHERE id = ?`).run(...values)
        return messageView(getRow(messageId))
      })
    },

    finish(messageId, { status, text = '', thinking = '', data = null }) {
      return roomDb.withTransaction(() => {
        const row = getRow(messageId)
        if (!row) throw new Error('ROOM_MESSAGE_NOT_FOUND')
        let finalData = data && typeof data === 'object' ? { ...data } : {}
        if (thinking) finalData.thinking = thinking
        if (Object.keys(finalData).length === 0) finalData = null
        database.prepare('UPDATE messages SET status = ?, content = ?, data_json = ? WHERE id = ?')
          .run(status, text ?? '', finalData === null ? null : JSON.stringify(finalData), messageId)
        return messageView(getRow(messageId))
      })
    },

    edit(messageId, { content, data = null }) {
      return roomDb.withTransaction(() => {
        const row = getRow(messageId)
        if (!row) throw new Error('ROOM_MESSAGE_NOT_FOUND')
        const event = appendInternal({
          chatId: row.chat_id,
          authorType: 'system',
          authorId: 'system',
          kind: 'system',
          content: '',
          status: 'done',
          data: { event: 'message_edited', messageId },
        })
        const assignments = ['content = ?', 'revision = revision + 1', 'edited_at = ?']
        const values = [content ?? '', at()]
        if (data !== null && data !== undefined) {
          assignments.push('data_json = ?')
          values.push(JSON.stringify(data))
        }
        values.push(messageId)
        database.prepare(`UPDATE messages SET ${assignments.join(', ')} WHERE id = ?`).run(...values)
        return { message: messageView(getRow(messageId)), event }
      })
    },

    get,

    after(chatId, seq) {
      return database.prepare('SELECT * FROM messages WHERE chat_id = ? AND seq > ? ORDER BY seq ASC')
        .all(chatId, seq)
        .map(messageView)
    },

    latest(chatId) {
      return messageView(database.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 1').get(chatId))
    },

    activitySeq(chatId) {
      const row = database.prepare('SELECT activity_seq FROM chats WHERE id = ?').get(chatId)
      return row ? row.activity_seq : 0
    },
  }
}

module.exports = { createTimeline }
