const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const {
  DEFAULT_LIMITS,
  cleanLine,
  isInsideOrEqual,
  removeDirectory,
  safeReadSkillDirectory,
  sharedSkillId,
  skillError,
  validSkillName,
} = require('./skill-library-util.cjs')

const execFileAsync = promisify(execFile)
const MAX_ENTRIES = 50
const MAX_WALK_DIRS = 500
const MAX_WALK_DEPTH = 6
const GIT_TIMEOUT = 120000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const SOURCE_ID = /^src-[a-f0-9]{32}$/
const TOKEN = /^market-[a-f0-9]{32}$/
const SHA = /^[a-f0-9]{40}$/i

function marketError(code, cause) {
  return skillError(code, cause)
}

function fail(code, cause) {
  throw marketError(code, cause)
}

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function validateUrl(value) {
  const raw = String(value || '').trim()
  if (!raw || raw.length > 2000) fail('SKILL_MARKET_SOURCE_INVALID')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    fail('SKILL_MARKET_SOURCE_INVALID')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('SKILL_MARKET_SOURCE_INVALID')
  }
  if (parsed.protocol === 'https:') return raw
  if (parsed.protocol === 'file:' && (!parsed.hostname || parsed.hostname === 'localhost')) {
    let decoded
    try { decoded = decodeURIComponent(parsed.pathname) } catch { fail('SKILL_MARKET_SOURCE_INVALID') }
    if (!path.isAbsolute(decoded)) fail('SKILL_MARKET_SOURCE_INVALID')
    return raw
  }
  fail('SKILL_MARKET_SOURCE_INVALID')
}

function validateRef(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.length > 200 || raw.startsWith('-') || raw.includes('..') || /\s/.test(raw)
      || !/^[A-Za-z0-9._/@{}~-]+$/.test(raw)) {
    fail('SKILL_MARKET_SOURCE_INVALID')
  }
  return raw
}

function validateSubpath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/')
  if (!raw) return ''
  if (raw.length > 300 || raw.startsWith('/')) fail('SKILL_MARKET_SOURCE_INVALID')
  if (raw.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    fail('SKILL_MARKET_SOURCE_INVALID')
  }
  return raw
}

function sourceDto(source) {
  return {
    id: source.id,
    type: source.type || 'git',
    url: source.url,
    ref: source.ref || '',
    subpath: source.subpath || '',
    addedAt: source.addedAt || null,
    lastCheckedAt: source.lastCheckedAt || null,
    lastCommit: source.lastCommit || null,
  }
}

function entryDto(staged, meta) {
  return {
    token: staged.token,
    name: meta.name,
    description: meta.description,
    version: meta.version || null,
    contentHash: meta.contentHash,
    relativePath: staged.relativePath,
    validName: validSkillName(meta.name),
    repoMode: staged.repoMode === true,
  }
}

async function runGit(args, { cwd } = {}) {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
      timeout: GIT_TIMEOUT,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
      windowsHide: true,
    })
    return String(result.stdout || '')
  } catch (error) {
    if (error?.code === 'ENOENT') fail('SKILL_MARKET_GIT_MISSING')
    fail('SKILL_MARKET_FETCH_FAILED', error)
  }
}

function discoverSkillDirectories(root, subpath) {
  const base = subpath ? path.join(root, ...subpath.split('/')) : root
  if (!isInsideOrEqual(root, base) || !fs.existsSync(base)) fail('SKILL_MARKET_SOURCE_INVALID')
  let stat
  try { stat = fs.statSync(base) } catch { fail('SKILL_MARKET_SOURCE_INVALID') }
  if (!stat.isDirectory()) fail('SKILL_MARKET_SOURCE_INVALID')

  const found = []
  let visited = 0
  function walk(directory, depth) {
    if (found.length >= MAX_ENTRIES || visited >= MAX_WALK_DIRS || depth > MAX_WALK_DEPTH) return
    visited += 1
    if (fs.existsSync(path.join(directory, 'SKILL.md'))) {
      found.push(directory)
      return
    }
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      walk(path.join(directory, entry.name), depth + 1)
    }
  }
  walk(base, 0)
  return found
}

class SkillMarket {
  constructor({ library, stagingRoot, limits = DEFAULT_LIMITS, now = () => new Date(), git = runGit } = {}) {
    if (!library || typeof library.loadStore !== 'function') {
      throw new TypeError('SKILL_MARKET_LIBRARY_REQUIRED')
    }
    if (typeof stagingRoot !== 'string' || !path.isAbsolute(stagingRoot)) {
      throw new TypeError('SKILL_MARKET_STAGING_REQUIRED')
    }
    this.library = library
    this.stagingRoot = path.normalize(stagingRoot)
    this.limits = limits
    this.now = now
    this.git = git
    this.staged = new Map()
    fs.mkdirSync(this.stagingRoot, { recursive: true, mode: 0o700 })
    this.cleanupStaging()
  }

  cleanupStaging() {
    let entries = []
    try { entries = fs.readdirSync(this.stagingRoot, { withFileTypes: true }) } catch { return }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const directory = path.join(this.stagingRoot, entry.name)
      try {
        if (fs.statSync(directory).mtimeMs < cutoff) removeDirectory(directory)
      } catch { /* best effort */ }
    }
  }

  clearSourceStaging(sourceId) {
    for (const [token, staged] of this.staged) {
      if (staged.sourceId === sourceId) this.staged.delete(token)
    }
    let entries = []
    try { entries = fs.readdirSync(this.stagingRoot, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(`${sourceId}-`)) {
        removeDirectory(path.join(this.stagingRoot, entry.name))
      }
    }
  }

  clearUpdateStaging(skillId) {
    for (const [token, staged] of this.staged) {
      if (staged.skillId === skillId) this.staged.delete(token)
    }
    let entries = []
    try { entries = fs.readdirSync(this.stagingRoot, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(`update-${skillId}-`)) {
        removeDirectory(path.join(this.stagingRoot, entry.name))
      }
    }
  }

  async clone(url, ref, target) {
    removeDirectory(target)
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    try {
      if (SHA.test(ref)) {
        fs.mkdirSync(target, { recursive: true, mode: 0o700 })
        await this.git(['init', '-q'], { cwd: target })
        await this.git(['remote', 'add', 'origin', url], { cwd: target })
        await this.git(['fetch', '--depth', '1', 'origin', ref], { cwd: target })
        await this.git(['checkout', '-q', 'FETCH_HEAD'], { cwd: target })
      } else {
        const args = ['clone', '--depth', '1', '--single-branch', '--no-tags']
        if (ref) args.push('--branch', ref)
        args.push(url, target)
        await this.git(args, { cwd: path.dirname(target) })
      }
      const commit = String(await this.git(['rev-parse', 'HEAD'], { cwd: target })).trim()
      if (!SHA.test(commit)) fail('SKILL_MARKET_FETCH_FAILED')
      return commit.toLowerCase()
    } catch (error) {
      removeDirectory(target)
      throw error
    }
  }

  async latestCommit(source) {
    const ref = source.ref || ''
    if (SHA.test(ref)) return ref.toLowerCase()
    const candidates = ref ? [`refs/heads/${ref}`, `refs/tags/${ref}`, ref] : ['HEAD']
    for (const candidate of candidates) {
      let output
      try {
        output = await this.git(['ls-remote', source.url, candidate], { cwd: this.stagingRoot })
      } catch {
        continue
      }
      const lines = String(output || '').split(/\r?\n/).filter(Boolean).map(line => line.split(/\s+/))
      if (!lines.length) continue
      const exact = lines.find(([, name]) => name === candidate || name === `${candidate}^{}`)
      const chosen = lines.find(([, name]) => name?.endsWith('^{}')) || exact || lines[0]
      const commit = chosen?.[0] || ''
      if (SHA.test(commit)) return commit.toLowerCase()
    }
    fail('SKILL_MARKET_FETCH_FAILED')
  }

  listSources() {
    const store = this.library.loadStore()
    const installed = Object.values(store.skills).filter(skill => skill.sourceKind === 'market')
    return Object.values(store.sources)
      .map(source => ({
        ...sourceDto(source),
        installedCount: installed.filter(skill => skill.origin?.sourceId === source.id).length,
      }))
      .sort((left, right) => (left.url || '').localeCompare(right.url || ''))
  }

  addSource(input = {}) {
    const url = validateUrl(input.url)
    const ref = validateRef(input.ref)
    const subpath = validateSubpath(input.subpath)
    const id = `src-${sha(`${url}\0${ref}\0${subpath}`).slice(0, 32)}`
    const store = this.library.loadStore()
    if (store.sources[id]) return sourceDto(store.sources[id])
    const source = {
      id,
      type: 'git',
      url,
      ref,
      subpath,
      addedAt: this.now().toISOString(),
      lastCheckedAt: null,
      lastCommit: null,
    }
    store.sources[id] = source
    this.library.saveStore(store)
    this.library.notify()
    return sourceDto(source)
  }

  removeSource(sourceId) {
    if (!SOURCE_ID.test(String(sourceId || ''))) fail('SKILL_MARKET_SOURCE_INVALID')
    const store = this.library.loadStore()
    if (!store.sources[sourceId]) fail('SKILL_MARKET_SOURCE_NOT_FOUND')
    const used = Object.values(store.skills).some(skill => skill.sourceKind === 'market'
      && skill.origin?.sourceId === sourceId)
    if (used) fail('SKILL_MARKET_SOURCE_IN_USE')
    delete store.sources[sourceId]
    this.library.saveStore(store)
    this.library.notify()
    return { removed: true }
  }

  async previewSource(sourceId) {
    if (!SOURCE_ID.test(String(sourceId || ''))) fail('SKILL_MARKET_SOURCE_INVALID')
    const store = this.library.loadStore()
    const source = store.sources[sourceId]
    if (!source) fail('SKILL_MARKET_SOURCE_NOT_FOUND')
    this.clearSourceStaging(sourceId)
    const target = path.join(this.stagingRoot, `${sourceId}-${Date.now()}`)
    const commit = await this.clone(source.url, source.ref, target)
    const directories = discoverSkillDirectories(target, source.subpath)
    const entries = []
    for (const directory of directories) {
      const relativePath = path.relative(target, directory).split(path.sep).join('/')
      const meta = safeReadSkillDirectory(directory, {
        expectedName: path.basename(directory),
        limits: this.limits,
      })
      if (!meta.contentHash) continue
      const token = `market-${sha(`${sourceId}\0${commit}\0${relativePath}`).slice(0, 32)}`
      const staged = {
        token,
        sourceId,
        commit,
        root: target,
        directory,
        relativePath,
        name: meta.name,
        repoMode: path.resolve(directory) !== path.resolve(target),
      }
      this.staged.set(token, staged)
      const entry = entryDto(staged, meta)
      const installed = store.skills[sharedSkillId(meta.name)]
      entry.installed = Boolean(installed)
      entry.installedId = installed ? sharedSkillId(meta.name) : null
      entry.upToDate = Boolean(installed && installed.contentHash === meta.contentHash)
      entries.push(entry)
    }
    if (!entries.length) {
      removeDirectory(target)
      fail('SKILL_MARKET_NO_SKILLS')
    }
    source.lastCheckedAt = this.now().toISOString()
    source.lastCommit = commit
    store.sources[sourceId] = source
    this.library.saveStore(store)
    this.library.notify()
    return {
      source: sourceDto(source),
      commit,
      entries: entries.sort((left, right) => left.name.localeCompare(right.name)),
    }
  }

  installEntry({ token, repo = false } = {}) {
    if (!TOKEN.test(String(token || ''))) fail('SKILL_MARKET_ENTRY_INVALID')
    const staged = this.staged.get(token)
    if (!staged) fail('SKILL_MARKET_ENTRY_EXPIRED')
    const store = this.library.loadStore()
    const source = store.sources[staged.sourceId]
    if (!source) fail('SKILL_MARKET_SOURCE_NOT_FOUND')
    return this.library.installMarketEntry({
      source: sourceDto(source),
      commit: staged.commit,
      stagingDirectory: staged.directory,
      repoRoot: staged.root,
      relativePath: staged.relativePath,
      name: staged.name,
      repo: repo === true && staged.repoMode === true,
    })
  }

  async checkUpdates() {
    const store = this.library.loadStore()
    const groups = new Map()
    for (const [skillId, skill] of Object.entries(store.skills)) {
      if (skill.sourceKind !== 'market' || !skill.origin?.url) continue
      const key = skill.origin.sourceId || skill.origin.url
      const group = groups.get(key) || {
        source: store.sources[skill.origin.sourceId] || {
          id: key,
          url: skill.origin.url,
          ref: skill.origin.ref || '',
        },
        skills: [],
      }
      group.skills.push({ skillId, skill })
      groups.set(key, group)
    }
    const updates = []
    const errors = []
    for (const [key, group] of groups) {
      let latest
      try {
        latest = await this.latestCommit(group.source)
      } catch (error) {
        errors.push({ sourceId: key, url: group.source.url, code: error?.code || 'SKILL_MARKET_FETCH_FAILED' })
        continue
      }
      if (store.sources[key]) {
        store.sources[key].lastCheckedAt = this.now().toISOString()
        store.sources[key].lastCommit = latest
      }
      for (const { skillId, skill } of group.skills) {
        const updateAvailable = Boolean(latest && skill.origin.commit !== latest)
        store.skills[skillId] = { ...skill, updateAvailable }
        if (updateAvailable) {
          updates.push({
            skillId,
            name: skill.name,
            sourceId: key,
            currentCommit: skill.origin.commit,
            latestCommit: latest,
          })
        }
      }
    }
    this.library.saveStore(store)
    this.library.notify()
    return { updates, errors, checkedAt: this.now().toISOString() }
  }

  async previewUpdate({ skillId } = {}) {
    const record = this.library.recordById(skillId)
    if (record.sourceKind !== 'market' || !record.origin?.url) fail('SKILL_MARKET_UPDATE_INVALID')
    const origin = record.origin
    this.clearUpdateStaging(record.id)
    const target = path.join(this.stagingRoot, `update-${record.id}-${Date.now()}`)
    const commit = await this.clone(origin.url, origin.ref || '', target)
    const directories = discoverSkillDirectories(target, origin.subpath || '')
    let directory = directories.find(candidate => (
      path.relative(target, candidate).split(path.sep).join('/') === (origin.relativePath || '')
    ))
    if (!directory) directory = directories.find(candidate => path.basename(candidate) === record.name)
    if (!directory) {
      removeDirectory(target)
      fail('SKILL_MARKET_ENTRY_NOT_FOUND')
    }
    const relativePath = path.relative(target, directory).split(path.sep).join('/')
    const meta = safeReadSkillDirectory(directory, {
      expectedName: record.name,
      limits: this.limits,
    })
    if (!meta.contentHash) {
      removeDirectory(target)
      fail('SKILL_MARKET_ENTRY_INVALID')
    }
    const token = `market-${sha(`${record.id}\0${commit}\0${relativePath}`).slice(0, 32)}`
    const staged = {
      token,
      sourceId: origin.sourceId || origin.url,
      skillId: record.id,
      commit,
      root: target,
      directory,
      relativePath,
      name: record.name,
      originUrl: origin.url,
      originRef: origin.ref || '',
      repoMode: path.resolve(directory) !== path.resolve(target),
    }
    this.staged.set(token, staged)
    const current = this.library.detail(record.id)
    return {
      skillId: record.id,
      name: record.name,
      upToDate: meta.contentHash === current.contentHash,
      source: { url: origin.url, ref: origin.ref || '', commit },
      current: {
        contentHash: current.contentHash,
        version: current.version,
        origin: current.origin,
      },
      entry: entryDto(staged, meta),
    }
  }

  applyUpdate({ skillId, token } = {}) {
    if (!TOKEN.test(String(token || ''))) fail('SKILL_MARKET_ENTRY_INVALID')
    const staged = this.staged.get(token)
    if (!staged || staged.skillId !== skillId) fail('SKILL_MARKET_ENTRY_EXPIRED')
    const store = this.library.loadStore()
    const source = store.sources[staged.sourceId] || {
      id: staged.sourceId,
      url: staged.originUrl || '',
      ref: staged.originRef || '',
    }
    if (!source.url) fail('SKILL_MARKET_SOURCE_NOT_FOUND')
    return this.library.replaceMarketEntry({
      skillId,
      source: sourceDto(source),
      commit: staged.commit,
      stagingDirectory: staged.directory,
      repoRoot: staged.root,
      relativePath: staged.relativePath,
    })
  }
}

module.exports = {
  SkillMarket,
  SOURCE_ID,
  TOKEN,
  discoverSkillDirectories,
  validateRef,
  validateSubpath,
  validateUrl,
}
