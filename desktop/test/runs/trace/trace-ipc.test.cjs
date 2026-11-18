const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { encodeId } = require('../../../src/runs/trace/trace-ids.cjs')
const {
  createTraceAppendedNotifier,
  registerTraceIpc,
} = require('../../../src/shell/trace-ipc.cjs')
const { createTraceReader } = require('../../../src/runs/trace/trace-reader.cjs')
const { createTraceSink } = require('../../../src/runs/trace/trace-writer.cjs')

function makeReader(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-trace-ipc-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tracesRoot = path.join(root, 'traces')
  const sink = createTraceSink({
    tracesRoot, runId: 'run-1', agentRunId: 'agent-1', groupId: 'group-1',
  })
  sink.ingest('acp', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-1',
    title: 'tool',
    status: 'completed',
    content: [{ type: 'text', text: 'hello' }],
  })
  sink.end()
  return createTraceReader({
    tracesRoot,
    isKnownGroup: groupId => groupId === 'group-1',
  })
}

function register(reader) {
  const handlers = new Map()
  registerTraceIpc({
    registerTrustedHandle: (channel, handler) => { handlers.set(channel, handler) },
    reader,
    store: {
      diskUsage: () => ({ bytes: 10, runs: 1 }),
      prune: () => ({ removed: 1, bytes: 10 }),
    },
  })
  return handlers
}

test('trace IPC registers page, blob, and status handlers', async (t) => {
  const reader = makeReader(t)
  const handlers = register(reader)
  assert.deepEqual([...handlers.keys()], [
    'trace:page', 'trace:blob', 'trace:status', 'trace:diskUsage', 'trace:prune',
  ])

  const page = await handlers.get('trace:page')({
    runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 10,
  })
  assert.equal(page.steps.length, 1)
  assert.equal(page.steps[0].output, 'hello')
  const status = await handlers.get('trace:status')({
    runId: 'run-1', agentRunId: 'agent-1',
  })
  assert.equal(status.lastSeq, 1)
  assert.equal(status.complete, true)
  assert.deepEqual(await handlers.get('trace:diskUsage')({}), { bytes: 10, runs: 1 })
  assert.deepEqual(await handlers.get('trace:prune')({ groupId: 'group-1' }), { removed: 1, bytes: 10 })
})

test('trace IPC rejects invalid inputs and unknown runs', async (t) => {
  const reader = makeReader(t)
  const handlers = register(reader)
  await assert.rejects(
    async () => handlers.get('trace:page')({
      runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 10, extra: true,
    }),
    { code: 'TRACE_NOT_FOUND' },
  )
  await assert.rejects(
    async () => handlers.get('trace:status')({ runId: 'run-2', agentRunId: 'agent-1' }),
    { code: 'TRACE_NOT_FOUND' },
  )
  await assert.rejects(
    async () => handlers.get('trace:blob')({
      runId: 'run-1', agentRunId: 'agent-1', blobId: 'bad id', offset: 0, length: 10,
    }),
    { code: 'TRACE_NOT_FOUND' },
  )
})

test('trace:appended notifications are coalesced to five per second', () => {
  let now = 0
  const timers = new Map()
  let timerId = 0
  const sent = []
  const notifier = createTraceAppendedNotifier({
    send: payload => sent.push(payload),
    now: () => now,
    setTimeoutFn: (fn, ms) => {
      timerId += 1
      timers.set(timerId, { fn, at: now + ms })
      return timerId
    },
  })
  notifier.notify({ runId: 'run-1', agentRunId: 'agent-1', lastSeq: 1 })
  assert.equal(sent.length, 1)
  notifier.notify({ runId: 'run-1', agentRunId: 'agent-1', lastSeq: 2 })
  notifier.notify({ runId: 'run-1', agentRunId: 'agent-1', lastSeq: 3 })
  assert.equal(sent.length, 1)
  assert.equal(timers.size, 1)
  now = 200
  for (const [id, timer] of [...timers]) {
    timers.delete(id)
    timer.fn()
  }
  assert.deepEqual(sent.at(-1), { runId: 'run-1', agentRunId: 'agent-1', lastSeq: 3 })
  notifier.notify({ runId: 'run-2', agentRunId: 'agent-2', lastSeq: 1 })
  assert.equal(sent.length, 3)
})
