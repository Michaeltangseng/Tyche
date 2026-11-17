// Real CLI seam smoke: chat session -> created task -> task session -> finish claim -> settlement -> Captain review.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { detectAgents, resolveExecutable, runAgent } = require('../src/agents/cli/cli-adapters.cjs')
const { resolveNativeShellEnvironment, codexDeclaredCredentialKeys } = require('../src/agents/local-agent-readiness.cjs')
const { nativeCredentialEnvironment } = require('../src/agents/agent-native-environment.cjs')
const { networkEnvironment } = require('../src/agents/cli/cli-network-environment.cjs')
const { configDirectoryEnvironment } = require('../src/agents/cli/cli-config-directories.cjs')
const { openRoomDatabase } = require('../src/room/db.cjs')
const { createRoomRepository } = require('../src/room/repository.cjs')
const { createTimeline } = require('../src/room/timeline.cjs')
const { createOutbox } = require('../src/room/effects.cjs')
const { createTaskQueue } = require('../src/room/task-queue.cjs')
const { createSessionStore } = require('../src/room/session-store.cjs')
const { createSettlement } = require('../src/room/settlement.cjs')
const { createCaptainReview } = require('../src/room/captain-review.cjs')

const argument = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? '' : process.argv[index + 1] || ''
}
const provider = argument('--provider')
if (!process.argv.includes('--run') || !['claude', 'codex'].includes(provider)) {
  console.error('Use: room-seam-smoke.cjs --run --provider claude|codex')
  process.exit(2)
}

function userDataDirectory() {
  if (process.env.MELDWORK_USER_DATA) return process.env.MELDWORK_USER_DATA
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Meldwork')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'Meldwork')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'meldwork')
}

function parseMarker(text, marker) {
  const raw = String(text ?? '')
  const index = raw.indexOf(marker)
  if (index < 0) return null
  const after = raw.slice(index + marker.length)
  const start = after.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < after.length; i += 1) {
    const character = after[i]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(after.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

async function main() {
  const userData = userDataDirectory()
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-room-seam-${provider}-`))
  const workdir = path.join(root, 'project')
  fs.mkdirSync(workdir, { recursive: true, mode: 0o700 })
  const resultPath = path.join(userData, 'room-seam-result.json')
  const result = { provider, ok: false, error: null }
  let roomDb
  try {
    const shell = await resolveNativeShellEnvironment()
    const env = { ...process.env, ...shell.env }
    for (const key of shell.unsetKeys || []) delete env[key]
    const executable = await resolveExecutable(provider, { env })
    if (!executable) throw new Error('SEAM_PROVIDER_NOT_INSTALLED')
    const agents = await detectAgents({ env, resolveExecutableFn: kind => kind === provider ? executable : null })
    const agent = agents.find(item => item.kind === provider && item.available !== false && item.invocable !== false)
    if (!agent) throw new Error('SEAM_PROVIDER_NOT_INVOCABLE')
    const nativeKeys = provider === 'codex' ? ['CODEX_API_KEY', ...codexDeclaredCredentialKeys({ env })] : []
    const childEnv = {
      ...networkEnvironment(env),
      ...configDirectoryEnvironment(env),
      ...nativeCredentialEnvironment(provider, env, nativeKeys),
      PATH: env.PATH,
    }
    const invoke = async (prompt, sessionRef, timeoutMs = 120_000) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        return await runAgent(agent, prompt, workdir, {
          env: childEnv,
          sandbox: 'read-only',
          nativeCredentialKeys: nativeKeys,
          sessionRef: sessionRef || '',
          signal: controller.signal,
          onEvent: () => {},
        })
      } finally {
        clearTimeout(timer)
      }
    }

    roomDb = openRoomDatabase({ directory: path.join(root, 'room') })
    const repository = createRoomRepository(roomDb)
    const roomId = repository.createRoom({ name: 'Seam smoke', workspace: workdir, providers: [provider] })
    const chatId = repository.createChat({ roomId, title: 'Seam' })
    const captainRoleId = repository.createRole({ chatId, displayName: 'Captain', provider, prompt: 'route', isCaptain: true })
    const workerRoleId = repository.createRole({ chatId, displayName: 'Worker', provider, prompt: 'work' })
    repository.addParticipant({ chatId, roleId: captainRoleId })
    repository.addParticipant({ chatId, roleId: workerRoleId })
    const timeline = createTimeline({ roomDb, repository })
    const outbox = createOutbox({ roomDb, repository })
    const queue = createTaskQueue({ roomDb, repository, timeline, outbox })
    const sessions = createSessionStore({ roomDb, repository })
    const settlement = createSettlement({ roomDb, repository, timeline })
    const review = createCaptainReview({ roomDb, repository, timeline })

    const baseSession = { provider, promptRevision: 1, permissionMode: 'read-only', workspaceRef: workdir,
      skillBindings: [], model: null, thinkingLevel: null, created: () => {} }
    const chatSession = sessions.ensureSession({ ...baseSession, scopeType: 'chat', scopeId: chatId, roleId: workerRoleId })

    const first = await invoke('Remember the codeword ALPHA. Reply with OK only.', null)
    if (first.sessionRef) sessions.saveNativeRef({ sessionId: chatSession.sessionId, nativeSessionRef: first.sessionRef })
    const second = await invoke(
      'What codeword did I ask you to remember? Reply with the codeword, then on a new line output exactly one line with no code fence: '
      + 'MELDWORK_CREATE_TASK {"title":"Seam task","description":"Confirm ALPHA","acceptance":"Report ALPHA"}',
      first.sessionRef || '',
    )
    result.chatSessionReused = Boolean(first.sessionRef && second.sessionRef && first.sessionRef === second.sessionRef)
    result.chatRemembered = /\bALPHA\b/i.test(String(second.text || ''))
    const createMarker = parseMarker(second.text, 'MELDWORK_CREATE_TASK')
    result.createMarker = createMarker
    if (!createMarker) throw new Error('SEAM_CREATE_MARKER_MISSING')

    const task = queue.createTask({
      chatId,
      roleId: workerRoleId,
      title: createMarker.title || 'Seam task',
      description: createMarker.description || 'Confirm ALPHA',
      acceptance: createMarker.acceptance || 'Report ALPHA',
    })
    result.taskId = task.taskId
    result.runId = task.runId
    const taskSession = sessions.ensureSession({
      ...baseSession, scopeType: 'task', scopeId: task.taskId, roleId: workerRoleId,
    })
    const taskResult = await invoke(
      'You are the worker for a read-only task. Task: Seam task. Description: Confirm ALPHA. Acceptance: Report ALPHA. '
      + 'You have no write tools. Reply with exactly one line and no code fence: '
      + 'MELDWORK_FINISH_TASK {"status":"ready","summary":"ALPHA"}',
      null,
    )
    if (taskResult.sessionRef) sessions.saveNativeRef({ sessionId: taskSession.sessionId, nativeSessionRef: taskResult.sessionRef })
    result.taskSessionSeparate = Boolean(taskResult.sessionRef && taskResult.sessionRef !== second.sessionRef)
    const finishMarker = parseMarker(taskResult.text, 'MELDWORK_FINISH_TASK')
    result.finishMarker = finishMarker
    if (!finishMarker) throw new Error('SEAM_FINISH_MARKER_MISSING')
    sessions.setLaneLastSeq({ taskId: task.taskId, roleId: workerRoleId, seq: 1 })

    roomDb.database.prepare("UPDATE task_runs SET status = 'running', started_at = ? WHERE id = ?")
      .run(new Date().toISOString(), task.runId)
    roomDb.database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.taskId)
    settlement.claim({ runId: task.runId, taskId: task.taskId, status: finishMarker.status || 'ready',
      summary: finishMarker.summary || 'ALPHA' })

    const assignmentMessage = timeline.append({
      chatId, authorType: 'agent', authorId: captainRoleId,
      content: '@Worker complete the seam task', mentions: [workerRoleId], status: 'done',
    })
    const targetReply = timeline.append({
      chatId, authorType: 'agent', authorId: workerRoleId, content: 'done', status: 'done',
    })
    review.recordAssignment({ chatId, messageId: assignmentMessage.id, rootMessageId: assignmentMessage.id,
      targetRoleIds: [workerRoleId], targetReplyIds: [targetReply.id] })

    const settled = settlement.settle({ runId: task.runId, exit: { observed: true, code: 0 },
      snapshot: { state: 'not_applicable' } })
    result.settlementTaskStatus = settled.task.status
    result.settlementRunStatus = settled.run.status
    result.snapshotState = settled.run.snapshotState
    if (settled.task.status !== 'in_review') throw new Error('SEAM_TASK_NOT_IN_REVIEW')

    const pending = review.review({ chatId })
    result.reviewKinds = pending.map(item => item.kind)
    const activityBefore = timeline.activitySeq(chatId)
    review.deliver({ chatId })
    result.activityStable = timeline.activitySeq(chatId) === activityBefore
    const latest = timeline.latest(chatId)
    result.reviewAudience = latest.audience
    result.reviewReply = latest.data?.reviewReply === true

    result.ok = result.chatSessionReused && result.chatRemembered && result.taskSessionSeparate
      && result.settlementTaskStatus === 'in_review' && result.snapshotState === 'not_applicable'
      && result.reviewKinds.includes('assignment_settled') && result.activityStable
      && result.reviewAudience === 'captain' && result.reviewReply === true
  } catch (error) {
    result.error = String(error?.code || error?.message || error)
  } finally {
    try { roomDb?.close() } catch { /* best effort */ }
  }
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ stage: 'complete', resultPath, ...result }))
  if (!result.ok) process.exitCode = 1
}

main().catch(error => {
  console.error(JSON.stringify({ stage: 'failed', code: String(error?.code || error?.message || error) }))
  process.exitCode = 1
})
