'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { z } = require('zod')
const { resolveRoot } = require('../runs/path-claims.cjs')
const { describePathChange } = require('../project-room/path-change.cjs')
const {
  classifyContent,
  imageMime,
  listDirectory,
  normalizeRelativePath,
  resolveForRead,
  trimUtf8Buffer,
  validateForDiff,
} = require('../project-room/workdir-access.cjs')

const ID = /^[A-Za-z0-9._:-]{1,120}$/
const id = z.string().min(1).max(120).regex(ID)
const relativePath = z.string().max(4096)

const schemas = {
  list: z.strictObject({
    projectId: id,
    relPath: relativePath.optional(),
    cursor: z.string().max(80).optional(),
  }),
  read: z.strictObject({
    projectId: id,
    relPath: relativePath,
    offset: z.number().int().nonnegative().optional(),
    length: z.number().int().positive().max(512 * 1024).optional(),
  }),
  diff: z.strictObject({
    projectId: id,
    relPath: relativePath,
    against: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('accepted'), checkpointId: id, version: id.optional() }),
      z.strictObject({ kind: z.literal('candidate'), checkpointId: id }),
    ]),
  }),
  acceptedDocuments: z.strictObject({ projectId: id }),
}

function workdirError(code = 'WORKDIR_PATH_REJECTED') {
  return Object.assign(new Error(code), { code })
}

function projectError(code = 'PROJECT_NOT_FOUND') {
  return Object.assign(new Error(code), { code })
}

function contextFor(service, projectId) {
  const context = service()?.contextFor?.(projectId)
  if (!context) throw projectError()
  return context
}

function commitFor(state, against) {
  const instance = (state?.instances || []).find(item => item.id === against.checkpointId)
  if (!instance) throw workdirError()
  if (against.kind === 'candidate') return instance.candidate || ''
  const version = against.version
    ? (instance.artifactVersions || []).find(item => item.id === against.version)
    : (instance.artifactVersions || []).at(-1)
  return version?.commit || ''
}

function placeholderFor(state, relative) {
  return (state?.placeholders || []).find(item => item.path === relative) || null
}

function workdirEntry(target, state, relative, numstat, oldEntry) {
  const placeholder = placeholderFor(state, relative)
  if (placeholder) {
    return {
      kind: 'placeholder',
      reason: placeholder.reason,
      size: placeholder.size ?? null,
      sha256: placeholder.sha256 ?? null,
    }
  }
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return { kind: 'absent' }
  }
  if (stat.isSymbolicLink()) {
    return { kind: 'link', target: fs.readlinkSync(target) }
  }
  const mode = stat.mode & 0o111 ? '100755' : '100644'
  const changed = Boolean(numstat && (
    numstat.binary || (numstat.added || 0) > 0 || (numstat.removed || 0) > 0
      || (oldEntry?.mode && oldEntry.mode !== mode)
  ))
  return {
    kind: 'file',
    mode,
    size: stat.size,
    sha256: changed ? 'changed' : (oldEntry?.sha256 || null),
  }
}

function registerWorkdirIpc({ registerTrustedHandle, getProjectService }) {
  const service = () => {
    const value = getProjectService?.()
    if (!value) throw projectError()
    return value
  }

  async function rootInfoFor(projectId) {
    const context = contextFor(service, projectId)
    const rootInfo = await resolveRoot(context.project.workdir)
    return { context, rootInfo }
  }

  registerTrustedHandle('workdir:list', async (input) => {
    const parsed = schemas.list.safeParse(input)
    if (!parsed.success) throw workdirError()
    const { projectId, relPath = '', cursor } = parsed.data
    const offset = cursor === undefined ? 0 : Number(cursor)
    if (!Number.isSafeInteger(offset) || offset < 0) throw workdirError()
    const { rootInfo } = await rootInfoFor(projectId)
    const result = await listDirectory(rootInfo, relPath, offset)
    return {
      entries: result.entries,
      cursor: result.cursor,
      hasMore: result.hasMore,
    }
  })

  registerTrustedHandle('workdir:read', async (input) => {
    const parsed = schemas.read.safeParse(input)
    if (!parsed.success) throw workdirError()
    const { projectId, relPath, offset = 0, length = 512 * 1024 } = parsed.data
    const { rootInfo } = await rootInfoFor(projectId)
    const opened = await resolveForRead(rootInfo, relPath)
    try {
      const stat = fs.fstatSync(opened.fd)
      const totalBytes = stat.size
      const start = Math.min(Math.max(0, offset), totalBytes)
      const requested = Math.min(length, 512 * 1024, totalBytes - start)
      const buffer = Buffer.alloc(requested)
      const read = requested > 0 ? fs.readSync(opened.fd, buffer, 0, requested, start) : 0
      const slice = Buffer.isBuffer(read) ? read : buffer.subarray(0, read)
      const kind = classifyContent(slice, path.basename(opened.relative))
      if (kind === 'image' && totalBytes <= 5 * 1024 * 1024) {
        const whole = Buffer.alloc(totalBytes)
        fs.readSync(opened.fd, whole, 0, totalBytes, 0)
        return {
          kind: 'image',
          mime: imageMime(whole),
          dataBase64: whole.toString('base64'),
        }
      }
      if (kind === 'text') {
        const textBuffer = trimUtf8Buffer(slice)
        return {
          kind: 'text',
          text: textBuffer.toString('utf8'),
          totalBytes,
          eof: start + textBuffer.length >= totalBytes,
          encoding: 'utf-8',
        }
      }
      return {
        kind: 'binary',
        size: totalBytes,
        ...(kind === 'image' ? { mime: imageMime(slice) } : {}),
      }
    } finally {
      fs.closeSync(opened.fd)
    }
  })

  registerTrustedHandle('workdir:diff', async (input) => {
    const parsed = schemas.diff.safeParse(input)
    if (!parsed.success) throw workdirError()
    const { projectId, relPath, against } = parsed.data
    const { context, rootInfo } = await rootInfoFor(projectId)
    const relative = validateForDiff(rootInfo, relPath)
    const state = context.store?.current() || null
    const commit = commitFor(state, against)
    if (!commit) throw workdirError()
    try {
      const numstat = (await context.shadowRepo.numstat(commit, null, [relative]))
        .find(entry => entry.path === relative) || null
      const oldEntries = await context.shadowRepo.entriesAtCommit(commit, [relative])
      const oldEntry = oldEntries[relative]?.exists === false
        ? { kind: 'absent' }
        : oldEntries[relative]
      const newEntry = workdirEntry(
        path.join(rootInfo.realRoot, ...normalizeRelativePath(relative, rootInfo).segments),
        state,
        relative,
        numstat,
        oldEntry,
      )
      const change = describePathChange(oldEntry, newEntry)
      let diff = null
      if (change.diffAvailable) {
        diff = await context.shadowRepo.fileDiff(commit, null, relative)
      }
      return { path: relative, against, numstat, change, diff }
    } catch (error) {
      if (/beyond a symbolic link/i.test(String(error?.message || error?.stderr || ''))) {
        throw workdirError()
      }
      if (error?.code?.startsWith?.('WORKDIR_') || error?.code === 'PROJECT_NOT_FOUND') throw error
      throw workdirError()
    }
  })

  registerTrustedHandle('workdir:acceptedDocuments', async (input) => {
    const parsed = schemas.acceptedDocuments.safeParse(input)
    if (!parsed.success) throw projectError()
    const snapshot = service().snapshot(parsed.data.projectId)
    const documents = (snapshot.progress || [])
      .filter(item => item.acceptedVersion)
      .map(item => ({
        checkpointId: item.checkpointId,
        name: item.name,
        path: item.acceptedVersion.files?.[0] || '',
        files: [...(item.acceptedVersion.files || [])],
        versionId: item.acceptedVersion.id,
        acceptedAt: item.acceptedVersion.acceptedAt,
        stale: item.state === 'stale',
        hasPendingVersion: item.hasPendingVersion === true,
      }))
    return { documents }
  })
}

module.exports = { registerWorkdirIpc }
