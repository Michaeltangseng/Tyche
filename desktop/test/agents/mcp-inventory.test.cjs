const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { listNativeMcpServers } = require('../../src/agents/mcp-inventory.cjs')

test('reads MCP servers from native Agent configs without exposing commands', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-mcp-inventory-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const saved = {}
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME']) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      github: { url: 'https://example.test/mcp', headers: { Authorization: 'secret' } },
    },
  }))
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    projects: {
      '/tmp/project': {
        mcpServers: { linear: { command: 'npx', args: ['linear-mcp'] } },
      },
    },
  }))

  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), [
    '[mcp_servers.playwright]',
    'command = "npx"',
    'args = ["@playwright/mcp"]',
    '',
  ].join('\n'))

  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true })
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
    },
  }))

  const servers = listNativeMcpServers({ home })
  const byName = new Map(servers.map(server => [server.name, server]))
  assert.deepEqual(byName.get('filesystem'), {
    name: 'filesystem',
    transport: 'stdio',
    agents: ['Claude', 'Gemini'],
  })
  assert.deepEqual(byName.get('github'), {
    name: 'github',
    transport: 'http',
    agents: ['Claude'],
  })
  assert.deepEqual(byName.get('linear'), {
    name: 'linear',
    transport: 'stdio',
    agents: ['Claude'],
  })
  assert.deepEqual(byName.get('playwright'), {
    name: 'playwright',
    transport: 'stdio',
    agents: ['Codex'],
  })
  const serialized = JSON.stringify(servers)
  assert.equal(serialized.includes('npx'), false)
  assert.equal(serialized.includes('example.test'), false)
  assert.equal(serialized.includes('secret'), false)
})
