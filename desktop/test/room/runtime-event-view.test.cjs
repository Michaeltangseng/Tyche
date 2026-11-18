const test = require('node:test')
const assert = require('node:assert/strict')

const {
  sanitizeRuntimeEvent,
  sanitizeStoredEvent,
  safeEvent,
} = require('../../src/room/runtime-event-view.cjs')

function payload(event) {
  return { runId: 'reply-1', chatId: 'chat-1', roleId: 'role-1', mode: 'chat', event }
}

test('text and reasoning deltas are bounded and redacted', () => {
  const view = sanitizeRuntimeEvent(payload({
    kind: 'text_delta',
    text: 'token sk-secret-value and more',
    seq: 3,
  }))
  assert.equal(view.runId, 'reply-1')
  assert.equal(view.event.kind, 'text_delta')
  assert.equal(view.event.seq, 3)
  assert.equal(view.event.text.includes('sk-secret-value'), false)

  const reasoning = sanitizeRuntimeEvent(payload({
    kind: 'reasoning',
    content: { kind: 'text', text: 'thinking' },
  }))
  assert.equal(reasoning.event.text, 'thinking')
})

test('tool lifecycle events keep only display fields', () => {
  const started = sanitizeRuntimeEvent(payload({
    kind: 'tool_call_started',
    callId: 'call-1',
    toolName: 'shell',
    input: '{"command":"ls"}',
    executable: '/private/bin/tool',
  }))
  assert.deepEqual(started.event, {
    kind: 'tool_call_started',
    callId: 'call-1',
    toolName: 'shell',
    input: '{"command":"ls"}',
  })

  const ended = sanitizeRuntimeEvent(payload({
    kind: 'tool_call_ended',
    callId: 'call-1',
    tool: 'shell',
    result: 'failed',
    exitCode: 2,
    content: [{ type: 'text', text: 'permission denied' }],
  }))
  assert.equal(ended.event.status, 'failed')
  assert.equal(ended.event.output, 'permission denied')
  assert.equal(ended.event.exitCode, 2)
})

test('usage and turn events keep provider-reported numbers only', () => {
  const usage = sanitizeRuntimeEvent(payload({
    kind: 'usage',
    usage: {
      inputTokens: 1200,
      outputTokens: 80,
      totalTokens: 1280,
      context: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
      privateCost: 99,
    },
  }))
  assert.deepEqual(usage.event.usage, {
    inputTokens: 1200,
    outputTokens: 80,
    totalTokens: 1280,
    context: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
  })

  const ended = sanitizeRuntimeEvent(payload({ kind: 'turn_ended', outcome: 'completed' }))
  assert.equal(ended.event.outcome, 'completed')
})

test('OAR token totals become in, out, and cache, with cache kept out of input', () => {
  const usage = sanitizeRuntimeEvent(payload({
    kind: 'usage',
    usage: {
      context: { tokens: 15497, contextWindow: 1000000, percent: 2 },
      tokens: { input: 44744, output: 790, cacheRead: 29824, cacheWrite: 0 },
      total: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      sessionId: 'secret',
    },
  }))
  assert.deepEqual(usage.event.usage, {
    inputTokens: 14920,
    outputTokens: 790,
    cachedInputTokens: 29824,
    context: { tokens: 15497, contextWindow: 1000000, percent: 2 },
  })

  const fromTotal = sanitizeRuntimeEvent(payload({
    kind: 'usage',
    usage: { total: { input: 80, output: 20, cacheRead: 30 } },
  }))
  assert.deepEqual(fromTotal.event.usage, {
    inputTokens: 50,
    outputTokens: 20,
    cachedInputTokens: 30,
  })

  const contextOnly = sanitizeRuntimeEvent(payload({
    kind: 'usage',
    usage: { context: { tokens: 5420, contextWindow: 1000000, percent: 0.542 } },
  }))
  assert.deepEqual(contextOnly.event.usage, {
    context: { tokens: 5420, contextWindow: 1000000, percent: 0.542 },
  })
})

test('malformed payloads and unknown private events are rejected', () => {
  assert.equal(sanitizeRuntimeEvent(null), null)
  assert.equal(sanitizeRuntimeEvent({ runId: 'r', chatId: 'c', mode: 'other', event: { kind: 'text_delta' } }), null)
  assert.equal(sanitizeRuntimeEvent({ runId: '', chatId: 'c', mode: 'chat', event: { kind: 'text_delta' } }), null)
  assert.deepEqual(safeEvent({ kind: 'private_event', sessionRef: 'secret' }), { kind: 'private_event' })
})

test('stored events reuse the same payload allowlist', () => {
  const view = sanitizeStoredEvent({
    id: 'event-1',
    runId: 'run-1',
    chatId: 'chat-1',
    taskId: 'task-1',
    mode: 'task',
    seq: 4,
    kind: 'tool_call_started',
    payload: {
      kind: 'tool_call_started',
      callId: 'call-1',
      toolName: 'shell',
      input: 'ls',
      executable: '/private/bin/tool',
    },
    createdAt: '2026-11-17T00:00:00Z',
  })
  assert.equal(view.payload.toolName, 'shell')
  assert.equal(view.payload.executable, undefined)
  assert.equal(view.taskId, 'task-1')
})

test('host tool results are hidden while the tool name is preserved', () => {
  const started = sanitizeRuntimeEvent(payload({
    kind: 'tool_call_started',
    callId: 'call-1',
    tool: { name: 'mcp__tyche__post_in_chat' },
    input: '{"text":"hello"}',
  }))
  assert.equal(started.event.toolName, 'mcp__tyche__post_in_chat')

  const ended = sanitizeRuntimeEvent(payload({
    kind: 'tool_call_ended',
    callId: 'call-1',
    toolName: 'mcp__tyche__post_in_chat',
    content: [{ type: 'text', text: '{"id":"message-1","chatId":"chat-1","audience":"chat"}' }],
  }))
  assert.equal(ended.event.toolName, 'mcp__tyche__post_in_chat')
  assert.equal(ended.event.output, '')
})
