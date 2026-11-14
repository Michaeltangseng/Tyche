const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { z } = require('zod')
const { atomicWritePrivateFile } = require('../security/private-file.cjs')
const { redactSecrets } = require('../security/secret-redaction.cjs')
const { claimsOverlap, makeClaim, resolveRoot } = require('../runs/path-claims.cjs')
const { ShadowRepo, checkGitVersion } = require('./shadow-git.cjs')
const {
  DEFAULT_SNAPSHOT_LIMITS,
  checkpointDefSchema,
  emptyProjectState,
  profileSchema,
  seatSchema,
} = require('./project-state-schema.cjs')
const { ProjectStore } = require('./project-store.cjs')
const { PendingMessageStore, TimelineHistoryStore } = require('./project-timeline.cjs')
const { CheckpointEngine, detectionEffectId } = require('./checkpoint-engine.cjs')
const { validateSeatCapabilities } = require('./agent-capabilities.cjs')
const { buildProjectChatContext } = require('./project-chat-context.cjs')
const { buildProjectRoomPrompt } = require('./project-room-prompt.cjs')
const {
  CHECKPOINT_MARKER_PREFIX,
  REVIEW_MARKER_PREFIX,
  parseCheckpointSignal,
  parseReviewVerdict,
} = require('./signal-markers.cjs')
const { projectRoomSessionKey } = require('../workspace/local-workspace-context.cjs')
const { createEffectHandlers } = require('./effect-handlers.cjs')
const {
  pendingDecisions,
  projectSnapshot,
  sidebarEntry,
} = require('./project-projection.cjs')
const {
  acceptanceBlockers,
  impactPreview,
} = require('./project-progress.cjs')
const { allowedGateOutcomes } = require('./checkpoint-transitions.cjs')

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
    clock = Date.now,
    isPreviewEnabled = () => true,
    invoke,
    cancelInvocation,
    userGit,
    effectHooks = {},
    effectHandlers,
    getManifest,
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
    this.clock = typeof clock === 'function' ? clock : Date.now
    this.previewEnabledFn = typeof isPreviewEnabled === 'function'
      ? isPreviewEnabled
      : () => true
    this.invoke = invoke
    this.cancelInvocation = cancelInvocation
    this.userGit = userGit
    this.effectHooks = effectHooks
    this.effectHandlers = effectHandlers
    this.getManifest = getManifest
    this.projectControllers = new Map()
    this.maintenanceRuns = new Map()
    this.maintenanceEnsures = new Map()
    this.projects = new Map()
    this.started = false
    this.pendingStores = new Map()
    this.timelineStores = new Map()
    this.changeListeners = new Set()
    this.changeTimers = new Map()
    this.changePending = new Map()
    this.changeLastEmit = new Map()
  }

  onChanged(listener) {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  isPreviewEnabled() {
    return this.previewEnabledFn() === true
  }

  #queueChange(projectId, revision) {
    const pending = this.changePending.get(projectId)
    const nextRevision = Math.max(pending?.revision || 0, revision)
    const now = this.clock()
    const last = this.changeLastEmit.get(projectId) || 0
    if (!pending && now - last >= 100) {
      this.changeLastEmit.set(projectId, now)
      for (const listener of [...this.changeListeners]) {
        try {
          listener({ projectId, revision: nextRevision })
        } catch {
          // A failed listener must not affect the project store.
        }
      }
      return
    }
    this.changePending.set(projectId, { revision: nextRevision })
    if (this.changeTimers.has(projectId)) return
    const delay = Math.max(0, 100 - (now - last))
    const timer = setTimeout(() => {
      this.changeTimers.delete(projectId)
      const queued = this.changePending.get(projectId)
      this.changePending.delete(projectId)
      if (!queued) return
      this.changeLastEmit.set(projectId, this.clock())
      for (const listener of [...this.changeListeners]) {
        try {
          listener({ projectId, revision: queued.revision })
        } catch {
          // Ignore listener failures.
        }
      }
    }, delay)
    if (timer.unref) timer.unref()
    this.changeTimers.set(projectId, timer)
  }

  #registerContext(projectId, context) {
    this.projects.set(projectId, context)
    if (context.store) {
      context.store.onCommitted(({ revision }) => this.#queueChange(projectId, revision))
    }
  }

  contextFor(projectId) {
    return this.projects.get(projectId) || null
  }

  removeContext(projectId) {
    this.projects.delete(projectId)
    const timer = this.changeTimers.get(projectId)
    if (timer) clearTimeout(timer)
    this.changeTimers.delete(projectId)
    this.changePending.delete(projectId)
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
          this.#createEngine(context)
          try {
            await context.engine.recover()
          } catch (error) {
            context.readOnly = true
            context.readOnlyReason = error?.code || 'engine-recovery-failed'
          }
        }
      } catch (error) {
        context.readOnly = true
        context.readOnlyReason = error?.details?.reason || 'state-invalid'
      }
      if (held) await this.scheduler.openRoot(project.workdir)
      this.#registerContext(project.id, context)
      if (!context.readOnly) {
        try {
          await this.runProjectEffects(project.id)
        } catch (error) {
          context.readOnly = true
          context.readOnlyReason = error?.code || 'project-effects-failed'
        }
      }
    }
    return this.list()
  }

  list() {
    return [...this.projects.values()].map(context => sidebarEntry(
      this.#projectForProjection(context),
      context.store?.current() || null,
    ))
  }

  async invokeProjectAgent({
    effect, projectId, checkpointId, role, seatId, round, sessionGeneration,
  }) {
    const context = this.#context(projectId)
    const state = context.store.current()
    const instance = state.instances.find(item => item.id === checkpointId)
    if (!instance) throw projectError('PROJECT_NOT_FOUND', { checkpointId })
    const def = state.config.playbook.checkpointDefs
      .find(item => item.key === instance.checkpointKey)
    const seat = state.config.seats.find(item => item.id === seatId)
    if (!seat) throw projectError('PROJECT_NOT_FOUND', { seatId })
    const mainGroup = this.#mainGroupFor(context.project.id)
    if (!mainGroup) throw inputError('main-chat-missing')
    const startMessage = (this.workspace.state.messages || []).find(message => (
      message.groupId === mainGroup.id && message.projectRoom?.start === true
    ))
    let diffText = ''
    if (role === 'reviewer' && context.shadowRepo && instance.candidate) {
      const previous = instance.rounds.at(-1)?.candidate
      if (previous && previous !== instance.candidate) {
        try {
          const stats = await context.shadowRepo.numstat(
            previous, instance.candidate, def?.targetFiles || [],
          )
          const parts = []
          for (const entry of stats.slice(0, 20)) {
            const diff = await context.shadowRepo.fileDiff(
              previous, instance.candidate, entry.path, { maxBytes: 20000 },
            )
            parts.push(`--- ${entry.path} (+${entry.added}/-${entry.removed})\n${diff.text}`)
          }
          diffText = parts.join('\n')
        } catch { /* diff is best effort */ }
      }
    }
    const prompt = buildProjectRoomPrompt({
      project: context.project,
      state,
      instance,
      def,
      seat,
      role: role === 'reviewer' ? 'review' : role,
      round,
      mainGroup,
      brief: String(startMessage?.content || ''),
      diffText,
    })
    const contextPack = this.workspace.createContextPack({
      group: mainGroup,
      taskId: instance.id,
      mode: 'manual',
      targetKinds: [seat.agentKind],
      message: { id: instance.id, role: 'user', content: prompt },
    })
    const capabilities = seat.capabilities || []
    const permissionMode = capabilities.includes('write-workdir') || capabilities.includes('write-drafts')
      ? 'workspace-write'
      : (capabilities.includes('read-exec') ? 'read-exec' : 'read-only')
    const sessionKey = projectRoomSessionKey({
      projectId: context.project.id,
      checkpointId: instance.id,
      seatId,
      kind: seat.agentKind,
      generation: instance.sessionGeneration,
    })
    const controller = new AbortController()
    this.projectControllers.set(effect.id, controller)
    let invocation
    try {
      invocation = await this.workspace.invokeAgent(
        mainGroup,
        seat.agentKind,
        'manual',
        controller.signal,
        instance.id,
        {
          taskId: instance.id,
          sessionPolicy: 'project-room',
          promptOverride: prompt,
          contextPackId: contextPack.contextPackId,
          permissionMode,
          sessionKey,
          saveSession: role !== 'reviewer',
          deferMessage: true,
          watchdog: { onInactivity: 'remind', hardLimitMs: null },
        },
      )
    } finally {
      this.projectControllers.delete(effect.id)
    }
    const rawText = String(
      invocation?.pendingMessage?.content
        || invocation?.pendingMessage?.text
        || invocation?.message?.content
        || '',
    )
    const textLines = rawText.split(/\r?\n/)
    let markerIndex = -1
    for (let index = textLines.length - 1; index >= 0; index -= 1) {
      if (!textLines[index].trim()) continue
      markerIndex = index
      break
    }
    const markerLine = markerIndex >= 0 ? textLines[markerIndex].trim() : ''
    const stripMarker = (prefix) => markerLine.startsWith(prefix) && markerLine.endsWith(']]')
    let signal = role === 'reviewer' ? null : parseCheckpointSignal(rawText)
    let verdict = role === 'reviewer' ? parseReviewVerdict(rawText) : null
    if (role !== 'reviewer' && !signal) signal = null
    if (role === 'reviewer' && !verdict) verdict = null
    const bodyLines = [...textLines]
    if (stripMarker(CHECKPOINT_MARKER_PREFIX) || stripMarker(REVIEW_MARKER_PREFIX)) {
      bodyLines.splice(markerIndex, 1)
    }
    const body = bodyLines.join('\n').trim()
    let reviewFile = ''
    if (role === 'reviewer' && body) {
      reviewFile = path.posix.join(
        'meldwork', 'reviews', instance.checkpointKey, `r${Math.max(1, round)}-${seatId}.md`,
      )
      const absolute = path.join(context.project.workdir, ...reviewFile.split('/'))
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, `${body}\n`)
    }
    const sourceKey = [context.project.id, 'invoke', effect.id]
    const pendingMessage = body
      ? {
        sourceKey,
        body,
        metadata: {
          id: `msg-${createHash('sha256').update(JSON.stringify(sourceKey), 'utf8').digest('hex')}`,
          groupId: mainGroup.id,
          role: 'agent',
          agentKind: seat.agentKind,
          createdAt: this.#nowIso(),
          projectRoom: {
            projectId: context.project.id,
            checkpointId: instance.id,
            seatId,
            role: role === 'reviewer' ? 'review' : role,
            round: Math.max(1, round),
            generation: sessionGeneration,
            ...(verdict ? { verdict } : {}),
            ...(signal ? { signal } : {}),
            ...(reviewFile ? { reviewFile } : {}),
          },
        },
      }
      : null
    return {
      role,
      seatId,
      round,
      sessionGeneration,
      marker: role === 'reviewer' ? (verdict || '') : (signal || ''),
      ...(pendingMessage ? { pendingMessage } : {}),
    }
  }

  cancelProjectInvocation({ effect }) {
    const controller = this.projectControllers.get(effect?.id)
    controller?.abort()
    return true
  }

  #appendDecision(context, params) {
    const decision = params?.decision
    if (!decision?.gateId) return null
    const directory = path.join(context.project.workdir, 'meldwork')
    const file = path.join(directory, 'decisions.md')
    const marker = `<!-- meldwork:${params.effectId || decision.gateId} -->`
    let existing = ''
    try { existing = fs.readFileSync(file, 'utf8') } catch { existing = '' }
    if (existing.includes(marker)) return null
    fs.mkdirSync(directory, { recursive: true })
    const comment = redactSecrets(String(decision.comment || '')).trim()
    const lines = [
      `## ${decision.decidedAt || ''} ${params.checkpointKey || ''}`.trim(),
      '',
      `- gate: ${decision.gateId} (revision ${decision.gateRevision})`,
      `- reason: ${decision.reason}`,
      `- outcome: ${decision.outcome}`,
      `- candidate: ${decision.candidateCommit || ''}`,
      ...(decision.upstreamCheckpointId ? [`- upstream: ${decision.upstreamCheckpointId}`] : []),
      ...(decision.impactHash ? [`- impact: ${decision.impactHash}`] : []),
      ...(decision.driftChoice ? [`- drift: ${decision.driftChoice}`] : []),
      `- commitToGit: ${decision.commitToGit === true}`,
      '',
      comment || '(no comment)',
      '',
      marker,
      '',
    ]
    fs.appendFileSync(file, `${lines.join('\n')}\n`)
    return null
  }

  #stampChanges(context, params) {
    const commit = String(params?.candidateCommit || '')
    if (!commit) return null
    const file = path.join(context.project.workdir, 'meldwork', 'changes.md')
    let source = ''
    try { source = fs.readFileSync(file, 'utf8') } catch { return null }
    const marker = `<!-- meldwork:${params.effectId || commit} -->`
    if (source.includes(marker)) return null
    const targets = new Set(Array.isArray(params.targetFiles) ? params.targetFiles : [])
    let changed = false
    const lines = source.split(/\r?\n/).map((line) => {
      const match = /^(-\s*\[path=)([^\s\]]+)([^\]]*)\]/.exec(line)
      if (!match || /\bto=/.test(match[3])) return line
      if (targets.size && !targets.has(match[2])) return line
      changed = true
      return `${match[1]}${match[2]}${match[3]} to=${commit}]`
    })
    if (!changed) return null
    lines.push('', marker, '')
    fs.writeFileSync(file, lines.join('\n'))
    return null
  }

  #handlersFor(context) {
    const projectId = context.project.id
    if (typeof this.effectHandlers === 'function') {
      return this.effectHandlers({ context, projectId })
    }
    const hooks = {
      writeReviewFile: async () => null,
      appendDecision: params => this.#appendDecision(context, params),
      stampChanges: params => this.#stampChanges(context, params),
      notify: async () => null,
      ...this.effectHooks,
      appendMessage: async (params) => {
        const store = this.pendingMessageStore(projectId)
        const payload = store.read(params?.ref)
        if (!payload) return null
        const metadata = payload.metadata || {}
        this.workspace.insertProjectRoomMessage({
          id: metadata.id,
          groupId: metadata.groupId,
          role: metadata.role,
          agentKind: metadata.agentKind,
          content: payload.body,
          createdAt: metadata.createdAt,
          projectRoom: metadata.projectRoom,
          ...(metadata.trace ? { trace: metadata.trace } : {}),
          ...(metadata.elapsedMs != null ? { elapsedMs: metadata.elapsedMs } : {}),
        })
        await store.consume(params.ref)
        return null
      },
      appendTimeline: async (params) => {
        const id = createHash('sha256')
          .update(JSON.stringify(params?.sourceKey || []), 'utf8')
          .digest('hex')
        await this.timelineStore(projectId).append({
          id,
          record: { ...params.record, id },
        })
        return null
      },
    }
    return createEffectHandlers({
      shadowRepo: context.shadowRepo,
      userGit: this.userGit,
      ...hooks,
    })
  }

  #createEngine(context) {
    const state = context.store.current()
    const readExecSeatIds = (state?.config.seats || [])
      .filter(seat => seat.capabilities.includes('read-exec'))
      .map(seat => seat.id)
    context.engine = new CheckpointEngine({
      projectId: context.project.id,
      store: context.store,
      scheduler: this.scheduler,
      handlers: this.#handlersFor(context),
      invoke: this.invoke || (input => this.invokeProjectAgent(input)),
      cancelInvocation: this.cancelInvocation || (input => this.cancelProjectInvocation(input)),
      workdir: context.project.workdir,
      readExecSeatIds,
      getManifest: this.getManifest,
      softBlockers: (projectState) => {
        const checks = Object.keys(projectState?.chatWriteChecks || {}).length
        const pendingDetection = (projectState?.projectEffects || []).some(effect => (
          effect.type === 'detect-accepted-changes'
            && !['consumed', 'voided', 'failed'].includes(effect.status)
        ))
        return checks || pendingDetection ? { detection: true } : {}
      },
      shadowRepo: context.shadowRepo,
      snapshotLimits: state?.config.settings.snapshotLimits || {},
      stageMessage: input => this.stageProjectMessage(context.project.id, input),
      now: this.now,
    })
    return context.engine
  }

  engineFor(projectId) {
    return this.projects.get(projectId)?.engine || null
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

  async gateDetail({ projectId, gateId, gateRevision }) {
    const context = this.#context(projectId)
    const state = context.store?.current()
    if (!state) throw projectError('PROJECT_NOT_FOUND', { projectId })
    const instance = state.instances.find(item => item.gate?.id === gateId)
    if (!instance || instance.gate.revision !== gateRevision) {
      throw projectError('PROJECT_GATE_STALE')
    }
    const gate = instance.gate
    const def = state.config.playbook.checkpointDefs
      .find(item => item.key === instance.checkpointKey)
    const paths = def?.targetFiles || []
    let commitToGit = {
      available: false,
      reasons: [{ path: '', reason: 'git-unavailable' }],
    }
    if (this.userGit?.userRepoPreflight && context.shadowRepo?.entriesAtCommit
        && gate.candidateCommit && paths.length) {
      try {
        const acceptedEntries = await context.shadowRepo.entriesAtCommit(
          gate.candidateCommit,
          paths,
        )
        const preflight = await this.userGit.userRepoPreflight({
          workTree: context.project.workdir,
          paths,
          acceptedEntries,
        })
        commitToGit = {
          available: preflight.ok === true,
          reasons: preflight.reasons || [],
        }
      } catch {
        commitToGit = {
          available: false,
          reasons: [{ path: '', reason: 'git-preflight-failed' }],
        }
      }
    }
    return {
      projectId,
      checkpointId: instance.id,
      checkpointKey: instance.checkpointKey,
      checkpointName: def?.name || instance.checkpointKey,
      gateId: gate.id,
      gateRevision: gate.revision,
      reason: gate.reason,
      question: ['question', 'draft-question'].includes(gate.reason),
      candidateCommit: gate.candidateCommit,
      allowedOutcomes: allowedGateOutcomes(gate.reason),
      acceptBlockers: acceptanceBlockers(state, instance.id).blockers,
      firstScreen: gate.firstScreen,
      commitToGit,
    }
  }

  assertReady(projectId) {
    const context = this.#context(projectId)
    this.#assertWritable(context)
    return context
  }

  async compact(projectId) {
    const context = this.#context(projectId)
    this.#assertWritable(context)
    const result = await context.store.compactNow()
    return { revision: result.revision, durable: result.durable }
  }

  pendingMessageStore(projectId) {
    if (!this.pendingStores.has(projectId)) {
      this.pendingStores.set(projectId, new PendingMessageStore({
        projectDir: this.#projectDir(projectId),
        now: this.now,
      }))
    }
    return this.pendingStores.get(projectId)
  }

  timelineStore(projectId) {
    if (!this.timelineStores.has(projectId)) {
      this.timelineStores.set(projectId, new TimelineHistoryStore({
        projectDir: this.#projectDir(projectId),
        now: this.now,
      }))
    }
    return this.timelineStores.get(projectId)
  }

  async stageProjectMessage(projectId, input) {
    this.#context(projectId)
    return this.pendingMessageStore(projectId).stage(input)
  }

  async consumeProjectMessage(projectId, ref) {
    this.#context(projectId)
    return this.pendingMessageStore(projectId).consume(ref)
  }

  insertProjectMessage(input) {
    return this.workspace.insertProjectRoomMessage(input)
  }

  timelineHistory(projectId, { cursor, limit } = {}) {
    const context = this.#context(projectId)
    const state = context.store?.current() || null
    const pending = []
    for (const effect of state?.projectEffects || []) {
      if (effect.type === 'append-timeline' && effect.params?.record) {
        pending.push(effect.params.record)
      }
    }
    for (const instance of state?.instances || []) {
      for (const effect of instance.effects || []) {
        if (effect.type === 'append-timeline' && effect.params?.record) {
          pending.push(effect.params.record)
        }
      }
    }
    return this.timelineStore(projectId).read({
      projectId,
      cursor,
      limit: limit === undefined ? 50 : limit,
      pending,
    })
  }

  #newInstance(checkpointKey) {
    return {
      id: this.createId(),
      checkpointKey,
      state: 'pending',
      seq: 0,
      epoch: 0,
      round: 0,
      roundsSinceHuman: 0,
      continuations: 0,
      sessionGeneration: 0,
      candidate: null,
      rounds: [],
      roundsSummary: [],
      leaseRequests: [],
      activeInvocations: [],
      pendingStart: null,
      drafts: [],
      interjections: [],
      gate: null,
      blockedOn: null,
      effects: [],
      artifactVersions: [],
      readVersions: {},
      decisions: [],
    }
  }

  #mainGroupFor(projectId) {
    return (this.workspace.state.groups || []).find(group => (
      group.projectId === projectId && group.projectRole === 'main'
    )) || null
  }

  #messageIdFor(sourceKey) {
    return `msg-${createHash('sha256')
      .update(JSON.stringify(sourceKey), 'utf8')
      .digest('hex')}`
  }

  async #stageUserMessage(projectId, { sourceKey, body, checkpointId, generation, extra = {} }) {
    const group = this.#mainGroupFor(projectId)
    if (!group || !String(body || '').trim()) return null
    const id = this.#messageIdFor(sourceKey)
    return this.stageProjectMessage(projectId, {
      sourceKey,
      body,
      metadata: {
        id,
        groupId: group.id,
        role: 'user',
        agentKind: '',
        createdAt: this.#nowIso(),
        projectRoom: {
          projectId,
          ...(checkpointId ? { checkpointId, generation } : {}),
          ...extra,
        },
      },
    })
  }

  async #queueProjectMessage(projectId, staged) {
    if (!staged?.ref) return
    const effectId = `message-${staged.ref}`
    await this.#context(projectId).store.enqueue((state) => {
      if (!state.projectEffects.some(effect => effect.id === effectId)) {
        state.projectEffects.push({
          id: effectId,
          type: 'append-message',
          category: 'required',
          status: 'pending',
          params: { ref: staged.ref },
          result: null,
          error: null,
          startedAt: null,
          finishedAt: null,
        })
      }
      return { next: state }
    })
    await this.runProjectEffects(projectId)
  }

  async startProject({ projectId, brief }) {
    const context = this.#context(projectId)
    this.#assertWritable(context)
    const state = context.store.current()
    if (state.instances.length) throw projectError('PROJECT_ALREADY_STARTED')
    const def = state.config.playbook.checkpointDefs[0]
    if (!def) throw inputError('playbook-empty')
    const staged = await this.#stageUserMessage(projectId, {
      sourceKey: [projectId, 'start'],
      body: brief,
      extra: { start: true },
    })
    const instance = this.#newInstance(def.key)
    await context.store.enqueue((next) => {
      next.instances.push(instance)
      return { next }
    })
    await this.#queueProjectMessage(projectId, staged)
    if (typeof this.onStart === 'function') {
      await this.onStart({ context, brief: String(brief || ''), instance })
    }
    await context.engine.dispatch(instance.id, {
      type: 'DEPS_READY',
      at: this.#nowIso(),
    })
    return { checkpointId: instance.id }
  }

  async interject({ projectId, checkpointId, text }) {
    const context = this.#context(projectId)
    this.#assertWritable(context)
    const result = await context.engine.dispatch(checkpointId, {
      type: 'INTERJECT',
      at: this.#nowIso(),
      payload: { content: text },
    })
    if (result.ignored) throw projectError('PROJECT_TARGET_CHANGED')
    return { checkpointId }
  }

  async stopAndDeliver({ projectId, checkpointId }) {
    const context = this.#context(projectId)
    this.#assertWritable(context)
    const result = await context.engine.dispatch(checkpointId, {
      type: 'STOP_AND_DELIVER',
      at: this.#nowIso(),
    })
    if (result.ignored) throw projectError('PROJECT_TARGET_CHANGED')
    return { checkpointId }
  }

  async decideGate(input) {
    const { projectId } = input
    let rejectPreview = null
    let acceptDivergence = null
    const context = this.#context(projectId)
    this.#assertWritable(context)
    const state = context.store.current()
    const instance = state.instances.find(item => item.gate?.id === input.gateId)
    if (!instance) throw projectError('PROJECT_GATE_STALE')
    const gate = instance.gate
    if (gate.revision !== input.gateRevision) throw projectError('PROJECT_GATE_STALE')
    if (!allowedGateOutcomes(gate.reason).includes(input.outcome)) {
      throw projectError('PROJECT_GATE_OUTCOME_UNAVAILABLE', { reason: gate.reason })
    }
    if (gate.candidateCommit && input.candidateCommit !== gate.candidateCommit) {
      throw projectError('PROJECT_GATE_STALE')
    }
    if (input.outcome === 'continue' && !String(input.comment || '').trim()) {
      throw projectError('PROJECT_GATE_COMMENT_REQUIRED')
    }
    if (input.outcome === 'reject-upstream') {
      const upstreamIds = new Set(Object.keys(instance.readVersions || {}))
      const def = state.config.playbook.checkpointDefs
        .find(item => item.key === instance.checkpointKey)
      for (const key of def?.dependsOn || []) {
        const upstream = state.instances.find(item => item.checkpointKey === key)
        if (upstream) upstreamIds.add(upstream.id)
      }
      if (!upstreamIds.has(input.upstreamCheckpointId)) {
        throw projectError('PROJECT_IMPACT_CHANGED')
      }
      const preview = impactPreview(state, input.upstreamCheckpointId)
      if (preview.impactHash !== input.impactHash) {
        throw projectError('PROJECT_IMPACT_CHANGED')
      }
      rejectPreview = preview
    }
    if (input.outcome === 'accept') {
      const blockers = acceptanceBlockers(state, instance.id)
      if (blockers.blocked) {
        throw projectError('PROJECT_ACCEPT_BLOCKED', { blockers: blockers.blockers })
      }
      if (context.shadowRepo && instance.candidate) {
        const def = state.config.playbook.checkpointDefs
          .find(item => item.key === instance.checkpointKey)
        let verified
        try {
          verified = await context.shadowRepo.verifyAgainst({
            effectId: `gate-candidate:${gate.id}:${gate.revision}`,
            commit: instance.candidate,
            paths: def?.targetFiles || [],
            placeholderList: state.placeholders || [],
            limits: state.config.settings.snapshotLimits,
          })
        } catch {
          throw projectError('PROJECT_CANDIDATE_DIVERGED', { files: [] })
        }
        if (verified.intact === false) {
          if (input.acceptCandidate !== true) {
            throw projectError('PROJECT_CANDIDATE_DIVERGED', {
              files: verified.differing || [],
            })
          }
          const observed = await context.shadowRepo.snapshot({
            effectId: `gate-observed:${gate.id}:${gate.revision}`,
            targets: [],
            placeholderList: state.placeholders || [],
            limits: state.config.settings.snapshotLimits,
            isOptional: false,
          })
          acceptDivergence = {
            files: verified.differing || [],
            observedCommit: observed.commit,
            checkpointId: instance.id,
            acceptedCommit: instance.candidate,
            baseVersionId: instance.artifactVersions.at(-1)?.id || null,
          }
        }
      }
    }
    const staged = String(input.comment || '').trim()
      ? await this.#stageUserMessage(projectId, {
        sourceKey: [projectId, 'gate', input.gateId, input.gateRevision],
        body: input.comment,
        checkpointId: instance.id,
        generation: instance.sessionGeneration,
        extra: {
          gateId: input.gateId,
          revision: input.gateRevision,
          outcome: input.outcome,
        },
      })
      : null
    const result = await context.engine.dispatch(instance.id, {
      type: 'GATE_DECIDED',
      at: this.#nowIso(),
      payload: {
        gateId: input.gateId,
        gateRevision: input.gateRevision,
        candidateCommit: input.candidateCommit,
        outcome: input.outcome,
        comment: input.comment || '',
        upstreamCheckpointId: input.upstreamCheckpointId,
        impactHash: input.impactHash,
        driftChoice: input.driftChoice,
        commitToGit: input.commitToGit === true,
      },
    })
    if (result.ignored) throw projectError('PROJECT_GATE_STALE')
    if (input.outcome === 'reject-upstream' && rejectPreview) {
      await context.engine.dispatch(input.upstreamCheckpointId, {
        type: 'REOPEN',
        at: this.#nowIso(),
        payload: { reason: String(input.comment || 'Rejected upstream.') },
      })
      for (const affectedId of rejectPreview.affectedCheckpointIds) {
        await context.engine.dispatch(affectedId, {
          type: 'UPSTREAM_REOPENED',
          at: this.#nowIso(),
          payload: { checkpointId: input.upstreamCheckpointId },
        })
      }
    }
    if (acceptDivergence) {
      await context.store.enqueue((next) => {
        for (const path of acceptDivergence.files) {
          const id = createHash('sha256')
            .update(`${acceptDivergence.checkpointId}:${path}:${acceptDivergence.observedCommit}`, 'utf8')
            .digest('hex')
          if (next.driftItems.some(item => item.id === id)) continue
          next.driftItems.push({
            id,
            revision: 1,
            path,
            checkpointId: acceptDivergence.checkpointId,
            baseVersionId: acceptDivergence.baseVersionId,
            acceptedCommit: acceptDivergence.acceptedCommit,
            observedCommit: acceptDivergence.observedCommit,
            foundAt: this.#nowIso(),
            source: 'accept-candidate',
            status: 'unresolved',
            resolvedAt: null,
          })
        }
        return { next }
      })
    }
    await this.#queueProjectMessage(projectId, staged)
    return { revision: context.store.current().revision }
  }

  previewReject({ projectId, checkpointId, upstreamId }) {
    const context = this.#context(projectId)
    const state = context.store.current()
    if (!state.instances.some(item => item.id === checkpointId)) {
      throw projectError('PROJECT_NOT_FOUND', { checkpointId })
    }
    return impactPreview(state, upstreamId)
  }

  previewReopen({ projectId, checkpointId }) {
    const context = this.#context(projectId)
    const state = context.store.current()
    const instance = state.instances.find(item => item.id === checkpointId)
    if (!instance || instance.state !== 'accepted') {
      throw projectError('PROJECT_NOT_REOPENABLE')
    }
    return impactPreview(state, checkpointId)
  }

  async reopen({ projectId, checkpointId, reason, impactHash }) {
    const context = this.#context(projectId)
    this.#assertWritable(context)
    const state = context.store.current()
    const instance = state.instances.find(item => item.id === checkpointId)
    if (!instance || instance.state !== 'accepted') {
      throw projectError('PROJECT_NOT_REOPENABLE')
    }
    const preview = impactPreview(state, checkpointId)
    if (preview.impactHash !== impactHash) {
      throw projectError('PROJECT_IMPACT_CHANGED')
    }
    await context.engine.dispatch(checkpointId, {
      type: 'REOPEN',
      at: this.#nowIso(),
      payload: { reason },
    })
    for (const affectedId of preview.affectedCheckpointIds) {
      await context.engine.dispatch(affectedId, {
        type: 'UPSTREAM_REOPENED',
        at: this.#nowIso(),
        payload: { checkpointId },
      })
    }
    return { revision: context.store.current().revision }
  }

  async resolveOutOfScope({ projectId, itemIds }) {
    const context = this.#context(projectId)
    this.#assertWritable(context)
    const ids = new Set(itemIds)
    await context.store.enqueue((state) => {
      for (const item of state.outOfScopeItems) {
        if (ids.has(item.id) && item.status === 'unresolved') {
          item.status = 'resolved'
          item.resolvedAt = this.#nowIso()
        }
      }
      return { next: state }
    })
    return { resolved: itemIds.length }
  }

  async resolveDrift({ projectId, items, choice }) {
    const context = this.#context(projectId)
    this.#assertWritable(context)
    const state = context.store.current()
    const targets = items.map(({ itemId, revision }) => {
      const item = state.driftItems.find(entry => entry.id === itemId)
      if (!item || item.revision !== revision || item.status !== 'unresolved') {
        throw projectError('PROJECT_DRIFT_STALE')
      }
      return item
    })
    if (choice !== 'workdir') throw projectError('PROJECT_ENGINE_UNAVAILABLE')
    if (context.shadowRepo) {
      for (const item of targets) {
        const verified = await context.shadowRepo.verifyAgainst({
          effectId: `drift-resolve:${item.id}:${item.revision}`,
          commit: item.observedCommit,
          paths: [item.path],
          placeholderList: state.placeholders || [],
          limits: state.config.settings.snapshotLimits,
        })
        if (verified.intact === false) throw projectError('PROJECT_DRIFT_STALE')
      }
    }
    await context.store.enqueue((next) => {
      for (const target of targets) {
        const item = next.driftItems.find(entry => entry.id === target.id)
        item.status = 'resolved'
        item.resolvedAt = this.#nowIso()
      }
      return { next }
    })
    return { resolved: targets.length }
  }

  async cancelDriftResolution({ projectId, itemId, revision }) {
    const context = this.#context(projectId)
    this.#assertWritable(context)
    await context.store.enqueue((state) => {
      const item = state.driftItems.find(entry => entry.id === itemId)
      if (!item || item.revision !== revision || item.status !== 'resolving') {
        throw projectError('PROJECT_DRIFT_STALE')
      }
      item.status = 'unresolved'
      return { next: state }
    })
    return { itemId, status: 'unresolved' }
  }

  #projectForGroup(groupId) {
    const group = (this.workspace.state.groups || []).find(item => item.id === groupId)
    if (!group?.projectId) return null
    return { group, context: this.projects.get(group.projectId) || null }
  }

  async beginProjectChatWrite(groupId, checkId) {
    const found = this.#projectForGroup(groupId)
    if (!found?.context?.store?.current()) throw projectError('PROJECT_NOT_FOUND')
    if (found.context.readOnly) throw projectError('PROJECT_READ_ONLY')
    await found.context.store.enqueue((state) => {
      state.chatWriteChecks[checkId] = {
        groupId,
        status: 'running',
        snapshotCommit: null,
        baseVersions: null,
        failure: null,
      }
      return { next: state }
    })
    return { checkId }
  }

  async endProjectChatWrite(groupId, checkId) {
    const found = this.#projectForGroup(groupId)
    if (!found?.context?.store?.current()) return null
    const context = found.context
    const state = context.store.current()
    const check = state.chatWriteChecks?.[checkId]
    if (!check) return null
    const baseVersions = state.instances
      .filter(instance => instance.state === 'accepted')
      .map(instance => ({
        checkpointId: instance.id,
        artifactVersionId: instance.artifactVersions.at(-1)?.id || '',
        instanceEpoch: instance.epoch,
      }))
      .filter(entry => entry.artifactVersionId)
    let snapshotCommit = null
    let failure = null
    if (context.shadowRepo) {
      const effectKey = createHash('sha256')
        .update(JSON.stringify([context.project.id, 'chat-end', checkId]), 'utf8')
        .digest('hex')
      try {
        const snapshot = await context.shadowRepo.snapshot({
          effectId: `chat-${effectKey}`,
          targets: [],
          placeholderList: state.placeholders || [],
          limits: state.config.settings.snapshotLimits,
          isOptional: false,
        })
        snapshotCommit = snapshot.commit || null
      } catch (error) {
        failure = String(error?.code || 'SHADOW_SNAPSHOT_FAILED')
      }
    } else {
      failure = 'SHADOW_UNAVAILABLE'
    }
    const detectionId = detectionEffectId(context.project.id, checkId)
    await context.store.enqueue((next) => {
      const current = next.chatWriteChecks?.[checkId]
      if (current) {
        current.status = 'pending-detection'
        current.snapshotCommit = snapshotCommit
        current.baseVersions = baseVersions
        current.failure = failure
      }
      if (!next.projectEffects.some(effect => effect.id === detectionId)) {
        next.projectEffects.push({
          id: detectionId,
          type: 'detect-accepted-changes',
          category: 'required',
          status: 'pending',
          params: {
            checkId,
            groupId,
            snapshotCommit,
            baseVersions,
            failure,
          },
          result: null,
          error: null,
          startedAt: null,
          finishedAt: null,
        })
      }
      return { next, control: false }
    })
    await this.runProjectEffects(context.project.id)
    return { checkId, snapshotCommit, failure }
  }

  async #processProjectMessage(context, effect) {
    const projectId = context.project.id
    const store = this.pendingMessageStore(projectId)
    const payload = store.read(effect.params?.ref)
    if (payload) {
      const metadata = payload.metadata || {}
      this.workspace.insertProjectRoomMessage({
        id: metadata.id,
        groupId: metadata.groupId,
        role: metadata.role,
        agentKind: metadata.agentKind,
        content: payload.body,
        createdAt: metadata.createdAt,
        projectRoom: metadata.projectRoom,
      })
      await store.consume(effect.params.ref)
    }
    await context.store.enqueue((state) => {
      const target = state.projectEffects.find(item => item.id === effect.id)
      if (target) {
        target.status = 'consumed'
        target.finishedAt = this.#nowIso()
      }
      return { next: state, control: true }
    })
  }

  async runProjectEffects(projectId) {
    const context = this.#context(projectId)
    for (let step = 0; step < 100; step += 1) {
      const state = context.store?.current()
      if (!state) return { processed: step }
      if (state.projectBlockedOn) {
        const blocked = (state.projectEffects || [])
          .find(item => item.id === state.projectBlockedOn.effectId)
        if (blocked?.status === 'failed') return { processed: step, paused: true }
      }
      const effect = (state.projectEffects || []).find(item => item.status === 'pending')
      if (!effect) return { processed: step }
      if (effect.type === 'append-message') {
        await this.#processProjectMessage(context, effect)
        continue
      }
      if (effect.type !== 'detect-accepted-changes') break
      const outcome = await this.#processDetection(context, effect)
      if (outcome === 'requeued') {
        const pending = context.store.current().projectEffects.find(item => item.id === effect.id)
        if (pending?.status === 'pending' && !pending.params?.snapshotCommit) {
          await this.#ensureMaintenanceDetection(context, pending)
        }
      }
      const latest = context.store.current().projectEffects.find(item => item.id === effect.id)
      if (latest?.status === 'failed') break
      if (latest?.status === 'pending' && !latest.params?.snapshotCommit) break
    }
    return { processed: 100 }
  }

  async #ensureMaintenanceDetection(context, effect) {
    const existing = this.maintenanceEnsures.get(effect.id)
    if (existing) return existing
    const ensure = this.#ensureMaintenanceDetectionInner(context, effect)
    this.maintenanceEnsures.set(effect.id, ensure)
    try {
      return await ensure
    } finally {
      if (this.maintenanceEnsures.get(effect.id) === ensure) {
        this.maintenanceEnsures.delete(effect.id)
      }
    }
  }

  async #ensureMaintenanceDetectionInner(context, effect) {
    const projectId = context.project.id
    const requestId = `maintenance-${effect.id}`
    const state = context.store.current()
    if (!state || state.deletion) return
    let request = (state.maintenanceLeaseRequests || []).find(item => item.id === requestId)
    if (request && request.status === 'released') {
      await context.store.enqueue((next) => {
        const target = next.maintenanceLeaseRequests.find(item => item.id === requestId)
        if (target) {
          target.status = 'waiting'
          target.requestedAt = this.#nowIso()
          target.grantedAt = null
          target.releasedAt = null
        }
        return { next }
      })
    } else if (!request) {
      request = {
        id: requestId,
        holder: {
          kind: 'project-maintenance',
          projectId,
          ownerId: requestId,
        },
        chainEffectId: effect.id,
        claims: [{
          root: context.project.workdir,
          path: '',
          mode: 'exclusive',
        }],
        epoch: 0,
        requestedAt: this.#nowIso(),
        status: 'waiting',
        grantedAt: null,
        releasedAt: null,
      }
      await context.store.enqueue((next) => {
        if (next.deletion) return { next }
        if (!next.maintenanceLeaseRequests.some(item => item.id === requestId)) {
          next.maintenanceLeaseRequests.push(request)
        }
        return { next }
      })
    }
    request = context.store.current().maintenanceLeaseRequests.find(item => item.id === requestId)
    if (!request || !['waiting', 'granted'].includes(request.status)) return
    const isGranted = () => (this.scheduler.snapshot?.().claimGrants || [])
      .some(entry => entry.requestId === requestId)
    if (!isGranted()) {
      this.scheduler.request({
        requestId,
        holder: request.holder,
        claims: request.claims,
        onGranted: () => {
          this.#runMaintenanceDetection(context, effect.id).catch(() => {})
        },
      })
    }
    if (isGranted()) await this.#runMaintenanceDetection(context, effect.id)
  }

  #runMaintenanceDetection(context, effectId) {
    const running = this.maintenanceRuns.get(effectId)
    if (running) return running
    let outcome = null
    const run = this.#runMaintenanceDetectionInner(context, effectId)
      .then((result) => {
        outcome = result
        return result
      })
      .finally(() => {
        if (this.maintenanceRuns.get(effectId) === run) {
          this.maintenanceRuns.delete(effectId)
        }
        if (outcome?.requeue) this.#requeueMaintenanceDetection(context, effectId)
      })
    this.maintenanceRuns.set(effectId, run)
    return run
  }

  #requeueMaintenanceDetection(context, effectId) {
    const state = context.store.current()
    if (!state || state.deletion) return
    const effect = (state.projectEffects || []).find(item => item.id === effectId)
    if (!effect || effect.status !== 'pending' || effect.params?.snapshotCommit) return
    this.#ensureMaintenanceDetection(context, effect).catch(() => {})
  }

  async #releaseMaintenanceRequest(context, requestId) {
    await context.store.enqueue((next) => {
      const target = next.maintenanceLeaseRequests.find(item => item.id === requestId)
      if (target && target.status !== 'released' && target.status !== 'withdrawn') {
        target.status = 'released'
        target.releasedAt = this.#nowIso()
      }
      return { next, control: true }
    })
    this.scheduler.release(requestId)
  }

  async #runMaintenanceDetectionInner(context, effectId) {
    const requestId = `maintenance-${effectId}`
    const state = context.store.current()
    const request = (state?.maintenanceLeaseRequests || []).find(item => item.id === requestId)
    const effect = (state?.projectEffects || []).find(item => item.id === effectId)
    if (!request || !effect || effect.status !== 'pending'
        || !['waiting', 'granted'].includes(request.status)
        || state.deletion
        || (state.projectBlockedOn && state.projectBlockedOn.effectId !== effectId)) {
      if (request) await this.#releaseMaintenanceRequest(context, requestId)
      else this.scheduler.release(requestId)
      return
    }
    if (request.status === 'waiting') {
      await context.store.enqueue((next) => {
        const target = next.maintenanceLeaseRequests.find(item => item.id === requestId)
        if (target && target.status === 'waiting') {
          target.status = 'granted'
          target.grantedAt = this.#nowIso()
        }
        return { next }
      })
    }
    const current = context.store.current()
    const currentEffect = (current?.projectEffects || []).find(item => item.id === effectId)
    const currentRequest = (current?.maintenanceLeaseRequests || []).find(item => item.id === requestId)
    if (!current || current.deletion || !currentEffect || currentEffect.status !== 'pending'
        || !currentRequest || currentRequest.status !== 'granted') {
      await this.#releaseMaintenanceRequest(context, requestId)
      return
    }
    const baseVersions = current.instances
      .filter(instance => instance.state === 'accepted')
      .map(instance => ({
        checkpointId: instance.id,
        artifactVersionId: instance.artifactVersions.at(-1)?.id || '',
        instanceEpoch: instance.epoch,
      }))
      .filter(entry => entry.artifactVersionId)
    let snapshotCommit = null
    let failure = null
    try {
      const snapshot = await context.shadowRepo.snapshot({
        effectId: requestId,
        targets: [],
        placeholderList: current.placeholders || [],
        limits: current.config.settings.snapshotLimits,
        isOptional: false,
      })
      snapshotCommit = snapshot.commit || null
    } catch (error) {
      failure = String(error?.code || 'SHADOW_SNAPSHOT_FAILED')
    }
    await context.store.enqueue((next) => {
      const target = next.maintenanceLeaseRequests.find(item => item.id === requestId)
      if (target) {
        target.status = 'released'
        target.releasedAt = this.#nowIso()
      }
      const nextEffect = next.projectEffects.find(item => item.id === effectId)
      if (nextEffect) {
        nextEffect.params = {
          ...nextEffect.params,
          snapshotCommit,
          baseVersions,
          failure,
        }
        if (failure) {
          nextEffect.status = 'failed'
          nextEffect.error = failure
          nextEffect.finishedAt = this.#nowIso()
          next.projectBlockedOn = { effectId, error: failure, time: this.#nowIso() }
        }
        const check = nextEffect.params.checkId
          ? next.chatWriteChecks?.[nextEffect.params.checkId]
          : null
        if (check) {
          check.snapshotCommit = snapshotCommit
          check.baseVersions = baseVersions
          check.failure = failure
        }
      }
      return { next, control: true }
    })
    this.scheduler.release(requestId)
    let requeue = false
    if (snapshotCommit) {
      const refreshed = context.store.current().projectEffects.find(item => item.id === effectId)
      if (refreshed) {
        requeue = await this.#processDetection(context, refreshed) === 'requeued'
      }
    }
    return { requeue }
  }

  async #processDetection(context, effect) {
    const state = context.store.current()
    const params = effect.params || {}
    if (!params.snapshotCommit) {
      await this.#ensureMaintenanceDetection(context, effect)
      return 'waiting'
    }
    const changes = []
    let baseChanged = false
    for (const instance of state.instances) {
      if (instance.state !== 'accepted') continue
      const version = instance.artifactVersions.at(-1)
      if (!version) continue
      const expected = (params.baseVersions || []).find(item => item.checkpointId === instance.id)
      if (!expected || expected.artifactVersionId !== version.id
          || expected.instanceEpoch !== instance.epoch) {
        baseChanged = true
        break
      }
      const def = state.config.playbook.checkpointDefs
        .find(item => item.key === instance.checkpointKey)
      for (const path of def?.targetFiles || []) {
        try {
          const clean = await context.shadowRepo.diffQuiet(version.commit, params.snapshotCommit, [path])
          if (!clean) changes.push({ instance, def, path })
        } catch {
          baseChanged = true
          break
        }
      }
      if (baseChanged) break
    }
    if (baseChanged) {
      await context.store.enqueue((next) => {
        const target = next.projectEffects.find(item => item.id === effect.id)
        if (target) {
          target.status = 'pending'
          target.params = { ...target.params, snapshotCommit: null, baseVersions: null }
        }
        return { next }
      })
      return 'requeued'
    }
    let changesHeaderMissing = true
    try {
      const changesFile = await context.shadowRepo.fileAtCommit(
        params.snapshotCommit, 'meldwork/changes.md',
      )
      if (changesFile) {
        const headers = new Set([...String(changesFile.text).matchAll(/^-\s*\[path=([^\]]+?)\s+from=[^\]]*\]/gm)]
          .map(match => match[1].trim()))
        changesHeaderMissing = changes.some(change => !headers.has(change.path))
      }
    } catch { changesHeaderMissing = true }
    for (const change of changes) {
      const critical = ['requirements', 'architecture'].some(key => (
        change.def?.key === key || String(change.def?.name || '').toLowerCase().includes(key)
      ))
      await context.engine.dispatch(change.instance.id, {
        type: 'ACCEPTED_DOC_CHANGED',
        at: this.#nowIso(),
        payload: {
          file: change.path,
          critical,
          snapshot: params.snapshotCommit,
        },
      })
    }
    if (changesHeaderMissing) {
      await context.store.enqueue((next) => {
        for (const change of changes) {
          const instance = next.instances.find(item => item.id === change.instance.id)
          if (instance?.gate) {
            instance.gate.firstScreen.changesHeaderMissing = true
            instance.gate.revision += 1
          }
        }
        return { next }
      })
    }
    await context.store.enqueue((next) => {
      const target = next.projectEffects.find(item => item.id === effect.id)
      if (target) {
        target.status = 'consumed'
        target.finishedAt = this.#nowIso()
      }
      if (params.checkId) delete next.chatWriteChecks[params.checkId]
      if (next.projectBlockedOn?.effectId === effect.id) next.projectBlockedOn = null
      return { next, control: true }
    })
    return 'consumed'
  }

  projectChatContext(groupId) {
    const group = (this.workspace.state.groups || []).find(item => item.id === groupId)
    if (!group?.projectId || group.projectRole === 'main') return null
    const context = this.projects.get(group.projectId)
    if (!context?.store?.current()) return null
    const state = context.store.current()
    return buildProjectChatContext({
      project: context.project,
      state,
      groupId,
      language: state.config.settings.language,
    })
  }

  async recordChatReads(projectId, groupId, versions) {
    const context = this.#context(projectId)
    if (!context.store?.current()) return null
    await context.store.enqueue((state) => {
      state.chatReads[groupId] = { ...(versions || {}) }
      return { next: state }
    })
    return { groupId }
  }

  async retryEffect({ projectId, checkpointId, effectId }) {
    const context = this.#context(projectId)
    const state = context.store?.current()
    if (!state) {
      throw projectError('PROJECT_READ_ONLY', {
        reason: context.readOnlyReason || 'read-only',
      })
    }
    let found = false
    if (checkpointId) {
      const instance = state.instances.find(item => item.id === checkpointId)
      found = Boolean(instance?.effects.some(effect => (
        effect.id === effectId && effect.status === 'failed'
      )))
    } else {
      found = state.projectEffects.some(effect => (
        effect.id === effectId && effect.status === 'failed'
      ))
    }
    if (!found) throw projectError('PROJECT_EFFECT_NOT_FOUND')
    if (!checkpointId) {
      await context.store.enqueue((next) => {
        const effect = next.projectEffects.find(item => item.id === effectId)
        if (effect) {
          effect.status = 'pending'
          effect.error = null
          effect.finishedAt = null
        }
        if (next.projectBlockedOn?.effectId === effectId) next.projectBlockedOn = null
        return { next, control: true }
      })
      await this.runProjectEffects(projectId)
      return { effectId, retried: true }
    }
    await context.engine.dispatch(checkpointId, {
      type: 'RETRY_EFFECT',
      at: this.#nowIso(),
      payload: { effectId },
    })
    await context.engine.runUntilIdle()
    return { effectId, retried: true }
  }

  async residual({ residualId, action }) {
    if (!this.scheduler?.snapshot) throw projectError('PROJECT_ENGINE_UNAVAILABLE')
    if (!['manuallyEnded', 'notRelated'].includes(action)) {
      throw inputError('residual-action-invalid')
    }
    const residual = (this.scheduler.snapshot().residuals || [])
      .find(item => item.residualId === residualId)
    if (!residual) throw inputError('residual-not-found', { residualId })
    this.scheduler.clearResidual(residualId)
    if (typeof this.onResidual === 'function') await this.onResidual({ residual, action })
    return { residualId, cleared: true }
  }

  async unlockDirectory({ projectId, folderName }) {
    const context = this.#context(projectId)
    if (String(folderName) !== path.basename(context.project.workdir)) {
      throw projectError('PROJECT_UNLOCK_CONFIRMATION_MISMATCH')
    }
    const residuals = this.scheduler?.snapshot?.().residuals || []
    const rootClaim = await makeClaim({
      root: context.project.workdir,
      path: '',
      mode: 'exclusive',
    })
    const blocking = residuals.filter(residual => (
      (residual.claims || []).some(claim => claimsOverlap(claim, rootClaim))
    ))
    if (blocking.length) {
      throw projectError('PROJECT_RESIDUAL_UNRESOLVED', {
        residualIds: blocking.map(item => item.residualId),
      })
    }
    if (typeof this.onUnlockDirectory === 'function') {
      await this.onUnlockDirectory({ context, folderName })
    }
    return { unlocked: true }
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
    this.#createEngine(context)
    this.#registerContext(projectId, context)
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
    const validation = validateSeatCapabilities(seat.agentKind, seat.capabilities)
    if (!validation.ok) {
      throw projectError('PROJECT_CAPABILITY_UNSUPPORTED', {
        seatId: seat.id,
        agentKind: seat.agentKind,
        unsupported: validation.unsupported,
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
