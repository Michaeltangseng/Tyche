const MAX_REVIEW_SUMMARIES = 16
const MAX_CHANGED_FILES = 200
const MAX_SOFT_GATE_ENTRIES = 100
const MAX_SIGNALS = 16

function signal(kind, { checkpointId = null, count = null } = {}) {
  return { kind, checkpointId, count }
}

function timestampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function upstreamIds(state, instance, def) {
  const ids = new Set(Object.keys(instance.readVersions || {}))
  for (const key of def?.dependsOn || []) {
    const upstream = (state.instances || []).find(item => (
      item.checkpointKey === key && item.state === 'accepted'
    ))
    if (upstream) ids.add(upstream.id)
  }
  return ids
}

function sameAgentKind(state, def) {
  const seats = state?.config?.seats || []
  const lead = seats.find(seat => seat.id === def?.leadSeatId)
  if (!lead) return false
  return (def?.reviewerSeatIds || []).some((seatId) => {
    const reviewer = seats.find(seat => seat.id === seatId)
    return reviewer?.agentKind === lead.agentKind
  })
}

function reviewSummaries(round) {
  return (round?.reviews || []).slice(0, MAX_REVIEW_SUMMARIES).map(review => ({
    seatId: review.seatId,
    verdict: review.verdict,
    summary: String(review.summary || ''),
    reviewFile: review.reviewFile,
  }))
}

function softGateSummary(state, instance) {
  const defs = state?.config?.playbook?.checkpointDefs || []
  const currentIndex = defs.findIndex(def => def.key === instance.checkpointKey)
  const limit = currentIndex < 0 ? defs.length : currentIndex
  const entries = []
  for (const def of defs.slice(0, limit)) {
    if (def.gate !== 'soft') continue
    const accepted = (state.instances || []).find(item => (
      item.checkpointKey === def.key && item.state === 'accepted'
    ))
    if (!accepted) continue
    entries.push({
      checkpointId: accepted.id,
      name: def.name,
      rounds: accepted.round,
      signals: accepted.lastGateSignals || [],
    })
  }
  return entries.slice(0, MAX_SOFT_GATE_ENTRIES)
}

function changedFileEntry(file) {
  return {
    path: String(file?.path || ''),
    added: Number.isFinite(file?.added) ? file.added : 0,
    removed: Number.isFinite(file?.removed) ? file.removed : 0,
    binary: file?.binary === true,
  }
}

function buildGateScreen({
  state,
  instance,
  def,
  gate,
  changedFiles = [],
  now = Date.now(),
}) {
  const previous = gate?.firstScreen || {}
  const round = (instance.rounds || []).find(item => (
    item.round === Math.max(1, instance.round)
  )) || null
  const upstream = upstreamIds(state, instance, def)
  const driftItems = (state?.driftItems || []).filter(item => (
    (item.status === 'unresolved' || item.status === 'resolving')
      && upstream.has(item.checkpointId)
  ))
  const ownDrift = (state?.driftItems || []).filter(item => (
    (item.status === 'unresolved' || item.status === 'resolving')
      && item.checkpointId === instance.id
  ))
  const outOfScope = (state?.outOfScopeItems || []).filter(item => (
    item.status === 'unresolved'
      && item.effectId
      && (instance.effects || []).some(effect => effect.id === item.effectId)
  ))
  const pendingVersions = (state?.instances || []).filter(item => (
    upstream.has(item.id) && item.gate?.reason === 'doc-new-version'
  ))

  const signals = []
  if (pendingVersions.length) {
    signals.push(signal('upstream-pending-version', {
      checkpointId: pendingVersions[0].id,
      count: pendingVersions.length,
    }))
  }
  if (driftItems.length) {
    signals.push(signal('upstream-drift', {
      checkpointId: driftItems[0].checkpointId,
      count: driftItems.length,
    }))
  }
  if (previous.candidateDiverged === true) signals.push(signal('candidate-diverged'))
  if (outOfScope.length) signals.push(signal('out-of-scope', { count: outOfScope.length }))
  if (previous.changesHeaderMissing === true) signals.push(signal('changes-header-missing'))
  if (previous.detectionSkipped === true) signals.push(signal('detection-skipped'))
  if (sameAgentKind(state, def)) signals.push(signal('same-agent-kind'))
  if (gate?.reason === 'round-limit') signals.push(signal('round-limit'))
  if (gate?.reason === 'artifact-unchanged') signals.push(signal('artifact-unchanged'))
  if (round?.rebuttal === true) signals.push(signal('rebuttal'))

  const blockers = new Set()
  for (const item of pendingVersions) blockers.add(item.id)
  for (const item of driftItems) if (item.checkpointId) blockers.add(item.checkpointId)

  const startedAt = timestampMs(round?.startedAt)
  return {
    round: Number.isSafeInteger(instance.round) ? instance.round : 0,
    elapsedMs: startedAt ? Math.max(0, now - startedAt) : 0,
    signals: signals.slice(0, MAX_SIGNALS),
    reviewSummaries: reviewSummaries(round),
    changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES).map(changedFileEntry),
    softGateSummary: softGateSummary(state, instance),
    driftItemIds: ownDrift.map(item => item.id),
    outOfScopeItemIds: outOfScope.map(item => item.id),
    blockerCheckpointIds: [...blockers],
    changesHeaderMissing: previous.changesHeaderMissing === true,
    detectionSkipped: previous.detectionSkipped === true,
    candidateDiverged: previous.candidateDiverged === true,
  }
}

module.exports = {
  buildGateScreen,
}
