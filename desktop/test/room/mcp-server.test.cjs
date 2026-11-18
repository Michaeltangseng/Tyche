const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { openRoomDatabase } = require('../../src/room/db.cjs')
const { createRoomRepository } = require('../../src/room/repository.cjs')
const { createToolDispatcher } = require('../../src/room/tools/dispatcher.cjs')
const { createMcpHttpServer } = require('../../src/room/tools/mcp-server.cjs')

test('mcp server lists and calls the bound tools', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-room-v2-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const roomDb = openRoomDatabase({ directory })
  const repo = createRoomRepository(roomDb)
  const roomId = repo.createRoom({ name: 'R', workspace: directory })
  const chatId = repo.createChat({ roomId, title: 'C' })
  const roleId = repo.createRole({ chatId, displayName: 'A', provider: 'claude', prompt: 'p' })
  repo.addParticipant({ chatId, roleId })
  const dispatcher = createToolDispatcher({ roomDb, repository: repo })
  dispatcher.register('echo', async args => ({ args }), {
    description: 'echo',
    inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
  })
  dispatcher.bindRun('run1', { chatId, roleId, allowedTools: ['echo'] })
  const server = await createMcpHttpServer({ dispatcher, runId: 'run1' })
  let client
  t.after(async () => {
    try { await client?.close() } catch { /* best effort */ }
    try { await server.close() } catch { /* best effort */ }
  })
  assert.equal(typeof server.token, 'string')
  const unauthorized = await fetch(server.url, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
  assert.equal(unauthorized.status, 401)
  client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
  }))
  const tools = await client.listTools()
  assert.equal(tools.tools.some(tool => tool.name === 'echo'), true)
  const result = await client.callTool({ name: 'echo', arguments: { x: 1 } })
  assert.deepEqual(result.structuredContent, { args: { x: 1 } })
  assert.equal(typeof result._meta?.callId, 'string')
  await client.close()
  await server.close()
  roomDb.close()
})
