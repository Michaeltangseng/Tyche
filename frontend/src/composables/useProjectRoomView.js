import { computed, ref, watch } from 'vue'
import { errorCode } from '../desktop.js'
import { useProjectRoom } from './useProjectRoom.js'

const STATE_LABELS = {
  pending: 'projectRoom.state.pending',
  checking: 'projectRoom.state.checking',
  drafting: 'projectRoom.state.drafting',
  leading: 'projectRoom.state.leading',
  submitted: 'projectRoom.state.submitted',
  reviewing: 'projectRoom.state.reviewing',
  gate: 'projectRoom.state.gate',
  accepting: 'projectRoom.state.accepting',
  accepted: 'projectRoom.state.accepted',
  stale: 'projectRoom.state.stale',
}

const STATE_GLYPHS = {
  pending: '○',
  checking: '◌',
  drafting: '✎',
  leading: '▶',
  submitted: '⇧',
  reviewing: '◉',
  gate: '!',
  accepting: '…',
  accepted: '✓',
  stale: '↻',
}

const ACTIVE_STATES = new Set([
  'checking', 'drafting', 'leading', 'submitted', 'reviewing', 'accepting',
])

const SEND_ERROR_KEYS = {
  PROJECT_TARGET_CHANGED: 'projectRoom.composer.errors.targetChanged',
  PROJECT_GATE_STALE: 'projectRoom.composer.errors.gateStale',
  PROJECT_GATE_OUTCOME_UNAVAILABLE: 'projectRoom.composer.errors.outcomeUnavailable',
  PROJECT_GATE_COMMENT_REQUIRED: 'projectRoom.composer.errors.commentRequired',
  PROJECT_INPUT_INVALID: 'projectRoom.composer.errors.invalid',
  PROJECT_NOT_FOUND: 'projectRoom.composer.errors.notFound',
  PROJECT_READ_ONLY: 'projectRoom.composer.errors.readOnly',
  PROJECT_DELETING: 'projectRoom.composer.errors.deleting',
  PROJECT_ROOM_DISABLED: 'projectRoom.composer.errors.disabled',
}

function timestampMs(value) {
  if (Number.isFinite(value)) return Number(value)
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function newest(values) {
  return values.reduce((latest, value) => Math.max(latest, value), 0) || null
}

export function useProjectRoomView({
  activeGroup,
  formatNavTime = () => '',
  normalizeSnapshot,
  now = () => Date.now(),
  projectTarget = ref(null),
  room = null,
  selectGroup,
  showError = () => {},
  snapshot,
  sortByUpdated = () => 0,
  t,
  workspace,
}) {
  const projectRoom = room || useProjectRoom()
  const project = projectRoom.project
  const projectId = computed(() => activeGroup.value?.projectId || '')
  const isMainGroup = computed(() => (
    activeGroup.value?.projectRole === 'main' && Boolean(projectId.value)
  ))

  const activeTargetId = ref('')
  const draft = ref('')
  const sendErrorKey = ref('')
  const reopenRequest = ref(null)
  const drafts = new Map()

  const progress = computed(() => (
    Array.isArray(project.value?.progress) ? project.value.progress : []
  ))
  const gates = computed(() => (
    Array.isArray(project.value?.gates) ? project.value.gates : []
  ))
  const projectStarted = computed(() => progress.value.length > 0)
  const projectUnavailable = computed(() => (
    Boolean(project.value?.readOnly || project.value?.deleting)
  ))
  const projectName = computed(() => String(project.value?.name || activeGroup.value?.name || ''))
  const workdirName = computed(() => {
    const workdir = String(project.value?.workdir || activeGroup.value?.workdir || '')
    return workdir.split(/[\\/]/).filter(Boolean).at(-1) || ''
  })
  const driftItems = computed(() => project.value?.driftItems || [])
  const outOfScopeItems = computed(() => project.value?.outOfScopeItems || [])
  const residuals = computed(() => project.value?.residuals || [])
  const errorBar = computed(() => project.value?.errorBar || null)
  const diagnostics = ref(null)
  const selectedDiff = ref(null)
  const statusErrorKey = ref('')
  const timelineHistory = ref({ items: [], total: 0, nextCursor: null })
  const timelineLoading = ref(false)
  let timelineRequest = 0

  async function loadTimelineHistory({ reset = false } = {}) {
    if (!projectId.value) return null
    if (timelineLoading.value) return null
    const cursor = reset ? undefined : (timelineHistory.value.nextCursor || undefined)
    if (!reset && !cursor) return timelineHistory.value
    const request = ++timelineRequest
    timelineLoading.value = true
    try {
      const page = await projectRoom.timelineHistory({
        projectId: projectId.value,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      })
      if (request !== timelineRequest) return null
      const items = reset
        ? (page.items || [])
        : [...(page.items || []), ...(timelineHistory.value.items || [])]
      const byId = new Map(items.map(item => [item.id, item]))
      const merged = [...byId.values()].sort((left, right) => (
        timestampValue(left.at) - timestampValue(right.at) || String(left.id).localeCompare(String(right.id))
      ))
      timelineHistory.value = {
        items: merged,
        total: Number.isSafeInteger(page.total) ? page.total : merged.length,
        nextCursor: page.nextCursor || null,
      }
      return timelineHistory.value
    } catch (error) {
      statusErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      return null
    } finally {
      timelineLoading.value = false
    }
  }

  function timestampValue(value) {
    if (Number.isFinite(value)) return Number(value)
    const parsed = Date.parse(String(value || ''))
    return Number.isFinite(parsed) ? parsed : 0
  }

  const projectTimelineCards = computed(() => {
    const defs = new Map((project.value?.config?.playbook?.checkpointDefs || [])
      .map(def => [def.key, def]))
    const progressByKey = new Map()
    for (const item of progress.value) {
      if (!item.checkpointKey) continue
      if (!progressByKey.has(item.checkpointKey)) progressByKey.set(item.checkpointKey, item)
    }
    const cards = []
    const seen = new Set()
    const push = (card) => {
      if (!card?.id || seen.has(card.id)) return
      seen.add(card.id)
      cards.push(card)
    }
    for (const record of timelineHistory.value.items || []) {
      const progressItem = progress.value.find(item => item.checkpointId === record.checkpointId)
      const def = defs.get(record.checkpointKey)
      const name = def?.name || progressItem?.name || record.checkpointKey || record.checkpointId
      if (record.type === 'checkpoint-start' || record.type === 'checkpoint-reopen') {
        push({
          id: record.id,
          kind: 'checkpoint',
          at: record.at,
          checkpointId: record.checkpointId,
          generation: record.generation,
          name,
          reopened: record.type === 'checkpoint-reopen',
          reason: record.reason || '',
        })
      } else if (record.type === 'gate-decided') {
        push({
          id: record.id,
          kind: 'gate-decided',
          at: record.at,
          checkpointId: record.checkpointId,
          generation: record.generation,
          name,
          gateId: record.gateId,
          gateRevision: record.gateRevision,
          reason: record.reason || '',
          outcome: record.outcome || '',
          comment: record.comment || '',
        })
      } else if (record.type === 'gate-voided') {
        push({
          id: record.id,
          kind: 'gate-voided',
          at: record.at,
          checkpointId: record.checkpointId,
          generation: record.generation,
          name,
          reason: record.reason || '',
        })
      }
    }
    for (const gate of gates.value) {
      push({
        id: `gate:${gate.gateId}:${gate.revision}`,
        kind: 'gate',
        at: gate.createdAt,
        checkpointId: gate.checkpointId,
        name: progress.value.find(item => item.id === gate.checkpointId)?.name || gate.checkpointId,
        gateId: gate.gateId,
        gateRevision: gate.revision,
        reason: gate.reason,
      })
    }
    for (const item of progress.value) {
      for (const interjection of item.pendingInterjections || []) {
        push({
          id: `interjection:${item.id}:${interjection.id}`,
          kind: 'interjection',
          at: interjection.createdAt,
          checkpointId: item.id,
          name: item.name,
          content: interjection.content,
        })
      }
      if (['checking', 'drafting', 'leading', 'submitted', 'reviewing', 'accepting']
        .includes(item.state)) {
        push({
          id: `run:${item.id}:${item.generation}:${item.state}`,
          kind: 'running',
          at: null,
          checkpointId: item.id,
          name: item.name,
          state: item.state,
          waitingOn: item.waitingOn,
          generation: item.generation,
        })
      }
    }
    return cards.sort((left, right) => {
      if (left.kind === 'running' && right.kind !== 'running') return 1
      if (right.kind === 'running' && left.kind !== 'running') return -1
      return timestampValue(left.at) - timestampValue(right.at)
        || String(left.id).localeCompare(String(right.id))
    })
  })

  const projectRoomCardMessages = computed(() => projectTimelineCards.value.map(card => ({
    id: `project-card-${card.id}`,
    role: 'system',
    createdAt: card.kind === 'running' ? 8640000000000000 : (card.at || 0),
    projectRoomCard: card,
  })))

  const projectRoomCurrentGenerations = computed(() => {
    const generations = {}
    for (const item of progress.value) {
      if (!item.checkpointId) continue
      generations[item.checkpointId] = Number.isSafeInteger(item.generation)
        ? item.generation
        : 0
    }
    return generations
  })

  function isArchivedProjectMessage(message) {
    const checkpointId = String(message?.projectRoom?.checkpointId || '')
    const generation = Number(message?.projectRoom?.generation)
    if (!checkpointId || !Number.isSafeInteger(generation)) return false
    const current = projectRoomCurrentGenerations.value[checkpointId]
    return Number.isSafeInteger(current) && generation < current
  }

  function archivedGenerationLabel(message) {
    const generation = Number(message?.projectRoom?.generation)
    return t('projectRoom.timeline.previousRun', {
      count: Number.isSafeInteger(generation) ? generation + 1 : 1,
    })
  }

  async function stopAndDeliver(checkpointId) {
    if (!projectId.value || !checkpointId) return false
    statusErrorKey.value = ''
    try {
      await projectRoom.stopAndDeliver({ projectId: projectId.value, checkpointId })
      await projectRoom.refresh()
      return true
    } catch (error) {
      statusErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      showError(error)
      return false
    }
  }

  async function resolveDriftItems(itemIds, choice) {
    const ids = new Set(Array.isArray(itemIds) ? itemIds : [])
    const items = driftItems.value
      .filter(item => ids.has(item.id))
      .map(item => ({ itemId: item.id, revision: item.revision }))
    if (!items.length) return false
    statusErrorKey.value = ''
    try {
      await projectRoom.resolveDrift({ projectId: projectId.value, items, choice })
      await projectRoom.refresh()
      return true
    } catch (error) {
      statusErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      showError(error)
      return false
    }
  }

  async function cancelDriftResolution(itemId) {
    const item = driftItems.value.find(entry => entry.id === itemId)
    if (!item) return false
    statusErrorKey.value = ''
    try {
      await projectRoom.cancelDriftResolution({
        projectId: projectId.value,
        itemId: item.id,
        revision: item.revision,
      })
      await projectRoom.refresh()
      return true
    } catch (error) {
      statusErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      showError(error)
      return false
    }
  }

  async function resolveOutOfScopeItems(itemIds) {
    const ids = Array.isArray(itemIds) ? itemIds : []
    if (!ids.length) return false
    statusErrorKey.value = ''
    try {
      await projectRoom.resolveOutOfScope({ projectId: projectId.value, itemIds: ids })
      await projectRoom.refresh()
      return true
    } catch (error) {
      statusErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      showError(error)
      return false
    }
  }

  async function retryProjectError() {
    const bar = errorBar.value
    if (!bar?.retryable || !bar.effectId) return false
    statusErrorKey.value = ''
    try {
      const input = { projectId: projectId.value, effectId: bar.effectId }
      if (bar.scope === 'instance' && bar.checkpointId) input.checkpointId = bar.checkpointId
      await projectRoom.retryEffect(input)
      await projectRoom.refresh()
      return true
    } catch (error) {
      statusErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      showError(error)
      return false
    }
  }

  async function compactProject() {
    statusErrorKey.value = ''
    try {
      const result = await projectRoom.compact({ projectId: projectId.value })
      await projectRoom.refresh()
      return result
    } catch (error) {
      statusErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      showError(error)
      return null
    }
  }

  async function loadDiagnostics() {
    statusErrorKey.value = ''
    try {
      diagnostics.value = await projectRoom.diagnostics({ projectId: projectId.value })
      return diagnostics.value
    } catch (error) {
      statusErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      showError(error)
      return null
    }
  }

  async function resolveResidual(residualId, action) {
    if (!residualId || !['manuallyEnded', 'notRelated'].includes(action)) return false
    statusErrorKey.value = ''
    try {
      await projectRoom.residual({ projectId: projectId.value, residualId, action })
      await projectRoom.refresh()
      return true
    } catch (error) {
      statusErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      showError(error)
      return false
    }
  }

  function openDriftDiff(item) {
    if (!item) return
    selectedDiff.value = {
      path: item.path,
      observedCommit: item.observedCommit,
      acceptedCommit: item.acceptedCommit,
    }
  }

  function checkpointActivityAt(checkpointId) {
    const groupId = activeGroup.value?.id
    if (!groupId) return null
    return newest((snapshot.value.messages || [])
      .filter(message => (
        message.groupId === groupId
          && String(message.projectRoom?.checkpointId || '') === String(checkpointId || '')
      ))
      .map(message => timestampMs(message.createdAt))
      .filter(Boolean))
  }

  const lastActivityAt = computed(() => {
    const groupId = activeGroup.value?.id
    if (!groupId) return null
    return newest((snapshot.value.messages || [])
      .filter(message => message.groupId === groupId)
      .map(message => timestampMs(message.createdAt))
      .filter(Boolean))
  })
  const lastActivityLabel = computed(() => (
    lastActivityAt.value ? formatNavTime(lastActivityAt.value) : ''
  ))

  function elapsedLabel(entry) {
    if (!entry.lastActivityAt) return ''
    const minutes = Math.max(0, Math.floor((now() - entry.lastActivityAt) / 60000))
    return minutes < 1
      ? t('projectRoom.progress.elapsedJustNow')
      : t('projectRoom.progress.elapsed', { count: minutes })
  }

  const progressItems = computed(() => progress.value.map((item) => {
    const lastActivity = checkpointActivityAt(item.checkpointId)
    return {
      ...item,
      lastActivityAt: lastActivity,
      label: item.blocked ? t('projectRoom.state.paused') : t(STATE_LABELS[item.state] || 'projectRoom.state.unknown'),
      glyph: item.blocked ? '!' : (STATE_GLYPHS[item.state] || '·'),
      elapsed: elapsedLabel({ lastActivityAt: lastActivity }),
    }
  }))

  function purposeFor(entry, gate) {
    if (projectUnavailable.value) return 'unavailable'
    if (gate) {
      return ['question', 'draft-question'].includes(gate.reason) ? 'answer' : 'gate-comment'
    }
    if (!entry) return projectStarted.value ? 'unavailable' : 'start'
    if (entry.state === 'pending' || entry.state === 'checking') return 'interjection-queued'
    if (['drafting', 'leading', 'submitted', 'reviewing'].includes(entry.state)) {
      return 'interjection-active'
    }
    return 'unavailable'
  }

  const activeTarget = computed(() => {
    if (!isMainGroup.value) return null
    if (activeTargetId.value === 'start') {
      if (projectStarted.value || projectUnavailable.value) return null
      return {
        key: 'start',
        checkpointId: '',
        entry: null,
        gate: null,
        purpose: 'start',
      }
    }
    const entry = progress.value.find(item => item.checkpointId === activeTargetId.value)
    if (!entry) return null
    const gate = gates.value.find(item => item.checkpointId === entry.checkpointId) || null
    return {
      key: entry.checkpointId,
      checkpointId: entry.checkpointId,
      entry,
      gate,
      purpose: purposeFor(entry, gate),
    }
  })

  const currentItem = computed(() => (
    activeTarget.value?.checkpointId
      ? progressItems.value.find(item => item.checkpointId === activeTarget.value.checkpointId) || null
      : null
  ))

  const targetPurpose = computed(() => activeTarget.value?.purpose || 'unavailable')
  const targetAvailable = computed(() => Boolean(activeTarget.value) && targetPurpose.value !== 'unavailable')
  const targetLabel = computed(() => {
    if (!activeTarget.value) return t('projectRoom.composer.noTarget')
    if (targetPurpose.value === 'start') return t('projectRoom.composer.startTarget')
    return currentItem.value?.name || activeTarget.value.checkpointId
  })
  const targetPurposeLabel = computed(() => t(`projectRoom.composer.purpose.${targetPurpose.value}`))
  const targetHint = computed(() => {
    if (!activeTarget.value) return t('projectRoom.composer.noTargetHint')
    if (targetPurpose.value === 'start') return t('projectRoom.composer.hint.start')
    const name = currentItem.value?.name || activeTarget.value.checkpointId
    if (targetPurpose.value === 'answer') return t('projectRoom.composer.hint.answer', { checkpoint: name })
    if (targetPurpose.value === 'gate-comment') return t('projectRoom.composer.hint.gate', { checkpoint: name })
    if (targetPurpose.value === 'interjection-queued') {
      return t('projectRoom.composer.hint.queued', { checkpoint: name })
    }
    if (targetPurpose.value === 'interjection-active') {
      return t('projectRoom.composer.hint.active', { checkpoint: name })
    }
    if (activeTarget.value.entry?.state === 'accepted' || activeTarget.value.entry?.state === 'stale') {
      return t('projectRoom.composer.hint.inactive', { checkpoint: name })
    }
    return t('projectRoom.composer.hint.unavailable', { checkpoint: name })
  })
  const sendLabel = computed(() => t(`projectRoom.composer.send.${targetPurpose.value}`))
  const canSend = computed(() => targetAvailable.value && Boolean(draft.value.trim()))
  const sendErrorLabel = computed(() => (sendErrorKey.value ? t(sendErrorKey.value) : ''))

  const gateDetail = ref(null)
  const gateLoading = ref(false)
  const gateErrorKey = ref('')
  const gateStale = ref(false)
  const confirmAcceptAsIs = ref(false)
  const candidateDiverged = ref(null)
  const rejectRequested = ref(false)
  const commitToGit = ref(false)
  const activeGate = computed(() => activeTarget.value?.gate || null)
  const activeGateKey = computed(() => (
    activeGate.value
      ? `${activeGate.value.gateId}:${activeGate.value.revision}`
      : ''
  ))
  const gateScreen = computed(() => (
    gateDetail.value?.firstScreen || activeGate.value?.firstScreen || null
  ))
  const gateAllowedOutcomes = computed(() => (
    gateDetail.value?.allowedOutcomes || activeGate.value?.allowedOutcomes || []
  ))
  const gateAcceptBlockers = computed(() => (
    gateDetail.value?.acceptBlockers || activeGate.value?.acceptBlockers || []
  ))
  const gateCheckpointName = computed(() => (
    gateDetail.value?.checkpointName
      || currentItem.value?.name
      || activeGate.value?.checkpointKey
      || ''
  ))
  const gateCommitToGit = computed(() => (
    gateDetail.value?.commitToGit || { available: false, reasons: [] }
  ))
  const questionGate = computed(() => (
    gateDetail.value?.question === true
      || ['question', 'draft-question'].includes(activeGate.value?.reason)
  ))
  const driftGate = computed(() => activeGate.value?.reason === 'drift')
  const allReviewersPass = computed(() => {
    const reviews = gateScreen.value?.reviewSummaries || []
    return reviews.length > 0 && reviews.every(review => review.verdict === 'pass')
  })
  const gateErrorLabel = computed(() => (gateErrorKey.value ? t(gateErrorKey.value) : ''))

  async function loadGateDetail() {
    gateDetail.value = null
    gateErrorKey.value = ''
    if (!activeGate.value || !projectId.value
        || typeof projectRoom.gateDetail !== 'function') return
    gateLoading.value = true
    try {
      gateDetail.value = await projectRoom.gateDetail({
        projectId: projectId.value,
        gateId: activeGate.value.gateId,
        gateRevision: activeGate.value.revision,
      })
    } catch (error) {
      gateErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
    } finally {
      gateLoading.value = false
    }
  }

  const projectDefs = computed(() => (
    project.value?.config?.playbook?.checkpointDefs || []
  ))
  const activeCheckpointId = computed(() => activeTarget.value?.checkpointId || '')
  const upstreamCheckpoints = computed(() => {
    const current = progress.value.find(item => item.checkpointId === activeCheckpointId.value)
    if (!current) return []
    const defs = projectDefs.value
    const upstreamKeys = new Set()
    const visit = (key) => {
      const def = defs.find(item => item.key === key)
      for (const dependency of def?.dependsOn || []) {
        if (upstreamKeys.has(dependency)) continue
        upstreamKeys.add(dependency)
        visit(dependency)
      }
    }
    visit(current.checkpointKey)
    return progressItems.value
      .filter(item => upstreamKeys.has(item.checkpointKey))
      .map(item => ({
        ...item,
        gate: gates.value.find(gate => gate.checkpointId === item.checkpointId) || null,
      }))
  })
  const rejectPreview = ref(null)
  const rejectUpstreamId = ref('')
  const rejectImpactChanged = ref(false)

  async function previewRejectUpstream(upstreamId) {
    if (!activeGate.value) return null
    rejectUpstreamId.value = String(upstreamId || '')
    rejectImpactChanged.value = false
    gateErrorKey.value = ''
    try {
      rejectPreview.value = await projectRoom.previewReject({
        projectId: projectId.value,
        checkpointId: activeCheckpointId.value,
        upstreamId: rejectUpstreamId.value,
      })
      return rejectPreview.value
    } catch (error) {
      gateErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      return null
    }
  }

  async function submitReject(reason, impactHash) {
    const gate = activeGate.value
    if (!gate || !String(reason || '').trim()) return { ok: false, reasonRequired: true }
    try {
      await projectRoom.decideGate({
        projectId: projectId.value,
        gateId: gate.gateId,
        gateRevision: gate.revision,
        ...(gate.candidateCommit ? { candidateCommit: gate.candidateCommit } : {}),
        outcome: 'reject-upstream',
        upstreamCheckpointId: rejectUpstreamId.value,
        impactHash,
        comment: String(reason),
      })
      rejectPreview.value = null
      rejectUpstreamId.value = ''
      await projectRoom.refresh()
      await loadGateDetail()
      return { ok: true }
    } catch (error) {
      const code = errorCode(error)
      if (code === 'PROJECT_IMPACT_CHANGED') {
        rejectImpactChanged.value = true
        await previewRejectUpstream(rejectUpstreamId.value)
        return { ok: false, impactChanged: true }
      }
      if (code === 'PROJECT_GATE_STALE') {
        gateStale.value = true
        await projectRoom.refresh()
        await loadGateDetail()
        return { ok: false, stale: true }
      }
      gateErrorKey.value = SEND_ERROR_KEYS[code] || 'projectRoom.composer.errors.generic'
      return { ok: false }
    }
  }

  async function previewReopenCheckpoint(checkpointId) {
    if (!projectId.value || !checkpointId) return null
    gateErrorKey.value = ''
    try {
      reopenRequest.value = {
        projectId: projectId.value,
        checkpointId,
        ...(await projectRoom.previewReopen({
          projectId: projectId.value,
          checkpointId,
        })),
      }
      return reopenRequest.value
    } catch (error) {
      gateErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      return null
    }
  }

  async function submitReopen(checkpointId, reason, impactHash) {
    if (!String(reason || '').trim()) return { ok: false, reasonRequired: true }
    try {
      await projectRoom.reopen({
        projectId: projectId.value,
        checkpointId,
        reason: String(reason),
        impactHash,
      })
      reopenRequest.value = null
      await projectRoom.refresh()
      await loadGateDetail()
      return { ok: true }
    } catch (error) {
      const code = errorCode(error)
      if (code === 'PROJECT_IMPACT_CHANGED') {
        await previewReopenCheckpoint(checkpointId)
        return { ok: false, impactChanged: true }
      }
      gateErrorKey.value = SEND_ERROR_KEYS[code] || 'projectRoom.composer.errors.generic'
      return { ok: false }
    }
  }

  async function deleteProjectRoom(targetProjectId, keepChats) {
    await projectRoom.delete({ projectId: targetProjectId, keepChats: keepChats === true })
    return true
  }

  async function unlockProjectDirectory(folderName) {
    await projectRoom.unlockDirectory({
      projectId: projectId.value,
      folderName: String(folderName || '').trim(),
    })
    return true
  }

  const gateTargets = computed(() => [...gates.value].sort((left, right) => (
    timestampMs(left.createdAt) - timestampMs(right.createdAt)
  )))
  const otherGateCount = computed(() => gateTargets.value.filter(gate => (
    gate.gateId !== activeTarget.value?.gate?.gateId
  )).length)

  function draftKey(project, target) {
    return `${project || ''}:${target || ''}`
  }

  function saveDraft() {
    if (!projectId.value || !activeTargetId.value) return
    const key = draftKey(projectId.value, activeTargetId.value)
    if (draft.value.trim()) drafts.set(key, draft.value)
    else drafts.delete(key)
  }

  function setTarget(targetId) {
    saveDraft()
    activeTargetId.value = String(targetId || '')
    draft.value = drafts.get(draftKey(projectId.value, activeTargetId.value)) || ''
    sendErrorKey.value = ''
  }

  function selectTarget(checkpointId) {
    const id = String(checkpointId || '')
    if (id === 'start') {
      if (projectStarted.value || projectUnavailable.value) return false
      setTarget('start')
      return true
    }
    if (!progress.value.some(item => item.checkpointId === id)) return false
    setTarget(id)
    return true
  }

  function selectNextGateTarget() {
    if (!gateTargets.value.length) return false
    const index = gateTargets.value.findIndex(gate => (
      gate.checkpointId === activeTarget.value?.checkpointId
    ))
    const next = gateTargets.value[(index + 1) % gateTargets.value.length]
    return selectTarget(next.checkpointId)
  }

  function applyDefaultTarget() {
    const requested = projectTarget?.value
    if (requested?.projectId === projectId.value && requested.checkpointId
        && progress.value.some(item => item.checkpointId === requested.checkpointId)) {
      setTarget(requested.checkpointId)
      return
    }
    if (gateTargets.value.length) {
      setTarget(gateTargets.value[0].checkpointId)
      return
    }
    const active = [...progressItems.value]
      .filter(item => ACTIVE_STATES.has(item.state))
      .sort((left, right) => (right.lastActivityAt || 0) - (left.lastActivityAt || 0))
    if (active.length) {
      setTarget(active[0].checkpointId)
      return
    }
    if (!projectStarted.value && !projectUnavailable.value && project.value) {
      setTarget('start')
      return
    }
    saveDraft()
    activeTargetId.value = ''
    draft.value = ''
  }

  function syncTarget() {
    if (!isMainGroup.value) return
    if (activeTargetId.value === 'start') {
      if (!projectStarted.value && !projectUnavailable.value) return
      applyDefaultTarget()
      return
    }
    if (activeTargetId.value
        && progress.value.some(item => item.checkpointId === activeTargetId.value)) return
    applyDefaultTarget()
  }

  watch([projectId, isMainGroup], ([id, main], previous) => {
    const [previousId, previousMain] = previous || []
    if (previousId && previousMain && activeTargetId.value) {
      const key = draftKey(previousId, activeTargetId.value)
      if (draft.value.trim()) drafts.set(key, draft.value)
      else drafts.delete(key)
    }
    activeTargetId.value = ''
    draft.value = ''
    sendErrorKey.value = ''
    if (main && id) void projectRoom.open(id)
    else projectRoom.close()
  }, { immediate: true })

  watch(project, () => {
    if (!isMainGroup.value) return
    syncTarget()
    void loadTimelineHistory({ reset: true })
  }, { immediate: true })

  watch(() => projectTarget?.value, (requested) => {
    if (!isMainGroup.value || requested?.projectId !== projectId.value) return
    if (requested.checkpointId
        && progress.value.some(item => item.checkpointId === requested.checkpointId)) {
      setTarget(requested.checkpointId)
    }
  })

  async function sendTargetText() {
    const target = activeTarget.value
    const text = draft.value.trim()
    if (!target || !text || target.purpose === 'unavailable') return false
    sendErrorKey.value = ''
    try {
      if (target.purpose === 'start') {
        await projectRoom.start({ projectId: projectId.value, brief: text })
      } else if (target.purpose === 'interjection-queued' || target.purpose === 'interjection-active') {
        await projectRoom.interject({
          projectId: projectId.value,
          checkpointId: target.checkpointId,
          purpose: 'interjection',
          text,
        })
      } else {
        await projectRoom.decideGate({
          projectId: projectId.value,
          gateId: target.gate.gateId,
          gateRevision: target.gate.revision,
          ...(target.gate.candidateCommit ? { candidateCommit: target.gate.candidateCommit } : {}),
          outcome: 'continue',
          comment: text,
        })
      }
      drafts.delete(draftKey(projectId.value, activeTargetId.value))
      draft.value = ''
      await projectRoom.refresh()
      return true
    } catch (error) {
      sendErrorKey.value = SEND_ERROR_KEYS[errorCode(error)] || 'projectRoom.composer.errors.generic'
      return false
    }
  }

  async function submitGateDecision(outcome, options = {}) {
    const gate = activeGate.value
    if (!gate) return false
    const comment = String(options.comment ?? draft.value).trim()
    if (outcome === 'continue' && !comment) return false
    if (outcome === 'accept' && !options.confirmed && !allReviewersPass.value) {
      confirmAcceptAsIs.value = true
      return false
    }
    confirmAcceptAsIs.value = false
    candidateDiverged.value = null
    gateErrorKey.value = ''
    try {
      await projectRoom.decideGate({
        projectId: projectId.value,
        gateId: gate.gateId,
        gateRevision: gate.revision,
        ...(gate.candidateCommit ? { candidateCommit: gate.candidateCommit } : {}),
        outcome,
        ...(comment ? { comment } : {}),
        ...(outcome === 'accept' ? { commitToGit: commitToGit.value === true } : {}),
        ...(options.acceptCandidate ? { acceptCandidate: true } : {}),
      })
      drafts.delete(draftKey(projectId.value, activeTargetId.value))
      draft.value = ''
      gateStale.value = false
      commitToGit.value = false
      await projectRoom.refresh()
      await loadGateDetail()
      return true
    } catch (error) {
      const code = errorCode(error)
      if (code === 'PROJECT_GATE_STALE') {
        gateStale.value = true
        await projectRoom.refresh()
        await loadGateDetail()
      } else if (code === 'PROJECT_CANDIDATE_DIVERGED') {
        candidateDiverged.value = { files: error?.details?.files || [] }
      } else {
        gateErrorKey.value = SEND_ERROR_KEYS[code] || 'projectRoom.composer.errors.generic'
      }
      return false
    }
  }

  function requestAccept() {
    return submitGateDecision('accept')
  }

  function confirmAcceptNow() {
    return submitGateDecision('accept', { confirmed: true })
  }

  function acceptCandidateVersion() {
    return submitGateDecision('accept', { confirmed: true, acceptCandidate: true })
  }

  function submitGateContinue() {
    return submitGateDecision('continue')
  }

  function requestReject() {
    rejectRequested.value = true
  }

  function cancelAcceptConfirm() {
    confirmAcceptAsIs.value = false
  }

  async function resolveGateDrift(choice) {
    const ids = new Set(gateScreen.value?.driftItemIds || [])
    const items = (project.value?.driftItems || [])
      .filter(item => ids.has(item.id))
      .map(item => ({ itemId: item.id, revision: item.revision }))
    if (!items.length) return false
    gateErrorKey.value = ''
    try {
      await projectRoom.resolveDrift({ projectId: projectId.value, items, choice })
      await projectRoom.refresh()
      await loadGateDetail()
      return true
    } catch (error) {
      gateErrorKey.value = SEND_ERROR_KEYS[errorCode(error)]
        || 'projectRoom.composer.errors.generic'
      return false
    }
  }

  async function reloadGate() {
    gateStale.value = false
    await projectRoom.refresh()
    await loadGateDetail()
  }

  watch(activeGateKey, () => {
    gateStale.value = false
    confirmAcceptAsIs.value = false
    candidateDiverged.value = null
    commitToGit.value = false
    void loadGateDetail()
  }, { immediate: true })

  async function openProjectChat() {
    const id = projectId.value
    if (!id) return false
    const chats = (snapshot.value.groups || [])
      .filter(group => group.projectId === id && group.projectRole !== 'main')
      .sort(sortByUpdated)
    if (chats.length) {
      selectGroup(chats[0].id)
      return true
    }
    const main = activeGroup.value
    if (!main || !workspace?.value?.createGroup) return false
    try {
      const created = await workspace.value.createGroup({
        name: t('projectRoom.chat.defaultName'),
        topic: '',
        agentKinds: [...(main.agentKinds || [])],
        workdir: main.workdir,
        allowWrite: false,
        projectId: id,
      })
      if (typeof normalizeSnapshot === 'function') {
        snapshot.value = normalizeSnapshot(await workspace.value.get())
      }
      selectGroup(created.id)
      return true
    } catch (error) {
      showError(error)
      return false
    }
  }

  async function requestReopen(checkpointId) {
    return Boolean(await previewReopenCheckpoint(checkpointId))
  }

  return {
    acceptCandidateVersion,
    activeCheckpointId,
    activeGate,
    archivedGenerationLabel,
    activeTargetId,
    allReviewersPass,
    canSend,
    cancelAcceptConfirm,
    cancelDriftResolution,
    candidateDiverged,
    commitToGit,
    compactProject,
    confirmAcceptAsIs,
    confirmAcceptNow,
    currentItem,
    deleteProjectRoom,
    diagnostics,
    draft,
    driftGate,
    driftItems,
    errorBar,
    gateAcceptBlockers,
    gateAllowedOutcomes,
    gateCheckpointName,
    gateCommitToGit,
    gateErrorLabel,
    gateLoading,
    gateScreen,
    gateStale,
    isArchivedProjectMessage,
    isMainGroup,
    lastActivityLabel,
    loadDiagnostics,
    loadGateDetail,
    loadMoreTimeline: () => loadTimelineHistory({ reset: false }),
    loadTimelineHistory,
    openDriftDiff,
    openProjectChat,
    outOfScopeItems,
    projectRoomCardMessages,
    projectRoomCurrentGenerations,
    projectTimelineCards,
    otherGateCount,
    refresh: () => projectRoom.refresh(),
    previewRejectUpstream,
    previewReopenCheckpoint,
    project,
    projectName,
    progressItems,
    questionGate,
    rejectImpactChanged,
    rejectPreview,
    rejectRequested,
    rejectUpstreamId,
    reloadGate,
    reopenRequest,
    requestAccept,
    requestReject,
    requestReopen,
    residuals,
    resolveDriftItems,
    resolveGateDrift,
    resolveOutOfScopeItems,
    resolveResidual,
    retryProjectError,
    selectNextGateTarget,
    selectedDiff,
    statusErrorKey,
    stopAndDeliver,
    timelineHistory,
    timelineLoading,
    selectTarget,
    sendErrorLabel,
    sendLabel,
    sendTargetText,
    submitGateContinue,
    submitReject,
    submitReopen,
    targetAvailable,
    targetHint,
    targetLabel,
    targetPurposeLabel,
    unlockProjectDirectory,
    upstreamCheckpoints,
    workdirName,
  }
}
