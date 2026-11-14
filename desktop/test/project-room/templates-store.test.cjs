const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  BUILTIN_TEMPLATE_ID,
  TemplatesStore,
  builtinTemplate,
} = require('../../src/project-room/templates-store.cjs')

const at = '2026-01-01T00:00:00.000Z'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-templates-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function storagePath(directory) {
  return path.join(directory, 'meldwork-private', 'templates.json')
}

function checkpointDef(key = 'requirements') {
  return {
    key,
    name: 'Requirements',
    type: 'document',
    targetFiles: ['docs/requirements.md'],
    leadSeatId: 'seat-lead',
    reviewerSeatIds: ['seat-reviewer'],
    draftSeatIds: [],
    gate: 'hard',
    roundLimit: 3,
    continuationLimit: 3,
    producesChecklist: false,
    dependsOn: [],
  }
}

function seatTemplates() {
  return [
    {
      key: 'seat-lead',
      roleName: 'Lead',
      duty: 'Write.',
      agentKind: 'codex',
      capabilities: ['read', 'write-workdir'],
      profileText: 'Write a complete draft.',
    },
    {
      key: 'seat-reviewer',
      roleName: 'Reviewer',
      duty: 'Review.',
      agentKind: 'claude',
      capabilities: ['read'],
      profileText: 'Find contradictions.',
    },
  ]
}

function storeFor(directory, options = {}) {
  return new TemplatesStore({
    storagePath: storagePath(directory),
    now: () => at,
    createId: () => 'template-1',
    ...options,
  })
}

test('a missing file loads empty templates and exposes the built-in placeholder', async (t) => {
  const directory = fixture(t)
  const store = storeFor(directory)
  assert.deepEqual(await store.load(), [])
  assert.equal(store.isReadOnly(), false)

  const builtin = store.builtin()
  assert.equal(builtin.id, BUILTIN_TEMPLATE_ID)
  assert.equal(builtin.source, 'builtin')
  assert.equal(builtin.checkpointDefs.length, 1)
  assert.equal(builtin.seatTemplates.length, 2)
  assert.deepEqual(store.get(BUILTIN_TEMPLATE_ID), builtin)
  builtin.checkpointDefs[0].name = 'Changed'
  assert.equal(store.builtin().checkpointDefs[0].name, 'Requirements')
})

test('save, update, and rollback form new versions and keep older ones', async (t) => {
  const directory = fixture(t)
  let nextId = 0
  const store = storeFor(directory, { createId: () => `template-${nextId += 1}` })
  await store.load()

  const saved = await store.save({
    name: 'Template A',
    checkpointDefs: [checkpointDef()],
    seatTemplates: seatTemplates(),
  })
  assert.equal(saved.id, 'template-1')
  assert.equal(saved.version, 1)
  assert.equal(saved.source, 'user-saved')
  assert.equal(store.list().length, 1)
  assert.equal(store.versions('template-1').length, 1)

  const updated = await store.update({
    id: 'template-1',
    name: 'Template B',
    checkpointDefs: [checkpointDef('requirements-v2')],
  })
  assert.equal(updated.version, 2)
  assert.equal(updated.name, 'Template B')
  assert.equal(updated.checkpointDefs[0].key, 'requirements-v2')
  assert.deepEqual(updated.seatTemplates, seatTemplates())
  assert.equal(store.versions('template-1').length, 2)
  assert.equal(store.get('template-1', 1).name, 'Template A')
  assert.equal(store.get('template-1').version, 2)
  assert.equal(store.list().length, 1)

  const rolledBack = await store.rollback({ id: 'template-1', version: 1 })
  assert.equal(rolledBack.version, 3)
  assert.equal(rolledBack.source, 'rollback')
  assert.equal(rolledBack.name, 'Template A')
  assert.equal(rolledBack.checkpointDefs[0].key, 'requirements')
  assert.equal(store.get('template-1').version, 3)
  assert.equal(store.get('template-1').name, 'Template A')

  const savedFile = JSON.parse(fs.readFileSync(storagePath(directory), 'utf8'))
  assert.equal(savedFile.schemaVersion, 1)
  assert.deepEqual(savedFile.templates.map(item => item.version), [1, 2, 3])
})

test('a corrupt file opens read-only and keeps the original bytes', async (t) => {
  const directory = fixture(t)
  const filename = storagePath(directory)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, '{"schemaVersion":1,"templates":[')
  const store = storeFor(directory)

  assert.deepEqual(await store.load(), [])
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'corrupt')
  assert.equal(fs.readFileSync(filename, 'utf8'), '{"schemaVersion":1,"templates":[')
  await assert.rejects(store.save({
    name: 'Template', checkpointDefs: [checkpointDef()], seatTemplates: seatTemplates(),
  }), { code: 'PROJECT_READ_ONLY' })
})

test('a newer schema version opens read-only', async (t) => {
  const directory = fixture(t)
  const filename = storagePath(directory)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, '{"schemaVersion":2,"templates":[]}')
  const store = storeFor(directory)

  assert.deepEqual(await store.load(), [])
  assert.equal(store.isReadOnly(), true)
  assert.equal(store.readOnlyReason(), 'schema-version-newer')
})

test('invalid template input is rejected before writing', async (t) => {
  const directory = fixture(t)
  const store = storeFor(directory)
  await store.load()

  const cases = [
    { name: 'x'.repeat(81), checkpointDefs: [checkpointDef()], seatTemplates: seatTemplates() },
    { name: 'Template', checkpointDefs: [], seatTemplates: seatTemplates() },
    {
      name: 'Template',
      checkpointDefs: [checkpointDef()],
      seatTemplates: [{ ...seatTemplates()[0], capabilities: ['teleport'] }],
    },
    {
      name: 'Template',
      checkpointDefs: [checkpointDef()],
      seatTemplates: [{ ...seatTemplates()[0], extra: true }],
    },
  ]
  for (const input of cases) {
    await assert.rejects(store.save(input), (error) => {
      assert.equal(error.code, 'PROJECT_INPUT_INVALID')
      assert.ok(error.details.issues.length > 0)
      return true
    })
  }
  assert.deepEqual(store.list(), [])
  assert.equal(fs.existsSync(storagePath(directory)), false)
})

test('update and rollback reject unknown templates', async (t) => {
  const directory = fixture(t)
  const store = storeFor(directory)
  await store.load()

  await assert.rejects(store.update({ id: 'missing', name: 'X' }), (error) => {
    assert.equal(error.code, 'PROJECT_INPUT_INVALID')
    assert.equal(error.details.reason, 'template-not-found')
    return true
  })
  await assert.rejects(store.rollback({ id: 'missing', version: 1 }), (error) => {
    assert.equal(error.code, 'PROJECT_INPUT_INVALID')
    assert.equal(error.details.reason, 'template-version-not-found')
    return true
  })
})

test('the built-in placeholder is a valid template record', async (t) => {
  const directory = fixture(t)
  const store = storeFor(directory)
  await store.load()
  const builtin = builtinTemplate()
  const saved = await store.save({
    name: builtin.name,
    checkpointDefs: builtin.checkpointDefs,
    seatTemplates: builtin.seatTemplates,
  })
  assert.equal(saved.version, 1)
  assert.doesNotThrow(() => fs.readFileSync(storagePath(directory), 'utf8'))
})
