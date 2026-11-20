'use strict'

const { stripSessionMetadata } = require('../trace-metadata.cjs')

const TOOL_ID = /^[A-Za-z0-9._:-]{1,120}$/
const PLAN_UPDATES = new Set(['plan', 'plan_update', 'plan_removed'])

function toolCallId(value) {
  const id = String(value || '')
  return TOOL_ID.test(id) ? id : ''
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(item => (typeof item === 'string' ? item : item?.text))
      .filter(item => typeof item === 'string')
      .join('')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text
  }
  return ''
}

function toolPaths(update) {
  const paths = []
  if (Array.isArray(update.locations)) {
    for (const location of update.locations) {
      if (typeof location?.path === 'string' && location.path) paths.push(location.path)
    }
  }
  const input = update.rawInput ?? update.input ?? update.arguments ?? update.args
  for (const key of ['path', 'file', 'filePath', 'file_path']) {
    if (typeof input?.[key] === 'string' && input[key]) paths.push(input[key])
  }
  return [...new Set(paths)].slice(0, 256)
}

function toolInput(update) {
  return update.rawInput ?? update.input ?? update.arguments ?? update.args
}

function createAcpMapper() {
  return {
    map(rawEvent) {
      const update = stripSessionMetadata(rawEvent || {})
      const type = update.sessionUpdate
      if (type === 'agent_message_chunk'
          && update.content?.type === 'text'
          && typeof update.content.text === 'string') {
        return [{
          kind: 'message',
          output: update.content.text,
          raw: { type, coalesced: true },
        }]
      }
      if (type === 'agent_thought_chunk'
          && update.content?.type === 'text'
          && typeof update.content.text === 'string') {
        return [{
          kind: 'thinking',
          output: update.content.text,
          raw: { type, coalesced: true },
        }]
      }
      if (type === 'tool_call' || type === 'tool_call_update') {
        const id = toolCallId(update.toolCallId)
        const input = toolInput(update)
        const command = typeof update.command === 'string'
          ? update.command
          : typeof input?.command === 'string' ? input.command : ''
        const output = typeof update.output === 'string'
          ? update.output
          : contentText(update.content)
        const paths = toolPaths(update)
        return [{
          kind: 'tool',
          ...(id ? { toolCallId: id } : {}),
          title: String(update.title || update.kind || 'tool').slice(0, 2000),
          status: String(update.status || (type === 'tool_call' ? 'running' : 'completed')),
          ...(command ? { command } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(output ? { output } : {}),
          ...(paths.length ? { paths } : {}),
          raw: update,
        }]
      }
      if (PLAN_UPDATES.has(type)) {
        const plan = type === 'plan_update' ? update.plan : update
        const entries = Array.isArray(plan?.entries) ? plan.entries : []
        const output = entries.length
          ? entries.map(entry => String(entry?.content || '')).filter(Boolean).join('\n')
          : typeof plan?.content === 'string' ? plan.content : ''
        return [{
          kind: 'plan',
          title: 'plan',
          status: type === 'plan_removed' ? 'stopped' : 'running',
          ...(output ? { output } : {}),
          ...(plan !== undefined ? { input: plan } : {}),
          raw: update,
        }]
      }
      return [{
        kind: 'raw',
        title: String(type || 'event').slice(0, 2000),
        raw: update,
      }]
    },
    end() {
      return []
    },
  }
}

module.exports = { createAcpMapper }
