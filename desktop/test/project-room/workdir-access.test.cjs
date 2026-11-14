const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  classifyContent,
  fdRealPath,
  listDirectory,
  normalizeRelativePath,
  resolveForRead,
  validateForDiff,
} = require('../../src/project-room/workdir-access.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-workdir-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-outside-'))
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(root, 'readme.md'), 'hello\n')
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'external secret\n')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'inside\n')
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, '.git', 'config'), 'secret git config\n')
  return {
    root,
    outside,
    rootInfo: {
      realRoot: fs.realpathSync.native(root),
      caseInsensitive: process.platform === 'darwin',
    },
  }
}

test('relative paths reject traversal, absolute paths, NUL, and .git segments', () => {
  const volume = { caseInsensitive: false }
  assert.equal(normalizeRelativePath('docs/a.md', volume).relative, 'docs/a.md')
  assert.equal(normalizeRelativePath('./docs/./a.md', volume).relative, 'docs/a.md')
  for (const value of ['../secret', 'docs/../secret', '/etc/passwd', 'docs/a\0b', '.git/config']) {
    assert.throws(() => normalizeRelativePath(value, volume), { code: 'WORKDIR_PATH_REJECTED' })
  }
  assert.throws(
    () => normalizeRelativePath('.GIT/config', { caseInsensitive: true }),
    { code: 'WORKDIR_PATH_REJECTED' },
  )
  assert.equal(
    normalizeRelativePath('.GIT/config', { caseInsensitive: false }).relative,
    '.GIT/config',
  )
})

test('reading follows the opened descriptor and rejects escapes and .git', async (t) => {
  const { root, outside, rootInfo } = fixture(t)
  const read = await resolveForRead(rootInfo, 'readme.md')
  try {
    assert.equal(fs.readFileSync(read.fd, 'utf8'), 'hello\n')
    assert.equal(read.realPath, fs.realpathSync.native(path.join(root, 'readme.md')))
  } finally {
    fs.closeSync(read.fd)
  }
  await assert.rejects(resolveForRead(rootInfo, '.git/config'), { code: 'WORKDIR_PATH_REJECTED' })

  fs.symlinkSync(outside, path.join(root, 'alias'), 'dir')
  await assert.rejects(
    resolveForRead(rootInfo, 'alias/secret.txt'),
    { code: 'WORKDIR_PATH_REJECTED' },
  )
  const opened = await resolveForRead(rootInfo, 'readme.md')
  try {
    const real = await fdRealPath(opened.fd)
    assert.equal(real, fs.realpathSync.native(path.join(root, 'readme.md')))
  } finally {
    fs.closeSync(opened.fd)
  }
})

test('a directory swap after open still reads the original file', async (t) => {
  const { root, rootInfo } = fixture(t)
  const doc = path.join(root, 'sub', 'file.txt')
  let swapped = false
  const opened = await resolveForRead(rootInfo, 'sub/file.txt', {
    hooks: {
      afterOpen({ target }) {
        if (swapped) return
        swapped = true
        fs.rmSync(path.join(root, 'sub'), { recursive: true, force: true })
        fs.symlinkSync(path.dirname(target), path.join(root, 'sub-alias'), 'dir')
      },
    },
  }).catch(error => error)
  // The hook replaces the path after the descriptor is open; the descriptor
  // still points at the original file.
  if (opened?.fd) {
    try {
      assert.equal(fs.readFileSync(opened.fd, 'utf8'), 'inside\n')
    } finally {
      fs.closeSync(opened.fd)
    }
  } else {
    // Some platforms may reject the missing path during the real-path check.
    assert.equal(opened.code, 'WORKDIR_PATH_REJECTED')
  }
})

test('an ancestor swap before open is rejected by the descriptor real path', async (t) => {
  const { root, outside, rootInfo } = fixture(t)
  fs.renameSync(path.join(root, 'sub'), path.join(root, 'sub-real'))
  fs.symlinkSync(outside, path.join(root, 'sub'), 'dir')
  await assert.rejects(
    resolveForRead(rootInfo, 'sub/secret.txt'),
    { code: 'WORKDIR_PATH_REJECTED' },
  )
})

test('listDirectory marks .git as metadata and paginates', async (t) => {
  const { rootInfo } = fixture(t)
  const first = await listDirectory(rootInfo, '', 0, { limit: 2 })
  assert.equal(first.entries.length, 2)
  assert.equal(first.hasMore, true)
  assert.equal(first.entries[0].kind, 'directory')
  const all = await listDirectory(rootInfo, '', 0, { limit: 100 })
  const git = all.entries.find(entry => entry.name === '.git')
  assert.equal(git.kind, 'metadata')
  const total = all.entries.length
  const second = await listDirectory(rootInfo, '', Number(first.cursor), { limit: 100 })
  assert.equal(second.entries.length, total - 2)
})

test('listDirectory discards results when the directory inode changes', async (t) => {
  const { root, outside, rootInfo } = fixture(t)
  await assert.rejects(
    listDirectory(rootInfo, 'sub', 0, {
      hooks: {
        beforeDoubleStat() {
          fs.rmSync(path.join(root, 'sub'), { recursive: true, force: true })
          fs.symlinkSync(outside, path.join(root, 'sub'), 'dir')
        },
      },
    }),
    { code: 'WORKDIR_PATH_REJECTED' },
  )
})

test('validateForDiff allows deleted paths and rejects .git and external links', (t) => {
  const { root, outside, rootInfo } = fixture(t)
  assert.equal(validateForDiff(rootInfo, 'sub/missing.md'), 'sub/missing.md')
  assert.throws(() => validateForDiff(rootInfo, '.git/config'), { code: 'WORKDIR_PATH_REJECTED' })
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'outside-link'))
  assert.throws(() => validateForDiff(rootInfo, 'outside-link'), { code: 'WORKDIR_PATH_REJECTED' })
})

test('classifyContent distinguishes text, images, SVG, and binary', () => {
  assert.equal(classifyContent(Buffer.from('hello\n'), 'a.txt'), 'text')
  assert.equal(classifyContent(Buffer.from([0, 1, 2]), 'a.bin'), 'binary')
  assert.equal(classifyContent(Buffer.from([0xe4, 0xbd]), 'a.txt'), 'binary')
  assert.equal(classifyContent(Buffer.from('<svg></svg>'), 'icon.svg'), 'text')
  assert.equal(classifyContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), 'a.png'), 'image')
  assert.equal(classifyContent(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'a.jpg'), 'image')
  assert.equal(classifyContent(Buffer.from('GIF89a', 'ascii'), 'a.gif'), 'image')
  assert.equal(classifyContent(Buffer.from('RIFF0000WEBP', 'ascii'), 'a.webp'), 'image')
})
