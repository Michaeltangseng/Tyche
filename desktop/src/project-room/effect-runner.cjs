const DEFAULT_RETRY_DELAYS = [1000, 5000, 30000]
const NEVER_EXPIRE = new Set(['release-scope', 'withdraw-lease', 'cancel-invocation'])
const INVOCATION_TYPES = new Set(['invoke-lead', 'invoke-draft', 'invoke-reviewer'])
const MANAGED_HOLDER_KINDS = new Set(['checkpoint-scope', 'project-maintenance'])

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errorShape(error) {
  return {
    code: String(error?.code || 'EFFECT_FAILED'),
    message: String(error?.message || error || 'EFFECT_FAILED'),
  }
}

class EffectRunner {
  constructor({
    scheduler,
    handlers = {},
    invoke,
    cancelInvocation,
    markStarted = async () => {},
    isStorageDurable = () => true,
    sleep = defaultSleep,
    retryDelays = DEFAULT_RETRY_DELAYS,
    now = () => Date.now(),
  } = {}) {
    this.scheduler = scheduler
    this.handlers = handlers
    this.invoke = invoke
    this.cancelInvocation = cancelInvocation
    this.markStarted = markStarted
    this.isStorageDurable = isStorageDurable
    this.sleep = sleep
    this.retryDelays = [...retryDelays]
    this.now = now
  }

  #paused(instance, effect, context) {
    if (this.isStorageDurable() === false) return 'storage'
    if (instance.blockedOn && effect.category !== 'cleanup') return 'blocked'
    if (context?.paused === true) return 'paused'
    return ''
  }

  async #executeOnce(effect, context) {
    if (INVOCATION_TYPES.has(effect.type)) {
      if (typeof this.invoke !== 'function') throw new Error('EFFECT_INVOKE_UNAVAILABLE')
      const invocation = await this.invoke({ effect, ...context })
      return {
        type: 'INVOCATION_ENDED',
        effectId: effect.id,
        effectType: effect.type,
        role: invocation?.role || context.role || '',
        seatId: invocation?.seatId || context.seatId || '',
        round: invocation?.round ?? context.round,
        sessionGeneration: invocation?.sessionGeneration ?? context.sessionGeneration,
        marker: invocation?.marker || '',
        ...(invocation?.failed ? { failed: invocation.failed } : {}),
        ...(invocation?.cancelled ? { cancelled: true } : {}),
        ...(invocation?.pendingMessageRef
          ? { pendingMessageRef: invocation.pendingMessageRef }
          : {}),
      }
    }
    if (effect.type === 'cancel-invocation') {
      if (typeof this.cancelInvocation !== 'function') {
        throw new Error('EFFECT_CANCEL_UNAVAILABLE')
      }
      await this.cancelInvocation({ effect, ...context })
      return { type: 'EFFECT_RESULT', effectId: effect.id, effectType: effect.type, result: null }
    }
    const handler = this.handlers[effect.type]
    if (typeof handler !== 'function') {
      throw Object.assign(new Error('EFFECT_HANDLER_MISSING'), {
        code: 'EFFECT_HANDLER_MISSING',
        details: { effectType: effect.type },
      })
    }
    const result = await handler({ effect, ...context })
    if (effect.type === 'user-git-commit') {
      return { type: 'EFFECT_RESULT', effectId: effect.id, effectType: effect.type, result }
    }
    return { type: 'EFFECT_RESULT', effectId: effect.id, effectType: effect.type, result }
  }

  async run(instance, effect, context = {}) {
    if (!effect || typeof effect !== 'object') {
      throw Object.assign(new Error('EFFECT_INVALID'), { code: 'EFFECT_INVALID' })
    }
    if (effect.epoch !== instance.epoch && !NEVER_EXPIRE.has(effect.type)) {
      return {
        type: 'EFFECT_VOIDED',
        effectId: effect.id,
        effectType: effect.type,
      }
    }
    const pauseReason = this.#paused(instance, effect, context)
    if (pauseReason) {
      return {
        type: 'EFFECT_PAUSED',
        effectId: effect.id,
        effectType: effect.type,
        reason: pauseReason,
      }
    }
    if (INVOCATION_TYPES.has(effect.type) || effect.type === 'user-git-commit') {
      await this.markStarted(effect)
    }
    const attempts = effect.category === 'required' ? this.retryDelays.length + 1 : 1
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await this.sleep(this.retryDelays[attempt - 1])
      try {
        return await this.#executeOnce(effect, {
          ...context,
          instance,
          attempt,
        })
      } catch (error) {
        lastError = error
      }
    }
    if (effect.category === 'best-effort') {
      return {
        type: 'EFFECT_RESULT',
        effectId: effect.id,
        effectType: effect.type,
        result: null,
        error: errorShape(lastError),
      }
    }
    return {
      type: 'EFFECT_FAILED',
      effectId: effect.id,
      effectType: effect.type,
      error: errorShape(lastError),
    }
  }

  async runAll(instance, effects, context = {}) {
    const results = []
    for (const effect of Array.isArray(effects) ? effects : []) {
      results.push(await this.run(instance, effect, context))
    }
    return results
  }

  reconcileScheduler({ projectId, expectedRequestIds = [] } = {}) {
    if (!this.scheduler || typeof this.scheduler.snapshot !== 'function') {
      throw Object.assign(new Error('EFFECT_SCHEDULER_UNAVAILABLE'), {
        code: 'EFFECT_SCHEDULER_UNAVAILABLE',
      })
    }
    const expected = new Set(expectedRequestIds)
    const snapshot = this.scheduler.snapshot()
    const entries = [...(snapshot.claimGrants || []), ...(snapshot.claimQueue || [])]
    const withdrawn = []
    for (const entry of entries) {
      if (!MANAGED_HOLDER_KINDS.has(entry.holder?.kind)) continue
      if (entry.holder?.projectId && entry.holder.projectId !== projectId) continue
      if (expected.has(entry.requestId)) continue
      this.scheduler.withdraw(entry.requestId)
      withdrawn.push(entry.requestId)
    }
    return { withdrawn }
  }
}

module.exports = {
  DEFAULT_RETRY_DELAYS,
  EffectRunner,
  NEVER_EXPIRE,
}
