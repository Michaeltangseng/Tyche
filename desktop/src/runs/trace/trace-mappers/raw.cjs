'use strict'

const { stripSessionMetadata } = require('../trace-metadata.cjs')

function createRawMapper({ channel = 'stdout' } = {}) {
  let pending = ''
  const kind = channel === 'stderr' ? 'stderr' : 'raw'

  function lineDraft(line) {
    if (!line) return null
    return {
      kind,
      output: line,
      raw: { type: `${channel}-line`, line },
    }
  }

  return {
    map(rawEvent) {
      if (typeof rawEvent !== 'string') {
        return [{ kind: 'raw', raw: stripSessionMetadata(rawEvent || {}) }]
      }
      pending += rawEvent
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      return lines.map(lineDraft).filter(Boolean)
    },
    end() {
      const tail = pending
      pending = ''
      return tail ? [lineDraft(tail)].filter(Boolean) : []
    },
  }
}

function createStructuredRawMapper() {
  return {
    map(rawEvent) {
      const event = stripSessionMetadata(rawEvent || {})
      return [{
        kind: 'raw',
        title: String(event.type || event.sessionUpdate || 'event').slice(0, 2000),
        raw: event,
      }]
    },
    end() {
      return []
    },
  }
}

module.exports = { createRawMapper, createStructuredRawMapper }
