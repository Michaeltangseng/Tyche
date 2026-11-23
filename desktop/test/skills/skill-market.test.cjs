const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

const { LocalSkillCatalog } = require('../../src/skills/local-skill-catalog.cjs')
const { SkillLibrary } = require('../../src/skills/skill-library.cjs')
const { SkillMarket } = require('../../src/skills/skill-market.cjs')

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
}

function writeSkill(root, relative, name, description, body) {
  const directory = path.join(root, relative, name)
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

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-market-repo-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  git(['init', '-q', '-b', 'main'], root)
  git(['config', 'user.name', 'Tyche Test'], root)
  git(['config', 'user.email', 'tyche@example.test'], root)
  writeSkill(root, 'skills', 'alpha', 'Alpha Skill', 'Alpha instructions.')
  writeSkill(root, 'skills', 'beta', 'Beta Skill', 'Beta instructions.')
  git(['add', '.'], root)
  git(['commit', '-q', '-m', 'initial'], root)
  return root
}

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-market-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const catalog = new LocalSkillCatalog({ home })
  const library = new SkillLibrary({
    storagePath: path.join(home, 'store', 'skill-library.json'),
    legacyPath: path.join(home, 'store', 'skill-inventory.json'),
    libraryRoot: path.join(home, 'library'),
    backupRoot: path.join(home, 'backups'),
    trashRoot: path.join(home, 'trash'),
    marketRoot: path.join(home, 'market'),
    home,
    catalog,
  })
  return { home, library }
}

test('a Git source previews, installs, checks, and updates a market Skill', async (t) => {
  const repo = makeRepo(t)
  const { home, library } = setup(t)
  const source = library.market.addSource({
    url: pathToFileURL(repo).href,
    ref: '',
    subpath: '',
  })
  assert.equal(source.id.startsWith('src-'), true)

  const preview = await library.market.previewSource(source.id)
  assert.equal(preview.entries.length, 2)
  const alpha = preview.entries.find(entry => entry.name === 'alpha')
  assert.ok(alpha)
  assert.equal(alpha.validName, true)
  assert.equal(alpha.preview, undefined)
  assert.equal(alpha.risk, undefined)

  const installed = library.market.installEntry({ token: alpha.token })
  assert.equal(installed.id, 'shared/library/alpha')
  assert.equal(installed.source, 'market')
  assert.equal(installed.trust, undefined)
  assert.equal(fs.existsSync(path.join(home, 'library', 'alpha', 'SKILL.md')), true)
  const provenance = JSON.parse(fs.readFileSync(path.join(home, 'library', 'alpha', '.tyche-provenance.json'), 'utf8'))
  assert.equal(provenance.sourceKind, 'market')
  assert.equal(provenance.origin.relativePath, 'skills/alpha')

  assert.deepEqual(library.assertSelectable('codex', ['shared/library/alpha']), ['shared/library/alpha'])
  const installedPreview = await library.market.previewSource(source.id)
  const installedAlpha = installedPreview.entries.find(entry => entry.name === 'alpha')
  assert.equal(installedAlpha.installed, true)
  assert.equal(installedAlpha.installedId, 'shared/library/alpha')
  assert.equal(installedAlpha.upToDate, true)

  writeSkill(repo, 'skills', 'alpha', 'Alpha Skill', 'Alpha instructions updated.')
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'update alpha'], repo)
  const updates = await library.market.checkUpdates()
  assert.equal(updates.updates.length, 1)
  assert.equal(updates.updates[0].skillId, 'shared/library/alpha')
  assert.equal(library.list().skills.find(skill => skill.id === 'shared/library/alpha').updateAvailable, true)

  const changedPreview = await library.market.previewSource(source.id)
  const changedAlpha = changedPreview.entries.find(entry => entry.name === 'alpha')
  assert.equal(changedAlpha.installed, true)
  assert.equal(changedAlpha.upToDate, false)

  const next = await library.market.previewUpdate({ skillId: 'shared/library/alpha' })
  assert.equal(next.upToDate, false)
  assert.equal(next.entry.preview, undefined)
  const changed = library.market.applyUpdate({
    skillId: 'shared/library/alpha',
    token: next.entry.token,
  })
  assert.equal(changed.updateAvailable, false)
  assert.match(fs.readFileSync(path.join(home, 'library', 'alpha', 'SKILL.md'), 'utf8'), /updated/)

  const current = await library.market.previewUpdate({ skillId: 'shared/library/alpha' })
  assert.equal(current.upToDate, true)
})

test('repo mode installs the whole toolchain as a library symlink', async (t) => {
  const repo = makeRepo(t)
  fs.mkdirSync(path.join(repo, 'cli'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'cli', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 })
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'add toolchain'], repo)

  const { home, library } = setup(t)
  const source = library.market.addSource({
    url: pathToFileURL(repo).href,
    ref: '',
    subpath: '',
  })
  const preview = await library.market.previewSource(source.id)
  const alpha = preview.entries.find(entry => entry.name === 'alpha')
  assert.equal(alpha.repoMode, true)

  const installed = library.market.installEntry({ token: alpha.token, repo: true })
  assert.equal(installed.repoSkill, true)
  const topLink = path.join(home, 'library', 'alpha')
  assert.equal(fs.lstatSync(topLink).isSymbolicLink(), true)
  const real = fs.realpathSync(topLink)
  assert.equal(fs.existsSync(path.join(real, '..', '..', 'cli', 'run.sh')), true)
  assert.equal(fs.existsSync(path.join(home, '.codex', 'skills', 'alpha')), false)

  fs.writeFileSync(path.join(repo, 'cli', 'run.sh'), '#!/bin/sh\necho updated\n')
  writeSkill(repo, 'skills', 'alpha', 'Alpha Skill', 'Alpha updated toolchain.')
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'update alpha toolchain'], repo)

  const updates = await library.market.checkUpdates()
  assert.equal(updates.updates.length, 1)
  const next = await library.market.previewUpdate({ skillId: 'shared/library/alpha' })
  assert.equal(next.upToDate, false)
  assert.equal(next.entry.repoMode, true)
  const changed = library.market.applyUpdate({
    skillId: 'shared/library/alpha',
    token: next.entry.token,
  })
  assert.equal(changed.repoSkill, true)
  assert.match(fs.readFileSync(path.join(home, 'library', 'alpha', 'SKILL.md'), 'utf8'), /updated toolchain/)
  assert.match(fs.readFileSync(path.join(real, '..', '..', 'cli', 'run.sh'), 'utf8'), /updated/)

  library.remove({ id: 'shared/library/alpha', confirmName: 'alpha' })
  assert.equal(fs.existsSync(topLink), false)
})

test('market sources reject unsafe URLs and keep installed sources in use', async (t) => {
  const repo = makeRepo(t)
  const { library } = setup(t)
  assert.throws(
    () => library.market.addSource({ url: 'http://example.com/repo.git', ref: '', subpath: '' }),
    /SKILL_MARKET_SOURCE_INVALID/,
  )
  assert.throws(
    () => library.market.addSource({ url: 'file:///tmp/repo', ref: '../main', subpath: '' }),
    /SKILL_MARKET_SOURCE_INVALID/,
  )
  assert.throws(
    () => library.market.addSource({ url: pathToFileURL(repo).href, ref: '', subpath: '../skills' }),
    /SKILL_MARKET_SOURCE_INVALID/,
  )
  const source = library.market.addSource({ url: pathToFileURL(repo).href, ref: '', subpath: '' })
  const preview = await library.market.previewSource(source.id)
  const alpha = preview.entries.find(entry => entry.name === 'alpha')
  library.market.installEntry({ token: alpha.token })
  assert.throws(
    () => library.market.removeSource(source.id),
    /SKILL_MARKET_SOURCE_IN_USE/,
  )
})

test('the bundled catalog lists real entries and marks installed Skills', (t) => {
  const { library } = setup(t)
  const catalog = library.market.catalog()
  assert.equal(catalog.length > 50, true)
  const pdf = catalog.find(entry => entry.id === 'anthropics/pdf')
  assert.ok(pdf)
  assert.equal(pdf.installed, false)
  assert.equal(pdf.url, 'https://github.com/anthropics/skills')

  const store = library.loadStore()
  store.skills['shared/library/pdf'] = {
    name: 'pdf',
    sourceKind: 'market',
    origin: {
      type: 'market',
      url: 'https://github.com/anthropics/skills',
      relativePath: 'skills/pdf',
    },
    contentHash: 'a'.repeat(64),
  }
  library.saveStore(store)
  library.invalidate()

  const installed = library.market.catalog().find(entry => entry.id === 'anthropics/pdf')
  assert.equal(installed.installed, true)
  assert.equal(installed.installedId, 'shared/library/pdf')
})

test('concurrent previews of one source share a single clone', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-market-concurrent-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const sourceId = `src-${'a'.repeat(32)}`
  const store = {
    sources: { [sourceId]: { id: sourceId, url: 'https://example.test/repo.git', ref: '', subpath: '' } },
    skills: {},
  }
  const library = {
    loadStore: () => store,
    saveStore: () => {},
    notify: () => {},
  }
  let clones = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const git = async (args) => {
    if (args[0] === 'clone') {
      clones += 1
      const target = args[args.length - 1]
      fs.mkdirSync(path.join(target, 'skills', 'alpha'), { recursive: true })
      fs.writeFileSync(path.join(target, 'skills', 'alpha', 'SKILL.md'), [
        '---', 'name: alpha', 'description: Alpha', '---', '', 'Body.', '',
      ].join('\n'))
      await gate
      return ''
    }
    if (args[0] === 'rev-parse') return 'a'.repeat(40)
    return ''
  }
  const market = new SkillMarket({
    library,
    stagingRoot: path.join(home, 'staging'),
    git,
  })
  const first = market.previewSource(sourceId)
  const second = market.previewSource(sourceId)
  release()
  const [left, right] = await Promise.all([first, second])
  assert.equal(clones, 1)
  assert.deepEqual(left.entries.map(entry => entry.name), ['alpha'])
  assert.equal(right, left)
})
