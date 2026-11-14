const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CustomAgentStore } = require('../../src/agents/custom-agent-store.cjs')

const fakeAgent = path.join(__dirname, '..', 'fixtures', 'fake-agent', 'fake-agent.cjs')
const at = '2026-01-01T00:00:00.000Z'
const kind = `custom-${'a'.repeat(16)}`

function fixture(t, steps, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-fake-agent-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const scriptPath = path.join(directory, 'script.json')
  fs.writeFileSync(scriptPath, JSON.stringify({ steps, ...extra }))
  const storagePath = path.join(directory, 'agents.json')
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 1,
    agents: [{
      kind,
      label: 'Fake Agent',
      description: 'scripted test agent',
      executable: process.execPath,
      args: [fakeAgent, scriptPath],
      promptMode: 'stdin',
      createdAt: at,
    }],
  }))
  const store = new CustomAgentStore({ storagePath, platform: process.platform })
  return { directory, scriptPath, store }
}

test('the fake agent performs scripted steps and prints its marker last', async (t) => {
  const { directory, scriptPath, store } = fixture(t, [
    { op: 'echoPrompt' },
    { op: 'write', path: 'docs/output.md', content: 'written by fake agent' },
    { op: 'run', command: '/bin/echo', args: ['ran'], print: true },
    { op: 'wait', ms: 1 },
  ], {
    finalText: 'Final answer',
    marker: '[[MELDWORK_CHECKPOINT:{"signal":"ready"}]]',
  })
  const result = await store.run(kind, 'Prompt body', directory, {
    sandbox: 'workspace-write',
  })
  assert.match(result.text, /Prompt body/)
  assert.match(result.text, /ran/)
  assert.match(result.text, /Final answer/)
  assert.equal(
    result.text.trim().split('\n').at(-1),
    '[[MELDWORK_CHECKPOINT:{"signal":"ready"}]]',
  )
  assert.equal(
    fs.readFileSync(path.join(directory, 'docs', 'output.md'), 'utf8'),
    'written by fake agent',
  )
})

test('a crashing fake agent is reported as a failed process', async (t) => {
  const { directory, scriptPath, store } = fixture(t, [
    { op: 'output', text: 'partial' },
    { op: 'crash', code: 3 },
  ])
  await assert.rejects(store.run(kind, 'Prompt', directory, {
    sandbox: 'workspace-write',
  }), { message: 'CUSTOM_AGENT_PROCESS_FAILED' })
})
