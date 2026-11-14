const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { z } = require('zod')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')
const { resolveRoot } = require('../runs/path-claims.cjs')
const { ShadowRepo, checkGitVersion } = require('./shadow-git.cjs')
const {
  DEFAULT_SNAPSHOT_LIMITS,
  checkpointDefSchema,
  emptyProjectState,
  profileSchema,
  seatSchema,
} = require('./project-state-schema.cjs')
const { ProjectStore } = require('./project-store.cjs')
const {
  pendingDecisions,
  projectSnapshot,
  sidebarEntry,
} = require('./project-projection.cjs')

const PROJECT_ID = /^[A-Za-z0-9._:-]{1,120}$/
const DEFAULT_TEMPLATE_ID = 'builtin-default'
const MAX_NAME = 80
const MAX_PROFILE_TEXT = 16384

const updatePlaybookInput = z.strictObject({
  projectId: z.string().min(1).max(120),
  patch: z.strictObject({
    roundLimit: z.number().int().positive().max(100).optional(),
    continuationLimit: z.number().int().nonnegative().max(1000).optional(),
    gates: z.record(z.string().max(120), z.enum(['soft', 'hard'])).optional(),
    checkpointDefs: z.array(z.strictObject({
      key: z.string().min(1).max(120),
      gate: z.enum(['soft', 'hard']).optional(),
      roundLimit: z.number().int().positive().max(100).nullable().optional(),
      continuationLimit: z.number().int().nonnegative().max(1000).nullable().optional(),
    })).max(256).optional(),
  }),
  configRevision: z.number().int().nonnegative(),
})

function projectError(code, details = {}) {
  return Object.assign(new Error(code), { code, details })
}

function inputError(reason, details = {}) {
  return projectError('PROJECT_INPUT_INVALID', { reason, ...details })
}

function parseWith(schema, value, reason) {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw inputError(reason, {
      issues: result.error.issues.map(issue => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
        ...(issue.keys ? { keys: issue.keys } : {}),
      })),
    })
  }
  return result.data
}

function pathContains(parent, child) {
  if (parent === child) return true
  const base = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`
  return child.startsWith(base)
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
  const left = resolve(first)
  const right = resolve(second)
  if (process.platform === 'win32') {
    return pathContains(left.toLowerCase(), right.toLowerCase())
      || pathContains(right.toLowerCase(), left.toLowerCase())
  }
  return pathContains(left, right) || pathContains(right, left)
}

// B2: nested git repositories are recorded in the shadow exclude list so the
// snapshot never mistakes their pointer files for content.
function scanNestedRepos(root, { maxDepth = 8, maxEntries = 5000, maxResults = 256 } = {}) {
  const results = []
  let seen = 0
  const walk = (directory, depth) => {
    if (depth > maxDepth || results.length >= maxResults || seen >= maxEntries) return
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      seen += 1
      if (seen >= maxEntries) return
      if (entry.name === 'node_modules') continue
      const full = path.join(directory, entry.name)
      if (entry.name === '.git') {
        if (path.resolve(directory) !== path.resolve(root)) {
          const relative = path.relative(root, directory).split(path.sep).join('/')
          if (relative && !relative.startsWith('..')) results.push(relative)
        }
        continue
      }
      if (entry.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(path.resolve(root), 0)
  return results
}

class ProjectService {
  constructor({
    workspace,
    privateRoot,
    scheduler,
    templatesStore,
    ShadowRepoClass = ShadowRepo,
    checkGitVersionFn = checkGitVersion,
    resolveRootFn = resolveRoot,
    scanNestedReposFn = scanNestedRepos,
    now = () => new Date().toISOString(),
    createId = () => randomUUID(),
    writeFile = atomicWritePrivateFile,
  } = {}) {
    if (!workspace) throw inputError('workspace-required')
    if (!privateRoot) throw inputError('private-root-required')
    if (!scheduler) throw inputError('scheduler-required')
    if (!templatesStore) throw inputError('templates-store-required')
    this.workspace = workspace
    this.privateRoot = privateRoot
    this.scheduler = scheduler
    this.templatesStore = templatesStore
    this.ShadowRepoClass = ShadowRepoClass
    this.checkGitVersionFn = checkGitVersionFn
    this.resolveRootFn = resolveRootFn
    this.scanNestedReposFn = scanNestedReposFn
    this.now = now
    this.createId = createId
    this.writeFile = writeFile
    this.projects = new Map()
    this.started = false
  }

  #nowIso() {
    const value = this.now()
    const ms = typeof value === 'number' ? value : Date.parse(value)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString()
  }

  #projectDir(projectId) {
    return path.join(this.privateRoot, 'projects', projectId)
  }

  #workspaceProjects() {
    const state = this.workspace.state
    if (!Array.isArray(state.projects)) state.projects = []
    return state.projects
  }

  #availableAgentKinds() {
    const detected = typeof this.workspace.detectedAgents === 'function'
      ? this.workspace.detectedAgents()
      : this.workspace.detectedAgents
    return new Set((Array.isArray(detected) ? detected : [])
      .filter(agent => agent?.available !== false)
      .map(agent => agent.kind))
  }

  async start() {
    if (this.started) return this.list()
    this.started = true
    if (this.templatesStore.templates === null) await this.templatesStore.load()
    for (const project of this.#workspaceProjects()) {
      const context = {
        project,
        store: null,
        shadowRepo: null,
        readOnly: false,
        readOnlyReason: '',
      }
      let held = false
      try {
        await this.scheduler.holdRoot(project.workdir)
        held = true
      } catch {
        context.readOnly = true
        context.readOnlyReason = 'workdir-unavailable'
      }
      try {
        const store = new ProjectStore({ projectDir: this.#projectDir(project.id), now: this.now })
        await store.load()
        context.store = store
        if (store.isReadOnly()) {
          context.readOnly = true
          context.readOnlyReason = store.readOnlyReason()
        } else {
          context.shadowRepo = new this.ShadowRepoClass({
            gitDir: path.join(this.#projectDir(project.id), 'shadow.git'),
            workTree: project.workdir,
          })
        }
      } catch (error) {
        context.readOnly = true
        context.readOnlyReason = error?.details?.reason || 'state-invalid'
      }
      if (held) await this.scheduler.openRoot(project.workdir)
      this.projects.set(project.id, context)
    }
    return this.list()
  }

  list() {
    return [...this.projects.values()].map(context => sidebarEntry(
      this.#projectForProjection(context),
      context.store?.current() || null,
    ))
  }

  #projectForProjection(context) {
    return {
      ...context.project,
      readOnly: context.readOnly,
      readOnlyReason: context.readOnlyReason,
      residuals: [],
    }
  }

  #context(projectId) {
    const context = this.projects.get(projectId)
    if (!context) throw projectError('PROJECT_NOT_FOUND')
    return context
  }

  snapshot(projectId) {
    const context = this.#context(projectId)
    return projectSnapshot(
      this.#projectForProjection(context),
      context.store?.current() || null,
    )
  }

  pendingDecisions(now = Date.now()) {
    return pendingDecisions([...this.projects.values()].map(context => ({
      project: this.#projectForProjection(context),
      state: context.store?.current() || null,
    })), now)
  }

  #template(templateId = DEFAULT_TEMPLATE_ID, templateVersion) {
    const template = this.templatesStore.get(templateId, templateVersion)
    if (!template) throw inputError('template-not-found', { templateId })
    return template
  }

  #configFromTemplate(template, input, excludedRepos) {
    const now = this.#nowIso()
    const templateSeats = new Map(template.seatTemplates.map(seat => [seat.key, seat]))
    const available = this.#availableAgentKinds()
    const provided = Array.isArray(input?.seats) && input.seats.length ? input.seats : null
    const sourceSeats = provided || template.seatTemplates.map(seat => ({
      id: seat.key,
      roleName: seat.roleName,
      duty: seat.duty,
      agentKind: seat.agentKind,
      capabilities: [...seat.capabilities],
      profileText: seat.profileText,
    }))
    const seats = []
    const profiles = []
    const seatIds = new Set()
    for (const source of sourceSeats) {
      const id = String(source?.id || '')
      if (!PROJECT_ID.test(id) || seatIds.has(id)) throw inputError('seat-invalid', { seatId: id })
      seatIds.add(id)
      const templateSeat = templateSeats.get(id)
      const agentKind = source.agentKind ?? templateSeat?.agentKind ?? ''
      if (!agentKind || (available.size && !available.has(agentKind))) {
        throw projectError('PROJECT_CAPABILITY_UNSUPPORTED', {
          seatId: id, agentKind, capability: 'agent-kind',
        })
      }
      const profileText = String(source.profileText ?? templateSeat?.profileText ?? '')
      if (profileText.length > MAX_PROFILE_TEXT) throw inputError('profile-too-large', { seatId: id })
      const profileId = this.createId()
      profiles.push(parseWith(profileSchema, {
        id: profileId,
        seatId: id,
        version: 1,
        text: profileText,
        createdAt: now,
        source: 'default',
      }, 'profile-invalid'))
      const checkpointRoles = Array.isArray(source.checkpointRoles) && source.checkpointRoles.length
        ? source.checkpointRoles
        : template.checkpointDefs.flatMap((def) => {
          const roles = []
          if (def.leadSeatId === id) roles.push({ checkpointKey: def.key, role: 'lead' })
          if (def.reviewerSeatIds.includes(id)) roles.push({ checkpointKey: def.key, role: 'reviewer' })
          if (def.draftSeatIds.includes(id)) roles.push({ checkpointKey: def.key, role: 'draft' })
          return roles
        })
      seats.push(parseWith(seatSchema, {
        id,
        roleName: String(source.roleName ?? templateSeat?.roleName ?? ''),
        duty: String(source.duty ?? templateSeat?.duty ?? ''),
        agentKind,
        capabilities: [...new Set(source.capabilities || templateSeat?.capabilities || [])],
        checkpointRoles,
        profileVersionId: profileId,
      }, 'seat-invalid'))
    }
    const overrides = input?.playbookOverrides || {}
    const gates = overrides.gates || {}
    const defs = template.checkpointDefs.map((def) => {
      const next = structuredClone(def)
      if (gates[def.key]) next.gate = gates[def.key]
      if (overrides.checkpointDefs && Array.isArray(overrides.checkpointDefs)) {
        const patch = overrides.checkpointDefs.find(item => item.key === def.key)
        if (patch) {
          if (patch.gate) next.gate = patch.gate
          if (patch.roundLimit !== undefined) next.roundLimit = patch.roundLimit
          if (patch.continuationLimit !== undefined) next.continuationLimit = patch.continuationLimit
        }
      }
      return next
    })
    for (const def of defs) {
      const referenced = [
        def.leadSeatId, ...def.reviewerSeatIds, ...def.draftSeatIds,
      ].filter(Boolean)
      for (const seatId of referenced) {
        if (!seatIds.has(seatId)) throw inputError('seat-reference-invalid', { checkpointKey: def.key, seatId })
      }
      parseWith(checkpointDefSchema, def, 'checkpoint-def-invalid')
    }
    return {
      seats,
      profiles,
      playbook: {
        templateId: template.id,
        templateVersion: template.version,
        checkpointDefs: defs,
        roundLimit: Number.isInteger(overrides.roundLimit) ? overrides.roundLimit : 3,
        continuationLimit: Number.isInteger(overrides.continuationLimit)
          ? overrides.continuationLimit
          : 3,
      },
      settings: {
        docsRoot: String(input?.docsRoot || 'meldwork/'),
        language: input?.language === 'en' ? 'en' : 'zh',
        snapshotLimits: { ...DEFAULT_SNAPSHOT_LIMITS },
        excludedRepos,
      },
      configRevision: 1,
    }
  }

  async create(input = {}) {
    const name = String(input.name || '').trim().slice(0, MAX_NAME)
    if (!name) throw inputError('name-required')
    let rootInfo
    try {
      rootInfo = await this.resolveRootFn(input.workdir)
    } catch {
      throw inputError('workdir-invalid')
    }
    const workdir = rootInfo.realRoot
    for (const project of this.#workspaceProjects()) {
      if (workdirsOverlap(project.workdir, workdir)) throw projectError('PROJECT_WORKDIR_TAKEN')
    }
    const git = await this.checkGitVersionFn()
    if (!git?.ok) throw projectError('PROJECT_GIT_UNAVAILABLE', { version: git?.version || '' })
    const nestedRepos = await this.scanNestedReposFn(workdir)
    const template = this.#template(input.templateId || DEFAULT_TEMPLATE_ID, input.templateVersion)
    const config = this.#configFromTemplate(template, input, nestedRepos)
    let projectId = ''
    for (let attempt = 0; attempt < 100 && !projectId; attempt += 1) {
      const candidate = this.createId()
      if (PROJECT_ID.test(candidate) && !this.projects.has(candidate)
          && !fs.existsSync(this.#projectDir(candidate))) projectId = candidate
    }
    if (!projectId) throw inputError('project-id-unavailable')
    const projectDir = this.#projectDir(projectId)
    const state = emptyProjectState({ projectId, config })
    const timestamp = this.#nowIso()
    const projectRecord = {
      id: projectId,
      name,
      workdir,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 })
    try {
      await this.writeFile(
        path.join(projectDir, 'state.json'),
        `${JSON.stringify(state)}\n`,
      )
      await this.ShadowRepoClass.create({
        gitDir: path.join(projectDir, 'shadow.git'),
        workTree: workdir,
        excludePaths: nestedRepos.map(entry => `${entry}/`),
      })
    } catch (error) {
      fs.rmSync(projectDir, { recursive: true, force: true })
      throw error
    }

    const wantedKinds = [...new Set(config.seats.map(seat => seat.agentKind))]
    const available = this.#availableAgentKinds()
    const agentKinds = available.size
      ? wantedKinds.filter(kind => available.has(kind))
      : wantedKinds
    if (!agentKinds.length) {
      fs.rmSync(projectDir, { recursive: true, force: true })
      throw projectError('PROJECT_CAPABILITY_UNSUPPORTED', {
        capability: 'agent-kind', agentKinds: wantedKinds,
      })
    }
    const mainGroup = {
      id: this.createId(),
      name: config.settings.language === 'en' ? 'Main chat' : '主流程',
      topic: '',
      agentKinds,
      workdir,
      allowWrite: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      projectId,
      projectRole: 'main',
    }
    const workspaceState = this.workspace.state
    const previousProjects = workspaceState.projects
    const previousGroups = workspaceState.groups
    workspaceState.projects = [...(previousProjects || []), projectRecord]
    workspaceState.groups = [mainGroup, ...(previousGroups || [])]
    try {
      await this.workspace.save()
      this.workspace.emitChanged()
    } catch (error) {
      if (error?.phase !== 'after-commit') {
        workspaceState.projects = previousProjects
        workspaceState.groups = previousGroups
        fs.rmSync(projectDir, { recursive: true, force: true })
        throw error
      }
    }

    const store = new ProjectStore({ projectDir, now: this.now })
    await store.load()
    const context = {
      project: projectRecord,
      store,
      shadowRepo: new this.ShadowRepoClass({
        gitDir: path.join(projectDir, 'shadow.git'),
        workTree: workdir,
        excludePaths: nestedRepos.map(entry => `${entry}/`),
      }),
      readOnly: false,
      readOnlyReason: '',
    }
    this.projects.set(projectId, context)
    return this.snapshot(projectId)
  }

  async rename({ projectId, name }) {
    const context = this.#context(projectId)
    const nextName = String(name || '').trim().slice(0, MAX_NAME)
    if (!nextName) throw inputError('name-required')
    const previous = context.project.name
    context.project.name = nextName
    context.project.updatedAt = this.#nowIso()
    try {
      await this.workspace.save()
      this.workspace.emitChanged()
    } catch (error) {
      if (error?.phase !== 'after-commit') {
        context.project.name = previous
        throw error
      }
    }
    return this.snapshot(projectId)
  }

  #assertWritable(context) {
    if (context.readOnly || !context.store || context.store.isReadOnly()) {
      throw projectError('PROJECT_READ_ONLY', {
        reason: context.readOnlyReason || context.store?.readOnlyReason() || 'read-only',
      })
    }
  }

  async #enqueueConfig(projectId, mutate) {
    const context = this.#context(projectId)
    this.#assertWritable(context)
    return context.store.enqueue((state) => {
      const result = mutate(state)
      state.config.configRevision += 1
      return { next: state, result }
    })
  }

  #assertConfigRevision(state, configRevision) {
    if (state.config.configRevision !== configRevision) {
      throw projectError('PROJECT_CONFIG_STALE', {
        current: state.config.configRevision,
        submitted: configRevision,
      })
    }
  }

  #assertSeatAgent(seat) {
    const available = this.#availableAgentKinds()
    if (available.size && !available.has(seat.agentKind)) {
      throw projectError('PROJECT_CAPABILITY_UNSUPPORTED', {
        seatId: seat.id, agentKind: seat.agentKind, capability: 'agent-kind',
      })
    }
  }

  async updateSeat({ projectId, seat, configRevision }) {
    const parsed = parseWith(seatSchema, seat, 'seat-invalid')
    this.#assertSeatAgent(parsed)
    return this.#enqueueConfig(projectId, (state) => {
      this.#assertConfigRevision(state, configRevision)
      const index = state.config.seats.findIndex(item => item.id === parsed.id)
      if (index < 0) throw projectError('PROJECT_NOT_FOUND', { seatId: parsed.id })
      const profile = state.config.profiles.find(item => (
        item.id === parsed.profileVersionId && item.seatId === parsed.id
      ))
      if (!profile) throw inputError('profile-not-found', { seatId: parsed.id })
      state.config.seats[index] = parsed
      return parsed
    })
  }

  async addSeat({ projectId, seat, configRevision }) {
    const { profileText, ...seatValue } = seat || {}
    const parsed = parseWith(seatSchema, seatValue, 'seat-invalid')
    this.#assertSeatAgent(parsed)
    return this.#enqueueConfig(projectId, (state) => {
      this.#assertConfigRevision(state, configRevision)
      if (state.config.seats.some(item => item.id === parsed.id)) {
        throw inputError('seat-already-exists', { seatId: parsed.id })
      }
      let profile = state.config.profiles.find(item => (
        item.id === parsed.profileVersionId && item.seatId === parsed.id
      ))
      if (!profile) {
        profile = parseWith(profileSchema, {
          id: this.createId(),
          seatId: parsed.id,
          version: 1,
          text: String(profileText || ''),
          createdAt: this.#nowIso(),
          source: 'default',
        }, 'profile-invalid')
        state.config.profiles.push(profile)
        parsed.profileVersionId = profile.id
      }
      state.config.seats.push(parsed)
      return parsed
    })
  }

  async removeSeat({ projectId, seatId, configRevision }) {
    return this.#enqueueConfig(projectId, (state) => {
      this.#assertConfigRevision(state, configRevision)
      const seat = state.config.seats.find(item => item.id === seatId)
      if (!seat) throw projectError('PROJECT_NOT_FOUND', { seatId })
      const referenced = state.config.playbook.checkpointDefs.some(def => (
        def.leadSeatId === seatId
          || def.reviewerSeatIds.includes(seatId)
          || def.draftSeatIds.includes(seatId)
      )) || state.instances.some(instance => (
        instance.activeInvocations.some(invocation => invocation.seatId === seatId)
      ))
      if (referenced) throw projectError('PROJECT_SEAT_IN_USE', { seatId })
      state.config.seats = state.config.seats.filter(item => item.id !== seatId)
      return true
    })
  }

  async updateProfile({ projectId, seatId, text, configRevision }) {
    const value = String(text || '')
    if (value.length > MAX_PROFILE_TEXT) throw inputError('profile-too-large', { seatId })
    return this.#enqueueConfig(projectId, (state) => {
      this.#assertConfigRevision(state, configRevision)
      const seat = state.config.seats.find(item => item.id === seatId)
      if (!seat) throw projectError('PROJECT_NOT_FOUND', { seatId })
      const version = Math.max(0, ...state.config.profiles
        .filter(item => item.seatId === seatId)
        .map(item => item.version)) + 1
      const profile = profileSchema.parse({
        id: this.createId(),
        seatId,
        version,
        text: value,
        createdAt: this.#nowIso(),
        source: 'user-edit',
      })
      state.config.profiles.push(profile)
      seat.profileVersionId = profile.id
      return profile
    })
  }

  async rollbackProfile({ projectId, seatId, profileId, configRevision }) {
    return this.#enqueueConfig(projectId, (state) => {
      this.#assertConfigRevision(state, configRevision)
      const seat = state.config.seats.find(item => item.id === seatId)
      if (!seat) throw projectError('PROJECT_NOT_FOUND', { seatId })
      const target = state.config.profiles.find(item => (
        item.id === profileId && item.seatId === seatId
      ))
      if (!target) throw inputError('profile-not-found', { seatId, profileId })
      const version = Math.max(0, ...state.config.profiles
        .filter(item => item.seatId === seatId)
        .map(item => item.version)) + 1
      const profile = profileSchema.parse({
        id: this.createId(),
        seatId,
        version,
        text: target.text,
        createdAt: this.#nowIso(),
        source: 'rollback',
      })
      state.config.profiles.push(profile)
      seat.profileVersionId = profile.id
      return profile
    })
  }

  async updatePlaybook(input) {
    const result = updatePlaybookInput.safeParse(input)
    if (!result.success) {
      throw inputError('playbook-invalid', {
        issues: result.error.issues.map(issue => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      })
    }
    const { projectId, patch, configRevision } = result.data
    return this.#enqueueConfig(projectId, (state) => {
      this.#assertConfigRevision(state, configRevision)
      if (patch.roundLimit !== undefined) state.config.playbook.roundLimit = patch.roundLimit
      if (patch.continuationLimit !== undefined) {
        state.config.playbook.continuationLimit = patch.continuationLimit
      }
      if (patch.gates) {
        for (const [key, gate] of Object.entries(patch.gates)) {
          const def = state.config.playbook.checkpointDefs.find(item => item.key === key)
          if (!def) throw inputError('checkpoint-not-found', { key })
          if (this.#checkpointStarted(state, key)) {
            throw inputError('checkpoint-started', { key })
          }
          def.gate = gate
        }
      }
      for (const patchDef of patch.checkpointDefs || []) {
        const def = state.config.playbook.checkpointDefs.find(item => item.key === patchDef.key)
        if (!def) throw inputError('checkpoint-not-found', { key: patchDef.key })
        if (this.#checkpointStarted(state, patchDef.key)) {
          throw inputError('checkpoint-started', { key: patchDef.key })
        }
        if (patchDef.gate) def.gate = patchDef.gate
        if (patchDef.roundLimit !== undefined) def.roundLimit = patchDef.roundLimit
        if (patchDef.continuationLimit !== undefined) {
          def.continuationLimit = patchDef.continuationLimit
        }
      }
      return state.config.playbook
    })
  }

  #checkpointStarted(state, key) {
    return state.instances.some(instance => (
      instance.checkpointKey === key && instance.state !== 'pending'
    ))
  }

  async saveAsTemplate({ projectId, name }) {
    const context = this.#context(projectId)
    this.#assertWritable(context)
    const state = context.store.current()
    const templateName = String(name || '').trim().slice(0, MAX_NAME)
    if (!templateName) throw inputError('name-required')
    return this.templatesStore.save({
      name: templateName,
      checkpointDefs: state.config.playbook.checkpointDefs,
      seatTemplates: state.config.seats.map((seat) => {
        const profile = state.config.profiles.find(item => item.id === seat.profileVersionId)
        return {
          key: seat.id,
          roleName: seat.roleName,
          duty: seat.duty,
          agentKind: seat.agentKind,
          capabilities: [...seat.capabilities],
          profileText: profile?.text || '',
        }
      }),
    })
  }
}

module.exports = {
  ProjectService,
  scanNestedRepos,
}
