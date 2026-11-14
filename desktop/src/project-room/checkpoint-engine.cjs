const { transition } = require('./checkpoint-transitions.cjs')
const { EffectRunner, NEVER_EXPIRE } = require('./effect-runner.cjs')
const { startableInstances } = require('./project-progress.cjs')

const IGNORED_CODES = new Set([
  'EVENT_IGNORED', 'GATE_STALE', 'GATE_OUTCOME_UNAVAILABLE',
])
const TERMINAL_EFFECT_STATUSES = new Set(['consumed', 'voided', 'failed'])
const ENDED_LEASE_STATUSES = new Set(['withdrawn', 'released'])

function engineError(code, details = {}) {
  return Object.assign(new Error(code), { code, details })
}

function recoveryGate(instance, eventAt) {
  return {
    id: `gate-${instance.id}-recovery-${instance.seq}`,
    revision: 1,
    reason: 'recovery',
    candidateCommit: instance.candidate,
    createdAt: eventAt,
    firstScreen: {
      round: instance.round,
      elapsedMs: 0,
      signals: [],
      reviewSummaries: [],
      changedFiles: [],
      softGateSummary: [],
      driftItemIds: [],
      outOfScopeItemIds: [],
      blockerCheckpointIds: [],
      changesHeaderMissing: false,
      detectionSkipped: false,
      candidateDiverged: false,
    },
  }
}

class CheckpointEngine {
  constructor({
    projectId,
    store,
    scheduler,
    handlers = {},
    invoke,
    cancelInvocation,
    workdir = '',
    readExecSeatIds = [],
    softBlockers = () => ({}),
    getManifest = () => null,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!projectId) throw engineError('PROJECT_INPUT_INVALID', { reason: 'project-id-required' })
    if (!store) throw engineError('PROJECT_INPUT_INVALID', { reason: 'store-required' })
    this.projectId = projectId
    this.store = store
    this.scheduler = scheduler
    this.workdir = workdir
    this.readExecSeatIds = readExecSeatIds
    this.softBlockersProvider = softBlockers
    this.now = now
    this.runner = new EffectRunner({
      scheduler,
      handlers,
      invoke,
      cancelInvocation,
      markStarted: effect => this.markStarted(effect.id),
      isStorageDurable: () => !this.store.getStorageFault?.(),
      now: () => Date.parse(this.now()) || Date.now(),
    })
    this.drainPromise = null
    this.dispatching = false
    this.drainQueued = false
    this.waitingAcquisitions = new Set()
    this.snapshotCommits = new Map()
    this.getManifest = getManifest
  }

  #instance(checkpointId) {
    return this.store.current()?.instances.find(item => item.id === checkpointId) || null
  }

  #config(instance) {
    const state = this.store.current()
    const def = state?.config.playbook.checkpointDefs
      .find(item => item.key === instance.checkpointKey) || null
    return {
      projectId: this.projectId,
      checkpoint: def,
      seats: state?.config.seats || [],
      readExecSeatIds: this.readExecSeatIds,
      softBlockers: this.softBlockersProvider(state) || {},
      workdir: this.workdir,
    }
  }

  #prepareEffect(instance, effect) {
    const state = this.store.current()
    const def = state?.config.playbook.checkpointDefs
      .find(item => item.key === instance.checkpointKey) || null
    const params = { ...(effect.params || {}) }
    const placeholders = state?.placeholders || []
    const limits = state?.config.settings.snapshotLimits || {}
    if (effect.type === 'snapshot') {
      params.targets = def?.targetFiles || params.targets || []
      params.placeholderList = placeholders
      params.limits = limits
      params.isOptional = params.isOptional === true
    } else if (effect.type === 'drift-check') {
      const acceptedByPath = {}
      const upstreamIds = new Set(Object.keys(instance.readVersions || {}))
      for (const key of def?.dependsOn || []) {
        const upstream = state.instances.find(item => (
          item.checkpointKey === key && item.state === 'accepted'
        ))
        if (upstream) upstreamIds.add(upstream.id)
      }
      for (const upstreamId of upstreamIds) {
        const upstream = state.instances.find(item => item.id === upstreamId)
        const version = upstream?.artifactVersions?.at(-1)
        const upstreamDef = state.config.playbook.checkpointDefs
          .find(item => item.key === upstream?.checkpointKey)
        if (!version || !upstreamDef) continue
        for (const path of upstreamDef.targetFiles || []) {
          acceptedByPath[path] = version.commit
        }
      }
      params.acceptedByPath = acceptedByPath
      params.placeholderList = placeholders
      params.limits = limits
    } else if (effect.type === 'evaluate-submission') {
      params.targetFiles = def?.targetFiles || []
      params.previousCandidate = instance.rounds.at(-1)?.candidate || ''
      params.candidate = this.snapshotCommits.get(instance.id) || instance.candidate || ''
      params.responseFile = `meldwork/reviews/${instance.checkpointKey}/r${instance.round + 1}-response.md`
      params.manifest = this.getManifest(instance)
    } else if (effect.type === 'verify-candidate') {
      params.candidate = instance.candidate
      params.paths = def?.targetFiles || []
      params.placeholderList = placeholders
      params.limits = limits
    } else if (effect.type === 'accept-commit') {
      const currentRound = instance.rounds.at(-1)
      params.candidate = instance.candidate
      params.recordPaths = [
        ...(currentRound?.reviews || []).map(review => review.reviewFile).filter(Boolean),
        'meldwork/decisions.md',
        'meldwork/changes.md',
      ]
      params.parent = instance.artifactVersions.at(-1)?.commit || null
      params.message = `Meldwork checkpoint ${instance.checkpointKey}`
    }
    return { ...effect, params }
  }

  async #persistPlaceholders(placeholders) {
    if (!Array.isArray(placeholders)) return
    await this.store.enqueue((state) => {
      state.placeholders = placeholders
      return { next: state }
    })
  }

  async dispatch(checkpointId, event) {
    const instance = this.#instance(checkpointId)
    if (!instance) throw engineError('PROJECT_NOT_FOUND', { checkpointId })
    const preview = transition(instance, event, this.#config(instance))
    if (preview.diagnostics.some(item => IGNORED_CODES.has(item.code))) {
      return { ignored: true, diagnostics: preview.diagnostics }
    }
    let effects = []
    await this.store.enqueue((state) => {
      const current = state.instances.find(item => item.id === checkpointId)
      if (!current) throw engineError('PROJECT_NOT_FOUND', { checkpointId })
      const result = transition(current, event, this.#config(current))
      for (const effect of result.effects) {
        if (effect.type !== 'acquire-scope') continue
        if (Array.isArray(effect.params?.claims) && effect.params.claims.length) continue
        const claims = this.#claimsFor(result.instance, effect)
        effect.params.claims = claims
        const request = result.instance.leaseRequests.find(item => item.id === effect.id)
        if (request) request.claims = claims
      }
      const index = state.instances.findIndex(item => item.id === checkpointId)
      state.instances[index] = result.instance
      effects = result.effects
      return { next: state, result: { effects } }
    })
    this.#queueDrain()
    return { ignored: false, effects }
  }

  async dispatchAll(event) {
    const instanceIds = (this.store.current()?.instances || []).map(instance => instance.id)
    const results = []
    for (const instanceId of instanceIds) {
      results.push(await this.dispatch(instanceId, event))
    }
    return results
  }

  async advanceProgress() {
    const state = this.store.current()
    if (!state) return []
    const ids = startableInstances(state)
    const results = []
    for (const instanceId of ids) {
      results.push(await this.dispatch(instanceId, {
        type: 'DEPS_READY',
        at: this.now(),
      }))
    }
    return results
  }

  async markStarted(effectId) {
    await this.store.enqueue((state) => {
      for (const instance of state.instances) {
        const effect = instance.effects.find(item => item.id === effectId)
        if (!effect) continue
        effect.status = 'started'
        effect.startedAt = this.now()
      }
      return { next: state, control: true }
    })
  }

  async #markEffect(effectId, status) {
    await this.store.enqueue((state) => {
      for (const instance of state.instances) {
        const effect = instance.effects.find(item => item.id === effectId)
        if (effect) {
          effect.status = status
          if (TERMINAL_EFFECT_STATUSES.has(status)) effect.finishedAt = this.now()
        }
      }
      return { next: state, control: true }
    })
  }

  #claimsFor(instance, effect) {
    if (Array.isArray(effect.params?.claims) && effect.params.claims.length) {
      return effect.params.claims
    }
    const def = this.#config(instance).checkpoint
    if (def && Array.isArray(def.targetFiles) && def.targetFiles.length && this.workdir) {
      return def.targetFiles.map(path => ({
        root: this.workdir,
        path,
        mode: 'exclusive',
      }))
    }
    return []
  }

  async #acquire(instance, effect) {
    if (!this.scheduler) throw engineError('PROJECT_INPUT_INVALID', { reason: 'scheduler-required' })
    const requestId = effect.id
    const isGranted = () => (this.scheduler.snapshot?.().claimGrants || [])
      .some(entry => entry.requestId === requestId)
    if (!this.waitingAcquisitions.has(requestId)) {
      this.waitingAcquisitions.add(requestId)
      const claims = this.#claimsFor(instance, effect)
      this.scheduler.request({
        requestId,
        holder: {
          kind: 'checkpoint-scope',
          projectId: this.projectId,
          ownerId: instance.id,
        },
        claims,
        onGranted: (grantedId) => {
          this.waitingAcquisitions.delete(requestId)
          this.dispatch(instance.id, {
            type: 'LEASE_GRANTED',
            at: this.now(),
            payload: { requestId: grantedId || requestId },
          }).catch(() => {})
        },
      })
    }
    if (!isGranted()) return false
    await this.dispatch(instance.id, {
      type: 'LEASE_GRANTED',
      at: this.now(),
      payload: { requestId },
    })
    this.waitingAcquisitions.delete(requestId)
    await this.#markEffect(effect.id, 'consumed')
    return true
  }

  async #release(instance, effect) {
    if (!this.scheduler) return
    const releaseAll = effect.type === 'release-scope'
    for (const request of instance.leaseRequests) {
      if (releaseAll) {
        if (request.status !== 'granted' && request.status !== 'releasing') continue
        this.scheduler.release(request.id)
        request.status = 'released'
        request.releasedAt = this.now()
        continue
      }
      if (request.status === 'waiting') {
        this.scheduler.withdraw(request.id)
        request.status = 'withdrawn'
      } else if (request.status === 'granted') {
        this.scheduler.release(request.id)
        request.status = 'released'
        request.releasedAt = this.now()
      }
    }
  }

  async #drainInstance(checkpointId) {
    for (let step = 0; step < 200; step += 1) {
      const instance = this.#instance(checkpointId)
      if (!instance) return
      const effect = instance.effects.find(item => item.status === 'pending')
      if (!effect) return
      if (effect.type === 'acquire-scope') {
        const granted = await this.#acquire(instance, effect)
        if (!granted) return
        continue
      }
      if (effect.type === 'release-scope' || effect.type === 'withdraw-lease') {
        await this.#release(instance, effect)
        await this.#markEffect(effect.id, 'consumed')
        continue
      }
      const prepared = this.#prepareEffect(instance, effect)
      const result = await this.runner.run(instance, prepared, {
        projectId: this.projectId,
        checkpointId,
        role: effect.type === 'invoke-reviewer'
          ? 'reviewer'
          : (effect.type === 'invoke-draft' ? 'draft' : 'lead'),
        seatId: effect.params?.seatId || '',
        round: instance.round,
        sessionGeneration: instance.sessionGeneration,
      })
      if (result.type === 'EFFECT_VOIDED') {
        await this.#markEffect(effect.id, 'voided')
        continue
      }
      if (result.type === 'EFFECT_PAUSED') return
      if (result.type === 'EFFECT_FAILED') {
        await this.dispatch(checkpointId, {
          type: 'EFFECT_FAILED',
          at: this.now(),
          payload: { effectId: effect.id, error: result.error?.code || 'EFFECT_FAILED' },
        })
        return
      }
      if (result.type === 'INVOCATION_ENDED') {
        await this.dispatch(checkpointId, {
          type: 'INVOCATION_ENDED',
          at: this.now(),
          payload: {
            effectId: result.effectId,
            role: result.role,
            seatId: result.seatId,
            round: result.round,
            sessionGeneration: result.sessionGeneration,
            ...(result.marker ? { marker: result.marker } : {}),
            ...(result.failed ? { failed: result.failed } : {}),
            ...(result.cancelled ? { cancelled: true } : {}),
            ...(result.pendingMessageRef ? { pendingMessageRef: result.pendingMessageRef } : {}),
          },
        })
        continue
      }
      if (result.effectType === 'snapshot' && result.result?.commit) {
        this.snapshotCommits.set(checkpointId, result.result.commit)
        if (Array.isArray(result.result.placeholderList)) {
          await this.#persistPlaceholders(result.result.placeholderList)
        }
      }
      await this.dispatch(checkpointId, {
        type: 'EFFECT_RESULT',
        at: this.now(),
        payload: {
          effectId: result.effectId,
          type: result.effectType,
          result: result.result,
        },
      })
    }
    throw engineError('PROJECT_ENGINE_STALLED', { checkpointId })
  }

  #queueDrain() {
    if (this.drainPromise) {
      this.drainQueued = true
      return this.drainPromise
    }
    this.drainPromise = this.#drainAll()
      .finally(() => {
        this.drainPromise = null
        if (this.drainQueued) {
          this.drainQueued = false
          this.#queueDrain()
        }
      })
    return this.drainPromise
  }

  async #drainAll() {
    for (let round = 0; round < 50; round += 1) {
      const state = this.store.current()
      if (!state) return
      let progressed = false
      for (const instance of [...state.instances]) {
        const pending = instance.effects.some(effect => effect.status === 'pending')
        if (!pending) continue
        progressed = true
        await this.#drainInstance(instance.id)
      }
      if (!progressed) return
    }
  }

  async runUntilIdle() {
    await this.#queueDrain()
    return { pending: this.#hasPendingEffects() }
  }

  #hasPendingEffects() {
    const state = this.store.current()
    if (!state) return false
    return state.instances.some(instance => instance.effects.some(effect => (
      effect.status === 'pending' || effect.status === 'started'
    )))
  }

  async recover() {
    const eventAt = this.now()
    await this.store.enqueue((state) => {
      for (const instance of state.instances) {
        const retryInvocations = []
        for (const invocation of [...instance.activeInvocations]) {
          const effect = instance.effects.find(item => item.id === invocation.effectId)
          if (invocation.role === 'lead' || invocation.role === 'draft') {
            if (invocation.cancellationRequested) {
              if (effect) effect.status = 'consumed'
            } else {
              instance.state = 'gate'
              instance.gate = recoveryGate(instance, eventAt)
              if (effect) effect.status = 'consumed'
            }
          } else if (effect) {
            effect.status = 'pending'
            effect.startedAt = null
            retryInvocations.push(invocation)
          }
        }
        instance.activeInvocations = retryInvocations
        for (const effect of instance.effects) {
          if (effect.status === 'pending' || effect.status === 'started') {
            if (effect.epoch !== instance.epoch && !NEVER_EXPIRE.has(effect.type)) {
              effect.status = 'voided'
              effect.finishedAt = eventAt
            }
          }
        }
        if (instance.blockedOn) {
          const blocked = instance.effects.find(effect => effect.id === instance.blockedOn.effectId)
          if (blocked?.status === 'voided') instance.blockedOn = null
        }
      }
      for (const drift of state.driftItems || []) {
        if (drift.status === 'resolving') drift.status = 'unresolved'
      }
      return { next: state, control: true }
    })

    const state = this.store.current()
    const granted = []
    const waiting = []
    for (const instance of state.instances) {
      for (const request of instance.leaseRequests) {
        if (request.status === 'granted') granted.push(request)
        else if (request.status === 'waiting') waiting.push(request)
      }
    }
    if (granted.length && this.scheduler?.restoreGranted) {
      try {
        this.scheduler.restoreGranted(granted.map(request => ({
          requestId: request.id,
          holder: request.holder,
          claims: request.claims,
        })))
      } catch {
        // A conflicting restoration leaves the records to the operator.
      }
    }
    for (const request of waiting) {
      this.scheduler?.request?.({
        requestId: request.id,
        holder: request.holder,
        claims: request.claims,
        onGranted: (requestId) => {
          this.dispatch(request.holder.ownerId, {
            type: 'LEASE_GRANTED',
            at: this.now(),
            payload: { requestId: requestId || request.id },
          }).catch(() => {})
        },
      })
    }
    await this.runUntilIdle()
    return { pending: this.#hasPendingEffects() }
  }

  beginDraining(state) {
    const next = structuredClone(state)
    const eventAt = this.now()
    for (const instance of next.instances) {
      instance.epoch += 1
      for (const invocation of instance.activeInvocations) {
        invocation.cancellationRequested = true
        const exists = instance.effects.some(effect => (
          effect.type === 'cancel-invocation' && effect.params?.effectId === invocation.effectId
        ))
        if (!exists) {
          instance.effects.push({
            id: `${instance.id}:cancel:${instance.effects.length}`,
            type: 'cancel-invocation',
            category: 'cleanup',
            status: 'pending',
            epoch: instance.epoch,
            params: { effectId: invocation.effectId },
            result: null,
            error: null,
            startedAt: null,
            finishedAt: null,
          })
        }
      }
      for (const request of instance.leaseRequests) {
        if (request.status === 'waiting') {
          request.status = 'withdrawn'
        } else if (request.status === 'granted') {
          const writing = instance.activeInvocations.some(invocation => (
            invocation.role === 'lead' || invocation.role === 'draft'
          ))
          request.status = writing ? 'releasing' : 'released'
          if (!writing) request.releasedAt = eventAt
        }
      }
      for (const effect of instance.effects) {
        if (effect.status !== 'pending') continue
        if (NEVER_EXPIRE.has(effect.type)) continue
        effect.status = 'voided'
        effect.finishedAt = eventAt
      }
      if (instance.blockedOn) {
        const blocked = instance.effects.find(effect => effect.id === instance.blockedOn.effectId)
        if (blocked?.status === 'voided') instance.blockedOn = null
      }
    }
    for (const effect of next.projectEffects || []) {
      if (effect.status !== 'pending') continue
      if (effect.type === 'reconcile-scheduler') continue
      effect.status = 'voided'
      effect.finishedAt = eventAt
    }
    next.deletion = {
      phase: 'draining',
      startedAt: next.deletion?.startedAt || eventAt,
    }
    return next
  }

  isDrained(state) {
    return (state.instances || []).every(instance => (
      instance.activeInvocations.length === 0
        && instance.leaseRequests.every(request => ENDED_LEASE_STATUSES.has(request.status))
        && instance.effects.every(effect => TERMINAL_EFFECT_STATUSES.has(effect.status))
    )) && (state.projectEffects || [])
      .every(effect => TERMINAL_EFFECT_STATUSES.has(effect.status))
  }
}

module.exports = {
  CheckpointEngine,
}
