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

// Retention rules arrive with task 4.4. Until then compaction is a pure
// identity so the over-limit path can be exercised without changing state.
function compact(state) {
  return state
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
      const compacted = compact(structuredClone(next))
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
