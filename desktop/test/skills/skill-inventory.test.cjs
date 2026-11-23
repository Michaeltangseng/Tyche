const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { LocalSkillCatalog } = require('../../src/skills/local-skill-catalog.cjs')
const { SkillInventory } = require('../../src/skills/skill-inventory.cjs')

function writeSkill(home, kindRoot, folder, body) {
  const directory = path.join(home, kindRoot, 'skills', folder)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'SKILL.md'), body)
  return directory
}

function setup(t, { maxFileBytes } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-skill-inventory-'))
  const storagePath = path.join(home, 'inventory.json')
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  writeSkill(home, '.claude', 'frontend-design', [
    '---',
    'name: frontend-design',
    'description: Layout and visual design',
    '---',
    'Use a clear hierarchy.',
    '',
  ].join('\n'))
  const catalog = new LocalSkillCatalog({ home })
  const inventory = new SkillInventory({ storagePath, catalog, maxFileBytes })
  return { home, inventory, storagePath }
}

test('a discovered skill stays untrusted until the user trusts that hash', () => {
  const { inventory } = setup(test)
  const listed = inventory.list()
  const skill = listed.skills.find(item => item.id === 'claude/global/frontend-design')
  assert.ok(skill)
  assert.equal(skill.trust, 'untrusted')
  assert.deepEqual(skill.eligible, [])
  assert.equal(skill.description, 'Layout and visual design')
  assert.equal(JSON.stringify(listed).includes('SKILL.md'), false)
  assert.deepEqual(listed.agents, ['claude'])
})

test('turning a switch on trusts that skill for the agent that owns the files', () => {
  const { home, inventory } = setup(test)
  const skillFile = path.join(home, '.claude', 'skills', 'frontend-design', 'SKILL.md')
  const before = fs.readFileSync(skillFile)
  inventory.setEligible('claude/global/frontend-design', 'claude', true)
  const skill = inventory.list().skills[0]
  assert.equal(skill.trust, 'trusted')
  assert.deepEqual(skill.eligible, ['claude'])
  assert.deepEqual(inventory.list().agents, ['claude'])
  assert.deepEqual(fs.readFileSync(skillFile), before)
  assert.throws(
    () => inventory.setEligible('claude/global/frontend-design', 'codex', true),
    /SKILL_INVENTORY_AGENT_INVALID/,
  )
  const equipped = inventory.materialize('claude', ['claude/global/frontend-design'])
  assert.equal(equipped.skills[0].body.includes('Use a clear hierarchy.'), true)
  assert.equal(Object.hasOwn(equipped.skills[0], 'sourceDirectory'), false)
  assert.deepEqual(inventory.materialize('codex', ['claude/global/frontend-design']).skills, [])
})

test('a content change drops trust and a revoked skill leaves the directory in place', () => {
  const { home, inventory } = setup(test)
  const skillFile = path.join(home, '.claude', 'skills', 'frontend-design', 'SKILL.md')
  inventory.trust('claude/global/frontend-design')
  inventory.setEligible('claude/global/frontend-design', 'claude', true)
  fs.appendFileSync(skillFile, '\nExtra instruction.\n')
  const changed = inventory.list().skills[0]
  assert.equal(changed.trust, 'changed')
  assert.throws(
    () => inventory.assertSelectable('claude', ['claude/global/frontend-design']),
    /SKILL_INVENTORY_SELECTION_INVALID/,
  )
  inventory.trust('claude/global/frontend-design')
  inventory.revoke('claude/global/frontend-design')
  assert.equal(fs.existsSync(skillFile), true)
  assert.equal(inventory.list().skills[0].trust, 'untrusted')
  assert.deepEqual(inventory.list().skills[0].eligible, [])
})

test('captain inventory and role defaults only contain skills that agent can select', () => {
  const { inventory } = setup(test)
  inventory.trust('claude/global/frontend-design')
  inventory.setEligible('claude/global/frontend-design', 'claude', true)
  inventory.rememberDefault('claude', ['claude/global/frontend-design'])
  const view = inventory.captainInventory(['claude', 'codex'])
  assert.equal(view.providers.find(item => item.provider === 'claude').skills[0].id, 'claude/global/frontend-design')
  assert.deepEqual(view.providers.find(item => item.provider === 'codex').skills, [])
  assert.deepEqual(inventory.defaults('claude'), ['claude/global/frontend-design'])
  assert.deepEqual(inventory.defaults('codex'), [])
  inventory.setEligible('claude/global/frontend-design', 'claude', false)
  assert.equal(fs.existsSync(path.join(inventory.storagePath)), true)
  assert.deepEqual(inventory.defaults('claude'), [])
})

test('a skill directory that is too large cannot be trusted', () => {
  const { inventory } = setup(test, { maxFileBytes: 32 })
  fs.appendFileSync(
    path.join(inventory.storagePath, '..', '.claude', 'skills', 'frontend-design', 'SKILL.md'),
    `${'x'.repeat(80)}\n`,
  )
  const skill = inventory.list().skills[0]
  assert.equal(skill.trust, 'unavailable')
  assert.throws(() => inventory.trust(skill.id), /SKILL_INVENTORY_TOO_LARGE/)
})
