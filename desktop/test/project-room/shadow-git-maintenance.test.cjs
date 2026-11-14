const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ShadowRepo } = require('../../src/project-room/shadow-git.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shadow-maintenance-'))
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

test('dropRefs removes snapshot references', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'a')
  const snapshot = await repo.snapshot({ effectId: 'drop-me' })
  const ref = `refs/meldwork/effects/${require('node:crypto')
    .createHash('sha256').update('drop-me').digest('hex')}`
  await repo.git(['rev-parse', '--verify', ref])
  await repo.dropRefs([ref])
  await assert.rejects(repo.git(['rev-parse', '--verify', ref]))
  assert.equal(typeof snapshot.commit, 'string')
})

test('collectIfNeeded runs gc above the loose-object threshold', async (t) => {
  const { repo, workTree } = await repoFor(t)
  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(workTree, `file-${index}.txt`), `content-${index}`)
  }
  await repo.snapshot({ effectId: 'gc-base' })
  const before = await repo.git(['count-objects', '-v'])
  assert.ok(Number(/^count:\s*(\d+)/m.exec(before.stdout)[1]) > 0)
  const result = await repo.collectIfNeeded({ looseObjectThreshold: 0 })
  assert.equal(result.collected, true)
  assert.ok(result.count > 0)
  const after = await repo.git(['count-objects', '-v'])
  assert.equal(Number(/^count:\s*(\d+)/m.exec(after.stdout)[1]), 0)
})

test('repairIndexIfCorrupt removes a corrupt long-term index', async (t) => {
  const { repo, workTree, gitDir } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'a')
  fs.writeFileSync(path.join(gitDir, 'index'), 'corrupt index')
  const repaired = await repo.repairIndexIfCorrupt()
  assert.deepEqual(repaired, { repaired: true })
  assert.equal(fs.existsSync(path.join(gitDir, 'index')), false)
  const snapshot = await repo.snapshot({ effectId: 'after-repair' })
  assert.equal(snapshot.skipped, false)
})
