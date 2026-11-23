/**
 * OAR-backed runtime adapter for the new room domain.
 *
 * The room engine already speaks a small port:
 *   runtime.start({ runId, chatId, roleId, prompt, nativeSessionRef, signal, onEvent })
 *     -> { launch, completion }
 *
 * This adapter implements that port with @botiverse/oar, so the room gets the
 * same runtime seam eta uses: one OAR session per run (resumed by the native
 * session id the room already persists), host tools served over a local MCP
 * server, and OAR's default YOLO permissions. The POC decision (2026-11-17)
 * is that both Chat and Task runs are YOLO; the room's host-tool dispatcher
 * still governs which MCP tools each run may call.
 *
 * Local MCP servers are reached over 127.0.0.1. On machines with an HTTP proxy
 * (common in CN), the CLI's MCP client may send that loopback request through
 * the proxy; every session therefore gets NO_PROXY/no_proxy for loopback.
 */
const crypto = require('node:crypto')
const { equippedSkillLines } = require('./briefing.cjs')
const { createMcpHttpServer } = require('./tools/mcp-server.cjs')

const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1'
const MCP_SERVER_NAME = 'tyche'

function selectRoomRuntime(registry, provider) {
  const runtime = registry?.get?.(provider)
  if (!runtime) {
    throw adapterError(
      'ROOM_RUNTIME_UNSUPPORTED',
      `room runtime has no launcher for ${JSON.stringify(provider)}`,
    )
  }
  return runtime
}

function adapterError(code, message, cause) {
  const error = new Error(message || code)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function truncate(value, max = 2000) {
  const text = typeof value === 'string' ? value : (value === null || value === undefined ? '' : JSON.stringify(value))
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function textOfToolOutput(content) {
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (part?.type === 'text') return part.text
    if (part?.type === 'image') return `[image ${part.mediaType ?? ''}]`
    return truncate(part?.value)
  }).filter(Boolean).join('\n')
}

function textOfReasoning(content) {
  return content?.kind === 'text' ? content.text ?? '' : ''
}

/** OAR's turn outcome in the room's reply status vocabulary. */
function mapTurnOutcome(turn, text) {
  if (!turn || turn.kind === 'completed') return { status: 'done', text: text ?? '' }
  if (turn.kind === 'aborted') return { status: 'stopped', text: text ?? '' }
  if (turn.kind === 'handled') return { status: 'failed', text: text || 'the runtime handled the input without a turn' }
  return { status: 'failed', text: text || turn.reason || turn.failure || 'runtime turn failed' }
}

function createOarRuntimeAdapter({
  roomDb,
  repository,
  timeline,
  sessions,
  dispatcher,
  settlement = null,
  env = process.env,
  executables = {},
  mcpFactory = createMcpHttpServer,
  loadOar = () => import('@botiverse/oar'),
  onTaskSettled = () => {},
  onEvent: onTaskEvent = null,
  runtimeWrapperPath = null,
  runtimeStateDir = null,
  now = () => Date.now(),
  skillSource = null,
  turnTimeoutMs = 10 * 60 * 1000,
  debug = (...args) => {
    if (process.env.ROOM_OAR_DEBUG) console.error('[room-oar]', ...args)
  },
} = {}) {
  if (!roomDb || !repository || !timeline || !sessions || !dispatcher) {
    throw new TypeError('ROOM_RUNTIME_ADAPTER_DEPENDENCIES_REQUIRED')
  }
  const { database } = roomDb
  let oarPromise = null
  let launcherIds = null
  const controllers = new Map()
  const completions = new Set()

  function rememberLaunchers(mod) {
    const list = mod?.defaultRuntimes?.list?.() || []
    launcherIds = list.map(runtime => runtime?.id).filter(id => typeof id === 'string')
  }

  function oarModule() {
    oarPromise ??= Promise.resolve().then(loadOar).then(mod => {
      rememberLaunchers(mod)
      return mod
    })
    return oarPromise
  }

  void oarModule().catch(() => { /* a later launch reports the missing runtime */ })

  function rolePromptRevision(roleId) {
    const row = database.prepare('SELECT MAX(revision) AS revision FROM role_prompt_revisions WHERE role_id = ?').get(roleId)
    return row?.revision ?? 1
  }

  function rolePrompt(roleId) {
    const row = database.prepare(`
      SELECT prompt FROM role_prompt_revisions
      WHERE role_id = ? ORDER BY revision DESC, rowid DESC LIMIT 1
    `).get(roleId)
    return typeof row?.prompt === 'string' && row.prompt.length > 0 ? row.prompt : undefined
  }

  async function resolveExecutable(provider) {
    if (typeof executables[provider] === 'string' && executables[provider]) return executables[provider]
    try {
      const { resolveExecutable: resolve } = require('../agents/cli/cli-adapters.cjs')
      return await resolve(provider, { env })
    } catch {
      return null
    }
  }

  async function installationFor(provider, runId) {
    const { defaultRuntimes } = await oarModule()
    const runtime = selectRoomRuntime(defaultRuntimes, provider)
    if (typeof runtime.installation !== 'function') {
      throw adapterError('ROOM_RUNTIME_INSTALLATION_UNAVAILABLE', `${provider} has no installation probe`)
    }
    const executable = await resolveExecutable(provider)
    // The PID-record wrapper is POSIX-only. Windows still runs the runtime,
    // but crash recovery has to wait for a native process-tree implementation.
    const useWrapper = process.platform !== 'win32'
      && Boolean(runtimeWrapperPath && runtimeStateDir && executable)
    const command = useWrapper ? runtimeWrapperPath : executable
    const baseEnv = {
      ...env,
      ...(command ? { [`OAR_${provider.toUpperCase()}_BIN`]: command } : {}),
      ...(useWrapper ? {
        TYCHE_RUNTIME_BIN: executable,
        TYCHE_ROOM_STATE_DIR: runtimeStateDir,
      } : {}),
      NO_PROXY: LOOPBACK_NO_PROXY,
      no_proxy: LOOPBACK_NO_PROXY,
    }
    // The installation probe runs the wrapper without a run id, so it does not
    // write a PID record; the actual session does.
    const installation = await runtime.installation({ env: baseEnv })
    if (!installation || installation.kind !== 'available') {
      throw adapterError(
        'ROOM_RUNTIME_UNAVAILABLE',
        `${provider} is not available: ${installation?.reason ?? installation?.kind ?? 'unknown'}`,
      )
    }
    const sessionEnv = useWrapper && runId
      ? { ...baseEnv, TYCHE_ROOM_RUN_ID: runId }
      : baseEnv
    return { runtime, installation, sessionEnv }
  }

  function allowedToolsFor(role, mode, laneKind = 'executor') {
    if (mode === 'task') {
      if (laneKind !== 'executor') return ['mention', 'read_chat', 'comment_task']
      return ['mention', 'read_chat', 'create_task', 'comment_task', 'finish_task']
    }
    if (role.isCaptain === true) return ['mention', 'read_chat', 'assign_in_group', 'post_in_chat', 'create_roles', 'rename_chat']
    return ['mention', 'read_chat', 'create_task', 'comment_task']
  }

  function bindRun({
    runId,
    chatId,
    roleId,
    mode,
    captainAssignmentId = null,
    rootMessageId = null,
    laneKind = 'executor',
  }) {
    const role = repository.getRole(roleId)
    if (!role) throw adapterError('ROOM_ROLE_NOT_FOUND', `room role ${roleId} not found`)
    dispatcher.bindRun(runId, {
      chatId,
      roleId,
      allowedTools: allowedToolsFor(role, mode, laneKind),
      captainAssignmentId,
      rootMessageId,
    })
    return role
  }

  function trackSignal(runId, externalSignal) {
    const controller = new AbortController()
    const abort = () => {
      debug('track-signal-abort', { runId, external: true })
      controller.abort()
    }
    if (externalSignal) {
      if (externalSignal.aborted) abort()
      else externalSignal.addEventListener('abort', abort, { once: true })
    }
    controllers.set(runId, controller)
    return {
      signal: controller.signal,
      cleanup() {
        externalSignal?.removeEventListener('abort', abort)
        if (controllers.get(runId) === controller) controllers.delete(runId)
      },
    }
  }

  function mcpEntryOf(server) {
    if (!server) return null
    if (server.server) return { ...server.server, name: server.server.name ?? MCP_SERVER_NAME }
    return {
      name: MCP_SERVER_NAME,
      type: 'http',
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
    }
  }

  async function openSession({ provider, cwd, resume, mcpServer, appendSystemPrompt, runId }) {
    const { runtime, installation, sessionEnv } = await installationFor(provider, runId)
    const options = {
      cwd,
      ...(resume ? { resume } : {}),
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      mcpServers: mcpServer ? [mcpServer] : [],
      env: sessionEnv,
    }
    try {
      const session = await runtime.session(installation, options)
      debug('session-open', { provider, id: session.id, cwd, resume: resume ?? null, hasPrompt: Boolean(appendSystemPrompt) })
      return session
    } catch (error) {
      // A native session the CLI no longer keeps is not fatal: open a new one
      // and let the room persist the new ref on launch.
      if (resume && error?.name === 'SessionNotFoundError') {
        debug('session-resume-missed', { provider, resume, reason: error.message })
        return await runtime.session(installation, { ...options, resume: undefined })
      }
      debug('session-open-failed', { provider, error: error?.message })
      throw error
    }
  }

  /**
   * Prompt one session and expose launch/completion separately. `launch`
   * resolves when the runtime accepted the prompt (the room's start effect is
   * a launch confirmation, not a completion); `completion` resolves at the
   * turn's end. Failures resolve completion as failed rather than reject, so a
   * caller that only awaits launch never sees an unhandled completion.
   */
  function startTurn({ session, prompt, signal, onEvent }) {
    let resolveLaunch
    let rejectLaunch
    const launch = new Promise((resolve, reject) => {
      resolveLaunch = resolve
      rejectLaunch = reject
    })
    launch.catch(() => {})
    const textParts = []
    const thinkingParts = []
    const activity = []
    const byCallId = new Map()
    const unsubscribe = session.events(event => {
      const root = !Array.isArray(event.agentPath) || event.agentPath.length === 0
      if (event.kind === 'text_delta' && root) textParts.push(event.text ?? '')
      else if (event.kind === 'reasoning' && root) thinkingParts.push(textOfReasoning(event.content))
      else if (event.kind === 'tool_call_started') {
        const entry = { name: event.toolName ?? event.tool ?? 'tool', input: truncate(event.input ?? ''), status: 'running' }
        activity.push(entry)
        if (event.callId) byCallId.set(event.callId, entry)
      } else if (event.kind === 'tool_call_input') {
        const entry = byCallId.get(event.callId)
        if (entry) entry.input = truncate(event.input ?? '')
      } else if (event.kind === 'tool_call_ended') {
        const entry = byCallId.get(event.callId) ?? { name: event.tool ?? 'tool' }
        entry.status = event.result === 'failed' ? 'failed' : 'completed'
        entry.output = truncate(textOfToolOutput(event.content))
        if (event.exitCode !== undefined) entry.exitCode = event.exitCode
      } else if (event.kind === 'turn_ended' || event.kind === 'exited' || event.kind === 'failure') {
        debug('runtime-event', event.kind, JSON.stringify(event).slice(0, 400))
      }
      if (event.kind !== 'text_delta' && event.kind !== 'reasoning') {
        debug('event', event.kind, JSON.stringify(event).slice(0, 300))
      }
      try { onEvent?.(event) } catch { /* event consumers are best-effort */ }
    })
    let timedOut = false
    const abort = () => {
      debug('abort-signal', { sessionId: session.id, signalAborted: signal?.aborted === true, timedOut })
      Promise.resolve(session.abort()).catch(() => {})
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timer = turnTimeoutMs > 0
      ? setTimeout(() => { timedOut = true; abort() }, turnTimeoutMs)
      : null

    const completion = (async () => {
      try {
        const { awaitTurnEnd } = await oarModule()
        const inputId = crypto.randomUUID()
        const accepted = await session.prompt(prompt, { inputId })
        debug('prompt-result', { sessionId: session.id, kind: accepted.kind, seq: accepted.seq, inputId })
        if (accepted.kind === 'rejected') {
          const error = adapterError('ROOM_RUNTIME_PROMPT_REJECTED', `${accepted.code}: ${accepted.reason}`)
          debug('prompt-rejected', { code: accepted.code, reason: accepted.reason })
          rejectLaunch(error)
          return { status: 'failed', text: textParts.join('') || accepted.reason || accepted.code, thinking: thinkingParts.join(''), activity }
        }
        resolveLaunch({ nativeSessionRef: session.id })
        const turn = await awaitTurnEnd(session, accepted.seq, inputId)
        debug('turn-ended', { sessionId: session.id, outcome: turn, text: textParts.join('').slice(0, 200) })
        let text = textParts.join('')
        if (timedOut && !text) text = 'the runtime turn timed out'
        const mapped = mapTurnOutcome(turn, text)
        return { ...mapped, thinking: thinkingParts.join(''), activity }
      } catch (error) {
        debug('turn-error', { sessionId: session.id, error: error?.message, aborted: signal?.aborted, timedOut })
        rejectLaunch(error)
        return {
          status: signal?.aborted ? 'stopped' : 'failed',
          text: textParts.join('') || (error?.message ?? String(error)),
          thinking: thinkingParts.join(''),
          activity,
        }
      } finally {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        unsubscribe()
      }
    })()
    completion.catch(() => {})
    return { launch, completion }
  }

  function taskPrompt(task, laneKind = 'executor', role = null) {
    const lines = laneKind !== 'executor'
      ? [
        "You are participating in a task's mention lane in the Tyche room.",
        `Task id: ${task.id}`,
        `Task #${task.number}: ${task.title ?? ''}`,
        `Description: ${task.description ?? ''}`,
        `Acceptance: ${task.acceptance ?? ''}`,
        '',
        'Read the task and its comments, then use comment_task or mention if you need to say something.',
        'Do not call finish_task: only the executor lane may finish or settle this task.',
      ]
      : [
        'You are the assigned agent for a task in the Tyche room.',
        `Task id: ${task.id}`,
        `Task #${task.number}: ${task.title ?? ''}`,
        `Description: ${task.description ?? ''}`,
        `Acceptance: ${task.acceptance ?? ''}`,
        '',
        'Use the room tools available to you. When the task is complete, call the finish_task tool with:',
        `  taskId: "${task.id}"`,
        '  status: "ready"',
        '  summary: a short summary of what you did',
        'If you need context, use read_chat. Do not stop before calling finish_task.',
      ]
    if (skillSource && Array.isArray(role?.skills) && role.skills.length) {
      try {
        const equipped = skillSource.materialize(role.provider, role.skills, {
          workspace: task.workspaceRef || '',
        }).skills || []
        lines.push('', ...equippedSkillLines(equipped))
      } catch { /* a skill scan must not block the task */ }
    }
    return lines.join('\n')
  }

  async function finalizeTaskRun({ run, task, result, laneKind = 'executor' }) {
    if (laneKind !== 'executor') {
      // A mention-lane run is a comment turn, not a task settlement. Record the
      // run fact and leave the task status untouched; only the executor lane
      // can produce a report or enter in_review.
      const endedAt = new Date(now()).toISOString()
      const runStatus = result.status === 'done'
        ? 'completed'
        : result.status === 'failed'
          ? 'failed'
          : 'interrupted'
      const outcome = result.status === 'stopped' ? 'unknown' : 'known'
      const reason = result.status === 'done' ? null : String(result.text ?? result.status).slice(0, 500)
      database.prepare(`
        UPDATE task_runs SET status = ?, outcome = ?, snapshot_state = 'not_applicable',
          ended_at = ?, reason = ? WHERE id = ? AND status IN ('starting', 'running')
      `).run(runStatus, outcome, endedAt, reason, run.id)
      const settledRun = database.prepare('SELECT status FROM task_runs WHERE id = ?').get(run.id)
      const settledTask = database.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id)
      onTaskSettled({
        runId: run.id,
        taskId: task.id,
        status: result.status,
        runStatus: settledRun?.status,
        taskStatus: settledTask?.status,
        laneKind,
      })
      return
    }
    if (!settlement) {
      onTaskSettled({ runId: run.id, taskId: task.id, error: adapterError('ROOM_SETTLEMENT_REQUIRED', 'no settlement service') })
      return
    }
    const writeCapable = Array.isArray(run.writeScopes) && run.writeScopes.length > 0
    const exit = result.status === 'done'
      ? { observed: true, code: 0 }
      : result.status === 'failed'
        ? { observed: true, code: 1 }
        : { observed: false }
    // POC: there is no Artifact snapshot pipeline yet. A write-capable run is
    // allowed to settle as completed so the task can reach in_review.
    const snapshot = writeCapable ? { state: 'completed', artifactIds: [] } : { state: 'not_applicable' }
    try {
      try {
        settlement.settle({ runId: run.id, exit, snapshot })
      } catch (error) {
        if (error?.message !== 'ROOM_REPORT_REQUIRED') throw error
        settlement.claim({
          runId: run.id,
          taskId: task.id,
          status: 'failed',
          summary: result.text || 'The agent exited without calling finish_task.',
        })
        settlement.settle({ runId: run.id, exit, snapshot })
      }
      const settledRun = database.prepare('SELECT status FROM task_runs WHERE id = ?').get(run.id)
      const settledTask = database.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id)
      onTaskSettled({
        runId: run.id,
        taskId: task.id,
        status: result.status,
        runStatus: settledRun?.status,
        taskStatus: settledTask?.status,
        laneKind: 'executor',
      })
    } catch (error) {
      onTaskSettled({ runId: run.id, taskId: task.id, error })
    }
  }

  /**
   * The room engine's runtime port (chat replies). Synchronous by contract: it
   * must always return { launch, completion }, even when opening the runtime
   * later fails; the engine attaches to launch immediately.
   */
  function start(input) {
    let resolveLaunch
    let rejectLaunch
    const launch = new Promise((resolve, reject) => {
      resolveLaunch = resolve
      rejectLaunch = reject
    })
    launch.catch(() => {})
    const completion = (async () => {
      let session = null
      let mcpServer = null
      let tracked = null
      try {
        const { runId, chatId, roleId, prompt, nativeSessionRef, signal, onEvent } = input ?? {}
        debug('chat-start', {
          runId,
          chatId,
          roleId,
          promptLength: prompt?.length ?? 0,
          promptPreview: String(prompt ?? '').slice(0, 600),
          resume: nativeSessionRef ?? null,
          signalAborted: signal?.aborted === true,
        })
        const reply = timeline.get(runId)
        if (!reply) throw adapterError('ROOM_REPLY_NOT_FOUND', `reply ${runId} not found`)
        const chat = repository.getChat(chatId)
        if (!chat) throw adapterError('ROOM_CHAT_NOT_FOUND', `chat ${chatId} not found`)
        const room = repository.getRoom(chat.roomId)
        if (!room?.workspace) throw adapterError('ROOM_WORKSPACE_REQUIRED', `room for chat ${chatId} has no workspace`)
        const role = bindRun({
          runId,
          chatId,
          roleId,
          mode: 'chat',
          captainAssignmentId: reply.captainAssignmentId ?? null,
          rootMessageId: reply.rootMessageId ?? reply.id,
        })
        mcpServer = await mcpFactory({ dispatcher, runId })
        session = await openSession({
          provider: role.provider,
          cwd: room.workspace,
          resume: nativeSessionRef || undefined,
          mcpServer: mcpEntryOf(mcpServer),
          appendSystemPrompt: rolePrompt(roleId),
          runId,
        })
        tracked = trackSignal(runId, signal)
        const turn = startTurn({ session, prompt, signal: tracked.signal, onEvent })
        turn.launch.then(resolveLaunch, rejectLaunch)
        return await turn.completion
      } catch (error) {
        debug('chat-failed', { runId: input?.runId, error: error?.message })
        rejectLaunch(error)
        return { status: 'failed', text: error?.message ?? String(error) }
      } finally {
        tracked?.cleanup()
        await session?.dispose().catch(() => {})
        await mcpServer?.close().catch(() => {})
      }
    })()
    completion.catch(() => {})
    completions.add(completion)
    completion.finally(() => completions.delete(completion)).catch(() => {})
    return { launch, completion }
  }

  /**
   * The task queue's startRun port. Resolves once the prompt is accepted (the
   * pump then marks the run running); completion settles the task in the
   * background and is reported through onTaskSettled.
   */
  async function startTaskRun(run, task) {
    let session = null
    let mcpServer = null
    let tracked = null
    try {
      const chat = repository.getChat(task.chatId)
      if (!chat) throw adapterError('ROOM_CHAT_NOT_FOUND', `chat ${task.chatId} not found`)
      const room = repository.getRoom(chat.roomId)
      const laneKind = task.laneKind === 'mention' ? 'mention' : 'executor'
      const role = bindRun({
        runId: run.id,
        chatId: task.chatId,
        roleId: run.roleId,
        mode: 'task',
        captainAssignmentId: run.captainAssignmentId ?? null,
        laneKind,
      })
      const workspace = run.workspaceRef || room?.workspace
      if (!workspace) throw adapterError('ROOM_WORKSPACE_REQUIRED', `task ${task.id} has no workspace`)
      let skillBindings = []
      if (skillSource && Array.isArray(role.skills) && role.skills.length) {
        try {
          skillBindings = (skillSource.materialize(role.provider, role.skills, {
            workspace,
          }).skills || []).map(skill => ({
            id: skill.id,
            contentHash: skill.contentHash,
            delivery: skill.delivery,
          }))
        } catch { skillBindings = [] }
      }
      const roomSession = sessions.ensureSession({
        scopeType: 'task',
        scopeId: task.id,
        roleId: run.roleId,
        provider: role.provider,
        promptRevision: rolePromptRevision(run.roleId),
        permissionMode: role.nativePermission || 'read-only',
        workspaceRef: workspace,
        skillBindings,
        model: role.model ?? null,
        thinkingLevel: null,
        laneKind,
      })
      const sessionRow = database.prepare('SELECT native_session_ref FROM sessions WHERE id = ?').get(roomSession.sessionId)
      mcpServer = await mcpFactory({ dispatcher, runId: run.id })
      session = await openSession({
        provider: role.provider,
        cwd: workspace,
        resume: sessionRow?.native_session_ref || undefined,
        mcpServer: mcpEntryOf(mcpServer),
        appendSystemPrompt: rolePrompt(run.roleId),
        runId: run.id,
      })
      tracked = trackSignal(run.id, null)
      const taskEvent = typeof onTaskEvent === 'function'
        ? event => onTaskEvent({
            runId: run.id,
            taskId: task.id,
            chatId: task.chatId,
            roleId: run.roleId,
            mode: 'task',
            event,
          })
        : null
      const turn = startTurn({ session, prompt: taskPrompt(task, laneKind, role), signal: tracked.signal, onEvent: taskEvent })
      turn.launch.then(({ nativeSessionRef }) => {
        if (nativeSessionRef) {
          try {
            sessions.saveNativeRef({ sessionId: roomSession.sessionId, nativeSessionRef })
          } catch { /* session bookkeeping must not fail the run */ }
        }
      }).catch(() => {})
      await turn.launch
      const completion = turn.completion.finally(async () => {
        tracked?.cleanup()
        await session?.dispose().catch(() => {})
        await mcpServer?.close().catch(() => {})
      })
      completions.add(completion)
      completion.then(result => finalizeTaskRun({ run, task, result, laneKind }))
        .catch(error => onTaskSettled({ runId: run.id, taskId: task.id, error }))
        .finally(() => completions.delete(completion))
      completion.catch(() => {})
      return { runId: run.id, sessionId: roomSession.sessionId }
    } catch (error) {
      tracked?.cleanup()
      await session?.dispose().catch(() => {})
      await mcpServer?.close().catch(() => {})
      throw error
    }
  }

  function stopRun(runId) {
    debug('stop-run', { runId })
    controllers.get(runId)?.abort()
  }

  function disposeAll() {
    debug('dispose-all', { controllers: controllers.size })
    for (const controller of controllers.values()) controller.abort()
    return Promise.allSettled([...completions])
  }

  function hasLauncher(provider) {
    if (!launcherIds) return null
    return launcherIds.includes(provider)
  }

  function launchProviderIds() {
    return launcherIds ? [...launcherIds] : null
  }

  return { start, startTaskRun, stopRun, disposeAll, hasLauncher, launchProviderIds }
}

module.exports = { createOarRuntimeAdapter, selectRoomRuntime }
