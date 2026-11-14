const path = require('node:path')
const { allowedGateOutcomes } = require('./checkpoint-transitions.cjs')
const { acceptanceBlockers } = require('./project-progress.cjs')

const MAX_PENDING_DECISIONS = 100
const MAX_SIGNALS = 4
const MAX_REVIEW_SUMMARIES = 2
const MAX_REVIEW_SUMMARY_LINES = 4
const MAX_CHANGED_FILES = 6
const MAX_SOFT_GATE_ENTRIES = 5
const MAX_ITEM_IDS = 100

const SIGNAL_ORDER = [
  'upstream-pending-version',
  'upstream-drift',
  'candidate-diverged',
  'out-of-scope',
  'changes-header-missing',
  'detection-skipped',
  'same-agent-kind',
  'round-limit',
  'artifact-unchanged',
  'rebuttal',
]
const VERDICT_ORDER = ['needs-human', 'revise', 'missing', 'failed', 'pass', 'cancelled']

function timestampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function displayName(workdir) {
  const resolved = path.resolve(String(workdir || ''))
  return path.basename(resolved) || resolved
}

function checkpointName(state, key) {
  const def = state?.config?.playbook?.checkpointDefs?.find(item => item.key === key)
  return def?.name || key
}

function currentProfile(state, seat) {
  return state?.config?.profiles?.find(profile => (
    profile.id === seat.profileVersionId && profile.seatId === seat.id
  )) || null
}

function unresolvedDrift(state) {
  return (state?.driftItems || []).filter(item => item.status === 'unresolved')
}

function deletingState(projectRecord, state) {
  const deletion = state?.deletion
  if (deletion) {
    return {
      phase: deletion.phase,
      startedAt: deletion.startedAt,
      requestedAt: projectRecord?.deleting?.requestedAt ?? null,
      keepChats: projectRecord?.deleting?.keepChats === true,
    }
  }
  if (projectRecord?.deleting) {
    return {
      phase: null,
      startedAt: null,
      requestedAt: projectRecord.deleting.requestedAt ?? null,
      keepChats: projectRecord.deleting.keepChats === true,
    }
  }
  return null
}

function sanitizedResiduals(projectRecord) {
  return (Array.isArray(projectRecord?.residuals) ? projectRecord.residuals : [])
    .map(residual => ({
      residualId: String(residual?.residualId || residual?.id || ''),
      pid: Number.isSafeInteger(residual?.pid) ? residual.pid : null,
      startedAt: residual?.startedAt ?? null,
      agentKind: typeof residual?.agentKind === 'string' ? residual.agentKind : '',
      programName: typeof residual?.programName === 'string' ? residual.programName : '',
      containerMarked: residual?.containerMarked === true,
    }))
    .filter(residual => residual.residualId)
}

function isReadOnly(projectRecord, state) {
  return projectRecord?.readOnly === true || !state
}

function sidebarEntry(projectRecord, state) {
  const pendingGates = (state?.instances || []).filter(instance => instance.gate).length
  return {
    projectId: String(projectRecord?.id || ''),
    name: String(projectRecord?.name || ''),
    displayName: displayName(projectRecord?.workdir),
    readOnly: isReadOnly(projectRecord, state),
    readOnlyReason: isReadOnly(projectRecord, state)
      ? String(projectRecord?.readOnlyReason || (!state ? 'state-unavailable' : 'read-only'))
      : '',
    deleting: deletingState(projectRecord, state),
    pendingGateCount: pendingGates,
    unresolvedDriftCount: unresolvedDrift(state).length,
    residualCount: sanitizedResiduals(projectRecord).length,
  }
}

function waitingOn(instance) {
  if (instance.gate) return 'human'
  if (instance.blockedOn) return 'retry'
  if (instance.activeInvocations.length) {
    const roles = new Set(instance.activeInvocations.map(invocation => invocation.role))
    if (roles.has('lead')) return 'lead'
    if (roles.has('reviewer')) return 'reviewers'
    if (roles.has('draft')) return 'drafts'
  }
  switch (instance.state) {
    case 'pending': return 'upstream'
    case 'checking': return 'drift-check'
    case 'submitted': return 'candidate'
    case 'accepting': return 'accepting'
    case 'stale': return 'upstream'
    case 'accepted': return 'none'
    default: return 'none'
  }
}

function progressEntry(state, instance) {
  const def = state?.config?.playbook?.checkpointDefs?.find(item => item.key === instance.checkpointKey)
  const leadSeatId = def?.leadSeatId || ''
  const leadSeat = state?.config?.seats?.find(seat => seat.id === leadSeatId)
  return {
    checkpointId: instance.id,
    checkpointKey: instance.checkpointKey,
    name: def?.name || instance.checkpointKey,
    state: instance.state,
    round: instance.round,
    roundsSinceHuman: instance.roundsSinceHuman,
    leadSeatId,
    leadSeatName: leadSeat?.roleName || '',
    reviewerSeatIds: def?.reviewerSeatIds || [],
    waitingOn: waitingOn(instance),
    hasGate: Boolean(instance.gate),
    blocked: Boolean(instance.blockedOn),
    generation: instance.sessionGeneration,
    pendingInterjections: (instance.interjections || [])
      .filter(item => item.status === 'queued')
      .slice(0, 20)
      .map(item => ({
        id: item.id,
        content: item.content,
        createdAt: item.createdAt,
      })),
    acceptedVersion: instance.artifactVersions.at(-1)
      ? {
        id: instance.artifactVersions.at(-1).id,
        commit: instance.artifactVersions.at(-1).commit,
        files: [...(instance.artifactVersions.at(-1).files || [])],
        acceptedAt: instance.artifactVersions.at(-1).acceptedAt,
        source: instance.artifactVersions.at(-1).source,
      }
      : null,
    hasPendingVersion: instance.gate?.reason === 'doc-new-version',
  }
}

function signalSort(left, right) {
  const leftIndex = SIGNAL_ORDER.indexOf(left?.kind)
  const rightIndex = SIGNAL_ORDER.indexOf(right?.kind)
  return (leftIndex < 0 ? SIGNAL_ORDER.length : leftIndex)
    - (rightIndex < 0 ? SIGNAL_ORDER.length : rightIndex)
}

function reviewSummarySort(left, right) {
  const leftIndex = VERDICT_ORDER.indexOf(left?.verdict)
  const rightIndex = VERDICT_ORDER.indexOf(right?.verdict)
  return (leftIndex < 0 ? VERDICT_ORDER.length : leftIndex)
    - (rightIndex < 0 ? VERDICT_ORDER.length : rightIndex)
}

function boundedReviewSummary(summary) {
  const lines = String(summary?.summary || '').split('\n').slice(0, MAX_REVIEW_SUMMARY_LINES)
  return {
    seatId: String(summary?.seatId || ''),
    verdict: String(summary?.verdict || ''),
    summary: lines.join('\n'),
    reviewFile: String(summary?.reviewFile || ''),
  }
}

function gateProjection(instance, state) {
  const gate = instance.gate
  if (!gate) return null
  const screen = gate.firstScreen
  const signals = [...screen.signals].sort(signalSort).slice(0, MAX_SIGNALS)
  const reviewSummaries = [...screen.reviewSummaries]
    .sort(reviewSummarySort)
    .slice(0, MAX_REVIEW_SUMMARIES)
    .map(boundedReviewSummary)
  const changedFiles = [...screen.changedFiles]
    .sort((left, right) => (right.added + right.removed) - (left.added + left.removed))
    .slice(0, MAX_CHANGED_FILES)
  const softGateSummary = screen.softGateSummary
    .filter(entry => entry.signals.length > 0)
    .slice(0, MAX_SOFT_GATE_ENTRIES)
  return {
    checkpointId: instance.id,
    gateId: gate.id,
    revision: gate.revision,
    reason: gate.reason,
    allowedOutcomes: allowedGateOutcomes(gate.reason),
    acceptBlockers: state ? acceptanceBlockers(state, instance.id).blockers : [],
    candidateCommit: gate.candidateCommit,
    createdAt: gate.createdAt,
    round: screen.round,
    elapsedMs: screen.elapsedMs,
    signals,
    signalCount: screen.signals.length,
    reviewSummaries,
    reviewSummaryCount: screen.reviewSummaries.length,
    changedFiles,
    changedFileCount: screen.changedFiles.length,
    softGateSummary,
    softGateCount: screen.softGateSummary.length,
    driftItemIds: screen.driftItemIds.slice(0, MAX_ITEM_IDS),
    outOfScopeItemIds: screen.outOfScopeItemIds.slice(0, MAX_ITEM_IDS),
    blockerCheckpointIds: screen.blockerCheckpointIds.slice(0, MAX_ITEM_IDS),
    changesHeaderMissing: screen.changesHeaderMissing === true,
    detectionSkipped: screen.detectionSkipped === true,
    candidateDiverged: screen.candidateDiverged === true,
  }
}

function driftProjection(state, item) {
  const placeholder = (state?.placeholders || [])
    .find(entry => entry.path === item.path) || null
  return {
    id: item.id,
    revision: item.revision,
    path: item.path,
    checkpointId: item.checkpointId,
    checkpointName: checkpointName(state, instanceKey(state, item.checkpointId)),
    baseVersionId: item.baseVersionId,
    acceptedCommit: item.acceptedCommit,
    observedCommit: item.observedCommit,
    foundAt: item.foundAt,
    source: item.source,
    status: item.status,
    placeholder: placeholder ? placeholder.reason : null,
    restorable: !placeholder,
  }
}

function instanceKey(state, instanceId) {
  return state?.instances?.find(instance => instance.id === instanceId)?.checkpointKey || ''
}

function outOfScopeProjection(item) {
  return {
    id: item.id,
    path: item.path,
    attribution: item.attribution,
    effectId: item.effectId,
    overlappingEffectIds: [...item.overlappingEffectIds],
    detectedAt: item.detectedAt,
    status: item.status,
  }
}

function errorBar(projectRecord, state) {
  if (projectRecord?.storageFault) {
    return {
      scope: 'project',
      checkpointId: null,
      effectId: null,
      error: 'PROJECT_STORAGE_FAULT',
      time: projectRecord.storageFault.time ?? null,
      retryable: false,
    }
  }
  if (state?.projectBlockedOn) {
    return {
      scope: 'project',
      checkpointId: null,
      effectId: state.projectBlockedOn.effectId,
      error: String(state.projectBlockedOn.error || 'PROJECT_STORAGE_FAULT'),
      time: state.projectBlockedOn.time,
      retryable: true,
    }
  }
  const blocked = (state?.instances || []).find(instance => instance.blockedOn)
  if (blocked) {
    return {
      scope: 'instance',
      checkpointId: blocked.id,
      effectId: blocked.blockedOn.effectId,
      error: String(blocked.blockedOn.error || 'PROJECT_STORAGE_FAULT'),
      time: blocked.blockedOn.time,
      retryable: true,
    }
  }
  return null
}

function configProjection(state) {
  if (!state) return null
  return {
    configRevision: state.config.configRevision,
    seats: state.config.seats.map((seat) => {
      const profile = currentProfile(state, seat)
      return {
        id: seat.id,
        roleName: seat.roleName,
        duty: seat.duty,
        agentKind: seat.agentKind,
        capabilities: [...seat.capabilities],
        checkpointRoles: seat.checkpointRoles.map(role => ({
          checkpointKey: role.checkpointKey,
          role: role.role,
        })),
        profile: profile
          ? { id: profile.id, version: profile.version, text: profile.text }
          : null,
        profileVersions: state.config.profiles
          .filter(item => item.seatId === seat.id)
          .sort((left, right) => left.version - right.version)
          .map(item => ({
            id: item.id,
            version: item.version,
            createdAt: item.createdAt,
            source: item.source,
          })),
      }
    }),
    playbook: {
      templateId: state.config.playbook.templateId,
      templateVersion: state.config.playbook.templateVersion,
      checkpointDefs: state.config.playbook.checkpointDefs.map(def => ({
        key: def.key,
        name: def.name,
        type: def.type,
        targetFiles: [...def.targetFiles],
        leadSeatId: def.leadSeatId,
        reviewerSeatIds: [...def.reviewerSeatIds],
        draftSeatIds: [...def.draftSeatIds],
        gate: def.gate,
        roundLimit: def.roundLimit,
        continuationLimit: def.continuationLimit,
        producesChecklist: def.producesChecklist,
        dependsOn: [...def.dependsOn],
      })),
      roundLimit: state.config.playbook.roundLimit,
      continuationLimit: state.config.playbook.continuationLimit,
    },
    settings: {
      docsRoot: state.config.settings.docsRoot,
      language: state.config.settings.language,
      snapshotLimits: { ...state.config.settings.snapshotLimits },
      excludedRepos: [...state.config.settings.excludedRepos],
    },
  }
}

function projectSnapshot(projectRecord, state) {
  const readOnly = isReadOnly(projectRecord, state)
  return {
    projectId: String(projectRecord?.id || ''),
    name: String(projectRecord?.name || ''),
    workdir: String(projectRecord?.workdir || ''),
    revision: Number.isSafeInteger(state?.revision) ? state.revision : 0,
    readOnly,
    readOnlyReason: readOnly
      ? String(projectRecord?.readOnlyReason || (!state ? 'state-unavailable' : 'read-only'))
      : '',
    deleting: deletingState(projectRecord, state),
    progress: (state?.instances || []).map(instance => progressEntry(state, instance)),
    gates: (state?.instances || [])
      .map(instance => gateProjection(instance, state))
      .filter(Boolean)
      .slice(0, 32),
    driftItems: unresolvedDrift(state).map(item => driftProjection(state, item)),
    outOfScopeItems: (state?.outOfScopeItems || [])
      .filter(item => item.status === 'unresolved')
      .map(outOfScopeProjection),
    errorBar: errorBar(projectRecord, state),
    residuals: sanitizedResiduals(projectRecord),
    config: configProjection(state),
    preferences: state?.preferences ? { ...state.preferences } : {},
  }
}

function decisionItem(entry, type, source) {
  return {
    type,
    projectId: String(entry.project?.id || ''),
    projectName: String(entry.project?.name || ''),
    checkpointId: source.checkpointId ?? null,
    checkpointName: source.checkpointName ?? '',
    reason: source.reason ?? '',
    itemId: source.itemId ?? '',
    waitingSince: source.waitingSince ?? null,
    waitingMs: source.waitingMs ?? 0,
  }
}

function pendingDecisions(allProjects, now = Date.now()) {
  const items = []
  for (const entry of Array.isArray(allProjects) ? allProjects : []) {
    const state = entry?.state || null
    if (state) {
      for (const instance of state.instances) {
        if (instance.gate) {
          const since = timestampMs(instance.gate.createdAt)
          items.push(decisionItem(entry, 'gate', {
            checkpointId: instance.id,
            checkpointName: checkpointName(state, instance.checkpointKey),
            reason: instance.gate.reason,
            itemId: instance.gate.id,
            waitingSince: instance.gate.createdAt,
            waitingMs: since === null ? 0 : Math.max(0, now - since),
          }))
        }
        if (instance.blockedOn) {
          const since = timestampMs(instance.blockedOn.time)
          items.push(decisionItem(entry, 'suspended', {
            checkpointId: instance.id,
            checkpointName: checkpointName(state, instance.checkpointKey),
            reason: 'suspended',
            itemId: instance.blockedOn.effectId,
            waitingSince: instance.blockedOn.time,
            waitingMs: since === null ? 0 : Math.max(0, now - since),
          }))
        }
      }
      for (const item of unresolvedDrift(state)) {
        const since = timestampMs(item.foundAt)
        items.push(decisionItem(entry, 'drift', {
          checkpointId: item.checkpointId,
          checkpointName: checkpointName(state, instanceKey(state, item.checkpointId)),
          reason: 'drift',
          itemId: item.id,
          waitingSince: item.foundAt,
          waitingMs: since === null ? 0 : Math.max(0, now - since),
        }))
      }
      if (state.projectBlockedOn) {
        const since = timestampMs(state.projectBlockedOn.time)
        items.push(decisionItem(entry, 'suspended', {
          checkpointId: null,
          checkpointName: '',
          reason: 'suspended',
          itemId: state.projectBlockedOn.effectId,
          waitingSince: state.projectBlockedOn.time,
          waitingMs: since === null ? 0 : Math.max(0, now - since),
        }))
      }
    }
    for (const residual of sanitizedResiduals(entry?.project)) {
      const since = timestampMs(residual.startedAt)
      items.push(decisionItem(entry, 'residual', {
        checkpointId: null,
        checkpointName: '',
        reason: 'residual',
        itemId: residual.residualId,
        waitingSince: residual.startedAt,
        waitingMs: since === null ? 0 : Math.max(0, now - since),
      }))
    }
  }
  items.sort((left, right) => (
    right.waitingMs - left.waitingMs
      || left.projectId.localeCompare(right.projectId)
      || left.itemId.localeCompare(right.itemId)
  ))
  return {
    items: items.slice(0, MAX_PENDING_DECISIONS),
    total: items.length,
  }
}

module.exports = {
  pendingDecisions,
  projectSnapshot,
  sidebarEntry,
}
