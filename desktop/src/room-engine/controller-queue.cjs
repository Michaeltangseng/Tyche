const crypto = require('node:crypto')

function createControllerQueue({ processBatch, getContextRevision, delayMs = 40 } = {}) {
  if (typeof processBatch !== 'function' || typeof getContextRevision !== 'function') throw new TypeError('ROOM_CONTROLLER_QUEUE_DEPENDENCIES_REQUIRED')
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new TypeError('ROOM_CONTROLLER_QUEUE_DELAY_INVALID')
  const chats = new Map()
  let closed = false

  function schedule(chatId, entry) {
    if (closed || entry.running || entry.timer || entry.pending.size === 0) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      flush(chatId).catch(() => {}) // Each enqueue caller receives the batch error.
    }, delayMs)
  }

  function enqueue({ chatId, messageId, eventId }) {
    if (closed) return Promise.reject(new Error('ROOM_CONTROLLER_QUEUE_CLOSED'))
    if (typeof chatId !== 'string' || !chatId || Boolean(messageId) === Boolean(eventId)
        || (messageId !== undefined && (typeof messageId !== 'string' || !messageId))
        || (eventId !== undefined && (typeof eventId !== 'string' || !eventId))) {
      return Promise.reject(new TypeError('ROOM_CONTROLLER_QUEUE_MESSAGE_INVALID'))
    }
    let entry = chats.get(chatId)
    if (!entry) {
      entry = { pending: new Map(), running: null, timer: null, abort: null }
      chats.set(chatId, entry)
    }
    const result = new Promise((resolve, reject) => {
      const key = messageId ? `message:${messageId}` : `event:${eventId}`
      const item = entry.pending.get(key) || { messageId, eventId, waiters: [] }
      item.waiters.push({ resolve, reject })
      entry.pending.set(key, item)
    })
    schedule(chatId, entry)
    return result
  }

  function flush(chatId) {
    const entry = chats.get(chatId)
    if (!entry || closed) return Promise.resolve(null)
    if (entry.running) return entry.running
    clearTimeout(entry.timer)
    entry.timer = null
    if (!entry.pending.size) return Promise.resolve(null)
    const batch = entry.pending
    entry.pending = new Map()
    entry.abort = new AbortController()
    entry.running = Promise.resolve().then(() => {
      if (entry.abort.signal.aborted) throw new Error('ROOM_CONTROLLER_QUEUE_CLOSED')
      return processBatch({
        chatId, batchId: `batch-${crypto.randomUUID()}`,
        contextRevision: getContextRevision(chatId),
        messageIds: [...batch.values()].map(item => item.messageId).filter(Boolean),
        triggerEventIds: [...batch.values()].map(item => item.eventId).filter(Boolean),
        signal: entry.abort.signal,
      })
    }).then(result => {
      for (const item of batch.values()) for (const waiter of item.waiters) waiter.resolve(result)
      return result
    }, error => {
      for (const item of batch.values()) for (const waiter of item.waiters) waiter.reject(error)
      throw error
    }).finally(() => {
      entry.running = null
      entry.abort = null
      if (entry.pending.size) schedule(chatId, entry)
      else chats.delete(chatId)
    })
    return entry.running
  }

  async function close() {
    closed = true
    const running = []
    for (const entry of chats.values()) {
      clearTimeout(entry.timer)
      for (const item of entry.pending.values()) for (const waiter of item.waiters) waiter.reject(new Error('ROOM_CONTROLLER_QUEUE_CLOSED'))
      entry.pending.clear()
      entry.abort?.abort()
      if (entry.running) running.push(entry.running)
    }
    await Promise.allSettled(running)
    chats.clear()
  }

  return { enqueue, flush, close }
}

module.exports = { createControllerQueue }
