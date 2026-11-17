'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { atomicWritePrivateFile } = require('../../security/private-file.cjs')
const { redactSecrets } = require('../../security/secret-redaction.cjs')
const { childSecrets } = require('../../agents/cli/cli-runtime-event-sanitizer.cjs')
const { encodeId } = require('./trace-ids.cjs')
const { createStreamingRedactor } = require('./streaming-redactor.cjs')
const { createTraceMapper } = require('./trace-mappers/index.cjs')
const { traceStepSchema } = require('./trace-step.cjs')

const ID = /^[A-Za-z0-9._:-]{1,120}$/
const FIELD_LIMIT = 256 * 1024
const FLUSH_BYTES = 64 * 1024
const FLUSH_MS = 1000
const SPLIT_MS = 500
const SPLIT_BYTES = 4096

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8')
}

function createTraceSink({
  tracesRoot,
  runId,
  agentRunId,
  groupId,
  projectId = null,
  agentKind = '',
  outputFormat = '',
  childEnv = {},
  knownSessionRefs = [],
  now = () => new Date().toISOString(),
  onAppended = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  writeFault = null,
} = {}) {
  if (!tracesRoot) throw new Error('TRACE_INPUT_INVALID')
  for (const value of [runId, agentRunId, groupId]) {
    if (!ID.test(String(value || ''))) {
      throw Object.assign(new Error('TRACE_INPUT_INVALID'), { code: 'TRACE_INPUT_INVALID' })
    }
  }

  const sessionRefs = knownSessionRefs
    .map(value => String(value || ''))
    .filter(Boolean)
  let knownValues = buildKnownValues(childEnv)

  function buildKnownValues(env) {
    return [...new Set([...childSecrets(env), ...sessionRefs])]
      .sort((left, right) => right.length - left.length)
  }

  const runDir = path.join(tracesRoot, encodeId(runId))
  const encodedAgentRunId = encodeId(agentRunId)
  const filePath = path.join(runDir, `${encodedAgentRunId}.jsonl`)
  const blobsDir = path.join(runDir, `${encodedAgentRunId}.blobs`)
  const metaPath = path.join(runDir, 'meta.json')

  let seq = 0
  let descriptor = null
  let lines = []
  let bufferedBytes = 0
  let flushTimer = null
  let failed = null
  let ended = false
  const streams = new Map()
  const mappers = new Map()
  const diagnostics = []

  function nowIso() {
    const value = now()
    return typeof value === 'string' ? value : new Date(value).toISOString()
  }

  function recordFailure(error) {
    if (!failed) failed = error
    diagnostics.push(String(error?.code || error?.message || error))
    lines = []
    bufferedBytes = 0
    if (flushTimer) {
      clearTimeoutFn(flushTimer)
      flushTimer = null
    }
  }

  function redactString(value) {
    let text = String(value || '')
    for (const known of knownValues) {
      if (known) text = text.split(known).join('[redacted]')
    }
    return redactSecrets(text)
  }

  function redactDeep(value) {
    if (typeof value === 'string') return redactString(value)
    if (Array.isArray(value)) return value.map(redactDeep)
    if (!value || typeof value !== 'object') return value
    const result = {}
    for (const [key, item] of Object.entries(value)) result[key] = redactDeep(item)
    return result
  }

  function ensureRunDir() {
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(blobsDir, { recursive: true, mode: 0o700 })
  }

  const meta = {
    runId,
    groupId,
    projectId: projectId || null,
    createdAt: nowIso(),
  }
  try {
    ensureRunDir()
    atomicWritePrivateFile(metaPath, `${JSON.stringify(meta)}\n`)
  } catch (error) {
    recordFailure(error)
  }

  function ensureFile() {
    if (descriptor !== null) return descriptor
    ensureRunDir()
    descriptor = fs.openSync(filePath, 'a', 0o600)
    return descriptor
  }

  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeoutFn(() => {
      flushTimer = null
      flush()
    }, FLUSH_MS)
    flushTimer?.unref?.()
  }

  function flush({ force = false } = {}) {
    if (flushTimer) {
      clearTimeoutFn(flushTimer)
      flushTimer = null
    }
    if (!lines.length) return
    if (failed && !force) {
      lines = []
      bufferedBytes = 0
      return
    }
    const data = lines.join('')
    lines = []
    bufferedBytes = 0
    try {
      ensureFile()
      if (typeof writeFault === 'function') writeFault()
      fs.writeSync(descriptor, data)
      fs.fsyncSync(descriptor)
      if (typeof onAppended === 'function') {
        try { onAppended({ runId, agentRunId, lastSeq: seq }) } catch { /* best effort */ }
      }
    } catch (error) {
      recordFailure(error)
    }
  }

  function writeBlob(step, field, text) {
    ensureRunDir()
    const blobId = `${step.seq}-${field}`
    fs.writeFileSync(path.join(blobsDir, `${blobId}.txt`), text, { mode: 0o600 })
    return { blobId, bytes: byteLength(text) }
  }

  function writeStep(draft, { force = false } = {}) {
    if (ended || (failed && !force)) return
    const next = { seq: seq + 1, at: nowIso(), ...draft }
    try {
      const blobs = { ...(next.blobs || {}) }
      for (const field of ['output', 'command', 'title']) {
        if (typeof next[field] === 'string' && byteLength(next[field]) > FIELD_LIMIT) {
          blobs[field] = writeBlob(next, field, next[field])
          delete next[field]
        }
      }
      for (const field of ['input', 'raw']) {
        if (next[field] === undefined) continue
        const serialized = JSON.stringify(next[field])
        if (serialized && byteLength(serialized) > FIELD_LIMIT) {
          blobs[field] = writeBlob(next, field, serialized)
          delete next[field]
        }
      }
      if (Object.keys(blobs).length) next.blobs = blobs
      const step = traceStepSchema.parse(next)
      seq = step.seq
      const line = `${JSON.stringify(step)}\n`
      lines.push(line)
      bufferedBytes += byteLength(line)
      if (bufferedBytes >= FLUSH_BYTES) flush()
      else scheduleFlush()
    } catch (error) {
      recordFailure(error)
    }
  }

  function redactDraft(draft) {
    const result = { ...draft }
    if (typeof result.title === 'string') result.title = redactString(result.title)
    if (typeof result.command === 'string') result.command = redactString(result.command)
    if (typeof result.output === 'string') result.output = redactString(result.output)
    if (result.input !== undefined) result.input = redactDeep(result.input)
    if (result.raw !== undefined) result.raw = redactDeep(result.raw)
    return result
  }

  function streamKey(draft) {
    if (draft.kind === 'tool') {
      return `tool:${draft.toolCallId || 'tool'}:${draft.title || ''}`
    }
    return draft.kind
  }

  function getStream(draft) {
    const key = streamKey(draft)
    let stream = streams.get(key)
    if (!stream) {
      stream = {
        redactor: createStreamingRedactor({ knownValues }),
        buffer: '',
        timer: null,
        template: {
          kind: draft.kind,
          ...(draft.toolCallId ? { toolCallId: draft.toolCallId } : {}),
          ...(draft.title ? { title: draft.title } : {}),
          ...(draft.status ? { status: draft.status } : {}),
          raw: {
            type: draft.raw?.type || 'coalesced',
            coalesced: true,
          },
        },
      }
      streams.set(key, stream)
    }
    return stream
  }

  function emitStream(stream) {
    const text = stream.buffer
    stream.buffer = ''
    if (stream.timer) {
      clearTimeoutFn(stream.timer)
      stream.timer = null
    }
    if (!text) return
    writeStep({ ...stream.template, output: text })
  }

  function queueStream(stream, text) {
    if (!text) return
    stream.buffer += text
    while (byteLength(stream.buffer) > SPLIT_BYTES) {
      const chunk = stream.buffer.slice(0, SPLIT_BYTES)
      stream.buffer = stream.buffer.slice(SPLIT_BYTES)
      writeStep({ ...stream.template, output: chunk })
    }
    if (stream.buffer && !stream.timer) {
      stream.timer = setTimeoutFn(() => {
        stream.timer = null
        emitStream(stream)
      }, SPLIT_MS)
      stream.timer?.unref?.()
    }
  }

  function processDraft(draft) {
    if (!draft || typeof draft !== 'object') return
    if (draft.raw?.coalesced === true && typeof draft.output === 'string') {
      const stream = getStream(draft)
      queueStream(stream, stream.redactor.push(draft.output))
      return
    }
    writeStep(redactDraft(draft))
  }

  function mapperFor(channel) {
    const key = `${channel}|${agentKind}|${outputFormat}`
    if (!mappers.has(key)) {
      mappers.set(key, createTraceMapper({ channel, agentKind, outputFormat }))
    }
    return mappers.get(key)
  }

  function ingest(channel, rawEvent) {
    if (failed || ended) return
    try {
      const mapper = mapperFor(channel)
      for (const draft of mapper.map(rawEvent)) processDraft(draft)
    } catch (error) {
      recordFailure(error)
    }
  }

  function end() {
    if (ended) return
    try {
      if (!failed) {
        for (const stream of streams.values()) {
          queueStream(stream, stream.redactor.end())
          emitStream(stream)
        }
        for (const mapper of mappers.values()) {
          for (const draft of mapper.end()) processDraft(draft)
        }
      }
      flush()
      if (!failed) {
        try {
          atomicWritePrivateFile(metaPath, `${JSON.stringify({
            ...meta,
            completedAt: nowIso(),
          })}\n`)
        } catch (error) {
          recordFailure(error)
        }
      }
      if (failed) {
        try {
          writeStep({
            kind: 'lifecycle',
            title: 'trace-incomplete',
            status: 'incomplete',
          }, { force: true })
        } catch { /* the trace is already incomplete */ }
        flush({ force: true })
      }
    } catch (error) {
      recordFailure(error)
    } finally {
      ended = true
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor)
        } catch { /* already closed */ }
        descriptor = null
      }
    }
  }

  return {
    end,
    ingest,
    setChildEnv: env => { knownValues = buildKnownValues(env) },
    diagnostics: () => [...diagnostics],
  }
}

module.exports = { createTraceSink }
