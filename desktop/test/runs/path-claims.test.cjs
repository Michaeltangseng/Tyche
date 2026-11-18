const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  claimsConflict,
  makeClaim,
  normalizeRelativePath,
  resolveClaimPath,
  resolveRoot,
} = require('../../src/runs/path-claims.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-path-claims-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('normalizeRelativePath normalizes, rejects traversal and absolute paths', () => {
  assert.equal(normalizeRelativePath('a//b/./c'), 'a/b/c')
  assert.equal(normalizeRelativePath(''), '')
  assert.equal(normalizeRelativePath('.'), '')
  assert.equal(normalizeRelativePath('cafe\u0301'), 'caf\u00e9')
  for (const invalid of ['a/../b', '/abs', 'C:\\abs', 'C:foo', 'a\0b']) {
    assert.throws(
      () => normalizeRelativePath(invalid),
      (error) => error.code === 'SCHEDULER_CLAIM_PATH_INVALID',
      invalid,
    )
  }
})

test('claims conflict on equal and prefix paths but not sibling names', async (t) => {
  const root = fixture(t)
  const parent = await makeClaim({ root, path: 'a' })
  const child = await makeClaim({ root, path: 'a/b' })
  const sibling = await makeClaim({ root, path: 'a/bc' })
  assert.equal(claimsConflict(parent, child), true)
  assert.equal(claimsConflict(child, parent), true)
  assert.equal(claimsConflict(parent, parent), true)
  assert.equal(claimsConflict(child, sibling), false)
})

test('shared-legacy claims do not conflict with each other but do with exclusive claims', async (t) => {
  const root = fixture(t)
  const first = await makeClaim({ root, path: 'a', mode: 'shared-legacy' })
  const second = await makeClaim({ root, path: 'a/b', mode: 'shared-legacy' })
  const exclusive = await makeClaim({ root, path: 'a/b', mode: 'exclusive' })
  assert.equal(claimsConflict(first, second), false)
  assert.equal(claimsConflict(first, exclusive), true)
})

test('claims on different volumes do not conflict', () => {
  const first = { volumeId: 1, key: '/same/path', mode: 'exclusive' }
  const second = { volumeId: 2, key: '/same/path', mode: 'exclusive' }
  assert.equal(claimsConflict(first, second), false)
})

test('case-insensitive volumes compare paths case-insensitively', async (t) => {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, 'Docs'))
  const upper = await makeClaim({ root, path: 'Docs/A.md' })
  const lower = await makeClaim({ root, path: 'docs/a.md' })
  const rootInfo = await resolveRoot(root)
  assert.equal(claimsConflict(upper, lower), rootInfo.caseInsensitive)

  const upperSensitive = await makeClaim({ root, path: 'Docs/A.md', caseInsensitive: false })
  const lowerSensitive = await makeClaim({ root, path: 'docs/a.md', caseInsensitive: false })
  assert.equal(claimsConflict(upperSensitive, lowerSensitive), false)
})

test('NFC and NFD spellings of the same path conflict', async (t) => {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, 'caf\u00e9'))
  const composed = await makeClaim({ root, path: 'caf\u00e9/file.md' })
  const decomposed = await makeClaim({ root, path: 'cafe\u0301/file.md' })
  assert.equal(claimsConflict(composed, decomposed), true)
})

test('resolves internal symlinks and missing tails through the nearest existing ancestor', async (t) => {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, 'docs'))
  fs.writeFileSync(path.join(root, 'docs', 'spec.md'), 'x')
  fs.symlinkSync('docs', path.join(root, 'alias'))
  const alias = await makeClaim({ root, path: 'alias/spec.md' })
  const direct = await makeClaim({ root, path: 'docs/spec.md' })
  assert.equal(claimsConflict(alias, direct), true)

  const missing = await makeClaim({ root, path: 'docs/new/file.md' })
  assert.ok(missing.key.endsWith(`${path.sep}docs${path.sep}new${path.sep}file.md`))
})

test('rejects claims that resolve outside the root through a symlink', async (t) => {
  const root = fixture(t)
  const outside = fixture(t)
  fs.mkdirSync(path.join(outside, 'secret'))
  fs.symlinkSync(outside, path.join(root, 'escape'))
  await assert.rejects(
    makeClaim({ root, path: 'escape/secret' }),
    (error) => error.code === 'SCHEDULER_CLAIM_OUTSIDE_ROOT',
  )
  await assert.rejects(
    makeClaim({ root, path: 'escape/another/new-file' }),
    (error) => error.code === 'SCHEDULER_CLAIM_OUTSIDE_ROOT',
  )
})

test('resolveRoot and resolveClaimPath return the resolved root and inside path', async (t) => {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, 'nested'))
  const rootInfo = await resolveRoot(root)
  assert.equal(rootInfo.realRoot, fs.realpathSync.native(root))
  assert.equal(Number.isInteger(rootInfo.volumeId), true)
  const resolved = await resolveClaimPath(rootInfo, 'nested/file.md')
  assert.equal(resolved, path.join(rootInfo.realRoot, 'nested', 'file.md'))
})
