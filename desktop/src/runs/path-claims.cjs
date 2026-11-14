const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const caseSensitivityCache = new Map()

function claimsError(code) {
  return Object.assign(new Error(code), { code })
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw claimsError('SCHEDULER_CLAIM_PATH_INVALID')
  }
  // Paths are stored with '/' separators regardless of the input platform.
  const text = value.replace(/\\/g, '/').normalize('NFC')
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
    throw claimsError('SCHEDULER_CLAIM_PATH_INVALID')
  }
  const segments = []
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') throw claimsError('SCHEDULER_CLAIM_PATH_INVALID')
    segments.push(segment)
  }
  return segments.join('/')
}

function probeCaseSensitivity(directory) {
  const token = `meldwork-case-${crypto.randomBytes(8).toString('hex')}a`
  const filename = path.join(directory, token)
  const upper = path.join(directory, token.toUpperCase())
  try {
    fs.writeFileSync(filename, '', { flag: 'wx', mode: 0o600 })
    try {
      fs.statSync(upper)
      return true
    } catch {
      return false
    }
  } catch {
    // An unwritable directory cannot be probed; treat it as case-sensitive.
    return false
  } finally {
    try { fs.rmSync(filename, { force: true }) } catch { /* already gone */ }
  }
}

async function resolveRoot(root, options = {}) {
  if (typeof root !== 'string' || !root || root.includes('\0')) {
    throw claimsError('SCHEDULER_CLAIM_ROOT_INVALID')
  }
  let realRoot
  try {
    realRoot = fs.realpathSync.native(path.resolve(root))
  } catch {
    throw claimsError('SCHEDULER_CLAIM_ROOT_INVALID')
  }
  let stat
  try {
    stat = fs.statSync(realRoot)
  } catch {
    throw claimsError('SCHEDULER_CLAIM_ROOT_INVALID')
  }
  if (!stat.isDirectory()) throw claimsError('SCHEDULER_CLAIM_ROOT_INVALID')
  const volumeId = stat.dev
  let caseInsensitive
  if (options.caseInsensitive != null) {
    caseInsensitive = options.caseInsensitive === true
  } else {
    caseInsensitive = caseSensitivityCache.get(volumeId)
    if (caseInsensitive === undefined) {
      caseInsensitive = probeCaseSensitivity(realRoot)
      caseSensitivityCache.set(volumeId, caseInsensitive)
    }
  }
  return { realRoot, volumeId, caseInsensitive }
}

function pathSegments(value, caseInsensitive) {
  const normalized = value.normalize('NFC')
  const segments = normalized.split(path.sep).filter(Boolean)
  return caseInsensitive ? segments.map(segment => segment.toLowerCase()) : segments
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

async function resolveClaimPath(rootInfo, relativePath) {
  const relative = normalizeRelativePath(relativePath)
  const candidate = relative
    ? path.join(rootInfo.realRoot, relative)
    : rootInfo.realRoot
  let resolved
  try {
    resolved = fs.realpathSync.native(candidate)
  } catch {
    // Resolve the nearest existing ancestor and append the missing tail.
    let ancestor = candidate
    const tail = []
    for (;;) {
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw claimsError('SCHEDULER_CLAIM_OUTSIDE_ROOT')
      tail.unshift(path.basename(ancestor))
      ancestor = parent
      if (fs.existsSync(ancestor)) break
    }
    let resolvedAncestor
    try {
      resolvedAncestor = fs.realpathSync.native(ancestor)
    } catch {
      throw claimsError('SCHEDULER_CLAIM_OUTSIDE_ROOT')
    }
    resolved = path.join(resolvedAncestor, ...tail)
  }
  if (!withinRoot(rootInfo.realRoot, resolved, rootInfo.caseInsensitive)) {
    throw claimsError('SCHEDULER_CLAIM_OUTSIDE_ROOT')
  }
  return resolved.normalize('NFC')
}

async function makeClaim({ root, path: relative = '', mode = 'exclusive', caseInsensitive } = {}) {
  if (mode !== 'exclusive' && mode !== 'shared-legacy') {
    throw claimsError('SCHEDULER_CLAIM_MODE_INVALID')
  }
  const rootInfo = await resolveRoot(root, { caseInsensitive })
  const resolved = await resolveClaimPath(rootInfo, relative)
  const normalized = resolved.normalize('NFC')
  const key = rootInfo.caseInsensitive ? normalized.toLowerCase() : normalized
  return { volumeId: rootInfo.volumeId, key, mode }
}

function isPathPrefix(parent, child) {
  if (parent === child) return true
  const separator = path.sep
  const withSeparator = parent.endsWith(separator) ? parent : `${parent}${separator}`
  return child.startsWith(withSeparator)
}

function claimsOverlap(a, b) {
  if (!a || !b || a.volumeId !== b.volumeId) return false
  return isPathPrefix(a.key, b.key) || isPathPrefix(b.key, a.key)
}

function claimsConflict(a, b) {
  if (!a || !b || a.volumeId !== b.volumeId) return false
  if (a.mode === 'shared-legacy' && b.mode === 'shared-legacy') return false
  return claimsOverlap(a, b)
}

module.exports = {
  claimsConflict,
  claimsOverlap,
  makeClaim,
  normalizeRelativePath,
  resolveClaimPath,
  resolveRoot,
}
