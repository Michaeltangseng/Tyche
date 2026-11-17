const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadWorkspaceState, saveWorkspaceState, workspaceSnapshot } = require('../../src/workspace/local-workspace-state.cjs')

test('snapshot exposes only the newest bound run outcome without private ledger fields', () => {
  const record = { runId: 'run-new', groupId: 'group', threadRootId: 'root', status: 'completed',
    targetKinds: ['codex'], startedAt: 20, finishedAt: 30,
    sessionRef: '/private/native-session', reason: 'secret', agentRuns: [{ output: 'private' }] }
  const snapshot = workspaceSnapshot({
    detectedAgents: [], preparingRuns: new Map(), activeRuns: new Map(),
    state: { groups: [{ id: 'group' }], messages: [{ id: 'root', groupId: 'group', role: 'user' }] },
    runLedger: { list: () => [record,
      { ...record, runId: 'run-old', startedAt: 10, finishedAt: 40, status: 'failed' },
      { ...record, groupId: 'other' }, { ...record, threadRootId: 'missing' },
    ] },
  })
  assert.deepEqual(snapshot.runOutcomes, [{ runId: 'run-new', groupId: 'group', threadRootId: 'root',
    status: 'completed', targetKinds: ['codex'], startedAt: 20, finishedAt: 30 }])
  assert.deepEqual(snapshot.runs, [])
  snapshot.runOutcomes[0].targetKinds.push('hermes')
  assert.deepEqual(record.targetKinds, ['codex'])
})

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workspace-state-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'workspace.json')
}

test('a maximum-length Connector session reference survives workspace reload', t => {
  const storagePath = fixture(t)
  const reference = 'x'.repeat(256)
  saveWorkspaceState(storagePath, { version: 3, groups: [], messages: [], sessions: { 'group:connector': reference } })
  assert.equal(loadWorkspaceState(storagePath).state.sessions['group:connector'], reference)
})

test('distinguishes missing, corrupt, unreadable, unsupported, and valid workspace state', (t) => {
  const storagePath = fixture(t)

  assert.deepEqual(loadWorkspaceState(storagePath), {
    state: {
      version: 4, groups: [], messages: [], sessions: {}, sessionMeta: {},
      agentPreferences: {}, agentRuntime: {},
    },
    status: 'missing',
    trusted: true,
    diagnostic: '',
  })

  fs.writeFileSync(storagePath, '{invalid json')
  assert.equal(loadWorkspaceState(storagePath).status, 'corrupt')
  assert.equal(loadWorkspaceState(storagePath).diagnostic, 'LOCAL_WORKSPACE_STATE_CORRUPT')

  fs.writeFileSync(storagePath, JSON.stringify({ version: 99, groups: [], messages: [], sessions: {} }))
  assert.equal(loadWorkspaceState(storagePath).status, 'unsupported')
  assert.equal(loadWorkspaceState(storagePath).diagnostic, 'LOCAL_WORKSPACE_STATE_UNSUPPORTED')

  fs.rmSync(storagePath)
  fs.mkdirSync(storagePath)
  assert.equal(loadWorkspaceState(storagePath).status, 'unreadable')
  assert.equal(loadWorkspaceState(storagePath).diagnostic, 'LOCAL_WORKSPACE_STATE_UNREADABLE')

  fs.rmSync(storagePath, { recursive: true })
  fs.writeFileSync(storagePath, JSON.stringify({ version: 3, groups: [], messages: [], sessions: {} }))
  assert.equal(loadWorkspaceState(storagePath).status, 'ready')
  assert.equal(loadWorkspaceState(storagePath).trusted, true)
})

test('a group emptied by an earlier build is recovered from its replies instead of dropped', (t) => {
  const storagePath = fixture(t)
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 3,
    groups: [
      { id: 'emptied', name: 'Emptied', agentKinds: [], workdir: '/tmp' },
      { id: 'silent', name: 'Never replied', agentKinds: [], workdir: '/tmp' },
    ],
    messages: [
      { id: 'u1', groupId: 'emptied', role: 'user', content: 'Plan it' },
      { id: 'a1', groupId: 'emptied', role: 'agent', agentKind: 'hermes', content: 'Hermes reply' },
      { id: 'a2', groupId: 'emptied', role: 'agent', agentKind: 'codex', content: 'Codex reply' },
      { id: 'a3', groupId: 'emptied', role: 'agent', agentKind: 'hermes', content: 'Hermes again' },
      { id: 'u2', groupId: 'silent', role: 'user', content: 'Nobody answered' },
    ],
    sessions: {},
  }))

  const { state, trusted } = loadWorkspaceState(storagePath)
  assert.equal(trusted, true)
  assert.deepEqual(state.groups.map(group => [group.id, group.agentKinds]), [
    ['emptied', ['hermes', 'codex']],
  ])
  assert.deepEqual(state.messages.map(message => message.id), ['u1', 'a1', 'a2', 'a3'])
})


test('v3 workspace files are written back as v4 with a one-time v3 backup', (t) => {
  const storagePath = fixture(t)
  const original = `${JSON.stringify({
    version: 3,
    groups: [{ id: 'group-1', name: 'Group', agentKinds: ['codex'], workdir: '/tmp' }],
    messages: [],
    sessions: { 'group-1:codex': 'session-1' },
  })}\n`
  fs.writeFileSync(storagePath, original)

  const loaded = loadWorkspaceState(storagePath)
  assert.equal(loaded.state.version, 4)

  saveWorkspaceState(storagePath, loaded.state)
  assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8')).version, 4)
  const backupPath = path.join(path.dirname(storagePath), 'meldwork-workspace.v3.backup.json')
  assert.equal(fs.readFileSync(backupPath, 'utf8'), original)

  fs.writeFileSync(backupPath, 'keep-me')
  saveWorkspaceState(storagePath, loaded.state)
  assert.equal(fs.readFileSync(backupPath, 'utf8'), 'keep-me')
})

test('a new workspace is saved as v4 without creating a v3 backup', (t) => {
  const storagePath = fixture(t)
  saveWorkspaceState(storagePath, {
    version: 4, groups: [], messages: [], sessions: {},
  })
  assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8')).version, 4)
  assert.equal(fs.existsSync(
    path.join(path.dirname(storagePath), 'meldwork-workspace.v3.backup.json'),
  ), false)
})





test('a real v3 workspace fixture upgrades without losing groups, messages, or sessions', (t) => {
  const storagePath = fixture(t)
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'meldwork-workspace-v3.json')
  const original = fs.readFileSync(fixturePath, 'utf8')
  fs.writeFileSync(storagePath, original)

  const loaded = loadWorkspaceState(storagePath)
  assert.equal(loaded.status, 'ready')
  assert.equal(loaded.state.version, 4)
  assert.deepEqual(loaded.state.groups.map(group => group.id), [
    'group-1', 'group-2', 'group-3', 'group-4',
  ])
  assert.deepEqual(loaded.state.groups.map(group => group.name), [
    'Group 1', 'Group 2', 'Group 3', 'Group 4',
  ])
  assert.equal(loaded.state.groups[0].allowWrite, true)
  assert.equal(loaded.state.groups[1].conversationType, 'direct')
  assert.deepEqual(loaded.state.messages.map(message => message.id), [
    'message-1', 'message-2', 'message-3', 'message-4', 'message-5', 'message-6',
  ])
  assert.deepEqual(loaded.state.messages.map(message => message.role), [
    'user', 'agent', 'user', 'agent', 'user', 'agent',
  ])
  assert.deepEqual(loaded.state.sessions, { 'group-4:gemini': 'fixture-session-1' })

  saveWorkspaceState(storagePath, loaded.state)
  const saved = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  assert.equal(saved.version, 4)
  assert.equal(saved.groups.length, 4)
  assert.equal(saved.messages.length, 6)
  assert.deepEqual(saved.sessions, loaded.state.sessions)
  const backupPath = path.join(path.dirname(storagePath), 'meldwork-workspace.v3.backup.json')
  assert.equal(fs.readFileSync(backupPath, 'utf8'), original)
})
