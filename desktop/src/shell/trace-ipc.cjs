'use strict'

const { z } = require('zod')

const ID = /^[A-Za-z0-9._:-]{1,120}$/
const id = z.string().min(1).max(120).regex(ID)

const schemas = {
  page: z.strictObject({
    runId: id,
    agentRunId: id,
    cursor: z.string().max(4096).optional(),
    direction: z.enum(['forward', 'backward']),
    limit: z.number().int().positive().max(200),
  }),
  blob: z.strictObject({
    runId: id,
    agentRunId: id,
    blobId: id,
    offset: z.number().int().nonnegative(),
    length: z.number().int().positive().max(256 * 1024),
  }),
  status: z.strictObject({ runId: id, agentRunId: id }),
  diskUsage: z.strictObject({}),
  prune: z.strictObject({
    groupId: id.optional(),
    olderThan: z.number().int().nonnegative().optional(),
  }),
}

function traceInputError() {
  return Object.assign(new Error('TRACE_NOT_FOUND'), { code: 'TRACE_NOT_FOUND' })
}

function registerTraceIpc({ registerTrustedHandle, reader, store }) {
  if (!reader) throw new Error('TRACE_READER_REQUIRED')
  for (const [method, schema] of Object.entries(schemas)) {
    registerTrustedHandle(`trace:${method}`, (input) => {
      const parsed = schema.safeParse(input)
      if (!parsed.success) throw traceInputError()
      const target = typeof reader[method] === 'function' ? reader : store
      if (!target || typeof target[method] !== 'function') throw traceInputError()
      return target[method](parsed.data)
    })
  }
}

function createTraceAppendedNotifier({
  send,
  now = Date.now,
  setTimeoutFn = setTimeout,
  intervalMs = 200,
} = {}) {
  const pending = new Map()
  const lastSent = new Map()
  const timers = new Map()

  function flush(key) {
    timers.delete(key)
    const payload = pending.get(key)
    pending.delete(key)
    if (!payload) return
    lastSent.set(key, now())
    try { send?.(payload) } catch { /* notifications are best effort */ }
  }

  function notify(payload) {
    const key = `${payload?.runId || ''}:${payload?.agentRunId || ''}`
    pending.set(key, payload)
    if (timers.has(key)) return
    const elapsed = lastSent.has(key) ? now() - lastSent.get(key) : intervalMs
    if (elapsed >= intervalMs) {
      flush(key)
      return
    }
    const timer = setTimeoutFn(() => flush(key), intervalMs - elapsed)
    timer?.unref?.()
    timers.set(key, timer)
  }

  return { notify }
}

module.exports = { createTraceAppendedNotifier, registerTraceIpc }
