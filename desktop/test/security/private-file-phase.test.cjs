const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { atomicWritePrivateFile } = require('../../src/security/private-file.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-private-file-phase-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('atomic writes succeed without an error phase', (t) => {
  const directory = fixture(t)
  const filename = path.join(directory, 'private.json')
  atomicWritePrivateFile(filename, 'data')
  assert.equal(fs.readFileSync(filename, 'utf8'), 'data')
})

test('directory fsync failures report after-commit and keep the new content', (t) => {
  if (process.platform === 'win32') return t.skip('directory handles are not portable on Windows')
  const directory = fixture(t)
  const filename = path.join(directory, 'private.json')
  atomicWritePrivateFile(filename, 'old')
  const original = fs.fsyncSync
  fs.fsyncSync = (descriptor) => {
    if (fs.fstatSync(descriptor).isDirectory()) {
      throw Object.assign(new Error('DIRECTORY_SYNC_FAILED'), { code: 'EIO' })
    }
    return original(descriptor)
  }
  t.after(() => { fs.fsyncSync = original })

  let error
  try {
    atomicWritePrivateFile(filename, 'new')
  } catch (caught) {
    error = caught
  }
  assert.ok(error)
  assert.equal(error.phase, 'after-commit')
  assert.equal(fs.readFileSync(filename, 'utf8'), 'new')
  assert.deepEqual(fs.readdirSync(directory), ['private.json'])
})

test('temporary write failures report before-commit and keep the previous content', (t) => {
  const directory = fixture(t)
  const filename = path.join(directory, 'private.json')
  atomicWritePrivateFile(filename, 'old')
  const original = fs.writeFileSync
  fs.writeFileSync = () => {
    throw Object.assign(new Error('WRITE_FAILED'), { code: 'EIO' })
  }
  t.after(() => { fs.writeFileSync = original })

  let error
  try {
    atomicWritePrivateFile(filename, 'new')
  } catch (caught) {
    error = caught
  }
  assert.ok(error)
  assert.equal(error.phase, 'before-commit')
  assert.equal(fs.readFileSync(filename, 'utf8'), 'old')
  assert.deepEqual(fs.readdirSync(directory), ['private.json'])
})

test('rename failures report before-commit and keep the previous content', (t) => {
  const directory = fixture(t)
  const filename = path.join(directory, 'private.json')
  atomicWritePrivateFile(filename, 'old')
  const original = fs.renameSync
  fs.renameSync = () => {
    throw Object.assign(new Error('RENAME_FAILED'), { code: 'EIO' })
  }
  t.after(() => { fs.renameSync = original })

  let error
  try {
    atomicWritePrivateFile(filename, 'new')
  } catch (caught) {
    error = caught
  }
  assert.ok(error)
  assert.equal(error.phase, 'before-commit')
  assert.equal(fs.readFileSync(filename, 'utf8'), 'old')
  assert.deepEqual(fs.readdirSync(directory), ['private.json'])
})
