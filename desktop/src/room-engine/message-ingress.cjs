const AUTHOR_TYPES = new Set(['user', 'agent', 'system'])
const MAX_MESSAGE_LENGTH = 100_000

function mentionsFrom(content) {
  const mentions = []
  const seen = new Set()
  const pattern = /@([A-Za-z0-9][A-Za-z0-9._-]*)/g
  for (const match of String(content).matchAll(pattern)) {
    const mention = match[1]
    if (!seen.has(mention)) {
      seen.add(mention)
      mentions.push(mention)
    }
  }
  return mentions
}

function validateAuthor(author) {
  if (!author || typeof author !== 'object' || !AUTHOR_TYPES.has(author.type)) {
    throw new TypeError('ROOM_MESSAGE_AUTHOR_INVALID')
  }
  if (typeof author.id !== 'string' || author.id.length === 0 || author.id.length > 256) {
    throw new TypeError('ROOM_MESSAGE_AUTHOR_ID_INVALID')
  }
  return { type: author.type, id: author.id }
}

function validateContent(content) {
  if (typeof content !== 'string' || content.length === 0 || content.length > MAX_MESSAGE_LENGTH) {
    throw new TypeError('ROOM_MESSAGE_CONTENT_INVALID')
  }
  return content
}

function createMessageIngress(roomDb, repository) {
  if (!roomDb || typeof roomDb.withTransaction !== 'function') throw new TypeError('ROOM_DATABASE_REQUIRED')
  if (!repository || typeof repository.appendMessage !== 'function') throw new TypeError('ROOM_REPOSITORY_REQUIRED')

  function submit({ chatId, author, content, attachmentIds = [], replyTo = null, taskId = null, messageId }) {
    const identity = validateAuthor(author)
    const text = validateContent(content)
    const mentions = mentionsFrom(text)
    return roomDb.withTransaction(() => {
      if (replyTo !== null) {
        const parent = repository.getMessage(replyTo)
        if (!parent || parent.chat_id !== chatId || parent.deleted_at) throw new Error('ROOM_MESSAGE_REPLY_SCOPE_INVALID')
      }
      if (taskId !== null) {
        const task = repository.getTask(taskId)
        if (!task || task.chat_id !== chatId) throw new Error('ROOM_MESSAGE_TASK_SCOPE_INVALID')
      }
      const message = repository.appendMessage({
        messageId, chatId, authorType: identity.type, authorId: identity.id,
        content: text, mentions, attachmentIds, replyTo, taskId,
      })
      const chat = roomDb.database.prepare('SELECT room_id FROM chats WHERE id = ?').get(chatId)
      if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
      const event = repository.appendEvent({
        roomId: chat.room_id, chatId, actorId: identity.id, type: 'message_created',
        payload: { messageId: message.messageId },
      })
      return { message, mentions, event }
    })
  }

  function edit({ messageId, author, content, attachmentIds = [] }) {
    const identity = validateAuthor(author)
    const text = validateContent(content)
    const mentions = mentionsFrom(text)
    return roomDb.withTransaction(() => {
      const message = repository.getMessage(messageId)
      if (!message || message.author_id !== identity.id) throw new Error('ROOM_MESSAGE_EDIT_FORBIDDEN')
      const updated = repository.editMessage({ messageId, content: text, mentions, attachmentIds })
      const event = repository.appendEvent({
        roomId: roomIdFor(message.chat_id), chatId: message.chat_id, actorId: identity.id,
        type: 'message_edited', payload: { messageId },
      })
      return { message: updated, mentions, event }
    })
  }

  function remove({ messageId, author }) {
    const identity = validateAuthor(author)
    return roomDb.withTransaction(() => {
      const message = repository.getMessage(messageId)
      if (!message || message.author_id !== identity.id) throw new Error('ROOM_MESSAGE_DELETE_FORBIDDEN')
      const deleted = repository.deleteMessage({ messageId })
      const event = repository.appendEvent({
        roomId: roomIdFor(message.chat_id), chatId: message.chat_id, actorId: identity.id,
        type: 'message_deleted', payload: { messageId },
      })
      return { message: deleted, event }
    })
  }

  function roomIdFor(chatId) {
    const chat = roomDb.database.prepare('SELECT room_id FROM chats WHERE id = ?').get(chatId)
    if (!chat) throw new Error('ROOM_CHAT_NOT_FOUND')
    return chat.room_id
  }

  return { submit, edit, remove, mentionsFrom }
}

module.exports = { AUTHOR_TYPES, MAX_MESSAGE_LENGTH, createMessageIngress, mentionsFrom }
