const crypto = require('node:crypto')
const http = require('node:http')

const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js')

function createMcpHttpServer({ dispatcher, runId, host = '127.0.0.1', port = 0 }) {
  if (typeof runId !== 'string' || runId.length === 0) return Promise.reject(new Error('ROOM_MCP_RUN_ID_REQUIRED'))
  const token = crypto.randomBytes(24).toString('hex')

  function buildServer() {
    const server = new Server(
      { name: 'tyche-room', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: dispatcher.listTools(runId) }))
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args } = request.params
      const callId = request.params._meta?.callId ?? request.id ?? crypto.randomUUID()
      try {
        const result = await dispatcher.invoke({ runId, callId, name, args: args ?? {} })
        const structured = result !== null && typeof result === 'object' && !Array.isArray(result)
          ? result
          : { result: result ?? null }
        return {
          content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
          structuredContent: structured,
          _meta: { callId },
        }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error?.message ?? String(error) }], _meta: { callId } }
      }
    })
    return server
  }

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404
      res.end()
      return
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401
      res.end()
      return
    }
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      Promise.resolve(transport.close()).catch(() => {})
      Promise.resolve(server.close()).catch(() => {})
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500
        res.end(error?.message ?? String(error))
      }
    }
  })

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, () => {
      const address = httpServer.address()
      resolve({
        url: `http://${host}:${address.port}/mcp`,
        token,
        close: () => new Promise((done, fail) => {
          httpServer.closeAllConnections?.()
          httpServer.close(error => (error ? fail(error) : done()))
        }),
      })
    })
  })
}

module.exports = { createMcpHttpServer }
