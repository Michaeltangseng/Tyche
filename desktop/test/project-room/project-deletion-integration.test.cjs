const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProjectDeletion } = require('../../src/project-room/project-deletion.cjs')
const { ProjectStore } = require('../../src/project-room/project-store.cjs')
const { CheckpointEngine } = require('../../src/project-room/checkpoint-engine.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { makeClaim } = require('../../src/runs/path-claims.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T00:00:00.000Z'

test('deletion releases managed scheduler grants and leaves invocation leases alone', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-deletion-integration-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const workdir = path.join(directory, 'work')
  fs.mkdirSync(workdir, { recursive: true })
  const privateRoot = path.join(directory, 'private')
  const projectDir = path.join(privateRoot, 'projects', 'project-1')
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(
    path.join(projectDir, 'state.json'),
    `${JSON.stringify(emptyProjectState({ projectId: 'project-1' }))}\n`,
  )
  const store = new ProjectStore({ projectDir, now: () => at })
  await store.load()
  const scheduler = new RunScheduler()
  const claim = await makeClaim({ root: workdir, path: '', mode: 'exclusive' })
  scheduler.request({
    requestId: 'managed-1',
    holder: { kind: 'checkpoint-scope', projectId: 'project-1', ownerId: 'cp-1' },
    claims: [claim],
  })
  scheduler.request({
    requestId: 'invocation-1',
    holder: { kind: 'invocation', projectId: 'project-1', ownerId: 'group-1' },
    claims: [claim],
  })
  const engine = new CheckpointEngine({
    projectId: 'project-1',
    store,
    scheduler,
    handlers: {},
    workdir,
    now: () => at,
  })
  const workspace = {
    state: {
      projects: [{
        id: 'project-1', name: 'Project', workdir, createdAt: at, updatedAt: at,
        deleting: { requestedAt: at, keepChats: false },
      }],
      groups: [],
      messages: [],
      sessions: {},
    },
    save() {},
    emitChanged() {},
  }
  const deletion = new ProjectDeletion({
    workspace,
    privateRoot,
    scheduler,
    getContext: () => ({ project: workspace.state.projects[0], store }),
    engine,
    effects: { isIdle: () => true, onIdle: () => {}, removeIdleListener: () => {} },
    invocations: {
      activeInvocations: () => 0,
      onInvocationEnded: () => {},
      removeInvocationEndedListener: () => {},
      cancelAll: () => {},
    },
    now: () => at,
    onDeleted: () => {},
  })

  const waiting = await deletion.retryDeletion('project-1')
  assert.equal(waiting.deleted, false)
  let snapshot = scheduler.snapshot()
  assert.equal(snapshot.claimGrants.some(record => record.requestId === 'managed-1'), false)
  assert.equal(snapshot.claimGrants.some(record => record.requestId === 'invocation-1'), true)
  assert.equal(fs.existsSync(projectDir), true)

  scheduler.release('invocation-1')
  const result = await deletion.retryDeletion('project-1')
  assert.equal(result.deleted, true)
  snapshot = scheduler.snapshot()
  assert.equal(snapshot.claimGrants.length, 0)
  assert.equal(fs.existsSync(projectDir), false)
  assert.deepEqual(workspace.state.projects, [])
})
