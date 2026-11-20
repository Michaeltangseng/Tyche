const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createTimeline } = require('../../src/room/timeline.cjs')
const { createOutbox } = require('../../src/room/effects.cjs')
const { createTaskQueue } = require('../../src/room/task-queue.cjs')
const { createSettlement } = require('../../src/room/settlement.cjs')
const { createRoomReadModel } = require('../../src/room/read-model.cjs')

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-read-model-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'Room', workspace: directory, providers: ['claude'] })
  const chatId = repo.createChat({ roomId, title: 'Chat' })
  const captainRoleId = repo.createRole({
    chatId, displayName: 'Captain', provider: 'claude', prompt: 'route', isCaptain: true,
  })
  const workerRoleId = repo.createRole({
    chatId, displayName: 'Worker', provider: 'claude', prompt: 'work',
  })
  repo.addParticipant({ chatId, roleId: captainRoleId })
  repo.addParticipant({ chatId, roleId: workerRoleId })
  const timeline = createTimeline({ roomDb, repository: repo })
  const outbox = createOutbox({ roomDb, repository: repo })
  const queue = createTaskQueue({ roomDb, repository: repo, timeline, outbox })
  const settlement = createSettlement({ roomDb, repository: repo, timeline })

  const user = timeline.append({
    chatId, authorType: 'user', authorId: 'user', content: '@Worker hi', status: 'done',
  })
  timeline.append({
    chatId, authorType: 'agent', authorId: workerRoleId, content: 'ok', status: 'done',
  })
  timeline.append({
    chatId, authorType: 'agent', authorId: workerRoleId, content: 'tool run', status: 'done',
    data: { activity: [{ name: 'Bash', input: '/private/path' }], thinking: 'deliberate' },
  })
  const reviewRow = timeline.append({
    chatId, authorType: 'system', authorId: 'system', kind: 'captain_review', content: 'review body',
    audience: 'captain', status: 'done',
  })
  const reviewReply = timeline.append({
    chatId, authorType: 'agent', authorId: captainRoleId, content: 'captain reply',
    audience: 'captain', status: 'done', data: { reviewReply: true },
  })

  const task = queue.createTask({
    chatId, roleId: workerRoleId, title: 'T', description: 'D', acceptance: 'A',
  })
  const run = queue.listRuns(task.taskId)[0]
  roomDb.database.prepare("UPDATE task_runs SET status = 'running', started_at = 't' WHERE id = ?").run(run.id)
  settlement.claim({ runId: run.id, taskId: task.taskId, status: 'ready', summary: 'done', artifactIds: ['artifact-1'] })
  settlement.settle({
    runId: run.id,
    exit: { observed: true, code: 0 },
    snapshot: { state: 'not_applicable' },
  })
  roomDb.database.prepare(`
    INSERT INTO attentions (id, chat_id, task_id, type, question, options_json, status, requested_by, created_at)
    VALUES (?, ?, ?, 'run_failed', 'Check the task', '[]', 'open', 'system', 't')
  `).run(crypto.randomUUID(), chatId, task.taskId)
  const assignmentId = crypto.randomUUID()
  roomDb.database.prepare(`
    INSERT INTO captain_assignments
      (id, chat_id, message_id, root_message_id, target_role_ids_json, target_reply_ids_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 't')
  `).run(
    assignmentId, chatId, reviewRow.id, reviewRow.id,
    JSON.stringify([workerRoleId]), JSON.stringify([reviewReply.id]),
  )
  roomDb.database.prepare(`
    INSERT INTO captain_reviews
      (id, chat_id, assignment_id, kind, dedupe_key, checkpoint_seq, status, body, data_json, created_at, updated_at)
    VALUES (?, ?, ?, 'assignment_settled', ?, 2, 'pending', 'observation', '{}', 't', 't')
  `).run(crypto.randomUUID(), chatId, assignmentId, `${chatId}:assignment_settled:2`)

  return { directory, roomDb, repo, roomId, chatId, captainRoleId, workerRoleId, timeline, task, user, reviewRow, reviewReply }
}

test('snapshot is display-safe and public by default', t => {
  const context = setup(t)
  const model = createRoomReadModel({ roomDb: context.roomDb })
  const snapshot = model.snapshot({ roomId: context.roomId, messageLimit: 10 })

  assert.equal(snapshot.room.workspace, undefined)
  assert.equal(snapshot.room.workspace_label, path.basename(context.directory))
  assert.equal(snapshot.room.primary_chat_id, context.chatId)
  assert.equal(snapshot.chats[0].id, context.chatId)
  assert.equal(snapshot.roles.length, 2)
  assert.equal(snapshot.roles.find(role => role.id === context.captainRoleId).is_captain, true)
  assert.equal(snapshot.roles.find(role => role.id === context.workerRoleId).prompt, 'work')

  assert.equal(snapshot.messages.some(message => message.audience === 'captain'), false)
  assert.equal(snapshot.messages.some(message => message.content === 'captain reply'), false)
  const activity = snapshot.messages.find(message => message.content === 'tool run')
  assert.equal(activity.sequence > 0, true)
  assert.equal(activity.data.activity, undefined)
  assert.equal(activity.data.thinking, 'deliberate')

  assert.equal(snapshot.tasks.length, 1)
  assert.equal(snapshot.tasks[0].assignee_name, 'Worker')
  assert.equal(snapshot.runs[0].lane_kind, 'executor')
  assert.equal(snapshot.runs[0].workspace_ref, undefined)
  assert.equal(snapshot.runs[0].session_id, undefined)
  assert.equal(snapshot.reports[0].kind, 'ready')
  assert.deepEqual(snapshot.reports[0].artifact_ids, ['artifact-1'])
  assert.equal(snapshot.attentions[0].type, 'run_failed')
  assert.equal(snapshot.reviews[0].kind, 'assignment_settled')
  assert.equal(snapshot.reviews[0].body, undefined)
  assert.equal(snapshot.assignments[0].target_role_ids[0], context.workerRoleId)
  context.roomDb.close()
})

test('snapshot can include captain rows and reports older pages', t => {
  const context = setup(t)
  const model = createRoomReadModel({ roomDb: context.roomDb })
  const all = model.snapshot({ roomId: context.roomId, messageLimit: 10, includeCaptain: true })
  assert.equal(all.messages.some(message => message.content === 'captain reply'), true)
  assert.equal(all.messages.some(message => message.content === 'review body'), false)

  const page = model.snapshot({ roomId: context.roomId, messageLimit: 2 })
  assert.equal(page.messages.length, 2)
  assert.deepEqual(page.messages_have_older, [context.chatId])

  const older = model.chatMessages({
    chatId: context.chatId,
    beforeSeq: page.messages.at(-1).sequence,
    limit: 1,
  })
  assert.equal(older.hasMore, true)
  assert.equal(older.messages[0].sequence, 3)
  context.roomDb.close()
})

test('listRooms exposes a label and chats, not the absolute workspace', t => {
  const context = setup(t)
  const model = createRoomReadModel({ roomDb: context.roomDb })
  const rooms = model.listRooms()
  assert.equal(rooms.length, 1)
  assert.equal(rooms[0].id, context.roomId)
  assert.equal(rooms[0].workspace, undefined)
  assert.equal(typeof rooms[0].workspace_label, 'string')
  assert.equal(rooms[0].chat_count, 1)
  assert.equal(rooms[0].chats[0].id, context.chatId)
  context.roomDb.close()
})

test('snapshot includes the room artifact ledger without absolute paths', t => {
  const context = setup(t)
  const at = new Date().toISOString()
  context.roomDb.database.prepare(`
    INSERT INTO artifacts (id, room_id, task_id, run_id, path, kind, version, status, created_at, updated_at)
    VALUES ('artifact-1', ?, NULL, NULL, 'docs/room.md', 'document', 'v1', 'published', ?, ?)
  `).run(context.roomId, at, at)
  const model = createRoomReadModel({ roomDb: context.roomDb })
  const snapshot = model.snapshot({ roomId: context.roomId })
  assert.deepEqual(snapshot.artifacts, [{
    id: 'artifact-1',
    task_id: null,
    run_id: null,
    path: 'docs/room.md',
    kind: 'document',
    version: 'v1',
    status: 'published',
    created_at: at,
    updated_at: at,
  }])
  assert.equal(JSON.stringify(snapshot.artifacts).includes(context.roomId), false)
  context.roomDb.close()
})

test('display text replaces the absolute room workspace path', t => {
  const context = setup(t)
  context.timeline.append({
    chatId: context.chatId,
    authorType: 'agent',
    authorId: context.workerRoleId,
    content: `wrote ${context.directory}/docs/room.md`,
    status: 'done',
  })
  const model = createRoomReadModel({ roomDb: context.roomDb })
  const snapshot = model.snapshot({ roomId: context.roomId, messageLimit: 20 })
  const message = snapshot.messages.find(item => item.content.includes('docs/room.md'))
  assert.equal(message.content.includes(context.directory), false)
  assert.equal(message.content, `wrote ${path.basename(context.directory)}/docs/room.md`)
  context.roomDb.close()
})

test('a reply snapshot keeps settled token usage and drops private usage fields', t => {
  const context = setup(t)
  context.timeline.append({
    chatId: context.chatId,
    authorType: 'agent',
    authorId: context.workerRoleId,
    content: 'usage reply',
    status: 'done',
    data: {
      usage: {
        inputTokens: 14920,
        outputTokens: 790,
        cachedInputTokens: 29824,
        context: { tokens: 15497, contextWindow: 1000000, percent: 2 },
        sessionId: 'secret',
      },
      activity: [{ name: 'Bash', input: context.directory }],
    },
  })
  const model = createRoomReadModel({ roomDb: context.roomDb })
  const snapshot = model.snapshot({ roomId: context.roomId, messageLimit: 20 })
  const message = snapshot.messages.find(item => item.content === 'usage reply')
  assert.deepEqual(message.data.usage, {
    inputTokens: 14920,
    outputTokens: 790,
    cachedInputTokens: 29824,
    context: { tokens: 15497, contextWindow: 1000000, percent: 2 },
  })
  assert.equal(JSON.stringify(message.data).includes('secret'), false)
  assert.equal(JSON.stringify(message.data).includes(context.directory), false)
  context.roomDb.close()
})
