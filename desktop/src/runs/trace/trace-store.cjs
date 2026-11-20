'use strict'

const fs = require('node:fs')
const path = require('node:path')

function readMeta(directory) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(directory, 'meta.json'), 'utf8'))
    return meta && typeof meta === 'object' ? meta : null
  } catch {
    return null
  }
}

function listTraceDirectories(tracesRoot) {
  let entries
  try {
    entries = fs.readdirSync(tracesRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const directories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = path.join(tracesRoot, entry.name)
    directories.push({
      directory,
      bytes: directoryBytes(directory),
      meta: readMeta(directory),
    })
  }
  return directories
}

function directoryBytes(directory) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) total += directoryBytes(full)
    else if (entry.isFile()) {
      try { total += fs.statSync(full).size } catch { /* file vanished */ }
    }
  }
  return total
}

function removeTraceDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function removeTracesForGroup(tracesRoot, groupId) {
  let removed = 0
  for (const entry of listTraceDirectories(tracesRoot)) {
    if (entry.meta?.groupId !== groupId) continue
    if (removeTraceDirectory(entry.directory)) removed += 1
  }
  return removed
}

function cleanupOrphanTraces(tracesRoot, isKnownGroup) {
  let removed = 0
  for (const entry of listTraceDirectories(tracesRoot)) {
    if (entry.meta?.groupId && isKnownGroup(entry.meta.groupId)) continue
    if (removeTraceDirectory(entry.directory)) removed += 1
  }
  return removed
}

function traceDiskUsage(tracesRoot) {
  const directories = listTraceDirectories(tracesRoot)
  return {
    bytes: directories.reduce((total, entry) => total + entry.bytes, 0),
    runs: directories.length,
  }
}

function pruneTraces(tracesRoot, { groupId = '', olderThan = 0 } = {}) {
  const cutoff = Number.isFinite(olderThan) && olderThan > 0 ? olderThan : 0
  let removed = 0
  let bytes = 0
  for (const entry of listTraceDirectories(tracesRoot)) {
    if (groupId && entry.meta?.groupId !== groupId) continue
    if (cutoff) {
      const createdAt = Date.parse(entry.meta?.createdAt || '')
      if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue
    }
    if (!groupId && !cutoff) continue
    if (removeTraceDirectory(entry.directory)) {
      removed += 1
      bytes += entry.bytes
    }
  }
  return { removed, bytes }
}

function createTraceStore({ tracesRoot }) {
  return {
    diskUsage: () => traceDiskUsage(tracesRoot),
    prune: input => pruneTraces(tracesRoot, input),
    removeForGroup: groupId => removeTracesForGroup(tracesRoot, groupId),
    cleanupOrphans: isKnownGroup => cleanupOrphanTraces(tracesRoot, isKnownGroup),
  }
}

module.exports = {
  cleanupOrphanTraces,
  createTraceStore,
  pruneTraces,
  removeTracesForGroup,
  traceDiskUsage,
}
