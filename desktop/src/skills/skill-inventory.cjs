const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { LocalSkillCatalog } = require('./local-skill-catalog.cjs')

const AGENT_KINDS = Object.freeze([
  'claude', 'codex', 'gemini', 'pi', 'hermes', 'kimi', 'deepseek', 'qwen', 'opencode', 'openclaw', 'workbuddy',
])
const MAX_ROLE_SKILLS = 8
const MAX_CAPTAIN_SKILLS = 24
const DESCRIPTION_LIMIT = 240
const CAPTAIN_DESCRIPTION_LIMIT = 80
const PREVIEW_LIMIT = 1200
const BODY_LIMIT = 4000
const DEFAULT_MAX_FILES = 256
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,80}){2}$/

function inventoryError(code) {
  return Object.assign(new Error(code), { code })
}

function fail(code) {
  throw inventoryError(code)
}

function cleanLine(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function frontmatterFields(contents) {
  const lines = String(contents || '').replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { fields: {}, body: String(contents || '').trim() }
  const fields = {}
  let closed = 0
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(---|\.\.\.)\s*$/.test(lines[index].trim())) {
      closed = index
      break
    }
    const match = lines[index].match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/)
    if (match && match[2] && match[2] !== '|' && match[2] !== '>') fields[match[1].toLowerCase()] = match[2]
  }
  const body = closed ? lines.slice(closed + 1).join('\n').trim() : ''
  return { fields, body }
}

function unquote(value) {
  const raw = String(value || '').trim()
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw) } catch { return '' }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'")
  return raw.replace(/\s+#.*$/, '').trim()
}

function skillId(kind, namespace, slug) {
  return `${kind}/${namespace}/${slug}`
}

function hashDirectory(root, limits) {
  const files = []
  function walk(directory, relative) {
    if (files.length > limits.maxFiles) fail('SKILL_INVENTORY_TOO_LARGE')
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { fail('SKILL_INVENTORY_UNREADABLE') }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (entry.isSymbolicLink()) continue
      const filename = path.join(directory, entry.name)
      const next = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(filename, next)
      else if (entry.isFile()) {
        const stat = fs.statSync(filename)
        if (stat.size > limits.maxFileBytes) fail('SKILL_INVENTORY_TOO_LARGE')
        files.push({ relative: next, filename, size: stat.size })
      }
    }
  }
  walk(root, '')
  let total = 0
  const hash = crypto.createHash('sha256')
  for (const file of files) {
    total += file.size
    if (total > limits.maxTotalBytes) fail('SKILL_INVENTORY_TOO_LARGE')
    hash.update(file.relative)
    hash.update('\0')
    hash.update(fs.readFileSync(file.filename))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function readSkillFile(filename, limits) {
  const raw = fs.readFileSync(filename, 'utf8')
  const { fields, body } = frontmatterFields(raw)
  let contentHash = null
  let tooLarge = false
  try {
    contentHash = hashDirectory(path.dirname(filename), limits)
  } catch (error) {
    if (error?.code !== 'SKILL_INVENTORY_TOO_LARGE') throw error
    tooLarge = true
  }
  const text = body.replace(/\u0000/g, '').slice(0, BODY_LIMIT)
  return {
    description: cleanLine(unquote(fields.description), DESCRIPTION_LIMIT),
    body: text,
    preview: text.split(/\r?\n/).slice(0, 20).join('\n').slice(0, PREVIEW_LIMIT),
    contentHash,
    tooLarge,
  }
}

function emptyStore() {
  return { schemaVersion: 1, eligibility: {}, trust: {}, defaults: {} }
}

function normalizeStore(value) {
  if (!value || value.schemaVersion !== 1 || !value.eligibility || !value.trust || !value.defaults) {
    fail('SKILL_INVENTORY_STORE_INVALID')
  }
  return value
}

class SkillInventory {
  constructor({
    storagePath,
    catalog = null,
    home,
    now = () => new Date(),
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  } = {}) {
    if (typeof storagePath !== 'string' || !path.isAbsolute(storagePath)) {
      fail('SKILL_INVENTORY_STORE_INVALID')
    }
    this.storagePath = path.normalize(storagePath)
    this.catalog = catalog || new LocalSkillCatalog(home ? { home } : {})
    this.now = now
    this.limits = { maxFileBytes, maxFiles, maxTotalBytes }
    this.cache = new Map()
  }

  loadStore() {
    try {
      if (!fs.existsSync(this.storagePath)) return emptyStore()
      return normalizeStore(JSON.parse(fs.readFileSync(this.storagePath, 'utf8')))
    } catch (error) {
      if (error?.code === 'SKILL_INVENTORY_STORE_INVALID') throw error
      fail('SKILL_INVENTORY_STORE_INVALID')
    }
  }

  writeStore(store) {
    const directory = path.dirname(this.storagePath)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.storagePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, this.storagePath)
  }

  scan() {
    const records = []
    for (const kind of AGENT_KINDS) {
      const listed = this.catalog.list(kind)
      if (!listed.supported || !listed.skills.length) continue
      let resolved = []
      try {
        resolved = this.catalog.resolveSelections(kind, listed.skills)
      } catch {
        for (const skill of listed.skills) {
          try { resolved.push(...this.catalog.resolveSelections(kind, [skill])) } catch { /* skip one unreadable skill */ }
        }
      }
      for (const skill of resolved) {
        const filename = path.join(skill.sourceDirectory, 'SKILL.md')
        let stat
        try { stat = fs.statSync(filename) } catch { continue }
        const cacheKey = `${skill.sourceDirectory}\0${stat.mtimeMs}\0${stat.size}`
        let details = this.cache.get(cacheKey)
        if (!details) {
          try { details = readSkillFile(filename, this.limits) } catch { continue }
          this.cache.set(cacheKey, details)
        }
        records.push({
          id: skillId(kind, skill.namespace, skill.slug),
          originKind: kind,
          namespace: skill.namespace,
          slug: skill.slug,
          name: skill.name,
          ...details,
        })
      }
    }
    return records
  }

  decorate(records, store = this.loadStore()) {
    return records.map((record) => {
      const approved = store.trust[record.id]
      let trust = 'untrusted'
      if (record.tooLarge || !record.contentHash) trust = 'unavailable'
      else if (approved?.contentHash && approved.contentHash === record.contentHash) trust = 'trusted'
      else if (approved?.contentHash) trust = 'changed'
      const eligible = Array.isArray(store.eligibility[record.id])
        ? store.eligibility[record.id].filter(kind => kind === record.originKind)
        : []
      return { ...record, trust, eligible, trustedAt: approved?.trustedAt || null }
    })
  }

  requireRecord(id) {
    if (!SKILL_ID.test(String(id || ''))) fail('SKILL_INVENTORY_NOT_FOUND')
    const record = this.decorate(this.scan()).find(item => item.id === id)
    if (!record) fail('SKILL_INVENTORY_NOT_FOUND')
    return record
  }

  list() {
    const store = this.loadStore()
    const skills = this.decorate(this.scan(), store).map(record => ({
      id: record.id,
      originKind: record.originKind,
      namespace: record.namespace,
      slug: record.slug,
      name: record.name,
      description: record.description,
      trust: record.trust,
      eligible: record.eligible,
      source: 'native',
      trustedAt: record.trustedAt,
      preview: record.preview,
    }))
    const present = new Set(skills.map(skill => skill.originKind))
    return {
      agents: AGENT_KINDS.filter(kind => present.has(kind)),
      skills,
      defaults: store.defaults,
    }
  }

  trust(id) {
    const record = this.requireRecord(id)
    if (record.tooLarge || !record.contentHash) fail('SKILL_INVENTORY_TOO_LARGE')
    const store = this.loadStore()
    store.trust[id] = { contentHash: record.contentHash, trustedAt: this.now().toISOString() }
    this.writeStore(store)
    return { id, trust: 'trusted' }
  }

  revoke(id) {
    this.requireRecord(id)
    const store = this.loadStore()
    delete store.trust[id]
    delete store.eligibility[id]
    for (const kind of Object.keys(store.defaults)) {
      store.defaults[kind] = store.defaults[kind].filter(skillId => skillId !== id)
    }
    this.writeStore(store)
    return { id, trust: 'untrusted' }
  }

  setEligible(id, agent, enabled) {
    const kind = String(agent || '')
    const record = this.requireRecord(id)
    if (kind !== record.originKind) fail('SKILL_INVENTORY_AGENT_INVALID')
    if (enabled && (record.tooLarge || !record.contentHash)) fail('SKILL_INVENTORY_TOO_LARGE')
    const store = this.loadStore()
    if (enabled) {
      store.trust[id] = { contentHash: record.contentHash, trustedAt: this.now().toISOString() }
      store.eligibility[id] = [kind]
    } else {
      store.eligibility[id] = []
      delete store.trust[id]
      if (Array.isArray(store.defaults[kind])) {
        store.defaults[kind] = store.defaults[kind].filter(skillId => skillId !== id)
      }
    }
    this.writeStore(store)
    return { id, eligible: store.eligibility[id], trust: enabled ? 'trusted' : 'untrusted' }
  }

  enableForAgents(id) {
    const record = this.requireRecord(id)
    this.setEligible(id, record.originKind, true)
    return this.requireRecord(id).eligible
  }

  assertSelectable(agent, ids) {
    const kind = String(agent || '')
    if (!AGENT_KINDS.includes(kind)) fail('SKILL_INVENTORY_AGENT_INVALID')
    if (!Array.isArray(ids) || ids.length > MAX_ROLE_SKILLS) fail('SKILL_INVENTORY_SELECTION_INVALID')
    const available = new Map(this.decorate(this.scan())
      .filter(record => record.trust === 'trusted' && record.eligible.includes(kind))
      .map(record => [record.id, record]))
    const selected = []
    const seen = new Set()
    for (const id of ids) {
      if (typeof id !== 'string' || seen.has(id) || !available.has(id)) fail('SKILL_INVENTORY_SELECTION_INVALID')
      seen.add(id)
      selected.push(id)
    }
    return selected
  }

  rememberDefault(agent, ids) {
    const selected = this.assertSelectable(agent, ids)
    const store = this.loadStore()
    store.defaults[agent] = selected
    this.writeStore(store)
    return selected
  }

  defaults(agent) {
    const stored = this.loadStore().defaults[String(agent || '')]
    if (!Array.isArray(stored) || !stored.length) return []
    try { return this.assertSelectable(agent, stored) } catch { return [] }
  }

  captainInventory(providers) {
    const wanted = (Array.isArray(providers) ? providers : []).filter(kind => AGENT_KINDS.includes(kind))
    const records = this.decorate(this.scan())
    return {
      providers: wanted.map((provider) => {
        const skills = records.filter(record => record.trust === 'trusted' && record.eligible.includes(provider))
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

  materialize(agent, ids) {
    const kind = String(agent || '')
    const records = new Map(this.decorate(this.scan()).map(record => [record.id, record]))
    const skills = []
    const dropped = []
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, MAX_ROLE_SKILLS)) {
      const record = records.get(id)
      if (!record || record.trust !== 'trusted' || !record.eligible.includes(kind)) {
        dropped.push({ id: String(id || ''), reason: 'unavailable' })
        continue
      }
      skills.push({
        id: record.id,
        name: record.name,
        description: record.description,
        body: record.body,
      })
    }
    return { skills, dropped }
  }
}

module.exports = {
  AGENT_KINDS,
  MAX_ROLE_SKILLS,
  SkillInventory,
}
