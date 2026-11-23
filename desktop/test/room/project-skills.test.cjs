const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createProjectSkillSync } = require('../../src/room/project-skills.cjs')

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-project-skills-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const library = path.join(root, 'library')
  const state = path.join(root, 'room')
  fs.mkdirSync(path.join(library, 'deck'), { recursive: true })
  fs.writeFileSync(path.join(library, 'deck', 'SKILL.md'), '# deck\n')
  fs.mkdirSync(path.join(library, 'deck', 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(library, 'deck', 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n')
  fs.mkdirSync(workspace, { recursive: true })
  return {
    workspace,
    library,
    state,
    sync: createProjectSkillSync({ stateRoot: state, platform: 'darwin' }),
  }
}

test('links a platform Skill into the workspace project roots', (t) => {
  const { workspace, library, sync } = setup(t)
  const result = sync.sync({
    workspace,
    providers: ['claude', 'codex'],
    skills: [{ id: 'shared/library/deck', name: 'deck', sourceDirectory: path.join(library, 'deck') }],
  })
  assert.equal(result.supported, true)
  assert.equal(result.conflicts.length, 0)
  for (const link of [
    path.join(workspace, '.claude', 'skills', 'deck'),
    path.join(workspace, '.codex', 'skills', 'deck'),
  ]) {
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(library, 'deck')))
    assert.equal(fs.existsSync(path.join(link, 'scripts', 'run.sh')), true)
  }
})

test('never overwrites an occupied path and clears only managed links', (t) => {
  const { workspace, library, state, sync } = setup(t)
  fs.mkdirSync(path.join(workspace, '.claude', 'skills', 'deck'), { recursive: true })
  fs.writeFileSync(path.join(workspace, '.claude', 'skills', 'deck', 'user.txt'), 'mine')
  const result = sync.sync({
    workspace,
    providers: ['claude', 'codex'],
    skills: [{ id: 'shared/library/deck', name: 'deck', sourceDirectory: path.join(library, 'deck') }],
  })
  assert.equal(result.conflicts[0].reason, 'occupied')
  assert.equal(fs.readFileSync(path.join(workspace, '.claude', 'skills', 'deck', 'user.txt'), 'utf8'), 'mine')
  assert.equal(fs.lstatSync(path.join(workspace, '.codex', 'skills', 'deck')).isSymbolicLink(), true)

  const cleared = sync.clear({ workspace })
  assert.equal(cleared.removed.length, 1)
  assert.equal(fs.existsSync(path.join(workspace, '.codex', 'skills', 'deck')), false)
  assert.equal(fs.existsSync(path.join(workspace, '.claude', 'skills', 'deck', 'user.txt')), true)
  assert.equal(fs.existsSync(path.join(state, 'project-skills.json')), true)
})

test('a second sync replaces stale managed links', (t) => {
  const { workspace, library, sync } = setup(t)
  sync.sync({
    workspace,
    providers: ['claude'],
    skills: [{ id: 'shared/library/deck', name: 'deck', sourceDirectory: path.join(library, 'deck') }],
  })
  const result = sync.sync({ workspace, providers: ['claude'], skills: [] })
  assert.equal(result.removed.length, 1)
  assert.equal(fs.existsSync(path.join(workspace, '.claude', 'skills', 'deck')), false)
})
