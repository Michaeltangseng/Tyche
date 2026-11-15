const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createSessionSupervisor } = require('../../src/room-engine/session-supervisor.cjs')
const { createAssignmentRunner } = require('../../src/room-engine/assignment-runner.cjs')

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-runner-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const roleId = repository.createAgentRole({ chatId, displayName: 'Backend', provider: 'codex', createdBy: 'user' })
  const taskId = repository.createTask({ chatId, objective: 'Build API', createdBy: 'user' })
  const assignmentId = repository.createAssignment({ taskId, roleId })
  const supervisor = createSessionSupervisor({ roomDb, repository })
  return { roomDb, repository, roomId, chatId, taskId, assignmentId, supervisor }
}

test('assignment runner maps a queued assignment to invokeAgent and records exit without a report', async () => {
  const state = setup()
  let invocation
  const runner = createAssignmentRunner({
    repository: state.repository,
    supervisor: state.supervisor,
    resolveGroup: () => ({ id: 'legacy-group', workdir: '/tmp/demo' }),
    invokeAgent: async (...args) => { invocation = args; return { output: 'done' } },
  })
  const started = runner.start({ assignmentId: state.assignmentId, prompt: 'Build the API' })
  assert.equal(started.nativeSessionId, `room:${state.roomId}:${state.chatId}:${state.taskId}:${state.assignmentId}:1`)
  await started.promise
  assert.equal(invocation[0].id, 'legacy-group')
  assert.equal(invocation[1], 'codex')
  assert.equal(invocation[5].assignmentId, state.assignmentId)
  assert.ok(invocation[5].promptOverride.includes('Build the API'))
  assert.ok(invocation[5].promptOverride.includes('[[MELDWORK_REPORT:'))
  assert.match(invocation[5].contextPackId, /^context-pack-[a-f0-9]{64}$/)
  assert.equal(invocation[5].deferMessage, true)
  assert.equal(state.repository.getAssignmentContext(state.assignmentId).status, 'waiting')
  assert.equal(state.repository.listEvents(state.roomId).map(event => event.type).join(','), 'session_started,session_exited')
  state.roomDb.close()
})

test('assignment runner marks invocation failures and does not accept a second start', async () => {
  const state = setup()
  const runner = createAssignmentRunner({
    repository: state.repository,
    supervisor: state.supervisor,
    resolveGroup: () => ({ id: 'legacy-group', workdir: '/tmp/demo' }),
    invokeAgent: async () => { throw new Error('provider failed') },
  })
  await assert.rejects(runner.start({ assignmentId: state.assignmentId, prompt: 'Build' }).promise, /provider failed/)
  assert.equal(state.repository.getAssignmentContext(state.assignmentId).status, 'failed')
  assert.throws(() => runner.start({ assignmentId: state.assignmentId, prompt: 'Retry' }), /ROOM_ASSIGNMENT_NOT_QUEUED/)
  state.roomDb.close()
})

test('assignment runner imports a structured report returned by the Agent invocation', async () => {
  const state = setup()
  const runner = createAssignmentRunner({
    repository: state.repository,
    supervisor: state.supervisor,
    resolveGroup: () => ({ id: 'legacy-group', workdir: '/tmp/demo' }),
    importReport: input => require('../../src/room-engine/report-importer.cjs')
      .createReportImporter({ roomDb: state.roomDb, repository: state.repository })
      .importFromMessage(input),
    invokeAgent: async () => ({
      message: { content: 'done [[MELDWORK_REPORT:{"kind":"ready","summary":"API built"}]]' },
    }),
  })
  const result = await runner.start({ assignmentId: state.assignmentId, prompt: 'Build' }).promise
  assert.equal(result.roomReport.kind, 'ready')
  assert.equal(state.repository.getAssignmentContext(state.assignmentId).status, 'completed')
  assert.equal(state.repository.getReport(result.roomReport.id).summary, 'API built')
  state.roomDb.close()
})

test('malformed Worker report records an exited failure rather than leaving the assignment running', async () => {
  const state = setup()
  const runner = createAssignmentRunner({
    repository: state.repository, supervisor: state.supervisor,
    resolveGroup: () => ({ id: 'host' }),
    invokeAgent: async () => ({ pendingMessage: { content: '[[MELDWORK_REPORT:{invalid}]]' } }),
    importReport: require('../../src/room-engine/report-importer.cjs').createReportImporter(state).importFromMessage,
  })
  await assert.rejects(runner.start({ assignmentId: state.assignmentId, prompt: 'Build' }).promise, /MARKER_JSON_INVALID/)
  assert.equal(state.repository.getAssignmentContext(state.assignmentId).status, 'failed')
  assert.equal(state.repository.listEvents(state.roomId).at(-1).type, 'session_exited')
  state.roomDb.close()
})
