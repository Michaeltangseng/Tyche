/**
 * A chat workflow drawn only from work that has already been recorded.
 *
 * A task is one beat. parent_task_id is the only task-to-task link. A task
 * created for someone else hangs off the person who created it. An assignment
 * whose target does not yet have a later task is its own beat. Each later
 * handoff message adds the next beat, so a relay keeps growing after the
 * first task. Nothing is drawn for a step that has not happened.
 */

const LIVE_TASK = new Set(['queued', 'in_progress', 'running', 'starting', 'working'])
const LIVE_RUN = new Set(['queued', 'starting', 'running', 'in_progress'])
const LIVE_MESSAGE = new Set(['queued', 'starting', 'working'])

function time(value) {
  const parsed = new Date(value || '').getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

function preview(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 48)
}

function messageOrder(message) {
  const sequence = Number(message?.sequence)
  return Number.isFinite(sequence) ? sequence : time(message?.created_at)
}

function isHandoffMessage(message) {
  if (!message || message.deleted_at || message.author_type !== 'agent' || !message.author_id) return false
  if (message.kind === 'captain_review') return false
  if (message.kind === 'mention') return Array.isArray(message.mentions) && message.mentions.length > 0
  return !message.reply_to && Array.isArray(message.mentions) && message.mentions.length > 0
}

function layerNodes(nodes, edges) {
  const parents = new Map(nodes.map(node => [node.id, []]))
  for (const edge of edges) {
    if (!parents.has(edge.to) || !parents.has(edge.from)) continue
    parents.get(edge.to).push(edge.from)
  }
  const depth = new Map()
  function measure(id, stack) {
    if (depth.has(id)) return depth.get(id)
    if (stack.has(id)) return 0
    stack.add(id)
    const above = parents.get(id) || []
    const value = above.length ? Math.max(...above.map(parent => measure(parent, stack))) + 1 : 0
    stack.delete(id)
    depth.set(id, value)
    return value
  }
  for (const node of nodes) measure(node.id, new Set())
  const grouped = new Map()
  for (const node of nodes) {
    const level = depth.get(node.id) || 0
    const layer = grouped.get(level) || []
    layer.push(node)
    grouped.set(level, layer)
  }
  return [...grouped.keys()].sort((left, right) => left - right).map(level => grouped.get(level))
}

export function buildRoomWorkflow({
  tasks = [],
  runs = [],
  assignments = [],
  messages = [],
  roles = [],
} = {}) {
  const taskList = [...tasks]
    .filter(task => task?.id)
    .sort((left, right) => time(left.created_at) - time(right.created_at) || String(left.id).localeCompare(String(right.id)))
  const runsByTask = new Map()
  for (const run of runs) {
    if (!run?.task_id) continue
    const list = runsByTask.get(run.task_id) || []
    list.push(run)
    runsByTask.set(run.task_id, list)
  }
  const knownTasks = new Set(taskList.map(task => task.id))
  const messageById = new Map(messages.filter(message => message?.id).map(message => [message.id, message]))
  const nodes = []
  const edges = []
  const originByRole = new Map()

  function origin(roleId) {
    if (!roleId) return ''
    let node = originByRole.get(roleId)
    if (!node) {
      node = { id: `origin:${roleId}`, roleId, live: false, status: '', title: '', label: '' }
      originByRole.set(roleId, node)
      nodes.push(node)
    }
    return node.id
  }

  function taskIsLive(task) {
    if (LIVE_TASK.has(task.status)) return true
    return (runsByTask.get(task.id) || []).some(run => LIVE_RUN.has(run.status))
  }

  const latestTaskAt = new Map()
  for (const task of taskList) {
    const roleId = task.assignee_role_id || task.created_by_role_id || ''
    if (!roleId) continue
    const at = time(task.created_at)
    latestTaskAt.set(roleId, Math.max(latestTaskAt.get(roleId) || 0, at))
    nodes.push({
      id: task.id,
      roleId,
      live: taskIsLive(task),
      status: task.status || '',
      title: preview(task.title),
      label: '',
    })
    const parent = task.parent_task_id && knownTasks.has(task.parent_task_id) ? task.parent_task_id : ''
    if (parent) {
      edges.push({ id: `${parent}:${task.id}`, from: parent, to: task.id, label: preview(task.title) })
      continue
    }
    const creator = task.created_by_role_id || ''
    if (creator && creator !== roleId) {
      edges.push({ id: `${creator}:${task.id}`, from: origin(creator), to: task.id, label: preview(task.title) })
    }
  }

  const covered = new Set(
    taskList
      .filter(task => task.captain_assignment_id && task.assignee_role_id)
      .map(task => `${task.captain_assignment_id}:${task.assignee_role_id}`),
  )
  const captain = roles.find(role => role?.is_captain)
  const assignmentList = [...assignments]
    .filter(item => item?.id)
    .sort((left, right) => time(left.created_at) - time(right.created_at) || String(left.id).localeCompare(String(right.id)))
  for (const assignment of assignmentList) {
    const targets = Array.isArray(assignment.target_role_ids) ? assignment.target_role_ids : []
    const label = preview(messageById.get(assignment.message_id)?.content)
    const at = time(assignment.created_at)
    for (const roleId of targets) {
      if (!roleId || covered.has(`${assignment.id}:${roleId}`)) continue
      if ((latestTaskAt.get(roleId) || 0) >= at && at > 0) continue
      const id = `assignment:${assignment.id}:${roleId}`
      nodes.push({
        id,
        roleId,
        live: assignment.status === 'active',
        status: assignment.status || '',
        title: label,
        label: '',
      })
      if (captain?.id && captain.id !== roleId) {
        edges.push({ id: `${captain.id}:${id}`, from: origin(captain.id), to: id, label })
      }
    }
  }

  const latestNode = new Map()
  for (const node of nodes) {
    if (String(node.id).startsWith('origin:')) continue
    latestNode.set(node.roleId, node.id)
  }
  const consumed = new Set()
  const liveRoles = new Set(
    messages
      .filter(message => message?.author_type === 'agent' && LIVE_MESSAGE.has(message.status))
      .map(message => message.author_id),
  )
  const handoffs = messages
    .filter(isHandoffMessage)
    .sort((left, right) => messageOrder(left) - messageOrder(right) || String(left.id).localeCompare(String(right.id)))
  for (const message of handoffs) {
    const mentions = message.mentions.filter(roleId => roleId && roleId !== message.author_id)
    if (!mentions.length) continue
    const fromId = latestNode.get(message.author_id) || origin(message.author_id)
    const label = preview(message.content)
    for (const roleId of mentions) {
      const existingId = latestNode.get(roleId)
      const existing = existingId ? nodes.find(node => node.id === existingId) : null
      const reusable = existing && !String(existing.id).startsWith('handoff:') && !consumed.has(existing.id)
      if (reusable) {
        consumed.add(existing.id)
        latestNode.set(roleId, existing.id)
        continue
      }
      const id = `handoff:${message.id}:${roleId}`
      nodes.push({
        id,
        roleId,
        live: false,
        status: message.status || '',
        title: label,
        label: '',
      })
      edges.push({ id: `${fromId}:${id}`, from: fromId, to: id, label })
      latestNode.set(roleId, id)
    }
  }
  if (liveRoles.size) {
    for (const node of nodes) {
      if (String(node.id).startsWith('origin:')) continue
      node.live = latestNode.get(node.roleId) === node.id && liveRoles.has(node.roleId)
    }
  }

  const used = new Set(edges.flatMap(edge => [edge.from, edge.to]))
  const labelByTarget = new Map(edges.map(edge => [edge.to, edge.label]))
  const visible = nodes
    .filter(node => !String(node.id).startsWith('origin:') || used.has(node.id))
    .map(node => ({ ...node, label: labelByTarget.get(node.id) || '' }))
  const visibleEdges = edges.filter(edge => visible.some(node => node.id === edge.from) && visible.some(node => node.id === edge.to))
  return { nodes: visible, edges: visibleEdges, layers: layerNodes(visible, visibleEdges) }
}
