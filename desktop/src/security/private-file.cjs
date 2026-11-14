const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('PRIVATE_DIRECTORY_INVALID')
  }
  if (process.platform === 'win32') return
  const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0)
  const descriptor = fs.openSync(directory, flags)
  try {
    if (!fs.fstatSync(descriptor).isDirectory()) throw new Error('PRIVATE_DIRECTORY_INVALID')
    fs.fchmodSync(descriptor, 0o700)
  } finally {
    fs.closeSync(descriptor)
  }
}

function atomicWritePrivateFile(filename, contents) {
  const directory = path.dirname(filename)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  )
  let descriptor
  let committed = false
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, contents, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.chmodSync(temporaryPath, 0o600)
    fs.renameSync(temporaryPath, filename)
    // Rename is the commit point: from here on the new contents are already
    // on disk even if the following directory fsync fails (M1/M5 6.1).
    committed = true
    let directoryDescriptor
    try {
      directoryDescriptor = fs.openSync(directory, 'r')
      fs.fsyncSync(directoryDescriptor)
    } catch (error) {
      const unsupported = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)
        || (process.platform === 'win32' && ['EPERM', 'EISDIR'].includes(error.code))
      if (!unsupported) throw error
    } finally {
      if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor)
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
    }
    try { fs.unlinkSync(temporaryPath) } catch { /* absent or already renamed */ }
    if (error && typeof error === 'object' && error.phase === undefined) {
      error.phase = committed ? 'after-commit' : 'before-commit'
    }
    throw error
  }
}

module.exports = { atomicWritePrivateFile, ensurePrivateDirectory }
