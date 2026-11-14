const DEFAULT_MERGE_WINDOW_MS = 30 * 1000

function itemKey(item) {
  return `${String(item?.projectId || '')}\u0000${String(item?.type || '')}\u0000${String(item?.itemId || '')}`
}

function reasonKey(reason) {
  return `projectRoom.notification.${String(reason || 'item')}`
}

// Pure per M1/M5 section 10. The caller keeps the returned pending buffers
// and calls again at nextAt (or on the next project change). Nothing here
// touches the system notification API.
function coalesceNotifications({
  previousItems = [],
  nextItems = [],
  now = Date.now(),
  viewingProjectId = '',
  pending = [],
  mergeWindowMs = DEFAULT_MERGE_WINDOW_MS,
} = {}) {
  const previousKeys = new Set(
    (Array.isArray(previousItems) ? previousItems : []).map(itemKey),
  )
  const buffers = new Map()
  for (const buffer of Array.isArray(pending) ? pending : []) {
    if (!buffer?.projectId) continue
    buffers.set(buffer.projectId, {
      projectId: buffer.projectId,
      projectName: String(buffer.projectName || ''),
      firstAt: Number.isFinite(buffer.firstAt) ? buffer.firstAt : now,
      items: Array.isArray(buffer.items) ? buffer.items.map(item => ({ ...item })) : [],
    })
  }

  for (const item of Array.isArray(nextItems) ? nextItems : []) {
    if (!item?.projectId || previousKeys.has(itemKey(item))) continue
    if (viewingProjectId && item.projectId === viewingProjectId) continue
    const buffer = buffers.get(item.projectId) || {
      projectId: item.projectId,
      projectName: String(item.projectName || ''),
      firstAt: now,
      items: [],
    }
    if (!buffer.items.some(existing => itemKey(existing) === itemKey(item))) {
      buffer.items.push({
        type: String(item.type || ''),
        itemId: String(item.itemId || ''),
        projectId: item.projectId,
        checkpointName: String(item.checkpointName || ''),
        reason: String(item.reason || item.type || 'item'),
      })
    }
    buffers.set(item.projectId, buffer)
  }
  if (viewingProjectId) buffers.delete(viewingProjectId)

  const notifications = []
  for (const [projectId, buffer] of [...buffers]) {
    if (now - buffer.firstAt < mergeWindowMs) continue
    buffers.delete(projectId)
    if (!buffer.items.length) continue
    notifications.push({
      projectId,
      projectName: buffer.projectName,
      checkpointNames: [...new Set(
        buffer.items.map(item => item.checkpointName).filter(Boolean),
      )].slice(0, 5),
      reasonKeys: [...new Set(buffer.items.map(item => reasonKey(item.reason)))].slice(0, 5),
      count: buffer.items.length,
      at: now,
    })
  }

  const nextPending = [...buffers.values()]
  const nextAt = nextPending.length
    ? Math.min(...nextPending.map(buffer => buffer.firstAt + mergeWindowMs))
    : null
  return { notifications, pending: nextPending, nextAt }
}

module.exports = {
  DEFAULT_MERGE_WINDOW_MS,
  coalesceNotifications,
}
