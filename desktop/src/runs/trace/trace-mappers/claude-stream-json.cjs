'use strict'

const { stripSessionMetadata } = require('../trace-metadata.cjs')

const TOOL_ID = /^[A-Za-z0-9._:-]{1,120}$/

function safeId(value) {
  const id = String(value || '')
  return TOOL_ID.test(id) ? id : ''
}

function blockText(block) {
  if (typeof block?.text === 'string') return block.text
  if (typeof block?.thinking === 'string') return block.thinking
  return ''
}

function resultText(block) {
  if (typeof block === 'string') return block
  if (Array.isArray(block)) {
    return block
      .map(item => (typeof item === 'string' ? item : item?.text))
      .filter(item => typeof item === 'string')
      .join('')
  }
  if (typeof block?.text === 'string') return block.text
  if (typeof block?.content === 'string') return block.content
  return ''
}

function createClaudeStreamJsonMapper() {
  const blocks = new Map()
  const streamedMessages = new Set()
  const mappedTools = new Set()
  let currentMessageId = ''

  function mapStream(event) {
    const update = event.event || {}
    const messageId = String(
      update.message_id || currentMessageId || update.message?.id || '',
    )
    if (update.type === 'message_start' && update.message?.id) {
      currentMessageId = String(update.message.id)
      return []
    }
    if (update.type === 'content_block_start') {
      const block = update.content_block || {}
      const id = String(block.id || '')
      if (id) blocks.set(String(update.index), { id, type: block.type })
      if (block.type === 'tool_use' && id) {
        mappedTools.add(id)
        return [{
          kind: 'tool',
          ...(safeId(id) ? { toolCallId: safeId(id) } : {}),
          title: String(block.name || 'tool').slice(0, 2000),
          status: 'running',
          ...(block.input !== undefined ? { input: block.input } : {}),
          raw: event,
        }]
      }
      return []
    }
    if (update.type === 'content_block_delta') {
      if (update.delta?.type === 'text_delta' && typeof update.delta.text === 'string') {
        if (messageId) streamedMessages.add(messageId)
        return [{
          kind: 'message',
          output: update.delta.text,
          raw: { type: 'content_block_delta', coalesced: true },
        }]
      }
      if (update.delta?.type === 'thinking_delta'
          && typeof update.delta.thinking === 'string') {
        if (messageId) streamedMessages.add(messageId)
        return [{
          kind: 'thinking',
          output: update.delta.thinking,
          raw: { type: 'content_block_delta', coalesced: true },
        }]
      }
      if (update.delta?.type === 'input_json_delta') {
        const block = blocks.get(String(update.index))
        if (block?.type === 'tool_use' && block.id) {
          return [{
            kind: 'tool',
            ...(safeId(block.id) ? { toolCallId: safeId(block.id) } : {}),
            title: 'tool',
            status: 'running',
            ...(typeof update.delta.partial_json === 'string'
              ? { input: update.delta.partial_json }
              : {}),
            raw: event,
          }]
        }
      }
      return []
    }
    return []
  }

  function mapAssistant(event) {
    const messageId = String(event.message?.id || '')
    const streamed = messageId && streamedMessages.has(messageId)
    const steps = []
    const content = event.message?.content
    const blocksList = Array.isArray(content) ? content : content ? [content] : []
    for (const block of blocksList) {
      if (block?.type === 'text') {
        if (streamed) continue
        const text = blockText(block)
        if (text) steps.push({ kind: 'message', output: text, raw: event })
      } else if (block?.type === 'thinking') {
        if (streamed) continue
        const text = blockText(block)
        if (text) steps.push({ kind: 'thinking', output: text, raw: event })
      } else if (block?.type === 'tool_use') {
        const id = String(block.id || '')
        if (id && mappedTools.has(id)) continue
        if (id) mappedTools.add(id)
        steps.push({
          kind: 'tool',
          ...(safeId(id) ? { toolCallId: safeId(id) } : {}),
          title: String(block.name || 'tool').slice(0, 2000),
          status: 'running',
          ...(block.input !== undefined ? { input: block.input } : {}),
          raw: event,
        })
      } else if (block?.type) {
        steps.push({ kind: 'raw', title: String(block.type).slice(0, 2000), raw: event })
      }
    }
    return steps
  }

  function mapUser(event) {
    const content = event.message?.content
    const blocksList = Array.isArray(content) ? content : content ? [content] : []
    const steps = []
    for (const block of blocksList) {
      if (block?.type === 'tool_result') {
        const id = String(block.tool_use_id || '')
        const text = resultText(block.content)
        steps.push({
          kind: 'tool',
          ...(safeId(id) ? { toolCallId: safeId(id) } : {}),
          title: 'tool',
          status: block.is_error === true ? 'failed' : 'completed',
          ...(text ? { output: text } : {}),
          raw: event,
        })
      }
    }
    return steps
  }

  return {
    map(rawEvent) {
      const event = stripSessionMetadata(rawEvent || {})
      if (event.type === 'stream_event') return mapStream(event)
      if (event.type === 'assistant') return mapAssistant(event)
      if (event.type === 'user') return mapUser(event)
      if (event.type === 'result') {
        return [{
          kind: 'lifecycle',
          title: 'result',
          status: event.is_error === true || event.subtype === 'error' ? 'failed' : 'completed',
          ...(typeof event.result === 'string' ? { output: event.result } : {}),
          raw: event,
        }]
      }
      if (event.type === 'system') {
        // Token counters and hook chatter dominate the trace without adding
        // anything a person can act on. Keep only meaningful lifecycle marks.
        if (event.subtype === 'init') {
          return [{
            kind: 'lifecycle',
            title: 'init',
            status: 'completed',
            ...(typeof event.model === 'string' ? { output: event.model } : {}),
            raw: event,
          }]
        }
        if (event.subtype === 'permission_denied') {
          return [{
            kind: 'lifecycle',
            title: 'permission_denied',
            status: 'failed',
            raw: event,
          }]
        }
        return []
      }
      return [{
        kind: 'raw',
        title: String(event.type || 'event').slice(0, 2000),
        raw: event,
      }]
    },
    end() {
      return []
    },
  }
}

module.exports = { createClaudeStreamJsonMapper }
