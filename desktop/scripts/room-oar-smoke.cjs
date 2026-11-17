// OAR-driven room smoke through the production room service.
//
// The real engine, room service liveness, supervisor and OAR adapter drive
// real Claude/Codex: Captain assign_in_group -> Worker create_task -> Task
// finish_task -> settlement -> in_review -> Captain review reply.
//
// Chat and Task intentionally use OAR's default YOLO permissions per the
// 2026-11-17 POC decision.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { openRoomDatabase } = require('../src/room/db.cjs')
const { createRoomRepository } = require('../src/room/repository.cjs')
const { createRoomService } = require('../src/room/room-service.cjs')
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
    serviceDriven: true,
    error: null,
  }
  let roomDb = null
  let service = null
  let runtimeStateDir = null
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
    runtimeStateDir = path.join(root, 'runtime')
    const runtimeWrapperPath = path.join(__dirname, '..', 'src', 'room', 'meldwork-runtime-wrapper.sh')
    result.runtimeWrapperPath = runtimeWrapperPath

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

    let resolveTaskSettled
    const taskSettled = new Promise(resolve => { resolveTaskSettled = resolve })
    service = createRoomService({
      roomDb,
      repository,
      adapterFactory: deps => createOarRuntimeAdapter({
        ...deps,
        env,
        executables: { [provider]: executable },
        turnTimeoutMs: 8 * 60 * 1000,
      }),
      livenessDebounceMs: 150,
      runtimeWrapperPath,
      runtimeStateDir,
      onTaskSettled: info => {
        result.taskSettlement = info
        resolveTaskSettled(info)
      },
    })
    result.startupSweep = await service.startupSweep

    const userMessage = `@Captain Assign Worker (role id ${workerRoleId}) to create a task. `
      + `Call assign_in_group with text: "Create a task with title OAR smoke task, description Confirm the OAR engine loop, acceptance finish_task called. Use the create_task tool." `
      + `and roleIds: ["${workerRoleId}"]. Then reply with a short confirmation.`
    service.submitUserMessage({ chatId, content: userMessage })
    await service.waitForChatIdle({ chatId, timeoutMs: 8 * 60 * 1000 })

    const taskRow = roomDb.database.prepare(`
      SELECT * FROM tasks WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(chatId)
    if (!taskRow) throw new Error('OAR_SMOKE_TASK_NOT_CREATED')
    result.taskId = taskRow.id
    result.taskTitle = taskRow.title
    const runs = service.queue.listRuns(taskRow.id)
    result.runId = runs[0]?.id ?? null

    const captainRefBeforeReview = roomDb.database.prepare(`
      SELECT native_session_ref FROM sessions
      WHERE scope_type = 'chat' AND scope_id = ? AND role_id = ? AND state = 'active'
    `).get(chatId, captainRoleId)?.native_session_ref ?? null

    // The service liveness normally starts the task run on its start_run
    // commit; pump once as a deterministic nudge.
    const started = await service.pump({ roomId })
    result.startedRuns = started.length
    const runAfterPump = result.runId
      ? roomDb.database.prepare('SELECT status, reason FROM task_runs WHERE id = ?').get(result.runId)
      : null
    if (runAfterPump?.status === 'failed') {
      resolveTaskSettled({ runId: result.runId, taskId: taskRow.id, error: runAfterPump.reason })
    }
    const settlementInfo = await withTimeout(taskSettled, 8 * 60 * 1000, 'OAR_SMOKE_TASK_TIMEOUT')
    if (settlementInfo?.error) throw new Error(`OAR_SMOKE_TASK_SETTLEMENT_FAILED: ${settlementInfo.error}`)

    const activityBefore = service.timeline.activitySeq(chatId)
    const reviewDeadline = Date.now() + 20_000
    let sawReview = false
    while (Date.now() < reviewDeadline) {
      const row = roomDb.database.prepare('SELECT 1 AS found FROM captain_reviews WHERE chat_id = ? LIMIT 1').get(chatId)
      if (row) {
        sawReview = true
        break
      }
      await sleep(100)
    }
    result.sawReview = sawReview
    result.reviewKinds = roomDb.database.prepare('SELECT kind FROM captain_reviews WHERE chat_id = ?').all(chatId)
      .map(row => row.kind)
    result.deliveredReviews = roomDb.database.prepare(`
      SELECT COUNT(*) AS n FROM captain_reviews WHERE chat_id = ? AND status = 'completed'
    `).get(chatId).n

    // Only the review row + its reviewReply are required not to advance
    // activity. A later public post_in_chat is public by design.
    const activityAfterReview = service.timeline.activitySeq(chatId)
    result.activityStable = activityBefore === activityAfterReview

    await service.waitForChatIdle({ chatId, timeoutMs: 8 * 60 * 1000 })
    result.activityAfterChat = service.timeline.activitySeq(chatId)
    result.runtimePidFilesBeforeClose = runtimeStateDir && fs.existsSync(runtimeStateDir)
      ? fs.readdirSync(runtimeStateDir).filter(name => name.endsWith('.pid')).length
      : 0

    const task = roomDb.database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskRow.id)
    const run = roomDb.database.prepare('SELECT * FROM task_runs WHERE id = ?').get(result.runId)
    const report = roomDb.database.prepare(`
      SELECT * FROM reports WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(taskRow.id)
    const latest = service.timeline.latest(chatId)
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

  } catch (error) {
    result.error = String(error?.code || error?.message || error)
  } finally {
    try { await service?.close() } catch { /* best effort */ }
    try {
      result.runtimePidFilesAfterClose = runtimeStateDir && fs.existsSync(runtimeStateDir)
        ? fs.readdirSync(runtimeStateDir).filter(name => name.endsWith('.pid')).length
        : 0
    } catch {
      result.runtimePidFilesAfterClose = null
    }
    try { roomDb?.close() } catch { /* best effort */ }
  }
  const succeeded = name => Array.isArray(result.toolCalls)
    && result.toolCalls.some(call => call.tool_name === name && call.status === 'succeeded')
  result.ok = result.engineDriven === true
    && result.serviceDriven === true
    && result.sawReview === true
    && result.taskStatus === 'in_review'
    && result.runStatus === 'completed'
    && result.reportKind === 'ready'
    && Array.isArray(result.reviewKinds) && result.reviewKinds.includes('assignment_settled')
    && result.activityStable === true
    && result.reviewReplyStatus === 'done'
    && result.reviewReplyAudience === 'captain'
    && result.reviewReplyFlag === true
    && result.captainSessionStable === true
    && result.taskSessionSeparate === true
    && result.runtimePidFilesBeforeClose > 0
    && result.runtimePidFilesAfterClose === 0
    && succeeded('assign_in_group')
    && succeeded('create_task')
    && succeeded('finish_task')
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ stage: 'complete', resultPath, ...result }))
  if (!result.ok) process.exitCode = 1
}

main().catch(error => {
  console.error(JSON.stringify({ stage: 'failed', code: String(error?.code || error?.message || error) }))
  process.exitCode = 1
})
