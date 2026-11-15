const crypto = require('node:crypto')

function createControllerQueue({ processBatch, getContextRevision, delayMs = 40, maxBatchSize = 32,
  maxRetries = 3, retryBaseMs = 1000, retryMaxMs = 30_000,
  shouldRetry = () => false, onRetryError = () => {} } = {}) {
  if (typeof processBatch !== 'function' || typeof getContextRevision !== 'function') throw new TypeError('ROOM_CONTROLLER_QUEUE_DEPENDENCIES_REQUIRED')
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new TypeError('ROOM_CONTROLLER_QUEUE_DELAY_INVALID')
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 1000) throw new TypeError('ROOM_CONTROLLER_QUEUE_BATCH_SIZE_INVALID')
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10
      || !Number.isInteger(retryBaseMs) || retryBaseMs < 1 || retryBaseMs > 60_000
      || !Number.isInteger(retryMaxMs) || retryMaxMs < retryBaseMs || retryMaxMs > 60_000
      || typeof shouldRetry !== 'function' || typeof onRetryError !== 'function') throw new TypeError('ROOM_CONTROLLER_QUEUE_RETRY_INVALID')
  const chats = new Map()
  let closed = false

  function schedule(chatId, entry) {
    if (closed || entry.running || entry.timer || (!entry.retry && entry.pending.size === 0)) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      flush(chatId).catch(() => {}) // Each enqueue caller receives the batch error.
    }, entry.retry ? Math.min(retryMaxMs, retryBaseMs * 2 ** (entry.retry.attempt - 1)) : delayMs)
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
      entry = { pending: new Map(), running: null, timer: null, abort: null, retry: null }
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
    // Neither new messages nor a manual flush bypass a scheduled cooldown.
    if (entry.retry && entry.timer) return Promise.resolve(null)
    clearTimeout(entry.timer)
    entry.timer = null
    if (!entry.retry && !entry.pending.size) return Promise.resolve(null)
    const attempt = entry.retry?.attempt || 0
    const batch = entry.retry?.batch || new Map([...entry.pending].slice(0, maxBatchSize))
    if (!entry.retry) for (const key of batch.keys()) entry.pending.delete(key)
    entry.retry = null
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
      for (const item of batch.values()) {
        for (const waiter of item.waiters) waiter.reject(error)
        item.waiters = []
      }
      if (!closed && attempt < maxRetries && shouldRetry(error)) {
        entry.retry = { batch, attempt: attempt + 1 }
      } else {
        // A duplicate arriving during evaluation cannot reset a failed batch's
        // automatic retry budget. Its persisted ledger input remains recoverable.
        for (const key of batch.keys()) {
          for (const waiter of entry.pending.get(key)?.waiters || []) waiter.reject(error)
          entry.pending.delete(key)
        }
      }
      if (!closed && attempt > 0) onRetryError(error)
      throw error
    }).finally(() => {
      entry.running = null
      entry.abort = null
      if (entry.retry || entry.pending.size) schedule(chatId, entry)
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
