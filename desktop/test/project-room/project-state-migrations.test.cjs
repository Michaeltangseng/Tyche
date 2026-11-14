const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ProjectStore } = require('../../src/project-room/project-store.cjs')
const { MIGRATIONS } = require('../../src/project-room/project-state-migrations.cjs')
const { emptyProjectState } = require('../../src/project-room/project-state-schema.cjs')

const at = '2026-01-01T00:00:00.000Z'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-project-migrations-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function statePath(directory) {
  return path.join(directory, 'state.json')
}

function writeState(directory, value) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(statePath(directory), `${JSON.stringify(value)}\n`)
}

function migrate0to1(value) {
  const next = emptyProjectState({ projectId: value.projectId })
  next.config.configRevision = Number(value.marker) || 0
  return next
}

function storeFor(directory, options = {}) {
  return new ProjectStore({
    projectDir: directory,
    now: () => at,
    migrations: [migrate0to1],
    ...options,
  })
}

test('the current schema version has no migrations', () => {
  assert.deepEqual(MIGRATIONS, [])
})

test('a lower schema version is backed up, migrated, validated, and written back', async (t) => {
  const directory = fixture(t)
  const original = `${JSON.stringify({
    schemaVersion: 0, projectId: 'project-1', marker: 7,
  })}\n`
  fs.writeFileSync(statePath(directory), original)
  const store = storeFor(directory)

  const state = await store.load()
  assert.equal(state.schemaVersion, 1)
  assert.equal(state.config.configRevision, 7)
  assert.equal(store.isReadOnly(), false)

  const backup = fs.readFileSync(path.join(directory, 'state.v0.backup.json'), 'utf8')
  assert.equal(backup, original)
  const saved = JSON.parse(fs.readFileSync(statePath(directory), 'utf8'))
  assert.equal(saved.schemaVersion, 1)
  assert.equal(saved.config.configRevision, 7)

  const result = await store.enqueue((next) => {
    next.config.configRevision += 1
    return { next }
  })
  assert.equal(result.revision, 1)
  assert.equal(store.current().config.configRevision, 8)
})

test('a failing migration leaves the original file untouched and opens read-only', async (t) => {
  const directory = fixture(t)
  const original = `${JSON.stringify({
    schemaVersion: 0, projectId: 'project-1', marker: 7,
  })}\n`
  fs.writeFileSync(statePath(directory), original)
  const store = storeFor(directory, {
    migrations: [() => { throw new Error('migration-broken') }],
  })

  const state = await store.load()
  assert.equal(state, null)
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'migration-failed')
  assert.equal(fs.readFileSync(statePath(directory), 'utf8'), original)
  assert.equal(fs.existsSync(path.join(directory, 'state.v0.backup.json')), true)
  await assert.rejects(store.enqueue(next => ({ next })), {
    code: 'PROJECT_READ_ONLY',
  })
})

test('a migration that produces an invalid state opens read-only without writing', async (t) => {
  const directory = fixture(t)
  const original = `${JSON.stringify({
    schemaVersion: 0, projectId: 'project-1', marker: 7,
  })}\n`
  fs.writeFileSync(statePath(directory), original)
  const store = storeFor(directory, {
    migrations: [value => ({ schemaVersion: 1, projectId: value.projectId })],
  })

  const state = await store.load()
  assert.equal(state, null)
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'migration-failed')
  assert.equal(fs.readFileSync(statePath(directory), 'utf8'), original)
})

test('a schema version newer than this application opens read-only without a backup', async (t) => {
  const directory = fixture(t)
  const original = `${JSON.stringify({
    schemaVersion: 2, projectId: 'project-1',
  })}\n`
  fs.writeFileSync(statePath(directory), original)
  const store = storeFor(directory)

  const state = await store.load()
  assert.equal(state, null)
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'schema-version-newer')
  assert.equal(fs.readFileSync(statePath(directory), 'utf8'), original)
  assert.equal(fs.existsSync(path.join(directory, 'state.v0.backup.json')), false)
  assert.equal(fs.existsSync(path.join(directory, 'state.v2.backup.json')), false)
})

test('an existing migration backup is never overwritten', async (t) => {
  const directory = fixture(t)
  const original = `${JSON.stringify({
    schemaVersion: 0, projectId: 'project-1', marker: 7,
  })}\n`
  fs.writeFileSync(statePath(directory), original)
  const backupPath = path.join(directory, 'state.v0.backup.json')
  fs.writeFileSync(backupPath, 'keep-me')
  const store = storeFor(directory)

  await store.load()
  assert.equal(fs.readFileSync(backupPath, 'utf8'), 'keep-me')
})

test('a backup write failure stops the migration before touching state.json', async (t) => {
  const directory = fixture(t)
  const original = `${JSON.stringify({
    schemaVersion: 0, projectId: 'project-1', marker: 7,
  })}\n`
  fs.writeFileSync(statePath(directory), original)
  let calls = 0
  const writeFile = (filename, contents) => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('EIO'), { phase: 'before-commit' })
    fs.writeFileSync(filename, contents)
  }
  const store = storeFor(directory, { writeFile })

  const state = await store.load()
  assert.equal(state, null)
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'migration-failed')
  assert.equal(fs.readFileSync(statePath(directory), 'utf8'), original)
})

test('a migration write failure before commit keeps the original state file', async (t) => {
  const directory = fixture(t)
  const original = `${JSON.stringify({
    schemaVersion: 0, projectId: 'project-1', marker: 7,
  })}\n`
  fs.writeFileSync(statePath(directory), original)
  let calls = 0
  const writeFile = (filename, contents) => {
    calls += 1
    if (calls === 2) throw Object.assign(new Error('EIO'), { phase: 'before-commit' })
    fs.writeFileSync(filename, contents)
  }
  const store = storeFor(directory, { writeFile })

  const state = await store.load()
  assert.equal(state, null)
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'migration-failed')
  assert.equal(fs.readFileSync(statePath(directory), 'utf8'), original)
  assert.equal(fs.existsSync(path.join(directory, 'state.v0.backup.json')), true)
})

test('a migration write whose directory fsync fails adopts the migrated state without durability', async (t) => {
  const directory = fixture(t)
  writeState(directory, { schemaVersion: 0, projectId: 'project-1', marker: 7 })
  let calls = 0
  const writeFile = (filename, contents) => {
    calls += 1
    fs.writeFileSync(filename, contents)
    if (calls === 2) throw Object.assign(new Error('EIO'), { phase: 'after-commit' })
  }
  const store = storeFor(directory, { writeFile })

  const state = await store.load()
  assert.equal(state.schemaVersion, 1)
  assert.equal(store.isReadOnly(), false)
  assert.equal(store.getStorageFault().duringMigration, true)
  const saved = JSON.parse(fs.readFileSync(statePath(directory), 'utf8'))
  assert.equal(saved.schemaVersion, 1)
})
