const fs = require('node:fs')
const path = require('node:path')

const { LocalSkillCatalog } = require('./local-skill-catalog.cjs')
const { SkillLibraryStore } = require('./skill-library-store.cjs')
const { AGENT_KINDS, adapterFor, agentCapabilities, agentLabel } = require('./skill-adapters.cjs')
const { scanSkill } = require('./skill-risk.cjs')
const {
  backupProjection,
  deployCopy,
  projectionId,
  projectionStatus,
  removeProjection,
  unmanageProjection,
} = require('./skill-projections.cjs')
const {
  DEFAULT_LIMITS,
  cleanLine,
  copySkillDirectory,
  displayPath,
  fail,
  frontmatterFields,
  hashSkillDirectory,
  nativeSkillId,
  normalizeSkillMarkdown,
  readManagedMarker,
  readProvenance,
  removeDirectory,
  replaceSkillBody,
  safeReadSkillDirectory,
  safeSkillName,
  sharedSkillId,
  skillError,
  skillMarkdownTemplate,
  treeSignature,
  validSkillName,
  writeProvenance,
} = require('./skill-library-util.cjs')

const MAX_ROLE_SKILLS = 8
const MAX_CAPTAIN_SKILLS = 24
const CAPTAIN_DESCRIPTION_LIMIT = 80
const SCAN_CACHE_MS = 1500
const MAX_BODY_INPUT = 40000

function nowIso(now) {
  return now().toISOString()
}

function skillUpdatedAt(directory) {
  try {
    return new Date(fs.statSync(path.join(directory, 'SKILL.md')).mtimeMs).toISOString()
  } catch {
    return null
  }
}

function sameRealPath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right)
  } catch {
    return false
  }
}

function realPath(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    return value
  }
}

class SkillLibrary {
  constructor({
    storagePath,
    legacyPath = '',
    libraryRoot,
    backupRoot,
    trashRoot,
    home,
    catalog = null,
    configDirectoryForKind = () => '',
    limits = {},
    now = () => new Date(),
    onChanged = () => {},
  } = {}) {
    if (typeof libraryRoot !== 'string' || !path.isAbsolute(libraryRoot)) {
      fail('SKILL_LIBRARY_STORE_INVALID')
    }
    this.store = new SkillLibraryStore({ storagePath, legacyPath, now })
    this.libraryRoot = path.normalize(libraryRoot)
    this.backupRoot = path.normalize(backupRoot || path.join(path.dirname(this.libraryRoot), 'skill-backups'))
    this.trashRoot = path.normalize(trashRoot || path.join(path.dirname(this.libraryRoot), 'skill-trash'))
    this.home = path.normalize(String(home || ''))
    this.catalog = catalog || new LocalSkillCatalog({ home: this.home || undefined })
    this.configDirectoryForKind = configDirectoryForKind
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.now = now
    this.onChanged = onChanged
    this.readCache = new Map()
    this.riskCache = new Map()
    this.scanCache = null
    this.scanCacheAt = 0
    this.ensureDirectories()
    this.store.load()
  }

  ensureDirectories() {
    for (const directory of [this.libraryRoot, this.backupRoot, this.trashRoot]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    }
  }

  invalidate() {
    this.readCache.clear()
    this.riskCache.clear()
    this.scanCache = null
    this.scanCacheAt = 0
  }

  notify() {
    this.invalidate()
    try { this.onChanged() } catch { /* observers are best-effort */ }
  }

  adapter(agent) {
    return adapterFor(agent, {
      home: this.home,
      configDirectoryForKind: this.configDirectoryForKind,
    })
  }

  loadStore() {
    return this.store.load()
  }

  saveStore(store) {
    this.store.save(store)
  }

  readCached(directory, expectedName) {
    const key = `${directory}\0${expectedName || ''}`
    const cached = this.readCache.get(key)
    const now = Date.now()
    if (cached && now - cached.at < SCAN_CACHE_MS) return cached.meta
    if (cached) {
      try {
        const signature = treeSignature(directory, this.limits).signature
        if (signature === cached.signature) {
          cached.at = now
          return cached.meta
        }
      } catch { /* the directory changed or became unreadable; reread below */ }
    }
    const meta = safeReadSkillDirectory(directory, {
      expectedName,
      limits: this.limits,
    })
    let signature = ''
    try { signature = treeSignature(directory, this.limits).signature } catch { /* cache misses are safe */ }
    this.readCache.set(key, { at: now, meta, signature })
    return meta
  }

  managedPaths(store) {
    const paths = new Set()
    for (const projection of Object.values(store.projections)) {
      if (typeof projection?.targetRef === 'string') paths.add(realPath(projection.targetRef))
    }
    return paths
  }

  scanNative(store, managed) {
    const records = []
    for (const kind of AGENT_KINDS) {
      let listed
      try {
        listed = this.catalog.listResolved(kind)
      } catch {
        continue
      }
      if (!listed?.supported || !Array.isArray(listed.skills) || listed.skills.length === 0) continue
      for (const skill of listed.skills) {
        const directory = skill.sourceDirectory
        if (!directory) continue
        if (managed.has(realPath(directory))) continue
        if (readManagedMarker(directory)) continue
        const meta = this.readCached(directory, skill.name)
        if (meta.contentHash === null && meta.errorCode === 'SKILL_UNREADABLE') continue
        records.push({
          ...meta,
          id: nativeSkillId(kind, skill.namespace, skill.slug),
          kind: 'native',
          source: 'native',
          sourceKind: 'native',
          originKind: kind,
          namespace: skill.namespace,
          slug: skill.slug,
          sourceDirectory: directory,
          origin: {
            type: 'native',
            agent: kind,
            namespace: skill.namespace,
            slug: skill.slug,
          },
          updatedAt: skillUpdatedAt(directory),
          risk: null,
        })
      }
    }
    return records
  }

  scanLibrary(store) {
    let entries
    try {
      entries = fs.readdirSync(this.libraryRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const records = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const name = entry.name
      if (!validSkillName(name)) continue
      const directory = path.join(this.libraryRoot, name)
      if (!fs.existsSync(path.join(directory, 'SKILL.md'))) continue
      const meta = this.readCached(directory, name)
      if (meta.contentHash === null && meta.errorCode === 'SKILL_UNREADABLE') continue
      const id = sharedSkillId(name)
      const stored = store.skills[id] || {}
      const provenance = readProvenance(directory) || {}
      const sourceKind = provenance.sourceKind === 'market' || stored.sourceKind === 'market'
        ? 'market'
        : 'shared'
      records.push({
        ...meta,
        id,
        kind: 'shared',
        source: sourceKind,
        sourceKind,
        originKind: 'shared',
        namespace: 'library',
        slug: name,
        sourceDirectory: directory,
        origin: stored.origin || provenance.origin || { type: 'library' },
        version: meta.version || provenance.version || stored.version || null,
        risk: stored.risk || null,
        updatedAt: skillUpdatedAt(directory),
      })
    }
    return records
  }

  trustState(record, store) {
    if (record.tooLarge || !record.contentHash) return 'unavailable'
    if (store.approvedHashes[record.contentHash]) return 'trusted'
    const approvedHash = store.skills[record.id]?.approvedHash
    if (approvedHash && approvedHash !== record.contentHash) return 'changed'
    return 'untrusted'
  }

  decorate(records, store) {
    const groups = new Map()
    for (const record of records) {
      const key = safeSkillName(record.name || record.slug)
      const list = groups.get(key) || []
      list.push(record)
      groups.set(key, list)
    }
    for (const record of records) {
      record.approvedHash = store.skills[record.id]?.approvedHash || null
      record.nativeEligible = Array.isArray(store.skills[record.id]?.nativeEligible)
        ? store.skills[record.id].nativeEligible.filter(agent => typeof agent === 'string')
        : []
      record.trust = this.trustState(record, store)
      record.available = record.trust !== 'trusted'
        ? []
        : record.kind === 'native'
          ? (record.nativeEligible.includes(record.originKind) ? [record.originKind] : [])
          : [...AGENT_KINDS]
      record.projections = Object.values(store.projections)
        .filter(projection => projection.skillId === record.id)
        .map((projection) => {
          const info = projectionStatus(projection, {
            skill: record,
            limits: this.limits,
            home: this.home,
          })
          return {
            id: projection.id,
            agent: projection.agent,
            scope: projection.scope || 'global',
            mode: projection.mode || 'copy',
            status: info.status,
            reason: info.reason || null,
            displayPath: info.displayPath || projection.displayPath || null,
            contentHash: projection.contentHash || null,
            deployedAt: projection.deployedAt || null,
          }
        })
      const variants = groups.get(safeSkillName(record.name || record.slug)) || []
      const hashes = new Set(variants.map(item => item.contentHash).filter(Boolean))
      record.conflict = hashes.size > 1
        ? {
            name: record.name,
            variants: variants.map(item => ({
              id: item.id,
              source: item.source,
              agent: item.originKind,
              hash: item.contentHash ? item.contentHash.slice(0, 12) : null,
            })),
          }
        : null
    }
    return records
  }

  scan() {
    const at = Date.now()
    if (this.scanCache && at - this.scanCacheAt < SCAN_CACHE_MS) return this.scanCache
    const store = this.loadStore()
    const managed = this.managedPaths(store)
    const records = [
      ...this.scanNative(store, managed),
      ...this.scanLibrary(store),
    ]
    const decorated = this.decorate(records, store)
    decorated.sort((left, right) => {
      const rank = item => item.kind === 'shared' ? (item.sourceKind === 'market' ? 1 : 0) : 2
      return rank(left) - rank(right)
        || left.name.localeCompare(right.name)
        || left.id.localeCompare(right.id)
    })
    this.scanCache = decorated
    this.scanCacheAt = at
    return decorated
  }

  recordById(id) {
    const record = this.scan().find(item => item.id === id)
    if (!record) throw skillError('SKILL_NOT_FOUND')
    return record
  }

  listDto(record) {
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      source: record.source,
      sourceKind: record.sourceKind,
      originKind: record.originKind,
      namespace: record.namespace,
      slug: record.slug,
      trust: record.trust,
      eligible: record.available,
      available: record.available,
      preview: record.preview,
      version: record.version || null,
      updatedAt: record.updatedAt || null,
      risk: record.risk || null,
      fileCount: record.fileCount || 0,
      totalBytes: record.totalBytes || 0,
      projections: record.projections.map(projection => ({
        id: projection.id,
        agent: projection.agent,
        scope: projection.scope,
        mode: projection.mode,
        status: projection.status,
        reason: projection.reason,
        displayPath: projection.displayPath,
      })),
      conflict: record.conflict,
    }
  }

  riskFor(record) {
    if (!record.contentHash) {
      return { level: 'none', labels: ['unreadable'], findings: [], scannedAt: nowIso(this.now) }
    }
    if (record.risk?.scannedHash === record.contentHash) return record.risk
    const cached = this.riskCache.get(record.contentHash)
    if (cached) return cached
    let report
    try {
      report = scanSkill(record.sourceDirectory, this.limits)
    } catch {
      report = { level: 'none', labels: [], findings: [], scannedAt: nowIso(this.now) }
    }
    report.scannedHash = record.contentHash
    this.riskCache.set(record.contentHash, report)
    return report
  }

  detailDto(record, store) {
    const approved = store.approvedHashes[record.contentHash]
    const previous = record.approvedHash ? store.approvedHashes[record.approvedHash] : null
    const origin = record.kind === 'native'
      ? { type: 'native', agent: record.originKind, namespace: record.namespace, slug: record.slug }
      : (record.origin || { type: 'library' })
    return {
      ...this.listDto(record),
      contentHash: record.contentHash,
      approvedHash: record.approvedHash,
      approvedAt: approved?.approvedAt || previous?.approvedAt || null,
      preview: record.preview,
      files: record.fileManifest.map(file => ({
        path: file.path,
        size: file.size,
        hash: file.hash,
      })),
      risk: this.riskFor(record),
      origin,
      approvedManifest: approved?.fileManifest || previous?.fileManifest || [],
      approvedPreview: approved?.preview || previous?.preview || '',
      canEdit: record.kind === 'shared' && record.sourceKind === 'shared',
      canRemove: record.kind === 'shared',
      canProject: record.kind === 'shared' && record.trust === 'trusted',
      projectableAgents: record.kind === 'shared'
        ? AGENT_KINDS.filter(agent => this.adapter(agent)?.canProject)
        : [],
    }
  }

  list() {
    const records = this.scan()
    const store = this.loadStore()
    const agents = new Set()
    for (const record of records) {
      if (record.kind === 'native') agents.add(record.originKind)
      for (const projection of record.projections) agents.add(projection.agent)
    }
    const agentList = AGENT_KINDS.filter(agent => agents.has(agent))
    const counts = {
      all: records.length,
      shared: records.filter(record => record.source === 'shared').length,
      native: records.filter(record => record.source === 'native').length,
      market: records.filter(record => record.source === 'market').length,
      reauth: records.filter(record => record.trust === 'changed').length,
      conflict: records.filter(record => record.conflict).length,
    }
    return {
      agents: agentList,
      agentLabels: Object.fromEntries(agentList.map(agent => [agent, agentLabel(agent)])),
      agentCapabilities: agentCapabilities({
        home: this.home,
        configDirectoryForKind: this.configDirectoryForKind,
      }),
      skills: records.map(record => this.listDto(record)),
      defaults: store.defaults,
      policy: store.policy,
      counts,
      storeError: this.store.lastError,
    }
  }

  summary() {
    const view = this.list()
    return {
      agents: view.agents,
      agentLabels: view.agentLabels,
      agentCapabilities: view.agentCapabilities,
      counts: view.counts,
      policy: view.policy,
      storeError: view.storeError,
    }
  }

  detail(id) {
    const store = this.loadStore()
    const record = this.recordById(id)
    return this.detailDto(record, store)
  }

  trust(id) {
    const record = this.recordById(id)
    if (!record.contentHash) throw skillError(record.tooLarge ? 'SKILL_TOO_LARGE' : 'SKILL_UNREADABLE')
    const store = this.loadStore()
    const risk = this.riskFor(record)
    const approvedAt = nowIso(this.now)
    store.approvedHashes[record.contentHash] = {
      approvedAt,
      preview: record.preview,
      fileManifest: record.fileManifest,
      risk,
      scannedHash: record.contentHash,
    }
    store.skills[id] = {
      ...(store.skills[id] || {}),
      name: record.name,
      sourceKind: record.sourceKind,
      origin: record.origin,
      contentHash: record.contentHash,
      approvedHash: record.contentHash,
      version: record.version || null,
      updatedAt: approvedAt,
    }
    this.saveStore(store)
    this.notify()
    return this.detail(id)
  }

  revokeTrust(id) {
    const record = this.recordById(id)
    const store = this.loadStore()
    const hash = record.contentHash
    if (store.skills[id]) {
      delete store.skills[id].approvedHash
      store.skills[id].nativeEligible = []
    }
    if (hash) {
      const stillUsed = Object.values(store.skills).some(item => item.approvedHash === hash)
      if (!stillUsed) delete store.approvedHashes[hash]
    }
    for (const agent of Object.keys(store.defaults)) {
      store.defaults[agent] = store.defaults[agent].filter(skillId => skillId !== id)
    }
    const removedProjections = []
    const keptProjections = []
    for (const projection of Object.values(store.projections).filter(item => item.skillId === id)) {
      if (projection.mode === 'copy') {
        try {
          removeProjection(projection)
          removedProjections.push(projection.id)
        } catch (error) {
          keptProjections.push({ id: projection.id, reason: error?.code || 'SKILL_PROJECTION_CONFLICT' })
          continue
        }
      }
      delete store.projections[projection.id]
      if (projection.mode === 'nativeOrigin') removedProjections.push(projection.id)
    }
    this.saveStore(store)
    this.notify()
    return { id, trust: 'untrusted', removedProjections, keptProjections }
  }

  revoke(id) {
    return this.revokeTrust(id)
  }

  setEligible(id, agent, enabled) {
    const record = this.recordById(id)
    if (typeof enabled !== 'boolean') throw skillError('SKILL_SELECTION_INVALID')
    if (record.kind === 'shared') {
      const result = enabled ? this.project(id, agent) : this.unproject(id, agent)
      return { id, eligible: enabled ? [agent] : [], trust: result.trust || record.trust }
    }
    if (agent !== record.originKind) throw skillError('SKILL_AGENT_INVALID')
    if (enabled && record.trust !== 'trusted') throw skillError('SKILL_TRUST_REQUIRED')
    const store = this.loadStore()
    const current = new Set(store.skills[id]?.nativeEligible || [])
    if (enabled) current.add(agent)
    else current.delete(agent)
    store.skills[id] = {
      ...(store.skills[id] || {}),
      name: record.name,
      sourceKind: 'native',
      origin: record.origin,
      nativeEligible: [...current].sort(),
    }
    this.saveStore(store)
    this.notify()
    return { id, eligible: [...current].sort(), trust: this.recordById(id).trust }
  }

  enableForAgents(id) {
    const record = this.recordById(id)
    if (record.kind === 'native') return this.setEligible(id, record.originKind, true)
    const projections = []
    const failed = []
    for (const agent of AGENT_KINDS) {
      if (!this.adapter(agent)?.canProject) continue
      try {
        this.project(id, agent)
        projections.push(agent)
      } catch (error) {
        failed.push({ agent, reason: error?.code || 'SKILL_PROJECTION_FAILED' })
      }
    }
    return { id, projections, failed }
  }

  assertSelectable(agent, ids) {
    if (!AGENT_KINDS.includes(agent)) throw skillError('SKILL_AGENT_INVALID')
    if (!Array.isArray(ids) || ids.length > MAX_ROLE_SKILLS) throw skillError('SKILL_SELECTION_INVALID')
    const available = new Map(this.scan()
      .filter(record => record.trust === 'trusted' && record.available.includes(agent))
      .map(record => [record.id, record]))
    const selected = []
    const seen = new Set()
    for (const id of ids) {
      if (typeof id !== 'string' || seen.has(id) || !available.has(id)) {
        throw skillError('SKILL_SELECTION_INVALID')
      }
      seen.add(id)
      selected.push(id)
    }
    return selected
  }

  materialize(agent, ids) {
    const records = new Map(this.scan().map(record => [record.id, record]))
    const skills = []
    const dropped = []
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, MAX_ROLE_SKILLS)) {
      const record = records.get(id)
      if (!record || record.trust !== 'trusted' || !record.available.includes(agent)) {
        dropped.push({ id: String(id || ''), reason: 'unavailable' })
        continue
      }
      const native = record.projections.some(projection => (
        projection.agent === agent && projection.status === 'deployed'
      ))
      skills.push({
        id: record.id,
        name: record.name,
        description: record.description,
        body: native ? '' : record.body,
        contentHash: record.contentHash,
        delivery: native ? 'native' : 'prompt',
      })
    }
    return { skills, dropped }
  }

  captainInventory(providers) {
    const wanted = (Array.isArray(providers) ? providers : []).filter(agent => AGENT_KINDS.includes(agent))
    const records = this.scan()
    return {
      providers: wanted.map((provider) => {
        const skills = records
          .filter(record => record.trust === 'trusted' && record.available.includes(provider))
          .sort((left, right) => left.name.localeCompare(right.name))
        return {
          provider,
          skills: skills.slice(0, MAX_CAPTAIN_SKILLS).map(record => ({
            id: record.id,
            name: record.name,
            description: cleanLine(record.description, CAPTAIN_DESCRIPTION_LIMIT),
          })),
          more: Math.max(0, skills.length - MAX_CAPTAIN_SKILLS),
        }
      }),
    }
  }

  defaults(agent) {
    const stored = this.loadStore().defaults[String(agent || '')]
    if (!Array.isArray(stored) || stored.length === 0) return []
    try { return this.assertSelectable(agent, stored) } catch { return [] }
  }

  rememberDefault(agent, ids) {
    const selected = this.assertSelectable(agent, ids)
    const store = this.loadStore()
    store.defaults[agent] = selected
    this.saveStore(store)
    this.notify()
    return selected
  }

  libraryPath(name) {
    return path.join(this.libraryRoot, name)
  }

  uniqueLibraryName(baseName, store, onConflict, contentHash) {
    const clean = safeSkillName(baseName)
    const existingId = sharedSkillId(clean)
    const existing = store.skills[existingId]
    const exists = Boolean(existing) || fs.existsSync(this.libraryPath(clean))
    if (!exists) return { name: clean, reuse: false, replace: false, renamed: false }
    if (existing?.contentHash && existing.contentHash === contentHash) {
      return { name: clean, reuse: true, replace: false, renamed: false }
    }
    if (onConflict === 'replace') return { name: clean, reuse: false, replace: true, renamed: false }
    if (onConflict === 'error') throw skillError('SKILL_NAME_CONFLICT')
    for (let index = 2; index <= 50; index += 1) {
      const suffix = `-${index}`
      const candidate = safeSkillName(`${clean.slice(0, 64 - suffix.length)}${suffix}`)
      if (!store.skills[sharedSkillId(candidate)] && !fs.existsSync(this.libraryPath(candidate))) {
        return { name: candidate, reuse: false, replace: false, renamed: true }
      }
    }
    throw skillError('SKILL_NAME_CONFLICT')
  }

  importOne(record, store, { onConflict, trust }) {
    const resolved = this.uniqueLibraryName(record.name || record.slug, store, onConflict, record.contentHash)
    const id = sharedSkillId(resolved.name)
    if (resolved.reuse) {
      return { id, name: resolved.name, reused: true, renamed: false, approved: Boolean(store.approvedHashes[record.contentHash]) }
    }
    const staging = path.join(
      this.libraryRoot,
      `.tyche-import-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    removeDirectory(staging)
    try {
      copySkillDirectory(record.sourceDirectory, staging, this.limits)
      const skillFile = path.join(staging, 'SKILL.md')
      const original = fs.readFileSync(skillFile, 'utf8')
      fs.writeFileSync(skillFile, normalizeSkillMarkdown(original, {
        name: resolved.name,
        description: record.description || resolved.name,
      }), { mode: 0o600 })
      const copied = safeReadSkillDirectory(staging, {
        expectedName: resolved.name,
        limits: this.limits,
      })
      if (!copied.contentHash) throw skillError('SKILL_IMPORT_INVALID')
      const approved = trust === true || record.trust === 'trusted'
      const risk = scanSkill(staging, this.limits)
      risk.scannedHash = copied.contentHash
      const targetDirectory = this.libraryPath(resolved.name)
      if (resolved.replace && fs.existsSync(targetDirectory)) {
        backupProjection(targetDirectory, this.backupRoot, resolved.name, this.now)
        removeDirectory(targetDirectory)
      }
      writeProvenance(staging, {
        schemaVersion: 1,
        skillId: id,
        sourceKind: 'shared',
        origin: {
          type: 'import',
          fromAgent: record.originKind,
          namespace: record.namespace,
          slug: record.slug,
        },
        release: null,
        version: copied.version || null,
        contentHash: copied.contentHash,
        installedAt: nowIso(this.now),
      })
      fs.renameSync(staging, targetDirectory)
      const previous = store.skills[id] || {}
      store.skills[id] = {
        ...previous,
        name: resolved.name,
        sourceKind: 'shared',
        origin: {
          type: 'import',
          fromAgent: record.originKind,
          namespace: record.namespace,
          slug: record.slug,
        },
        version: copied.version || null,
        contentHash: copied.contentHash,
        approvedHash: approved ? copied.contentHash : (previous.approvedHash || null),
        nativeSourceRef: record.sourceDirectory,
        nativeEligible: previous.nativeEligible || [],
        createdAt: previous.createdAt || nowIso(this.now),
        updatedAt: nowIso(this.now),
      }
      if (approved) {
        store.approvedHashes[copied.contentHash] = {
          approvedAt: nowIso(this.now),
          preview: copied.preview,
          fileManifest: copied.fileManifest,
          risk,
          scannedHash: copied.contentHash,
        }
      }
      const adapter = this.adapter(record.originKind)
      const target = adapter?.canProject ? path.join(adapter.root, resolved.name) : ''
      if (target && sameRealPath(target, record.sourceDirectory)) {
        let targetHash = null
        try { targetHash = hashSkillDirectory(target, this.limits).contentHash } catch { /* keep no projection */ }
        if (targetHash === copied.contentHash) {
          const pid = projectionId(id, record.originKind)
          store.projections[pid] = {
            id: pid,
            skillId: id,
            agent: record.originKind,
            scope: 'global',
            mode: 'nativeOrigin',
            targetRef: target,
            displayPath: displayPath(target, this.home),
            contentHash: copied.contentHash,
            deployedAt: nowIso(this.now),
          }
        }
      }
      return { id, name: resolved.name, reused: false, renamed: resolved.renamed, approved }
    } catch (error) {
      removeDirectory(staging)
      throw error
    }
  }

  importFromAgent({ ids, onConflict = 'rename', trust = false } = {}) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 64) {
      throw skillError('SKILL_IMPORT_INVALID')
    }
    if (!['rename', 'replace', 'error'].includes(onConflict)) throw skillError('SKILL_IMPORT_INVALID')
    const records = new Map(this.scan().filter(record => record.kind === 'native').map(record => [record.id, record]))
    const store = this.loadStore()
    const imported = []
    const skipped = []
    const failed = []
    for (const id of ids) {
      const record = records.get(id)
      if (!record) {
        failed.push({ id: String(id || ''), code: 'SKILL_NOT_FOUND' })
        continue
      }
      try {
        imported.push(this.importOne(record, store, { onConflict, trust: trust === true }))
      } catch (error) {
        failed.push({ id, code: error?.code || 'SKILL_IMPORT_FAILED' })
      }
    }
    this.saveStore(store)
    this.notify()
    return { imported, skipped, failed }
  }

  create({ name, description, body = '', targets = [] } = {}) {
    if (!validSkillName(name)) throw skillError('SKILL_NAME_INVALID')
    if (fs.existsSync(this.libraryPath(name))) throw skillError('SKILL_NAME_CONFLICT')
    if (typeof description !== 'string' || description.length > 2000) throw skillError('SKILL_IMPORT_INVALID')
    if (typeof body !== 'string' || body.length > MAX_BODY_INPUT) throw skillError('SKILL_IMPORT_INVALID')
    const staging = path.join(this.libraryRoot, `.tyche-create-${process.pid}-${Date.now()}`)
    removeDirectory(staging)
    try {
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 })
      const skillFile = path.join(staging, 'SKILL.md')
      fs.writeFileSync(skillFile, skillMarkdownTemplate({
        name,
        description: cleanLine(description, 240),
        body,
      }), { mode: 0o600 })
      const hashed = hashSkillDirectory(staging, this.limits)
      const meta = safeReadSkillDirectory(staging, { expectedName: name, limits: this.limits })
      const risk = scanSkill(staging, this.limits)
      risk.scannedHash = hashed.contentHash
      const id = sharedSkillId(name)
      writeProvenance(staging, {
        schemaVersion: 1,
        skillId: id,
        sourceKind: 'shared',
        origin: { type: 'created' },
        release: null,
        version: meta.version || null,
        contentHash: hashed.contentHash,
        installedAt: nowIso(this.now),
      })
      fs.renameSync(staging, this.libraryPath(name))
      const store = this.loadStore()
      store.skills[id] = {
        name,
        sourceKind: 'shared',
        origin: { type: 'created' },
        version: meta.version || null,
        contentHash: hashed.contentHash,
        approvedHash: hashed.contentHash,
        nativeEligible: [],
        createdAt: nowIso(this.now),
        updatedAt: nowIso(this.now),
      }
      store.approvedHashes[hashed.contentHash] = {
        approvedAt: nowIso(this.now),
        preview: meta.preview,
        fileManifest: meta.fileManifest,
        risk,
        scannedHash: hashed.contentHash,
      }
      this.saveStore(store)
      this.notify()
      const targetErrors = []
      for (const agent of Array.isArray(targets) ? targets : []) {
        try { this.project(id, agent) } catch (error) { targetErrors.push({ agent, reason: error?.code || 'SKILL_PROJECTION_FAILED' }) }
      }
      return { ...this.detail(id), targetErrors }
    } catch (error) {
      removeDirectory(staging)
      throw error
    }
  }

  update({ id, description, body } = {}) {
    const record = this.recordById(id)
    if (record.kind !== 'shared') throw skillError('SKILL_AGENT_INVALID')
    if (record.sourceKind === 'market') throw skillError('SKILL_MARKET_READONLY')
    if (description !== undefined && (typeof description !== 'string' || description.length > 2000)) {
      throw skillError('SKILL_IMPORT_INVALID')
    }
    if (body !== undefined && (typeof body !== 'string' || body.length > MAX_BODY_INPUT)) {
      throw skillError('SKILL_IMPORT_INVALID')
    }
    const skillFile = path.join(record.sourceDirectory, 'SKILL.md')
    const current = fs.readFileSync(skillFile, 'utf8')
    const parsed = frontmatterFields(current)
    const nextDescription = description === undefined ? record.description : cleanLine(description, 240)
    const nextBody = body === undefined ? parsed.body : String(body).slice(0, MAX_BODY_INPUT)
    let next = normalizeSkillMarkdown(current, { name: record.name, description: nextDescription })
    next = replaceSkillBody(next, nextBody)
    const temporary = `${skillFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, next, { mode: 0o600 })
    fs.renameSync(temporary, skillFile)
    const meta = safeReadSkillDirectory(record.sourceDirectory, {
      expectedName: record.name,
      limits: this.limits,
    })
    if (!meta.contentHash) throw skillError('SKILL_UNREADABLE')
    const store = this.loadStore()
    store.skills[id] = {
      ...(store.skills[id] || {}),
      name: record.name,
      sourceKind: record.sourceKind,
      origin: record.origin,
      contentHash: meta.contentHash,
      version: meta.version || record.version || null,
      updatedAt: nowIso(this.now),
    }
    const provenance = readProvenance(record.sourceDirectory)
    if (provenance) {
      writeProvenance(record.sourceDirectory, {
        ...provenance,
        contentHash: meta.contentHash,
        version: meta.version || provenance.version || null,
      })
    }
    this.saveStore(store)
    this.notify()
    return this.detail(id)
  }

  remove({ id, confirmName } = {}) {
    const record = this.recordById(id)
    if (record.kind !== 'shared') throw skillError('SKILL_AGENT_INVALID')
    if (confirmName !== record.name) throw skillError('SKILL_CONFIRM_MISMATCH')
    const store = this.loadStore()
    fs.mkdirSync(this.trashRoot, { recursive: true, mode: 0o700 })
    const trash = path.join(this.trashRoot, `${Date.now()}-${record.name}`)
    try {
      fs.renameSync(record.sourceDirectory, trash)
    } catch {
      fs.cpSync(record.sourceDirectory, trash, { recursive: true, force: false, errorOnExist: false })
      removeDirectory(record.sourceDirectory)
    }
    const keptProjections = []
    for (const projection of Object.values(store.projections).filter(item => item.skillId === id)) {
      if (projection.mode === 'copy') {
        try {
          removeProjection(projection)
        } catch (error) {
          try { unmanageProjection(projection) } catch { /* leave the copy in place */ }
          keptProjections.push({ id: projection.id, reason: 'unmanaged', code: error?.code || 'SKILL_PROJECTION_CONFLICT' })
        }
      }
      delete store.projections[projection.id]
    }
    const hash = record.contentHash
    delete store.skills[id]
    if (hash && !Object.values(store.skills).some(item => item.approvedHash === hash)) {
      delete store.approvedHashes[hash]
    }
    for (const agent of Object.keys(store.defaults)) {
      store.defaults[agent] = store.defaults[agent].filter(skillId => skillId !== id)
    }
    this.saveStore(store)
    this.notify()
    return { removed: true, keptProjections }
  }

  project(id, agent) {
    const record = this.recordById(id)
    if (record.kind !== 'shared') throw skillError('SKILL_AGENT_INVALID')
    if (record.trust !== 'trusted') throw skillError('SKILL_TRUST_REQUIRED')
    const adapter = this.adapter(agent)
    if (!adapter?.canProject) throw skillError('SKILL_UNSUPPORTED_AGENT')
    const store = this.loadStore()
    const pid = projectionId(id, agent)
    let projection = store.projections[pid]
    if (projection) {
      if (projection.mode === 'nativeOrigin') {
        const info = projectionStatus(projection, { skill: record, limits: this.limits, home: this.home })
        if (info.status === 'deployed') return this.detail(id)
        if (info.status === 'drifted') throw skillError('SKILL_PROJECTION_DRIFTED')
        if (info.status === 'outdated') throw skillError('SKILL_PROJECTION_OUTDATED')
        delete store.projections[pid]
        projection = null
      } else {
        const info = projectionStatus(projection, {
          skill: record,
          limits: this.limits,
          home: this.home,
        })
        if (info.status === 'drifted') throw skillError('SKILL_PROJECTION_DRIFTED')
        const deployed = deployCopy({
          skill: record,
          adapter,
          projection,
          backupRoot: this.backupRoot,
          limits: this.limits,
          home: this.home,
          now: this.now,
        })
        projection.contentHash = deployed.contentHash
        projection.targetRef = deployed.targetRef
        projection.displayPath = deployed.displayPath
        projection.deployedAt = nowIso(this.now)
        this.saveStore(store)
        this.notify()
        return this.detail(id)
      }
    }
    const target = path.join(adapter.root, record.name)
    if (fs.existsSync(target)) {
      const nativeSourceRef = store.skills[id]?.nativeSourceRef
      let targetHash = null
      try { targetHash = hashSkillDirectory(target, this.limits).contentHash } catch { /* conflict */ }
      if (nativeSourceRef && sameRealPath(target, nativeSourceRef) && targetHash === record.contentHash) {
        store.projections[pid] = {
          id: pid,
          skillId: id,
          agent,
          scope: 'global',
          mode: 'nativeOrigin',
          targetRef: target,
          displayPath: displayPath(target, this.home),
          contentHash: record.contentHash,
          deployedAt: nowIso(this.now),
        }
        this.saveStore(store)
        this.notify()
        return this.detail(id)
      }
      throw skillError('SKILL_PROJECTION_CONFLICT')
    }
    const nextProjection = {
      id: pid,
      skillId: id,
      agent,
      scope: 'global',
      mode: 'copy',
      targetRef: target,
      displayPath: displayPath(target, this.home),
      contentHash: '',
      deployedAt: null,
    }
    const deployed = deployCopy({
      skill: record,
      adapter,
      projection: nextProjection,
      backupRoot: this.backupRoot,
      limits: this.limits,
      home: this.home,
      now: this.now,
    })
    nextProjection.contentHash = deployed.contentHash
    nextProjection.targetRef = deployed.targetRef
    nextProjection.displayPath = deployed.displayPath
    nextProjection.deployedAt = nowIso(this.now)
    store.projections[pid] = nextProjection
    this.saveStore(store)
    this.notify()
    return this.detail(id)
  }

  unproject(id, agent) {
    const record = this.recordById(id)
    const store = this.loadStore()
    const pid = projectionId(id, agent)
    const projection = store.projections[pid]
    if (!projection) return this.detail(id)
    if (projection.mode === 'copy') {
      const info = projectionStatus(projection, {
        skill: record,
        limits: this.limits,
        home: this.home,
      })
      if (info.status === 'drifted') throw skillError('SKILL_PROJECTION_DRIFTED')
      removeProjection(projection)
    }
    delete store.projections[pid]
    this.saveStore(store)
    this.notify()
    return this.detail(id)
  }

  resolveProjection({ projectionId: pid, action } = {}) {
    if (!['restore', 'adopt', 'unmanage'].includes(action)) throw skillError('SKILL_PROJECTION_INVALID')
    const store = this.loadStore()
    const projection = store.projections[pid]
    if (!projection) throw skillError('SKILL_PROJECTION_NOT_FOUND')
    const record = this.recordById(projection.skillId)
    if (action === 'restore') {
      if (projection.mode !== 'copy') throw skillError('SKILL_PROJECTION_INVALID')
      if (record.trust !== 'trusted') throw skillError('SKILL_TRUST_REQUIRED')
      const adapter = this.adapter(projection.agent)
      if (!adapter?.canProject) throw skillError('SKILL_UNSUPPORTED_AGENT')
      const deployed = deployCopy({
        skill: record,
        adapter,
        projection,
        backupRoot: this.backupRoot,
        limits: this.limits,
        home: this.home,
        now: this.now,
      })
      projection.contentHash = deployed.contentHash
      projection.targetRef = deployed.targetRef
      projection.displayPath = deployed.displayPath
      projection.deployedAt = nowIso(this.now)
      this.saveStore(store)
      this.notify()
      return this.detail(record.id)
    }
    if (action === 'unmanage') {
      unmanageProjection(projection)
      delete store.projections[pid]
      this.saveStore(store)
      this.notify()
      return this.detail(record.id)
    }

    const target = projection.targetRef
    if (!target || !fs.existsSync(target)) throw skillError('SKILL_PROJECTION_MISSING')
    const staging = path.join(this.libraryRoot, `.tyche-adopt-${process.pid}-${Date.now()}`)
    removeDirectory(staging)
    try {
      copySkillDirectory(target, staging, this.limits)
      const skillFile = path.join(staging, 'SKILL.md')
      const original = fs.readFileSync(skillFile, 'utf8')
      fs.writeFileSync(skillFile, normalizeSkillMarkdown(original, {
        name: record.name,
        description: record.description || record.name,
      }), { mode: 0o600 })
      const meta = safeReadSkillDirectory(staging, {
        expectedName: record.name,
        limits: this.limits,
      })
      if (!meta.contentHash) throw skillError('SKILL_IMPORT_INVALID')
      const previousProvenance = readProvenance(record.sourceDirectory)
      backupProjection(record.sourceDirectory, this.backupRoot, record.name, this.now)
      removeDirectory(record.sourceDirectory)
      fs.renameSync(staging, this.libraryPath(record.name))
      if (previousProvenance) {
        writeProvenance(this.libraryPath(record.name), {
          ...previousProvenance,
          skillId: record.id,
          contentHash: meta.contentHash,
          version: meta.version || previousProvenance.version || null,
        })
      }
      store.skills[record.id] = {
        ...(store.skills[record.id] || {}),
        name: record.name,
        sourceKind: record.sourceKind,
        origin: record.origin,
        contentHash: meta.contentHash,
        version: meta.version || record.version || null,
        updatedAt: nowIso(this.now),
      }
      projection.contentHash = meta.contentHash
      projection.deployedAt = nowIso(this.now)
      this.saveStore(store)
      this.notify()
      return this.detail(record.id)
    } catch (error) {
      removeDirectory(staging)
      throw error
    }
  }

  revealPath(id) {
    const record = this.recordById(id)
    return record.sourceDirectory
  }
}

module.exports = {
  MAX_CAPTAIN_SKILLS,
  MAX_ROLE_SKILLS,
  SkillLibrary,
}
