const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { atomicWritePrivateFile } = require('../../security/private-file.cjs')
const inspector = require('./process-inspect.cjs')

const STORE_VERSION = 1
const ENDED_RETENTION_MS = 24 * 60 * 60 * 1000
const DEFAULT_LEADER_WAIT_MS = 10000
const VALID_STATUSES = new Set(['starting', 'running', 'ending', 'ended'])

const DEFAULT_INSPECT = Object.freeze({
  groupEmpty: inspector.groupEmpty,
  groupMembers: inspector.groupMembers,
  processGroupOf: inspector.processGroupOf,
  processProgramName: inspector.processProgramName,
  processStartTime: inspector.processStartTime,
  readEnvironmentMarker: inspector.readEnvironmentMarker,
})

function registryError(code, cause) {
  const error = Object.assign(new Error(code), { code })
  if (cause) error.cause = cause
  return error
}

class ProcessRegistry {
  constructor(options = {}) {
    if (typeof options.storagePath !== 'string' || !options.storagePath) {
      throw registryError('PROCESS_REGISTRY_STORAGE_REQUIRED')
    }
    this.storagePath = path.resolve(options.storagePath)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.inspect = { ...DEFAULT_INSPECT, ...(options.inspect || {}) }
    this.writeFile = typeof options.writeFile === 'function' ? options.writeFile : atomicWritePrivateFile
    this.sleepFn = typeof options.sleepFn === 'function'
      ? options.sleepFn
      : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
    this.leaderWaitMs = Number.isFinite(options.leaderWaitMs)
      ? Math.max(0, options.leaderWaitMs)
      : DEFAULT_LEADER_WAIT_MS
    this.records = []
    this.diagnostics = []
    this.queue = Promise.resolve()
    this.load()
  }

  nowMs() {
    const value = this.now()
    return value instanceof Date ? value.getTime() : Number(value)
  }

  load() {
    let bytes
    try {
      bytes = fs.readFileSync(this.storagePath)
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.records = []
        return this.records
      }
      this.diagnostics.push({ code: 'PROCESS_REGISTRY_LOAD_FAILED', error: String(error.message || error) })
      this.records = []
      return this.records
    }
    try {
      if (!bytes.length) throw registryError('PROCESS_REGISTRY_EMPTY')
      const parsed = JSON.parse(bytes.toString('utf8'))
      if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.records)) {
        throw registryError('PROCESS_REGISTRY_INVALID')
      }
      if (parsed.records.some((record) => (
        !record || typeof record.recordId !== 'string' || !VALID_STATUSES.has(record.status)
      ))) {
        throw registryError('PROCESS_REGISTRY_INVALID')
      }
      this.records = parsed.records
    } catch (error) {
      const timestamp = new Date(this.nowMs()).toISOString().replace(/[:.]/g, '-')
      try {
        fs.mkdirSync(path.dirname(this.storagePath), { recursive: true, mode: 0o700 })
        fs.renameSync(this.storagePath, `${this.storagePath}.corrupt-${timestamp}.json`)
      } catch (renameError) {
        this.diagnostics.push({
          code: 'PROCESS_REGISTRY_QUARANTINE_FAILED',
          error: String(renameError.message || renameError),
        })
      }
      this.diagnostics.push({
        code: 'PROCESS_REGISTRY_CORRUPT',
        error: String(error.message || error),
      })
      this.records = []
    }
    return this.records
  }

  enqueue(operation) {
    const run = this.queue.catch(() => {}).then(operation)
    this.queue = run.catch(() => {})
    return run
  }

  async persist(next) {
    const serialized = `${JSON.stringify({ version: STORE_VERSION, records: next }, null, 2)}\n`
    try {
      await this.writeFile(this.storagePath, serialized)
      this.records = next
    } catch (error) {
      if (error && error.phase === 'after-commit') {
        // The rename committed the new contents; keep memory in sync and
        // rewrite once to confirm durability (M1/M5 6.1, M3 3.3).
        this.records = next
        await this.writeFile(this.storagePath, serialized)
        return
      }
      throw error
    }
  }

  begin(record = {}) {
    return this.enqueue(async () => {
      if (!record.workdir || typeof record.workdir !== 'string') {
        throw registryError('PROCESS_REGISTRY_RECORD_INVALID')
      }
      if (!record.containerMarker || typeof record.containerMarker !== 'string') {
        throw registryError('PROCESS_REGISTRY_RECORD_INVALID')
      }
      const recordId = typeof record.recordId === 'string' && record.recordId
        ? record.recordId
        : `process-${crypto.randomUUID()}`
      const nextRecord = {
        recordId,
        invocationId: record.invocationId || null,
        groupId: record.groupId || null,
        projectId: record.projectId || null,
        workdir: record.workdir,
        permission: record.permission || null,
        claims: Array.isArray(record.claims) ? record.claims : [],
        containerMarker: record.containerMarker,
        agentKind: record.agentKind || null,
        createdAt: new Date(this.nowMs()).toISOString(),
        status: 'starting',
        pgid: null,
        leaderStartTime: null,
        finalKillMembers: null,
        endedAt: null,
      }
      await this.persist([...this.records, nextRecord])
      return recordId
    })
  }

  markRunning(recordId, { pgid, leaderStartTime } = {}) {
    return this.enqueue(async () => {
      const record = this.records.find((candidate) => candidate.recordId === recordId)
      if (!record) throw registryError('PROCESS_REGISTRY_RECORD_NOT_FOUND')
      const nextRecord = { ...record, status: 'running', pgid, leaderStartTime }
      await this.persist(this.replace(recordId, nextRecord))
      return nextRecord
    })
  }

  markEnding(recordId, { finalKillMembers } = {}) {
    return this.enqueue(async () => {
      const record = this.records.find((candidate) => candidate.recordId === recordId)
      if (!record) throw registryError('PROCESS_REGISTRY_RECORD_NOT_FOUND')
      const nextRecord = {
        ...record,
        status: 'ending',
        finalKillMembers: Array.isArray(finalKillMembers) ? finalKillMembers : null,
      }
      await this.persist(this.replace(recordId, nextRecord))
      return nextRecord
    })
  }

  markEnded(recordId) {
    return this.enqueue(async () => {
      const record = this.records.find((candidate) => candidate.recordId === recordId)
      if (!record) throw registryError('PROCESS_REGISTRY_RECORD_NOT_FOUND')
      const nextRecord = {
        ...record,
        status: 'ended',
        endedAt: new Date(this.nowMs()).toISOString(),
      }
      const cutoff = this.nowMs() - ENDED_RETENTION_MS
      const next = this.replace(recordId, nextRecord).filter((candidate) => (
        candidate.status !== 'ended'
        || !candidate.endedAt
        || !Number.isFinite(Date.parse(candidate.endedAt))
        || Date.parse(candidate.endedAt) >= cutoff
      ))
      await this.persist(next)
      return nextRecord
    })
  }

  recover() {
    return this.enqueue(async () => {
      const results = []
      const next = []
      let changed = false
      for (const record of this.records) {
        if (record.status === 'ended') {
          next.push(record)
          continue
        }
        const outcome = await this.inspectRecord(record)
        results.push(outcome)
        if (outcome.outcome === 'ended') {
          next.push({ ...record, status: 'ended', endedAt: new Date(this.nowMs()).toISOString() })
          changed = true
        } else {
          next.push(record)
        }
      }
      if (changed) await this.persist(next)
      return results
    })
  }

  replace(recordId, nextRecord) {
    return this.records.map((candidate) => (
      candidate.recordId === recordId ? nextRecord : candidate
    ))
  }

  ended(record) {
    return { recordId: record.recordId, outcome: 'ended' }
  }

  residual(record, members) {
    return {
      recordId: record.recordId,
      outcome: 'residual',
      residual: {
        recordId: record.recordId,
        workdir: record.workdir,
        claims: Array.isArray(record.claims) ? record.claims : [],
        pgid: record.pgid,
        containerMarker: record.containerMarker,
        agentKind: record.agentKind || null,
        members: members.map((member) => ({
          pid: member.pid,
          startTime: member.startTime,
          agentKind: record.agentKind || null,
          programName: member.programName || null,
          marker: member.marker || 'unreadable',
        })),
      },
    }
  }

  async inspectRecord(record) {
    if (record.status === 'starting' && !record.pgid) return this.ended(record)
    if (!Number.isInteger(record.pgid) || record.pgid <= 0) return this.ended(record)
    if (await this.inspect.groupEmpty(record.pgid)) return this.ended(record)

    const leaderStartTime = await this.inspect.processStartTime(record.pgid)
    const leaderGroup = leaderStartTime == null
      ? null
      : await this.inspect.processGroupOf(record.pgid)
    if (leaderStartTime != null && leaderGroup === record.pgid) {
      if (!record.leaderStartTime) {
        // A live leader with no recorded start time cannot be proven separate
        // from a reused pid; keep it as an unresolved residual.
        const members = await this.inspect.groupMembers(record.pgid)
        return this.residual(record, await this.enrichMembers(record, members))
      }
      if (leaderStartTime !== record.leaderStartTime) {
        // The group number now belongs to a different leader: the original
        // container has already emptied.
        return this.ended(record)
      }
      const deadline = this.nowMs() + this.leaderWaitMs
      for (;;) {
        if (this.nowMs() >= deadline) {
          const members = await this.inspect.groupMembers(record.pgid)
          return this.residual(record, await this.enrichMembers(record, members))
        }
        await this.sleepFn(Math.min(100, Math.max(0, deadline - this.nowMs())))
        if (await this.inspect.groupEmpty(record.pgid)) return this.ended(record)
        const currentStartTime = await this.inspect.processStartTime(record.pgid)
        const currentGroup = currentStartTime == null
          ? null
          : await this.inspect.processGroupOf(record.pgid)
        if (currentStartTime == null || currentGroup !== record.pgid) break
        if (currentStartTime !== leaderStartTime) return this.ended(record)
      }
      if (await this.inspect.groupEmpty(record.pgid)) return this.ended(record)
    }
    return this.evaluateMembers(record)
  }

  async enrichMembers(record, members) {
    const enriched = []
    for (const member of members) {
      const marker = record.containerMarker
        ? await this.inspect.readEnvironmentMarker(member.pid, record.containerMarker)
        : 'unreadable'
      const programName = typeof this.inspect.processProgramName === 'function'
        ? await this.inspect.processProgramName(member.pid)
        : null
      enriched.push({ ...member, marker, programName })
    }
    return enriched
  }

  async evaluateMembers(record) {
    const members = await this.inspect.groupMembers(record.pgid)
    if (!Array.isArray(members) || !members.length) return this.ended(record)
    const createdAtMs = Date.parse(record.createdAt)
    let allProvenOutside = true
    for (const member of members) {
      const startTimeMs = typeof member.startTime === 'number'
        ? member.startTime
        : Date.parse(member.startTime)
      const earlierThanContainer = Number.isFinite(startTimeMs)
        && Number.isFinite(createdAtMs)
        && startTimeMs + 1000 < createdAtMs
      if (!earlierThanContainer) allProvenOutside = false
    }
    if (allProvenOutside) return this.ended(record)
    return this.residual(record, await this.enrichMembers(record, members))
  }
}

module.exports = {
  ENDED_RETENTION_MS,
  ProcessRegistry,
  STORE_VERSION,
}
