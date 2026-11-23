const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MAX_FILES = 256
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const DESCRIPTION_LIMIT = 240
const PREVIEW_LIMIT = 1200
const BODY_LIMIT = 4000
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,80}){2}$/
const PROJECTION_ID = /^proj-[a-f0-9]{32}$/
const HASH_EXCLUDED_DIRS = new Set(['.git', 'node_modules'])
const HASH_EXCLUDED_FILES = new Set(['.DS_Store', '.tyche-managed.json', '.tyche-provenance.json'])
const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: MAX_FILE_BYTES,
  maxFiles: MAX_FILES,
  maxTotalBytes: MAX_TOTAL_BYTES,
})

function skillError(code, cause) {
  const error = new Error(code)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function fail(code, cause) {
  throw skillError(code, cause)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cleanLine(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function unquote(value) {
  const raw = String(value || '').trim()
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw) } catch { return '' }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'")
  return raw.replace(/\s+#.*$/, '').trim()
}

function frontmatterFields(contents) {
  const text = String(contents || '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { fields: {}, body: text.trim(), closed: false, endLine: -1 }
  const fields = {}
  let closed = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(---|\.\.\.)\s*$/.test(lines[index].trim())) {
      closed = index
      break
    }
    const match = lines[index].match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/)
    if (match && match[2] && match[2] !== '|' && match[2] !== '>') fields[match[1].toLowerCase()] = match[2]
  }
  return {
    fields,
    body: closed >= 0 ? lines.slice(closed + 1).join('\n').trim() : '',
    closed: closed >= 0,
    endLine: closed,
  }
}

function scalar(value) {
  const text = String(value ?? '')
  if (/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(text) && !/^\s|\s$/.test(text)) return text
  return JSON.stringify(text)
}

function readSkillMetadata(directory, limits = DEFAULT_LIMITS) {
  const filename = path.join(directory, 'SKILL.md')
  let raw
  let stat
  try {
    stat = fs.statSync(filename)
    if (!stat.isFile()) fail('SKILL_UNREADABLE')
    if (stat.size > limits.maxFileBytes) fail('SKILL_TOO_LARGE')
    raw = fs.readFileSync(filename, 'utf8')
  } catch (error) {
    if (error?.code === 'SKILL_TOO_LARGE' || error?.code === 'SKILL_UNREADABLE') throw error
    fail('SKILL_UNREADABLE', error)
  }
  const parsed = frontmatterFields(raw)
  const body = parsed.body.replace(/\u0000/g, '').slice(0, BODY_LIMIT)
  return {
    description: cleanLine(unquote(parsed.fields.description), DESCRIPTION_LIMIT),
    name: cleanLine(unquote(parsed.fields.name), 120),
    version: cleanLine(unquote(parsed.fields.version), 40) || null,
    body,
    preview: body.split(/\r?\n/).slice(0, 20).join('\n').slice(0, PREVIEW_LIMIT),
    fields: parsed.fields,
    raw,
    bytes: stat.size,
  }
}

function walkSkillFiles(root, { limits = DEFAULT_LIMITS, rejectSymlinks = false } = {}) {
  const files = []
  let totalBytes = 0

  function walk(directory, relative) {
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      fail('SKILL_UNREADABLE', error)
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (HASH_EXCLUDED_DIRS.has(entry.name)) continue
      if (HASH_EXCLUDED_FILES.has(entry.name)) continue
      if (entry.name.startsWith('.tyche-tmp-')) continue
      const filename = path.join(directory, entry.name)
      const next = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        if (rejectSymlinks) fail('SKILL_UNSAFE')
        continue
      }
      if (entry.isDirectory()) {
        walk(filename, next)
        continue
      }
      if (!entry.isFile()) continue
      let stat
      try {
        stat = fs.statSync(filename)
      } catch (error) {
        fail('SKILL_UNREADABLE', error)
      }
      if (stat.size > limits.maxFileBytes) fail('SKILL_TOO_LARGE')
      totalBytes += stat.size
      if (totalBytes > limits.maxTotalBytes) fail('SKILL_TOO_LARGE')
      files.push({
        relativePath: next,
        filename,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode,
      })
      if (files.length > limits.maxFiles) fail('SKILL_TOO_LARGE')
    }
  }

  walk(root, '')
  return { files, totalBytes }
}

function hashSkillDirectory(root, limits = DEFAULT_LIMITS) {
  const { files, totalBytes } = walkSkillFiles(root, { limits })
  const hash = crypto.createHash('sha256')
  const fileManifest = []
  for (const file of files) {
    let bytes
    try {
      bytes = fs.readFileSync(file.filename)
    } catch (error) {
      fail('SKILL_UNREADABLE', error)
    }
    const fileHash = crypto.createHash('sha256').update(bytes).digest('hex')
    fileManifest.push({ path: file.relativePath, hash: fileHash, size: file.size })
    hash.update(file.relativePath)
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return { contentHash: hash.digest('hex'), fileManifest, totalBytes, fileCount: files.length }
}

function treeSignature(root, limits = DEFAULT_LIMITS) {
  const { files, totalBytes } = walkSkillFiles(root, { limits })
  const hash = crypto.createHash('sha256')
  for (const file of files) {
    hash.update(file.relativePath)
    hash.update('\0')
    hash.update(String(file.size))
    hash.update('\0')
    hash.update(String(Math.trunc(file.mtimeMs)))
    hash.update('\n')
  }
  return { signature: hash.digest('hex'), fileCount: files.length, totalBytes }
}

function safeReadSkillDirectory(directory, { expectedName = '', limits = DEFAULT_LIMITS } = {}) {
  const folderName = path.basename(directory)
  try {
    const meta = readSkillMetadata(directory, limits)
    const hashed = hashSkillDirectory(directory, limits)
    return {
      ...meta,
      name: cleanLine(expectedName || meta.name || folderName, 120) || folderName,
      folderName,
      contentHash: hashed.contentHash,
      fileManifest: hashed.fileManifest,
      fileCount: hashed.fileCount,
      totalBytes: hashed.totalBytes,
      tooLarge: false,
      errorCode: null,
    }
  } catch (error) {
    const code = error?.code || 'SKILL_UNREADABLE'
    return {
      description: '',
      name: cleanLine(expectedName || folderName, 120) || folderName,
      version: null,
      body: '',
      preview: '',
      fields: {},
      raw: '',
      bytes: 0,
      folderName,
      contentHash: null,
      fileManifest: [],
      fileCount: 0,
      totalBytes: 0,
      tooLarge: code === 'SKILL_TOO_LARGE',
      errorCode: code,
    }
  }
}

function validSkillName(value) {
  return SKILL_NAME.test(String(value || ''))
}

function safeSkillName(value) {
  const raw = String(value || '').normalize('NFKC').toLowerCase()
  let name = raw
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  if (!name) name = 'skill'
  return SKILL_NAME.test(name) ? name : 'skill'
}

function nativeSkillId(agentKind, namespace, slug) {
  return `${agentKind}/${namespace}/${slug}`
}

function sharedSkillId(name) {
  return `shared/library/${name}`
}

function isInsideOrEqual(root, candidate) {
  if (candidate === root) return true
  const relative = path.relative(root, candidate)
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative))
}

function displayPath(absolute, home) {
  const resolvedHome = String(home || '').trim()
  if (resolvedHome) {
    const relative = path.relative(resolvedHome, absolute)
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      return `~/${relative.split(path.sep).join('/')}`
    }
    if (!relative) return '~'
  }
  return `…/${path.basename(absolute)}`
}

function copySkillDirectory(source, target, limits = DEFAULT_LIMITS) {
  const { files, totalBytes } = walkSkillFiles(source, { limits, rejectSymlinks: true })
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  for (const file of files) {
    const destination = path.join(target, ...file.relativePath.split('/'))
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.copyFileSync(file.filename, destination)
    try { fs.chmodSync(destination, file.mode & 0o777) } catch { /* best effort */ }
  }
  return { fileCount: files.length, totalBytes }
}

function readJsonFile(filename) {
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

function writeJsonAtomic(filename, value, mode = 0o600) {
  const directory = path.dirname(filename)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode })
  fs.renameSync(temporary, filename)
}

function readProvenance(directory) {
  const value = readJsonFile(path.join(directory, '.tyche-provenance.json'))
  if (!value || value.schemaVersion !== 1 || typeof value.skillId !== 'string') return null
  return value
}

function writeProvenance(directory, provenance) {
  writeJsonAtomic(path.join(directory, '.tyche-provenance.json'), provenance)
}

function readManagedMarker(directory) {
  const value = readJsonFile(path.join(directory, '.tyche-managed.json'))
  if (!value || value.schemaVersion !== 1
      || !PROJECTION_ID.test(String(value.projectionId || ''))
      || typeof value.skillId !== 'string'
      || !/^[a-f0-9]{64}$/.test(String(value.contentHash || ''))) return null
  return value
}

function writeManagedMarker(directory, marker) {
  writeJsonAtomic(path.join(directory, '.tyche-managed.json'), marker)
}

function normalizeSkillMarkdown(raw, { name, description }) {
  const text = String(raw || '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return skillMarkdownTemplate({ name, description, body: text })
  }
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(---|\.\.\.)\s*$/.test(lines[index].trim())) {
      end = index
      break
    }
  }
  if (end < 0) return skillMarkdownTemplate({ name, description, body: text })
  const head = lines.slice(1, end)
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '')
  const setField = (key, value) => {
    const index = head.findIndex(line => new RegExp(`^\\s*${key}\\s*:`, 'i').test(line))
    const line = `${key}: ${scalar(value)}`
    if (index >= 0) head[index] = line
    else head.push(line)
  }
  setField('name', name)
  setField('description', description)
  return ['---', ...head, '---', '', body].join('\n')
}

function replaceSkillBody(raw, body) {
  const parsed = frontmatterFields(raw)
  if (!parsed.closed) return String(body || '').trim()
  const lines = String(raw || '').replace(/^﻿/, '').split(/\r?\n/)
  return [
    ...lines.slice(0, parsed.endLine + 1),
    '',
    String(body || '').trim(),
  ].join('\n') + '\n'
}

function skillMarkdownTemplate({ name, description, body = '' }) {
  return [
    '---',
    `name: ${scalar(name)}`,
    `description: ${scalar(description)}`,
    '---',
    '',
    String(body || '').trim(),
  ].join('\n') + '\n'
}

function removeDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
}

module.exports = {
  BODY_LIMIT,
  DEFAULT_LIMITS,
  DESCRIPTION_LIMIT,
  HASH_EXCLUDED_DIRS,
  HASH_EXCLUDED_FILES,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  PREVIEW_LIMIT,
  PROJECTION_ID,
  SKILL_ID,
  SKILL_NAME,
  cleanLine,
  copySkillDirectory,
  displayPath,
  fail,
  frontmatterFields,
  hashSkillDirectory,
  isInsideOrEqual,
  isPlainObject,
  nativeSkillId,
  normalizeSkillMarkdown,
  readJsonFile,
  readManagedMarker,
  readProvenance,
  readSkillMetadata,
  removeDirectory,
  replaceSkillBody,
  safeReadSkillDirectory,
  safeSkillName,
  scalar,
  sharedSkillId,
  skillError,
  skillMarkdownTemplate,
  treeSignature,
  validSkillName,
  walkSkillFiles,
  writeJsonAtomic,
  writeManagedMarker,
  writeProvenance,
}
