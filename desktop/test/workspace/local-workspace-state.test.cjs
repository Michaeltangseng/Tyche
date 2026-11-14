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
      version: 4, projects: [], groups: [], messages: [], sessions: {}, sessionMeta: {},
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

function writeProjectState(storagePath, projectId) {
  const filename = path.join(
    path.dirname(storagePath), 'meldwork-private', 'projects', projectId, 'state.json',
  )
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, '{}')
}

function projectCodes(issues, projectId) {
  return issues.filter(issue => issue.projectId === projectId).map(issue => issue.code)
}

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
  assert.deepEqual(loaded.state.projects, [])

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
    version: 4, projects: [], groups: [], messages: [], sessions: {},
  })
  assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8')).version, 4)
  assert.equal(fs.existsSync(
    path.join(path.dirname(storagePath), 'meldwork-workspace.v3.backup.json'),
  ), false)
})

test('v4 project records and project group fields survive load, save, and snapshot', (t) => {
  const storagePath = fixture(t)
  const workdir = path.join(path.dirname(storagePath), 'project-workdir')
  const project = {
    id: 'project-1',
    name: 'Project',
    workdir,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    deleting: { requestedAt: '2026-01-03T00:00:00.000Z', keepChats: true },
  }
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 4,
    projects: [project],
    groups: [
      {
        id: 'main', name: 'Main', agentKinds: ['codex'], workdir,
        projectId: 'project-1', projectRole: 'main',
      },
      {
        id: 'chat', name: 'Chat', agentKinds: ['codex'], workdir, projectId: 'project-1',
      },
    ],
    messages: [{ id: 'm1', groupId: 'main', role: 'user', content: 'Hello' }],
    sessions: { 'project:project-1:cp:1:seat:1:codex:g0': 'session-1' },
  }))
  writeProjectState(storagePath, 'project-1')

  const loaded = loadWorkspaceState(storagePath)
  assert.equal(loaded.status, 'ready')
  assert.deepEqual(loaded.state.projects, [project])
  assert.deepEqual(loaded.projectIssues, [])

  const snapshot = workspaceSnapshot({
    detectedAgents: [], state: loaded.state, preparingRuns: new Map(), activeRuns: new Map(),
    runLedger: { list: () => [] },
  })
  assert.equal(snapshot.groups.find(group => group.id === 'main').projectRole, 'main')
  assert.equal(snapshot.groups.find(group => group.id === 'chat').projectId, 'project-1')

  saveWorkspaceState(storagePath, loaded.state)
  const saved = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
  assert.equal(saved.version, 4)
  assert.deepEqual(saved.projects, [project])
  assert.equal(saved.groups.find(group => group.id === 'main').projectRole, 'main')
  assert.equal(saved.groups.find(group => group.id === 'chat').projectId, 'project-1')
  assert.equal(fs.existsSync(
    path.join(path.dirname(storagePath), 'meldwork-workspace.v3.backup.json'),
  ), false)
})

test('workspace loading reports project consistency issues without repairing projects', (t) => {
  const storagePath = fixture(t)
  const root = path.join(path.dirname(storagePath), 'projects')
  const workdirA = path.join(root, 'alpha')
  const workdirB = path.join(workdirA, 'nested')
  const workdirC = path.join(root, 'gamma')
  fs.mkdirSync(root, { recursive: true })
  const projects = [
    {
      id: 'alpha', name: 'Alpha', workdir: workdirA,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'beta', name: 'Beta', workdir: workdirB,
      createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'gamma', name: 'Gamma', workdir: workdirA,
      createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z',
    },
    {
      id: 'delta', name: 'Delta', workdir: workdirC,
      createdAt: '2026-01-04T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z',
    },
  ]
  const groups = [
    {
      id: 'alpha-main', name: 'Alpha main', agentKinds: ['codex'], workdir: workdirA,
      projectId: 'alpha', projectRole: 'main',
    },
    {
      id: 'beta-main', name: 'Beta main', agentKinds: ['codex'], workdir: workdirB,
      projectId: 'beta', projectRole: 'main',
    },
    {
      id: 'delta-main', name: 'Delta main', agentKinds: ['codex'], workdir: workdirC,
      projectId: 'delta', projectRole: 'main',
    },
    {
      id: 'dangling', name: 'Dangling', agentKinds: ['codex'], workdir: workdirA,
      projectId: 'missing-project',
    },
    {
      id: 'orphan-main', name: 'Orphan main', agentKinds: ['codex'], workdir: workdirA,
      projectRole: 'main',
    },
  ]
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 4, projects, groups, messages: [], sessions: {},
  }))
  for (const projectId of ['alpha', 'beta', 'gamma']) writeProjectState(storagePath, projectId)

  const loaded = loadWorkspaceState(storagePath)
  assert.equal(loaded.status, 'ready')
  assert.equal(loaded.state.projects.length, 4)
  assert.deepEqual(projectCodes(loaded.projectIssues, 'alpha'), [])
  assert.ok(projectCodes(loaded.projectIssues, 'beta').includes('PROJECT_WORKDIR_OVERLAP'))
  assert.ok(projectCodes(loaded.projectIssues, 'gamma').includes('PROJECT_MAIN_CHAT_INVALID'))
  assert.ok(projectCodes(loaded.projectIssues, 'gamma').includes('PROJECT_WORKDIR_OVERLAP'))
  assert.deepEqual(projectCodes(loaded.projectIssues, 'delta'), ['PROJECT_STATE_MISSING'])

  const overlap = loaded.projectIssues.find(issue => (
    issue.projectId === 'beta' && issue.code === 'PROJECT_WORKDIR_OVERLAP'
  ))
  assert.equal(overlap.readOnly, true)
  assert.equal(overlap.conflictsWith, 'alpha')
  assert.equal(loaded.projectIssues.find(issue => (
    issue.projectId === 'gamma' && issue.code === 'PROJECT_MAIN_CHAT_INVALID'
  )).readOnly, true)

  assert.equal(loaded.state.groups.find(group => group.id === 'dangling').projectId, undefined)
  assert.equal(loaded.state.groups.find(group => group.id === 'orphan-main').projectRole, undefined)
  assert.ok(projectCodes(loaded.projectIssues, 'missing-project').includes('PROJECT_GROUP_DANGLING'))
  assert.ok(loaded.projectIssues.some(issue => (
    issue.code === 'PROJECT_MAIN_CHAT_DANGLING' && issue.groupId === 'orphan-main'
  )))
})

test('invalid project records are dropped and reported', (t) => {
  const storagePath = fixture(t)
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 4,
    projects: [
      { id: 'bad id', name: 'Bad', workdir: '/tmp/project' },
      { id: 'missing-workdir', name: 'Missing' },
      { id: 'relative-workdir', name: 'Relative', workdir: 'relative/path' },
      { id: 'valid-project', name: 'Valid', workdir: '/tmp/valid-project' },
    ],
    groups: [], messages: [], sessions: {},
  }))

  const loaded = loadWorkspaceState(storagePath)
  assert.deepEqual(loaded.state.projects.map(project => project.id), ['valid-project'])
  assert.equal(
    loaded.projectIssues.filter(issue => issue.code === 'PROJECT_INVALID').length, 3,
  )
  assert.ok(loaded.projectIssues.some(issue => (
    issue.projectId === 'valid-project' && issue.code === 'PROJECT_MAIN_CHAT_INVALID'
  )))
  assert.ok(loaded.projectIssues.some(issue => (
    issue.projectId === 'valid-project' && issue.code === 'PROJECT_STATE_MISSING'
  )))
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
