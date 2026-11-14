const at = '1970-01-01T00:00:00.000Z'

const EFFECT_CATEGORY = {
  'drift-check': 'required',
  snapshot: 'required',
  'evaluate-submission': 'required',
  'verify-candidate': 'required',
  'write-review-file': 'required',
  'accept-commit': 'required',
  'append-decision': 'required',
  'stamp-changes': 'required',
  'acquire-scope': 'required',
  'release-scope': 'required',
  'restore-files': 'required',
  'verify-observed': 'required',
  'append-message': 'required',
  'append-timeline': 'required',
  'invoke-lead': 'invocation',
  'invoke-draft': 'invocation',
  'invoke-reviewer': 'invocation',
  'cancel-invocation': 'cleanup',
  'withdraw-lease': 'cleanup',
  'drop-snapshot-refs': 'cleanup',
  'reconcile-scheduler': 'cleanup',
  'user-git-commit': 'external',
  notify: 'best-effort',
}

const GATE_OUTCOMES = {
  'doc-new-version': ['continue', 'accept', 'reject-upstream'],
  drift: ['accept', 'reject-upstream'],
  failure: ['continue', 'accept', 'reject-upstream'],
  recovery: ['continue', 'accept', 'reject-upstream'],
  question: ['continue', 'reject-upstream'],
  'draft-question': ['continue', 'reject-upstream'],
  'continuation-limit': ['continue', 'accept', 'reject-upstream'],
  'marker-missing': ['continue', 'accept', 'reject-upstream'],
  'manifest-invalid': ['continue', 'reject-upstream'],
  'needs-human': ['continue', 'accept', 'reject-upstream'],
  'review-failed': ['continue', 'accept', 'reject-upstream'],
  'rebuttal-rejected': ['continue', 'accept', 'reject-upstream'],
  'round-limit': ['continue', 'accept', 'reject-upstream'],
  'artifact-unchanged': ['continue', 'accept', 'reject-upstream'],
  'hard-gate-passed': ['continue', 'accept', 'reject-upstream'],
}

function addEffect(effects, type, params = {}) {
  effects.push({ type, category: EFFECT_CATEGORY[type] || 'required', params })
}

function consumeEffect(instance, effectId, status, eventAt) {
  if (!effectId) return null
  const effect = instance.effects.find(item => item.id === effectId)
  if (!effect) return null
  effect.status = status
  if (status === 'consumed' || status === 'voided' || status === 'failed') {
    effect.finishedAt = eventAt || effect.finishedAt || null
  }
  return effect
}

function removeInvocation(instance, effectId) {
  if (!effectId) return null
  const index = instance.activeInvocations.findIndex(item => item.effectId === effectId)
  if (index < 0) return null
  return instance.activeInvocations.splice(index, 1)[0]
}

function deliverInterjections(instance, eventAt) {
  let delivered = 0
  for (const interjection of instance.interjections) {
    if (interjection.status !== 'queued') continue
    interjection.status = 'delivered'
    interjection.deliveredAt = eventAt
    delivered += 1
  }
  instance.roundsSinceHuman = 0
  instance.continuations = 0
  return delivered
}

function emptyScreen() {
  return {
    round: 0,
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
  }
}

function openGate(instance, reason, eventAt, revision = 1) {
  instance.gate = {
    id: `gate-${instance.id}-${instance.seq + 1}`,
    revision,
    reason,
    candidateCommit: instance.candidate,
    createdAt: eventAt,
    firstScreen: emptyScreen(),
  }
  instance.state = 'gate'
}

function voidGate(instance) {
  if (!instance.gate) return null
  const gate = instance.gate
  instance.decisions.push({
    gateId: gate.id,
    gateRevision: gate.revision,
    reason: gate.reason,
    outcome: 'continue',
    comment: '',
    candidateCommit: gate.candidateCommit,
    upstreamCheckpointId: null,
    impactHash: null,
    driftChoice: null,
    commitToGit: false,
    decidedAt: gate.createdAt,
  })
  instance.gate = null
  return gate
}

function currentRound(instance, eventAt) {
  const roundNumber = Math.max(1, instance.round)
  let round = instance.rounds.find(item => item.round === roundNumber)
  if (!round) {
    round = {
      round: roundNumber,
      candidate: instance.candidate || '0'.repeat(40),
      rebuttal: false,
      bodyChanged: true,
      startedAt: eventAt,
      reviews: [],
    }
    instance.rounds.push(round)
  }
  return round
}

function recordReview(instance, payload, eventAt) {
  const round = currentRound(instance, eventAt)
  const verdict = payload.failed ? 'failed' : (payload.marker || 'missing')
  const existing = round.reviews.find(item => item.seatId === payload.seatId)
  const value = {
    seatId: payload.seatId,
    verdict,
    reviewFile: `meldwork/reviews/${instance.checkpointKey}/r${round.round}-${payload.seatId}.md`,
    finishedAt: eventAt,
  }
  if (existing) Object.assign(existing, value)
  else round.reviews.push(value)
  return { round, verdict }
}

function reviewedSeats(instance) {
  const round = instance.rounds.find(item => item.round === Math.max(1, instance.round))
  return new Set((round?.reviews || []).map(review => review.seatId))
}

function isReadExecSeat(config, seatId) {
  return (config?.readExecSeatIds || []).includes(seatId)
}

function readExecRemaining(instance, config) {
  const reviewed = reviewedSeats(instance)
  return (config?.readExecSeatIds || []).some(seatId => !reviewed.has(seatId))
}

function startReview(instance, effects, { rebuttal, eventAt, config }) {
  instance.round += 1
  instance.roundsSinceHuman += 1
  instance.state = 'reviewing'
  instance.rounds.push({
    round: instance.round,
    candidate: instance.candidate || '0'.repeat(40),
    rebuttal,
    bodyChanged: !rebuttal,
    startedAt: eventAt,
    reviews: [],
  })
  addEffect(effects, 'invoke-reviewer', {
    checkpointId: instance.id,
    seatId: config?.checkpoint?.reviewerSeatIds?.[0] || '',
    round: instance.round,
    sessionGeneration: instance.sessionGeneration,
  })
  return config
}

function acceptEffects(effects) {
  addEffect(effects, 'append-decision')
  addEffect(effects, 'stamp-changes')
  addEffect(effects, 'accept-commit')
  addEffect(effects, 'drop-snapshot-refs')
  addEffect(effects, 'notify')
}

function rejectToUpstream(instance, effects) {
  voidGate(instance)
  instance.epoch += 1
  instance.state = 'stale'
  addEffect(effects, 'withdraw-lease')
}

function handleInvocationEnded(instance, event, config, effects, diagnostics) {
  const payload = event.payload || {}
  const eventAt = event.at || at
  const invocation = instance.activeInvocations.find(item => item.effectId === payload.effectId)
  if (!invocation || invocation.role !== payload.role
      || invocation.round !== payload.round
      || invocation.sessionGeneration !== payload.sessionGeneration) {
    return false
  }
  const removed = removeInvocation(instance, payload.effectId)
  consumeEffect(instance, payload.effectId, 'consumed', eventAt)
  if (payload.role === 'draft') {
    if (instance.state !== 'drafting') return false
    const limit = config?.checkpoint?.continuationLimit ?? 3
    if (!payload.failed && !payload.cancelled && payload.marker === 'continue'
        && instance.continuations + 1 < limit) {
      instance.continuations += 1
      addEffect(effects, 'invoke-draft', {
        seatId: payload.seatId,
        round: instance.round,
        sessionGeneration: instance.sessionGeneration,
      })
      return true
    }
    let draft = instance.drafts.find(item => item.seatId === payload.seatId)
    if (!draft) {
      draft = { seatId: payload.seatId, status: 'pending', effectId: payload.effectId, sessionGeneration: instance.sessionGeneration }
      instance.drafts.push(draft)
    }
    draft.status = payload.failed
      ? 'failed'
      : (payload.marker || 'failed')
    if (instance.activeInvocations.length > 0) return removed !== null || true
    const blocked = instance.drafts.some(item => ['question', 'failed', 'missing'].includes(item.status))
    if (blocked) {
      instance.state = 'gate'
      openGate(instance, 'draft-question', eventAt)
      addEffect(effects, 'release-scope')
      return true
    }
    instance.state = 'leading'
    addEffect(effects, 'release-scope')
    addEffect(effects, 'acquire-scope')
    addEffect(effects, 'snapshot', { phase: 'before' })
    addEffect(effects, 'invoke-lead', {
      seatId: config?.checkpoint?.leadSeatId || '',
      round: instance.round,
      sessionGeneration: instance.sessionGeneration,
    })
    return true
  }
  if (payload.role === 'lead') {
    if (instance.state !== 'leading') return false
    const limit = config?.checkpoint?.continuationLimit ?? 3
    if (payload.cancelled) return true
    if (!payload.failed && payload.marker === 'ready') {
      instance.state = 'submitted'
      addEffect(effects, 'snapshot', { phase: 'after' })
      addEffect(effects, 'evaluate-submission')
      return true
    }
    if (!payload.failed && payload.marker === 'continue') {
      if (instance.continuations + 1 < limit) {
        instance.continuations += 1
        addEffect(effects, 'invoke-lead', {
      seatId: config?.checkpoint?.leadSeatId || '',
      round: instance.round,
      sessionGeneration: instance.sessionGeneration,
    })
      } else {
        addEffect(effects, 'snapshot', { phase: 'after' })
        addEffect(effects, 'release-scope')
        openGate(instance, 'continuation-limit', eventAt)
      }
      return true
    }
    if (payload.failed) {
      addEffect(effects, 'snapshot', { phase: 'after' })
      addEffect(effects, 'release-scope')
      openGate(instance, 'failure', eventAt)
      return true
    }
    addEffect(effects, 'snapshot', { phase: 'after' })
    addEffect(effects, 'release-scope')
    openGate(instance, payload.marker === 'question' ? 'question' : 'marker-missing', eventAt)
    return true
  }
  if (payload.role === 'reviewer') {
    if (instance.state !== 'reviewing') return false
    const { verdict } = recordReview(instance, payload, eventAt)
    addEffect(effects, 'write-review-file', { seatId: payload.seatId })
    if (payload.failed) {
      addEffect(effects, 'cancel-invocation')
      addEffect(effects, 'release-scope')
      openGate(instance, 'review-failed', eventAt)
      return true
    }
    if (verdict === 'needs-human' || verdict === 'missing') {
      addEffect(effects, 'cancel-invocation')
      addEffect(effects, 'release-scope')
      openGate(instance, 'needs-human', eventAt)
      return true
    }
    if (instance.activeInvocations.length > 0) return true
    if (isReadExecSeat(config, payload.seatId)) {
      addEffect(effects, 'snapshot', { phase: 'after' })
      addEffect(effects, 'verify-candidate')
      return true
    }
    const round = currentRound(instance, eventAt)
    const readExecLeft = readExecRemaining(instance, config)
    if (readExecLeft) {
      addEffect(effects, 'snapshot', { phase: 'before' })
      addEffect(effects, 'invoke-reviewer', {
        seatId: config?.readExecSeatIds?.[0] || '',
        round: instance.round,
        sessionGeneration: instance.sessionGeneration,
      })
      return true
    }
    const verdicts = round.reviews.map(review => review.verdict)
    if (verdicts.includes('needs-human') || verdicts.includes('missing') || verdicts.includes('failed')) {
      addEffect(effects, 'release-scope')
      openGate(instance, 'needs-human', eventAt)
      return true
    }
    if (verdicts.includes('revise')) {
      if (round.rebuttal) {
        addEffect(effects, 'release-scope')
        openGate(instance, 'rebuttal-rejected', eventAt)
        return true
      }
      if (instance.interjections.some(item => item.status === 'queued')) {
        deliverInterjections(instance, eventAt)
        instance.state = 'leading'
        return true
      }
      const limit = config?.checkpoint?.roundLimit ?? 3
      if (instance.roundsSinceHuman >= limit) {
        addEffect(effects, 'release-scope')
        openGate(instance, 'round-limit', eventAt)
        return true
      }
      instance.state = 'leading'
      addEffect(effects, 'snapshot', { phase: 'before' })
      addEffect(effects, 'invoke-lead', {
      seatId: config?.checkpoint?.leadSeatId || '',
      round: instance.round,
      sessionGeneration: instance.sessionGeneration,
    })
      return true
    }
    addEffect(effects, 'verify-candidate')
    return true
  }
  return false
}

function handleSubmittedResult(instance, event, config, effects, diagnostics) {
  if (instance.state !== 'submitted') return false
  const payload = event.payload || {}
  const eventAt = event.at || at
  if (payload.type === 'snapshot') {
    instance.candidate = payload.result?.commit || payload.result || instance.candidate
    return true
  }
  if (payload.type !== 'evaluate-submission') return false
  const result = payload.result || {}
  if (result.manifestValid === false) {
    addEffect(effects, 'release-scope')
    openGate(instance, 'manifest-invalid', eventAt)
    return true
  }
  if (instance.interjections.some(item => item.status === 'queued')) {
    deliverInterjections(instance, eventAt)
    instance.state = 'leading'
    return true
  }
  if (result.bodyChanged === true || instance.round === 0) {
    startReview(instance, effects, { rebuttal: false, eventAt, config })
    return true
  }
  if (result.newResponse === true) {
    startReview(instance, effects, { rebuttal: true, eventAt, config })
    return true
  }
  addEffect(effects, 'release-scope')
  openGate(instance, 'artifact-unchanged', eventAt)
  return true
}

function handleReviewingResult(instance, event, config, effects, diagnostics) {
  if (instance.state !== 'reviewing') return false
  const payload = event.payload || {}
  if (payload.type !== 'verify-candidate') return false
  const intact = payload.result?.intact === true
  if (!intact) {
    addEffect(effects, 'release-scope')
    openGate(instance, 'review-failed', event.at || at)
    return true
  }
  if (readExecRemaining(instance, config)) {
    const nextSeat = (config.readExecSeatIds || []).find(seatId => !reviewedSeats(instance).has(seatId))
    addEffect(effects, 'write-review-file', { seatId: nextSeat || '' })
    addEffect(effects, 'invoke-reviewer', {
      seatId: nextSeat || '',
      round: instance.round,
      sessionGeneration: instance.sessionGeneration,
    })
    return true
  }
  if (instance.interjections.some(item => item.status === 'queued')) {
    deliverInterjections(instance, event.at || at)
    instance.state = 'leading'
    return true
  }
  if (config?.checkpoint?.gate === 'hard' || Object.keys(config?.softBlockers || {}).length > 0) {
    addEffect(effects, 'release-scope')
    openGate(instance, 'hard-gate-passed', event.at || at)
    return true
  }
  instance.state = 'accepting'
  acceptEffects(effects)
  return true
}

function decideGate(instance, event, config, effects, diagnostics) {
  if (instance.state !== 'gate' && !(instance.state === 'accepted' && instance.gate)) return false
  const payload = event.payload || {}
  if (!instance.gate || instance.gate.id !== payload.gateId
      || instance.gate.revision !== payload.gateRevision) {
    diagnostics.push({ code: 'GATE_STALE' })
    return false
  }
  const reason = instance.gate.reason
  const available = GATE_OUTCOMES[reason] || []
  if (!available.includes(payload.outcome)) {
    diagnostics.push({ code: 'GATE_OUTCOME_UNAVAILABLE' })
    return false
  }
  const eventAt = event.at || at
  instance.roundsSinceHuman = 0
  instance.continuations = 0
  if (payload.outcome === 'reject-upstream') {
    rejectToUpstream(instance, effects)
    return true
  }
  voidGate(instance)
  if (reason === 'doc-new-version') {
    if (payload.outcome === 'accept') {
      instance.artifactVersions.push({
        id: `av-${instance.id}-${instance.artifactVersions.length + 1}`,
        commit: payload.candidateCommit || instance.candidate,
        candidateCommit: null,
        files: [],
        acceptedAt: eventAt,
        source: 'accepted-doc-change',
        decisionId: null,
      })
      instance.state = 'accepted'
      return true
    }
    instance.state = 'checking'
    addEffect(effects, 'drift-check')
    return true
  }
  if (payload.outcome === 'accept') {
    if (reason === 'drift') {
      instance.state = 'checking'
      addEffect(effects, 'drift-check')
    } else if (['needs-human', 'review-failed', 'rebuttal-rejected', 'round-limit',
      'artifact-unchanged', 'hard-gate-passed'].includes(reason)) {
      instance.state = 'accepting'
      acceptEffects(effects)
    } else {
      instance.state = 'submitted'
      addEffect(effects, 'snapshot', { phase: 'before' })
      addEffect(effects, 'evaluate-submission')
    }
    return true
  }
  if (reason === 'draft-question') instance.state = 'drafting'
  else instance.state = 'leading'
  return true
}

function handleInterject(instance, event, effects) {
  if (!['pending', 'checking', 'drafting', 'leading', 'submitted', 'reviewing'].includes(instance.state)) {
    return false
  }
  const eventAt = event.at || at
  instance.interjections.push({
    id: `interjection-${instance.interjections.length + 1}`,
    content: String(event.payload?.content || ''),
    status: instance.state === 'submitted' ? 'delivered' : 'queued',
    createdAt: eventAt,
    deliveredAt: instance.state === 'submitted' ? eventAt : null,
  })
  if (instance.state === 'submitted') {
    instance.state = 'leading'
    instance.roundsSinceHuman = 0
    instance.continuations = 0
  }
  return true
}

function handleStopAndDeliver(instance, event, effects) {
  if (!['drafting', 'leading', 'submitted', 'reviewing'].includes(instance.state)) return false
  const eventAt = event.at || at
  if (instance.state === 'submitted') {
    deliverInterjections(instance, eventAt)
    instance.state = 'leading'
    return true
  }
  addEffect(effects, 'cancel-invocation')
  instance.pendingStart = {
    kind: 'deliver-interjection',
    interjectionId: instance.interjections.find(item => item.status === 'queued')?.id || '',
    sessionGeneration: instance.sessionGeneration,
  }
  return true
}

function handleEvent(instance, event, config, effects, diagnostics) {
  const type = event?.type
  const eventAt = event?.at || at
  if (type === 'EFFECT_RESULT') {
    consumeEffect(instance, event.payload?.effectId, 'consumed', eventAt)
  } else if (type === 'EFFECT_FAILED') {
    consumeEffect(instance, event.payload?.effectId, 'failed', eventAt)
  } else if (type === 'RETRY_EFFECT' || type === 'RESTORED') {
    consumeEffect(instance, event.payload?.effectId, 'pending', eventAt)
  }
  if (type === 'DEPS_READY') {
    if (instance.state === 'pending') {
      instance.state = 'checking'
      addEffect(effects, 'drift-check')
      return true
    }
    if (instance.state === 'stale') {
      if (instance.activeInvocations.length > 0) {
        instance.pendingStart = {
          kind: 'invocation',
          effectId: `${instance.id}:pending`,
          role: 'lead',
          seatId: config?.checkpoint?.leadSeatId || '',
          round: instance.round,
          sessionGeneration: instance.sessionGeneration,
          claims: [],
        }
        return true
      }
      instance.sessionGeneration += 1
      instance.state = 'checking'
      addEffect(effects, 'drift-check')
      return true
    }
    return false
  }
  if (type === 'INVOCATION_ENDED') {
    return handleInvocationEnded(instance, event, config, effects, diagnostics)
  }
  if (type === 'EFFECT_RESULT') {
    const effectType = event.payload?.type
    if (effectType === 'drift-check' && instance.state === 'checking') {
      const clean = event.payload?.result?.clean !== false
      if (!clean) {
        openGate(instance, 'drift', eventAt)
        return true
      }
      if ((config?.checkpoint?.draftSeatIds || []).length > 0) {
        instance.state = 'drafting'
        addEffect(effects, 'acquire-scope')
        addEffect(effects, 'snapshot', { phase: 'before' })
        for (const seatId of config.checkpoint.draftSeatIds) {
          addEffect(effects, 'invoke-draft', {
            seatId,
            round: instance.round,
            sessionGeneration: instance.sessionGeneration,
          })
        }
      } else {
        instance.state = 'leading'
        addEffect(effects, 'acquire-scope')
        addEffect(effects, 'snapshot', { phase: 'before' })
        addEffect(effects, 'invoke-lead', {
      seatId: config?.checkpoint?.leadSeatId || '',
      round: instance.round,
      sessionGeneration: instance.sessionGeneration,
    })
      }
      return true
    }
    if (effectType === 'snapshot' && instance.state === 'submitted') {
      return handleSubmittedResult(instance, event, config, effects, diagnostics)
    }
    if (effectType === 'evaluate-submission') {
      return handleSubmittedResult(instance, event, config, effects, diagnostics)
    }
    if (effectType === 'verify-candidate') {
      return handleReviewingResult(instance, event, config, effects, diagnostics)
    }
    if (effectType === 'accept-commit' && instance.state === 'accepting') {
      instance.state = 'accepted'
      instance.artifactVersions.push({
        id: `av-${instance.id}-${instance.artifactVersions.length + 1}`,
        commit: event.payload?.result?.commit || instance.candidate || '0'.repeat(40),
        candidateCommit: instance.candidate,
        files: [],
        acceptedAt: eventAt,
        source: 'gate',
        decisionId: null,
      })
      return true
    }
    if ([
      'snapshot', 'write-review-file', 'append-decision', 'stamp-changes',
      'drop-snapshot-refs', 'notify', 'user-git-commit', 'append-message',
      'append-timeline',
    ].includes(effectType)) {
      return true
    }
    return false
  }
  if (type === 'GATE_DECIDED') {
    return decideGate(instance, event, config, effects, diagnostics)
  }
  if (type === 'ACCEPTED_DOC_CHANGED') {
    if (instance.state !== 'accepted') return false
    if (event.payload?.critical) {
      openGate(instance, 'doc-new-version', eventAt)
      instance.state = 'accepted'
      return true
    }
    instance.artifactVersions.push({
      id: `av-${instance.id}-${instance.artifactVersions.length + 1}`,
      commit: event.payload?.snapshot || instance.candidate || '0'.repeat(40),
      candidateCommit: null,
      files: [String(event.payload?.file || '')],
      acceptedAt: eventAt,
      source: 'accepted-doc-change',
      decisionId: null,
    })
    return true
  }
  if (type === 'REOPEN') {
    if (instance.state !== 'accepted') return false
    voidGate(instance)
    instance.epoch += 1
    instance.sessionGeneration += 1
    instance.state = 'checking'
    addEffect(effects, 'withdraw-lease')
    return true
  }
  if (type === 'UPSTREAM_REOPENED') {
    if (instance.state === 'accepting') return true
    if (!['pending', 'checking', 'submitted', 'gate', 'accepted',
      'drafting', 'leading', 'reviewing'].includes(instance.state)) return false
    if (['drafting', 'leading', 'reviewing'].includes(instance.state)) {
      addEffect(effects, 'cancel-invocation')
    }
    voidGate(instance)
    instance.epoch += 1
    instance.state = 'stale'
    addEffect(effects, 'withdraw-lease')
    return true
  }
  if (type === 'INTERJECT') return handleInterject(instance, event, effects)
  if (type === 'STOP_AND_DELIVER') return handleStopAndDeliver(instance, event, effects)
  if (type === 'EFFECT_FAILED') {
    instance.blockedOn = {
      effectId: String(event.payload?.effectId || ''),
      error: String(event.payload?.error || 'EFFECT_FAILED'),
      time: eventAt,
    }
    return true
  }
  if (type === 'RETRY_EFFECT' || type === 'RESTORED') {
    if (!instance.blockedOn) return false
    instance.blockedOn = null
    return true
  }
  if (type === 'UPSTREAM_BLOCKERS_CHANGED') {
    if (instance.gate?.reason === 'drift') {
      voidGate(instance)
      instance.state = 'checking'
      addEffect(effects, 'drift-check')
      return true
    }
    return false
  }
  if (type === 'LEASE_GRANTED') {
    const requestId = event.payload?.requestId
    const request = instance.leaseRequests.find(item => item.id === requestId)
    if (!request) return false
    request.status = 'granted'
    request.grantedAt = eventAt
    return true
  }
  return false
}

function transition(instance, event, config) {
  const next = structuredClone(instance)
  const effects = []
  const diagnostics = []
  const handled = handleEvent(next, event, config || {}, effects, diagnostics)
  if (!handled) {
    return {
      instance: structuredClone(instance),
      effects: [],
      diagnostics: diagnostics.length
        ? diagnostics
        : [{ code: 'EVENT_IGNORED', state: instance.state, event: event?.type || '' }],
    }
  }
  next.seq = instance.seq + 1
  const produced = effects.map((effect, index) => ({
    id: `${instance.id}:${next.seq}:${index}`,
    type: effect.type,
    category: effect.category,
    status: 'pending',
    epoch: next.epoch,
    params: effect.params || {},
    result: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  }))
  next.effects = [...next.effects, ...produced]
  const invocationRoles = {
    'invoke-lead': 'lead',
    'invoke-draft': 'draft',
    'invoke-reviewer': 'reviewer',
  }
  for (const effect of produced) {
    const role = invocationRoles[effect.type]
    if (!role) continue
    if (next.activeInvocations.some(item => item.effectId === effect.id)) continue
    const seatId = String(effect.params?.seatId || '')
    const seat = (config?.seats || []).find(item => item.id === seatId)
    next.activeInvocations.push({
      effectId: effect.id,
      role,
      seatId,
      agentKind: seat?.agentKind || 'codex',
      round: next.round,
      sessionGeneration: next.sessionGeneration,
      claims: [],
      cancellationRequested: false,
      processRegistryId: null,
    })
  }
  for (const effect of produced) {
    if (effect.type !== 'acquire-scope') continue
    if (next.leaseRequests.some(request => request.id === effect.id)) continue
    next.leaseRequests.push({
      id: effect.id,
      holder: {
        kind: 'checkpoint-scope',
        projectId: String(config?.projectId || 'project-1'),
        ownerId: instance.id,
      },
      chainEffectId: effect.id,
      claims: Array.isArray(effect.params?.claims) ? effect.params.claims : [],
      epoch: next.epoch,
      requestedAt: event?.at || at,
      status: 'waiting',
      grantedAt: null,
      releasedAt: null,
    })
  }
  return { instance: next, effects: produced, diagnostics }
}

module.exports = { transition }
