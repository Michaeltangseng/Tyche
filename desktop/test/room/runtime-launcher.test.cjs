const assert = require('node:assert/strict')
const test = require('node:test')
const { createOarRuntimeAdapter, selectRoomRuntime } = require('../../src/room/runtime-adapter.cjs')

test('selectRoomRuntime uses the registry and rejects a missing launcher', () => {
  const pi = { id: 'pi' }
  const registry = { get: id => (id === 'pi' ? pi : undefined) }
  assert.equal(selectRoomRuntime(registry, 'pi'), pi)
  assert.throws(
    () => selectRoomRuntime(registry, 'hermes'),
    error => error.code === 'ROOM_RUNTIME_UNSUPPORTED'
      && /no launcher for "hermes"/.test(error.message),
  )
})

test('adapter reports launcher ids after OAR loads', async () => {
  const adapter = createOarRuntimeAdapter({
    roomDb: { database: { prepare: () => ({ get: () => null }) } },
    repository: {},
    timeline: {},
    sessions: {},
    dispatcher: {},
    loadOar: async () => ({
      defaultRuntimes: {
        list: () => [{ id: 'claude' }, { id: 'pi' }],
        get: () => undefined,
      },
    }),
  })
  assert.equal(adapter.launchProviderIds(), null)
  for (let i = 0; i < 10 && adapter.launchProviderIds() === null; i += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.deepEqual(adapter.launchProviderIds(), ['claude', 'pi'])
  assert.equal(adapter.hasLauncher('pi'), true)
  assert.equal(adapter.hasLauncher('hermes'), false)
})
