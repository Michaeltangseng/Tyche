const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { LocalSkillCatalog } = require('../../src/skills/local-skill-catalog.cjs')
const { SkillLibrary } = require('../../src/skills/skill-library.cjs')

function writeNativeSkill(home, agentDirectory, name, description, body) {
  const directory = path.join(home, agentDirectory, 'skills', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
    '',
  ].join('\n'))
  return directory
}

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-skill-library-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  writeNativeSkill(home, '.claude', 'pptx', 'Create presentations', 'Use the pptx workflow.')
  writeNativeSkill(home, '.codex', 'documents', 'Edit documents', '# Documents\n')
  const catalog = new LocalSkillCatalog({ home })
  const storageRoot = path.join(home, 'store')
  const library = new SkillLibrary({
    storagePath: path.join(storageRoot, 'skill-library.json'),
    legacyPath: path.join(storageRoot, 'skill-inventory.json'),
    libraryRoot: path.join(home, 'library'),
    backupRoot: path.join(home, 'backups'),
    trashRoot: path.join(home, 'trash'),
    home,
    catalog,
  })
  return { catalog, home, library, storageRoot }
}

function findSkill(library, id) {
  return library.list().skills.find(skill => skill.id === id)
}

test('native Skills are listed read-only and cannot be selected by a role', (t) => {
  const { library } = setup(t)
  const listed = library.list()
  assert.deepEqual(listed.agents.sort(), ['claude', 'codex'])
  const pptx = findSkill(library, 'claude/global/pptx')
  assert.ok(pptx)
  assert.equal(pptx.source, 'native')
  assert.equal(pptx.originKind, 'claude')
  assert.equal(pptx.trust, undefined)
  assert.equal(pptx.canEdit, undefined)
  assert.throws(
    () => library.assertSelectable('claude', ['claude/global/pptx']),
    /SKILL_SELECTION_INVALID/,
  )
})

test('creating a platform Skill makes it selectable and injectable', (t) => {
  const { library } = setup(t)
  const created = library.create({
    name: 'deck',
    description: 'Build decks',
    body: 'Follow the deck workflow.',
  })
  assert.equal(created.id, 'shared/library/deck')
  assert.equal(findSkill(library, 'shared/library/deck').source, 'shared')
  assert.deepEqual(library.assertSelectable('claude', ['shared/library/deck']), ['shared/library/deck'])
  const materialized = library.materialize('codex', ['shared/library/deck'])
  assert.equal(materialized.skills.length, 1)
  assert.equal(materialized.skills[0].delivery, 'prompt')
  assert.match(materialized.skills[0].body, /deck workflow/)
  assert.equal(fs.existsSync(path.join(library.libraryRoot, 'deck', '.tyche-provenance.json')), true)
})

test('updating a platform Skill keeps it usable and changes its hash', (t) => {
  const { library } = setup(t)
  const created = library.create({ name: 'deck', description: 'Build decks', body: 'One.' })
  const updated = library.update({ id: created.id, body: 'Two.' })
  assert.notEqual(updated.contentHash, created.contentHash)
  assert.deepEqual(library.assertSelectable('claude', [created.id]), [created.id])
  assert.match(library.materialize('claude', [created.id]).skills[0].body, /Two\./)
})

test('removing a platform Skill moves it to trash and drops defaults', (t) => {
  const { library } = setup(t)
  const created = library.create({ name: 'deck', description: 'Build decks', body: 'Body.' })
  library.rememberDefault('claude', [created.id])
  assert.deepEqual(library.loadStore().defaults.claude, [created.id])
  assert.throws(() => library.remove({ id: created.id, confirmName: 'wrong' }), /SKILL_CONFIRM_MISMATCH/)
  assert.deepEqual(library.remove({ id: created.id, confirmName: 'deck' }), { removed: true })
  assert.equal(findSkill(library, created.id), undefined)
  assert.deepEqual(library.loadStore().defaults.claude, [])
  assert.equal(fs.existsSync(path.join(library.libraryRoot, 'deck')), false)
})

test('defaults only keep platform Skills', (t) => {
  const { library } = setup(t)
  const created = library.create({ name: 'deck', description: 'Build decks', body: 'Body.' })
  library.rememberDefault('claude', [created.id])
  assert.deepEqual(library.defaults('claude'), [created.id])
  assert.throws(
    () => library.rememberDefault('claude', ['claude/global/pptx']),
    /SKILL_SELECTION_INVALID/,
  )
})

test('a v1 inventory migrates only defaults', (t) => {
  const { home, storageRoot } = setup(t)
  fs.mkdirSync(storageRoot, { recursive: true })
  fs.writeFileSync(path.join(storageRoot, 'skill-inventory.json'), JSON.stringify({
    schemaVersion: 1,
    trust: { 'claude/global/pptx': { contentHash: 'a'.repeat(64), trustedAt: new Date().toISOString() } },
    eligibility: { 'claude/global/pptx': ['claude'] },
    defaults: { claude: ['claude/global/pptx'] },
  }))
  const catalog = new LocalSkillCatalog({ home })
  const library = new SkillLibrary({
    storagePath: path.join(storageRoot, 'skill-library.json'),
    legacyPath: path.join(storageRoot, 'skill-inventory.json'),
    libraryRoot: path.join(home, 'library-2'),
    backupRoot: path.join(home, 'backups-2'),
    trashRoot: path.join(home, 'trash-2'),
    home,
    catalog,
  })
  library.loadStore()
  const store = JSON.parse(fs.readFileSync(path.join(storageRoot, 'skill-library.json'), 'utf8'))
  assert.equal(store.schemaVersion, 3)
  assert.deepEqual(store.defaults, { claude: ['claude/global/pptx'] })
  assert.equal(store.trust, undefined)
  assert.equal(store.projections, undefined)
  assert.equal(fs.existsSync(path.join(storageRoot, 'skill-inventory.json.bak')), true)
})

test('a v2 store drops trust, policy and projections on load', (t) => {
  const { home, storageRoot } = setup(t)
  fs.mkdirSync(storageRoot, { recursive: true })
  fs.writeFileSync(path.join(storageRoot, 'skill-library.json'), JSON.stringify({
    schemaVersion: 2,
    policy: { untrustedByDefault: true, revokeOnChange: true, denySkillNetwork: false },
    sources: {},
    releases: {},
    skills: {},
    approvedHashes: { [String('a'.repeat(64))]: { approvedAt: new Date().toISOString() } },
    projections: { 'proj-1': { skillId: 'shared/library/x' } },
    defaults: { claude: ['shared/library/x'] },
  }))
  const catalog = new LocalSkillCatalog({ home })
  const library = new SkillLibrary({
    storagePath: path.join(storageRoot, 'skill-library.json'),
    legacyPath: path.join(storageRoot, 'skill-inventory.json'),
    libraryRoot: path.join(home, 'library-3'),
    backupRoot: path.join(home, 'backups-3'),
    trashRoot: path.join(home, 'trash-3'),
    home,
    catalog,
  })
  const store = library.loadStore()
  assert.equal(store.schemaVersion, 3)
  assert.deepEqual(store.defaults, { claude: ['shared/library/x'] })
  assert.equal(store.policy, undefined)
  assert.equal(store.approvedHashes, undefined)
  assert.equal(store.projections, undefined)
  const persisted = JSON.parse(fs.readFileSync(path.join(storageRoot, 'skill-library.json'), 'utf8'))
  assert.equal(persisted.schemaVersion, 3)
  assert.equal(persisted.policy, undefined)
})
