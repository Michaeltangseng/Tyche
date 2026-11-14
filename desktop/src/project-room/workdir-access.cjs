'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const MAX_LIST_ENTRIES = 1000

function workdirError(code = 'WORKDIR_PATH_REJECTED') {
  return Object.assign(new Error(code), { code })
}

function foldSegment(segment, caseInsensitive) {
  return caseInsensitive ? segment.toLowerCase() : segment
}

function isGitSegment(segment, volumeInfo = {}) {
  return foldSegment(segment, volumeInfo.caseInsensitive === true) === '.git'
}

function normalizeRelativePath(value, volumeInfo = {}) {
  const raw = String(value ?? '')
  if (raw.includes('\0') || path.isAbsolute(raw)) throw workdirError()
  const separatorNormalized = process.platform === 'win32' ? raw.replace(/\\/g, '/') : raw
  const segments = []
  for (const segment of separatorNormalized.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') throw workdirError()
    const normalized = segment.normalize('NFC')
    if (!normalized || isGitSegment(normalized, volumeInfo)) throw workdirError()
    segments.push(normalized)
  }
  return { relative: segments.join('/'), segments }
}

function pathSegments(absolutePath, caseInsensitive) {
  return String(absolutePath).split(path.sep)
    .filter(Boolean)
    .map(segment => foldSegment(segment.normalize('NFC'), caseInsensitive))
}

function withinRoot(root, candidate, caseInsensitive) {
  const rootSegments = pathSegments(root, caseInsensitive)
  const candidateSegments = pathSegments(candidate, caseInsensitive)
  if (candidateSegments.length < rootSegments.length) return false
  for (let index = 0; index < rootSegments.length; index += 1) {
    if (rootSegments[index] !== candidateSegments[index]) return false
  }
  return true
}

function relativeWithinRoot(root, candidate, caseInsensitive) {
  const rootSegments = pathSegments(root, caseInsensitive)
  const candidateSegments = pathSegments(candidate, caseInsensitive)
  return candidateSegments.slice(rootSegments.length)
}

function isInsideGitBoundary(relativeSegments, volumeInfo = {}) {
  return relativeSegments.some(segment => isGitSegment(segment, volumeInfo))
}

function fdRealPath(fd, { platform = process.platform, execFileFn = execFileAsync } = {}) {
  if (platform === 'linux') {
    return Promise.resolve(fs.readlinkSync(`/proc/self/fd/${fd}`))
  }
  if (platform === 'darwin') {
    return Promise.resolve(execFileFn(
      'lsof', ['-a', '-p', String(process.pid), '-d', String(fd), '-Fn'],
    )).then(({ stdout }) => {
      const line = String(stdout || '').split('\n').find(item => item.startsWith('n'))
      if (!line) throw workdirError()
      return line.slice(1)
    })
  }
  throw workdirError()
}

function verifiedRealPath(realRoot, realPath, volumeInfo) {
  if (!withinRoot(realRoot, realPath, volumeInfo.caseInsensitive === true)) {
    throw workdirError()
  }
  const relativeSegments = relativeWithinRoot(
    realRoot, realPath, volumeInfo.caseInsensitive === true,
  )
  if (isInsideGitBoundary(relativeSegments, volumeInfo)) throw workdirError()
  return relativeSegments
}

async function resolveForRead(
  rootInfo,
  relPath,
  {
    hooks = {},
    fdRealPathFn = fdRealPath,
    platform = process.platform,
  } = {},
) {
  const { relative, segments } = normalizeRelativePath(relPath, rootInfo)
  if (!segments.length) throw workdirError()
  const target = path.join(rootInfo.realRoot, ...segments)
  let fd
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  } catch {
    throw workdirError()
  }
  try {
    await hooks.afterOpen?.({ fd, target })
    const realPath = await fdRealPathFn(fd, { platform })
    await hooks.afterRealPath?.({ fd, target, realPath })
    verifiedRealPath(rootInfo.realRoot, realPath, rootInfo)
    return { fd, realPath, relative }
  } catch (error) {
    fs.closeSync(fd)
    if (error?.code === 'WORKDIR_PATH_REJECTED') throw error
    if (error?.code === 'ENOENT') throw workdirError('WORKDIR_NOT_FOUND')
    throw workdirError()
  }
}

function listEntry(directory, name, volumeInfo) {
  const full = path.join(directory, name)
  let stat
  try {
    stat = fs.lstatSync(full)
  } catch {
    return null
  }
  if (isGitSegment(name, volumeInfo)) {
    return { name, kind: 'metadata', size: 0, mtime: stat.mtime.toISOString() }
  }
  if (stat.isSymbolicLink()) {
    let linkTarget = ''
    try { linkTarget = fs.readlinkSync(full) } catch { /* broken link */ }
    return {
      name,
      kind: 'link',
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      linkTarget,
    }
  }
  return {
    name,
    kind: stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  }
}

async function listDirectory(
  rootInfo,
  relPath,
  cursor = 0,
  {
    hooks = {},
    fdRealPathFn = fdRealPath,
    platform = process.platform,
    limit = MAX_LIST_ENTRIES,
  } = {},
) {
  const { relative, segments } = normalizeRelativePath(relPath, rootInfo)
  const target = path.join(rootInfo.realRoot, ...segments)
  const offset = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0
  let fd
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  } catch {
    throw workdirError()
  }
  try {
    const realPath = await fdRealPathFn(fd, { platform })
    verifiedRealPath(rootInfo.realRoot, realPath, rootInfo)
    await hooks.afterOpen?.({ fd, target, realPath })
    const names = fs.readdirSync(realPath)
    const entries = []
    for (const name of names) {
      const entry = listEntry(realPath, name, rootInfo)
      if (entry) entries.push(entry)
    }
    entries.sort((left, right) => {
      const leftDirectory = left.kind === 'directory' ? 0 : 1
      const rightDirectory = right.kind === 'directory' ? 0 : 1
      return leftDirectory - rightDirectory || left.name.localeCompare(right.name)
    })
    await hooks.beforeDoubleStat?.({ fd, target, realPath })
    const opened = fs.fstatSync(fd)
    const current = fs.statSync(target)
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw workdirError()
    const page = entries.slice(offset, offset + limit)
    const next = offset + page.length
    return {
      entries: page,
      cursor: next < entries.length ? String(next) : null,
      hasMore: next < entries.length,
      relative,
    }
  } finally {
    fs.closeSync(fd)
  }
}

function validateForDiff(rootInfo, relPath) {
  const { relative, segments } = normalizeRelativePath(relPath, rootInfo)
  if (!segments.length) throw workdirError()
  const target = path.join(rootInfo.realRoot, ...segments)
  try {
    const stat = fs.lstatSync(target)
    if (stat) {
      const realPath = fs.realpathSync.native(target)
      verifiedRealPath(rootInfo.realRoot, realPath, rootInfo)
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return relative
    if (error?.code === 'WORKDIR_PATH_REJECTED') throw error
    throw workdirError()
  }
  return relative
}

function trimUtf8Buffer(buffer) {
  let end = buffer.length
  while (end > 0 && (buffer[end - 1] & 0xc0) === 0x80) end -= 1
  if (end === 0) return buffer
  const lead = buffer[end - 1]
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return buffer.length - end + 1 < needed ? buffer.subarray(0, end - 1) : buffer
}

function classifyContent(buffer, name = '') {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '')
  const head = source.subarray(0, 8192)
  if (/\.svg$/i.test(String(name))) return 'text'
  if (head.length >= 8
      && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return 'image'
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image'
  }
  if (head.subarray(0, 4).toString('ascii') === 'GIF8') return 'image'
  if (head.length >= 12
      && head.subarray(0, 4).toString('ascii') === 'RIFF'
      && head.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image'
  }
  if (head.includes(0)) return 'binary'
  const trimmed = trimUtf8Buffer(head)
  if (!trimmed.length && head.length) return 'binary'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(trimmed)
  } catch {
    return 'binary'
  }
  return 'text'
}

function imageMime(buffer) {
  const head = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg'
  if (head.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (head.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp'
  return 'application/octet-stream'
}

module.exports = {
  classifyContent,
  fdRealPath,
  imageMime,
  isGitSegment,
  isInsideGitBoundary,
  listDirectory,
  normalizeRelativePath,
  resolveForRead,
  trimUtf8Buffer,
  validateForDiff,
  withinRoot,
}
