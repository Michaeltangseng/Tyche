const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createRoomHost, PREVIOUS_CAPTAIN_PROMPT } = require('../../src/room/room-host.cjs')

function fakeAdapter() {
  return {
    start() {
      throw new Error('runtime must not start in this test')
    },
    startTaskRun() {
      throw new Error('runtime must not start in this test')
    },
    async disposeAll() {},
  }
}

function createHost(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-room-host-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const host = createRoomHost({
    privateRoot: path.join(root, 'private'),
    adapterFactory: () => fakeAdapter(),
    liveness: false,
  })
  t.after(() => host.close())
  return { root, workspace, host }
}

test('the production host assembles the OAR adapter by default', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-room-host-oar-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const host = createRoomHost({
    privateRoot: path.join(root, 'private'),
    liveness: false,
  })
  t.after(() => host.close())
  assert.equal(typeof host.service.adapter.start, 'function')
  assert.equal(typeof host.service.adapter.startTaskRun, 'function')
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'src', 'room', 'tyche-runtime-wrapper.sh')), true)
  await host.start()
})

test('bootstrap creates a display-safe room with a default captain', async (t) => {
  const { root, workspace, host } = createHost(t)
  const created = host.bootstrap({
    name: 'Alpha room',
    workspace,
    providers: ['codex'],
    title: 'Main chat',
  })

  assert.equal(typeof created.roomId, 'string')
  assert.equal(typeof created.chatId, 'string')

  const rooms = host.listRooms()
  assert.equal(rooms.length, 1)
  assert.equal(rooms[0].name, 'Alpha room')
  assert.equal(rooms[0].workspace_label, 'workspace')
  assert.equal(rooms[0].primary_chat_id, created.chatId)
  assert.equal(rooms[0].write_authorized, false)
  assert.equal(JSON.stringify(rooms).includes(root), false)

  const snapshot = host.snapshot({ roomId: created.roomId })
  assert.equal(snapshot.chats.length, 1)
  assert.equal(snapshot.roles.length, 1)
  assert.equal(snapshot.roles[0].display_name, 'Captain')
  assert.equal(snapshot.roles[0].is_captain, true)
  assert.equal(snapshot.roles[0].native_permission, 'danger-full-access')
  assert.match(snapshot.roles[0].prompt, /create_roles/)
  assert.equal(JSON.stringify(snapshot).includes(workspace), false)

  await host.start()
})

test('bootstrap honours explicit roles and a single captain', (t) => {
  const { workspace, host } = createHost(t)
  assert.throws(() => host.bootstrap({
    name: 'Two captains',
    workspace,
    providers: ['claude'],
    roles: [
      { displayName: 'A', provider: 'claude', prompt: 'a', isCaptain: true },
      { displayName: 'B', provider: 'claude', prompt: 'b', isCaptain: true },
    ],
  }), /ROOM_ROLE_CAPTAIN_CONFLICT/)

  assert.throws(() => host.bootstrap({
    name: 'Wrong provider',
    workspace,
    providers: ['claude'],
    roles: [{ displayName: 'A', provider: 'codex', prompt: 'a' }],
  }), /ROOM_ROLE_PROVIDER_NOT_ALLOWED/)

  assert.throws(() => host.bootstrap({
    name: 'Relative workspace',
    workspace: 'relative/path',
    providers: ['claude'],
  }), /TEAM_ROOM_WORKSPACE_INVALID/)

  const created = host.bootstrap({
    name: 'Explicit',
    workspace,
    providers: ['claude', 'codex'],
    roles: [
      { displayName: 'Captain', provider: 'claude', prompt: 'route', isCaptain: true },
      { displayName: 'Worker', provider: 'codex', prompt: 'work' },
    ],
  })
  const snapshot = host.snapshot({ roomId: created.roomId })
  assert.deepEqual(snapshot.roles.map(role => role.display_name), ['Captain', 'Worker'])
  assert.deepEqual(snapshot.roles.map(role => role.is_captain), [true, false])
})

test('a new chat clones the primary roles and chat deletion is guarded', (t) => {
  const { workspace, host } = createHost(t)
  const created = host.bootstrap({
    name: 'Rooms',
    workspace,
    providers: ['codex'],
    roles: [
      { displayName: 'Captain', provider: 'codex', prompt: 'route', isCaptain: true },
      { displayName: 'Worker', provider: 'codex', prompt: 'work' },
    ],
  })

  const second = host.createChat({ roomId: created.roomId, title: 'Research' })
  const snapshot = host.snapshot({ roomId: created.roomId })
  assert.equal(snapshot.chats.length, 2)
  const secondRoles = snapshot.roles.filter(role => role.chat_id === second.chatId)
  assert.deepEqual(secondRoles.map(role => role.display_name), ['Captain', 'Worker'])
  assert.deepEqual(secondRoles.map(role => role.is_captain), [true, false])

  assert.throws(
    () => host.deleteChat({ roomId: created.roomId, chatId: created.chatId }),
    /ROOM_PRIMARY_CHAT_UNDELETABLE/,
  )
  assert.deepEqual(host.deleteChat({ roomId: created.roomId, chatId: second.chatId }), {
    deleted: true,
    chatId: second.chatId,
  })
  assert.equal(host.snapshot({ roomId: created.roomId }).chats.length, 1)
})

test('messages are queued without exposing the runtime and chat pages stay scoped', (t) => {
  const { workspace, host } = createHost(t)
  const created = host.bootstrap({
    name: 'Chat',
    workspace,
    providers: ['codex'],
  })

  const result = host.submitMessage({
    roomId: created.roomId,
    chatId: created.chatId,
    content: 'Hello team',
    clientId: 'client-1',
  })
  assert.equal(result.message.content, 'Hello team')
  assert.equal(result.replies.length, 1)
  assert.equal(result.replies[0].status, 'queued')

  const replay = host.submitMessage({
    roomId: created.roomId,
    chatId: created.chatId,
    content: 'Hello team',
    clientId: 'client-1',
  })
  assert.equal(replay.message.id, result.message.id)

  const page = host.chatMessages({ roomId: created.roomId, chatId: created.chatId })
  assert.equal(page.messages[0].content, 'Hello team')
  assert.equal(page.messages[0].author_type, 'user')
  assert.equal(page.messages[1].status, 'queued')
  assert.equal(page.hasMore, false)

  assert.throws(() => host.chatMessages({
    roomId: created.roomId,
    chatId: 'missing-chat',
  }), /ROOM_CHAT_NOT_FOUND/)
})

test('files are read from the room workspace without renderer paths', async (t) => {
  const { workspace, host } = createHost(t)
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'hello room\n')
  const created = host.bootstrap({ name: 'Files', workspace, providers: ['codex'] })

  const listing = await host.filesList({ roomId: created.roomId, relPath: '' })
  assert.ok(listing.entries.some(entry => entry.name === 'note.txt'))
  assert.equal(JSON.stringify(listing).includes(workspace), false)

  const read = await host.filesRead({ roomId: created.roomId, relPath: 'note.txt' })
  assert.equal(read.kind, 'text')
  assert.equal(read.text, 'hello room\n')

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-room-upload-'))
  const outside = path.join(outsideDir, 'upload-note.txt')
  fs.writeFileSync(outside, 'brought in\n')
  const imported = await host.importWorkspaceFiles({ roomId: created.roomId, sources: [outside] })
  assert.deepEqual(imported, { files: [{ name: 'upload-note.txt' }] })
  assert.equal(fs.readFileSync(path.join(workspace, 'upload-note.txt'), 'utf8'), 'brought in\n')
  assert.equal(JSON.stringify(imported).includes(workspace), false)

  await assert.rejects(
    () => host.filesRead({ roomId: created.roomId, relPath: '../outside.txt' }),
    /ROOM_FILE_PATH_REJECTED/,
  )

  assert.deepEqual(host.setWriteAuthorized({ roomId: created.roomId, authorized: true }), {
    roomId: created.roomId,
    authorized: true,
  })
  assert.equal(host.snapshot({ roomId: created.roomId }).room.write_authorized, true)
  assert.deepEqual(host.setWriteAuthorized({ roomId: created.roomId, authorized: false }), {
    roomId: created.roomId,
    authorized: false,
  })
})

test('roles can be created, updated, and deleted while unused', (t) => {
  const { workspace, host } = createHost(t)
  const created = host.bootstrap({ name: 'Roles', workspace, providers: ['codex', 'claude'] })

  const worker = host.createRole({
    roomId: created.roomId,
    chatId: created.chatId,
    displayName: 'Writer',
    provider: 'codex',
    prompt: 'Write the document.',
    isCaptain: false,
    nativePermission: 'workspace-write',
  })
  let snapshot = host.snapshot({ roomId: created.roomId })
  assert.deepEqual(snapshot.roles.map(role => role.display_name), ['Captain', 'Writer'])

  assert.throws(() => host.createRole({
    roomId: created.roomId,
    chatId: created.chatId,
    displayName: 'Second Captain',
    provider: 'claude',
    prompt: 'route',
    isCaptain: true,
  }), /ROOM_ROLE_CAPTAIN_CONFLICT/)

  host.updateRole({
    roomId: created.roomId,
    roleId: worker.roleId,
    displayName: 'Reviewer',
    prompt: 'Review the document.',
  })
  snapshot = host.snapshot({ roomId: created.roomId })
  const updated = snapshot.roles.find(role => role.id === worker.roleId)
  assert.equal(updated.display_name, 'Reviewer')
  assert.equal(updated.prompt, 'Review the document.')
  assert.equal(updated.prompt_revision, 2)

  assert.deepEqual(host.deleteRole({ roomId: created.roomId, roleId: worker.roleId }), {
    deleted: true,
    roomId: created.roomId,
    roleId: worker.roleId,
  })
  assert.equal(host.snapshot({ roomId: created.roomId }).roles.length, 1)
})

test('attention answers are idempotent and append a system message', (t) => {
  const { workspace, host } = createHost(t)
  const created = host.bootstrap({ name: 'Attention', workspace, providers: ['codex'] })
  const attentionId = 'attention-1'
  host.roomDb.database.prepare(`
    INSERT INTO attentions (id, chat_id, task_id, type, question, options_json, status, requested_by, created_at)
    VALUES (?, ?, NULL, 'effect_unknown', 'Check the write', '[]', 'open', 'system', ?)
  `).run(attentionId, created.chatId, new Date().toISOString())

  assert.deepEqual(host.answerAttention({
    roomId: created.roomId,
    chatId: created.chatId,
    attentionId,
    resolution: 'The write did not land.',
    commandId: 'command-1',
  }), { attentionId, status: 'answered' })
  assert.deepEqual(host.answerAttention({
    roomId: created.roomId,
    chatId: created.chatId,
    attentionId,
    resolution: 'The write did not land.',
    commandId: 'command-1',
  }), { attentionId, status: 'answered' })

  const snapshot = host.snapshot({ roomId: created.roomId })
  assert.equal(snapshot.attentions.find(item => item.id === attentionId).status, 'answered')
  assert.ok(snapshot.messages.some(message => message.kind === 'attention_resolution'))
})

test('a room with running work cannot be deleted', (t) => {
  const { workspace, host } = createHost(t)
  const created = host.bootstrap({ name: 'Busy', workspace, providers: ['codex'] })
  host.submitMessage({
    roomId: created.roomId,
    chatId: created.chatId,
    content: 'Run this',
  })
  assert.throws(() => host.deleteRoom({ roomId: created.roomId }), /ROOM_ROOM_BUSY/)
  host.roomDb.database.prepare("UPDATE messages SET status = 'done' WHERE chat_id = ?").run(created.chatId)
  assert.deepEqual(host.deleteRoom({ roomId: created.roomId }), {
    deleted: true,
    roomId: created.roomId,
  })
})

test('live runtime events are sanitized before reaching the host observer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-room-host-events-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const events = []
  const adapter = {
    start({ onEvent }) {
      onEvent({ kind: 'text_delta', text: 'hello', seq: 1 })
      onEvent({ kind: 'usage', usage: { totalTokens: 12, context: { percent: 1 } }, seq: 2 })
      return {
        launch: Promise.resolve({ nativeSessionRef: 'session-1' }),
        completion: Promise.resolve({ status: 'done', text: 'hello', thinking: '', activity: [] }),
      }
    },
    startTaskRun() { throw new Error('not used') },
    async disposeAll() {},
  }
  const host = createRoomHost({
    privateRoot: path.join(root, 'private'),
    adapterFactory: () => adapter,
    liveness: false,
    onRuntimeEvent: payload => events.push(payload),
  })
  t.after(() => host.close())
  const created = host.bootstrap({ name: 'Events', workspace, providers: ['codex'] })
  host.submitMessage({ roomId: created.roomId, chatId: created.chatId, content: 'hi' })
  await host.service.startQueuedReplies({ chatId: created.chatId })

  assert.deepEqual(events.map(event => event.event.kind), ['text_delta', 'usage'])
  assert.equal(events[0].runId.startsWith('optimistic'), false)
  assert.equal(JSON.stringify(events).includes('session-1'), false)
  assert.equal(events[1].event.usage.totalTokens, 12)
})

test('runtime events are scoped to a chat in the room', (t) => {
  const { workspace, host } = createHost(t)
  const created = host.bootstrap({ name: 'Trace', workspace, providers: ['codex'] })
  assert.deepEqual(host.runtimeEvents({ roomId: created.roomId, chatId: created.chatId }), [])
  assert.throws(
    () => host.runtimeEvents({ roomId: created.roomId, chatId: 'missing' }),
    /ROOM_CHAT_NOT_FOUND/,
  )
})

test('captain and worker default prompts follow the role, including demotion', (t) => {
  const { workspace, host } = createHost(t)
  const created = host.bootstrap({
    name: 'Prompts',
    workspace,
    providers: ['codex', 'claude'],
    roles: [
      { displayName: 'Captain', provider: 'codex', prompt: '', isCaptain: true },
      { displayName: 'Worker', provider: 'claude', prompt: '', isCaptain: false },
    ],
  })
  let roles = host.snapshot({ roomId: created.roomId }).roles
  const captain = roles.find(role => role.is_captain)
  const worker = roles.find(role => !role.is_captain)
  assert.match(captain.prompt, /Do not create tasks yourself/)
  assert.match(worker.prompt, /create_task/)
  assert.doesNotMatch(worker.prompt, /Do not create tasks yourself/)

  host.updateRole({ roomId: created.roomId, roleId: captain.id, isCaptain: false })
  roles = host.snapshot({ roomId: created.roomId }).roles
  assert.match(roles.find(role => role.id === captain.id).prompt, /create_task/)

  host.updateRole({ roomId: created.roomId, roleId: worker.id, isCaptain: true })
  roles = host.snapshot({ roomId: created.roomId }).roles
  assert.match(roles.find(role => role.id === worker.id).prompt, /Do not create tasks yourself/)

  const extra = host.createRole({
    roomId: created.roomId,
    chatId: created.chatId,
    displayName: 'Extra',
    provider: 'codex',
  })
  const extraRole = host.snapshot({ roomId: created.roomId }).roles.find(role => role.id === extra.roleId)
  assert.match(extraRole.prompt, /create_task/)
})

test('startup upgrades a stock captain prompt and leaves a custom prompt alone', async (t) => {
  const { workspace, host } = createHost(t)
  const created = host.bootstrap({
    name: 'Stock captain',
    workspace,
    providers: ['codex'],
    roles: [
      { displayName: 'Captain', provider: 'codex', prompt: PREVIOUS_CAPTAIN_PROMPT, isCaptain: true },
      { displayName: 'Custom', provider: 'codex', prompt: 'Keep this prompt.', isCaptain: false },
    ],
  })
  await host.start()
  const roles = host.snapshot({ roomId: created.roomId }).roles
  assert.match(roles.find(role => role.is_captain).prompt, /create_roles/)
  assert.equal(roles.find(role => role.display_name === 'Custom').prompt, 'Keep this prompt.')
})

test('startup repairs the legacy captain prompt on a demoted role', async (t) => {
  const { workspace, host } = createHost(t)
  const legacy = [
    'You are the Captain of this chat.',
    'Use assign_in_group to give work to other roles, and post_in_chat for public updates.',
    'Do not create tasks yourself; the assigned role owns its task.',
    'Keep replies short and quote task numbers when useful.',
  ].join(' ')
  const created = host.bootstrap({
    name: 'Legacy prompts',
    workspace,
    providers: ['codex'],
    roles: [
      { displayName: 'Captain', provider: 'codex', prompt: 'route', isCaptain: true },
      { displayName: 'Legacy worker', provider: 'codex', prompt: legacy },
    ],
  })
  await host.start()
  const worker = host.snapshot({ roomId: created.roomId }).roles.find(role => role.display_name === 'Legacy worker')
  assert.match(worker.prompt, /create_task/)
  assert.doesNotMatch(worker.prompt, /Do not create tasks yourself/)
})

test('Captain swaps atomically and chat roles stay independent', (t) => {
  const { workspace, host } = createHost(t)
  const created = host.bootstrap({
    name: 'Independence',
    workspace,
    providers: ['codex', 'claude'],
    roles: [
      { displayName: 'Codex Captain', provider: 'codex', prompt: '', isCaptain: true },
      { displayName: 'Claude Worker', provider: 'claude', prompt: '', isCaptain: false },
    ],
  })
  const second = host.createChat({ roomId: created.roomId, title: 'Second' })
  const primaryRoles = host.snapshot({ roomId: created.roomId }).roles
  const codex = primaryRoles.find(role => role.display_name === 'Codex Captain')
  const claude = primaryRoles.find(role => role.display_name === 'Claude Worker')

  // Editing one chat's role must not rewrite the clone in another chat.
  host.updateRole({ roomId: created.roomId, roleId: claude.id, displayName: 'Claude Editor' })
  const secondRoles = host.snapshot({ roomId: created.roomId }).roles
    .filter(role => role.chat_id === second.chatId)
  assert.ok(secondRoles.some(role => role.display_name === 'Claude Worker'))
  assert.equal(secondRoles.some(role => role.display_name === 'Claude Editor'), false)

  // Swapping the Captain is one transaction: old captain demoted, prompts
  // adjusted, new captain promoted.
  const swapped = host.setCaptain({ roomId: created.roomId, roleId: claude.id })
  assert.equal(swapped.previousRoleId, codex.id)
  const roles = host.snapshot({ roomId: created.roomId }).roles
  assert.equal(roles.find(role => role.id === codex.id).is_captain, false)
  assert.equal(roles.find(role => role.id === claude.id).is_captain, true)
  assert.match(roles.find(role => role.id === codex.id).prompt, /create_task/)
  assert.match(roles.find(role => role.id === claude.id).prompt, /Do not create tasks yourself/)
})
