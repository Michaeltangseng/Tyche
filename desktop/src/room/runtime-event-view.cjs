/**
 * Display-safe projection of OAR runtime events.
 *
 * Raw events can carry executable paths, native session refs, and unbounded
 * tool payloads. The renderer only needs enough to draw a live process box and
 * a read-only trace, so every event is reduced to an allowlist and bounded
 * strings. Secrets are redacted before crossing the preload boundary.
 */
const { redactSecrets } = require('../security/secret-redaction.cjs')

const MAX_TEXT = 32 * 1024
const MAX_INPUT = 4 * 1024
const MAX_OUTPUT = 8 * 1024

function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return ''
  return redactSecrets(value).slice(0, max)
}

function number(value) {
  return Number.isFinite(value) ? value : null
}

function toolOutput(value, max = MAX_OUTPUT) {
  if (typeof value === 'string') return text(value, max)
  if (!Array.isArray(value)) return ''
  return text(value.map(part => {
    if (part?.type === 'text') return part.text ?? ''
    if (part?.type === 'image') return `[image ${part.mediaType ?? ''}]`
    return typeof part?.value === 'string' ? part.value : ''
  }).filter(Boolean).join('\n'), max)
}

function toolNameOf(event) {
  return text(
    event.toolName
      || event.tool?.name
      || event.name
      || (typeof event.tool === 'string' ? event.tool : '')
      || 'tool',
    120,
  )
}

const HOST_TOOLS = /(?:^|__)(assign_in_group|post_in_chat|create_roles|rename_chat|create_task|finish_task|comment_task|mention|read_chat)$/

function hostToolOutput(name, output) {
  // Host tool results are structured domain rows. The trace should show that
  // the tool ran, not the internal ids and message payloads it returned.
  return HOST_TOOLS.test(name) ? '' : output
}

/**
 * OAR's running total counts cache reads and writes inside `input`. The room
 * shows those beside input, the way a member strip is read, so input here is
 * the part that is not cache.
 */
function projectTokenTotals(totals) {
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return null
  const input = number(totals.input)
  const output = number(totals.output)
  if (input === null && output === null) return null
  const cacheRead = number(totals.cacheRead)
  const cacheWrite = number(totals.cacheWrite)
  const hasCache = cacheRead !== null || cacheWrite !== null
  const cache = (cacheRead ?? 0) + (cacheWrite ?? 0)
  const reasoning = number(totals.reasoning)
  return {
    inputTokens: Math.max(0, (input ?? 0) - (hasCache ? cache : 0)),
    outputTokens: output ?? 0,
    ...(hasCache ? { cachedInputTokens: cache } : {}),
    ...(reasoning !== null ? { reasoningTokens: reasoning } : {}),
  }
}

function safeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  const result = {}
  for (const key of [
    'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens',
    'reasoningTokens', 'costUsd', 'costMicros',
  ]) {
    const value = number(usage[key])
    if (value !== null) result[key] = value
  }
  const projected = projectTokenTotals(usage.tokens) || projectTokenTotals(usage.total)
  if (projected) {
    for (const [key, value] of Object.entries(projected)) {
      if (result[key] === undefined) result[key] = value
    }
  }
  if (usage.context && typeof usage.context === 'object' && !Array.isArray(usage.context)) {
    const tokens = number(usage.context.tokens)
    const contextWindow = number(usage.context.contextWindow)
    const percent = number(usage.context.percent)
    if (tokens !== null || contextWindow !== null || percent !== null) {
      result.context = {
        ...(tokens !== null ? { tokens } : {}),
        ...(contextWindow !== null ? { contextWindow } : {}),
        ...(percent !== null ? { percent } : {}),
      }
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

function safeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const kind = typeof event.kind === 'string' && event.kind ? event.kind.slice(0, 80) : 'unknown'
  const result = {
    kind,
    ...(Number.isInteger(event.seq) ? { seq: event.seq } : {}),
  }
  switch (kind) {
    case 'text_delta':
      result.text = text(event.text)
      break
    case 'reasoning':
      result.text = text(event.content?.kind === 'text' ? event.content.text : '')
      break
    case 'tool_call_started':
      result.toolName = toolNameOf(event)
      if (event.callId) result.callId = text(event.callId, 160)
      result.input = text(event.input, MAX_INPUT)
      break
    case 'tool_call_input':
      if (event.callId) result.callId = text(event.callId, 160)
      result.input = text(event.input, MAX_INPUT)
      break
    case 'tool_call_ended': {
      if (event.callId) result.callId = text(event.callId, 160)
      const name = toolNameOf(event)
      result.toolName = name
      result.status = event.result === 'failed' ? 'failed' : 'completed'
      result.output = hostToolOutput(name, toolOutput(event.content, 2000))
      if (Number.isInteger(event.exitCode)) result.exitCode = event.exitCode
      break
    }
    case 'usage': {
      const usage = safeUsage(event.usage)
      if (usage) result.usage = usage
      break
    }
    case 'turn_ended':
      result.outcome = text(event.outcome ?? '', 80)
      break
    case 'exited':
      result.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null
      break
    case 'failure':
      result.message = text(event.message ?? event.reason ?? '', MAX_OUTPUT)
      break
    default:
      break
  }
  return result
}

function sanitizeRuntimeEvent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  if (typeof payload.runId !== 'string' || !payload.runId) return null
  if (typeof payload.chatId !== 'string' || !payload.chatId) return null
  if (payload.mode !== 'chat' && payload.mode !== 'task') return null
  const event = safeEvent(payload.event)
  if (!event) return null
  return {
    runId: payload.runId,
    chatId: payload.chatId,
    roleId: typeof payload.roleId === 'string' ? payload.roleId : '',
    taskId: typeof payload.taskId === 'string' ? payload.taskId : null,
    mode: payload.mode,
    event,
  }
}

/** Sanitize a stored runtime-events row returned by runtime-events.list. */
function sanitizeStoredEvent(row) {
  if (!row || typeof row !== 'object') return null
  return {
    id: row.id,
    runId: row.runId,
    chatId: row.chatId,
    taskId: row.taskId ?? null,
    mode: row.mode,
    seq: row.seq,
    kind: row.kind,
    payload: safeEvent(row.payload && typeof row.payload === 'object'
      ? { ...row.payload, kind: row.kind }
      : { kind: row.kind }),
    createdAt: row.createdAt,
  }
}

module.exports = { sanitizeRuntimeEvent, sanitizeStoredEvent, safeEvent, safeUsage }
