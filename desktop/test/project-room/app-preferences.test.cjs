const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { AppPreferencesStore } = require('../../src/project-room/app-preferences.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-app-preferences-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'app-preferences.json')
}

test('the preview flag defaults to off and persists once enabled', async (t) => {
  const storagePath = fixture(t)
  const store = new AppPreferencesStore({ storagePath })
  assert.deepEqual(await store.load(), { version: 1, projectRoomPreview: false })
  assert.equal(store.isProjectRoomEnabled(), false)

  assert.deepEqual(await store.set({ projectRoomPreview: true }), {
    version: 1,
    projectRoomPreview: true,
  })
  assert.equal(store.isProjectRoomEnabled(), true)

  const reloaded = new AppPreferencesStore({ storagePath })
  assert.deepEqual(await reloaded.load(), { version: 1, projectRoomPreview: true })
  assert.equal(reloaded.isProjectRoomEnabled(), true)
})

test('corrupt or unreadable preferences fall back to the disabled default', async (t) => {
  const storagePath = fixture(t)
  fs.writeFileSync(storagePath, '{"version":1,"projectRoomPreview":')
  const corrupt = new AppPreferencesStore({ storagePath })
  assert.equal((await corrupt.load()).projectRoomPreview, false)

  const directoryPath = path.join(path.dirname(storagePath), 'preferences-dir')
  fs.mkdirSync(directoryPath)
  const unreadable = new AppPreferencesStore({ storagePath: directoryPath })
  assert.equal((await unreadable.load()).projectRoomPreview, false)
})

test('invalid preference input is rejected without writing', async (t) => {
  const storagePath = fixture(t)
  const store = new AppPreferencesStore({ storagePath })
  await store.load()
  await assert.rejects(store.set({ projectRoomPreview: 'yes' }), {
    code: 'PROJECT_INPUT_INVALID',
  })
  await assert.rejects(store.set({ projectRoomPreview: true, extra: true }), {
    code: 'PROJECT_INPUT_INVALID',
  })
  assert.equal(fs.existsSync(storagePath), false)
})
