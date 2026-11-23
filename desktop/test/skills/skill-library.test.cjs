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
  return { catalog, home, library }
}

function findSkill(library, id) {
  return library.list().skills.find(skill => skill.id === id)
}

test('native skills start untrusted and only become selectable after trust and eligibility', (t) => {
  const { library } = setup(t)
  const listed = library.list()
  assert.deepEqual(listed.agents.sort(), ['claude', 'codex'])
  const pptx = findSkill(library, 'claude/global/pptx')
  assert.ok(pptx)
  assert.equal(pptx.trust, 'untrusted')
  assert.deepEqual(pptx.available, [])
  assert.throws(() => library.assertSelectable('claude', ['claude/global/pptx']), /SKILL_SELECTION_INVALID/)

  library.trust('claude/global/pptx')
  library.setEligible('claude/global/pptx', 'claude', true)
  const trusted = findSkill(library, 'claude/global/pptx')
  assert.equal(trusted.trust, 'trusted')
  assert.deepEqual(trusted.available, ['claude'])
  assert.deepEqual(library.assertSelectable('claude', ['claude/global/pptx']), ['claude/global/pptx'])
  assert.match(library.materialize('claude', ['claude/global/pptx']).skills[0].body, /pptx workflow/)
  assert.deepEqual(library.materialize('codex', ['claude/global/pptx']).skills, [])
  assert.throws(
    () => library.setEligible('claude/global/pptx', 'codex', true),
    /SKILL_AGENT_INVALID/,
  )
})

test('import copies a native skill and records a native-origin projection without writing a marker', (t) => {
  const { home, library } = setup(t)
  const result = library.importFromAgent({ ids: ['claude/global/pptx'], trust: true })
  assert.equal(result.imported.length, 1)
  assert.equal(result.imported[0].id, 'shared/library/pptx')
  assert.equal(result.imported[0].approved, true)

  assert.equal(fs.existsSync(path.join(home, 'library', 'pptx', 'SKILL.md')), true)
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'pptx', '.tyche-managed.json')), false)
  assert.equal(library.list().skills.some(skill => skill.id === 'claude/global/pptx'), false)

  const shared = findSkill(library, 'shared/library/pptx')
  assert.equal(shared.trust, 'trusted')
  assert.equal(shared.projections.length, 1)
  assert.equal(shared.projections[0].agent, 'claude')
  assert.equal(shared.projections[0].mode, 'nativeOrigin')
  assert.equal(shared.projections[0].status, 'deployed')
  assert.equal(library.list().agents.includes('claude'), true)
})

test('materialize switches from prompt delivery to native delivery after a valid projection', (t) => {
  const { library } = setup(t)
  library.importFromAgent({ ids: ['claude/global/pptx'], trust: true })

  let equipped = library.materialize('codex', ['shared/library/pptx']).skills[0]
  assert.equal(equipped.delivery, 'prompt')
  assert.match(equipped.body, /pptx workflow/)
  assert.equal(equipped.contentHash.length, 64)

  library.project('shared/library/pptx', 'codex')
  equipped = library.materialize('codex', ['shared/library/pptx']).skills[0]
  assert.equal(equipped.delivery, 'native')
  assert.equal(equipped.body, '')
})

test('projection copies into an Agent directory, detects drift, and restores', (t) => {
  const { catalog, home, library } = setup(t)
  library.importFromAgent({ ids: ['claude/global/pptx'], trust: true })
  library.project('shared/library/pptx', 'codex')

  const target = path.join(home, '.codex', 'skills', 'pptx')
  assert.equal(fs.existsSync(path.join(target, 'SKILL.md')), true)
  const marker = JSON.parse(fs.readFileSync(path.join(target, '.tyche-managed.json'), 'utf8'))
  assert.equal(marker.skillId, 'shared/library/pptx')
  assert.equal(marker.projectionId.startsWith('proj-'), true)

  let projection = findSkill(library, 'shared/library/pptx').projections.find(item => item.agent === 'codex')
  assert.equal(projection.status, 'deployed')

  fs.appendFileSync(path.join(target, 'SKILL.md'), '\nLocal edit.\n')
  catalog.invalidate('codex')
  library.invalidate()
  projection = findSkill(library, 'shared/library/pptx').projections.find(item => item.agent === 'codex')
  assert.equal(projection.status, 'drifted')
  assert.throws(
    () => library.unproject('shared/library/pptx', 'codex'),
    /SKILL_PROJECTION_DRIFTED/,
  )

  library.resolveProjection({ projectionId: projection.id, action: 'restore' })
  projection = findSkill(library, 'shared/library/pptx').projections.find(item => item.agent === 'codex')
  assert.equal(projection.status, 'deployed')
  assert.doesNotMatch(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /Local edit/)
})

test('content changes require re-approval and mark projections outdated', (t) => {
  const { catalog, home, library } = setup(t)
  library.importFromAgent({ ids: ['claude/global/pptx'], trust: true })
  library.project('shared/library/pptx', 'codex')

  fs.appendFileSync(path.join(home, 'library', 'pptx', 'SKILL.md'), '\nNew instruction.\n')
  catalog.invalidate('claude')
  library.invalidate()

  let shared = findSkill(library, 'shared/library/pptx')
  assert.equal(shared.trust, 'changed')
  assert.equal(shared.projections.find(item => item.agent === 'codex').status, 'outdated')
  assert.throws(
    () => library.assertSelectable('codex', ['shared/library/pptx']),
    /SKILL_SELECTION_INVALID/,
  )

  library.trust('shared/library/pptx')
  shared = findSkill(library, 'shared/library/pptx')
  assert.equal(shared.trust, 'trusted')
  library.project('shared/library/pptx', 'codex')
  shared = findSkill(library, 'shared/library/pptx')
  assert.equal(shared.projections.find(item => item.agent === 'codex').status, 'deployed')
})

test('an unmarked same-name native folder blocks projection', (t) => {
  const { catalog, home, library } = setup(t)
  library.importFromAgent({ ids: ['claude/global/pptx'], trust: true })
  writeNativeSkill(home, '.gemini', 'pptx', 'Different content', 'A different Skill.')
  catalog.invalidate('gemini')
  library.invalidate()

  assert.throws(
    () => library.project('shared/library/pptx', 'gemini'),
    /SKILL_PROJECTION_CONFLICT/,
  )
  assert.equal(fs.existsSync(path.join(home, '.gemini', 'skills', 'pptx', '.tyche-managed.json')), false)
  const gemini = findSkill(library, 'gemini/global/pptx')
  assert.ok(gemini)
  assert.equal(gemini.conflict?.name, 'pptx')
})

test('revoking trust removes managed copies and keeps the native source', (t) => {
  const { home, library } = setup(t)
  library.importFromAgent({ ids: ['claude/global/pptx'], trust: true })
  library.project('shared/library/pptx', 'codex')

  library.revokeTrust('shared/library/pptx')
  assert.equal(fs.existsSync(path.join(home, '.codex', 'skills', 'pptx')), false)
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'pptx', 'SKILL.md')), true)
  const shared = findSkill(library, 'shared/library/pptx')
  assert.equal(shared.trust, 'untrusted')
  assert.deepEqual(shared.projections, [])
})

test('removing a library Skill moves it to trash and removes managed copies only', (t) => {
  const { home, library } = setup(t)
  library.importFromAgent({ ids: ['claude/global/pptx'], trust: true })
  library.project('shared/library/pptx', 'codex')

  library.remove({ id: 'shared/library/pptx', confirmName: 'pptx' })
  assert.equal(fs.existsSync(path.join(home, 'library', 'pptx')), false)
  assert.equal(fs.existsSync(path.join(home, '.codex', 'skills', 'pptx')), false)
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'pptx', 'SKILL.md')), true)
  assert.equal(library.list().skills.some(skill => skill.id === 'shared/library/pptx'), false)
  assert.equal(fs.readdirSync(path.join(home, 'trash')).length, 1)
})

test('creating a Skill writes the standard frontmatter, trusts it, and can distribute immediately', (t) => {
  const { home, library } = setup(t)
  const created = library.create({
    name: 'review-kit',
    description: 'Review code changes',
    body: '# Review\n\nCheck the diff.',
    targets: ['codex'],
  })
  assert.equal(created.id, 'shared/library/review-kit')
  assert.equal(created.trust, 'trusted')
  assert.equal(created.projections.some(projection => projection.agent === 'codex' && projection.status === 'deployed'), true)
  assert.equal(fs.existsSync(path.join(home, '.codex', 'skills', 'review-kit', 'SKILL.md')), true)
  assert.match(fs.readFileSync(path.join(home, 'library', 'review-kit', 'SKILL.md'), 'utf8'), /name: review-kit/)
})

test('a v1 inventory migrates eligibility, trust, and defaults', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-skill-migrate-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  writeNativeSkill(home, '.claude', 'pptx', 'Create presentations', 'Use the pptx workflow.')
  const storageRoot = path.join(home, 'store')
  fs.mkdirSync(storageRoot, { recursive: true })
  const legacyPath = path.join(storageRoot, 'skill-inventory.json')
  fs.writeFileSync(legacyPath, JSON.stringify({
    schemaVersion: 1,
    eligibility: { 'claude/global/pptx': ['claude'] },
    trust: {},
    defaults: { claude: ['claude/global/pptx'] },
  }))
  const catalog = new LocalSkillCatalog({ home })
  const library = new SkillLibrary({
    storagePath: path.join(storageRoot, 'skill-library.json'),
    legacyPath,
    libraryRoot: path.join(home, 'library'),
    backupRoot: path.join(home, 'backups'),
    trashRoot: path.join(home, 'trash'),
    home,
    catalog,
  })
  assert.equal(fs.existsSync(path.join(storageRoot, 'skill-library.json')), true)
  assert.equal(fs.existsSync(`${legacyPath}.bak`), true)
  assert.equal(findSkill(library, 'claude/global/pptx').trust, 'untrusted')

  library.trust('claude/global/pptx')
  assert.deepEqual(findSkill(library, 'claude/global/pptx').available, ['claude'])
})

test('duplicate imports rename by default and can replace explicitly', (t) => {
  const { home, library } = setup(t)
  const first = library.importFromAgent({ ids: ['claude/global/pptx'], trust: true })
  assert.equal(first.imported[0].name, 'pptx')

  writeNativeSkill(home, '.gemini', 'pptx', 'Another version', 'Different instructions.')
  const catalog = library.catalog
  catalog.invalidate('gemini')
  library.invalidate()
  const second = library.importFromAgent({ ids: ['gemini/global/pptx'], trust: true })
  assert.equal(second.imported[0].name, 'pptx-2')
  assert.equal(fs.existsSync(path.join(home, 'library', 'pptx-2', 'SKILL.md')), true)

  const third = library.importFromAgent({ ids: ['gemini/global/pptx'], trust: true, onConflict: 'replace' })
  assert.equal(third.imported[0].name, 'pptx')
})
