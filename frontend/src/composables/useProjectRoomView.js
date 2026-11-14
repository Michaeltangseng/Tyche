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
    if (!projectId.value) return false
    try {
      reopenRequest.value = {
        projectId: projectId.value,
        checkpointId,
        ...(await projectRoom.previewReopen({
          projectId: projectId.value,
          checkpointId,
        })),
      }
      return true
    } catch (error) {
      showError(error)
      return false
    }
  }

  return {
    activeTargetId,
    canSend,
    currentItem,
    draft,
    isMainGroup,
    lastActivityLabel,
    openProjectChat,
    otherGateCount,
    project,
    progressItems,
    requestReopen,
    reopenRequest,
    selectNextGateTarget,
    selectTarget,
    sendErrorLabel,
    sendLabel,
    sendTargetText,
    targetAvailable,
    targetHint,
    targetLabel,
    targetPurposeLabel,
  }
}
