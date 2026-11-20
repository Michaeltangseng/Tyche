const test = require('node:test')
const assert = require('node:assert/strict')

const { CHANNELS, registerTeamRoomIpc } = require('../../src/shell/team-room-ipc.cjs')

function setup() {
  const handlers = new Map()
  const calls = []
  const host = new Proxy({}, {
    get(target, method) {
      if (!(method in target)) {
        target[method] = (...args) => {
          calls.push([method, ...args])
          return { method, args }
        }
      }
      return target[method]
    },
  })
  registerTeamRoomIpc({
    registerTrustedHandle(channel, handler) {
      handlers.set(channel, handler)
    },
    getHost: () => host,
  })
  return { handlers, calls }
}

test('registers every team-room channel', () => {
  const { handlers } = setup()
  assert.deepEqual([...handlers.keys()].sort(), Object.values(CHANNELS).sort())
})

test('forwards display-safe commands to the host', () => {
  const { handlers, calls } = setup()
  handlers.get(CHANNELS.bootstrap)({
    name: 'Room',
    workspace: '/tmp/room',
    providers: ['codex'],
    roles: [{ displayName: 'Captain', provider: 'codex', prompt: 'route', isCaptain: true }],
  })
  handlers.get(CHANNELS.snapshot)({ roomId: 'room-1', messageLimit: 50, includeCaptain: true })
  handlers.get(CHANNELS.chatMessages)({ roomId: 'room-1', chatId: 'chat-1', beforeSeq: 10, limit: 20 })
  handlers.get(CHANNELS.submitMessage)({
    roomId: 'room-1', chatId: 'chat-1', content: 'hello', clientId: 'c1',
  })
  handlers.get(CHANNELS.filesList)({ roomId: 'room-1', relPath: 'docs', cursor: '100' })
  handlers.get(CHANNELS.filesRead)({ roomId: 'room-1', relPath: 'docs/a.md', offset: 0, length: 1024 })
  handlers.get(CHANNELS.writeAuthorized)({ roomId: 'room-1', authorized: true })
  handlers.get(CHANNELS.runtimeEvents)({ roomId: 'room-1', chatId: 'chat-1', runId: 'run-1', limit: 10 })

  assert.deepEqual(calls.map(call => call[0]), [
    'bootstrap', 'snapshot', 'chatMessages', 'submitMessage',
    'filesList', 'filesRead', 'setWriteAuthorized', 'runtimeEvents',
  ])
})

test('rejects unknown fields, missing ids, and invalid cursors', () => {
  const { handlers } = setup()
  assert.throws(() => handlers.get(CHANNELS.snapshot)({ roomId: 'room-1', extra: true }), /TEAM_ROOM_INPUT_INVALID/)
  assert.throws(() => handlers.get(CHANNELS.chatMessages)({ roomId: 'room-1' }), /TEAM_ROOM_INPUT_INVALID/)
  assert.throws(() => handlers.get(CHANNELS.snapshot)({ roomId: 'room-1', messageLimit: 0 }), /TEAM_ROOM_INPUT_INVALID/)
  assert.throws(() => handlers.get(CHANNELS.filesRead)({
    roomId: 'room-1', relPath: 'a', length: 512 * 1024 + 1,
  }), /TEAM_ROOM_INPUT_INVALID/)
  assert.throws(() => handlers.get(CHANNELS.writeAuthorized)({
    roomId: 'room-1', authorized: 'yes',
  }), /TEAM_ROOM_INPUT_INVALID/)
})

test('reports an unavailable host instead of throwing a raw TypeError', () => {
  const handlers = new Map()
  registerTeamRoomIpc({
    registerTrustedHandle(channel, handler) { handlers.set(channel, handler) },
    getHost: () => null,
  })
  assert.throws(() => handlers.get(CHANNELS.listRooms)(), /TEAM_ROOM_UNAVAILABLE/)
})
