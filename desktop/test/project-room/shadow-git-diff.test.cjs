const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ShadowRepo } = require('../../src/project-room/shadow-git.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shadow-diff-'))
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

test('numstat reports text, binary and rename entries', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'one\ntwo\n')
  fs.writeFileSync(path.join(workTree, 'bin.dat'), Buffer.from([0, 1, 2]))
  fs.writeFileSync(path.join(workTree, 'rename.txt'), 'rename\n')
  const first = await repo.snapshot({ effectId: 'numstat-first' })
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'one\nchanged\n')
  fs.writeFileSync(path.join(workTree, 'bin.dat'), Buffer.from([0, 3, 4]))
  fs.renameSync(path.join(workTree, 'rename.txt'), path.join(workTree, 'renamed.txt'))
  const second = await repo.snapshot({ effectId: 'numstat-second' })

  const entries = await repo.numstat(first.commit, second.commit)
  const text = entries.find(entry => entry.path === 'a.txt')
  assert.equal(text.added, 1)
  assert.equal(text.removed, 1)
  assert.equal(text.binary, false)
  const binary = entries.find(entry => entry.path === 'bin.dat')
  assert.equal(binary.binary, true)
  assert.equal(binary.added, null)
  const renamed = entries.find(entry => entry.path === 'renamed.txt')
  assert.ok(renamed)
  assert.equal(renamed.oldPath, 'rename.txt')
})

test('fileDiff returns a unified diff, worktree diffs and truncation', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'one\ntwo\n')
  const first = await repo.snapshot({ effectId: 'diff-first' })
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'one\nchanged\n')
  const second = await repo.snapshot({ effectId: 'diff-second' })

  const diff = await repo.fileDiff(first.commit, second.commit, 'a.txt')
  assert.equal(diff.truncated, false)
  assert.match(diff.text, /@@/)
  assert.match(diff.text, /-two/)
  assert.match(diff.text, /\+changed/)
  const truncated = await repo.fileDiff(first.commit, second.commit, 'a.txt', { maxBytes: 5 })
  assert.equal(truncated.truncated, true)
  assert.ok(Buffer.byteLength(truncated.text) <= 5)

  fs.writeFileSync(path.join(workTree, 'a.txt'), 'one\nworktree\n')
  const worktreeDiff = await repo.fileDiff(first.commit, null, 'a.txt')
  assert.match(worktreeDiff.text, /\+worktree/)
})
