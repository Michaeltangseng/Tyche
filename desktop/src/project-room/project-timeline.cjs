const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { z } = require('zod')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')
const { redactSecrets } = require('../security/secret-redaction.cjs')

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9._:-]{1,120}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function storageFault(reason, details = {}) {
  return Object.assign(new Error('PROJECT_STORAGE_FAULT'), {
    code: 'PROJECT_STORAGE_FAULT',
    details: { reason, ...details },
  })
}

function inputError(reason, details = {}) {
  return Object.assign(new Error('PROJECT_INPUT_INVALID'), {
    code: 'PROJECT_INPUT_INVALID',
    details: { reason, ...details },
  })
}

class PendingMessageStore {
  constructor({
    projectDir,
    now = Date.now,
    writeFile = atomicWritePrivateFile,
    readFile = fs.readFileSync,
    removeFile = fs.rmSync,
  } = {}) {
    this.projectDir = projectDir
    this.directory = path.join(projectDir, 'pending-messages')
    this.now = now
    this.writeFile = writeFile
    this.readFile = readFile
    this.removeFile = removeFile
  }

  refFor(sourceKey) {
    return sha256(JSON.stringify(sourceKey))
  }

  #file(ref) {
    return path.join(this.directory, `${ref}.json`)
  }

  async stage({ sourceKey, body, metadata = {} } = {}) {
    if (sourceKey === undefined || sourceKey === null) throw inputError('source-key-required')
    const redacted = redactSecrets(String(body || ''))
    if (!redacted) throw inputError('message-body-required')
    const ref = this.refFor(sourceKey)
    const payload = {
      schemaVersion: 1,
      ref,
      sourceKey,
      body: redacted,
      metadata,
      createdAt: this.now(),
    }
    const contents = `${JSON.stringify(payload)}\n`
    const filename = this.#file(ref)
    if (fs.existsSync(filename)) {
      const existing = this.readFile(filename, 'utf8')
      if (existing !== contents && JSON.parse(existing).body !== redacted) {
        throw storageFault('pending-message-conflict', { ref })
      }
      return { ref, summary: sha256(redacted) }
    }
    try {
      await this.writeFile(filename, contents)
    } catch (error) {
      if (error?.phase !== 'after-commit') throw error
    }
    return { ref, summary: sha256(redacted) }
  }

  read(ref) {
    if (!HASH.test(String(ref || ''))) throw inputError('pending-ref-invalid')
    let source
    try {
      source = this.readFile(this.#file(ref), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    const payload = JSON.parse(source)
    if (payload?.schemaVersion !== 1 || payload?.ref !== ref
        || typeof payload.body !== 'string') {
      throw storageFault('pending-message-corrupt', { ref })
    }
    return payload
  }

  async consume(ref) {
    if (!HASH.test(String(ref || ''))) throw inputError('pending-ref-invalid')
    this.removeFile(this.#file(ref), { force: true })
  }

  async cleanupOrphans(referenced) {
    const keep = new Set(Array.isArray(referenced) ? referenced : [])
    let entries
    try {
      entries = fs.readdirSync(this.directory)
    } catch (error) {
      if (error?.code === 'ENOENT') return 0
      throw error
    }
    let removed = 0
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const ref = entry.slice(0, -5)
      if (!HASH.test(ref) || keep.has(ref)) continue
      this.removeFile(path.join(this.directory, entry), { force: true })
      removed += 1
    }
    return removed
  }
}

const id = z.string().regex(ID)
const timestamp = z.union([z.string().max(80).regex(TIMESTAMP), z.number().int().nonnegative()])

const checkpointRecord = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(HASH),
  type: z.enum(['checkpoint-start', 'checkpoint-reopen']),
  projectId: id,
  checkpointId: id,
  checkpointKey: id,
  generation: z.number().int().nonnegative(),
  at: timestamp,
  reason: z.string().max(32768).optional(),
})

const gateRecord = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(HASH),
  type: z.enum(['gate-decided', 'gate-voided']),
  projectId: id,
  checkpointId: id,
  checkpointKey: id,
  generation: z.number().int().nonnegative(),
  gateId: id,
  gateRevision: z.number().int().positive(),
  at: timestamp,
  reason: z.string().max(200).optional(),
  outcome: z.enum(['continue', 'accept', 'reject-upstream']).optional(),
  comment: z.string().max(32768).optional(),
  candidateCommit: z.string().max(64).nullable().optional(),
  reviewFiles: z.array(z.string().max(4096)).max(64).optional(),
})

const timelineRecord = z.union([checkpointRecord, gateRecord])

class TimelineHistoryStore {
  constructor({
    projectDir,
    now = Date.now,
    key = crypto.randomBytes(32),
    writeFile = atomicWritePrivateFile,
    readFile = fs.readFileSync,
  } = {}) {
    this.projectDir = projectDir
    this.directory = path.join(projectDir, 'timeline')
    this.now = now
    this.key = key
    this.writeFile = writeFile
    this.readFile = readFile
  }

  #file(recordId) {
    return path.join(this.directory, `${recordId}.json`)
  }

  #normalize(record) {
    const parsed = timelineRecord.parse(record)
    if (parsed.comment !== undefined) {
      parsed.comment = redactSecrets(parsed.comment).slice(0, 32768)
    }
    if (parsed.reason !== undefined) {
      parsed.reason = redactSecrets(parsed.reason).slice(0, 32768)
    }
    return parsed
  }

  async append({ id: recordId, record } = {}) {
    if (!HASH.test(String(recordId || ''))) throw inputError('timeline-id-invalid')
    let parsed
    try {
      parsed = this.#normalize(record || {})
    } catch (error) {
      throw inputError('timeline-record-invalid', {
        issues: error?.issues?.map(issue => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })) || [],
      })
    }
    if (parsed.id !== recordId) throw inputError('timeline-id-mismatch')
    const contents = `${JSON.stringify(parsed)}\n`
    const filename = this.#file(recordId)
    if (fs.existsSync(filename)) {
      if (this.readFile(filename, 'utf8') !== contents) {
        throw storageFault('timeline-record-conflict', { recordId })
      }
      return structuredClone(parsed)
    }
    try {
      await this.writeFile(filename, contents)
    } catch (error) {
      if (error?.phase !== 'after-commit') throw error
    }
    return structuredClone(parsed)
  }

  #archived() {
    let entries
    try {
      entries = fs.readdirSync(this.directory)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue
      const recordId = entry.slice(0, -5)
      if (!HASH.test(recordId)) continue
      try {
        const parsed = timelineRecord.parse(JSON.parse(this.readFile(this.#file(recordId), 'utf8')))
        if (parsed.id === recordId) records.push(parsed)
      } catch {
        // A corrupt history record is skipped; it cannot drive decisions.
      }
    }
    return records
  }

  encodeCursor(projectId, offset) {
    const payload = Buffer.from(JSON.stringify({ projectId, offset }), 'utf8')
      .toString('base64url')
    const signature = crypto.createHmac('sha256', this.key).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }

  decodeCursor(cursor, projectId) {
    const [payload, signature] = String(cursor || '').split('.')
    if (!payload || !signature) throw inputError('timeline-cursor-invalid')
    const expected = crypto.createHmac('sha256', this.key).update(payload).digest('base64url')
    const left = Buffer.from(signature)
    const right = Buffer.from(expected)
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      throw inputError('timeline-cursor-invalid')
    }
    let value
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch {
      throw inputError('timeline-cursor-invalid')
    }
    if (value?.projectId !== projectId || !Number.isSafeInteger(value.offset) || value.offset < 0) {
      throw inputError('timeline-cursor-invalid')
    }
    return value.offset
  }

  read({ projectId, cursor, limit = 50, pending = [] } = {}) {
    if (!ID.test(String(projectId || ''))) throw inputError('timeline-project-invalid')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw inputError('timeline-limit-invalid')
    }
    const byId = new Map()
    for (const record of this.#archived()) {
      if (record.projectId === projectId) byId.set(record.id, record)
    }
    for (const record of Array.isArray(pending) ? pending : []) {
      let parsed
      try {
        parsed = timelineRecord.parse(record)
      } catch {
        continue
      }
      if (parsed.projectId !== projectId || byId.has(parsed.id)) continue
      byId.set(parsed.id, parsed)
    }
    const records = [...byId.values()].sort((left, right) => {
      const leftAt = typeof left.at === 'number' ? left.at : Date.parse(left.at)
      const rightAt = typeof right.at === 'number' ? right.at : Date.parse(right.at)
      return leftAt - rightAt || left.id.localeCompare(right.id)
    })
    const offset = cursor === undefined || cursor === null || cursor === ''
      ? 0
      : this.decodeCursor(cursor, projectId)
    if (offset > records.length) throw inputError('timeline-cursor-invalid')
    const items = records.slice(offset, offset + limit)
    const nextOffset = offset + items.length
    return {
      items,
      total: records.length,
      nextCursor: nextOffset < records.length
        ? this.encodeCursor(projectId, nextOffset)
        : null,
    }
  }
}

module.exports = {
  PendingMessageStore,
  TimelineHistoryStore,
  sha256,
}
