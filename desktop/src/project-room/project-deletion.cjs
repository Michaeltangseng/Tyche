const fs = require('node:fs')
const path = require('node:path')
const { makeClaim, claimsOverlap } = require('../runs/path-claims.cjs')

const ALLOWED_DURING_DELETION = new Set([
  'snapshot',
  'diagnostics',
  'residual',
  'retryDeletion',
])
const DEFAULT_DRAIN_FALLBACK_MS = 30000

function deletionError(code, details = {}) {
  return Object.assign(new Error(code), { code, details })
}

function nowIso(now) {
  const value = now()
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString()
}

function allowedDuringDeletion(method) {
  return ALLOWED_DURING_DELETION.has(method)
}

class ProjectDeletion {
  constructor({
    workspace,
    privateRoot,
    scheduler,
    getContext,
    engine,
    effects,
    invocations,
    now = () => new Date().toISOString(),
    removeProjectDir,
    projectClaim = ({ project }) => makeClaim({
      root: project.workdir,
      path: '',
      mode: 'exclusive',
    }),
    hasResidual,
    onDeleted = () => {},
    onDrainCheck = () => {},
    onError = () => {},
    drainFallbackMs = DEFAULT_DRAIN_FALLBACK_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = {}) {
    this.workspace = workspace
    this.privateRoot = privateRoot
    this.scheduler = scheduler
    this.getContext = getContext
    this.engine = engine
    this.effects = effects
    this.invocations = invocations
    this.now = now
    this.removeProjectDir = removeProjectDir || ((projectId) => {
      fs.rmSync(path.join(this.privateRoot, 'projects', projectId), {
        recursive: true,
        force: true,
      })
    })
    this.projectClaim = projectClaim
    this.hasResidual = hasResidual
    this.onDeleted = onDeleted
    this.onDrainCheck = onDrainCheck
    this.onError = onError
    this.drainFallbackMs = drainFallbackMs
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this.deletions = new Map()
  }

  isDeleting(projectId) {
    return this.deletions.has(projectId)
  }

  progress(projectId) {
    const record = this.deletions.get(projectId)
    if (!record) return null
    return {
      projectId,
      phase: record.phase,
      keepChats: record.keepChats,
      requestedAt: record.requestedAt,
      waitingOn: {
        effects: !this.#effectsIdle(projectId),
        invocations: this.#activeInvocations(projectId) > 0,
        scheduler: !this.#schedulerIdleSync(projectId),
      },
    }
  }

  async start() {
    const state = this.workspace.state
    for (const project of state.projects || []) {
      if (!project.deleting) continue
      await this.#resume(project)
    }
    return [...this.deletions.keys()]
  }

  async delete({ projectId, keepChats = false }) {
    if (this.deletions.has(projectId)) throw deletionError('PROJECT_DELETING')
    const context = this.#context(projectId)
    if (await this.#hasUnresolvedResidual(context.project)) {
      throw deletionError('PROJECT_RESIDUAL_UNRESOLVED')
    }
    const requestedAt = nowIso(this.now)
    context.project.deleting = { requestedAt, keepChats: keepChats === true }
    await this.#saveWorkspace()
    return this.#beginDraining(context.project, {
      keepChats: keepChats === true,
      requestedAt,
    })
  }

  async retryDeletion(projectId) {
    const record = this.deletions.get(projectId)
    if (!record) {
      const project = (this.workspace.state.projects || [])
        .find(item => item.id === projectId)
      if (!project?.deleting) throw deletionError('PROJECT_NOT_FOUND')
      return this.#resume(project)
    }
    if (record.phase === 'drained' || record.phase === 'deleting-data') {
      await this.#finish(projectId)
      return { projectId, deleted: !this.deletions.has(projectId) }
    }
    await this.#checkDrain(projectId, 'retry')
    return {
      projectId,
      deleted: !this.deletions.has(projectId),
      phase: this.deletions.get(projectId)?.phase || null,
    }
  }

  async #resume(project) {
    if (this.deletions.has(project.id)) return { projectId: project.id }
    const record = {
      projectId: project.id,
      keepChats: project.deleting.keepChats === true,
      requestedAt: project.deleting.requestedAt || '',
      phase: 'draining',
      checking: false,
      finishing: false,
      finished: false,
      interval: null,
      listeners: [],
      error: null,
    }
    this.deletions.set(project.id, record)
    const context = this.getContext?.(project.id)
    if (!context?.store || context.store.isReadOnly() || !context.store.current()) {
      record.phase = 'drained'
      try {
        await this.#finish(project.id)
      } catch (error) {
        record.error = error
        this.onError(project.id, error)
        throw error
      }
      return { projectId: project.id }
    }
    const deletion = context.store.current().deletion
    if (deletion?.phase === 'drained') {
      record.phase = 'drained'
      await this.#finish(project.id)
      return { projectId: project.id }
    }
    return this.#beginDraining(project, {
      keepChats: record.keepChats,
      requestedAt: record.requestedAt,
      resumed: true,
    })
  }

  async #beginDraining(project, { keepChats, requestedAt, resumed = false }) {
    let record = this.deletions.get(project.id)
    if (!record) {
      record = {
        projectId: project.id,
        keepChats,
        requestedAt,
        phase: 'draining',
        checking: false,
        finishing: false,
        finished: false,
        interval: null,
        listeners: [],
        error: null,
      }
      this.deletions.set(project.id, record)
    }
    const context = this.getContext?.(project.id)
    if (!context?.store || context.store.isReadOnly() || !context.store.current()) {
      record.phase = 'drained'
      await this.#finish(project.id)
      return { projectId: project.id, deleted: true }
    }
    try {
      await context.store.enqueue((state) => {
        const next = this.engine.beginDraining(structuredClone(state)) || state
        next.deletion = {
          phase: 'draining',
          startedAt: nowIso(this.now),
        }
        return { next, control: true }
      })
    } catch (error) {
      if (error?.code !== 'PROJECT_READ_ONLY') throw error
      record.phase = 'drained'
      await this.#finish(project.id)
      return { projectId: project.id, deleted: true }
    }
    this.invocations.cancelAll(project.id)
    this.#installListeners(project.id, record)
    await this.#checkDrain(project.id, 'begin')
    if (!this.deletions.has(project.id)) return { projectId: project.id, deleted: true }
    return {
      projectId: project.id,
      deleted: false,
      phase: this.deletions.get(project.id)?.phase || null,
    }
  }

  #installListeners(projectId, record) {
    if (record.listeners.length) return
    const onIdle = () => this.#deliverDrainCheck(projectId, 'effects-idle')
    const onEnded = () => this.#deliverDrainCheck(projectId, 'invocation-ended')
    record.listeners.push({ type: 'effects', callback: onIdle })
    record.listeners.push({ type: 'invocations', callback: onEnded })
    this.effects.onIdle(projectId, onIdle)
    this.invocations.onInvocationEnded(projectId, onEnded)
    record.interval = this.setIntervalFn(() => {
      this.#deliverDrainCheck(projectId, 'fallback')
    }, this.drainFallbackMs)
    if (record.interval?.unref) record.interval.unref()
  }

  #deliverDrainCheck(projectId, cause) {
    this.onDrainCheck(projectId, cause)
    this.#checkDrain(projectId, cause).catch((error) => {
      const record = this.deletions.get(projectId)
      if (record) record.error = error
      this.onError(projectId, error)
    })
  }

  async #checkDrain(projectId, cause) {
    const record = this.deletions.get(projectId)
    if (!record || record.finished || record.checking || record.finishing) return
    record.checking = true
    try {
      if (!this.#localDrained(projectId)) return
      if (typeof this.engine.reconcileScheduler === 'function') {
        await this.engine.reconcileScheduler(projectId)
      }
      if (!this.#schedulerIdleSync(projectId)) return
      if (record.finished || record.finishing) return
      record.finishing = true
      await this.#writeDrained(projectId)
      await this.#finish(projectId)
    } finally {
      record.checking = false
    }
  }

  #localDrained(projectId) {
    const context = this.getContext?.(projectId)
    const state = context?.store?.current()
    if (state && !this.engine.isDrained(state)) return false
    if (!this.#effectsIdle(projectId)) return false
    if (this.#activeInvocations(projectId) > 0) return false
    return true
  }

  #effectsIdle(projectId) {
    return this.effects.isIdle(projectId) === true
  }

  #activeInvocations(projectId) {
    return Number(this.invocations.activeInvocations(projectId)) || 0
  }

  async #hasUnresolvedResidual(project) {
    if (typeof this.hasResidual === 'function') return this.hasResidual(project) === true
    const snapshot = this.scheduler.snapshot()
    if (!snapshot.residuals?.length) return false
    const rootClaim = await this.projectClaim({ project })
    return snapshot.residuals.some(residual => (
      (residual.claims || []).some(claim => claimsOverlap(claim, rootClaim))
    ))
  }

  #schedulerIdleSync(projectId) {
    const snapshot = this.scheduler.snapshot()
    const held = [...(snapshot.claimGrants || []), ...(snapshot.claimQueue || [])]
      .some(entry => entry.holder?.projectId === projectId)
    if (held) return false
    return true
  }

  async #writeDrained(projectId) {
    const context = this.getContext?.(projectId)
    if (!context?.store || context.store.isReadOnly() || !context.store.current()) return
    await context.store.enqueue((state) => {
      state.deletion = {
        phase: 'drained',
        startedAt: state.deletion?.startedAt || nowIso(this.now),
      }
      return { next: state, control: true }
    })
    const record = this.deletions.get(projectId)
    if (record) record.phase = 'drained'
  }

  async #finish(projectId) {
    const record = this.deletions.get(projectId)
    if (!record || record.finished) return
    record.phase = record.phase === 'draining' ? 'deleting-data' : record.phase
    await this.#deleteData(projectId, record.keepChats)
    await this.#removeProjectDirectory(projectId)
    await this.#removeWorkspaceRecord(projectId)
    record.finished = true
    this.#cleanup(projectId)
    this.onDeleted(projectId)
  }

  async #deleteData(projectId, keepChats) {
    const state = this.workspace.state
    let changed = false
    const sessions = state.sessions || {}
    for (const key of Object.keys(sessions)) {
      if (key.startsWith(`project:${projectId}:`)) {
        delete sessions[key]
        changed = true
      }
    }
    const sessionMeta = state.sessionMeta || {}
    for (const key of Object.keys(sessionMeta)) {
      if (key.startsWith(`project:${projectId}:`)) {
        delete sessionMeta[key]
        changed = true
      }
    }
    const groups = state.groups || []
    const mainGroupIds = new Set(groups
      .filter(group => group.projectId === projectId && group.projectRole === 'main')
      .map(group => group.id))
    if (mainGroupIds.size) changed = true
    const keptChatIds = new Set()
    const nextGroups = []
    for (const group of groups) {
      if (group.projectId !== projectId) {
        nextGroups.push(group)
        continue
      }
      if (keepChats && !mainGroupIds.has(group.id)) {
        const { projectId: _projectId, projectRole: _projectRole, ...rest } = group
        nextGroups.push(rest)
        keptChatIds.add(group.id)
      }
      changed = true
    }
    state.groups = nextGroups
    if (changed) {
      const removedGroupIds = new Set(groups
        .filter(group => group.projectId === projectId && !keptChatIds.has(group.id))
        .map(group => group.id))
      state.messages = (state.messages || []).filter(message => (
        !removedGroupIds.has(message.groupId)
      ))
      if (state.deliveryTasks) {
        state.deliveryTasks = state.deliveryTasks.filter(task => (
          !removedGroupIds.has(task.groupId)
        ))
      }
    }
    if (changed) await this.#saveWorkspace()
  }

  async #removeProjectDirectory(projectId) {
    try {
      await this.removeProjectDir(projectId)
    } catch (cause) {
      throw deletionError('PROJECT_STORAGE_FAULT', {
        reason: 'directory-removal-failed',
        projectId,
        cause: String(cause?.message || ''),
      })
    }
    if (fs.existsSync(path.join(this.privateRoot, 'projects', projectId))) {
      throw deletionError('PROJECT_STORAGE_FAULT', {
        reason: 'directory-removal-failed',
        projectId,
      })
    }
  }

  async #removeWorkspaceRecord(projectId) {
    const state = this.workspace.state
    const next = (state.projects || []).filter(project => project.id !== projectId)
    if (next.length === (state.projects || []).length) return
    state.projects = next
    await this.#saveWorkspace()
  }

  async #saveWorkspace() {
    try {
      await this.workspace.save()
      this.workspace.emitChanged?.()
    } catch (error) {
      if (error?.phase !== 'after-commit') throw error
    }
  }

  #cleanup(projectId) {
    const record = this.deletions.get(projectId)
    if (!record) return
    if (record.interval !== null) this.clearIntervalFn(record.interval)
    for (const listener of record.listeners) {
      if (listener.type === 'effects') {
        this.effects.removeIdleListener?.(projectId, listener.callback)
      } else {
        this.invocations.removeInvocationEndedListener?.(projectId, listener.callback)
      }
    }
    record.listeners = []
    record.interval = null
    this.deletions.delete(projectId)
  }

  #context(projectId) {
    const project = (this.workspace.state.projects || [])
      .find(item => item.id === projectId)
    if (!project) throw deletionError('PROJECT_NOT_FOUND')
    const context = this.getContext?.(projectId)
    return { project, store: context?.store || null }
  }
}

module.exports = {
  DEFAULT_DRAIN_FALLBACK_MS,
  ProjectDeletion,
  allowedDuringDeletion,
}
