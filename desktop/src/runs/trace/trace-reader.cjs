'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { encodeId } = require('./trace-ids.cjs')

const ID = /^[A-Za-z0-9._:-]{1,120}$/
const PAGE_LIMIT_BYTES = 512 * 1024
const BLOB_LIMIT = 256 * 1024

function traceError(code) {
  return Object.assign(new Error(code), { code })
}

function assertId(value) {
  if (!ID.test(String(value || ''))) throw traceError('TRACE_NOT_FOUND')
}

function readEntries(file) {
  let buffer
  try {
    buffer = fs.readFileSync(file)
  } catch {
    return { entries: [], bytes: 0, incomplete: false }
  }
  const entries = []
  let invalid = false
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue
    const end = index + 1
    const lineStart = start
    const line = buffer.subarray(lineStart, index).toString('utf8')
    start = end
    if (!line.trim()) continue
    try {
      entries.push({ start: lineStart, end, step: JSON.parse(line) })
    } catch {
      invalid = true
    }
  }
  const trailingPartial = start < buffer.length
  return {
    entries,
    bytes: buffer.length,
    incomplete: invalid || trailingPartial
      || entries.some(entry => entry.step?.title === 'trace-incomplete'),
  }
}

function trimUtf8(buffer) {
  let end = buffer.length
  while (end > 0 && (buffer[end - 1] & 0xc0) === 0x80) end -= 1
  if (end === 0) return buffer
  const lead = buffer[end - 1]
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return buffer.length - end + 1 < needed ? buffer.subarray(0, end - 1) : buffer
}

function createTraceReader({
  tracesRoot,
  isKnownGroup = () => false,
  isAuthorizedTrace = () => false,
  cursorKey = crypto.randomBytes(32),
} = {}) {
  if (!tracesRoot) throw traceError('TRACE_PATH_INVALID')

  function knownGroup(groupId) {
    try {
      return Boolean(isKnownGroup(groupId))
    } catch {
      return false
    }
  }

  function runPaths(runId, agentRunId) {
    assertId(runId)
    assertId(agentRunId)
    const runDir = path.join(tracesRoot, encodeId(runId))
    const metaPath = path.join(runDir, 'meta.json')
    let meta
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    } catch {
      throw traceError('TRACE_NOT_FOUND')
    }
    if (!meta || meta.runId !== runId || (!knownGroup(meta.groupId)
        && !isAuthorizedTrace({ runId, agentRunId, meta }))) {
      throw traceError('TRACE_NOT_FOUND')
    }
    const encodedAgent = encodeId(agentRunId)
    return {
      meta,
      runDir,
      encodedAgent,
      file: path.join(runDir, `${encodedAgent}.jsonl`),
      blobs: path.join(runDir, `${encodedAgent}.blobs`),
    }
  }

  function sign(payload) {
    return crypto.createHmac('sha256', cursorKey).update(payload).digest('base64url')
  }

  function encodeCursor(file, offset) {
    const payload = Buffer.from(JSON.stringify({ f: file, o: offset }), 'utf8').toString('base64url')
    return `${payload}.${sign(payload)}`
  }

  function decodeCursor(cursor, file) {
    const text = String(cursor || '')
    const separator = text.lastIndexOf('.')
    if (separator <= 0) throw traceError('TRACE_CURSOR_INVALID')
    const payload = text.slice(0, separator)
    const signature = text.slice(separator + 1)
    const expected = sign(payload)
    const left = Buffer.from(signature)
    const right = Buffer.from(expected)
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      throw traceError('TRACE_CURSOR_INVALID')
    }
    let decoded
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch {
      throw traceError('TRACE_CURSOR_INVALID')
    }
    if (decoded?.f !== file || !Number.isSafeInteger(decoded.o) || decoded.o < 0) {
      throw traceError('TRACE_CURSOR_INVALID')
    }
    return decoded.o
  }

  function status({ runId, agentRunId }) {
    const context = runPaths(runId, agentRunId)
    const parsed = readEntries(context.file)
    const lastSeq = parsed.entries.reduce(
      (latest, entry) => Math.max(latest, Number(entry.step?.seq) || 0),
      0,
    )
    const incomplete = parsed.incomplete
    return {
      lastSeq,
      complete: Boolean(context.meta.completedAt) && !incomplete,
      incomplete,
      bytes: parsed.bytes,
    }
  }

  function page({
    runId,
    agentRunId,
    cursor,
    direction = 'forward',
    limit = 50,
  }) {
    const context = runPaths(runId, agentRunId)
    const parsed = readEntries(context.file)
    const offset = cursor
      ? decodeCursor(cursor, context.encodedAgent)
      : (direction === 'backward' ? parsed.bytes : 0)
    let selected
    let hasMore
    if (direction === 'backward') {
      const before = parsed.entries.filter(entry => entry.end <= offset)
      const start = Math.max(0, before.length - limit)
      selected = before.slice(start)
      hasMore = start > 0
    } else {
      const after = parsed.entries.filter(entry => entry.start >= offset)
      selected = after.slice(0, limit)
      hasMore = after.length > selected.length
    }

    const steps = []
    let nextOffset = offset
    if (direction === 'backward') {
      let used = 0
      for (let index = selected.length - 1; index >= 0; index -= 1) {
        const size = Buffer.byteLength(JSON.stringify(selected[index].step))
        if (steps.length && used + size > PAGE_LIMIT_BYTES) {
          hasMore = true
          break
        }
        steps.unshift(selected[index].step)
        used += size
        nextOffset = selected[index].start
      }
      if (!steps.length) nextOffset = 0
    } else {
      let used = 0
      for (const entry of selected) {
        const size = Buffer.byteLength(JSON.stringify(entry.step))
        if (steps.length && used + size > PAGE_LIMIT_BYTES) {
          hasMore = true
          break
        }
        steps.push(entry.step)
        used += size
        nextOffset = entry.end
      }
    }

    const runStatus = status({ runId, agentRunId })
    return {
      steps,
      cursor: steps.length ? encodeCursor(context.encodedAgent, nextOffset) : null,
      hasMore,
      complete: runStatus.complete,
    }
  }

  function blob({
    runId,
    agentRunId,
    blobId,
    offset = 0,
    length = BLOB_LIMIT,
  }) {
    if (!ID.test(String(blobId || ''))) throw traceError('TRACE_NOT_FOUND')
    const context = runPaths(runId, agentRunId)
    const file = path.join(context.blobs, `${blobId}.txt`)
    let buffer
    try {
      buffer = fs.readFileSync(file)
    } catch {
      throw traceError('TRACE_NOT_FOUND')
    }
    const start = Math.max(0, Number(offset) || 0)
    const end = Math.min(buffer.length, start + Math.min(length, BLOB_LIMIT))
    const slice = trimUtf8(buffer.subarray(start, end))
    return {
      text: slice.toString('utf8'),
      totalBytes: buffer.length,
      eof: end >= buffer.length,
    }
  }

  return { blob, page, status }
}

module.exports = { createTraceReader, traceError }
