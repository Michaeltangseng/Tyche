const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createRoomHost } = require('../../src/room/room-host.cjs')

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-room-host-'))
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
  assert.ok(snapshot.roles[0].prompt.length > 0)
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

test('runtime events are scoped to a chat in the room', (t) => {
  const { workspace, host } = createHost(t)
  const created = host.bootstrap({ name: 'Trace', workspace, providers: ['codex'] })
  assert.deepEqual(host.runtimeEvents({ roomId: created.roomId, chatId: created.chatId }), [])
  assert.throws(
    () => host.runtimeEvents({ roomId: created.roomId, chatId: 'missing' }),
    /ROOM_CHAT_NOT_FOUND/,
  )
})
