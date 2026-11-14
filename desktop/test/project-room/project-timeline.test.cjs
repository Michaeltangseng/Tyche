const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')
const {
  PendingMessageStore,
  TimelineHistoryStore,
  sha256,
} = require('../../src/project-room/project-timeline.cjs')
const { ProjectService } = require('../../src/project-room/project-service.cjs')

const at = '2026-01-01T00:00:00.000Z'

async function makeWorkspace(t) {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Main', agentKinds: ['codex'], workdir: directory,
    projectId: 'project-1', projectRole: 'main',
  })
  return { workspace, group, directory, options }
}

function userGate() {
  return {
    projectId: 'project-1',
    checkpointId: 'cp-1',
    generation: 0,
    gateId: 'gate-1',
    revision: 1,
    outcome: 'accept',
  }
}

function agentSignal() {
  return {
    projectId: 'project-1',
    checkpointId: 'cp-1',
    seatId: 'seat-1',
    role: 'lead',
    round: 1,
    generation: 0,
    signal: 'ready',
    reviewFile: 'meldwork/reviews/cp-1/r1-seat-1.md',
  }
}

test('projectRoom metadata survives write and reload for user and agent messages', async (t) => {
  const { workspace, group, options } = await makeWorkspace(t)
  const user = workspace.addMessage(
    group.id, 'user', 'Opinion', '', '', null, { projectRoom: userGate() },
  )
  const agent = workspace.addMessage(
    group.id, 'agent', 'Answer', 'codex', '', null, { projectRoom: agentSignal() },
  )
  assert.deepEqual(user.projectRoom, userGate())
  assert.deepEqual(agent.projectRoom, agentSignal())

  const reloaded = new LocalWorkspace(options)
  assert.deepEqual(reloaded.state.messages.find(message => message.id === user.id).projectRoom, userGate())
  assert.deepEqual(reloaded.state.messages.find(message => message.id === agent.id).projectRoom, agentSignal())
})

test('invalid projectRoom fields are dropped without touching the message', async (t) => {
  const { workspace, group, options } = await makeWorkspace(t)
  const message = workspace.addMessage(
    group.id, 'user', 'Plain', '', '', null,
    { projectRoom: { projectId: 'bad id', start: true } },
  )
  assert.equal(message.projectRoom, undefined)
  const partial = workspace.addMessage(
    group.id, 'agent', 'Answer', 'codex', '', null,
    {
      projectRoom: {
        ...agentSignal(), verdict: 'invented', extra: true,
      },
    },
  )
  assert.equal(partial.projectRoom.role, 'lead')
  assert.equal(partial.projectRoom.verdict, undefined)
  assert.equal(partial.projectRoom.extra, undefined)
  const malformed = workspace.addMessage(
    group.id, 'agent', 'Answer', 'codex', '', null,
    { projectRoom: { ...agentSignal(), role: 'unknown' } },
  )
  assert.equal(malformed.projectRoom, undefined)

  const reloaded = new LocalWorkspace(options)
  assert.equal(reloaded.state.messages.find(item => item.id === message.id).projectRoom, undefined)
})

test('stable-id insertion is idempotent and conflicts fail closed', async (t) => {
  const { workspace, group } = await makeWorkspace(t)
  const input = {
    groupId: group.id,
    id: 'message-1',
    role: 'agent',
    agentKind: 'codex',
    content: 'Answer',
    createdAt: at,
    projectRoom: agentSignal(),
  }
  const first = workspace.insertProjectRoomMessage(input)
  assert.equal(first.deduplicated, false)
  assert.equal(first.message.id, 'message-1')
  assert.equal(first.message.createdAt, at)

  const replay = workspace.insertProjectRoomMessage(input)
  assert.equal(replay.deduplicated, true)
  assert.equal(workspace.state.messages.filter(message => message.id === 'message-1').length, 1)

  assert.throws(() => workspace.insertProjectRoomMessage({ ...input, content: 'Changed' }), (error) => {
    assert.equal(error.code, 'PROJECT_STORAGE_FAULT')
    assert.equal(error.details.reason, 'message-id-conflict')
    return true
  })
  assert.equal(
    workspace.state.messages.find(message => message.id === 'message-1').content,
    'Answer',
  )
})

test('a persistence failure does not report a stable-id insertion as successful', async (t) => {
  const { workspace, group } = await makeWorkspace(t)
  const originalSave = workspace.save.bind(workspace)
  workspace.save = () => { throw Object.assign(new Error('EIO'), { phase: 'before-commit' }) }
  assert.throws(() => workspace.insertProjectRoomMessage({
    groupId: group.id,
    id: 'message-2',
    role: 'user',
    content: 'Opinion',
    createdAt: at,
    projectRoom: userGate(),
  }), { message: 'EIO' })
  workspace.save = originalSave
  assert.equal(workspace.state.messages.some(message => message.id === 'message-2'), false)
})

function pendingFixture(t) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-pending-messages-'))
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }))
  return { projectDir }
}

test('pending messages are staged privately, redacted, and consumed by reference', async (t) => {
  const { projectDir } = pendingFixture(t)
  const store = new PendingMessageStore({ projectDir, now: () => 1000 })
  const secret = 'sk-abcdefghijklmnop'
  const staged = await store.stage({
    sourceKey: ['project-1', 'invoke', 'effect-1'],
    body: `Answer ${secret}`,
    metadata: { messageId: 'message-1', groupId: 'group-1' },
  })
  assert.match(staged.ref, /^[a-f0-9]{64}$/)
  assert.match(staged.summary, /^[a-f0-9]{64}$/)
  assert.equal('body' in staged, false)

  const filename = path.join(projectDir, 'pending-messages', `${staged.ref}.json`)
  const payload = JSON.parse(fs.readFileSync(filename, 'utf8'))
  assert.equal(payload.body.includes(secret), false)
  assert.equal(payload.body.includes('[redacted]'), true)
  assert.equal(store.read(staged.ref).metadata.messageId, 'message-1')

  const replay = await store.stage({
    sourceKey: ['project-1', 'invoke', 'effect-1'],
    body: `Answer ${secret}`,
    metadata: { messageId: 'message-1', groupId: 'group-1' },
  })
  assert.equal(replay.ref, staged.ref)
  await assert.rejects(store.stage({
    sourceKey: ['project-1', 'invoke', 'effect-1'],
    body: 'Different answer',
    metadata: { messageId: 'message-1', groupId: 'group-1' },
  }), { code: 'PROJECT_STORAGE_FAULT' })

  await store.consume(staged.ref)
  assert.equal(store.read(staged.ref), null)
})

test('orphan pending messages are cleaned up by reference', async (t) => {
  const { projectDir } = pendingFixture(t)
  const store = new PendingMessageStore({ projectDir, now: () => 1000 })
  const first = await store.stage({ sourceKey: ['a'], body: 'A', metadata: {} })
  const second = await store.stage({ sourceKey: ['b'], body: 'B', metadata: {} })
  assert.equal(await store.cleanupOrphans([first.ref]), 1)
  assert.ok(store.read(first.ref))
  assert.equal(store.read(second.ref), null)
})

function timelineDir(t) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-timeline-'))
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }))
  return projectDir
}

function checkpointRecord(seed, overrides = {}) {
  const id = sha256(seed)
  return {
    id,
    record: {
      schemaVersion: 1,
      id,
      type: 'checkpoint-start',
      projectId: 'project-1',
      checkpointId: 'cp-1',
      checkpointKey: 'requirements',
      generation: 0,
      at,
      ...overrides,
    },
  }
}

test('timeline records are appended idempotently and paginated with bound cursors', async (t) => {
  const projectDir = timelineDir(t)
  const store = new TimelineHistoryStore({ projectDir, now: () => 1000 })
  const first = checkpointRecord('first')
  const second = checkpointRecord('second', {
    at: '2026-01-02T00:00:00.000Z',
    type: 'checkpoint-reopen',
    reason: 'Reopened.',
  })
  await store.append(first)
  await store.append(second)
  await store.append(first)

  const page = store.read({ projectId: 'project-1', limit: 1 })
  assert.equal(page.total, 2)
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].type, 'checkpoint-start')
  assert.ok(page.nextCursor)

  const next = store.read({ projectId: 'project-1', cursor: page.nextCursor, limit: 1 })
  assert.equal(next.items[0].type, 'checkpoint-reopen')
  assert.equal(next.nextCursor, null)

  assert.throws(() => store.read({
    projectId: 'project-2', cursor: page.nextCursor, limit: 1,
  }), { code: 'PROJECT_INPUT_INVALID' })
  assert.throws(() => store.read({
    projectId: 'project-1', cursor: `${page.nextCursor}tampered`, limit: 1,
  }), { code: 'PROJECT_INPUT_INVALID' })
})

test('timeline merge includes pending effects and deduplicates archived ones', async (t) => {
  const projectDir = timelineDir(t)
  const store = new TimelineHistoryStore({ projectDir, now: () => 1000 })
  const archived = checkpointRecord('archived')
  await store.append(archived)
  const pending = checkpointRecord('pending', {
    at: '2026-01-03T00:00:00.000Z',
    type: 'gate-decided',
    gateId: 'gate-1',
    gateRevision: 1,
    reason: 'needs-human',
    outcome: 'accept',
    comment: 'Looks good.',
  })
  const result = store.read({
    projectId: 'project-1',
    pending: [archived.record, pending.record],
  })
  assert.deepEqual(result.items.map(item => item.id), [archived.id, pending.id])
})

test('timeline records redact known secrets and reject conflicting replays', async (t) => {
  const projectDir = timelineDir(t)
  const store = new TimelineHistoryStore({ projectDir, now: () => 1000 })
  const secret = 'sk-abcdefghijklmnop'
  const pending = checkpointRecord('secret', {
    type: 'gate-decided',
    gateId: 'gate-1',
    gateRevision: 1,
    reason: 'needs-human',
    outcome: 'continue',
    comment: `Please ${secret}`,
  })
  await store.append(pending)
  const saved = JSON.parse(fs.readFileSync(
    path.join(projectDir, 'timeline', `${pending.id}.json`), 'utf8',
  ))
  assert.equal(saved.comment.includes(secret), false)
  assert.equal(saved.comment.includes('[redacted]'), true)

  await assert.rejects(store.append({
    id: pending.id,
    record: { ...pending.record, comment: 'Different comment.' },
  }), { code: 'PROJECT_STORAGE_FAULT' })
})

test('the project service merges archived and pending timeline records', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-timeline-service-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const privateRoot = path.join(root, 'meldwork-private')
  const projectDir = path.join(privateRoot, 'projects', 'project-1')
  fs.mkdirSync(projectDir, { recursive: true })
  const store = new TimelineHistoryStore({ projectDir, now: () => 1000 })
  const archived = checkpointRecord('service-archived')
  await store.append(archived)
  const pending = checkpointRecord('service-pending', { at: '2026-01-05T00:00:00.000Z' })

  const service = new ProjectService({
    workspace: { state: { projects: [] }, save() {}, emitChanged() {} },
    privateRoot,
    scheduler: { snapshot: () => ({ claimGrants: [], claimQueue: [], residuals: [] }) },
    templatesStore: { templates: [], get: () => null, load: async () => [] },
    createId: (() => { let id = 0; return () => `id-${id += 1}` })(),
    now: () => at,
  })
  service.projects.set('project-1', {
    project: { id: 'project-1' },
    store: {
      current: () => ({
        projectEffects: [{ type: 'append-timeline', params: { record: pending.record } }],
        instances: [],
      }),
    },
    readOnly: false,
    readOnlyReason: '',
  })
  const result = service.timelineHistory('project-1')
  assert.deepEqual(result.items.map(item => item.id), [archived.id, pending.id])
})
