const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { RunScheduler } = require('../../src/runs/run-scheduler.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error('timed out waiting for condition')
}

test('a writable invocation fails closed when its workdir cannot be resolved', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const scheduler = new RunScheduler()
  options.runScheduler = scheduler
  let calls = 0
  options.runAgent = async () => {
    calls += 1
    return { text: 'should not run', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const workdir = path.join(directory, 'missing-workdir')
  fs.mkdirSync(workdir)
  const group = workspace.createGroup({
    name: 'Missing workdir', agentKinds: ['kimi'], workdir, allowWrite: true,
  })
  fs.rmSync(workdir, { recursive: true, force: true })

  await workspace.sendMessage({ groupId: group.id, text: 'write', targetKinds: ['kimi'] })

  assert.equal(calls, 0)
  const lastMessage = workspace.snapshot().messages.at(-1)
  assert.equal(lastMessage.system.params.reason, 'LOCAL_WORKDIR_UNRESOLVED')
  const snapshot = scheduler.snapshot()
  assert.equal(snapshot.queued.length, 0)
  assert.equal(snapshot.claimGrants.length, 0)
  assert.equal(snapshot.active.global, 0)
})

test('a read-only invocation still runs when its workdir cannot be resolved', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const scheduler = new RunScheduler()
  options.runScheduler = scheduler
  let calls = 0
  options.runAgent = async () => {
    calls += 1
    return { text: 'read-only reply', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const workdir = path.join(directory, 'missing-readonly-workdir')
  fs.mkdirSync(workdir)
  const group = workspace.createGroup({
    name: 'Missing read-only workdir', agentKinds: ['kimi'], workdir, allowWrite: false,
  })
  fs.rmSync(workdir, { recursive: true, force: true })

  await workspace.sendMessage({ groupId: group.id, text: 'read', targetKinds: ['kimi'] })

  assert.equal(calls, 1)
  const snapshot = scheduler.snapshot()
  assert.equal(snapshot.claimGrants.length, 0)
})

test('two writable conversations in the same folder do not wait for each other', async (t) => {
  const { directory, options } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const scheduler = new RunScheduler()
  options.runScheduler = scheduler
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  options.runAgent = async () => {
    calls += 1
    await gate
    return { text: 'done', outcome: 'completed' }
  }
  const workspace = new LocalWorkspace(options)
  await workspace.refreshAgents()
  const workdir = path.join(directory, 'shared-workdir')
  fs.mkdirSync(workdir)
  const first = workspace.createGroup({
    name: 'First shared', agentKinds: ['kimi'], workdir, allowWrite: true,
  })
  const second = workspace.createGroup({
    name: 'Second shared', agentKinds: ['kimi'], workdir, allowWrite: true,
  })

  const firstSend = workspace.sendMessage({ groupId: first.id, text: 'first', targetKinds: ['kimi'] })
  const secondSend = workspace.sendMessage({ groupId: second.id, text: 'second', targetKinds: ['kimi'] })
  await waitFor(() => calls === 2)
  release()
  await Promise.all([firstSend, secondSend])
  assert.equal(calls, 2)
  assert.equal(scheduler.snapshot().claimGrants.length, 0)
})
