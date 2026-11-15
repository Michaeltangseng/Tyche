const assert = require('node:assert/strict')
const test = require('node:test')

const { CHANNELS, registerRoomIpc } = require('../../src/room-engine/room-ipc.cjs')

function setup() {
  const handlers = new Map()
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler) },
    removeHandler(channel) { handlers.delete(channel) },
  }
  const calls = []
  const service = new Proxy({}, { get: (_target, property) => (input) => { calls.push([property, input]); return { ok: true } } })
  return { handlers, calls, service, ipcMain }
}

test('room IPC exposes only narrow service operations and validates renderer access', async () => {
  const { handlers, calls, service, ipcMain } = setup()
  let trusted = 0
  const dispose = registerRoomIpc({ ipcMain, service, requireRenderer: () => { trusted += 1 } })
  assert.equal(handlers.size, Object.keys(CHANNELS).length)
  const result = await handlers.get(CHANNELS.submitMessage)({}, { chatId: 'chat-1', content: 'hello' })
  assert.deepEqual(result, { ok: true })
  assert.equal(calls[0][0], 'submitMessage')
  assert.equal(trusted, 1)
  await assert.rejects(handlers.get(CHANNELS.userCommand)({}, null), /ROOM_IPC_INPUT_INVALID/)
  dispose()
  assert.equal(handlers.size, 0)
})

test('room IPC blocks calls during shutdown', async () => {
  const { handlers, service, ipcMain } = setup()
  registerRoomIpc({ ipcMain, service, isShuttingDown: () => true })
  await assert.rejects(handlers.get(CHANNELS.submitMessage)({}, {}), /DESKTOP_CLIENT_SHUTTING_DOWN/)
})
