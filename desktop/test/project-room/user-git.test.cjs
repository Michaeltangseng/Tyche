const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  userRepoCheckTrailer,
  userRepoCommit,
  userRepoPreflight,
} = require('../../src/project-room/user-git.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-user-git-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeRepo(t, { objectFormat } = {}) {
  const directory = fixture(t)
  const args = ['init', '--quiet']
  if (objectFormat) args.push('--object-format', objectFormat)
  execFileSync('git', args, { cwd: directory })
  git(directory, ['config', 'user.name', 'Tester'])
  git(directory, ['config', 'user.email', 'tester@example.com'])
  return directory
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function acceptedFile(content, mode = '100644') {
  return { exists: true, type: 'file', mode, sha256: sha256(content) }
}

function initialCommit(repo, content = 'old') {
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), content)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'initial'])
}

test('preflight accepts and commits a changed tracked path', async (t) => {
  const repo = makeRepo(t)
  initialCommit(repo)
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'new')
  const acceptedEntries = { 'src/a.ts': acceptedFile('new') }

  const preflight = await userRepoPreflight({
    workTree: repo, paths: ['src/a.ts'], acceptedEntries,
  })
  assert.deepEqual(preflight, { ok: true, reasons: [] })

  let staged = null
  const result = await userRepoCommit({
    workTree: repo,
    paths: ['src/a.ts'],
    acceptedEntries,
    message: 'accept change',
    decisionId: 'decision-1',
    onStaged: entries => { staged = entries },
  })
  assert.equal(result.committed, true)
  assert.equal(git(repo, ['show', `${result.commit}:src/a.ts`]), 'new')
  assert.equal(staged[0].path, 'src/a.ts')
  assert.equal(git(repo, ['log', '-1', '--format=%s']), 'accept change')
  assert.equal(await userRepoCheckTrailer({ workTree: repo, decisionId: 'decision-1' }), true)
  assert.equal(await userRepoCheckTrailer({ workTree: repo, decisionId: 'decision-2' }), false)
})

test('existing staged files stay staged and outside the commit', async (t) => {
  const repo = makeRepo(t)
  initialCommit(repo)
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'new')
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other')
  git(repo, ['add', 'other.txt'])

  const result = await userRepoCommit({
    workTree: repo,
    paths: ['src/a.ts'],
    acceptedEntries: { 'src/a.ts': acceptedFile('new') },
    message: 'accept change',
    decisionId: 'decision-staged',
  })
  assert.equal(result.committed, true)
  assert.deepEqual(git(repo, ['show', '--name-only', '--format=', 'HEAD']).split('\n'), ['src/a.ts'])
  assert.deepEqual(git(repo, ['diff', '--cached', '--name-only']).split('\n'), ['other.txt'])
})

test('a user-staged accepted path makes the preflight fail without touching the index', async (t) => {
  const repo = makeRepo(t)
  initialCommit(repo)
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'staged')
  git(repo, ['add', 'src/a.ts'])
  const acceptedEntries = { 'src/a.ts': acceptedFile('new') }

  const preflight = await userRepoPreflight({
    workTree: repo, paths: ['src/a.ts'], acceptedEntries,
  })
  assert.equal(preflight.ok, false)
  assert.deepEqual(preflight.reasons, [{ path: 'src/a.ts', reason: 'staged' }])
  const result = await userRepoCommit({
    workTree: repo,
    paths: ['src/a.ts'],
    acceptedEntries,
    decisionId: 'decision-staged-path',
  })
  assert.deepEqual(result, {
    committed: false,
    reasons: [{ path: 'src/a.ts', reason: 'staged' }],
  })
  assert.equal(git(repo, ['diff', '--cached', '--name-only']), 'src/a.ts')
})

test('ignored accepted paths are force-added to the commit', async (t) => {
  const repo = makeRepo(t)
  fs.writeFileSync(path.join(repo, '.gitignore'), 'docs/\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'initial'])
  fs.mkdirSync(path.join(repo, 'docs'))
  fs.writeFileSync(path.join(repo, 'docs', 'req.md'), 'accepted')
  const result = await userRepoCommit({
    workTree: repo,
    paths: ['docs/req.md'],
    acceptedEntries: { 'docs/req.md': acceptedFile('accepted') },
    decisionId: 'decision-ignored',
  })
  assert.equal(result.committed, true)
  assert.equal(git(repo, ['show', `${result.commit}:docs/req.md`]), 'accepted')
})

test('mode and type changes fail the preflight', async (t) => {
  const repo = makeRepo(t)
  initialCommit(repo)
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'new')
  fs.chmodSync(path.join(repo, 'src', 'a.ts'), 0o755)
  const mode = await userRepoPreflight({
    workTree: repo,
    paths: ['src/a.ts'],
    acceptedEntries: { 'src/a.ts': acceptedFile('new', '100644') },
  })
  assert.deepEqual(mode.reasons, [{ path: 'src/a.ts', reason: 'mode' }])

  fs.rmSync(path.join(repo, 'src', 'a.ts'))
  fs.writeFileSync(path.join(repo, 'target.txt'), 'new')
  fs.symlinkSync('target.txt', path.join(repo, 'src', 'a.ts'))
  const type = await userRepoPreflight({
    workTree: repo,
    paths: ['src/a.ts'],
    acceptedEntries: { 'src/a.ts': acceptedFile('new') },
  })
  assert.deepEqual(type.reasons, [{ path: 'src/a.ts', reason: 'type' }])
})

test('a rejecting hook restores only the paths this commit staged', async (t) => {
  const repo = makeRepo(t)
  initialCommit(repo)
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'new')
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other')
  git(repo, ['add', 'other.txt'])
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  fs.chmodSync(hook, 0o755)

  let failure = null
  try {
    await userRepoCommit({
      workTree: repo,
      paths: ['src/a.ts'],
      acceptedEntries: { 'src/a.ts': acceptedFile('new') },
      decisionId: 'decision-hook',
    })
  } catch (error) {
    failure = error
  }
  assert.ok(failure)
  assert.deepEqual(failure.restoredPaths, ['src/a.ts'])
  assert.equal(git(repo, ['show', 'HEAD:src/a.ts']), 'old')
  assert.equal(git(repo, ['diff', '--cached', '--name-only']), 'other.txt')
})

test('a worktree below the repository root converts paths correctly', async (t) => {
  const repo = makeRepo(t)
  fs.mkdirSync(path.join(repo, 'sub'))
  fs.writeFileSync(path.join(repo, 'sub', 'a.ts'), 'old')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'initial'])
  const workTree = path.join(repo, 'sub')
  fs.writeFileSync(path.join(workTree, 'a.ts'), 'new')
  const result = await userRepoCommit({
    workTree,
    paths: ['a.ts'],
    acceptedEntries: { 'a.ts': acceptedFile('new') },
    decisionId: 'decision-subdir',
  })
  assert.equal(result.committed, true)
  assert.equal(git(repo, ['show', `${result.commit}:sub/a.ts`]), 'new')
})

test('SHA-256 object-format repositories compare content and trailer correctly', async (t) => {
  const repo = makeRepo(t, { objectFormat: 'sha256' })
  initialCommit(repo)
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'new')
  const result = await userRepoCommit({
    workTree: repo,
    paths: ['src/a.ts'],
    acceptedEntries: { 'src/a.ts': acceptedFile('new') },
    decisionId: 'decision-sha256',
  })
  assert.equal(result.committed, true)
  assert.equal(git(repo, ['rev-parse', '--show-object-format']), 'sha256')
  assert.equal(await userRepoCheckTrailer({ workTree: repo, decisionId: 'decision-sha256' }), true)
})
