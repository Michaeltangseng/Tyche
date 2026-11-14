const fs = require('node:fs')
const path = require('node:path')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')
const { parseProjectState } = require('./project-state-schema.cjs')

const REGULAR_LIMIT_BYTES = 8 * 1024 * 1024
const CONTROL_LIMIT_BYTES = 9 * 1024 * 1024
const FAULT_FILE = 'fault.json'
const STATE_OVER_LIMIT_EFFECT = 'project-state-over-limit'

function projectError(code, details = {}) {
  return Object.assign(new Error(code), { code, details })
}

function serializedSize(state) {
  return Buffer.byteLength(`${JSON.stringify(state)}\n`, 'utf8')
}

const KEEP_ROUNDS = 5
const KEEP_CONSUMED_EFFECTS = 20
const KEEP_DECISIONS = 50
const METRIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const ENDED_LEASE_STATUSES = new Set(['withdrawn', 'released'])

function timestampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function monthOf(value) {
  const ms = timestampMs(value)
  return ms === null ? null : new Date(ms).toISOString().slice(0, 7)
}

function summarizeRounds(rounds) {
  const verdicts = {
    pass: 0, revise: 0, 'needs-human': 0, missing: 0, failed: 0, cancelled: 0,
  }
  for (const round of rounds) {
    for (const review of round.reviews) {
      if (Object.hasOwn(verdicts, review.verdict)) verdicts[review.verdict] += 1
    }
  }
  return {
    from: rounds[0].round,
    to: rounds[rounds.length - 1].round,
    verdicts,
  }
}

function keepRecentConsumed(effects, limit) {
  let consumed = 0
  const keep = new Set()
  for (let index = effects.length - 1; index >= 0; index -= 1) {
    const status = effects[index].status
    if (status === 'consumed' || status === 'voided') {
      consumed += 1
      if (consumed <= limit) keep.add(index)
    } else {
      keep.add(index)
    }
  }
  return effects.filter((_, index) => keep.has(index))
}

function openLeases(requests) {
  return requests.filter(request => !ENDED_LEASE_STATUSES.has(request.status))
}

function compactGateMetrics(decisions, months, cutoff) {
  const recent = []
  const aggregates = new Map(months.map(month => [
    month.month,
    {
      ...month,
      outcomes: { ...month.outcomes },
    },
  ]))
  for (const decision of decisions) {
    const decidedAt = timestampMs(decision.decidedAt)
    const month = monthOf(decision.decidedAt)
    if (decidedAt === null || decidedAt >= cutoff || month === null) {
      recent.push(decision)
      continue
    }
    const aggregate = aggregates.get(month) || {
      month,
      count: 0,
      outcomes: { continue: 0, accept: 0, 'reject-upstream': 0 },
      durationMs: 0,
      requestedChangesAfterPass: 0,
      acceptedAsIs: 0,
    }
    aggregate.count += 1
    aggregate.outcomes[decision.outcome] += 1
    aggregate.durationMs += decision.durationMs
    if (decision.requestedChangesAfterPass) aggregate.requestedChangesAfterPass += 1
    if (decision.acceptedAsIs) aggregate.acceptedAsIs += 1
    aggregates.set(month, aggregate)
  }
  return {
    recent,
    months: [...aggregates.values()].sort((left, right) => left.month.localeCompare(right.month)),
  }
}

function compactReopeningMetrics(reopenings, months, cutoff) {
  const recent = []
  const aggregates = new Map(months.map(month => [month.month, { ...month }]))
  for (const reopening of reopenings) {
    const at = timestampMs(reopening.at)
    const month = monthOf(reopening.at)
    if (at === null || at >= cutoff || month === null) {
      recent.push(reopening)
      continue
    }
    const aggregate = aggregates.get(month) || { month, count: 0 }
    aggregate.count += 1
    aggregates.set(month, aggregate)
  }
  return {
    recent,
    months: [...aggregates.values()].sort((left, right) => left.month.localeCompare(right.month)),
  }
}

// M1/M5 4.6: stricter retention on demand. Active records are never removed.
function compact(state, now = Date.now()) {
  const next = structuredClone(state)
  const cutoff = now - METRIC_RETENTION_MS
  next.instances = next.instances.map((instance) => {
    const rounds = instance.rounds.slice(-KEEP_ROUNDS)
    const roundsSummary = [...instance.roundsSummary]
    if (instance.rounds.length > KEEP_ROUNDS) {
      roundsSummary.push(summarizeRounds(instance.rounds.slice(0, -KEEP_ROUNDS)))
    }
    return {
      ...instance,
      rounds,
      roundsSummary,
      effects: keepRecentConsumed(instance.effects, KEEP_CONSUMED_EFFECTS),
      decisions: instance.decisions.slice(-KEEP_DECISIONS),
      leaseRequests: openLeases(instance.leaseRequests),
    }
  })
  next.driftItems = next.driftItems.filter(item => (
    item.status === 'unresolved' || item.status === 'resolving'
  ))
  next.outOfScopeItems = next.outOfScopeItems.filter(item => item.status === 'unresolved')
  next.projectEffects = keepRecentConsumed(next.projectEffects, KEEP_CONSUMED_EFFECTS)
  next.maintenanceLeaseRequests = openLeases(next.maintenanceLeaseRequests)
  const gates = compactGateMetrics(
    next.metrics.gateDecisions, next.metrics.gateDecisionMonths, cutoff,
  )
  next.metrics.gateDecisions = gates.recent
  next.metrics.gateDecisionMonths = gates.months
  const reopenings = compactReopeningMetrics(
    next.metrics.reopenings, next.metrics.reopeningMonths, cutoff,
  )
  next.metrics.reopenings = reopenings.recent
  next.metrics.reopeningMonths = reopenings.months
  return next
}

class ProjectStore {
  constructor({
    projectDir,
    now = () => new Date().toISOString(),
    writeFile = atomicWritePrivateFile,
    limits = {},
  } = {}) {
    if (!projectDir) throw projectError('PROJECT_STATE_INVALID', { reason: 'project-dir-required' })
    this.projectDir = projectDir
    this.statePath = path.join(projectDir, 'state.json')
    this.faultPath = path.join(projectDir, FAULT_FILE)
    this.now = now
    this.writeFile = writeFile
    this.regularLimit = limits.regular ?? REGULAR_LIMIT_BYTES
    this.controlLimit = limits.control ?? CONTROL_LIMIT_BYTES
    this.state = null
    this.readOnly = false
    this.storageFault = null
    this.listeners = new Set()
    this.tail = Promise.resolve()
  }

  async load() {
    if (fs.existsSync(this.faultPath)) this.readOnly = true
    let source
    try {
      source = fs.readFileSync(this.statePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw projectError('PROJECT_STATE_INVALID', { reason: 'missing' })
      }
      throw error
    }
    let value
    try {
      value = JSON.parse(source)
    } catch {
      throw projectError('PROJECT_STATE_INVALID', { reason: 'corrupt' })
    }
    this.state = parseProjectState(value)
    return this.current()
  }

  current() {
    return this.state
  }

  isReadOnly() {
    return this.readOnly
  }

  getStorageFault() {
    return this.storageFault
  }

  onCommitted(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  enqueue(operation) {
    const run = this.tail.then(() => this.#perform(operation))
    this.tail = run.then(() => {}, () => {})
    return run
  }

  async compactNow() {
    return this.enqueue(state => ({ next: compact(state, this.#nowMs()) }))
  }

  #nowMs() {
    const value = this.now()
    const parsed = typeof value === 'number' ? value : Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Date.now()
  }

  async #perform(operation) {
    if (!this.state) throw projectError('PROJECT_STATE_INVALID', { reason: 'not-loaded' })
    if (this.readOnly) throw projectError('PROJECT_READ_ONLY', { reason: 'PROJECT_STATE_FAULT' })
    if (typeof operation !== 'function') {
      throw projectError('PROJECT_STATE_INVALID', { reason: 'operation-required' })
    }

    const draft = structuredClone(this.state)
    const outcome = await operation(draft)
    if (!outcome || typeof outcome !== 'object' || !outcome.next) {
      throw projectError('PROJECT_STATE_INVALID', { reason: 'next-required' })
    }
    const control = outcome.control === true
    let next = structuredClone(outcome.next)
    if (next.projectId !== this.state.projectId) {
      throw projectError('PROJECT_STATE_INVALID', { reason: 'project-id-mismatch' })
    }
    next.revision = this.state.revision + 1
    next = parseProjectState(next)

    let size = serializedSize(next)
    if (!control && size > this.regularLimit) {
      const compacted = compact(structuredClone(next), this.#nowMs())
      compacted.revision = next.revision
      next = parseProjectState(compacted)
      size = serializedSize(next)
      if (size > this.regularLimit) {
        await this.#commitOverLimit(next)
        throw projectError('PROJECT_STATE_TOO_LARGE', {
          size, limit: this.regularLimit, revision: this.state.revision,
        })
      }
    }
    if (control && size > this.controlLimit) {
      this.#writeFaultFile()
      throw projectError('PROJECT_STATE_TOO_LARGE', {
        size, limit: this.controlLimit, revision: this.state.revision,
      })
    }

    return this.#commit(next, outcome.result)
  }

  async #commitOverLimit(next) {
    const faulted = structuredClone(next)
    if (!faulted.projectBlockedOn) {
      faulted.projectBlockedOn = {
        effectId: STATE_OVER_LIMIT_EFFECT,
        error: 'PROJECT_STATE_TOO_LARGE',
        time: this.now(),
      }
    }
    faulted.revision = next.revision
    const parsed = parseProjectState(faulted)
    if (serializedSize(parsed) > this.controlLimit) {
      this.#writeFaultFile()
      return
    }
    await this.#commit(parsed, undefined, { control: true })
  }

  #writeFaultFile() {
    this.readOnly = true
    try {
      this.writeFile(this.faultPath, `${JSON.stringify({
        time: this.now(),
        code: 'PROJECT_STATE_TOO_LARGE',
      })}\n`)
    } catch {
      // The in-memory read-only flag still prevents further writes.
    }
  }

  #notify(revision, durable) {
    for (const listener of [...this.listeners]) {
      try {
        listener({ revision, durable })
      } catch {
        // A failed listener must not undo a committed state.
      }
    }
  }

  async #commit(next, result, { control = false } = {}) {
    const contents = `${JSON.stringify(next)}\n`
    try {
      await this.writeFile(this.statePath, contents)
    } catch (error) {
      if (error?.phase !== 'after-commit') throw error
      this.state = next
      this.storageFault = {
        phase: 'after-commit',
        code: error.code || 'PROJECT_STORAGE_FAULT',
        revision: next.revision,
        control,
        time: this.now(),
        message: String(error.message || ''),
      }
      this.#notify(next.revision, false)
      try {
        await this.writeFile(this.statePath, contents)
        this.storageFault = null
        this.#notify(next.revision, true)
        return { revision: next.revision, durable: true, result }
      } catch (rewriteError) {
        this.storageFault.retryCode = rewriteError?.code || ''
        this.storageFault.retryPhase = rewriteError?.phase || ''
        return { revision: next.revision, durable: false, result }
      }
    }
    this.state = next
    this.storageFault = null
    this.#notify(next.revision, true)
    return { revision: next.revision, durable: true, result }
  }
}

module.exports = {
  CONTROL_LIMIT_BYTES,
  FAULT_FILE,
  ProjectStore,
  REGULAR_LIMIT_BYTES,
  compact,
}
