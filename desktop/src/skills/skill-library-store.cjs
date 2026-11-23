const fs = require('node:fs')
const path = require('node:path')

const {
  isPlainObject,
  readJsonFile,
  skillError,
  writeJsonAtomic,
} = require('./skill-library-util.cjs')

const SCHEMA_VERSION = 2
const DEFAULT_POLICY = Object.freeze({
  untrustedByDefault: true,
  revokeOnChange: true,
  denySkillNetwork: false,
})

function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    policy: { ...DEFAULT_POLICY },
    sources: {},
    releases: {},
    skills: {},
    approvedHashes: {},
    projections: {},
    defaults: {},
  }
}

function plainMap(value) {
  if (!isPlainObject(value)) return {}
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isPlainObject(entry)) result[key] = entry
  }
  return result
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

function normalizeStore(value) {
  if (!isPlainObject(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw skillError('SKILL_LIBRARY_STORE_INVALID')
  }
  const policy = isPlainObject(value.policy) ? value.policy : {}
  return {
    schemaVersion: SCHEMA_VERSION,
    policy: {
      untrustedByDefault: policy.untrustedByDefault !== false,
      revokeOnChange: policy.revokeOnChange !== false,
      denySkillNetwork: policy.denySkillNetwork === true,
    },
    sources: plainMap(value.sources),
    releases: plainMap(value.releases),
    skills: plainMap(value.skills),
    approvedHashes: plainMap(value.approvedHashes),
    projections: plainMap(value.projections),
    defaults: Object.fromEntries(Object.entries(plainMap(value.defaults))
      .map(([agent, ids]) => [agent, stringArray(ids)])),
  }
}

function isoOrNow(value, now) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : now().toISOString()
}

function migrateLegacyInventory(legacy, now) {
  if (!isPlainObject(legacy) || legacy.schemaVersion !== 1) return null
  const store = emptyStore()
  const trust = isPlainObject(legacy.trust) ? legacy.trust : {}
  for (const [id, record] of Object.entries(trust)) {
    if (!isPlainObject(record) || !/^[a-f0-9]{64}$/.test(String(record.contentHash || ''))) continue
    const approvedAt = isoOrNow(record.trustedAt, now)
    store.approvedHashes[record.contentHash] = {
      approvedAt,
      preview: '',
      fileManifest: [],
      risk: null,
      migrated: true,
    }
    store.skills[id] = {
      ...(store.skills[id] || {}),
      approvedHash: record.contentHash,
    }
  }
  const eligibility = isPlainObject(legacy.eligibility) ? legacy.eligibility : {}
  for (const [id, agents] of Object.entries(eligibility)) {
    if (!Array.isArray(agents)) continue
    store.skills[id] = {
      ...(store.skills[id] || {}),
      nativeEligible: agents.filter(agent => typeof agent === 'string'),
    }
  }
  const defaults = isPlainObject(legacy.defaults) ? legacy.defaults : {}
  for (const [agent, ids] of Object.entries(defaults)) {
    if (Array.isArray(ids)) store.defaults[agent] = ids.filter(id => typeof id === 'string')
  }
  return store
}

class SkillLibraryStore {
  constructor({ storagePath, legacyPath = '', now = () => new Date() }) {
    if (typeof storagePath !== 'string' || !path.isAbsolute(storagePath)) {
      throw skillError('SKILL_LIBRARY_STORE_INVALID')
    }
    this.storagePath = path.normalize(storagePath)
    this.legacyPath = typeof legacyPath === 'string' && path.isAbsolute(legacyPath)
      ? path.normalize(legacyPath)
      : ''
    this.now = now
    this.lastError = null
    this.migrated = false
  }

  backupInvalid(reason) {
    this.lastError = reason
    try {
      if (fs.existsSync(this.storagePath)) {
        fs.renameSync(this.storagePath, `${this.storagePath}.invalid-${Date.now()}`)
      }
    } catch { /* the store starts empty even when the backup cannot be written */ }
  }

  load() {
    this.lastError = null
    if (fs.existsSync(this.storagePath)) {
      try {
        return normalizeStore(readJsonFile(this.storagePath))
      } catch {
        this.backupInvalid('SKILL_LIBRARY_STORE_INVALID')
        return emptyStore()
      }
    }
    if (this.legacyPath && fs.existsSync(this.legacyPath)) {
      try {
        const legacy = readJsonFile(this.legacyPath)
        const migrated = migrateLegacyInventory(legacy, this.now)
        if (migrated) {
          this.save(migrated)
          this.migrated = true
          try { fs.renameSync(this.legacyPath, `${this.legacyPath}.bak`) } catch { /* keep the old file */ }
          return migrated
        }
      } catch {
        this.lastError = 'SKILL_LIBRARY_MIGRATION_FAILED'
      }
    }
    return emptyStore()
  }

  save(store) {
    writeJsonAtomic(this.storagePath, store, 0o600)
  }
}

module.exports = {
  DEFAULT_POLICY,
  SCHEMA_VERSION,
  SkillLibraryStore,
  emptyStore,
  migrateLegacyInventory,
  normalizeStore,
}
