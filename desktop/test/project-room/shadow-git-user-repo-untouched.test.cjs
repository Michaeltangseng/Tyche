const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ShadowRepo } = require('../../src/project-room/shadow-git.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shadow-untouched-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function hashDirectory(root) {
  const result = {}
  function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const filename = path.join(directory, name)
      const relative = path.relative(root, filename).split(path.sep).join('/')
      const stat = fs.lstatSync(filename)
      if (stat.isDirectory()) walk(filename)
      else if (stat.isFile()) {
        result[relative] = createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
      } else if (stat.isSymbolicLink()) {
        result[relative] = `link:${fs.readlinkSync(filename)}`
      } else {
        result[relative] = 'other'
      }
    }
  }
  walk(root)
  return result
}

function makeUserRepo(t) {
  const directory = fixture(t)
  execFileSync('git', ['init', '--quiet'], { cwd: directory })
  git(directory, ['config', 'user.name', 'User'])
  git(directory, ['config', 'user.email', 'user@example.com'])
  git(directory, ['config', 'custom.marker', 'do-not-touch'])
  fs.mkdirSync(path.join(directory, '.git', 'hooks'), { recursive: true })
  for (const hook of ['pre-commit', 'prepare-commit-msg', 'post-checkout']) {
    const filename = path.join(directory, '.git', 'hooks', hook)
    fs.writeFileSync(filename, '#!/bin/sh\necho hook-ran >> .git/hook-ran\n')
    fs.chmodSync(filename, 0o755)
  }
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'tracked')
  fs.writeFileSync(path.join(directory, 'staged.txt'), 'staged')
  git(directory, ['add', '-A'])
  git(directory, ['commit', '-m', 'initial'])
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'tracked changed')
  git(directory, ['add', 'tracked.txt'])
  fs.writeFileSync(path.join(directory, 'staged-only.txt'), 'staged only')
  git(directory, ['add', 'staged-only.txt'])
  // The setup commit ran the hooks once; remove that marker so the test can
  // assert that the shadow operations do not run hooks again.
  fs.rmSync(path.join(directory, '.git', 'hook-ran'), { force: true })
  return directory
}

test('shadow repository operations leave the user repository untouched', async (t) => {
  const userRepo = makeUserRepo(t)
  const shadowDir = fixture(t)
  const shadow = await ShadowRepo.create({
    gitDir: path.join(shadowDir, 'shadow.git'),
    workTree: userRepo,
  })
  const before = hashDirectory(path.join(userRepo, '.git'))

  fs.mkdirSync(path.join(userRepo, 'docs'))
  fs.writeFileSync(path.join(userRepo, 'docs', 'req.md'), 'requirements')
  fs.mkdirSync(path.join(userRepo, 'meldwork', 'reviews', 'cp'), { recursive: true })
  fs.writeFileSync(path.join(userRepo, 'meldwork', 'reviews', 'cp', 'r1.md'), 'review')

  const candidate = await shadow.snapshot({
    effectId: 'untouched-candidate',
    targets: ['docs/req.md'],
  })
  fs.writeFileSync(path.join(userRepo, 'docs', 'req.md'), 'requirements changed')
  const observed = await shadow.snapshot({
    effectId: 'untouched-observed',
    targets: ['docs/req.md'],
  })
  await shadow.verifyAgainst({
    effectId: 'untouched-verify',
    commit: candidate.commit,
    paths: ['docs/req.md'],
  })
  await shadow.driftCheck({
    effectId: 'untouched-drift',
    acceptedByPath: { 'docs/req.md': candidate.commit },
  })
  const accepted = await shadow.acceptCommit({
    effectId: 'untouched-accept',
    candidate: candidate.commit,
    recordPaths: ['meldwork/reviews/cp/r1.md'],
  })
  await shadow.driftAcceptCommit({
    effectId: 'untouched-drift-accept',
    base: candidate.commit,
    observed: observed.commit,
    paths: ['docs/req.md'],
  })
  await shadow.numstat(candidate.commit, observed.commit)
  await shadow.fileDiff(candidate.commit, observed.commit, 'docs/req.md')
  await shadow.restoreFiles({ commit: candidate.commit, paths: ['docs/req.md'] })
  await shadow.collectIfNeeded({ looseObjectThreshold: 0 })
  await shadow.dropRefs([`refs/meldwork/effects/${createHash('sha256')
    .update('untouched-candidate').digest('hex')}`])

  const after = hashDirectory(path.join(userRepo, '.git'))
  assert.deepEqual(after, before)
  assert.equal(fs.existsSync(path.join(userRepo, '.git', 'hook-ran')), false)
  assert.equal(git(userRepo, ['config', '--get', 'custom.marker']), 'do-not-touch')
  assert.equal(git(userRepo, ['diff', '--cached', '--name-only']).includes('tracked.txt'), true)
  assert.equal(typeof accepted, 'string')
})
