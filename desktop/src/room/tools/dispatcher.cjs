const crypto = require('node:crypto')

function stableStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function hashArgs(args) {
  return crypto.createHash('sha256').update(stableStringify(args ?? {})).digest('hex')
}

function createToolDispatcher({ roomDb, repository, now = () => Date.now() }) {
  const { database } = roomDb
  const tools = new Map()
  const runs = new Map()

  function at() {
    return new Date(now()).toISOString()
  }

  function contextFor(runId, binding, callId) {
    return {
      runId,
      callId,
      chatId: binding.chatId,
      roleId: binding.roleId,
      captainAssignmentId: binding.captainAssignmentId ?? null,
      rootMessageId: binding.rootMessageId ?? null,
    }
  }

  function recordReadOnly({ runId, callId, name, argsHash, status, result, error }) {
    database.prepare(`
      INSERT INTO tool_calls (id, run_id, call_id, tool_name, args_hash, status, result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      runId,
      `${callId}:audit:${crypto.randomUUID()}`,
      name,
      argsHash,
      status,
      JSON.stringify(result ?? (error ? { error: error.message } : null)),
      at(),
      at(),
    )
  }

  return {
    bindRun(runId, { chatId, roleId, allowedTools, captainAssignmentId = null, rootMessageId = null }) {
      if (!Array.isArray(allowedTools)) throw new TypeError('ROOM_TOOL_ALLOWED_TOOLS_REQUIRED')
      runs.set(runId, { chatId, roleId, allowedTools: [...allowedTools], captainAssignmentId, rootMessageId })
    },

    register(name, handler, { readOnly = false, description = '', inputSchema = { type: 'object' } } = {}) {
      if (typeof handler !== 'function') throw new TypeError('ROOM_TOOL_HANDLER_REQUIRED')
      tools.set(name, { handler, readOnly, description, inputSchema })
    },

    listTools(runId = null) {
      const binding = runId ? runs.get(runId) : null
      return [...tools.entries()]
        .filter(([name]) => !binding || binding.allowedTools.includes(name))
        .map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema }))
    },

    async invoke({ runId, callId, name, args }) {
      const binding = runs.get(runId)
      if (!binding) throw new Error('ROOM_TOOL_RUN_NOT_BOUND')
      if (!binding.allowedTools.includes(name)) throw new Error('ROOM_TOOL_NOT_ALLOWED')
      const tool = tools.get(name)
      if (!tool) throw new Error('ROOM_TOOL_NOT_FOUND')
      const argsHash = hashArgs(args)
      const context = contextFor(runId, binding, callId)

      if (tool.readOnly) {
        try {
          const result = await tool.handler(args ?? {}, context)
          recordReadOnly({ runId, callId, name, argsHash, status: 'succeeded', result })
          return result
        } catch (error) {
          recordReadOnly({ runId, callId, name, argsHash, status: 'failed', error })
          throw error
        }
      }

      const existing = database.prepare('SELECT * FROM tool_calls WHERE run_id = ? AND call_id = ?').get(runId, callId)
      if (existing) {
        if (existing.args_hash !== argsHash) throw new Error('ROOM_TOOL_CALL_ARGS_MISMATCH')
        if (existing.status === 'succeeded') return JSON.parse(existing.result_json)
        if (existing.status === 'failed') {
          const stored = JSON.parse(existing.result_json)
          throw new Error(stored?.error ?? 'ROOM_TOOL_CALL_FAILED')
        }
        throw new Error('ROOM_TOOL_CALL_IN_PROGRESS')
      }

      const id = crypto.randomUUID()
      database.prepare(`
        INSERT INTO tool_calls (id, run_id, call_id, tool_name, args_hash, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(id, runId, callId, name, argsHash, at(), at())
      try {
        const result = await tool.handler(args ?? {}, context)
        database.prepare("UPDATE tool_calls SET status = 'succeeded', result_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(result ?? null), at(), id)
        return result
      } catch (error) {
        database.prepare("UPDATE tool_calls SET status = 'failed', result_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify({ error: error?.message ?? String(error) }), at(), id)
        throw error
      }
    },
  }
}

module.exports = { createToolDispatcher }
