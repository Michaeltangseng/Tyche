/**
 * Derive the collaboration posture of one chat for the room header.
 *
 * The header never invents a pipeline. Nodes come from recorded facts only:
 * task runs, the task assignee, Captain assignment targets, completed handoff
 * messages, and the agent reply that is actually in flight. A plan the Agent
 * has not written down does not appear as "waiting".
 *
 * Modes:
 *   idle      no live work and no settled work to recap
 *   replying  an agent reply is streaming, but no assignment/task owns it
 *   running   a TaskRun, Captain assignment, or relay handoff is live
 *   settled   the latest task/assignment finished; a quiet recap remains
 */

const LIVE_RUN_STATUSES = new Set(['starting', 'running'])
const DONE_RUN_STATUSES = new Set(['completed'])
const ATTENTION_RUN_STATUSES = new Set(['failed', 'interrupted'])
const ACTIVE_MESSAGE_STATUSES = new Set(['queued', 'starting', 'working'])
const BUSY_MESSAGE_STATUSES = new Set(['queued', 'starting', 'working', 'stopping'])
const DONE_MESSAGE_STATUSES = new Set(['done', 'completed', 'accepted', 'stopped'])
const ATTENTION_MESSAGE_STATUSES = new Set(['failed', 'interrupted', 'waiting_for_input'])
const TERMINAL_MESSAGE_STATUSES = new Set([
  ...DONE_MESSAGE_STATUSES,
  ...ATTENTION_MESSAGE_STATUSES,
])

function timestamp(value) {
  const parsed = new Date(value || '').getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

function runTime(run) {
  return timestamp(run?.queued_at) || timestamp(run?.started_at) || timestamp(run?.ended_at)
}

function sortRuns(list) {
  return [...list].sort((left, right) => (
    runTime(left) - runTime(right)
    || String(left?.id || '').localeCompare(String(right?.id || ''))
  ))
}

function latestByCreatedAt(list) {
  return [...list].sort((left, right) => (
    timestamp(left?.created_at) - timestamp(right?.created_at)
    || String(left?.id || '').localeCompare(String(right?.id || ''))
  )).at(-1) || null
}

function latestTimestamp(list, keys) {
  let value = 0
  for (const item of list) {
    for (const key of keys) value = Math.max(value, timestamp(item?.[key]))
  }
  return value
}

function isTerminalRun(run) {
  return DONE_RUN_STATUSES.has(run?.status) || ATTENTION_RUN_STATUSES.has(run?.status)
}

function idleState() {
  return {
    mode: 'idle',
    nodes: [],
    replies: [],
    activeRoleId: '',
    activeSince: null,
    activeRunId: '',
    taskId: '',
    taskNumber: '',
    taskLabel: '',
    extraActiveTasks: 0,
    settledAt: null,
    tone: '',
  }
}

/**
 * Build one node per role. A role that ran twice keeps its latest run, so the
 * node shows what that role is doing now rather than replaying its history.
 */
function buildNodes({ task, runs, assignment, activeReply, replies }) {
  const orderedRoleIds = []
  const latestRunByRole = new Map()
  for (const run of sortRuns(runs)) {
    if (!run?.role_id) continue
    if (!latestRunByRole.has(run.role_id)) orderedRoleIds.push(run.role_id)
    latestRunByRole.set(run.role_id, run)
  }

  // The assignee is a recorded fact even before its run is queued.
  if (task?.assignee_role_id && !latestRunByRole.has(task.assignee_role_id)) {
    latestRunByRole.set(task.assignee_role_id, null)
    orderedRoleIds.push(task.assignee_role_id)
  }
  // Captain assignments are authorization facts; show roles that were handed
  // work but have not produced a run yet.
  for (const roleId of assignment?.target_role_ids || []) {
    if (!roleId || latestRunByRole.has(roleId)) continue
    latestRunByRole.set(roleId, null)
    orderedRoleIds.push(roleId)
  }

  const liveRunIds = new Set(
    runs.filter(run => LIVE_RUN_STATUSES.has(run.status)).map(run => run.id),
  )
  // A queued run is the current beat when nothing has started yet.
  const fallbackQueued = liveRunIds.size
    ? null
    : sortRuns(runs.filter(run => run.status === 'queued'))[0] || null

  const nodes = orderedRoleIds.map((roleId) => {
    const run = latestRunByRole.get(roleId) || null
    let state = 'waiting'
    let status = 'assigned'
    let since = null
    let activationKey = `${roleId}:waiting`

    if (run) {
      status = run.status
      if (LIVE_RUN_STATUSES.has(run.status)) {
        state = 'active'
        since = run.started_at || run.queued_at || null
        activationKey = run.id
      } else if (run.status === 'queued' && fallbackQueued?.id === run.id) {
        state = 'active'
        since = null
        activationKey = run.id
      } else if (DONE_RUN_STATUSES.has(run.status)) {
        state = 'done'
        activationKey = `${run.id}:done`
      } else if (ATTENTION_RUN_STATUSES.has(run.status)) {
        state = 'attention'
        activationKey = `${run.id}:attention`
      }
    }

    return {
      roleId,
      state,
      status,
      since,
      runId: run?.id || '',
      taskId: task?.id || '',
      activationKey,
      source: run ? 'run' : 'assigned',
    }
  })

  // A live chat reply is also a fact. If it comes from a role that is not in
  // the task chain, append it; if the role is already there but idle, let the
  // reply take the spotlight.
  for (const reply of replies || []) {
    if (!reply?.roleId) continue
    const existing = nodes.find(node => node.roleId === reply.roleId)
    if (existing) {
      if (existing.state === 'active') continue
      existing.state = 'active'
      existing.status = 'replying'
      existing.since = reply.since || null
      existing.activationKey = `reply:${reply.messageId || reply.roleId}`
      existing.source = 'reply'
      continue
    }
    nodes.push({
      roleId: reply.roleId,
      state: 'active',
      status: 'replying',
      since: reply.since || null,
      runId: '',
      taskId: task?.id || '',
      activationKey: `reply:${reply.messageId || reply.roleId}`,
      source: 'reply',
    })
  }

  if (activeReply?.author_id) {
    const existing = nodes.find(node => node.roleId === activeReply.author_id)
    if (existing && existing.source !== 'reply' && existing.state !== 'active') {
      existing.state = 'active'
      existing.status = 'replying'
      existing.since = activeReply.created_at || null
      existing.activationKey = `reply:${activeReply.id}`
      existing.source = 'reply'
    }
  }

  return nodes
}

/**
 * Assignment-driven relay: a Captain assignment is already a recorded fact,
 * even before any TaskRun exists. A role is done when its target reply
 * completed or when it posted a completed handoff message, active while it is
 * replying, and waiting otherwise. This is what makes the header switch to the
 * relay when people are collaborating through assignments and mentions.
 */
function buildAssignmentNodes({ assignments = [], messages = [], replies = [], since = 0 } = {}) {
  const messageById = new Map(messages.map(message => [message.id, message]))
  const replyByRole = new Map((replies || []).map(reply => [reply.roleId, reply]))
  const nodes = []
  const nodeByRole = new Map()

  function nodeFor(roleId, assignment) {
    if (!roleId) return null
    let node = nodeByRole.get(roleId)
    if (!node) {
      node = {
        roleId,
        state: 'waiting',
        status: 'assigned',
        since: null,
        runId: '',
        taskId: '',
        assignmentId: assignment?.id || '',
        activationKey: `assignment:${roleId}:waiting`,
        source: 'assignment',
      }
      nodeByRole.set(roleId, node)
      nodes.push(node)
    }
    // A newer assignment for the same role starts a new step.
    node.state = 'waiting'
    node.status = 'assigned'
    node.since = null
    node.assignmentId = assignment?.id || node.assignmentId
    node.activationKey = `assignment:${roleId}:${assignment?.id || 'waiting'}`
    return node
  }

  function doneHandoff(roleId, after) {
    return messages.find(message => (
      message.author_type === 'agent'
      && message.author_id === roleId
      && DONE_MESSAGE_STATUSES.has(message.status)
      && Array.isArray(message.mentions)
      && message.mentions.length > 0
      && timestamp(message.created_at) >= after
    )) || null
  }

  for (const assignment of assignments) {
    const assignmentAt = timestamp(assignment.created_at) || since
    const targetRoles = Array.isArray(assignment.target_role_ids) ? assignment.target_role_ids : []
    const targetReplies = (assignment.target_reply_ids || [])
      .map(id => messageById.get(id))
      .filter(Boolean)

    for (const roleId of targetRoles) {
      const node = nodeFor(roleId, assignment)
      if (!node) continue

      const live = replyByRole.get(roleId)
      if (live) {
        node.state = 'active'
        node.status = 'working'
        node.since = live.since || null
        node.activationKey = `reply:${live.messageId || roleId}`
        node.source = 'reply'
        continue
      }

      const roleReplies = targetReplies.filter(message => message.author_id === roleId)
      const busy = roleReplies.find(message => BUSY_MESSAGE_STATUSES.has(message.status))
      if (busy) {
        node.state = 'active'
        node.status = busy.status === 'queued'
          ? 'queued'
          : busy.status === 'starting' ? 'starting' : 'working'
        node.since = busy.status === 'queued' ? null : (busy.created_at || null)
        node.activationKey = `assignment:${roleId}:${busy.id}`
        continue
      }

      const attention = roleReplies.find(message => ATTENTION_MESSAGE_STATUSES.has(message.status))
      if (attention) {
        node.state = 'attention'
        node.status = attention.status
        node.activationKey = `assignment:${roleId}:${attention.id}`
        continue
      }

      const done = roleReplies.find(message => DONE_MESSAGE_STATUSES.has(message.status))
      if (done) {
        node.state = 'done'
        node.status = 'completed'
        node.activationKey = `assignment:${roleId}:${done.id}`
        continue
      }

      // Some assignments record only target roles. A completed message from
      // the role that hands off to the next role is still real evidence.
      const handoff = doneHandoff(roleId, assignmentAt)
      if (handoff) {
        node.state = 'done'
        node.status = 'completed'
        node.activationKey = `handoff:${handoff.id}`
        continue
      }

      // The assignment status is the final fallback when reply rows are
      // missing. Settled work still renders a done node; blocked work stays
      // visible as attention instead of disappearing from the relay.
      if (assignment.status === 'settled') {
        node.state = 'done'
        node.status = 'completed'
        node.activationKey = `assignment:${roleId}:${assignment.id}:settled`
      } else if (assignment.status === 'blocked') {
        node.state = 'attention'
        node.status = 'blocked'
        node.activationKey = `assignment:${roleId}:${assignment.id}:blocked`
      }
    }
  }

  // A live reply from a role outside the assignment (typically the Captain
  // reviewing) belongs to the same visible relay.
  for (const reply of replies || []) {
    if (!reply?.roleId || nodeByRole.has(reply.roleId)) continue
    const node = {
      roleId: reply.roleId,
      state: 'active',
      status: 'working',
      since: reply.since || null,
      runId: '',
      taskId: '',
      assignmentId: '',
      activationKey: `reply:${reply.messageId || reply.roleId}`,
      source: 'reply',
    }
    nodeByRole.set(reply.roleId, node)
    nodes.push(node)
  }

  return nodes
}

function latestRoleId(nodes) {
  const active = nodes.filter(node => node.state === 'active')
  const latest = [...active].sort((left, right) => (
    timestamp(left.since) - timestamp(right.since)
    || String(left.activationKey).localeCompare(String(right.activationKey))
  )).at(-1)
  return latest?.roleId || ''
}

function activeSince(nodes) {
  const active = nodes.filter(node => node.state === 'active')
  const latest = [...active].sort((left, right) => (
    timestamp(left.since) - timestamp(right.since)
  )).at(-1)
  return latest?.since || null
}

export function deriveRoomCollaboration({
  tasks = [],
  runs = [],
  reports = [],
  messages = [],
  assignments = [],
  reviews = [],
  liveRuns = {},
} = {}) {
  const runsByTask = new Map()
  for (const run of runs) {
    if (!runsByTask.has(run.task_id)) runsByTask.set(run.task_id, [])
    runsByTask.get(run.task_id).push(run)
  }

  const liveMessageIds = new Set(
    Object.entries(liveRuns || {})
      .filter(([, state]) => !state || state.status === 'running')
      .map(([id]) => id),
  )
  const activeMessages = messages.filter(message => (
    message.author_type === 'agent'
    && !TERMINAL_MESSAGE_STATUSES.has(message.status)
    && (ACTIVE_MESSAGE_STATUSES.has(message.status) || liveMessageIds.has(message.id))
  ))
  const latestActiveMessage = latestByCreatedAt(activeMessages)
  const repliesByRole = new Map()
  for (const message of activeMessages) {
    if (!message.author_id) continue
    const previous = repliesByRole.get(message.author_id)
    if (!previous || timestamp(message.created_at) >= timestamp(previous.since)) {
      repliesByRole.set(message.author_id, {
        roleId: message.author_id,
        since: message.created_at || null,
        messageId: message.id,
      })
    }
  }
  const replies = [...repliesByRole.values()]

  const lastUserMessage = [...messages].reverse().find(message => message.author_type === 'user')
  const lastUserAt = timestamp(lastUserMessage?.created_at)
  // Assignments are the Captain's recorded authorization for the current
  // user turn. Include settled/blocked rows too: the relay keeps its done
  // nodes after the review marks the assignment finished. Older rows stay in
  // the ledger, so scope the chain to the latest user message.
  const currentAssignments = [...assignments]
    .filter(assignment => assignment && !['cancelled', 'deleted'].includes(assignment.status))
    .filter(assignment => !lastUserAt || timestamp(assignment.created_at) >= lastUserAt)
    .sort((left, right) => (
      timestamp(left.created_at) - timestamp(right.created_at)
      || String(left?.id || '').localeCompare(String(right?.id || ''))
    ))
  const assignmentChainStart = currentAssignments.length
    ? Math.min(...currentAssignments.map(assignment => timestamp(assignment.created_at) || lastUserAt || 0))
    : 0
  const assignmentNodes = currentAssignments.length
    ? buildAssignmentNodes({
        assignments: currentAssignments,
        messages,
        replies,
        since: assignmentChainStart,
      })
    : []
  const assignmentHasActive = assignmentNodes.some(node => node.state === 'active')
  const assignmentHasWaiting = assignmentNodes.some(node => node.state === 'waiting')
  const assignmentHasAttention = assignmentNodes.some(node => node.state === 'attention')
  const assignmentAllDone = assignmentNodes.length > 0
    && assignmentNodes.every(node => node.state === 'done')

  function assignmentRunningState() {
    return {
      mode: 'running',
      nodes: assignmentNodes,
      replies,
      activeRoleId: latestRoleId(assignmentNodes),
      activeSince: activeSince(assignmentNodes),
      activeRunId: '',
      taskId: '',
      taskNumber: '',
      taskLabel: '',
      extraActiveTasks: 0,
      settledAt: null,
      tone: '',
    }
  }

  const activeRuns = runs.filter(run => LIVE_RUN_STATUSES.has(run.status))
  const queuedRuns = runs.filter(run => run.status === 'queued')
  const liveTaskIds = new Set([
    ...activeRuns.map(run => run.task_id),
    ...queuedRuns.map(run => run.task_id),
  ])
  const inProgressTasks = tasks.filter(task => (
    task.status === 'in_progress'
    && (liveTaskIds.has(task.id) || !(runsByTask.get(task.id) || []).length)
  ))
  const activeTaskIds = new Set([
    ...liveTaskIds,
    ...inProgressTasks.map(task => task.id),
  ])

  if (activeTaskIds.size) {
    const focusRun = sortRuns([...activeRuns, ...queuedRuns]).at(-1) || null
    const focusTask = tasks.find(task => task.id === focusRun?.task_id)
      || latestByCreatedAt(inProgressTasks)
      || tasks.find(task => task.id === [...activeTaskIds][0])
      || null

    if (focusTask) {
      const taskRuns = sortRuns(runsByTask.get(focusTask.id) || [])
      const assignment = assignments.find(item => item.id === focusTask.captain_assignment_id) || null
      const nodes = buildNodes({ task: focusTask, runs: taskRuns, assignment, activeReply: latestActiveMessage, replies })
      if (nodes.length) {
        return {
          mode: 'running',
          nodes,
          replies,
          activeRoleId: latestRoleId(nodes),
          activeSince: activeSince(nodes),
          activeRunId: nodes.find(node => node.state === 'active' && node.runId)?.runId || '',
          taskId: focusTask.id,
          taskNumber: focusTask.number ?? '',
          taskLabel: focusTask.title || '',
          extraActiveTasks: Math.max(0, activeTaskIds.size - 1),
          settledAt: null,
          tone: '',
        }
      }
    }
  }

  // An assignment owns the turn as soon as a target is actively replying or
  // needs attention. Waiting-only assignments are handled after the settled
  // task check so a finished task is not replaced by a stale waiting node.
  if (currentAssignments.length && (replies.length > 0 || assignmentHasActive || assignmentHasAttention)) {
    return assignmentRunningState()
  }

  if (latestActiveMessage) {
    return {
      ...idleState(),
      mode: 'replying',
      replies,
      activeRoleId: latestActiveMessage.author_id || '',
      activeSince: latestActiveMessage.created_at || null,
      activeRunId: latestActiveMessage.id || '',
    }
  }

  const latestTask = latestByCreatedAt(tasks)
  const latestTaskRuns = latestTask ? sortRuns(runsByTask.get(latestTask.id) || []) : []
  if (latestTask && latestTaskRuns.length && latestTaskRuns.every(isTerminalRun)) {
    const lastActivity = Math.max(
      timestamp(latestTask.updated_at),
      latestTaskRuns.reduce((latest, run) => Math.max(
        latest,
        timestamp(run.ended_at),
        timestamp(run.started_at),
        timestamp(run.queued_at),
      ), 0),
      latestTimestamp(reports.filter(report => report.task_id === latestTask.id), ['created_at']),
    )
    const userStartedNextTurn = lastUserMessage
      && timestamp(lastUserMessage.created_at) > lastActivity
    if (!userStartedNextTurn) {
      const assignment = assignments.find(item => item.id === latestTask.captain_assignment_id) || null
      const nodes = buildNodes({ task: latestTask, runs: latestTaskRuns, assignment, activeReply: null, replies: [] })
        .filter(node => node.runId)
        .map(node => ({
          ...node,
          state: node.state === 'attention' ? 'attention' : 'done',
          status: node.state === 'attention' ? node.status : 'completed',
        }))
      const hasAttention = nodes.some(node => node.state === 'attention')
        || latestTask.status === 'blocked'
      const tone = hasAttention
        ? 'attention'
        : latestTask.status === 'in_review' ? 'review' : 'done'
      const settledAt = new Date(
        lastActivity || timestamp(latestTask.created_at) || Date.now(),
      ).toISOString()
      return {
        ...idleState(),
        mode: 'settled',
        nodes,
        taskId: latestTask.id,
        taskNumber: latestTask.number ?? '',
        taskLabel: latestTask.title || '',
        settledAt,
        tone,
      }
    }
  }

  if (currentAssignments.length && assignmentHasWaiting) {
    return assignmentRunningState()
  }

  if (currentAssignments.length && assignmentAllDone) {
    const chainRoleIds = new Set(assignmentNodes.map(node => node.roleId))
    const chainMessages = messages.filter(message => (
      chainRoleIds.has(message.author_id)
      && timestamp(message.created_at) >= assignmentChainStart
    ))
    const chainReviews = reviews.filter(review => timestamp(review.created_at) >= assignmentChainStart)
    const settledAt = Math.max(
      latestTimestamp(currentAssignments, ['created_at']),
      latestTimestamp(chainMessages, ['created_at']),
      latestTimestamp(chainReviews, ['created_at']),
    )
    const blockedReview = chainReviews.some(review => review.kind === 'assignment_blocked')
    const hasAttention = assignmentNodes.some(node => node.state === 'attention') || blockedReview
    return {
      ...idleState(),
      mode: 'settled',
      nodes: assignmentNodes,
      settledAt: new Date(settledAt || Date.now()).toISOString(),
      tone: hasAttention ? 'attention' : 'done',
    }
  }

  return idleState()
}
