const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  resolveConnectorEventProfile,
} = require('../../../src/agents/cli/cli-event-profiles.cjs')

const FIXTURES = path.join(__dirname, '../../fixtures/trace')

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function summaryEvents(agentKind, fixture) {
  const profile = resolveConnectorEventProfile(agentKind)
  assert.ok(profile, agentKind)
  const state = profile.createState()
  const events = []
  for (const event of readJsonLines(path.join(FIXTURES, fixture))) {
    events.push(...profile.mapEvent(event, state))
  }
  return events
}

test('the summary channel stays byte-identical when full-trace fixtures are replayed', () => {
  const cases = [
    ['hermes', 'acp-session.jsonl', 'acp.json'],
    ['claude', 'claude-stream-json.jsonl', 'claude.json'],
    ['codex', 'codex-exec.jsonl', 'codex.json'],
  ]
  for (const [agentKind, fixture, baseline] of cases) {
    const expected = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, 'summary-baseline', baseline), 'utf8'),
    )
    assert.deepEqual(JSON.parse(JSON.stringify(summaryEvents(agentKind, fixture))), expected, agentKind)
  }
})
