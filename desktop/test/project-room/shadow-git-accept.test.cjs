const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ShadowRepo } = require('../../src/project-room/shadow-git.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shadow-accept-'))
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

async function blob(repo, commit, relative) {
  return (await repo.git(['cat-file', 'blob', `${commit}:${relative}`])).stdout
}

test('acceptCommit uses the candidate tree and overlays current record files', async (t) => {
  const { repo, workTree, gitDir } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'target.md'), 'candidate')
  const candidate = await repo.snapshot({ effectId: 'candidate' })
  fs.writeFileSync(path.join(workTree, 'target.md'), 'worktree')
  fs.mkdirSync(path.join(workTree, 'meldwork', 'reviews', 'cp'), { recursive: true })
  fs.writeFileSync(path.join(workTree, 'meldwork', 'reviews', 'cp', 'r1.md'), 'review')

  const commit = await repo.acceptCommit({
    effectId: 'accept-1',
    candidate: candidate.commit,
    recordPaths: ['meldwork/reviews/cp/r1.md', 'meldwork/missing.md'],
    message: 'accept message',
  })
  assert.equal(await blob(repo, commit, 'target.md'), 'candidate')
  assert.equal(await blob(repo, commit, 'meldwork/reviews/cp/r1.md'), 'review')
  await assert.rejects(repo.git(['cat-file', '-e', `${commit}:meldwork/missing.md`]))
  const subject = await repo.git(['log', '-1', '--format=%s', commit])
  assert.equal(subject.stdout.trim(), 'accept message')
  assert.equal(await repo.acceptCommit({
    effectId: 'accept-1',
    candidate: candidate.commit,
    recordPaths: [],
  }), commit)
  assert.deepEqual(
    fs.readdirSync(gitDir).filter(name => name.startsWith('accept-')),
    [],
  )
})

test('driftAcceptCommit overlays observed paths on the base and removes missing ones', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.md'), 'A')
  fs.writeFileSync(path.join(workTree, 'b.md'), 'B')
  fs.writeFileSync(path.join(workTree, 'c.md'), 'C')
  const base = await repo.snapshot({ effectId: 'drift-base' })
  fs.writeFileSync(path.join(workTree, 'a.md'), 'A2')
  fs.rmSync(path.join(workTree, 'b.md'))
  const observed = await repo.snapshot({ effectId: 'drift-observed' })

  const commit = await repo.driftAcceptCommit({
    effectId: 'drift-accept',
    base: base.commit,
    observed: observed.commit,
    paths: ['a.md', 'b.md'],
    message: 'drift accept',
  })
  assert.equal(await blob(repo, commit, 'a.md'), 'A2')
  await assert.rejects(repo.git(['cat-file', '-e', `${commit}:b.md`]))
  assert.equal(await blob(repo, commit, 'c.md'), 'C')
  assert.equal(await repo.driftAcceptCommit({
    effectId: 'drift-accept',
    base: base.commit,
    observed: observed.commit,
    paths: [],
  }), commit)
})
