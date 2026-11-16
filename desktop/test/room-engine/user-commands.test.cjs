const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { openRoomDatabase } = require('../../src/room-engine/room-db.cjs')
const { createRoomRepository } = require('../../src/room-engine/room-repository.cjs')
const { createUserCommandService } = require('../../src/room-engine/user-commands.cjs')
const { validateUserCommand, validateControllerAction } = require('../../src/room-engine/room-actions.cjs')

test('workspace grant is canonical, replay-safe, Room-wide and transactional', t => {
  const s = setup()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-write-grant-'))
  t.after(() => { s.roomDb.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const roomId = s.repository.getChatContext(s.chatId).chat.room_id
  s.roomDb.database.prepare('UPDATE rooms SET workspace=? WHERE id=?').run(root, roomId)
  const command = { type: 'set_workspace_write', chatId: s.chatId, allowWrite: true, commandId: 'grant' }
  const authorizedRoot = () => s.repository.getRoomSnapshot(roomId).room.write_authorized_root
  assert.equal(authorizedRoot(), null)
  assert.equal(s.commands.apply(command).writeAuthorizedRoot, fs.realpathSync.native(root))
  assert.equal(s.commands.apply(command).duplicate, true)
  assert.throws(() => s.commands.apply({ ...command, allowWrite: false }), /COMMAND_ID_REUSED/)
  assert.throws(() => validateUserCommand({ ...command, allowWrite: 'true' }), /ALLOW_WRITE_INVALID/)
  assert.throws(() => validateUserCommand({ ...command, writeAuthorizedRoot: root }), /UNKNOWN_FIELD/)
  assert.throws(() => validateControllerAction(command), /TYPE_INVALID/)
  const otherChat = s.repository.createChat({ roomId, title: 'Other team' })
  const roleId = s.repository.createAgentRole({ chatId: otherChat, displayName: 'Writer', provider: 'codex', createdBy: 'user' })
  const taskId = s.repository.createTask({ chatId: otherChat, objective: 'Write', createdBy: 'user' })
  const assignmentId = s.repository.createAssignment({ taskId, roleId, status: 'running' })
  const revoke = { ...command, allowWrite: false, commandId: 'revoke' }
  assert.throws(() => s.commands.apply(revoke), /PERMISSION_BUSY/)
  s.roomDb.database.prepare("UPDATE assignments SET status='waiting', outcome='unknown' WHERE id=?").run(assignmentId)
  assert.throws(() => s.commands.apply(revoke), /PERMISSION_BUSY/)
  s.roomDb.database.prepare("UPDATE assignments SET status='ready', outcome='ready' WHERE id=?").run(assignmentId)
  const original = s.repository.appendEvent
  s.repository.appendEvent = () => { throw new Error('audit failed') }
  assert.throws(() => s.commands.apply(revoke), /audit failed/)
  assert.equal(authorizedRoot(), fs.realpathSync.native(root))
  s.repository.appendEvent = original
  s.commands.apply(revoke)
  assert.equal(authorizedRoot(), null)
})

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-user-command-'))
  const roomDb = openRoomDatabase({ directory })
  const repository = createRoomRepository(roomDb)
  const roomId = repository.createRoom({ name: 'Demo', workspace: '/tmp/demo' })
  const chatId = repository.createChat({ roomId, title: 'Chat' })
  const attentionId = repository.createAttention({ chatId, type: 'decision', question: 'Accept?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], requestedBy: 'controller' })
  const artifactId = repository.createArtifact({ roomId, path: 'docs/draft.md', kind: 'document', version: 'v1' })
  return { roomDb, repository, chatId, attentionId, artifactId, commands: createUserCommandService({ roomDb, repository }) }
}

test('user can answer an open attention and the command is audited', () => {
  const { roomDb, commands, chatId, attentionId } = setup()
  const result = commands.apply({ type: 'answer_attention', chatId, attentionId, optionId: 'yes', comment: 'Looks good' }, { actorId: 'user-1' })
  assert.equal(result.resolution.optionId, 'yes')
  const row = roomDb.database.prepare('SELECT status, answered_by FROM attentions WHERE id = ?').get(attentionId)
  assert.equal(row.status, 'answered')
  assert.equal(row.answered_by, 'user-1')
  assert.equal(roomDb.database.prepare('SELECT type FROM events WHERE id = ?').get(result.event.eventId).type, 'user_answer_attention')
  roomDb.close()
})

test('artifact decisions and chat pause/resume update platform-owned state', () => {
  const { roomDb, commands, chatId, artifactId } = setup()
  assert.equal(commands.apply({ type: 'accept_artifact', chatId, artifactId }).status, 'accepted')
  assert.equal(commands.apply({ type: 'pause_chat', chatId }).status, 'paused')
  assert.equal(commands.apply({ type: 'resume_chat', chatId }).status, 'active')
  assert.equal(roomDb.database.prepare('SELECT status FROM artifacts WHERE id = ?').get(artifactId).status, 'accepted')
  roomDb.close()
})

test('user can revise a role prompt with an idempotent command', () => {
  const state = setup()
  const roleId = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user' })
  const command = { type: 'update_role_prompt', chatId: state.chatId, roleId, prompt: 'Write concise English reports.', commandId: 'prompt-1' }
  const first = state.commands.apply(command)
  const second = state.commands.apply(command)
  assert.equal(first.revision, 1)
  assert.equal(second.duplicate, true)
  assert.equal(state.repository.getRolePrompt(roleId).prompt, 'Write concise English reports.')
  assert.throws(() => state.commands.apply({ ...command, prompt: 'different' }), /COMMAND_ID_REUSED/)
  state.roomDb.close()
})

test('user can update role metadata and prompt in one idempotent command', () => {
  const state = setup()
  const roleId = state.repository.createAgentRole({
    chatId: state.chatId, displayName: 'Writer', responsibilities: 'Write docs',
    capabilities: ['read'], provider: 'codex', createdBy: 'user',
  })
  const command = {
    type: 'update_role', chatId: state.chatId, roleId, commandId: 'role-1',
    displayName: 'Editor', responsibilities: 'Edit and publish docs',
    capabilities: ['read', 'write-drafts'], provider: 'claude', prompt: 'Edit carefully.',
  }
  const first = state.commands.apply(command, { actorId: 'user-1' })
  assert.equal(first.displayName, 'Editor')
  assert.equal(first.provider, 'claude')
  assert.deepEqual(first.capabilities, ['read', 'write-drafts'])
  assert.equal(first.promptRevision.revision, 1)
  const row = state.roomDb.database.prepare('SELECT * FROM agent_roles WHERE id = ?').get(roleId)
  assert.equal(row.display_name, 'Editor')
  assert.equal(row.responsibilities, 'Edit and publish docs')
  assert.equal(row.provider, 'claude')
  assert.deepEqual(JSON.parse(row.capabilities_json), ['read', 'write-drafts'])
  assert.equal(state.repository.getRolePrompt(roleId).prompt, 'Edit carefully.')
  const second = state.commands.apply(command, { actorId: 'user-1' })
  assert.equal(second.duplicate, true)
  assert.equal(state.roomDb.database.prepare('SELECT COUNT(*) AS count FROM role_prompt_revisions WHERE role_id = ?').get(roleId).count, 1)
  assert.throws(() => state.commands.apply({ ...command, prompt: 'different' }, { actorId: 'user-1' }), /COMMAND_ID_REUSED/)
  state.roomDb.close()
})

test('user can create a role with a prompt and replay the command safely', () => {
  const state = setup()
  const roomId = state.repository.getChatContext(state.chatId).chat.room_id
  state.roomDb.database.prepare('UPDATE rooms SET providers_json = ? WHERE id = ?').run(JSON.stringify(['codex']), roomId)
  const command = {
    type: 'create_role', chatId: state.chatId, commandId: 'create-role-1',
    displayName: 'Reviewer', provider: 'codex', responsibilities: 'Review changes',
    capabilities: ['read'], prompt: 'Review carefully.', isController: true,
  }
  const first = state.commands.apply(command, { actorId: 'user-1' })
  assert.ok(first.roleId)
  assert.equal(first.isController, true)
  const role = state.roomDb.database.prepare('SELECT * FROM agent_roles WHERE id = ?').get(first.roleId)
  assert.equal(role.display_name, 'Reviewer')
  assert.equal(role.created_by, 'user-1')
  assert.equal(role.creation_reason, 'user_created')
  assert.equal(role.is_controller, 1)
  assert.deepEqual(JSON.parse(role.capabilities_json), ['read'])
  assert.equal(state.repository.getRolePrompt(first.roleId).prompt, 'Review carefully.')
  const second = state.commands.apply(command, { actorId: 'user-1' })
  assert.equal(second.duplicate, true)
  assert.equal(second.roleId, first.roleId)
  assert.throws(() => state.commands.apply({ ...command, prompt: 'different' }, { actorId: 'user-1' }), /COMMAND_ID_REUSED/)
  assert.throws(() => state.commands.apply({
    type: 'create_role', chatId: state.chatId, commandId: 'create-role-2', displayName: 'Bad', provider: 'claude',
  }), /PROVIDER_NOT_ALLOWED/)
  state.roomDb.close()
})

test('retry can attach write scopes only after workspace authorization', () => {
  const state = setup()
  const roomId = state.repository.getChatContext(state.chatId).chat.room_id
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-retry-write-'))
  state.roomDb.database.prepare('UPDATE rooms SET workspace = ? WHERE id = ?').run(root, roomId)
  const roleId = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user' })
  const taskId = state.repository.createTask({ chatId: state.chatId, objective: 'Write file', createdBy: 'user' })
  const source = state.repository.createAssignment({ taskId, roleId, status: 'waiting', runId: 'run-write-1' })
  state.repository.appendEvent({ roomId, chatId: state.chatId, actorId: 'supervisor', type: 'session_exited',
    payload: { assignmentId: source, runId: 'run-write-1' } })
  const base = { type: 'retry_task', chatId: state.chatId, taskId, assignmentId: source, writeScopes: ['.'] }
  assert.throws(() => state.commands.apply({ ...base, commandId: 'retry-write-1' }), /WRITE_NOT_AUTHORIZED/)
  state.commands.apply({ type: 'set_workspace_write', chatId: state.chatId, allowWrite: true, commandId: 'grant-write' })
  const retried = state.commands.apply({ ...base, commandId: 'retry-write-2' })
  assert.deepEqual(JSON.parse(state.repository.getAssignmentContext(retried.assignmentId).write_scopes_json), ['.'])
  state.roomDb.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('user can move the chat controller flag between roles', () => {
  const state = setup()
  const first = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'First', provider: 'codex', createdBy: 'user' })
  const second = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'Second', provider: 'claude', createdBy: 'user' })
  state.commands.apply({ type: 'update_role', chatId: state.chatId, roleId: first, commandId: 'controller-1', isController: true })
  const controllerFlag = roleId => state.roomDb.database.prepare('SELECT is_controller FROM agent_roles WHERE id = ?').get(roleId).is_controller
  assert.equal(controllerFlag(first), 1)
  assert.equal(controllerFlag(second), 0)
  state.commands.apply({ type: 'update_role', chatId: state.chatId, roleId: second, commandId: 'controller-2', isController: true })
  assert.equal(controllerFlag(first), 0)
  assert.equal(controllerFlag(second), 1)
  state.commands.apply({ type: 'update_role', chatId: state.chatId, roleId: second, commandId: 'controller-3', isController: false })
  assert.equal(controllerFlag(second), 0)
  state.roomDb.close()
})

test('user can delete an unused role but not one with assignment history', () => {
  const state = setup()
  const roleId = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'Temporary', provider: 'codex', createdBy: 'user' })
  const command = { type: 'delete_role', chatId: state.chatId, roleId, commandId: 'delete-role-1' }
  const first = state.commands.apply(command)
  assert.equal(first.deleted, true)
  assert.equal(state.roomDb.database.prepare('SELECT id FROM agent_roles WHERE id = ?').get(roleId), undefined)
  assert.equal(state.commands.apply(command).duplicate, true)
  const usedRole = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'Used', provider: 'codex', createdBy: 'user' })
  const taskId = state.repository.createTask({ chatId: state.chatId, objective: 'Work', createdBy: 'user' })
  state.repository.createAssignment({ taskId, roleId: usedRole })
  assert.throws(() => state.commands.apply({
    type: 'delete_role', chatId: state.chatId, roleId: usedRole, commandId: 'delete-role-2',
  }), /ROLE_IN_USE/)
  state.roomDb.close()
})

test('role metadata update rejects a provider outside the room and provider changes while busy', () => {
  const state = setup()
  const roomId = state.repository.getChatContext(state.chatId).chat.room_id
  state.roomDb.database.prepare('UPDATE rooms SET providers_json = ? WHERE id = ?').run(JSON.stringify(['codex']), roomId)
  const roleId = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'Writer', provider: 'codex', createdBy: 'user' })
  assert.throws(() => state.commands.apply({
    type: 'update_role', chatId: state.chatId, roleId, commandId: 'role-provider', provider: 'claude',
  }), /PROVIDER_NOT_ALLOWED/)
  const busyRoleId = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'Reviewer', provider: 'claude', createdBy: 'user' })
  const taskId = state.repository.createTask({ chatId: state.chatId, objective: 'Write', createdBy: 'user' })
  state.repository.createAssignment({ taskId, roleId: busyRoleId, status: 'running' })
  assert.throws(() => state.commands.apply({
    type: 'update_role', chatId: state.chatId, roleId: busyRoleId, commandId: 'role-busy', provider: 'codex',
  }), /ROLE_BUSY/)
  state.commands.apply({
    type: 'update_role', chatId: state.chatId, roleId, commandId: 'role-name', displayName: 'Editor',
  })
  assert.equal(state.roomDb.database.prepare('SELECT display_name FROM agent_roles WHERE id = ?').get(roleId).display_name, 'Editor')
  state.roomDb.close()
})

test('invalid attention option and unsupported lifecycle command are rejected', () => {
  const { roomDb, commands, chatId, attentionId } = setup()
  assert.throws(() => commands.apply({ type: 'answer_attention', chatId, attentionId, optionId: 'maybe' }), /OPTION_INVALID/)
  assert.throws(() => commands.apply({ type: 'archive_chat', chatId }), /UNSUPPORTED/)
  roomDb.close()
})

test('retry and handoff create linked attempts with replay-safe command IDs', () => {
  const state = setup()
  const roleId = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'Backend', provider: 'codex', createdBy: 'user' })
  const targetRoleId = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'Reviewer', provider: 'pi', createdBy: 'user' })
  const taskId = state.repository.createTask({ chatId: state.chatId, objective: 'Build', createdBy: 'user' })
  const source = state.repository.createAssignment({ taskId, roleId, status: 'failed', required: false, writeScopes: ['src/'] })
  const command = { type: 'retry_task', chatId: state.chatId, taskId, assignmentId: source, commandId: 'retry-1' }
  const retried = state.commands.apply(command)
  assert.equal(retried.attempt, 2)
  const replayed = state.commands.apply({ ...command })
  assert.equal(replayed.assignmentId, retried.assignmentId)
  assert.equal(replayed.duplicate, true)
  assert.throws(() => state.commands.apply({ ...command, reason: 'different' }), /COMMAND_ID_REUSED/)
  assert.throws(() => state.commands.apply({ ...command, commandId: 'another-retry' }), /ALREADY_REPLACED/)
  const retryRow = state.repository.getAssignmentContext(retried.assignmentId)
  assert.equal(retryRow.required, 0)
  assert.deepEqual(JSON.parse(retryRow.write_scopes_json), ['src/'])
  state.roomDb.database.prepare("UPDATE assignments SET status = 'blocked' WHERE id = ?").run(retried.assignmentId)
  const handed = state.commands.apply({ type: 'handoff_task', chatId: state.chatId, taskId, assignmentId: retried.assignmentId, roleId: targetRoleId, commandId: 'handoff-1' })
  const handoffRow = state.repository.getAssignmentContext(handed.assignmentId)
  assert.equal(handoffRow.attempt, 3)
  assert.equal(handoffRow.previous_assignment_id, retried.assignmentId)
  assert.equal(handoffRow.role_id, targetRoleId)
  assert.equal(state.repository.getAssignmentContext(source).status, 'failed')
  state.roomDb.close()
})

test('retry rejects active work, unresolved recovery, foreign roles and missing process exit', () => {
  const state = setup()
  const roleId = state.repository.createAgentRole({ chatId: state.chatId, displayName: 'Backend', provider: 'codex', createdBy: 'user' })
  const taskId = state.repository.createTask({ chatId: state.chatId, objective: 'Build', createdBy: 'user' })
  const assignmentId = state.repository.createAssignment({ taskId, roleId, status: 'running', runId: 'run-1' })
  const command = { type: 'retry_task', chatId: state.chatId, taskId, assignmentId, commandId: 'retry' }
  assert.throws(() => state.commands.apply(command), /NOT_RETRYABLE/)
  state.roomDb.database.prepare("UPDATE assignments SET status = 'waiting', outcome = 'unknown' WHERE id = ?").run(assignmentId)
  assert.throws(() => state.commands.apply(command), /RECOVERY_UNRESOLVED/)
  state.roomDb.database.prepare("UPDATE assignments SET outcome = 'waiting' WHERE id = ?").run(assignmentId)
  assert.throws(() => state.commands.apply(command), /PROCESS_NOT_EXITED/)
  const roomId = state.repository.getChatContext(state.chatId).chat.room_id
  state.repository.appendEvent({ roomId, chatId: state.chatId, actorId: 'supervisor', type: 'session_exited', payload: { assignmentId, runId: 'run-1' } })
  const otherChatId = state.repository.createChat({ roomId, title: 'Other' })
  const foreign = state.repository.createAgentRole({ chatId: otherChatId, displayName: 'Foreign', provider: 'pi', createdBy: 'user' })
  assert.throws(() => state.commands.apply({ ...command, type: 'handoff_task', roleId: foreign }), /ROLE_INACTIVE/)
  assert.throws(() => state.commands.apply({ ...command, chatId: otherChatId }), /ASSIGNMENT_NOT_FOUND/)
  assert.equal(state.repository.listAssignments(taskId).length, 1)
  state.roomDb.close()
})
