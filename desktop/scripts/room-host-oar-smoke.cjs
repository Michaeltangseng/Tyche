#!/usr/bin/env node
/**
 * Real OAR smoke through the production room host.
 *
 * The older room-oar-smoke exercises room-service directly. This script
 * exercises createRoomHost: bootstrap, role creation, the default OAR adapter,
 * the POSIX PID wrapper, liveness, live runtime events, settlement, and
 * Captain review.
 *
 * Usage:
 *   node scripts/room-host-oar-smoke.cjs --run --provider claude|codex
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createRoomHost } = require('../src/room/room-host.cjs')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? '' : process.argv[index + 1] || ''
}

const provider = argument('--provider')
if (!process.argv.includes('--run') || !['claude', 'codex'].includes(provider)) {
  console.error('Use: room-host-oar-smoke.cjs --run --provider claude|codex')
  process.exit(1)
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`ROOM_HOST_SMOKE_TIMEOUT:${label}`)
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tyche-room-host-${provider}-`))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const privateRoot = path.join(root, 'private')
  const events = []
  const changes = { count: 0 }
  const host = createRoomHost({
    privateRoot,
    env: {
      ...process.env,
      PATH: [
        path.join(os.homedir(), 'Library', 'pnpm'),
        path.join(os.homedir(), '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        process.env.PATH,
      ].filter(Boolean).join(path.delimiter),
    },
    onRuntimeEvent: payload => events.push(payload),
    onChanged: () => { changes.count += 1 },
  })
  const result = { provider, ok: false, error: null }
  try {
    await host.start()
    const nativePermission = provider === 'claude' ? 'bypassPermissions' : 'danger-full-access'
    const useDefaultPrompts = process.argv.includes('--default-prompts')
    const created = host.bootstrap({
      name: 'Host OAR smoke',
      workspace,
      providers: [provider],
      title: 'Host OAR smoke',
      roles: [
        {
          displayName: 'Captain',
          provider,
          ...(useDefaultPrompts
            ? {}
            : { prompt: 'You coordinate this room. Use assign_in_group to assign work. Keep replies short.' }),
          isCaptain: true,
          nativePermission,
        },
        {
          displayName: 'Worker',
          provider,
          ...(useDefaultPrompts
            ? {}
            : { prompt: 'You execute assigned tasks. Use the room tools. Keep replies short.' }),
          nativePermission,
        },
      ],
    })
    result.roomId = created.roomId
    result.chatId = created.chatId

    const worker = host.snapshot({ roomId: created.roomId }).roles.find(role => role.display_name === 'Worker')
    host.submitMessage({
      roomId: created.roomId,
      chatId: created.chatId,
      content: `@Captain Assign Worker (role id ${worker.id}) to create a task. `
        + 'Call assign_in_group with text: "Create a task with title Host smoke task, '
        + 'description Confirm the host OAR loop, acceptance finish_task called. Use the create_task tool." '
        + `and roleIds: ["${worker.id}"]. Then reply with a short confirmation.`,
    })
    await host.service.waitForChatIdle({ chatId: created.chatId, timeoutMs: 8 * 60 * 1000 })

    // Chat idle only means all reply rows settled. The task lane run is not a
    // chat reply, so wait for its terminal state before checking settlement.
    let task = null
    await waitFor(() => {
      task = host.roomDb.database.prepare(
        'SELECT * FROM tasks WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      ).get(created.chatId)
      if (!task) return null
      const run = host.roomDb.database.prepare(
        'SELECT status FROM task_runs WHERE task_id = ? ORDER BY queued_at DESC, rowid DESC LIMIT 1',
      ).get(task.id)
      return run && ['completed', 'failed', 'interrupted'].includes(run.status) ? run : null
    }, 8 * 60 * 1000, 'task-run')
    await waitFor(() => (
      host.roomDb.database.prepare(
        'SELECT COUNT(*) AS n FROM captain_reviews WHERE chat_id = ?',
      ).get(created.chatId).n > 0
    ), 60 * 1000, 'captain-review')
    await host.service.waitForChatIdle({ chatId: created.chatId, timeoutMs: 2 * 60 * 1000 })
    task = host.roomDb.database.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)
    result.taskId = task.id
    result.taskStatus = task.status
    result.reportKind = host.roomDb.database.prepare(
      'SELECT kind FROM reports WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get(task.id)?.kind ?? null
    result.reviews = host.roomDb.database.prepare(
      'SELECT kind, status FROM captain_reviews WHERE chat_id = ?',
    ).all(created.chatId)
    result.runtimeEventKinds = [...new Set(events.map(event => event.event.kind))].sort()
    result.liveEvents = events.length
    result.changes = changes.count
    result.ok = task.status === 'in_review' && result.reportKind === 'ready' && result.reviews.length > 0
    result.runtimePidFilesBeforeClose = fs.existsSync(path.join(privateRoot, 'room', 'runtime'))
      ? fs.readdirSync(path.join(privateRoot, 'room', 'runtime')).filter(name => name.endsWith('.pid')).length
      : 0
  } catch (error) {
    result.error = error?.message || String(error)
    result.stack = error?.stack || ''
  } finally {
    await host.close()
    const runtimeDir = path.join(privateRoot, 'room', 'runtime')
    result.runtimePidFilesAfterClose = fs.existsSync(runtimeDir)
      ? fs.readdirSync(runtimeDir).filter(name => name.endsWith('.pid')).length
      : 0
    if (result.runtimePidFilesAfterClose === 0 && result.runtimePidFilesBeforeClose >= 0 && result.ok) {
      result.ok = result.runtimePidFilesBeforeClose > 0
    }
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok ? 0 : 1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
