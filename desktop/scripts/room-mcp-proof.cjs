// Explicit local MCP tool-loop proof. Uses the same dispatcher and transport the engine uses.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { openRoomDatabase } = require('../src/room/db.cjs')
const { createRoomRepository } = require('../src/room/repository.cjs')
const { createTimeline } = require('../src/room/timeline.cjs')
const { createOutbox } = require('../src/room/effects.cjs')
const { createTaskQueue } = require('../src/room/task-queue.cjs')
const { createSettlement, registerFinishTaskTool } = require('../src/room/settlement.cjs')
const { createToolDispatcher } = require('../src/room/tools/dispatcher.cjs')
const { createMcpHttpServer } = require('../src/room/tools/mcp-server.cjs')
const { registerMentionTool } = require('../src/room/tools/mention.cjs')
const { registerTaskTools } = require('../src/room/tools/tasks.cjs')

function userDataDirectory() {
  if (process.env.TYCHE_USER_DATA) return process.env.TYCHE_USER_DATA
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Tyche')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'Tyche')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tyche')
}

async function main() {
  const userData = userDataDirectory()
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-room-mcp-proof-'))
  const roomDb = openRoomDatabase({ directory })
  let server
  let client
  try {
    const repo = createRoomRepository(roomDb)
    const roomId = repo.createRoom({ name: 'MCP proof', workspace: directory })
    const chatId = repo.createChat({ roomId, title: 'Proof' })
    const a = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'work' })
    const b = repo.createRole({ chatId, displayName: 'B', provider: 'claude', prompt: 'review' })
    repo.addParticipant({ chatId, roleId: a })
    repo.addParticipant({ chatId, roleId: b })
    const timeline = createTimeline({ roomDb, repository: repo })
    const outbox = createOutbox({ roomDb, repository: repo })
    const queue = createTaskQueue({ roomDb, repository: repo, timeline, outbox })
    const settlement = createSettlement({ roomDb, repository: repo, timeline })
    const dispatcher = createToolDispatcher({ roomDb, repository: repo })
    const queuedReplies = []
    registerMentionTool({ dispatcher, roomDb, repository: repo, timeline,
      queueReply: input => {
        queuedReplies.push(input)
        return timeline.append({ chatId, authorType: 'agent', authorId: input.roleId, content: '',
          replyTo: input.trigger.id, rootMessageId: input.rootMessageId, status: 'queued' })
      } })
    registerTaskTools({ dispatcher, roomDb, repository: repo, timeline, queueRun: queue })
    registerFinishTaskTool({ dispatcher, settlement })

    const task = queue.createTask({ chatId, roleId: a, title: 'Proof task', description: 'Do it', acceptance: 'Done' })
    roomDb.database.prepare("UPDATE task_runs SET status = 'running' WHERE id = ?").run(task.runId)
    roomDb.database.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.taskId)
    const trigger = timeline.append({ chatId, authorType: 'user', authorId: 'user', content: '@A begin', status: 'done' })
    dispatcher.bindRun(task.runId, { chatId, roleId: a,
      allowedTools: ['mention', 'create_task', 'finish_task'], rootMessageId: trigger.id })

    server = await createMcpHttpServer({ dispatcher, runId: task.runId })
    client = new Client({ name: 'room-mcp-proof', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    }))
    const listed = await client.listTools()
    const toolNames = listed.tools.map(tool => tool.name).sort()
    const mention = await client.callTool({ name: 'mention', arguments: { names: ['B'], text: 'please review' } })
    const created = await client.callTool({ name: 'create_task', arguments: {
      title: 'Created over MCP', description: 'D', acceptance: 'A' } })
    const finished = await client.callTool({ name: 'finish_task', arguments: {
      taskId: task.taskId, status: 'ready', summary: 'done' } })

    const result = {
      ok: toolNames.length === 3
        && mention.structuredContent?.targets?.[0] === b
        && typeof created.structuredContent?.taskId === 'string'
        && finished.structuredContent?.report?.kind === 'ready',
      toolNames,
      mentionTargets: mention.structuredContent?.targets ?? null,
      createdTaskId: created.structuredContent?.taskId ?? null,
      createdRunId: created.structuredContent?.runId ?? null,
      finishReportKind: finished.structuredContent?.report?.kind ?? null,
      queuedReplyCount: queuedReplies.length,
    }
    const resultPath = path.join(userData, 'room-mcp-proof.json')
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ stage: 'complete', resultPath, ...result }))
    if (!result.ok) process.exitCode = 1
  } finally {
    try { await client?.close() } catch { /* best effort */ }
    try { await server?.close() } catch { /* best effort */ }
    roomDb.close()
  }
}

main().catch(error => {
  console.error(JSON.stringify({ stage: 'failed', code: String(error?.code || error?.message || error) }))
  process.exitCode = 1
})
