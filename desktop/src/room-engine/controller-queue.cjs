const crypto = require('node:crypto')

function createControllerQueue({ processBatch, getContextRevision, delayMs = 40, maxBatchSize = 32,
  maxRetries = 3, retryBaseMs = 1000, retryMaxMs = 30_000,
  shouldRetry = () => false, onRetryError = () => {}, onSettled = () => {},
  maxInputs = 256, maxChatInputs = 64 } = {}) {
  if (typeof processBatch !== 'function' || typeof getContextRevision !== 'function') throw new TypeError('ROOM_CONTROLLER_QUEUE_DEPENDENCIES_REQUIRED')
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new TypeError('ROOM_CONTROLLER_QUEUE_DELAY_INVALID')
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 1000) throw new TypeError('ROOM_CONTROLLER_QUEUE_BATCH_SIZE_INVALID')
  if (!Number.isInteger(maxInputs) || maxInputs < 1 || !Number.isInteger(maxChatInputs)
      || maxChatInputs < 1 || maxChatInputs > maxInputs || typeof onSettled !== 'function') throw new TypeError('ROOM_CONTROLLER_QUEUE_CAPACITY_INVALID')
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10
      || !Number.isInteger(retryBaseMs) || retryBaseMs < 1 || retryBaseMs > 60_000
      || !Number.isInteger(retryMaxMs) || retryMaxMs < retryBaseMs || retryMaxMs > 60_000
      || typeof shouldRetry !== 'function' || typeof onRetryError !== 'function') throw new TypeError('ROOM_CONTROLLER_QUEUE_RETRY_INVALID')
  const chats = new Map()
  let closed = false

  function inputKeys(chatId) {
    const entry = chats.get(chatId)
    return entry ? [...new Set([...entry.pending.keys(), ...(entry.batch?.keys() || []), ...(entry.retry?.batch.keys() || [])])] : []
  }

  function capacity(chatId) {
    let total = 0
    for (const id of chats.keys()) total += inputKeys(id).length
    return Math.max(0, Math.min(maxChatInputs - inputKeys(chatId).length, maxInputs - total))
  }

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
    const key = messageId ? `message:${messageId}` : `event:${eventId}`
    const existing = entry?.pending.get(key) || entry?.batch?.get(key) || entry?.retry?.batch.get(key)
    if (existing) return existing.promise
    if (capacity(chatId) === 0) return Promise.reject(new Error('ROOM_CONTROLLER_QUEUE_FULL'))
    if (!entry) {
      entry = { pending: new Map(), running: null, timer: null, abort: null, retry: null, batch: null }
      chats.set(chatId, entry)
    }
    const item = { messageId, eventId }
    const result = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject })
    item.promise = result
    entry.pending.set(key, item)
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
    entry.batch = batch
    let failure = null
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
      for (const item of batch.values()) item.resolve(result)
      return result
    }, error => {
      failure = error
      for (const item of batch.values()) item.reject(error)
      if (!closed && attempt < maxRetries && shouldRetry(error)) {
        entry.retry = { batch, attempt: attempt + 1 }
      }
      if (!closed && attempt > 0) onRetryError(error)
      throw error
    }).finally(() => {
      entry.running = null
      entry.abort = null
      entry.batch = null
      if (entry.retry || entry.pending.size) schedule(chatId, entry)
      else chats.delete(chatId)
      if (!closed) onSettled({ chatId, error: failure, retrying: Boolean(entry.retry) })
    })
    return entry.running
  }

  async function close() {
    closed = true
    const running = []
    for (const entry of chats.values()) {
      clearTimeout(entry.timer)
      for (const item of entry.pending.values()) item.reject(new Error('ROOM_CONTROLLER_QUEUE_CLOSED'))
      entry.pending.clear()
      entry.abort?.abort()
      if (entry.running) running.push(entry.running)
    }
    await Promise.allSettled(running)
    chats.clear()
  }

  return { enqueue, flush, close, capacity, inputKeys }
}

module.exports = { createControllerQueue }
