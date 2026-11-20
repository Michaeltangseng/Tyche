'use strict'

const SESSION_KEYS = new Set([
  'sessionid',
  'session',
  'sessionref',
  'conversationid',
  'threadid',
  'resumeid',
])

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[_-]/g, '')
}

function stripSessionMetadata(value) {
  if (Array.isArray(value)) return value.map(stripSessionMetadata)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (SESSION_KEYS.has(normalizeKey(key))) continue
    result[key] = stripSessionMetadata(item)
  }
  return result
}

module.exports = { SESSION_KEYS, stripSessionMetadata }
