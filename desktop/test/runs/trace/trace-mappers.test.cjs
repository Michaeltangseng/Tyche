const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createTraceMapper } = require('../../../src/runs/trace/trace-mappers/index.cjs')
const { stripSessionMetadata } = require('../../../src/runs/trace/trace-metadata.cjs')

const FIXTURES = path.join(__dirname, '../../fixtures/trace')
const AGENT_OUTPUT = path.join(__dirname, '../../fixtures/agent-output')

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function mapFixture(name, options) {
  const mapper = createTraceMapper(options)
  const file = path.join(FIXTURES, name)
  const text = fs.readFileSync(file, 'utf8')
  const events = name.endsWith('.jsonl')
    ? text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    : [text]
  const steps = []
  for (const event of events) steps.push(...mapper.map(event))
  steps.push(...mapper.end())
  return steps
}

function expected(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected', name), 'utf8'))
}

function assertNoSessionMetadata(value, sessionValues = []) {
  const text = JSON.stringify(value)
  for (const sessionValue of sessionValues) {
    assert.equal(text.includes(sessionValue), false, `leaked session value ${sessionValue}`)
  }
  const visit = (item) => {
    if (Array.isArray(item)) {
      item.forEach(visit)
      return
    }
    if (!item || typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) {
      const normalized = key.toLowerCase().replace(/[_-]/g, '')
      assert.equal(
        ['sessionid', 'session', 'sessionref', 'conversationid', 'threadid', 'resumeid']
          .includes(normalized),
        false,
        `leaked key ${key}`,
      )
      visit(child)
    }
  }
  visit(value)
}

test('ACP updates map to thinking, message, tool, plan, and raw steps', () => {
  const steps = mapFixture('acp-session.jsonl', {
    channel: 'acp', agentKind: 'codex', outputFormat: 'acp',
  })
  assert.deepEqual(steps, expected('acp-session.expected.json'))
  assert.equal(steps.filter(step => step.toolCallId === 'acp-tool-1').length, 2)
  assert.equal(steps.at(-1).kind, 'raw')
})

test('Claude stream-json maps deltas, deduplicates the final assistant message, and maps tool results', () => {
  const steps = mapFixture('claude-stream-json.jsonl', {
    channel: 'structured', agentKind: 'claude', outputFormat: 'stream-json',
  })
  assert.deepEqual(steps, expected('claude-stream-json.expected.json'))
  assert.deepEqual(
    steps.filter(step => step.kind === 'thinking').map(step => step.output),
    ['Let me inspect the file. ', 'Then I will answer.'],
  )
  assert.deepEqual(
    steps.filter(step => step.kind === 'message').map(step => step.output),
    ['I will read the file ', 'and summarize it.'],
  )
  assert.equal(steps.filter(step => step.toolCallId === 'toolu_fixture_1').length, 3)
})

test('Codex exec maps lifecycle, reasoning, commands, and messages', () => {
  const steps = mapFixture('codex-exec.jsonl', {
    channel: 'structured', agentKind: 'codex', outputFormat: 'jsonl',
  })
  assert.deepEqual(steps, expected('codex-exec.expected.json'))
  const command = steps.find(step => step.toolCallId === 'codex-command-1' && step.command)
  assert.equal(command.command, 'ls -la')
  assert.equal(steps.filter(step => step.kind === 'thinking').length, 1)
  assert.equal(steps.filter(step => step.kind === 'message').length, 1)
})

test('plain stdout and stderr map line by line', () => {
  const stdout = mapFixture('raw-stdout.txt', { channel: 'stdout' })
  assert.deepEqual(stdout, expected('raw-stdout.expected.json'))
  assert.deepEqual(stdout.map(step => step.kind), ['raw', 'raw'])
  const stderr = mapFixture('raw-stderr.txt', { channel: 'stderr' })
  assert.deepEqual(stderr, expected('raw-stderr.expected.json'))
  assert.equal(stderr[0].kind, 'stderr')
})

test('unknown structured events become raw steps', () => {
  const mapper = createTraceMapper({
    channel: 'structured', agentKind: 'unknown', outputFormat: 'csv',
  })
  const steps = mapper.map({ type: 'mystery', value: 1 })
  assert.equal(steps.length, 1)
  assert.equal(steps[0].kind, 'raw')
  assert.deepEqual(steps[0].raw, { type: 'mystery', value: 1 })
})

test('session metadata keys are removed recursively', () => {
  const stripped = stripSessionMetadata({
    session_id: 'a',
    SessionId: 'b',
    sessionRef: 'c',
    thread_id: 'd',
    conversationId: 'e',
    resumeId: 'f',
    keep: { session: 'g', nested: [{ sessionId: 'h', value: 1 }] },
  })
  assert.deepEqual(stripped, { keep: { nested: [{ value: 1 }] } })
})

test('mapped fixtures never contain a known session value or session key', () => {
  const cases = [
    ['acp-session.jsonl', { channel: 'acp' }, ['acp-fixture-session']],
    ['claude-stream-json.jsonl', { channel: 'structured', agentKind: 'claude', outputFormat: 'stream-json' }, ['claude-fixture-session']],
    ['codex-exec.jsonl', { channel: 'structured', agentKind: 'codex', outputFormat: 'jsonl' }, ['codex-fixture-session']],
  ]
  for (const [name, options, sessionValues] of cases) {
    const steps = mapFixture(name, options)
    assertNoSessionMetadata(steps, sessionValues)
  }
})

test('existing agent-output fixtures do not leak their session identifiers', () => {
  const files = fs.readdirSync(AGENT_OUTPUT).filter(name => /\.(jsonl|json)$/.test(name))
  for (const name of files) {
    const text = fs.readFileSync(path.join(AGENT_OUTPUT, name), 'utf8')
    const sessionValues = [...text.matchAll(/"(?:session_id|sessionId|thread_id|threadId)"\s*:\s*"([^"]+)"/g)]
      .map(match => match[1])
      .filter(Boolean)
    let events
    try {
      const parsed = JSON.parse(text)
      events = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      events = text.split(/\r?\n/).filter(Boolean).map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return line
        }
      })
    }
    const mapper = createTraceMapper({
      channel: 'structured', agentKind: 'unknown', outputFormat: 'unknown',
    })
    const steps = []
    for (const event of events) steps.push(...mapper.map(event))
    steps.push(...mapper.end())
    assertNoSessionMetadata(steps, sessionValues)
  }
})
