const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createReportImporter, parseReportMarker } = require('../../src/room-engine/report-importer.cjs')

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-report-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const roleId = repository.createAgentRole({ chatId, displayName: 'Backend', provider: 'codex', createdBy: 'user' })
  const taskId = repository.createTask({ chatId, objective: 'Implement API', createdBy: 'user' })
  const assignmentId = repository.createAssignment({ taskId, roleId })
  return { roomDb, repository, chatId, taskId, assignmentId, importer: createReportImporter({ roomDb, repository }) }
}

test('parseReportMarker accepts the strict machine marker and ignores prose', () => {
  const report = parseReportMarker('完成了接口实现\n[[MELDWORK_REPORT:{"kind":"ready","summary":"API ready","artifacts":["artifact-1"]}]]')
  assert.deepEqual(report, {
    reportId: undefined, kind: 'ready', summary: 'API ready', evidence: [], artifactIds: ['artifact-1'], nextRequest: null, attentionId: null,
  })
  assert.equal(parseReportMarker('还在处理中'), null)
})

test('import writes one report and report_received event transactionally', () => {
  const { roomDb, repository, importer, chatId, taskId, assignmentId } = setup()
  const result = importer.importFromMessage({
    chatId, taskId, assignmentId, actorId: 'agent-backend',
    content: '完成\n[[MELDWORK_REPORT:{"reportId":"report-1","kind":"ready","summary":"完成","evidence":["test"]}]]',
  })
  assert.equal(result.imported, true)
  assert.equal(result.report.id, 'report-1')
  assert.equal(repository.listEvents('room-does-not-exist').length, 0)
  const events = repository.listEvents(roomDb.database.prepare('SELECT room_id FROM chats WHERE id = ?').get(chatId).room_id)
  assert.equal(events.at(-1).type, 'report_received')
  assert.equal(events.at(-1).report_id, 'report-1')
  roomDb.close()
})

test('report import is idempotent and rejects assignment mismatch', () => {
  const { roomDb, importer, chatId, taskId, assignmentId } = setup()
  const input = { chatId, taskId, assignmentId, actorId: 'agent', content: 'done [[MELDWORK_REPORT:{"reportId":"same","kind":"ready","summary":"ok"}]]' }
  assert.equal(importer.importFromMessage(input).imported, true)
  assert.equal(importer.importFromMessage(input).duplicate, true)
  assert.throws(() => importer.importFromMessage({ ...input, taskId: 'task-other' }), /ROOM_REPORT_ASSIGNMENT_MISMATCH/)
  roomDb.close()
})

test('invalid report markers are rejected before persistence', () => {
  assert.throws(() => parseReportMarker('[[MELDWORK_REPORT:{"kind":"ready","summary":"ok","extra":true}]]'), /UNKNOWN_FIELD/)
  assert.throws(() => parseReportMarker('[[MELDWORK_REPORT:{"kind":"unknown","summary":"ok"}]]'), /KIND_INVALID/)
  assert.throws(() => parseReportMarker('[[MELDWORK_REPORT:{bad}]]'), /JSON_INVALID/)
})
