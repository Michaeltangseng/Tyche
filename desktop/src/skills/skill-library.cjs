const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { LocalSkillCatalog } = require('./local-skill-catalog.cjs')
const { SkillLibraryStore } = require('./skill-library-store.cjs')
const { AGENT_KINDS, agentLabel } = require('./skill-adapters.cjs')
const { SkillMarket } = require('./skill-market.cjs')
const {
  DEFAULT_LIMITS,
  REPO_LIMITS,
  cleanLine,
  copyRepoDirectory,
  copySkillDirectory,
  fail,
  frontmatterFields,
  hashSkillDirectory,
  isInsideOrEqual,
  isPlainObject,
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

const MAX_CAPTAIN_SKILLS = 24
const CAPTAIN_DESCRIPTION_LIMIT = 80
const SCAN_CACHE_MS = 1500
const MAX_BODY_INPUT = 100000
const REPO_ID = /^repo-[a-f0-9]{32}$/

function nowIso(now) {
  return now().toISOString()
}

function repoIdFor(skillId, commit, relativePath) {
  return `repo-${crypto.createHash('sha256')
    .update(`${skillId}\0${commit}\0${relativePath}`)
    .digest('hex')
    .slice(0, 32)}`
}

function skillUpdatedAt(directory) {
  try {
    return new Date(fs.statSync(path.join(directory, 'SKILL.md')).mtimeMs).toISOString()
  } catch {
    return null
  }
}

function backupDirectory(target, backupRoot, name, now) {
  if (!backupRoot) return null
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  const destination = path.join(backupRoot, name, stamp)
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  fs.cpSync(target, destination, { recursive: true, force: false, errorOnExist: false })
  return destination
}

class SkillLibrary {
  constructor({
    storagePath,
    legacyPath = '',
    libraryRoot,
    backupRoot,
    trashRoot,
    marketRoot,
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
    this.marketRoot = path.normalize(marketRoot || path.join(path.dirname(this.libraryRoot), 'skill-market'))
    this.home = path.normalize(String(home || ''))
    this.catalog = catalog || new LocalSkillCatalog({ home: this.home || undefined })
    this.configDirectoryForKind = configDirectoryForKind
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.now = now
    this.onChanged = onChanged
    this.readCache = new Map()
    this.scanCache = null
    this.scanCacheAt = 0
    this.ensureDirectories()
    this.store.load()
    this.market = new SkillMarket({
      library: this,
      stagingRoot: path.join(this.marketRoot, 'staging'),
      limits: this.limits,
      now: this.now,
    })
  }

  ensureDirectories() {
    for (const directory of [
      this.libraryRoot,
      path.join(this.libraryRoot, '.repos'),
      this.backupRoot,
      this.trashRoot,
      this.marketRoot,
    ]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    }
  }

  invalidate() {
    this.readCache.clear()
    this.scanCache = null
    this.scanCacheAt = 0
  }

  notify() {
    this.invalidate()
    try { this.onChanged() } catch { /* observers are best-effort */ }
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

  scanNative() {
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
    const repoBase = path.join(this.libraryRoot, '.repos')
    let repoBaseReal = ''
    try { repoBaseReal = fs.realpathSync(repoBase) } catch { repoBaseReal = '' }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const name = entry.name
      if (!validSkillName(name)) continue
      const linkPath = path.join(this.libraryRoot, name)
      let directory = linkPath
      let linked = false
      if (entry.isSymbolicLink()) {
        if (!repoBaseReal) continue
        try { directory = fs.realpathSync(linkPath) } catch { continue }
        if (!isInsideOrEqual(repoBaseReal, directory)) continue
        linked = true
      } else if (!entry.isDirectory()) {
        continue
      }
      if (!fs.existsSync(path.join(directory, 'SKILL.md'))) continue
      const meta = this.readCached(directory, name)
      if (meta.contentHash === null && meta.errorCode === 'SKILL_UNREADABLE') continue
      const id = sharedSkillId(name)
      const stored = store.skills[id] || {}
      const provenance = readProvenance(directory) || {}
      const sourceKind = provenance.sourceKind === 'market' || stored.sourceKind === 'market'
        ? 'market'
        : 'shared'
      const repoId = stored.repoId || provenance.origin?.repoId || null
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
        updateAvailable: stored.updateAvailable === true,
        repoSkill: linked || stored.repoSkill === true,
        repoId: REPO_ID.test(String(repoId || '')) ? repoId : null,
        updatedAt: skillUpdatedAt(directory),
      })
    }
    return records
  }

  scan() {
    const at = Date.now()
    if (this.scanCache && at - this.scanCacheAt < SCAN_CACHE_MS) return this.scanCache
    const store = this.loadStore()
    const records = [
      ...this.scanNative(),
      ...this.scanLibrary(store),
    ]
    records.sort((left, right) => {
      const rank = item => item.kind === 'shared' ? (item.sourceKind === 'market' ? 1 : 0) : 2
      return rank(left) - rank(right)
        || left.name.localeCompare(right.name)
        || left.id.localeCompare(right.id)
    })
    this.scanCache = records
    this.scanCacheAt = at
    return records
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
      repoSkill: record.repoSkill === true,
      originKind: record.originKind,
      namespace: record.namespace,
      slug: record.slug,
      version: record.version || null,
      updatedAt: record.updatedAt || null,
      updateAvailable: record.sourceKind === 'market' && record.updateAvailable === true,
    }
  }

  editorBodyFor(record) {
    if (record.kind !== 'shared' || record.sourceKind !== 'shared') return null
    try {
      const raw = fs.readFileSync(path.join(record.sourceDirectory, 'SKILL.md'), 'utf8')
      const body = frontmatterFields(raw).body
      return body.length > MAX_BODY_INPUT ? null : body
    } catch {
      return null
    }
  }

  detailDto(record) {
    const origin = record.kind === 'native'
      ? { type: 'native', agent: record.originKind, namespace: record.namespace, slug: record.slug }
      : (record.origin || { type: 'library' })
    const editorBody = this.editorBodyFor(record)
    return {
      ...this.listDto(record),
      contentHash: record.contentHash,
      editorBody,
      origin,
      canEdit: record.kind === 'shared' && record.sourceKind === 'shared' && editorBody !== null,
      canRemove: record.kind === 'shared',
    }
  }

  list() {
    const records = this.scan()
    const store = this.loadStore()
    const agents = new Set()
    for (const record of records) {
      if (record.kind === 'native') agents.add(record.originKind)
    }
    const agentList = AGENT_KINDS.filter(agent => agents.has(agent))
    const counts = {
      all: records.length,
      shared: records.filter(record => record.source === 'shared').length,
      native: records.filter(record => record.source === 'native').length,
      market: records.filter(record => record.source === 'market').length,
    }
    return {
      agents: agentList,
      agentLabels: Object.fromEntries(agentList.map(agent => [agent, agentLabel(agent)])),
      skills: records.map(record => this.listDto(record)),
      defaults: store.defaults,
      counts,
      storeError: this.store.lastError,
    }
  }

  summary() {
    const view = this.list()
    return {
      agents: view.agents,
      agentLabels: view.agentLabels,
      counts: view.counts,
      storeError: view.storeError,
    }
  }

  detail(id) {
    return this.detailDto(this.recordById(id))
  }

  assertSelectable(agent, ids) {
    if (!AGENT_KINDS.includes(agent)) throw skillError('SKILL_AGENT_INVALID')
    if (!Array.isArray(ids)) throw skillError('SKILL_SELECTION_INVALID')
    const platform = new Map(this.scan()
      .filter(record => record.kind !== 'native')
      .map(record => [record.id, record]))
    const selected = []
    const seen = new Set()
    for (const id of ids) {
      if (typeof id !== 'string' || seen.has(id) || !platform.has(id)) {
        throw skillError('SKILL_SELECTION_INVALID')
      }
      seen.add(id)
      selected.push(id)
    }
    return selected
  }

  materialize(agent, ids) {
    if (!AGENT_KINDS.includes(agent)) throw skillError('SKILL_AGENT_INVALID')
    const records = new Map(this.scan()
      .filter(record => record.kind !== 'native')
      .map(record => [record.id, record]))
    const skills = []
    const dropped = []
    for (const id of (Array.isArray(ids) ? ids : [])) {
      const record = records.get(id)
      if (!record || typeof record.body !== 'string') {
        dropped.push({ id: String(id || ''), reason: 'unavailable' })
        continue
      }
      skills.push({
        id: record.id,
        name: record.name,
        description: record.description,
        body: record.body,
        contentHash: record.contentHash,
        delivery: 'prompt',
      })
    }
    return { skills, dropped }
  }

  captainInventory(providers) {
    const wanted = (Array.isArray(providers) ? providers : []).filter(agent => AGENT_KINDS.includes(agent))
    const platform = this.scan().filter(record => record.kind !== 'native')
    return {
      providers: wanted.map((provider) => ({
        provider,
        skills: platform.slice(0, MAX_CAPTAIN_SKILLS).map(record => ({
          id: record.id,
          name: record.name,
          description: cleanLine(record.description, CAPTAIN_DESCRIPTION_LIMIT),
        })),
        more: Math.max(0, platform.length - MAX_CAPTAIN_SKILLS),
      })),
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

  marketSourceInfo(source) {
    if (!isPlainObject(source)) throw skillError('SKILL_MARKET_SOURCE_INVALID')
    const id = String(source.id || '').slice(0, 200)
    const url = String(source.url || '')
    const ref = String(source.ref || '').slice(0, 200)
    const subpath = String(source.subpath || '').slice(0, 300)
    if (!id || !url || url.length > 2000) throw skillError('SKILL_MARKET_SOURCE_INVALID')
    return { id, url, ref, subpath }
  }

  marketRelativePath(value) {
    const relative = String(value || '').replace(/\\/g, '/')
    if (relative.length > 500 || relative.startsWith('/')
        || relative.split('/').some(part => part === '..')) {
      throw skillError('SKILL_MARKET_ENTRY_INVALID')
    }
    return relative
  }

  assertMarketStaging(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw skillError('SKILL_MARKET_ENTRY_INVALID')
    }
    let real
    let root
    try {
      real = fs.realpathSync(directory)
      root = fs.realpathSync(this.market.stagingRoot)
    } catch {
      throw skillError('SKILL_MARKET_ENTRY_INVALID')
    }
    if (!isInsideOrEqual(root, real)) throw skillError('SKILL_MARKET_ENTRY_INVALID')
  }

  marketOrigin(info, commit, relativePath) {
    return {
      type: 'market',
      sourceId: info.id,
      url: info.url,
      ref: info.ref,
      subpath: info.subpath,
      commit: String(commit).toLowerCase(),
      relativePath,
    }
  }

  installMarketEntry({
    source,
    commit,
    stagingDirectory,
    repoRoot = '',
    relativePath,
    name,
    repo = false,
  } = {}) {
    const info = this.marketSourceInfo(source)
    this.assertMarketStaging(stagingDirectory)
    if (!validSkillName(name)) throw skillError('SKILL_NAME_INVALID')
    if (!/^[a-f0-9]{40}$/i.test(String(commit || ''))) throw skillError('SKILL_MARKET_ENTRY_INVALID')
    const rel = this.marketRelativePath(relativePath)
    if (repo) {
      return this.installMarketRepo({
        info,
        commit,
        stagingDirectory,
        repoRoot,
        relativePath: rel,
        name,
      })
    }
    const store = this.loadStore()
    const sourceMeta = safeReadSkillDirectory(stagingDirectory, {
      expectedName: name,
      limits: this.limits,
    })
    if (!sourceMeta.contentHash) throw skillError('SKILL_MARKET_ENTRY_INVALID')
    const id = sharedSkillId(name)
    const existing = store.skills[id]
    if (existing?.sourceKind === 'market' && existing.contentHash === sourceMeta.contentHash) {
      return this.detail(id)
    }
    if (existing || fs.existsSync(this.libraryPath(name))) throw skillError('SKILL_NAME_CONFLICT')

    const staging = path.join(this.libraryRoot, `.tyche-market-${process.pid}-${Date.now()}`)
    removeDirectory(staging)
    try {
      copySkillDirectory(stagingDirectory, staging, this.limits)
      const skillFile = path.join(staging, 'SKILL.md')
      const original = fs.readFileSync(skillFile, 'utf8')
      fs.writeFileSync(skillFile, normalizeSkillMarkdown(original, {
        name,
        description: sourceMeta.description || name,
      }), { mode: 0o600 })
      const meta = safeReadSkillDirectory(staging, { expectedName: name, limits: this.limits })
      if (!meta.contentHash) throw skillError('SKILL_MARKET_ENTRY_INVALID')
      const origin = this.marketOrigin(info, commit, rel)
      writeProvenance(staging, {
        schemaVersion: 1,
        skillId: id,
        sourceKind: 'market',
        origin,
        release: {
          sourceId: info.id,
          url: info.url,
          ref: info.ref,
          commit: origin.commit,
          relativePath: rel,
          fetchedAt: nowIso(this.now),
        },
        version: meta.version || null,
        contentHash: meta.contentHash,
        installedAt: nowIso(this.now),
      })
      fs.renameSync(staging, this.libraryPath(name))
      store.skills[id] = {
        name,
        sourceKind: 'market',
        origin,
        version: meta.version || null,
        contentHash: meta.contentHash,
        updateAvailable: false,
        createdAt: nowIso(this.now),
        updatedAt: nowIso(this.now),
      }
      this.saveStore(store)
      this.notify()
      return this.detail(id)
    } catch (error) {
      removeDirectory(staging)
      throw error
    }
  }

  installMarketRepo({
    info,
    commit,
    stagingDirectory,
    repoRoot,
    relativePath,
    name,
  } = {}) {
    this.assertMarketStaging(repoRoot)
    this.assertMarketStaging(stagingDirectory)
    const rel = this.marketRelativePath(relativePath)
    const parts = rel ? rel.split('/').filter(Boolean) : []
    if (path.resolve(repoRoot, ...parts) !== path.resolve(stagingDirectory)) {
      throw skillError('SKILL_MARKET_ENTRY_INVALID')
    }
    const store = this.loadStore()
    const id = sharedSkillId(name)
    const existing = store.skills[id]
    const sourceMeta = safeReadSkillDirectory(stagingDirectory, {
      expectedName: name,
      limits: this.limits,
    })
    if (!sourceMeta.contentHash) throw skillError('SKILL_MARKET_ENTRY_INVALID')
    if (existing?.sourceKind === 'market' && existing.repoSkill === true
        && existing.contentHash === sourceMeta.contentHash) {
      return this.detail(id)
    }
    let linkStat = null
    try { linkStat = fs.lstatSync(this.libraryPath(name)) } catch { linkStat = null }
    if (existing || linkStat) throw skillError('SKILL_NAME_CONFLICT')

    const repoId = repoIdFor(id, commit, rel)
    const repoRootLocal = path.join(this.libraryRoot, '.repos', repoId)
    if (fs.existsSync(repoRootLocal)) throw skillError('SKILL_NAME_CONFLICT')
    let linked = false
    try {
      copyRepoDirectory(repoRoot, repoRootLocal, REPO_LIMITS)
      const copiedSkill = path.join(repoRootLocal, ...parts)
      if (!fs.existsSync(path.join(copiedSkill, 'SKILL.md'))) {
        throw skillError('SKILL_MARKET_ENTRY_INVALID')
      }
      const skillFile = path.join(copiedSkill, 'SKILL.md')
      const original = fs.readFileSync(skillFile, 'utf8')
      fs.writeFileSync(skillFile, normalizeSkillMarkdown(original, {
        name,
        description: sourceMeta.description || name,
      }), { mode: 0o600 })
      const meta = safeReadSkillDirectory(copiedSkill, { expectedName: name, limits: this.limits })
      if (!meta.contentHash) throw skillError('SKILL_MARKET_ENTRY_INVALID')
      const origin = {
        ...this.marketOrigin(info, commit, rel),
        repoId,
        repoMode: true,
      }
      writeProvenance(copiedSkill, {
        schemaVersion: 1,
        skillId: id,
        sourceKind: 'market',
        origin,
        release: {
          sourceId: info.id,
          url: info.url,
          ref: info.ref,
          commit: origin.commit,
          relativePath: rel,
          repoId,
          fetchedAt: nowIso(this.now),
        },
        version: meta.version || null,
        contentHash: meta.contentHash,
        installedAt: nowIso(this.now),
      })
      const linkTarget = path.relative(this.libraryRoot, copiedSkill)
      try {
        fs.symlinkSync(linkTarget, this.libraryPath(name), 'dir')
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)) {
          throw skillError('SKILL_SYMLINK_UNSUPPORTED')
        }
        throw error
      }
      linked = true
      store.skills[id] = {
        name,
        sourceKind: 'market',
        origin,
        repoId,
        repoSkill: true,
        version: meta.version || null,
        contentHash: meta.contentHash,
        updateAvailable: false,
        createdAt: nowIso(this.now),
        updatedAt: nowIso(this.now),
      }
      this.saveStore(store)
      this.notify()
      return this.detail(id)
    } catch (error) {
      if (linked) {
        try { fs.unlinkSync(this.libraryPath(name)) } catch { /* best effort */ }
      }
      removeDirectory(repoRootLocal)
      throw error
    }
  }

  replaceMarketEntry({
    skillId,
    source,
    commit,
    stagingDirectory,
    repoRoot = '',
    relativePath,
  } = {}) {
    const record = this.recordById(skillId)
    if (record.kind !== 'shared' || record.sourceKind !== 'market') {
      throw skillError('SKILL_MARKET_UPDATE_INVALID')
    }
    const info = this.marketSourceInfo(source)
    this.assertMarketStaging(stagingDirectory)
    if (!/^[a-f0-9]{40}$/i.test(String(commit || ''))) throw skillError('SKILL_MARKET_ENTRY_INVALID')
    const rel = this.marketRelativePath(relativePath)
    if (record.repoSkill) {
      return this.replaceMarketRepo({
        record,
        info,
        commit,
        stagingDirectory,
        repoRoot,
        relativePath: rel,
      })
    }
    const name = record.name
    const store = this.loadStore()
    const sourceMeta = safeReadSkillDirectory(stagingDirectory, {
      expectedName: name,
      limits: this.limits,
    })
    if (!sourceMeta.contentHash) throw skillError('SKILL_MARKET_ENTRY_INVALID')

    const staging = path.join(this.libraryRoot, `.tyche-market-${process.pid}-${Date.now()}`)
    removeDirectory(staging)
    try {
      copySkillDirectory(stagingDirectory, staging, this.limits)
      const skillFile = path.join(staging, 'SKILL.md')
      const original = fs.readFileSync(skillFile, 'utf8')
      fs.writeFileSync(skillFile, normalizeSkillMarkdown(original, {
        name,
        description: sourceMeta.description || record.description || name,
      }), { mode: 0o600 })
      const meta = safeReadSkillDirectory(staging, { expectedName: name, limits: this.limits })
      if (!meta.contentHash) throw skillError('SKILL_MARKET_ENTRY_INVALID')
      const origin = this.marketOrigin(info, commit, rel)
      writeProvenance(staging, {
        schemaVersion: 1,
        skillId,
        sourceKind: 'market',
        origin,
        release: {
          sourceId: info.id,
          url: info.url,
          ref: info.ref,
          commit: origin.commit,
          relativePath: rel,
          fetchedAt: nowIso(this.now),
        },
        version: meta.version || null,
        contentHash: meta.contentHash,
        installedAt: nowIso(this.now),
      })
      backupDirectory(record.sourceDirectory, this.backupRoot, name, this.now)
      removeDirectory(record.sourceDirectory)
      fs.renameSync(staging, this.libraryPath(name))
      store.skills[skillId] = {
        ...(store.skills[skillId] || {}),
        name,
        sourceKind: 'market',
        origin,
        version: meta.version || record.version || null,
        contentHash: meta.contentHash,
        updateAvailable: false,
        createdAt: store.skills[skillId]?.createdAt || nowIso(this.now),
        updatedAt: nowIso(this.now),
      }
      this.saveStore(store)
      this.notify()
      return this.detail(skillId)
    } catch (error) {
      removeDirectory(staging)
      throw error
    }
  }

  replaceMarketRepo({ record, info, commit, stagingDirectory, repoRoot, relativePath } = {}) {
    const store = this.loadStore()
    const repoId = REPO_ID.test(String(record.repoId || '')) ? record.repoId : ''
    if (!repoId) throw skillError('SKILL_MARKET_UPDATE_INVALID')
    this.assertMarketStaging(repoRoot)
    this.assertMarketStaging(stagingDirectory)
    const rel = this.marketRelativePath(record.origin?.relativePath ?? relativePath)
    const parts = rel ? rel.split('/').filter(Boolean) : []
    if (path.resolve(repoRoot, ...parts) !== path.resolve(stagingDirectory)) {
      throw skillError('SKILL_MARKET_ENTRY_INVALID')
    }
    const oldRepo = path.join(this.libraryRoot, '.repos', repoId)
    if (!fs.existsSync(oldRepo)) throw skillError('SKILL_MARKET_UPDATE_INVALID')
    const temp = path.join(this.libraryRoot, '.repos', `.tmp-${process.pid}-${Date.now()}`)
    removeDirectory(temp)
    try {
      copyRepoDirectory(repoRoot, temp, REPO_LIMITS)
      const copiedSkill = path.join(temp, ...parts)
      if (!fs.existsSync(path.join(copiedSkill, 'SKILL.md'))) {
        throw skillError('SKILL_MARKET_ENTRY_INVALID')
      }
      const skillFile = path.join(copiedSkill, 'SKILL.md')
      const original = fs.readFileSync(skillFile, 'utf8')
      fs.writeFileSync(skillFile, normalizeSkillMarkdown(original, {
        name: record.name,
        description: record.description || record.name,
      }), { mode: 0o600 })
      const meta = safeReadSkillDirectory(copiedSkill, {
        expectedName: record.name,
        limits: this.limits,
      })
      if (!meta.contentHash) throw skillError('SKILL_MARKET_ENTRY_INVALID')
      const origin = {
        ...this.marketOrigin(info, commit, rel),
        repoId,
        repoMode: true,
      }
      writeProvenance(copiedSkill, {
        schemaVersion: 1,
        skillId: record.id,
        sourceKind: 'market',
        origin,
        release: {
          sourceId: info.id,
          url: info.url,
          ref: info.ref,
          commit: origin.commit,
          relativePath: rel,
          repoId,
          fetchedAt: nowIso(this.now),
        },
        version: meta.version || null,
        contentHash: meta.contentHash,
        installedAt: nowIso(this.now),
      })

      const swap = path.join(this.libraryRoot, '.repos', `.old-${process.pid}-${Date.now()}`)
      fs.renameSync(oldRepo, swap)
      try {
        fs.renameSync(temp, oldRepo)
      } catch (error) {
        try { fs.renameSync(swap, oldRepo) } catch { /* the backup below remains the last resort */ }
        throw error
      }
      try { backupDirectory(swap, this.backupRoot, record.name, this.now) } catch { /* best effort */ }
      removeDirectory(swap)

      store.skills[record.id] = {
        ...(store.skills[record.id] || {}),
        name: record.name,
        sourceKind: 'market',
        origin,
        repoId,
        repoSkill: true,
        version: meta.version || record.version || null,
        contentHash: meta.contentHash,
        updateAvailable: false,
        createdAt: store.skills[record.id]?.createdAt || nowIso(this.now),
        updatedAt: nowIso(this.now),
      }
      this.saveStore(store)
      this.notify()
      return this.detail(record.id)
    } catch (error) {
      removeDirectory(temp)
      throw error
    }
  }

  create({ name, description, body = '' } = {}) {
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
        createdAt: nowIso(this.now),
        updatedAt: nowIso(this.now),
      }
      this.saveStore(store)
      this.notify()
      return this.detail(id)
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
    const repoId = REPO_ID.test(String(record.repoId || '')) ? record.repoId : ''
    if (record.repoSkill && repoId) {
      const repoRoot = path.join(this.libraryRoot, '.repos', repoId)
      try {
        fs.renameSync(repoRoot, trash)
      } catch {
        fs.cpSync(repoRoot, trash, { recursive: true, force: false, errorOnExist: false })
        removeDirectory(repoRoot)
      }
      try { fs.unlinkSync(this.libraryPath(record.name)) } catch { /* the link may already be gone */ }
    } else {
      try {
        fs.renameSync(record.sourceDirectory, trash)
      } catch {
        fs.cpSync(record.sourceDirectory, trash, { recursive: true, force: false, errorOnExist: false })
        removeDirectory(record.sourceDirectory)
      }
    }
    delete store.skills[id]
    for (const agent of Object.keys(store.defaults)) {
      store.defaults[agent] = store.defaults[agent].filter(skillId => skillId !== id)
    }
    this.saveStore(store)
    this.notify()
    return { removed: true }
  }

  revealPath(id) {
    const record = this.recordById(id)
    return record.sourceDirectory
  }
}

module.exports = {
  MAX_CAPTAIN_SKILLS,
  SkillLibrary,
}
