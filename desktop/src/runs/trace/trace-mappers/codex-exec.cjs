'use strict'

const { stripSessionMetadata } = require('../trace-metadata.cjs')

const TOOL_ID = /^[A-Za-z0-9._:-]{1,120}$/

function safeId(value) {
  const id = String(value || '')
  return TOOL_ID.test(id) ? id : ''
}

function outputText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(item => (typeof item === 'string' ? item : item?.text))
      .filter(item => typeof item === 'string')
      .join('')
  }
  if (typeof value?.text === 'string') return value.text
  if (typeof value?.content === 'string') return value.content
  return ''
}

function createCodexExecMapper() {
  return {
    map(rawEvent) {
      const event = stripSessionMetadata(rawEvent || {})
      if (event.type === 'thread.started' || event.type === 'turn.started') {
        return [{ kind: 'lifecycle', title: event.type, status: 'running', raw: event }]
      }
      if (event.type === 'turn.completed') {
        return [{ kind: 'lifecycle', title: event.type, status: 'completed', raw: event }]
      }
      if (!['item.started', 'item.completed'].includes(event.type) || !event.item) {
        return [{ kind: 'raw', title: String(event.type || 'event').slice(0, 2000), raw: event }]
      }
      const item = event.item
      const completed = event.type === 'item.completed'
      if (item.type === 'agent_message') {
        if (typeof item.text !== 'string' || !item.text) return []
        return [{ kind: 'message', output: item.text, raw: event }]
      }
      if (item.type === 'reasoning') {
        const text = typeof item.summary === 'string' ? item.summary : ''
        if (!text && !completed) return []
        return [{
          kind: 'thinking',
          title: 'reasoning',
          status: completed ? 'completed' : 'running',
          ...(text ? { output: text } : {}),
          raw: event,
        }]
      }
      if (item.type === 'plan') {
        const text = typeof item.summary === 'string' ? item.summary : item.text
        return [{
          kind: 'plan',
          title: 'plan',
          status: completed ? 'completed' : 'running',
          ...(typeof text === 'string' && text ? { output: text } : {}),
          raw: event,
        }]
      }
      if (item.type === 'command_execution') {
        const id = safeId(item.id)
        const failed = item.status === 'failed'
          || (Number.isInteger(item.exit_code) && item.exit_code !== 0)
        const output = outputText(item.aggregated_output ?? item.output)
        return [{
          kind: 'tool',
          ...(id ? { toolCallId: id } : {}),
          title: 'command_execution',
          status: failed ? 'failed' : completed ? 'completed' : 'running',
          ...(typeof item.command === 'string' ? { command: item.command } : {}),
          ...(output ? { output } : {}),
          ...(Number.isInteger(item.exit_code) ? { exitCode: item.exit_code } : {}),
          raw: event,
        }]
      }
      if (item.type) {
        const id = safeId(item.id)
        const text = outputText(item.output ?? item.content)
        return [{
          kind: 'tool',
          ...(id ? { toolCallId: id } : {}),
          title: String(item.type).slice(0, 2000),
          status: completed ? 'completed' : 'running',
          input: item,
          ...(text ? { output: text } : {}),
          raw: event,
        }]
      }
      return [{ kind: 'raw', title: 'item', raw: event }]
    },
    end() {
      return []
    },
  }
}

module.exports = { createCodexExecMapper }
