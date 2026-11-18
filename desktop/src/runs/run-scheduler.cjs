const {
  claimsConflict,
  claimsOverlap,
  makeClaim,
  resolveRoot,
} = require('./path-claims.cjs')

const DEFAULT_TASK_CONCURRENCY = null
const DEFAULT_WORKSPACE_CONCURRENCY = null
const DEFAULT_GLOBAL_CONCURRENCY = null
const schedulerPauseTokens = new WeakMap()
const schedulerLeaseBindings = new WeakMap()

function positiveLimit(value, fallback) {
  if (value == null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(1024, Math.floor(number))
}

function belowLimit(active, limit) {
  return limit === null || active < limit
}

function schedulerError(code) {
  return Object.assign(new Error(code), { code })
}

function resourceKey(value, code) {
  const key = String(value || '')
  if (!key || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) throw schedulerError(code)
  return key
}

function installTaskPause(scheduler, taskId) {
  const token = Object.freeze({})
  const pauses = schedulerPauseTokens.get(scheduler)
  const tokens = pauses.get(taskId) || new Set()
  tokens.add(token)
  pauses.set(taskId, tokens)
  return token
}

function removeTaskPause(scheduler, taskId, token) {
  const pauses = schedulerPauseTokens.get(scheduler)
  const tokens = pauses.get(taskId)
  if (!tokens) return
  tokens.delete(token)
  if (!tokens.size) pauses.delete(taskId)
}

function taskPauseAllows(scheduler, entry) {
  const tokens = schedulerPauseTokens.get(scheduler).get(entry.taskId)
  return !tokens?.size || (entry.pauseToken && tokens.has(entry.pauseToken))
}

function validHolder(holder) {
  return holder
    && typeof holder === 'object'
    && ['checkpoint-scope', 'project-maintenance', 'invocation'].includes(holder.kind)
}

class RunScheduler {
  constructor(options = {}) {
    this.limits = Object.freeze({
      task: positiveLimit(options.taskLimit, DEFAULT_TASK_CONCURRENCY),
      workspace: positiveLimit(options.workspaceLimit, DEFAULT_WORKSPACE_CONCURRENCY),
      global: positiveLimit(options.globalLimit, DEFAULT_GLOBAL_CONCURRENCY),
    })
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.projectRootsProvider = typeof options.projectRootsProvider === 'function'
      ? options.projectRootsProvider
      : () => []
    this.activeGlobal = 0
    this.activeTasks = new Map()
    this.activeWorkspaces = new Map()
    this.activeWorkspaceWriters = new Set()
    this.queue = []
    this.sequence = 0
    this.claimGrants = []
    this.residuals = new Map()
    this.heldRoots = new Map()
    this.recoveryMode = false
    schedulerPauseTokens.set(this, new Map())
  }

  resourceCount(collection, key) {
    return collection.get(key) || 0
  }

  canGrant(entry) {
    if (this.recoveryMode
        && (entry.permissionMode === 'workspace-write'
          || (entry.claims && entry.claims.length))) return false
    if (!taskPauseAllows(this, entry)) return false
    if (entry.permissionMode === 'workspace-write'
        && this.activeWorkspaceWriters.has(entry.workspaceKey)) return false
    if (!belowLimit(this.activeGlobal, this.limits.global)) return false
    if (!belowLimit(this.resourceCount(this.activeTasks, entry.taskId), this.limits.task)) return false
    if (!belowLimit(this.resourceCount(this.activeWorkspaces, entry.workspaceKey), this.limits.workspace)) {
      return false
    }
    if (entry.claims && entry.claims.length) {
      if (!this.claimsAvailable(entry.claims)) return false
      if (this.hasEarlierConflict(entry)) return false
    }
    return true
  }

  canGrantRequest(entry) {
    if (!entry.claims || !entry.claims.length) return true
    if (this.recoveryMode) return false
    return this.claimsAvailable(entry.claims) && !this.hasEarlierConflict(entry)
  }

  claimsAvailable(claims) {
    for (const claim of claims) {
      for (const record of this.claimGrants) {
        if (record.claims.some(other => claimsConflict(claim, other))) return false
      }
      for (const residual of this.residuals.values()) {
        if (residual.claims.some(other => claimsOverlap(claim, other))) return false
      }
      for (const held of this.heldRoots.values()) {
        if (claimsOverlap(claim, held.claim)) return false
      }
    }
    return true
  }

  hasEarlierConflict(entry) {
    if (!entry.claims || !entry.claims.length) return false
    const index = this.queue.indexOf(entry)
    if (index <= 0) return false
    for (let position = 0; position < index; position += 1) {
      const earlier = this.queue[position]
      if (!earlier || earlier.cancelled || !earlier.claims || !earlier.claims.length) continue
      if (earlier.claims.some(first => entry.claims.some(second => claimsConflict(first, second)))) {
        return true
      }
    }
    return false
  }

  blockersFor(entry) {
    const blockers = []
    if (!entry.claims || !entry.claims.length) return blockers
    for (const record of this.claimGrants) {
      if (record.claims.some(other => entry.claims.some(claim => claimsConflict(claim, other)))) {
        blockers.push({ type: 'grant', requestId: record.requestId, holderKind: record.holder?.kind || '' })
      }
    }
    for (const residual of this.residuals.values()) {
      if (residual.claims.some(other => entry.claims.some(claim => claimsOverlap(claim, other)))) {
        blockers.push({ type: 'residual', residualId: residual.residualId })
      }
    }
    for (const held of this.heldRoots.values()) {
      if (entry.claims.some(claim => claimsOverlap(claim, held.claim))) {
        blockers.push({ type: 'held-root', key: held.key })
      }
    }
    const index = this.queue.indexOf(entry)
    for (let position = 0; position < index; position += 1) {
      const earlier = this.queue[position]
      if (!earlier || earlier.cancelled || !earlier.claims || !earlier.claims.length) continue
      if (earlier.claims.some(other => entry.claims.some(claim => claimsConflict(claim, other)))) {
        blockers.push({ type: 'waiting', requestId: earlier.requestId })
      }
    }
    return blockers
  }

  changeCount(collection, key, change) {
    const next = this.resourceCount(collection, key) + change
    if (next > 0) collection.set(key, next)
    else collection.delete(key)
  }

  grant(entry) {
    let claimRecord = null
    if (entry.claims && entry.claims.length) {
      claimRecord = {
        requestId: entry.requestId,
        holder: entry.holder || { kind: 'invocation' },
        claims: entry.claims,
        source: 'invocation',
        restored: false,
      }
      this.claimGrants.push(claimRecord)
    }
    this.activeGlobal += 1
    this.changeCount(this.activeTasks, entry.taskId, 1)
    this.changeCount(this.activeWorkspaces, entry.workspaceKey, 1)
    if (entry.permissionMode === 'workspace-write') this.activeWorkspaceWriters.add(entry.workspaceKey)
    entry.signal?.removeEventListener('abort', entry.abortHandler)
    let released = false
    const lease = Object.freeze({
      leaseId: entry.requestId,
      taskId: entry.taskId,
      workspaceKey: entry.workspaceKey,
      permissionMode: entry.permissionMode,
      claims: Object.freeze((entry.claims || []).map(claim => Object.freeze({ ...claim }))),
      queuedAt: entry.queuedAt,
      acquiredAt: this.now(),
      release: () => {
        if (released) return false
        released = true
        this.activeGlobal -= 1
        this.changeCount(this.activeTasks, entry.taskId, -1)
        this.changeCount(this.activeWorkspaces, entry.workspaceKey, -1)
        if (entry.permissionMode === 'workspace-write') this.activeWorkspaceWriters.delete(entry.workspaceKey)
        if (claimRecord) {
          this.claimGrants = this.claimGrants.filter(record => record !== claimRecord)
        }
        this.drain()
        return true
      },
    })
    schedulerLeaseBindings.set(lease, Object.freeze({
      taskId: entry.taskId,
      workspaceKey: entry.workspaceKey,
      permissionMode: entry.permissionMode,
      signal: entry.signal,
      workdirRoot: entry.workdirRoot || '',
      exclusiveRoot: entry.exclusiveRoot,
      ownerId: entry.holder?.ownerId || '',
    }))
    entry.resolve(lease)
  }

  grantRequest(entry) {
    this.claimGrants.push({
      requestId: entry.requestId,
      holder: entry.holder,
      claims: entry.claims,
      source: 'request',
      restored: false,
    })
    if (typeof entry.onGranted === 'function') entry.onGranted(entry.requestId)
  }

  drain() {
    for (let index = 0; index < this.queue.length;) {
      const entry = this.queue[index]
      if (entry.cancelled) {
        this.queue.splice(index, 1)
        continue
      }
      const grantable = entry.type === 'request' ? this.canGrantRequest(entry) : this.canGrant(entry)
      if (!grantable) {
        index += 1
        continue
      }
      this.queue.splice(index, 1)
      if (entry.type === 'request') this.grantRequest(entry)
      else this.grant(entry)
    }
  }

  async #enqueueAcquire(input = {}, pauseToken = null) {
    let taskId
    let workspaceKey
    const permissionMode = input.permissionMode == null ? 'read-only' : input.permissionMode
    try {
      taskId = resourceKey(input.taskId, 'RUN_SCHEDULER_TASK_REQUIRED')
      workspaceKey = resourceKey(input.workspaceKey, 'RUN_SCHEDULER_WORKSPACE_REQUIRED')
      if (!['read-only', 'workspace-write'].includes(permissionMode)) {
        throw schedulerError('RUN_SCHEDULER_PERMISSION_INVALID')
      }
    } catch (error) {
      throw error
    }
    const signal = input.signal
    if (signal?.aborted) throw schedulerError('RUN_SCHEDULER_ABORTED')
    const workdirRoot = typeof input.workdirRoot === 'string' ? input.workdirRoot : ''
    let claims = []
    if (permissionMode === 'workspace-write' && workdirRoot) {
      const projectRoots = await Promise.resolve(this.projectRootsProvider())
      let mode = input.exclusiveRoot === true ? 'exclusive' : 'shared-legacy'
      if (Array.isArray(projectRoots) && projectRoots.length) {
        const workdirProbe = await makeClaim({ root: workdirRoot, path: '', mode: 'exclusive' })
        for (const projectRoot of projectRoots) {
          if (typeof projectRoot !== 'string' || !projectRoot) continue
          const projectClaim = await makeClaim({ root: projectRoot, path: '', mode: 'exclusive' })
          if (claimsOverlap(workdirProbe, projectClaim)) {
            mode = 'exclusive'
            break
          }
        }
      }
      claims = [await makeClaim({ root: workdirRoot, path: '', mode })]
    }
    if (signal?.aborted) throw schedulerError('RUN_SCHEDULER_ABORTED')
    return new Promise((resolve, reject) => {
      const entry = {
        requestId: `lease-${++this.sequence}`,
        taskId,
        workspaceKey,
        permissionMode,
        queuedAt: this.now(),
        signal,
        resolve,
        reject,
        cancelled: false,
        abortHandler: null,
        pauseToken,
        type: 'legacy',
        holder: { kind: 'invocation', ownerId: input.ownerId || '' },
        claims,
        workdirRoot,
        exclusiveRoot: input.exclusiveRoot === true,
      }
      entry.abortHandler = () => {
        if (entry.cancelled) return
        entry.cancelled = true
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        reject(schedulerError('RUN_SCHEDULER_ABORTED'))
        this.drain()
      }
      signal?.addEventListener('abort', entry.abortHandler, { once: true })
      this.queue.push(entry)
      this.drain()
    })
  }

  acquire(input = {}) {
    return this.#enqueueAcquire(input)
  }

  request({ requestId, holder, claims, onGranted } = {}) {
    if (typeof requestId !== 'string' || !requestId) {
      throw schedulerError('RUN_SCHEDULER_REQUEST_INVALID')
    }
    if (!validHolder(holder)) throw schedulerError('RUN_SCHEDULER_HOLDER_INVALID')
    if (!Array.isArray(claims)) throw schedulerError('RUN_SCHEDULER_CLAIMS_INVALID')
    if (this.queue.some(entry => entry.requestId === requestId)
        || this.claimGrants.some(record => record.requestId === requestId)) return
    this.queue.push({
      type: 'request',
      requestId,
      holder,
      claims,
      onGranted: typeof onGranted === 'function' ? onGranted : null,
      queuedAt: this.now(),
      cancelled: false,
    })
    this.drain()
  }

  release(requestId) {
    const index = this.claimGrants.findIndex(record => (
      record.requestId === requestId && record.source === 'request'
    ))
    if (index < 0) return false
    this.claimGrants.splice(index, 1)
    this.drain()
    return true
  }

  withdraw(requestId) {
    const index = this.queue.findIndex(entry => entry.requestId === requestId)
    if (index >= 0) {
      this.queue.splice(index, 1)
      this.drain()
      return true
    }
    return this.release(requestId)
  }

  restoreGranted(requests) {
    if (!Array.isArray(requests)) throw schedulerError('RUN_SCHEDULER_RESTORE_INVALID')
    const conflicts = []
    const requestIds = new Set()
    const proposed = []
    for (const request of requests) {
      if (!request || typeof request.requestId !== 'string' || !request.requestId
          || !validHolder(request.holder) || !Array.isArray(request.claims)) {
        conflicts.push({ requestId: request?.requestId || '', reason: 'invalid' })
        continue
      }
      if (requestIds.has(request.requestId)
          || this.claimGrants.some(record => record.requestId === request.requestId)) {
        conflicts.push({ requestId: request.requestId, reason: 'duplicate' })
        continue
      }
      requestIds.add(request.requestId)
      proposed.push(request)
    }
    for (let first = 0; first < proposed.length; first += 1) {
      for (let second = first + 1; second < proposed.length; second += 1) {
        if (proposed[first].claims.some(left => proposed[second].claims.some(right => (
          claimsOverlap(left, right)
        )))) {
          conflicts.push({
            requestId: proposed[first].requestId,
            reason: 'overlap',
            otherRequestId: proposed[second].requestId,
          })
        }
      }
      for (const record of this.claimGrants) {
        if (proposed[first].claims.some(left => record.claims.some(right => claimsOverlap(left, right)))) {
          conflicts.push({
            requestId: proposed[first].requestId,
            reason: 'existing-grant',
            otherRequestId: record.requestId,
          })
        }
      }
      for (const residual of this.residuals.values()) {
        if (proposed[first].claims.some(left => residual.claims.some(right => claimsOverlap(left, right)))) {
          conflicts.push({
            requestId: proposed[first].requestId,
            reason: 'residual',
            otherRequestId: residual.residualId,
          })
        }
      }
    }
    if (conflicts.length) return { restored: false, conflicts }
    for (const request of proposed) {
      this.claimGrants.push({
        requestId: request.requestId,
        holder: request.holder,
        claims: request.claims,
        source: 'request',
        restored: true,
      })
    }
    this.drain()
    return { restored: true, conflicts: [] }
  }

  registerResidual({ residualId, claims } = {}) {
    if (typeof residualId !== 'string' || !residualId) {
      throw schedulerError('RUN_SCHEDULER_RESIDUAL_INVALID')
    }
    if (!Array.isArray(claims)) throw schedulerError('RUN_SCHEDULER_RESIDUAL_INVALID')
    this.residuals.set(residualId, { residualId, claims })
    this.drain()
    return true
  }

  clearResidual(residualId) {
    const removed = this.residuals.delete(residualId)
    if (removed) this.drain()
    return removed
  }

  async holdRoot(root) {
    const rootInfo = await resolveRoot(root)
    const key = rootInfo.caseInsensitive
      ? rootInfo.realRoot.normalize('NFC').toLowerCase()
      : rootInfo.realRoot.normalize('NFC')
    const id = `${rootInfo.volumeId}:${key}`
    const held = this.heldRoots.get(id)
    if (held) {
      held.count += 1
    } else {
      this.heldRoots.set(id, {
        key,
        volumeId: rootInfo.volumeId,
        count: 1,
        claim: { volumeId: rootInfo.volumeId, key, mode: 'exclusive' },
      })
    }
    return id
  }

  async openRoot(root) {
    const rootInfo = await resolveRoot(root)
    const key = rootInfo.caseInsensitive
      ? rootInfo.realRoot.normalize('NFC').toLowerCase()
      : rootInfo.realRoot.normalize('NFC')
    const id = `${rootInfo.volumeId}:${key}`
    const held = this.heldRoots.get(id)
    if (!held) return false
    held.count -= 1
    if (held.count <= 0) this.heldRoots.delete(id)
    this.drain()
    return true
  }

  enterRecoveryMode() {
    this.recoveryMode = true
  }

  exitRecoveryMode() {
    this.recoveryMode = false
    this.drain()
  }

  async withLease(input, operation) {
    if (typeof operation !== 'function') throw schedulerError('RUN_SCHEDULER_OPERATION_REQUIRED')
    let activeLease = await this.acquire(input)
    let closed = false
    const lease = Object.freeze({
      get leaseId() { return activeLease?.leaseId || '' },
      get taskId() { return activeLease?.taskId || '' },
      get workspaceKey() { return activeLease?.workspaceKey || '' },
      get permissionMode() { return activeLease?.permissionMode || '' },
      get claims() { return activeLease?.claims || [] },
      get queuedAt() { return activeLease?.queuedAt || 0 },
      get acquiredAt() { return activeLease?.acquiredAt || 0 },
      release: () => {
        if (closed) return false
        closed = true
        const current = activeLease
        activeLease = null
        return current?.release() || false
      },
      suspend: async (waitingOperation, options = {}) => {
        if (typeof waitingOperation !== 'function') {
          throw schedulerError('RUN_SCHEDULER_OPERATION_REQUIRED')
        }
        if (closed || !activeLease) throw schedulerError('RUN_SCHEDULER_LEASE_INACTIVE')
        const binding = schedulerLeaseBindings.get(activeLease)
        const taskId = binding.taskId
        const pauseToken = options?.pauseTask === true
          ? installTaskPause(this, taskId)
          : null
        try {
          activeLease.release()
          activeLease = null
          let result
          let failure
          try {
            result = await waitingOperation()
          } catch (error) {
            failure = error
          }
          if (!closed && !binding.signal?.aborted) {
            activeLease = await this.#enqueueAcquire(binding, pauseToken)
          }
          if (failure) throw failure
          return result
        } finally {
          if (pauseToken) {
            removeTaskPause(this, taskId, pauseToken)
            this.drain()
          }
        }
      },
    })
    let releaseDeferred = false
    try {
      return await operation(lease)
    } catch (error) {
      const pendingExit = error?.[Symbol.for('tyche.pending-process-exit')]
      if (error?.code === 'LOCAL_AGENT_TERMINATION_FAILED' && pendingExit instanceof Promise) {
        releaseDeferred = true
        pendingExit.then(() => lease.release(), () => {})
      }
      throw error
    } finally {
      if (!releaseDeferred) lease.release()
    }
  }

  snapshot() {
    return {
      limits: { ...this.limits },
      active: {
        global: this.activeGlobal,
        tasks: [...this.activeTasks.entries()].map(([taskId, count]) => ({ taskId, count })),
        workspaces: [...this.activeWorkspaces.entries()]
          .map(([workspaceKey, count]) => ({ workspaceKey, count })),
      },
      queued: this.queue.filter(entry => !entry.cancelled).map(entry => ({
        requestId: entry.requestId,
        taskId: entry.taskId,
        workspaceKey: entry.workspaceKey,
        queuedAt: entry.queuedAt,
      })),
      recoveryMode: this.recoveryMode,
      claimGrants: this.claimGrants.map(record => ({
        requestId: record.requestId,
        holder: record.holder,
        claims: record.claims,
        source: record.source,
        restored: record.restored,
      })),
      claimQueue: this.queue
        .filter(entry => entry.type === 'request' || (entry.claims && entry.claims.length))
        .map(entry => ({
          requestId: entry.requestId,
          holder: entry.holder || { kind: 'invocation' },
          claims: entry.claims || [],
          queuedAt: entry.queuedAt,
          blockers: this.blockersFor(entry),
        })),
      residuals: [...this.residuals.values()].map(residual => ({
        residualId: residual.residualId,
        claims: residual.claims,
      })),
      heldRoots: [...this.heldRoots.values()].map(held => ({
        key: held.key,
        volumeId: held.volumeId,
        count: held.count,
      })),
    }
  }
}

const processRunScheduler = new RunScheduler()

module.exports = {
  DEFAULT_GLOBAL_CONCURRENCY,
  DEFAULT_TASK_CONCURRENCY,
  DEFAULT_WORKSPACE_CONCURRENCY,
  RunScheduler,
  processRunScheduler,
}
