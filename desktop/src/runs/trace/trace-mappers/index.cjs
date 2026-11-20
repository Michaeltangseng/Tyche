'use strict'

const { createAcpMapper } = require('./acp.cjs')
const { createClaudeStreamJsonMapper } = require('./claude-stream-json.cjs')
const { createCodexExecMapper } = require('./codex-exec.cjs')
const { createRawMapper, createStructuredRawMapper } = require('./raw.cjs')

const CLAUDE_STREAM_JSON_AGENTS = new Set(['claude', 'qwen', 'workbuddy'])

function supportsFullTrace({ channel = '', agentKind = '', outputFormat = '' } = {}) {
  if (channel === 'acp') return true
  if (channel === 'stdout' || channel === 'stderr') return false
  if (outputFormat === 'stream-json') return true
  if (outputFormat === 'jsonl' && (agentKind === 'codex' || agentKind === 'hermes')) return true
  return false
}

function createTraceMapper({ channel = 'stdout', agentKind = '', outputFormat = '' } = {}) {
  if (channel === 'acp') return createAcpMapper()
  if (channel === 'stdout' || channel === 'stderr') {
    return createRawMapper({ channel })
  }
  if (channel === 'structured') {
    if (outputFormat === 'stream-json'
        && (CLAUDE_STREAM_JSON_AGENTS.has(agentKind) || !agentKind)) {
      return createClaudeStreamJsonMapper()
    }
    if (agentKind === 'codex' && outputFormat === 'jsonl') {
      return createCodexExecMapper()
    }
    return createStructuredRawMapper()
  }
  return createStructuredRawMapper()
}

module.exports = { createTraceMapper, supportsFullTrace }
