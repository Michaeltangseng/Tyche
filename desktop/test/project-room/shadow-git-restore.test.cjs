const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ShadowRepo } = require('../../src/project-room/shadow-git.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shadow-restore-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

async function repoFor(t) {
  const directory = fixture(t)
  const workTree = path.join(directory, 'work')
  const gitDir = path.join(directory, 'shadow.git')
  fs.mkdirSync(workTree)
  const repo = await ShadowRepo.create({ gitDir, workTree })
  return { directory, workTree, gitDir, repo }
}

function temporaryFiles(workTree) {
  return fs.readdirSync(workTree).filter(name => name.includes('.meldwork-restore-'))
}

test('restoreFiles restores content, modes, links and deletes new files', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'A')
  fs.writeFileSync(path.join(workTree, 'run.sh'), '#!/bin/sh\n')
  fs.chmodSync(path.join(workTree, 'run.sh'), 0o755)
  fs.symlinkSync('a.txt', path.join(workTree, 'link'))
  const commit = await repo.snapshot({ effectId: 'restore-base' })

  fs.writeFileSync(path.join(workTree, 'a.txt'), 'changed')
  fs.chmodSync(path.join(workTree, 'run.sh'), 0o644)
  fs.rmSync(path.join(workTree, 'link'))
  fs.writeFileSync(path.join(workTree, 'link'), 'not a link')
  fs.writeFileSync(path.join(workTree, 'extra.txt'), 'extra')

  const result = await repo.restoreFiles({
    commit: commit.commit,
    paths: ['a.txt', 'run.sh', 'link', 'extra.txt'],
  })
  assert.deepEqual(result, {
    restored: ['a.txt', 'run.sh', 'link', 'extra.txt'],
    stoppedAt: null,
  })
  assert.equal(fs.readFileSync(path.join(workTree, 'a.txt'), 'utf8'), 'A')
  assert.equal(fs.statSync(path.join(workTree, 'run.sh')).mode & 0o777, 0o755)
  assert.equal(fs.lstatSync(path.join(workTree, 'link')).isSymbolicLink(), true)
  assert.equal(fs.readlinkSync(path.join(workTree, 'link')), 'a.txt')
  assert.equal(fs.existsSync(path.join(workTree, 'extra.txt')), false)
  assert.deepEqual(temporaryFiles(workTree), [])
})

test('restoreFiles stops before renaming when cancelled', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'A')
  fs.writeFileSync(path.join(workTree, 'b.txt'), 'B')
  const commit = await repo.snapshot({ effectId: 'cancel-base' })
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'changed-a')
  fs.writeFileSync(path.join(workTree, 'b.txt'), 'changed-b')

  let checks = 0
  const result = await repo.restoreFiles({
    commit: commit.commit,
    paths: ['a.txt', 'b.txt'],
    isCancelled: () => {
      checks += 1
      return checks >= 3
    },
  })
  assert.deepEqual(result, { restored: ['a.txt'], stoppedAt: 'b.txt' })
  assert.equal(fs.readFileSync(path.join(workTree, 'a.txt'), 'utf8'), 'A')
  assert.equal(fs.readFileSync(path.join(workTree, 'b.txt'), 'utf8'), 'changed-b')
  assert.deepEqual(temporaryFiles(workTree), [])
})

test('restoreFiles refuses placeholder entries', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'big.bin'), Buffer.alloc(64, 'B'))
  const commit = await repo.snapshot({
    effectId: 'placeholder-base',
    limits: { maxFileBytes: 16 },
  })
  await assert.rejects(
    repo.restoreFiles({ commit: commit.commit, paths: ['big.bin'] }),
    (error) => error.code === 'SHADOW_PLACEHOLDER_NOT_RESTORABLE',
  )
  assert.equal(fs.readFileSync(path.join(workTree, 'big.bin')).length, 64)
  assert.deepEqual(temporaryFiles(workTree), [])
})
