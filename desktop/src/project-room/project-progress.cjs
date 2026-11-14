const crypto = require('node:crypto')

const CHECKPOINT_TYPES = new Set([
  'interview', 'research', 'document', 'readiness', 'milestone', 'final-review', 'retro',
])
const TERMINAL_ACCEPTED = 'accepted'
const BLOCKING_DRIFT = new Set(['unresolved', 'resolving'])

function idError(reason, details = {}) {
  return Object.assign(new Error('PROJECT_INPUT_INVALID'), {
    code: 'PROJECT_INPUT_INVALID',
    details: { reason, ...details },
  })
}

function instanceForKey(state, key) {
  return state.instances.find(instance => (
    instance.checkpointKey === key && instance.state !== 'stale'
  )) || null
}

function instanceForId(state, id) {
  return state.instances.find(instance => instance.id === id) || null
}

function defFor(state, key) {
  return state.config.playbook.checkpointDefs.find(def => def.key === key) || null
}

function upstreamKeys(state, instance) {
  const def = defFor(state, instance.checkpointKey)
  const keys = new Set(def?.dependsOn || [])
  for (const checkpointId of Object.keys(instance.readVersions || {})) {
    const upstream = instanceForId(state, checkpointId)
    if (upstream) keys.add(upstream.checkpointKey)
  }
  return keys
}

function dependenciesAccepted(state, instance) {
  for (const key of upstreamKeys(state, instance)) {
    const upstream = instanceForKey(state, key)
    if (!upstream || upstream.state !== TERMINAL_ACCEPTED) return false
  }
  return true
}

function startableInstances(state) {
  return state.instances
    .filter(instance => instance.state === 'pending' && dependenciesAccepted(state, instance))
    .sort((left, right) => left.checkpointKey.localeCompare(right.checkpointKey))
    .map(instance => instance.id)
}

function validateManifest(state, manifest) {
  const issues = []
  if (!Array.isArray(manifest) || !manifest.length) {
    return { valid: false, issues: [{ code: 'MANIFEST_EMPTY' }] }
  }
  const seatIds = new Set(state.config.seats.map(seat => seat.id))
  const keys = new Set()
  for (const [index, item] of manifest.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push({ code: 'MANIFEST_ITEM_INVALID', index })
      continue
    }
    if (typeof item.key !== 'string' || !item.key || keys.has(item.key)) {
      issues.push({ code: 'MANIFEST_KEY_INVALID', index })
    } else {
      keys.add(item.key)
    }
    if (!CHECKPOINT_TYPES.has(item.type)) {
      issues.push({ code: 'MANIFEST_TYPE_INVALID', index })
    }
    const referenced = [
      item.leadSeatId, ...(item.reviewerSeatIds || []), ...(item.draftSeatIds || []),
    ].filter(Boolean)
    for (const seatId of referenced) {
      if (!seatIds.has(seatId)) {
        issues.push({ code: 'MANIFEST_SEAT_INVALID', index, seatId })
      }
    }
    for (const dependency of item.dependsOn || []) {
      if (!keys.has(dependency) && !defFor(state, dependency)) {
        issues.push({ code: 'MANIFEST_DEPENDENCY_INVALID', index, dependency })
      }
    }
  }
  return { valid: issues.length === 0, issues }
}

function emptyInstance(id, def) {
  return {
    id,
    checkpointKey: def.key,
    state: 'pending',
    seq: 0,
    epoch: 0,
    round: 0,
    roundsSinceHuman: 0,
    continuations: 0,
    sessionGeneration: 0,
    candidate: null,
    rounds: [],
    roundsSummary: [],
    leaseRequests: [],
    activeInvocations: [],
    pendingStart: null,
    drafts: [],
    interjections: [],
    gate: null,
    blockedOn: null,
    effects: [],
    artifactVersions: [],
    readVersions: {},
    decisions: [],
  }
}

function instantiateChecklist(state, {
  manifest,
  now = () => new Date().toISOString(),
  createId = () => crypto.randomUUID(),
} = {}) {
  const validation = validateManifest(state, manifest)
  if (!validation.valid) {
    throw idError('manifest-invalid', { issues: validation.issues })
  }
  const next = structuredClone(state)
  const created = []
  for (const item of manifest) {
    const def = {
      key: item.key,
      name: String(item.name || item.key),
      type: item.type,
      targetFiles: Array.isArray(item.targetFiles) ? [...item.targetFiles] : [],
      leadSeatId: item.leadSeatId,
      reviewerSeatIds: Array.isArray(item.reviewerSeatIds) ? [...item.reviewerSeatIds] : [],
      draftSeatIds: Array.isArray(item.draftSeatIds) ? [...item.draftSeatIds] : [],
      gate: item.gate === 'soft' ? 'soft' : 'hard',
      roundLimit: item.roundLimit ?? null,
      continuationLimit: item.continuationLimit ?? null,
      producesChecklist: item.producesChecklist === true,
      dependsOn: Array.isArray(item.dependsOn) ? [...item.dependsOn] : [],
    }
    const existingDef = defFor(next, item.key)
    if (existingDef) Object.assign(existingDef, def)
    else next.config.playbook.checkpointDefs.push(def)
    if (!instanceForKey(next, item.key)) {
      const instance = emptyInstance(createId(), def)
      next.instances.push(instance)
      created.push(instance.id)
    }
  }
  next.config.configRevision += 1
  void now
  return { state: next, createdInstanceIds: created }
}

function dependentInstanceIds(state, targetId) {
  const target = instanceForId(state, targetId)
  if (!target) return []
  const targetKeys = new Set([target.checkpointKey])
  const affected = new Set()
  const queue = [target.checkpointKey]
  while (queue.length) {
    const key = queue.shift()
    for (const instance of state.instances) {
      if (instance.id === targetId || affected.has(instance.id)) continue
      const def = defFor(state, instance.checkpointKey)
      const readsTarget = Object.keys(instance.readVersions || {})
        .some(checkpointId => checkpointId === targetId)
      const dependsOnKey = def?.dependsOn?.includes(key) || false
      if (!readsTarget && !dependsOnKey) continue
      if (instance.state === 'stale') continue
      affected.add(instance.id)
      if (!targetKeys.has(instance.checkpointKey)) {
        targetKeys.add(instance.checkpointKey)
        queue.push(instance.checkpointKey)
      }
    }
  }
  return [...affected].sort()
}

function impactHash(targetId, affectedIds, invocationIds) {
  const canonical = JSON.stringify({
    targetId,
    affected: [...new Set(affectedIds)].sort(),
    invocations: [...new Set(invocationIds)].sort(),
  })
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function impactPreview(state, targetId) {
  if (!instanceForId(state, targetId)) throw idError('checkpoint-not-found', { checkpointId: targetId })
  const affectedCheckpointIds = dependentInstanceIds(state, targetId)
  const activeInvocationEffectIds = []
  const target = instanceForId(state, targetId)
  for (const invocation of target.activeInvocations) {
    activeInvocationEffectIds.push(invocation.effectId)
  }
  for (const instanceId of affectedCheckpointIds) {
    const instance = instanceForId(state, instanceId)
    for (const invocation of instance.activeInvocations) {
      activeInvocationEffectIds.push(invocation.effectId)
    }
  }
  activeInvocationEffectIds.sort()
  return {
    targetCheckpointId: targetId,
    affectedCheckpointIds,
    activeInvocationEffectIds,
    impactHash: impactHash(targetId, affectedCheckpointIds, activeInvocationEffectIds),
  }
}

function acceptanceBlockers(state, instanceId) {
  const instance = instanceForId(state, instanceId)
  if (!instance) throw idError('checkpoint-not-found', { checkpointId: instanceId })
  const blockers = []
  const upstreamIds = new Set(Object.keys(instance.readVersions || {}))
  for (const key of upstreamKeys(state, instance)) {
    const upstream = instanceForKey(state, key)
    if (upstream) upstreamIds.add(upstream.id)
  }
  for (const upstreamId of upstreamIds) {
    const upstream = instanceForId(state, upstreamId)
    if (upstream?.gate?.reason === 'doc-new-version') {
      blockers.push({ type: 'doc-new-version', checkpointId: upstreamId })
    }
    for (const drift of state.driftItems || []) {
      if (drift.checkpointId === upstreamId && BLOCKING_DRIFT.has(drift.status)) {
        blockers.push({ type: 'drift', checkpointId: upstreamId, itemId: drift.id })
      }
    }
  }
  const checks = Object.values(state.chatWriteChecks || {})
  if (checks.length) {
    blockers.push({ type: 'detection', checkCount: checks.length })
  }
  const pendingDetection = (state.projectEffects || []).some(effect => (
    effect.type === 'detect-accepted-changes'
      && effect.status !== 'consumed'
      && effect.status !== 'voided'
  ))
  if (pendingDetection) blockers.push({ type: 'detection', effect: true })
  return { blocked: blockers.length > 0, blockers }
}

function blockerSignature(state, instanceId) {
  const { blockers } = acceptanceBlockers(state, instanceId)
  return blockers.map(blocker => (
    `${blocker.type}:${blocker.checkpointId || ''}:${blocker.itemId || ''}:${blocker.checkCount || ''}:${blocker.effect || ''}`
  )).sort().join('|')
}

function blockersDelta(previousState, nextState) {
  const changedCheckpointIds = []
  const events = []
  const ids = new Set([
    ...(previousState.instances || []).map(instance => instance.id),
    ...(nextState.instances || []).map(instance => instance.id),
  ])
  for (const instanceId of ids) {
    const previous = (previousState.instances || []).some(instance => instance.id === instanceId)
    const next = (nextState.instances || []).some(instance => instance.id === instanceId)
    if (!previous || !next) {
      changedCheckpointIds.push(instanceId)
      events.push({ type: 'UPSTREAM_BLOCKERS_CHANGED', checkpointId: instanceId })
      continue
    }
    if (blockerSignature(previousState, instanceId) !== blockerSignature(nextState, instanceId)) {
      changedCheckpointIds.push(instanceId)
      events.push({ type: 'UPSTREAM_BLOCKERS_CHANGED', checkpointId: instanceId })
    }
  }
  return { changedCheckpointIds: changedCheckpointIds.sort(), events }
}

module.exports = {
  acceptanceBlockers,
  blockersDelta,
  dependenciesAccepted,
  impactHash,
  impactPreview,
  instantiateChecklist,
  startableInstances,
  validateManifest,
}
