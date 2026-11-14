const fs = require('node:fs')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')
const path = require('node:path')
const { parseDeliveryTasks } = require('./delivery-tasks.cjs')
const { loadedWorkPreferences } = require('./work-preferences.cjs')
const { RUN_STATUSES } = require('../runs/run-ledger-records.cjs')
const { normalizeSessionMeta } = require('../runs/run-harness.cjs')
const { parseNativeSessionProfiles } = require('./native-session-profiles.cjs')
const {
  SESSION_KEY,
  cleanCurrentRound,
  cleanProgressSteps,
  cleanRunMaxRounds,
  cleanText,
  emptyState,
  normalizeLoadedGroup,
  normalizeLoadedMessage,
  normalizeSessionRef,
} = require('./local-workspace-inputs.cjs')

const FINISHED_AGENT_STATUSES = new Set([
  'completed', 'partial', 'failed', 'stopped', 'timeout', 'interrupted',
])
const FAILED_AGENT_STATUSES = new Set(['failed', 'stopped', 'timeout'])
const TERMINAL_PERSISTENCE_STATES = new Set(['pending', 'retrying', 'failed'])

const V4_PHASES = new Set([
  'prepare', 'dispatch', 'running', 'reconcile', 'proposal', 'discussion', 'challenge',
  'coordination', 'work', 'synthesis', 'verification', 'commit', 'committed', 'completed',
  'human-gate', 'stopped', 'failed',
])
const V4_SLOT_STATUSES = new Set([
  'planned', 'prepared', 'queued', 'running', 'waiting', 'completed', 'partial',
  'settled', 'committed', 'failed', 'stopped', 'timeout', 'interrupted',
  'cancelled', 'unknown_outcome',
])
const V4_SLOT_ROLES = new Set([
  'primary', 'reviewer', 'arbiter', 'worker', 'integrator',
  'synthesizer', 'verifier', 'writer', 'participant',
])
const V4_PRIVATE_GATE_RESUME_KINDS = new Set([
  'v4_human_gate', 'v4_synthesis_recovery',
])
const PUBLIC_AGENT_KIND = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const PROJECT_ID = /^[A-Za-z0-9._:-]{1,120}$/
const WORKSPACE_V3_BACKUP = 'meldwork-workspace.v3.backup.json'

function realWorkdir(workdir) {
  const resolved = path.resolve(workdir)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function pathContains(parent, child) {
  if (parent === child) return true
  const base = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`
  return child.startsWith(base)
}

function projectWorkdirsOverlap(first, second) {
  const left = realWorkdir(first)
  const right = realWorkdir(second)
  if (process.platform === 'win32') {
    const lowerLeft = left.toLowerCase()
    const lowerRight = right.toLowerCase()
    return pathContains(lowerLeft, lowerRight) || pathContains(lowerRight, lowerLeft)
  }
  return pathContains(left, right) || pathContains(right, left)
}

function projectIssue(projectId, code, details = {}) {
  return { projectId, code, ...details }
}

function publicOrchestrationSnapshot(orchestration) {
  if (!orchestration || orchestration.version !== 4) return null
  if (!V4_PHASES.has(orchestration.phase)) return null
  const phase = orchestration.phase
  const currentKinds = [...new Set(
    (Array.isArray(orchestration.currentKinds) ? orchestration.currentKinds : [])
      .filter(kind => typeof kind === 'string' && PUBLIC_AGENT_KIND.test(kind)),
  )].slice(0, 32)
  const roleByAgentKind = new Map(
    (Array.isArray(orchestration.plan?.assignments) ? orchestration.plan.assignments : [])
      .filter(assignment => assignment && typeof assignment === 'object')
      .map(assignment => [assignment.agentKind, assignment.role]),
  )
  const round = Number.isSafeInteger(orchestration.round) && orchestration.round >= 0
    ? Math.min(orchestration.round, 100000)
    : null
  const slots = (Array.isArray(orchestration.slots) ? orchestration.slots : [])
    .slice(0, 32)
    .map(slot => {
      if (!slot || typeof slot !== 'object') return null
      const agentKind = typeof slot.agentKind === 'string' ? slot.agentKind : ''
      if (!PUBLIC_AGENT_KIND.test(agentKind)
          || !V4_SLOT_STATUSES.has(slot.status)
          || !V4_PHASES.has(slot.phase)) return null
      const role = roleByAgentKind.get(agentKind)
      return {
        agentKind,
        phase: slot.phase,
        status: slot.status,
        ...(V4_SLOT_ROLES.has(role) ? { role } : {}),
        ...(round !== null ? { round } : {}),
      }
    })
    .filter(Boolean)
  return {
    version: 4,
    phase,
    currentKinds,
    slots,
  }
}

function terminalPersistenceSnapshot(value) {
  if (!value || !TERMINAL_PERSISTENCE_STATES.has(value.state)) return null
  return {
    state: value.state,
    status: typeof value.status === 'string' ? value.status : 'failed',
    attempts: Number.isSafeInteger(value.attempts) && value.attempts > 0 ? value.attempts : 1,
    nextRetryAt: Number.isSafeInteger(value.nextRetryAt) && value.nextRetryAt > 0
      ? value.nextRetryAt
      : 0,
    code: value.code === 'LOCAL_RUN_PERSIST_FAILED' ? value.code : '',
  }
}

function exactGateAgentAttempt(gate, agentRuns) {
  const matches = agentRuns.filter(agentRun => (
    agentRun?.agentRunId === gate.agentRunId && agentRun?.kind === gate.agentKind
  ))
  return matches.length === 1 ? matches[0] : null
}

function isV4PrivateGate(run, gate) {
  const continuation = run?.continuation
  if (run?.orchestration?.version !== 4 || continuation?.state !== 'pending'
      || continuation.gateId !== gate.gateId
      || continuation.agentRunId !== gate.agentRunId
      || continuation.agentKind !== gate.agentKind) return false
  if (V4_PRIVATE_GATE_RESUME_KINDS.has(continuation.resumeKind)) return true
  return continuation.resumeKind === 'agent_slot'
    && continuation.operationId === gate.agentRunId
    && continuation.operationId === continuation.agentRunId
}

function publicHumanGateSnapshot(gate, run, publicRun) {
  const agentRuns = Array.isArray(publicRun?.agentRuns) ? publicRun.agentRuns : []
  if (run?.orchestration?.version !== 4) return gate
  if (!isV4PrivateGate(run, gate)) {
    return exactGateAgentAttempt(gate, agentRuns) ? gate : null
  }
  const continuation = run.continuation
  if (typeof continuation.publicAgentRunId !== 'string'
      || !continuation.publicAgentRunId) return null
  const slots = run.orchestration.slots.filter(slot => (
    slot?.agentKind === continuation.agentKind
      && slot.agentRunId === continuation.publicAgentRunId
      && (continuation.resumeKind !== 'agent_slot'
        || (slot.slotId === continuation.slotId
          && slot.operationId === continuation.operationId))
  ))
  if (slots.length !== 1) return null
  const matches = agentRuns.filter(agentRun => (
    agentRun?.agentRunId === continuation.publicAgentRunId
      && agentRun?.kind === continuation.agentKind
  ))
  return matches.length === 1
    ? { ...gate, agentRunId: continuation.publicAgentRunId }
    : null
}

function loadWorkspaceState(storagePath) {
  let source
  try {
    source = fs.readFileSync(storagePath, 'utf8')
  } catch (error) {
    const missing = error?.code === 'ENOENT'
    return {
      state: emptyState(),
      status: missing ? 'missing' : 'unreadable',
      trusted: missing,
      diagnostic: missing ? '' : 'LOCAL_WORKSPACE_STATE_UNREADABLE',
    }
  }

  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    return {
      state: emptyState(),
      status: 'corrupt',
      trusted: false,
      diagnostic: 'LOCAL_WORKSPACE_STATE_CORRUPT',
    }
  }

  if (![1, 2, 3, 4].includes(parsed?.version)) {
    return {
      state: emptyState(),
      status: 'unsupported',
      trusted: false,
      diagnostic: 'LOCAL_WORKSPACE_STATE_UNSUPPORTED',
    }
  }
  if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.messages)
      || !parsed.sessions || typeof parsed.sessions !== 'object'
      || Array.isArray(parsed.sessions)) {
    return {
      state: emptyState(),
      status: 'corrupt',
      trusted: false,
      diagnostic: 'LOCAL_WORKSPACE_STATE_CORRUPT',
    }
  }

  try {
    const repliedAgentKinds = new Map()
    for (const message of Array.isArray(parsed.messages) ? parsed.messages : []) {
      if (message?.role !== 'agent' || typeof message.groupId !== 'string') continue
      const kinds = repliedAgentKinds.get(message.groupId) || []
      if (!kinds.includes(message.agentKind)) kinds.push(message.agentKind)
      repliedAgentKinds.set(message.groupId, kinds)
    }
    let groups = parsed.groups
      .map(group => normalizeLoadedGroup(group, {
        recoveredAgentKinds: repliedAgentKinds.get(group?.id) || [],
      }))
      .filter(Boolean)
    const groupIds = new Set(groups.map(group => group.id))
    const messages = parsed.messages
      .map(normalizeLoadedMessage)
      .filter(message => message && groupIds.has(message.groupId))
    const sessionMeta = {}
    if (parsed.sessionMeta && typeof parsed.sessionMeta === 'object'
        && !Array.isArray(parsed.sessionMeta)) {
      for (const [key, value] of Object.entries(parsed.sessionMeta).slice(0, 1000)) {
        if (/^[A-Za-z0-9._:-]{1,240}$/.test(key)) {
          sessionMeta[key] = normalizeSessionMeta(value)
        }
      }
    }
    const sessions = {}
    if (parsed.sessions && typeof parsed.sessions === 'object'
        && !Array.isArray(parsed.sessions)) {
      for (const [key, value] of Object.entries(parsed.sessions).slice(0, 1000)) {
        const sessionRef = normalizeSessionRef(value)
        if (SESSION_KEY.test(key) && sessionRef) sessions[key] = sessionRef
      }
    }
    const projects = []
    const projectIssues = []
    if (Array.isArray(parsed.projects)) {
      for (const candidate of parsed.projects.slice(0, 256)) {
        const projectId = String(candidate?.id || '')
        const name = cleanText(candidate?.name, 80)
        const workdir = cleanText(candidate?.workdir, 1000)
        if (!PROJECT_ID.test(projectId) || !workdir || !path.isAbsolute(workdir)) {
          projectIssues.push(projectIssue(projectId, 'PROJECT_INVALID'))
          continue
        }
        const project = {
          id: projectId,
          name,
          workdir: path.resolve(workdir),
          createdAt: cleanText(candidate.createdAt, 80),
          updatedAt: cleanText(candidate.updatedAt, 80),
        }
        if (candidate.deleting && typeof candidate.deleting === 'object'
            && !Array.isArray(candidate.deleting)) {
          project.deleting = {
            requestedAt: cleanText(candidate.deleting.requestedAt, 80),
            keepChats: candidate.deleting.keepChats === true,
          }
        }
        projects.push(project)
      }
    }
    const projectIds = new Set(projects.map(project => project.id))
    groups = groups.map(group => {
      if (!group.projectId) {
        if (group.projectRole === 'main') {
          projectIssues.push(projectIssue('', 'PROJECT_MAIN_CHAT_DANGLING', { groupId: group.id }))
          const { projectRole, ...rest } = group
          return rest
        }
        return group
      }
      if (!projectIds.has(group.projectId)) {
        projectIssues.push(projectIssue(group.projectId, 'PROJECT_GROUP_DANGLING', {
          groupId: group.id,
        }))
        const { projectId, projectRole, ...rest } = group
        return rest
      }
      return group
    })
    for (const project of projects) {
      const mains = groups.filter(group => (
        group.projectId === project.id && group.projectRole === 'main'
      ))
      if (mains.length !== 1) {
        projectIssues.push(projectIssue(project.id, 'PROJECT_MAIN_CHAT_INVALID', {
          readOnly: true,
        }))
      }
    }
    for (let second = 0; second < projects.length; second += 1) {
      for (let first = 0; first < second; first += 1) {
        if (projectWorkdirsOverlap(projects[first].workdir, projects[second].workdir)) {
          projectIssues.push(projectIssue(projects[second].id, 'PROJECT_WORKDIR_OVERLAP', {
            readOnly: true,
            conflictsWith: projects[first].id,
          }))
        }
      }
    }
    const projectStateRoot = path.join(
      path.dirname(storagePath), 'meldwork-private', 'projects',
    )
    for (const project of projects) {
      if (!fs.existsSync(path.join(projectStateRoot, project.id, 'state.json'))) {
        projectIssues.push(projectIssue(project.id, 'PROJECT_STATE_MISSING', {
          readOnly: true,
        }))
      }
    }
    return {
      state: {
        version: 4,
        projects,
        ...(parsed.workPreferences ? { workPreferences: loadedWorkPreferences(parsed.workPreferences) } : {}),
        ...(parsed.deliveryTasks ? {
          deliveryTasks: parseDeliveryTasks(parsed.deliveryTasks).filter(task => groupIds.has(task.groupId)),
        } : {}),
        groups,
        messages,
        sessions,
        sessionMeta,
        ...(parsed.nativeSessionProfiles ? { nativeSessionProfiles: parseNativeSessionProfiles(parsed.nativeSessionProfiles) } : {}),
        agentPreferences: parsed.agentPreferences
          && typeof parsed.agentPreferences === 'object' && !Array.isArray(parsed.agentPreferences)
          ? { ...parsed.agentPreferences }
          : {},
        agentRuntime: parsed.agentRuntime
          && typeof parsed.agentRuntime === 'object' && !Array.isArray(parsed.agentRuntime)
          ? { ...parsed.agentRuntime }
          : {},
      },
      status: 'ready',
      trusted: true,
      diagnostic: '',
      projectIssues,
    }
  } catch {
    return {
      state: emptyState(),
      status: 'corrupt',
      trusted: false,
      diagnostic: 'LOCAL_WORKSPACE_STATE_CORRUPT',
    }
  }
}

// Older builds reject v4 files, and keeping the version at 3 would make them
// silently drop `projects`. Before the first v4 write, keep the original v3
// file byte-for-byte so a downgrade has something to restore (M1/M5 3.1).
function ensureV3Backup(storagePath, state) {
  if (!state || !(Number(state.version) >= 4)) return
  const backupPath = path.join(path.dirname(storagePath), WORKSPACE_V3_BACKUP)
  if (fs.existsSync(backupPath)) return
  let source
  try {
    source = fs.readFileSync(storagePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  let version
  try {
    version = JSON.parse(source)?.version
  } catch {
    return
  }
  if (![1, 2, 3].includes(version)) return
  try {
    atomicWritePrivateFile(backupPath, source)
  } catch (error) {
    if (error?.phase !== 'after-commit') throw error
  }
}

// The whole workspace is rewritten on every save, synchronously on the main
// process. Compact JSON cuts the bytes written (and the time the UI is
// blocked) for long histories, and the private atomic writer fsyncs before
// the rename so a crash cannot leave a truncated file behind.
function saveWorkspaceState(storagePath, state) {
  ensureV3Backup(storagePath, state)
  atomicWritePrivateFile(storagePath, `${JSON.stringify(state)}\n`)
}

function durableWaitingRunSnapshots({ state, records, pendingGates, liveRunIds, liveGroupIds }) {
  const groupIds = new Set(state.groups.map(group => group.id))
  const pendingById = new Map(pendingGates.map(gate => [gate.gateId, gate]))
  const projectedGroupIds = new Set()
  const entries = []

  for (const record of records) {
    const continuation = record?.continuation
    const gate = pendingById.get(continuation?.gateId)
    if (record?.status !== 'waiting' || continuation?.state !== 'pending'
        || !gate || liveRunIds.has(record.runId) || liveGroupIds.has(record.groupId)
        || projectedGroupIds.has(record.groupId) || !groupIds.has(record.groupId)
        || gate.runId !== record.runId || gate.type !== continuation.gateType
        || gate.agentRunId !== continuation.agentRunId
        || gate.agentKind !== continuation.agentKind
        || !record.targetKinds?.includes(continuation.agentKind)) continue

    const latestAgentStatuses = new Map()
    for (const agentRun of Array.isArray(record.agentRuns) ? record.agentRuns : []) {
      if (!record.targetKinds.includes(agentRun?.kind)
          || !FINISHED_AGENT_STATUSES.has(agentRun?.status)) continue
      latestAgentStatuses.set(agentRun.kind, agentRun.status)
    }
    const mode = record.mode === 'auto' ? 'auto' : 'manual'
    const unlimitedRounds = mode === 'auto' && record.unlimitedRounds === true
    const maxRounds = mode === 'auto' && !unlimitedRounds
      ? cleanRunMaxRounds(record.maxRounds)
      : 0
    const isV4 = record.orchestration?.version === 4
    const orchestration = publicOrchestrationSnapshot(record.orchestration)
    const publicOrchestration = orchestration || (isV4 ? { version: 4 } : null)
    projectedGroupIds.add(record.groupId)
    entries.push({
      run: record,
      snapshot: {
        groupId: record.groupId,
        runId: record.runId,
        ...(!isV4 ? {
          taskId: record.taskId || '',
          contextPackId: record.contextPackId || '',
          contextPackState: record.contextPackState || (record.contextPackId
            ? 'captured'
            : 'legacy-unavailable'),
        } : {}),
        phase: 'running',
        mode,
        targetKinds: record.targetKinds || [],
        completedKinds: [...latestAgentStatuses.keys()],
        failedKinds: [...latestAgentStatuses]
          .filter(([, status]) => FAILED_AGENT_STATUSES.has(status))
          .map(([kind]) => kind),
        currentKind: continuation.agentKind,
        currentRound: cleanCurrentRound(record.currentRound, maxRounds, unlimitedRounds),
        maxRounds,
        unlimitedRounds,
        progress: [],
        threadRootId: record.threadRootId || '',
        responseVersionRootId: record.responseVersionRootId || '',
        startedAt: record.startedAt || Date.now(),
        agentRuns: Array.isArray(record.agentRuns) ? record.agentRuns : [],
        waitingGateIds: [gate.gateId],
        budget: record.budget || null,
        ...(publicOrchestration ? { orchestration: publicOrchestration } : {}),
      },
    })
  }
  return entries
}

function workspaceSnapshot({
  detectedAgents, state, preparingRuns, activeRuns, humanGateCoordinator, runLedger,
  workspaceRecovery, projectRoom,
}) {
  let records = []
  try { records = runLedger?.list?.() || [] } catch { /* retain the visible workspace on ledger read failure */ }
  const groupIds = new Set(state.groups.map(group => group.id))
  const roots = new Map(state.messages.filter(message => message.role === 'user' && !message.threadRootId)
    .map(message => [message.id, message.groupId]))
  const latestOutcomes = new Map()
  for (const record of records) {
    if (!groupIds.has(record.groupId) || roots.get(record.threadRootId) !== record.groupId
        || !RUN_STATUSES.has(record.status)) continue
    const previous = latestOutcomes.get(record.threadRootId)
    if (previous && previous.startedAt >= record.startedAt) continue
    latestOutcomes.set(record.threadRootId, {
      groupId: record.groupId, runId: record.runId, threadRootId: record.threadRootId,
      status: record.status, targetKinds: [...record.targetKinds],
      startedAt: record.startedAt, finishedAt: record.finishedAt || 0,
    })
  }
  const busyEntries = [
    ...[...preparingRuns.entries()].map(entry => [...entry, 'preparing']),
    ...[...activeRuns.entries()].map(entry => [...entry, 'running']),
  ]
  const runEntries = busyEntries.filter(([, run, phase]) => (
    phase === 'running' || run.taskBound === true
  ))
  const pendingGates = humanGateCoordinator?.list?.({ pendingOnly: true }) || []
  const liveRunIds = new Set(runEntries.map(([, run]) => run.runId).filter(Boolean))
  const liveGroupIds = new Set(busyEntries.map(([groupId]) => groupId))
  const durableRunEntries = durableWaitingRunSnapshots({
    state, records, pendingGates, liveRunIds, liveGroupIds,
  })
  const liveRunEntries = runEntries.map(([groupId, run, phase]) => {
    const mode = run.mode === 'auto' ? 'auto' : 'manual'
    const unlimitedRounds = mode === 'auto' && run.unlimitedRounds === true
    const maxRounds = mode === 'auto' && !unlimitedRounds ? cleanRunMaxRounds(run.maxRounds) : 0
    const terminalPersistence = terminalPersistenceSnapshot(run.terminalPersistence)
    const isV4 = run.orchestration?.version === 4
    const orchestration = publicOrchestrationSnapshot(run.orchestration)
    const publicOrchestration = orchestration || (isV4 ? { version: 4 } : null)
    return {
      run,
      snapshot: {
        groupId,
        runId: run.runId || '',
        ...(!isV4 ? {
          taskId: run.taskId || '',
          contextPackId: run.contextPackId || '',
          contextPackState: run.contextPackId ? 'captured' : 'legacy-unavailable',
        } : {}),
        phase,
        mode,
        targetKinds: run.targetKinds || [],
        completedKinds: run.completedKinds || [],
        failedKinds: run.failedKinds || [],
        currentKind: run.currentKind || '',
        currentRound: cleanCurrentRound(run.currentRound, maxRounds, unlimitedRounds),
        maxRounds,
        unlimitedRounds,
        progress: cleanProgressSteps(run.progress),
        threadRootId: run.threadRootId || '',
        responseVersionRootId: run.responseVersionRootId || '',
        startedAt: run.startedAt || Date.now(),
        agentRuns: run.harness?.snapshot?.() || [],
        waitingGateIds: [...(run.waitingGateIds || [])],
        budget: run.budget?.snapshot?.() || null,
        ...(publicOrchestration ? { orchestration: publicOrchestration } : {}),
        ...(!isV4 && terminalPersistence ? { terminalPersistence } : {}),
      },
    }
  })
  const publicRunEntries = [...liveRunEntries, ...durableRunEntries]
  const publicGates = []
  for (const gate of pendingGates) {
    const matches = publicRunEntries.filter(({ snapshot }) => snapshot.runId === gate.runId)
    if (matches.length !== 1) continue
    const publicGate = publicHumanGateSnapshot(gate, matches[0].run, matches[0].snapshot)
    if (publicGate) publicGates.push(publicGate)
  }
  const publicGatesById = new Map(publicGates.map(gate => [gate.gateId, gate]))
  const publicRuns = publicRunEntries.map(({ snapshot }) => ({
    ...snapshot,
    waitingGateIds: snapshot.waitingGateIds.filter((gateId) => {
      const gate = publicGatesById.get(gateId)
      return gate?.runId === snapshot.runId
    }),
  }))
  const deliveryMessages = new Map((state.deliveryTasks || []).flatMap(task => (
    task.attempts.map(attempt => [attempt.messageId, { task, attempt }])
  )))
  return {
    agents: detectedAgents.map(({ executable, ...agent }) => agent),
    groups: state.groups,
    messages: state.messages.map(message => {
      const delivery = deliveryMessages.get(message.id)
      if (!delivery || message.role !== 'user' || message.groupId !== delivery.task.groupId) return message
      const { task, attempt } = delivery
      return { ...message, content: [
        task.brief.title, task.brief.goal, task.brief.output,
        ...task.brief.criteria.map(item => `- ${item}`),
        attempt.revision?.note, attempt.input,
      ].filter(Boolean).join('\n\n') }
    }),
    ...(state.deliveryTasks?.length ? { deliveryTasks: structuredClone(state.deliveryTasks) } : {}),
    ...(workspaceRecovery?.trusted === false ? {
      recovery: {
        state: 'read-only',
        status: workspaceRecovery.status,
        diagnostic: workspaceRecovery.diagnostic,
      },
    } : {}),
    runningGroupIds: [...new Set([
      ...busyEntries.map(([groupId]) => groupId),
      ...durableRunEntries.map(({ snapshot }) => snapshot.groupId),
    ])],
    humanGates: publicGates,
    runs: publicRuns,
    runOutcomes: [...latestOutcomes.values()],
    ...(projectRoom ? {
      projectRooms: projectRoom.list(),
      pendingDecisions: projectRoom.pendingDecisions(),
    } : {}),
  }
}

module.exports = {
  loadWorkspaceState,
  saveWorkspaceState,
  workspaceSnapshot,
}
