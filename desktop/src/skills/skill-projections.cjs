const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  DEFAULT_LIMITS,
  copySkillDirectory,
  displayPath,
  hashSkillDirectory,
  readManagedMarker,
  removeDirectory,
  skillError,
  writeManagedMarker,
} = require('./skill-library-util.cjs')

function projectionId(skillId, agent, scope = 'global') {
  return `proj-${crypto.createHash('sha256')
    .update(`${skillId}\0${agent}\0${scope}`)
    .digest('hex')
    .slice(0, 32)}`
}

function projectionStatus(projection, { skill, limits = DEFAULT_LIMITS, home = '' } = {}) {
  const target = projection?.targetRef
  if (!target || !fs.existsSync(target)) {
    return { status: 'missing', reason: 'SKILL_PROJECTION_MISSING', targetRef: target }
  }
  if (projection.mode === 'copy') {
    const marker = readManagedMarker(target)
    if (!marker || marker.projectionId !== projection.id || marker.skillId !== projection.skillId) {
      return { status: 'conflict', reason: 'SKILL_PROJECTION_CONFLICT', targetRef: target }
    }
  }
  let hashed
  try {
    hashed = hashSkillDirectory(target, limits)
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error?.code || 'SKILL_PROJECTION_UNREADABLE',
      targetRef: target,
    }
  }
  const display = projection.displayPath || displayPath(target, home)
  if (hashed.contentHash !== projection.contentHash) {
    return {
      status: 'drifted',
      reason: 'SKILL_PROJECTION_DRIFTED',
      targetRef: target,
      displayPath: display,
      actualHash: hashed.contentHash,
    }
  }
  if (skill?.contentHash && projection.contentHash !== skill.contentHash) {
    return {
      status: 'outdated',
      reason: 'SKILL_PROJECTION_OUTDATED',
      targetRef: target,
      displayPath: display,
      actualHash: hashed.contentHash,
    }
  }
  return {
    status: 'deployed',
    reason: null,
    targetRef: target,
    displayPath: display,
    actualHash: hashed.contentHash,
  }
}

function backupProjection(target, backupRoot, name, now) {
  if (!backupRoot) return null
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  const destination = path.join(backupRoot, name, stamp)
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  fs.cpSync(target, destination, { recursive: true, force: false, errorOnExist: false })
  return destination
}

function deployCopy({ skill, adapter, projection, backupRoot, limits = DEFAULT_LIMITS, home = '', now = () => new Date() }) {
  if (!adapter?.canProject || !adapter.root) throw skillError('SKILL_UNSUPPORTED_AGENT')
  const target = path.join(adapter.root, skill.name)
  fs.mkdirSync(adapter.root, { recursive: true, mode: 0o700 })

  if (fs.existsSync(target)) {
    const marker = readManagedMarker(target)
    if (!marker || marker.projectionId !== projection.id || marker.skillId !== projection.skillId) {
      throw skillError('SKILL_PROJECTION_CONFLICT')
    }
    backupProjection(target, backupRoot, skill.name, now)
    removeDirectory(target)
  }

  const staging = path.join(adapter.root, `.tyche-tmp-${projection.id}-${process.pid}-${Date.now()}`)
  removeDirectory(staging)
  try {
    copySkillDirectory(skill.sourceDirectory, staging, limits)
    const hashed = hashSkillDirectory(staging, limits)
    writeManagedMarker(staging, {
      schemaVersion: 1,
      projectionId: projection.id,
      skillId: skill.id,
      contentHash: hashed.contentHash,
      mode: 'copy',
      createdAt: new Date(now()).toISOString(),
    })
    fs.renameSync(staging, target)
    return {
      targetRef: target,
      displayPath: displayPath(target, home),
      contentHash: hashed.contentHash,
    }
  } catch (error) {
    removeDirectory(staging)
    throw error
  }
}

function removeProjection(projection) {
  const target = projection?.targetRef
  if (!target || !fs.existsSync(target)) return { removed: false }
  const marker = readManagedMarker(target)
  if (!marker || marker.projectionId !== projection.id || marker.skillId !== projection.skillId) {
    throw skillError('SKILL_PROJECTION_CONFLICT')
  }
  removeDirectory(target)
  return { removed: true }
}

function unmanageProjection(projection) {
  const target = projection?.targetRef
  if (!target || !fs.existsSync(target)) return { removed: false }
  if (projection.mode === 'copy') {
    const marker = readManagedMarker(target)
    if (!marker || marker.projectionId !== projection.id) return { removed: false }
    fs.rmSync(path.join(target, '.tyche-managed.json'), { force: true })
  }
  return { removed: true }
}

module.exports = {
  backupProjection,
  deployCopy,
  projectionId,
  projectionStatus,
  removeProjection,
  unmanageProjection,
}
