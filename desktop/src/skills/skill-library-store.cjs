const fs = require('node:fs')
const path = require('node:path')

const {
  isPlainObject,
  readJsonFile,
  skillError,
  writeJsonAtomic,
} = require('./skill-library-util.cjs')

// v3 keeps only platform-library facts. Trust approvals, projections and
// policy are gone: a Skill in the library is usable.
const SCHEMA_VERSION = 3
const LEGACY_VERSIONS = new Set([1, 2])

function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    sources: {},
    skills: {},
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

function defaultsMap(value) {
  if (!isPlainObject(value)) return {}
  const result = {}
  for (const [agent, ids] of Object.entries(value)) {
    if (typeof agent !== 'string' || !Array.isArray(ids)) continue
    result[agent] = stringArray(ids)
  }
  return result
}

function normalizeStore(value) {
  if (!isPlainObject(value)) throw skillError('SKILL_LIBRARY_STORE_INVALID')
  const version = Number(value.schemaVersion)
  if (version !== SCHEMA_VERSION && !LEGACY_VERSIONS.has(version)) {
    throw skillError('SKILL_LIBRARY_STORE_INVALID')
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sources: plainMap(value.sources),
    skills: plainMap(value.skills),
    defaults: defaultsMap(value.defaults),
  }
}

function migrateLegacyInventory(legacy) {
  if (!isPlainObject(legacy) || legacy.schemaVersion !== 1) return null
  const store = emptyStore()
  const defaults = isPlainObject(legacy.defaults) ? legacy.defaults : {}
  for (const [agent, ids] of Object.entries(defaults)) {
    if (Array.isArray(ids)) store.defaults[agent] = stringArray(ids)
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
        const raw = readJsonFile(this.storagePath)
        const store = normalizeStore(raw)
        // Persist the v2 -> v3 shape once so retired fields do not linger.
        if (raw?.schemaVersion !== SCHEMA_VERSION) this.save(store)
        return store
      } catch {
        this.backupInvalid('SKILL_LIBRARY_STORE_INVALID')
        return emptyStore()
      }
    }
    if (this.legacyPath && fs.existsSync(this.legacyPath)) {
      try {
        const legacy = readJsonFile(this.legacyPath)
        const migrated = migrateLegacyInventory(legacy)
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
  SCHEMA_VERSION,
  SkillLibraryStore,
  emptyStore,
  migrateLegacyInventory,
  normalizeStore,
}
