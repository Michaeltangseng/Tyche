const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const {
  createRoomActionService, validateControllerAction, validatePlatformTransition, validateUserCommand,
} = require('../../src/room-engine/room-actions.cjs')

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-actions-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  return { roomDb, repository, roomId, chatId }
}

test('action protocols keep controller, user, and platform types separate', () => {
  const base = { chatId: 'chat-1' }
  assert.equal(validateUserCommand({ ...base, type: 'stop_task', taskId: 'task-1', commandId: 'stop-1' }).type, 'stop_task')
  assert.equal(validatePlatformTransition({ ...base, type: 'session_liveness', assignmentId: 'a-1', observedAt: 'now', state: 'running' }).type, 'session_liveness')
  assert.throws(() => validateControllerAction({ ...base, type: 'stop_task', contextRevision: 1, taskId: 'task-1' }), /CONTROLLER_ACTION_TYPE_INVALID/)
  assert.throws(() => validateUserCommand({ ...base, type: 'stop_task', taskId: 'task-1', contextRevision: 1 }), /UNKNOWN_FIELD/)
})

test('controller action rejects stale context and unknown fields', () => {
  const action = { type: 'create_task', chatId: 'chat-1', contextRevision: 3, objective: 'Draft', kind: 'draft' }
  assert.equal(validateControllerAction(action, { contextRevision: 3 }).objective, 'Draft')
  assert.throws(() => validateControllerAction(action, { contextRevision: 2 }), /ROOM_ACTION_CONTEXT_STALE/)
  assert.throws(() => validateControllerAction({ ...action, debug: true }), /ROOM_ACTION_UNKNOWN_FIELD/)
})

test('controller create_task, assign, role, and attention actions become ledger facts', () => {
  const { roomDb, repository, roomId, chatId } = setup()
  const service = createRoomActionService({ roomDb, repository })
  const role = service.applyController({
    type: 'create_role', chatId, contextRevision: 0, displayName: 'Writer', provider: 'codex',
  }, { actorId: 'controller' })
  const task = service.applyController({
    type: 'create_task', chatId, contextRevision: 0, objective: 'Draft', kind: 'draft',
  })
  const assignment = service.applyController({
    type: 'assign', chatId, contextRevision: 0, taskId: task.taskId, roleId: role.roleId,
  })
  const attention = service.applyController({
    type: 'request_attention', chatId, contextRevision: 0, taskId: task.taskId,
    attentionType: 'approval', question: 'Accept?', options: [{ id: 'yes', label: 'Yes' }],
  })
  assert.equal(repository.getTask(task.taskId).created_by, 'controller')
  assert.equal(repository.listAssignments(task.taskId)[0].id, assignment.assignmentId)
  assert.equal(attention.attentionId.startsWith('attention-'), true)
  assert.equal(repository.listEvents(roomId).length, 4)
  roomDb.close()
})

test('controller cannot directly mark a task complete or stop a running task', () => {
  const { roomDb, repository, chatId } = setup()
  const service = createRoomActionService({ roomDb, repository })
  assert.throws(() => service.applyController({ type: 'update_task', chatId, contextRevision: 0, taskId: 'task-1', status: 'done' }), /CONTROLLER_ACTION_TYPE_INVALID/)
  assert.throws(() => service.applyController({ type: 'stop_task', chatId, contextRevision: 0, taskId: 'task-1' }), /CONTROLLER_ACTION_TYPE_INVALID/)
  roomDb.close()
})

test('dynamic roles persist prompt revisions and respect room capabilities', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-role-policy-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Policy', workspace: '/tmp/policy', providers: ['codex'], allowedCapabilities: ['text'] })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const service = createRoomActionService({ roomDb, repository })
  const role = service.applyController({
    type: 'create_role', chatId, contextRevision: 0, displayName: 'Writer', provider: 'codex', capabilities: ['text'],
  })
  const prompt = service.applyController({
    type: 'update_role_prompt', chatId, contextRevision: 0, roleId: role.roleId, prompt: 'Write concise drafts.',
  })
  assert.equal(prompt.prompt.revision, 1)
  assert.equal(repository.getRolePrompt(role.roleId).prompt, 'Write concise drafts.')
  assert.throws(() => service.applyController({
    type: 'create_role', chatId, contextRevision: 0, displayName: 'Image', provider: 'gemini', capabilities: ['text'],
  }), /PROVIDER_NOT_ALLOWED/)
  roomDb.close()
})

test('role retirement persists, preserves history and rejects future assignments and prompt updates', () => {
  const { roomDb, repository, chatId, roomId } = setup()
  const service = createRoomActionService({ roomDb, repository })
  const roleId = repository.createAgentRole({ chatId, displayName: 'Writer', provider: 'codex', createdBy: 'controller' })
  repository.createRolePromptRevision({ roleId, prompt: 'Original instructions', createdBy: 'controller' })
  const taskId = repository.createTask({ chatId, objective: 'Draft', createdBy: 'controller' })
  const assignmentId = repository.createAssignment({ taskId, roleId, status: 'completed' })
  const action = { type: 'archive_role', chatId, contextRevision: 0, roleId }
  const result = service.applyController(action)
  assert.equal(result.status, 'archived')
  assert.deepEqual(repository.listAgentRoles(chatId), [])
  assert.equal(repository.listAgentRoles(chatId, { includeArchived: true })[0].status, 'archived')
  assert.equal(repository.getRolePrompt(roleId).prompt, 'Original instructions')
  assert.equal(repository.listAssignments(taskId)[0].id, assignmentId)
  assert.throws(() => repository.createAssignment({ taskId, roleId }), /ROLE_INACTIVE/)
  assert.throws(() => service.applyController({ type: 'update_role_prompt', chatId, contextRevision: 0, roleId, prompt: 'Changed' }), /ROLE_NOT_FOUND/)
  assert.equal(repository.listEvents(roomId).filter(event => event.type === 'action_archive_role').length, 1)
  roomDb.close()
})

test('unfinished or unknown assignments prevent retirement without changing ledger facts', () => {
  for (const status of ['queued', 'running', 'waiting', 'blocked', 'unknown']) {
    const { roomDb, repository, roomId, chatId } = setup()
    const service = createRoomActionService({ roomDb, repository })
    const roleId = repository.createAgentRole({ chatId, displayName: 'Writer', provider: 'codex', createdBy: 'controller' })
    const taskId = repository.createTask({ chatId, objective: 'Draft', createdBy: 'controller' })
    const assignmentId = repository.createAssignment({ taskId, roleId, status: status === 'unknown' ? 'failed' : status })
    if (status === 'unknown') roomDb.database.prepare("UPDATE assignments SET outcome = 'unknown' WHERE id = ?").run(assignmentId)
    assert.throws(() => service.applyController({ type: 'archive_role', chatId, contextRevision: 0, roleId }), /UNFINISHED_ASSIGNMENTS/)
    assert.equal(repository.listAgentRoles(chatId)[0].status, 'active')
    assert.equal(repository.listEvents(roomId).length, 0)
    roomDb.close()
  }
})

test('controller cannot retire or update prompts of another chat role', () => {
  const { roomDb, repository, roomId, chatId } = setup()
  const service = createRoomActionService({ roomDb, repository })
  const otherChatId = repository.createChat({ roomId, title: 'Other' })
  const roleId = repository.createAgentRole({ chatId: otherChatId, displayName: 'Private', provider: 'codex', createdBy: 'controller' })
  for (const action of [{ type: 'archive_role' }, { type: 'update_role_prompt', prompt: 'Injected' }]) {
    assert.throws(() => service.applyController({ ...action, chatId, contextRevision: 0, roleId }), /ROLE_NOT_FOUND/)
  }
  assert.equal(repository.listAgentRoles(otherChatId)[0].prompt_revision, 0)
  assert.equal(repository.listEvents(roomId).length, 0)
  roomDb.close()
})
