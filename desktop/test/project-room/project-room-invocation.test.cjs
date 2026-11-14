const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { LocalWorkspace } = require('../../src/workspace/local-workspace.cjs')
const { projectRoomSessionKey } = require('../../src/workspace/local-workspace-context.cjs')
const { fixture } = require('../support/local-workspace-test-helpers.cjs')

async function setup(t, options = {}) {
  const { directory, options: workspaceOptions, calls } = fixture()
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  if (options.runAgent) workspaceOptions.runAgent = options.runAgent
  const workspace = new LocalWorkspace(workspaceOptions)
  await workspace.refreshAgents()
  const group = workspace.createGroup({
    name: 'Main',
    agentKinds: ['codex'],
    workdir: directory,
    allowWrite: options.allowWrite === true,
    projectId: 'project-1',
    projectRole: 'main',
  })
  const task = workspace.addMessage(group.id, 'user', 'Task')
  const contextPack = workspace.createContextPack({
    group, taskId: task.id, mode: 'manual', targetKinds: ['codex'], message: task,
  })
  const reservation = workspace.reserveRun(group.id, 'manual', ['codex'], task.id)
  workspace.bindRunTask(group.id, reservation, task.id, task.id, contextPack.contextPackId)
  const controller = workspace.beginRun(group.id, 'manual', ['codex'], task.id, reservation)
  return {
    workspace, group, task, contextPack, controller, calls, directory,
  }
}

test('project-room lead calls send the exact prompt and use the caller session key', async (t) => {
  const calls = []
  const { workspace, group, task, contextPack, controller } = await setup(t, {
    runAgent: async (agent, prompt, workdir, runOptions) => {
      calls.push({ agent, prompt, workdir, runOptions })
      return {
        text: 'Answer\n[[MELDWORK_CHECKPOINT:{"signal":"ready"}]]',
        sessionRef: 'native-1',
        outcome: 'completed',
      }
    },
  })
  const sessionKey = projectRoomSessionKey({
    projectId: 'project-1', checkpointId: 'cp-1', seatId: 'seat-1', kind: 'codex', generation: 0,
  })
  const prompt = 'Exact project-room prompt'
  const result = await workspace.invokeAgent(
    group, 'codex', 'manual', controller.signal, task.id,
    {
      taskId: task.id,
      sessionPolicy: 'project-room',
      promptOverride: prompt,
      contextPackId: contextPack.contextPackId,
      permissionMode: 'workspace-write',
      sessionKey,
      saveSession: true,
      deferMessage: true,
    },
  )
  await workspace.finishRun(group.id, controller, 'completed')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].prompt, prompt)
  assert.equal(calls[0].runOptions.sandbox, 'workspace-write')
  assert.equal(calls[0].prompt.includes('Final response scope:'), false)
  assert.equal(workspace.state.sessions[sessionKey], 'native-1')
  assert.equal(result.message, null)
})

test('project-room reviewer calls do not persist a session', async (t) => {
  const calls = []
  const { workspace, group, task, contextPack, controller } = await setup(t, {
    runAgent: async (agent, prompt, workdir, runOptions) => {
      calls.push({ prompt, runOptions })
      return {
        text: 'Review\n[[MELDWORK_REVIEW:{"verdict":"pass"}]]',
        sessionRef: 'review-session',
        outcome: 'completed',
      }
    },
  })
  const sessionKey = projectRoomSessionKey({
    projectId: 'project-1', checkpointId: 'cp-1', seatId: 'seat-2', kind: 'codex', generation: 3,
  })
  await workspace.invokeAgent(
    group, 'codex', 'manual', controller.signal, task.id,
    {
      taskId: task.id,
      sessionPolicy: 'project-room',
      promptOverride: 'Review prompt',
      contextPackId: contextPack.contextPackId,
      permissionMode: 'read-only',
      sessionKey,
      saveSession: false,
    },
  )
  await workspace.finishRun(group.id, controller, 'completed')

  assert.equal(calls[0].prompt, 'Review prompt')
  assert.equal(calls[0].runOptions.sandbox, 'read-only')
  assert.equal(Object.hasOwn(workspace.state.sessions, sessionKey), false)
  assert.equal(Object.hasOwn(workspace.state.sessionMeta, sessionKey), false)
})

test('the project-room session key hash includes project, checkpoint, seat, and generation', () => {
  const base = projectRoomSessionKey({
    projectId: 'p', checkpointId: 'c', seatId: 's', kind: 'codex', generation: 0,
  })
  assert.equal(base, 'project:p:cp:c:seat:s:codex:g0')
  const variants = [
    { projectId: 'p2' },
    { checkpointId: 'c2' },
    { seatId: 's2' },
    { generation: 1 },
  ]
  for (const variant of variants) {
    const key = projectRoomSessionKey({
      projectId: 'p', checkpointId: 'c', seatId: 's', kind: 'codex', generation: 0,
      ...variant,
    })
    assert.notEqual(key, base)
  }
  const long = projectRoomSessionKey({
    projectId: 'p'.repeat(120),
    checkpointId: 'c'.repeat(120),
    seatId: 's'.repeat(120),
    kind: 'codex',
    generation: 1,
  })
  assert.match(long, /^session:[a-f0-9]{64}$/)
})
