// OAR-driven room smoke: the real engine drives real Claude/Codex over OAR,
// host tools come back over the per-run MCP server, and the task reaches
// in_review before the Captain's review reply.
//
// This is the engine-driven counterpart of room-seam-smoke.cjs (which is a
// module-level marker fallback). It intentionally runs Chat and Task with
// OAR's default YOLO permissions per the 2026-11-17 POC decision.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { openRoomDatabase } = require('../src/room/db.cjs')
const { createRoomRepository } = require('../src/room/repository.cjs')
const { createTimeline } = require('../src/room/timeline.cjs')
const { createSessionStore } = require('../src/room/session-store.cjs')
const { createOutbox } = require('../src/room/effects.cjs')
const { createEngine } = require('../src/room/engine.cjs')
const { createTaskQueue } = require('../src/room/task-queue.cjs')
const { createSettlement, registerFinishTaskTool } = require('../src/room/settlement.cjs')
const { createCaptainReview } = require('../src/room/captain-review.cjs')
const { createToolDispatcher } = require('../src/room/tools/dispatcher.cjs')
const { registerMentionTool } = require('../src/room/tools/mention.cjs')
const { registerReadChatTool } = require('../src/room/tools/read.cjs')
const { registerTaskTools } = require('../src/room/tools/tasks.cjs')
const { createCaptainAssignment, registerCaptainTools } = require('../src/room/tools/captain.cjs')
const { createOarRuntimeAdapter } = require('../src/room/runtime-adapter.cjs')
const { resolveExecutable } = require('../src/agents/cli/cli-adapters.cjs')

const argument = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? '' : process.argv[index + 1] || ''
}
const provider = argument('--provider')
if (!process.argv.includes('--run') || !['claude', 'codex'].includes(provider)) {
  console.error('Use: room-oar-smoke.cjs --run --provider claude|codex')
  process.exit(2)
}

function userDataDirectory() {
  if (process.env.MELDWORK_USER_DATA) return process.env.MELDWORK_USER_DATA
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Meldwork')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'Meldwork')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'meldwork')
}

function withTimeout(promise, ms, code) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

async function main() {
  const userData = userDataDirectory()
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `meldwork-room-oar-${provider}-`))
  const workdir = path.join(root, 'project')
  fs.mkdirSync(workdir, { recursive: true, mode: 0o700 })
  const resultPath = path.join(userData, 'room-oar-result.json')
  const result = {
    provider,
    ok: false,
    integrationMode: 'oar-engine',
    engineDriven: true,
    error: null,
  }
  let roomDb = null
  let adapter = null
  try {
    const env = {
      ...process.env,
      PATH: [
        path.join(os.homedir(), 'Library', 'pnpm'),
        path.join(os.homedir(), '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        process.env.PATH,
      ].filter(Boolean).join(path.delimiter),
    }
    const executable = await resolveExecutable(provider, { env })
    if (!executable) throw new Error('OAR_SMOKE_PROVIDER_NOT_INSTALLED')
    result.executable = executable

    roomDb = openRoomDatabase({ directory: path.join(root, 'room') })
    const repository = createRoomRepository(roomDb)
    const roomId = repository.createRoom({ name: 'OAR smoke', workspace: workdir, providers: [provider] })
    const chatId = repository.createChat({ roomId, title: 'OAR smoke' })
    const nativePermission = provider === 'claude' ? 'bypassPermissions' : 'danger-full-access'
    const captainRoleId = repository.createRole({
      chatId,
      displayName: 'Captain',
      provider,
      prompt: 'You coordinate this room. Use assign_in_group to assign work. Keep replies short.',
      isCaptain: true,
      nativePermission,
    })
    const workerRoleId = repository.createRole({
      chatId,
      displayName: 'Worker',
      provider,
      prompt: 'You execute assigned tasks. Use the room tools. Keep replies short.',
      nativePermission,
    })
    repository.addParticipant({ chatId, roleId: captainRoleId })
    repository.addParticipant({ chatId, roleId: workerRoleId })

    const timeline = createTimeline({ roomDb, repository })
    const sessions = createSessionStore({ roomDb, repository })
    const outbox = createOutbox({ roomDb, repository })
    const settlement = createSettlement({ roomDb, repository, timeline })
    const review = createCaptainReview({ roomDb, repository, timeline, outbox })
    const dispatcher = createToolDispatcher({ roomDb, repository })

    let adapterReady = null
    const runtime = { start: input => {
      if (!adapterReady) throw new Error('OAR_SMOKE_ADAPTER_NOT_READY')
      return adapterReady.start(input)
    } }
    const engine = createEngine({ roomDb, repository, timeline, sessions, outbox, runtime })
    const queue = createTaskQueue({
      roomDb,
      repository,
      timeline,
      outbox,
      startRun: (run, task) => {
        if (!adapterReady) throw new Error('OAR_SMOKE_ADAPTER_NOT_READY')
        return adapterReady.startTaskRun(run, task)
      },
    })
    const captainAssignment = createCaptainAssignment({
      roomDb,
      repository,
      timeline,
      review,
      queueReply: input => engine.queueReply(input),
      requestTick: () => {},
    })
    registerMentionTool({ dispatcher, roomDb, repository, timeline, queueReply: input => engine.queueReply(input) })
    registerReadChatTool({ dispatcher, timeline, repository })
    registerTaskTools({ dispatcher, roomDb, repository, timeline, queueRun: queue })
    registerFinishTaskTool({ dispatcher, settlement })
    registerCaptainTools({ dispatcher, repository, captainAssignment, timeline })

    let resolveTaskSettled
    const taskSettled = new Promise(resolve => { resolveTaskSettled = resolve })
    adapter = createOarRuntimeAdapter({
      roomDb,
      repository,
      timeline,
      sessions,
      dispatcher,
      settlement,
      env,
      executables: { [provider]: executable },
      onTaskSettled: info => {
        result.taskSettlement = info
        resolveTaskSettled(info)
      },
      turnTimeoutMs: 8 * 60 * 1000,
    })
    adapterReady = adapter

    async function waitForWorkingIdle(timeoutMs = 6 * 60 * 1000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const busy = roomDb.database.prepare(`
          SELECT COUNT(*) AS n FROM messages
          WHERE chat_id = ? AND author_type = 'agent'
            AND status IN ('working', 'waiting_for_input', 'stopping')
        `).get(chatId).n
        if (busy === 0) return
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      throw new Error('OAR_SMOKE_REPLY_TIMEOUT')
    }

    // startQueuedReplies confirms launches, not completions: each round starts
    // what is queued, then waits for the working replies to reach a terminal
    // status. Tools (assign_in_group / mention) may queue the next round.
    async function drainReplies(rounds = 8) {
      for (let round = 0; round < rounds; round += 1) {
        const queued = roomDb.database.prepare(`
          SELECT COUNT(*) AS n FROM messages
          WHERE chat_id = ? AND author_type = 'agent' AND status = 'queued'
        `).get(chatId).n
        if (queued > 0) await engine.startQueuedReplies({ chatId })
        await waitForWorkingIdle()
        const queuedAfter = roomDb.database.prepare(`
          SELECT COUNT(*) AS n FROM messages
          WHERE chat_id = ? AND author_type = 'agent' AND status = 'queued'
        `).get(chatId).n
        if (queuedAfter === 0) return
      }
      throw new Error('OAR_SMOKE_QUEUE_NOT_DRAINED')
    }

    const userMessage = `@Captain Assign Worker (role id ${workerRoleId}) to create a task. `
      + `Call assign_in_group with text: "Create a task with title OAR smoke task, description Confirm the OAR engine loop, acceptance finish_task called. Use the create_task tool." `
      + `and roleIds: ["${workerRoleId}"]. Then reply with a short confirmation.`
    engine.submitUserMessage({ chatId, content: userMessage })
    await drainReplies()

    const taskRow = roomDb.database.prepare(`
      SELECT * FROM tasks WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(chatId)
    if (!taskRow) throw new Error('OAR_SMOKE_TASK_NOT_CREATED')
    result.taskId = taskRow.id
    result.taskTitle = taskRow.title
    const runs = queue.listRuns(taskRow.id)
    result.runId = runs[0]?.id ?? null

    const captainRefBeforeReview = roomDb.database.prepare(`
      SELECT native_session_ref FROM sessions
      WHERE scope_type = 'chat' AND scope_id = ? AND role_id = ? AND state = 'active'
    `).get(chatId, captainRoleId)?.native_session_ref ?? null

    const started = await queue.pump({ roomId })
    result.startedRuns = started.length
    const runAfterPump = result.runId
      ? roomDb.database.prepare('SELECT status, reason FROM task_runs WHERE id = ?').get(result.runId)
      : null
    if (runAfterPump?.status === 'failed') {
      resolveTaskSettled({ runId: result.runId, taskId: taskRow.id, error: runAfterPump.reason })
    }
    const settlementInfo = await withTimeout(taskSettled, 8 * 60 * 1000, 'OAR_SMOKE_TASK_TIMEOUT')
    if (settlementInfo?.error) throw new Error(`OAR_SMOKE_TASK_SETTLEMENT_FAILED: ${settlementInfo.error}`)

    const reviews = review.review({ chatId })
    result.reviewKinds = reviews.map(item => item.kind)
    const activityBefore = timeline.activitySeq(chatId)
    const delivered = review.deliver({ chatId })
    result.deliveredReviews = delivered.length
    const activityAfter = timeline.activitySeq(chatId)
    result.activityStable = activityBefore === activityAfter
    await drainReplies(3)

    const task = roomDb.database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskRow.id)
    const run = roomDb.database.prepare('SELECT * FROM task_runs WHERE id = ?').get(result.runId)
    const report = roomDb.database.prepare(`
      SELECT * FROM reports WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(taskRow.id)
    const latest = timeline.latest(chatId)
    const reviewReplyRow = roomDb.database.prepare(`
      SELECT * FROM messages
      WHERE chat_id = ? AND data_json LIKE '%"reviewReply":true%'
      ORDER BY seq DESC LIMIT 1
    `).get(chatId)
    const reviewReplyData = reviewReplyRow?.data_json ? JSON.parse(reviewReplyRow.data_json) : null
    const toolCalls = roomDb.database.prepare(`
      SELECT tool_name, status FROM tool_calls
      WHERE tool_name IN ('create_task', 'finish_task', 'assign_in_group')
      ORDER BY created_at ASC, rowid ASC
    `).all()
    result.toolCalls = toolCalls
    const succeeded = name => toolCalls.some(call => call.tool_name === name && call.status === 'succeeded')

    const workerChatRef = roomDb.database.prepare(`
      SELECT native_session_ref FROM sessions
      WHERE scope_type = 'chat' AND scope_id = ? AND role_id = ? AND state = 'active'
    `).get(chatId, workerRoleId)?.native_session_ref ?? null
    const taskSessionRef = roomDb.database.prepare(`
      SELECT native_session_ref FROM sessions
      WHERE scope_type = 'task' AND scope_id = ? AND role_id = ? AND state = 'active'
    `).get(taskRow.id, workerRoleId)?.native_session_ref ?? null
    const captainRefAfterReview = roomDb.database.prepare(`
      SELECT native_session_ref FROM sessions
      WHERE scope_type = 'chat' AND scope_id = ? AND role_id = ? AND state = 'active'
    `).get(chatId, captainRoleId)?.native_session_ref ?? null

    result.taskStatus = task?.status ?? null
    result.runStatus = run?.status ?? null
    result.reportKind = report?.kind ?? null
    result.latestStatus = latest?.status ?? null
    result.latestAudience = latest?.audience ?? null
    result.latestReviewReply = latest?.data?.reviewReply === true
    result.reviewReplyStatus = reviewReplyRow?.status ?? null
    result.reviewReplyAudience = reviewReplyRow?.audience ?? null
    result.reviewReplyFlag = reviewReplyData?.reviewReply === true
    result.workerChatSessionRef = workerChatRef
    result.taskSessionRef = taskSessionRef
    result.captainSessionStable = Boolean(
      captainRefBeforeReview && captainRefAfterReview && captainRefBeforeReview === captainRefAfterReview,
    )
    result.taskSessionSeparate = Boolean(workerChatRef && taskSessionRef && workerChatRef !== taskSessionRef)

    result.ok = result.engineDriven === true
      && result.taskStatus === 'in_review'
      && result.runStatus === 'completed'
      && result.reportKind === 'ready'
      && result.reviewKinds.includes('assignment_settled')
      && result.activityStable === true
      && result.reviewReplyStatus === 'done'
      && result.reviewReplyAudience === 'captain'
      && result.reviewReplyFlag === true
      && result.captainSessionStable === true
      && result.taskSessionSeparate === true
      && succeeded('assign_in_group')
      && succeeded('create_task')
      && succeeded('finish_task')
  } catch (error) {
    result.error = String(error?.code || error?.message || error)
  } finally {
    try { await adapter?.disposeAll() } catch { /* best effort */ }
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
