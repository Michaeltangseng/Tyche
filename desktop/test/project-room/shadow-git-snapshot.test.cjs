const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ShadowRepo } = require('../../src/project-room/shadow-git.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-shadow-snapshot-'))
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

async function names(repo, commit) {
  const { stdout } = await repo.git(['ls-tree', '-r', '--name-only', commit])
  return stdout.trim() ? stdout.trim().split('\n') : []
}

async function blob(repo, commit, relative) {
  return (await repo.git(['cat-file', 'blob', `${commit}:${relative}`])).stdout
}

test('snapshots include ignored targets and record deletions', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'a')
  fs.mkdirSync(path.join(workTree, 'meldwork'))
  fs.writeFileSync(path.join(workTree, '.gitignore'), 'meldwork/\n')
  fs.writeFileSync(path.join(workTree, 'meldwork', 'target.md'), 'target')

  const first = await repo.snapshot({
    effectId: 'first',
    targets: ['meldwork/target.md', 'meldwork/missing.md'],
  })
  assert.equal(first.skipped, false)
  assert.deepEqual((await names(repo, first.commit)).sort(), [
    '.gitignore', 'a.txt', 'meldwork/target.md',
  ])

  fs.rmSync(path.join(workTree, 'a.txt'))
  const second = await repo.snapshot({ effectId: 'second' })
  assert.deepEqual(await names(repo, second.commit), [
    '.gitignore', 'meldwork/target.md',
  ])
  const diff = await repo.git(['diff', '--name-status', first.commit, second.commit])
  assert.match(diff.stdout, /^D\sa\.txt$/m)
})

test('the same effect id returns the same commit', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'a')
  const first = await repo.snapshot({ effectId: 'same' })
  const second = await repo.snapshot({ effectId: 'same' })
  assert.equal(second.commit, first.commit)
})

test('raw bytes keep CRLF and line-ending changes are detected', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, '.gitattributes'), '*.txt text eol=lf\n')
  fs.writeFileSync(path.join(workTree, 'crlf.txt'), 'A\r\nB\r\n')
  const first = await repo.snapshot({ effectId: 'raw-first' })
  assert.ok((await blob(repo, first.commit, 'crlf.txt')).includes('\r\n'))

  fs.writeFileSync(path.join(workTree, 'crlf.txt'), 'A\nB\n')
  const second = await repo.snapshot({ effectId: 'raw-second' })
  await assert.rejects(
    repo.git(['diff', '--quiet', first.commit, second.commit, '--', 'crlf.txt']),
    (error) => error.code === 1,
  )
})

test('oversize files become placeholders and targets above the limit fail', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'big.bin'), Buffer.alloc(64, 'A'))
  const result = await repo.snapshot({
    effectId: 'oversize',
    limits: { maxFileBytes: 16 },
  })
  assert.equal(result.placeholderList.length, 1)
  assert.equal(result.placeholderList[0].reason, 'oversize')
  assert.equal(result.placeholderList[0].size, 64)
  const placeholder = await blob(repo, result.commit, 'big.bin')
  assert.match(placeholder, /^meldwork-placeholder 1$/m)
  assert.match(placeholder, /^reason oversize$/m)
  const size = Number((await repo.git(['cat-file', '-s', `${result.commit}:big.bin`])).stdout.trim())
  assert.ok(size < 200)

  await assert.rejects(
    repo.snapshot({
      effectId: 'target-too-large',
      targets: ['big.bin'],
      limits: { maxFileBytes: 16 },
    }),
    (error) => error.code === 'SHADOW_TARGET_TOO_LARGE' && error.file === 'big.bin',
  )
})

test('placeholder paths disappear, shrink and become links correctly', async (t) => {
  const { repo, workTree } = await repoFor(t)
  const big = path.join(workTree, 'big.bin')
  fs.writeFileSync(big, Buffer.alloc(64, 'A'))
  const first = await repo.snapshot({ effectId: 'ph-first', limits: { maxFileBytes: 16 } })

  fs.rmSync(big)
  const removed = await repo.snapshot({
    effectId: 'ph-removed',
    placeholderList: first.placeholderList,
    limits: { maxFileBytes: 16 },
  })
  assert.deepEqual(removed.placeholderList, [])
  assert.equal((await names(repo, removed.commit)).includes('big.bin'), false)

  fs.writeFileSync(big, Buffer.alloc(64, 'B'))
  const second = await repo.snapshot({ effectId: 'ph-second', limits: { maxFileBytes: 16 } })
  fs.writeFileSync(big, Buffer.alloc(8, 'C'))
  const shrunk = await repo.snapshot({
    effectId: 'ph-shrunk',
    placeholderList: second.placeholderList,
    limits: { maxFileBytes: 16 },
  })
  assert.deepEqual(shrunk.placeholderList, [])
  assert.equal((await blob(repo, shrunk.commit, 'big.bin')).length, 8)

  fs.writeFileSync(big, Buffer.alloc(64, 'D'))
  fs.writeFileSync(path.join(workTree, 'target.txt'), 'target')
  const third = await repo.snapshot({ effectId: 'ph-third', limits: { maxFileBytes: 16 } })
  fs.rmSync(big)
  fs.symlinkSync('target.txt', big)
  const linked = await repo.snapshot({
    effectId: 'ph-linked',
    placeholderList: third.placeholderList,
    limits: { maxFileBytes: 16 },
  })
  assert.deepEqual(linked.placeholderList, [])
  const tree = await repo.git(['ls-tree', linked.commit, '--', 'big.bin'])
  assert.match(tree.stdout, /^120000 /m)
})

test('placeholder hashes are recomputed when ctime changes', async (t) => {
  const { repo, workTree } = await repoFor(t)
  const filename = path.join(workTree, 'hash.bin')
  fs.writeFileSync(filename, Buffer.alloc(64, 'A'))
  const first = await repo.snapshot({ effectId: 'hash-first', limits: { maxFileBytes: 16 } })
  const previous = fs.statSync(filename)
  fs.writeFileSync(filename, Buffer.alloc(64, 'B'))
  fs.utimesSync(filename, previous.atime, previous.mtime)
  const second = await repo.snapshot({
    effectId: 'hash-second',
    placeholderList: first.placeholderList,
    limits: { maxFileBytes: 16 },
  })
  assert.notEqual(first.placeholderList[0].sha256, second.placeholderList[0].sha256)
})

test('optional snapshots skip on limits while required snapshots fail', async (t) => {
  const { repo, workTree } = await repoFor(t)
  fs.writeFileSync(path.join(workTree, 'a.txt'), 'a')
  const skipped = await repo.snapshot({
    effectId: 'skip-files',
    limits: { maxFiles: 0 },
    isOptional: true,
  })
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.reason, 'files')
  await assert.rejects(
    repo.snapshot({ effectId: 'fail-files', limits: { maxFiles: 0 } }),
    (error) => error.code === 'SHADOW_SNAPSHOT_LIMIT',
  )
  const duration = await repo.snapshot({
    effectId: 'skip-duration',
    limits: { maxDurationMs: -1 },
    isOptional: true,
  })
  assert.equal(duration.skipped, true)
  assert.equal(duration.reason, 'duration')
})

test('user-repository LFS paths become placeholders without reading through the filter', async (t) => {
  const { repo, workTree } = await repoFor(t)
  execFileSync('git', ['init', '--quiet'], { cwd: workTree })
  fs.writeFileSync(path.join(workTree, '.gitattributes'),
    '*.bin filter=lfs diff=lfs merge=lfs -text\n')
  fs.writeFileSync(path.join(workTree, 'asset.bin'), Buffer.alloc(64, 'L'))
  const result = await repo.snapshot({ effectId: 'lfs' })
  assert.equal(result.placeholderList.length, 1)
  assert.equal(result.placeholderList[0].reason, 'lfs')
  assert.match(await blob(repo, result.commit, 'asset.bin'), /^reason lfs$/m)
})
