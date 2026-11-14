const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { z } = require('zod')
const { redactSecrets } = require('../security/secret-redaction.cjs')
const { seatSchema } = require('../project-room/project-state-schema.cjs')
const { capabilitiesFor } = require('../project-room/agent-capabilities.cjs')
const { allowedDuringDeletion } = require('../project-room/project-deletion.cjs')

const ID = /^[A-Za-z0-9._:-]{1,120}$/
const AGENT_KIND = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const CAPABILITIES = ['read', 'read-exec', 'write-drafts', 'write-workdir']
const ALWAYS_ALLOWED = new Set(['snapshot', 'getPreferences', 'setPreferences'])

const id = z.string().min(1).max(120).regex(ID)
const text = limit => z.string().max(limit)
const revision = z.number().int().nonnegative()
const emptyInput = z.strictObject({})

const checkpointRole = z.strictObject({
  checkpointKey: id,
  role: z.enum(['lead', 'reviewer', 'draft']),
})

const seatInput = z.strictObject({
  id,
  roleName: text(40),
  duty: text(200),
  agentKind: z.string().min(1).max(40).regex(AGENT_KIND),
  capabilities: z.array(z.enum(CAPABILITIES)).max(8),
  checkpointRoles: z.array(checkpointRole).max(256),
  profileVersionId: id,
  profileText: text(16384).optional(),
})

const playbookPatch = z.strictObject({
  roundLimit: z.number().int().positive().max(100).optional(),
  continuationLimit: z.number().int().nonnegative().max(1000).optional(),
  gates: z.record(id, z.enum(['soft', 'hard'])).optional(),
  checkpointDefs: z.array(z.strictObject({
    key: id,
    gate: z.enum(['soft', 'hard']).optional(),
    roundLimit: z.number().int().positive().max(100).nullable().optional(),
    continuationLimit: z.number().int().nonnegative().max(1000).nullable().optional(),
  })).max(256).optional(),
})

const playbookOverrides = z.strictObject({
  roundLimit: z.number().int().positive().max(100).optional(),
  continuationLimit: z.number().int().nonnegative().max(1000).optional(),
  gates: z.record(id, z.enum(['soft', 'hard'])).optional(),
  checkpointDefs: playbookPatch.shape.checkpointDefs,
})

const schemas = {
  chooseWorkdir: emptyInput,
  getPreferences: emptyInput,
  setPreferences: z.strictObject({ projectRoomPreview: z.boolean() }),
  templates: emptyInput,
  capabilities: z.strictObject({
    agentKind: z.string().min(1).max(40).regex(AGENT_KIND),
  }),
  create: z.strictObject({
    token: z.string().min(1).max(200),
    name: text(80),
    templateId: id.optional(),
    templateVersion: z.number().int().positive().optional(),
    seats: z.array(seatInput).max(64).optional(),
    playbookOverrides: playbookOverrides.optional(),
  }),
  rename: z.strictObject({ projectId: id, name: text(80) }),
  delete: z.strictObject({ projectId: id, keepChats: z.boolean() }),
  retryDeletion: z.strictObject({ projectId: id }),
  snapshot: z.strictObject({ projectId: id }),
  updateSeat: z.strictObject({ projectId: id, seat: seatSchema, configRevision: revision }),
  addSeat: z.strictObject({ projectId: id, seat: seatInput, configRevision: revision }),
  removeSeat: z.strictObject({ projectId: id, seatId: id, configRevision: revision }),
  updateProfile: z.strictObject({
    projectId: id, seatId: id, text: text(16384), configRevision: revision,
  }),
  rollbackProfile: z.strictObject({
    projectId: id, seatId: id, profileId: id, configRevision: revision,
  }),
  updatePlaybook: z.strictObject({
    projectId: id, patch: playbookPatch, configRevision: revision,
  }),
  saveAsTemplate: z.strictObject({ projectId: id, name: text(80) }),
  compact: z.strictObject({ projectId: id }),
  updatePreferences: z.strictObject({
    projectId: id,
    drawerWidth: z.number().int().min(280).max(760).optional(),
    drawerTab: z.enum(['files', 'trace']).optional(),
    commitToGit: z.boolean().optional(),
  }),
  diagnostics: z.strictObject({ projectId: id }),
  gateDetail: z.strictObject({
    projectId: id, gateId: id, gateRevision: z.number().int().positive(),
  }),
  start: z.strictObject({ projectId: id, brief: text(32768) }),
  interject: z.strictObject({
    projectId: id, checkpointId: id, purpose: z.literal('interjection'), text: text(32768),
  }),
  stopAndDeliver: z.strictObject({ projectId: id, checkpointId: id }),
  decideGate: z.strictObject({
    projectId: id,
    gateId: id,
    gateRevision: z.number().int().positive(),
    candidateCommit: z.string().regex(COMMIT).optional(),
    outcome: z.enum(['continue', 'accept', 'reject-upstream']),
    comment: text(32768).optional(),
    upstreamCheckpointId: id.optional(),
    impactHash: text(128).optional(),
    driftChoice: z.enum(['workdir', 'accepted']).optional(),
    commitToGit: z.boolean().optional(),
    acceptCandidate: z.boolean().optional(),
  }),
  previewReject: z.strictObject({ projectId: id, checkpointId: id, upstreamId: id }),
  previewReopen: z.strictObject({ projectId: id, checkpointId: id }),
  reopen: z.strictObject({
    projectId: id, checkpointId: id, reason: text(32768), impactHash: text(128),
  }),
  resolveDrift: z.strictObject({
    projectId: id,
    items: z.array(z.strictObject({ itemId: id, revision: z.number().int().positive() })).max(200),
    choice: z.enum(['workdir', 'accepted']),
  }),
  cancelDriftResolution: z.strictObject({
    projectId: id, itemId: id, revision: z.number().int().positive(),
  }),
  resolveOutOfScope: z.strictObject({
    projectId: id, itemIds: z.array(id).max(200),
  }),
  retryEffect: z.strictObject({
    projectId: id, checkpointId: id.optional(), effectId: id,
  }),
  timelineHistory: z.strictObject({
    projectId: id,
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  residual: z.strictObject({
    projectId: id.optional(),
    residualId: id,
    action: z.enum(['manuallyEnded', 'notRelated']),
  }),
  unlockDirectory: z.strictObject({ projectId: id, folderName: text(255) }),
}

function ipcError(code, details = {}) {
  return Object.assign(new Error(code), { code, details })
}

function request(schema, input) {
  const parsed = schema.safeParse(input ?? {})
  if (!parsed.success) {
    throw ipcError('PROJECT_INPUT_INVALID', {
      issues: parsed.error.issues.map(issue => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
        ...(issue.keys ? { keys: issue.keys } : {}),
      })),
    })
  }
  return parsed.data
}

function redact(value, limit) {
  return redactSecrets(String(value || '')).slice(0, limit)
}

function redactSeat(seat) {
  return {
    ...seat,
    roleName: redact(seat.roleName, 40),
    duty: redact(seat.duty, 200),
    ...(seat.profileText === undefined ? {} : { profileText: redact(seat.profileText, 16384) }),
  }
}

function workdirsOverlap(first, second) {
  const resolve = (value) => {
    const resolved = path.resolve(value)
    try {
      return fs.realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }
  const contains = (parent, child) => (
    parent === child
      || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`)
  )
  const left = resolve(first)
  const right = resolve(second)
  return contains(left, right) || contains(right, left)
}

function createWorkdirTokens({ now = Date.now, ttlMs = 10 * 60 * 1000, createToken = () => randomUUID() } = {}) {
  const tokens = new Map()
  return {
    issue(workdir) {
      const token = createToken()
      tokens.set(token, { workdir, expiresAt: now() + ttlMs })
      return token
    },
    consume(token) {
      const entry = tokens.get(token)
      tokens.delete(token)
      if (!entry || entry.expiresAt <= now()) {
        throw ipcError('PROJECT_WORKDIR_TOKEN_INVALID')
      }
      return entry.workdir
    },
    size() {
      return tokens.size
    },
  }
}

function registerProjectIpc({
  registerTrustedHandle,
  getProjectService,
  getDeletion,
  getPreferences = () => ({ projectRoomPreview: false }),
  setPreferences = async () => ({ projectRoomPreview: false }),
  onPreferencesChanged = () => {},
  dialog,
  getMainWindow,
  now = Date.now,
  ttlMs = 10 * 60 * 1000,
  createToken = () => randomUUID(),
} = {}) {
  const tokens = createWorkdirTokens({ now, ttlMs, createToken })
  const service = () => {
    const value = getProjectService?.()
    if (!value) throw ipcError('PROJECT_ENGINE_UNAVAILABLE')
    return value
  }
  const deletion = () => getDeletion?.() || null
  const handlers = {}

  const register = (method, handler) => {
    handlers[method] = handler
    registerTrustedHandle(`project:${method}`, (input) => {
      const parsed = request(schemas[method], input)
      if (!ALWAYS_ALLOWED.has(method) && getPreferences()?.projectRoomPreview !== true) {
        throw ipcError('PROJECT_ROOM_DISABLED')
      }
      if (parsed?.projectId && !allowedDuringDeletion(method)
          && deletion()?.isDeleting(parsed.projectId)) {
        throw ipcError('PROJECT_DELETING')
      }
      return handler(parsed)
    })
  }
  const placeholder = (method) => {
    register(method, () => { throw ipcError('PROJECT_ENGINE_UNAVAILABLE') })
  }

  register('getPreferences', () => getPreferences())

  register('setPreferences', async (input) => {
    const value = await setPreferences(input)
    onPreferencesChanged(value)
    return value
  })

  register('templates', () => service().listTemplates())
  register('capabilities', input => ({
    agentKind: input.agentKind,
    capabilities: capabilitiesFor(input.agentKind),
  }))

  register('chooseWorkdir', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
    })
    if (result?.canceled || !result?.filePaths?.length) return { cancelled: true }
    let workdir
    try {
      workdir = fs.realpathSync.native(result.filePaths[0])
    } catch {
      throw ipcError('PROJECT_INPUT_INVALID', { reason: 'workdir-invalid' })
    }
    const existing = [...service().projects.values()]
      .map(context => context.project)
      .find(project => workdirsOverlap(project.workdir, workdir))
    if (existing) {
      return { existingProjectId: existing.id, displayName: path.basename(workdir) }
    }
    return { token: tokens.issue(workdir), displayName: path.basename(workdir) }
  })

  register('create', async (input) => {
    const workdir = tokens.consume(input.token)
    const { token: _token, seats, ...rest } = input
    return service().create({
      ...rest,
      workdir,
      name: redact(input.name, 80),
      ...(seats ? { seats: seats.map(redactSeat) } : {}),
    })
  })

  register('rename', input => service().rename({
    projectId: input.projectId,
    name: redact(input.name, 80),
  }))

  register('delete', input => {
    const deletionService = deletion()
    if (!deletionService) throw ipcError('PROJECT_ENGINE_UNAVAILABLE')
    return deletionService.delete(input)
  })

  register('retryDeletion', input => {
    const deletionService = deletion()
    if (!deletionService) throw ipcError('PROJECT_ENGINE_UNAVAILABLE')
    return deletionService.retryDeletion(input.projectId)
  })

  register('snapshot', input => {
    const deletionService = deletion()
    if (deletionService?.isDeleting(input.projectId)) {
      return {
        projectId: input.projectId,
        deleting: true,
        deletion: deletionService.progress(input.projectId),
      }
    }
    return service().snapshot(input.projectId)
  })

  register('updateSeat', input => service().updateSeat({
    ...input,
    seat: redactSeat(input.seat),
  }))

  register('addSeat', input => service().addSeat({
    ...input,
    seat: redactSeat(input.seat),
  }))

  register('removeSeat', input => service().removeSeat(input))

  register('updateProfile', input => service().updateProfile({
    ...input,
    text: redact(input.text, 16384),
  }))

  register('rollbackProfile', input => service().rollbackProfile(input))

  register('updatePlaybook', input => service().updatePlaybook(input))

  register('saveAsTemplate', input => service().saveAsTemplate({
    projectId: input.projectId,
    name: redact(input.name, 80),
  }))

  register('compact', input => service().compact(input.projectId))
  register('updatePreferences', input => service().updatePreferences(input))

  register('timelineHistory', input => service().timelineHistory(
    input.projectId,
    { cursor: input.cursor, limit: input.limit },
  ))

  register('retryEffect', input => service().retryEffect(input))

  register('diagnostics', (input) => {
    const context = service().contextFor(input.projectId)
    if (!context) throw ipcError('PROJECT_NOT_FOUND')
    return {
      projectId: input.projectId,
      readOnly: context.readOnly === true,
      readOnlyReason: context.readOnlyReason || '',
      revision: Number.isSafeInteger(context.store?.current()?.revision)
        ? context.store.current().revision
        : 0,
      storageFault: context.store?.getStorageFault?.() || null,
      deletion: deletion()?.progress(input.projectId) || null,
    }
  })

  register('gateDetail', input => service().gateDetail(input))

  register('decideGate', (input) => {
    const deletionService = deletion()
    if (deletionService?.isDeleting(input.projectId)) throw ipcError('PROJECT_DELETING')
    service().assertReady(input.projectId)
    return service().decideGate(input)
  })

  register('start', input => service().startProject({
    ...input,
    brief: redact(input.brief, 32768),
  }))
  register('interject', input => service().interject({
    ...input,
    text: redact(input.text, 32768),
  }))
  register('stopAndDeliver', input => service().stopAndDeliver(input))
  register('previewReject', input => service().previewReject(input))
  register('previewReopen', input => service().previewReopen(input))
  register('reopen', input => service().reopen({
    ...input,
    reason: redact(input.reason, 32768),
  }))
  register('resolveDrift', input => service().resolveDrift(input))
  register('cancelDriftResolution', input => service().cancelDriftResolution(input))
  register('resolveOutOfScope', input => service().resolveOutOfScope(input))
  register('residual', input => service().residual(input))
  register('unlockDirectory', input => service().unlockDirectory(input))

  return { handlers, schemas, tokens }
}

module.exports = {
  createWorkdirTokens,
  registerProjectIpc,
  schemas,
}
