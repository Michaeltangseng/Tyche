const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ShadowRepo } = require('../../src/project-room/shadow-git.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shadow-compare-'))
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

test('diffQuiet and nameStatus compare selected paths', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'a')
  fs.writeFileSync(path.join(workTree, 'b.txt'), 'b')
  const first = await repo.snapshot({ effectId: 'compare-first' })
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'changed')
  fs.writeFileSync(path.join(workTree, 'c.txt'), 'c')
  const second = await repo.snapshot({ effectId: 'compare-second' })

  assert.equal(await repo.diffQuiet(first.commit, second.commit, ['a.txt']), false)
  assert.equal(await repo.diffQuiet(first.commit, second.commit, ['b.txt']), true)
  const entries = await repo.nameStatus(first.commit, second.commit)
  assert.deepEqual(entries.find(entry => entry.path === 'a.txt'), { status: 'M', path: 'a.txt' })
  assert.deepEqual(entries.find(entry => entry.path === 'c.txt'), { status: 'A', path: 'c.txt' })
})

test('verifyAgainst reports intact and differing worktrees', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'a')
  const accepted = await repo.snapshot({ effectId: 'verify-base' })
  const intact = await repo.verifyAgainst({
    effectId: 'verify-intact',
    commit: accepted.commit,
    paths: ['a.txt'],
  })
  assert.deepEqual(intact, { intact: true, differing: [] })

  fs.writeFileSync(path.join(workTree, 'a.txt'), 'changed')
  const changed = await repo.verifyAgainst({
    effectId: 'verify-changed',
    commit: accepted.commit,
    paths: ['a.txt'],
  })
  assert.equal(changed.intact, false)
  assert.deepEqual(changed.differing, ['a.txt'])
})

test('verification snapshots fail closed when limits are exceeded', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'a')
  const accepted = await repo.snapshot({ effectId: 'verify-limit-base' })
  await assert.rejects(
    repo.verifyAgainst({
      effectId: 'verify-limit-target',
      commit: accepted.commit,
      paths: ['a.txt'],
      limits: { maxDurationMs: -1 },
    }),
    (error) => error.code === 'SHADOW_SNAPSHOT_LIMIT',
  )
})

test('driftCheck compares accepted files against one observation snapshot', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.mkdirSync(path.join(workTree, 'docs'))
  fs.writeFileSync(path.join(workTree, 'docs', 'a.md'), 'accepted')
  const accepted = await repo.snapshot({ effectId: 'drift-base' })

  const clean = await repo.driftCheck({
    effectId: 'drift-clean',
    acceptedByPath: { 'docs/a.md': accepted.commit },
  })
  assert.deepEqual(clean.drifted, [])

  fs.writeFileSync(path.join(workTree, 'docs', 'a.md'), 'changed')
  const drifted = await repo.driftCheck({
    effectId: 'drift-changed',
    acceptedByPath: { 'docs/a.md': accepted.commit },
  })
  assert.deepEqual(drifted.drifted, ['docs/a.md'])
  assert.match(drifted.snapshotCommit, /^[a-f0-9]{40}$/)
})
