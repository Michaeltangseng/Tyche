const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProjectStore } = require('../../src/project-room/project-store.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T00:00:00.000Z'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-project-corruption-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function storeFor(directory, options = {}) {
  return new ProjectStore({
    projectDir: directory,
    now: () => at,
    ...options,
  })
}

function corruptFiles(directory) {
  return fs.readdirSync(directory).filter(name => name.startsWith('state.corrupt-')).sort()
}

test('truncated JSON opens the project read-only and keeps an exact copy', async (t) => {
  const directory = fixture(t)
  const original = '{"schemaVersion":1,"projectId":"project-1"'
  fs.writeFileSync(path.join(directory, 'state.json'), original)
  const store = storeFor(directory)

  const state = await store.load()
  assert.equal(state, null)
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'corrupt')
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), original)

  const copies = corruptFiles(directory)
  assert.equal(copies.length, 1)
  assert.equal(fs.readFileSync(path.join(directory, copies[0]), 'utf8'), original)
  await assert.rejects(store.enqueue(next => ({ next })), {
    code: 'PROJECT_READ_ONLY',
  })
})

test('a schema failure opens the whole project read-only without partial records', async (t) => {
  const directory = fixture(t)
  const state = emptyProjectState({ projectId: 'project-1' })
  state.instances = [{ id: 'broken' }]
  const original = `${JSON.stringify(state)}\n`
  fs.writeFileSync(path.join(directory, 'state.json'), original)
  const store = storeFor(directory)

  const loaded = await store.load()
  assert.equal(loaded, null)
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'corrupt')
  assert.equal(store.current(), null)
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), original)
  assert.equal(corruptFiles(directory).length, 1)
})

test('an invalid schema version is treated as corruption', async (t) => {
  const directory = fixture(t)
  const original = `${JSON.stringify({
    schemaVersion: 'one', projectId: 'project-1',
  })}\n`
  fs.writeFileSync(path.join(directory, 'state.json'), original)
  const store = storeFor(directory)

  const state = await store.load()
  assert.equal(state, null)
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'corrupt')
  assert.equal(corruptFiles(directory).length, 1)
})

test('an unreadable state file opens read-only without a copy', async (t) => {
  const directory = fixture(t)
  fs.mkdirSync(path.join(directory, 'state.json'))
  const store = storeFor(directory)

  const state = await store.load()
  assert.equal(state, null)
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'unreadable')
  assert.equal(corruptFiles(directory).length, 0)
})

test('repeated corruption does not overwrite an earlier copy', async (t) => {
  const directory = fixture(t)
  fs.writeFileSync(path.join(directory, 'state.json'), '{"first":')
  await storeFor(directory).load()
  fs.writeFileSync(path.join(directory, 'state.json'), '{"second":')
  await storeFor(directory).load()

  const copies = corruptFiles(directory)
  assert.equal(copies.length, 2)
  const contents = copies.map(name => fs.readFileSync(path.join(directory, name), 'utf8')).sort()
  assert.deepEqual(contents, ['{"first":', '{"second":'])
})

test('a failed corrupt-copy write still leaves the project read-only', async (t) => {
  const directory = fixture(t)
  const original = '{"schemaVersion":1,"broken":'
  fs.writeFileSync(path.join(directory, 'state.json'), original)
  const store = storeFor(directory, {
    writeFile: () => { throw Object.assign(new Error('EIO'), { phase: 'before-commit' }) },
  })

  const state = await store.load()
  assert.equal(state, null)
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'corrupt')
  assert.equal(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'), original)
  assert.deepEqual(corruptFiles(directory), [])
})
