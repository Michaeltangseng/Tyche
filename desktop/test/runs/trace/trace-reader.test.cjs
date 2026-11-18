const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { encodeId } = require('../../../src/runs/trace/trace-ids.cjs')
const { createTraceReader } = require('../../../src/runs/trace/trace-reader.cjs')
const { createTraceSink } = require('../../../src/runs/trace/trace-writer.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-trace-reader-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    root,
    tracesRoot: path.join(root, 'traces'),
    file: path.join(root, 'traces', encodeId('run-1'), `${encodeId('agent-1')}.jsonl`),
  }
}

function writeTrace(paths, toolCallTexts = ['step-1', 'step-2', 'step-3', 'step-4', 'step-5']) {
  const sink = createTraceSink({
    tracesRoot: paths.tracesRoot,
    runId: 'run-1',
    agentRunId: 'agent-1',
    groupId: 'group-1',
  })
  toolCallTexts.forEach((text, index) => {
    sink.ingest('acp', {
      sessionUpdate: 'tool_call_update',
      toolCallId: `tool-${index + 1}`,
      title: 'tool',
      status: 'completed',
      content: [{ type: 'text', text }],
    })
  })
  sink.end()
}

function reader(paths) {
  return createTraceReader({
    tracesRoot: paths.tracesRoot,
    isKnownGroup: groupId => groupId === 'group-1',
  })
}

test('status reports sequence, completion, and bytes', (t) => {
  const paths = fixture(t)
  writeTrace(paths)
  const status = reader(paths).status({ runId: 'run-1', agentRunId: 'agent-1' })
  assert.equal(status.lastSeq, 5)
  assert.equal(status.complete, true)
  assert.equal(status.incomplete, false)
  assert.ok(status.bytes > 0)
})

test('forward and backward pages move the opaque cursor', (t) => {
  const paths = fixture(t)
  writeTrace(paths)
  const trace = reader(paths)

  const first = trace.page({
    runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 2,
  })
  assert.deepEqual(first.steps.map(step => step.seq), [1, 2])
  assert.equal(first.hasMore, true)
  const second = trace.page({
    runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 2,
    cursor: first.cursor,
  })
  assert.deepEqual(second.steps.map(step => step.seq), [3, 4])
  const third = trace.page({
    runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 2,
    cursor: second.cursor,
  })
  assert.deepEqual(third.steps.map(step => step.seq), [5])
  assert.equal(third.hasMore, false)

  const last = trace.page({
    runId: 'run-1', agentRunId: 'agent-1', direction: 'backward', limit: 2,
  })
  assert.deepEqual(last.steps.map(step => step.seq), [4, 5])
  assert.equal(last.hasMore, true)
  const earlier = trace.page({
    runId: 'run-1', agentRunId: 'agent-1', direction: 'backward', limit: 2,
    cursor: last.cursor,
  })
  assert.deepEqual(earlier.steps.map(step => step.seq), [2, 3])
  assert.equal(earlier.hasMore, true)
})

test('a forged or mismatched cursor is rejected', (t) => {
  const paths = fixture(t)
  writeTrace(paths)
  const trace = reader(paths)
  const page = trace.page({
    runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 2,
  })
  assert.throws(
    () => trace.page({
      runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 2,
      cursor: `${page.cursor.slice(0, -1)}x`,
    }),
    { code: 'TRACE_CURSOR_INVALID' },
  )
  assert.throws(
    () => trace.page({
      runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 2,
      cursor: 'not-a-cursor',
    }),
    { code: 'TRACE_CURSOR_INVALID' },
  )
})

test('an unknown run or group is rejected', (t) => {
  const paths = fixture(t)
  writeTrace(paths)
  const trace = reader(paths)
  assert.throws(
    () => trace.status({ runId: 'run-2', agentRunId: 'agent-1' }),
    { code: 'TRACE_NOT_FOUND' },
  )
  const foreign = createTraceReader({
    tracesRoot: paths.tracesRoot,
    isKnownGroup: () => false,
  })
  assert.throws(
    () => foreign.status({ runId: 'run-1', agentRunId: 'agent-1' }),
    { code: 'TRACE_NOT_FOUND' },
  )
})

test('a throwing known-group lookup falls through to room authorization', (t) => {
  const paths = fixture(t)
  writeTrace(paths)
  const trace = createTraceReader({
    tracesRoot: paths.tracesRoot,
    isKnownGroup: () => { throw Object.assign(new Error('LOCAL_GROUP_NOT_FOUND'), { code: 'LOCAL_GROUP_NOT_FOUND' }) },
    isAuthorizedTrace: ({ runId, agentRunId, meta }) => runId === 'run-1' && agentRunId === 'agent-1' && meta.groupId === 'group-1',
  })
  assert.equal(trace.status({ runId: 'run-1', agentRunId: 'agent-1' }).lastSeq, 5)
  assert.equal(trace.page({ runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 10 }).steps.length, 5)
})

test('Room traces require the main-process assignment authorization callback', (t) => {
  const paths = fixture(t)
  writeTrace(paths)
  const denied = createTraceReader({ tracesRoot: paths.tracesRoot })
  assert.throws(() => denied.page({ runId: 'run-1', agentRunId: 'agent-1' }), error => error.code === 'TRACE_NOT_FOUND')
  const allowed = createTraceReader({ tracesRoot: paths.tracesRoot,
    isAuthorizedTrace: ({ runId, agentRunId, meta }) => runId === 'run-1' && agentRunId === 'agent-1' && meta.groupId === 'group-1' })
  assert.equal(allowed.page({ runId: 'run-1', agentRunId: 'agent-1' }).steps.length, 5)
})

test('a trailing half line is ignored and marks the trace incomplete', (t) => {
  const paths = fixture(t)
  writeTrace(paths)
  fs.appendFileSync(paths.file, '{"seq":6,"kind":"message"')
  const status = reader(paths).status({ runId: 'run-1', agentRunId: 'agent-1' })
  assert.equal(status.incomplete, true)
  assert.equal(status.complete, false)
  const page = reader(paths).page({
    runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 10,
  })
  assert.equal(page.steps.length, 5)
})

test('blob reads respect byte offsets, UTF-8 boundaries, and eof', (t) => {
  const paths = fixture(t)
  const text = '你好世界'.repeat(30000)
  writeTrace(paths, [text])
  const trace = reader(paths)
  const page = trace.page({
    runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 1,
  })
  const blobId = page.steps[0].blobs.output.blobId
  let offset = 0
  let assembled = ''
  for (let index = 0; index < 1000; index += 1) {
    const part = trace.blob({
      runId: 'run-1', agentRunId: 'agent-1', blobId, offset, length: 1000,
    })
    assembled += part.text
    offset += Buffer.byteLength(part.text)
    if (part.eof) break
  }
  assert.equal(assembled, text)
  const first = trace.blob({
    runId: 'run-1', agentRunId: 'agent-1', blobId, offset: 0, length: 1,
  })
  assert.equal(first.text, '')
  assert.equal(first.eof, false)
  assert.equal(first.totalBytes, Buffer.byteLength(text))
})

test('a page stops before the 512 KiB serialized cap', (t) => {
  const paths = fixture(t)
  const large = 'x'.repeat(100 * 1024)
  writeTrace(paths, [large, large, large])
  const page = reader(paths).page({
    runId: 'run-1', agentRunId: 'agent-1', direction: 'forward', limit: 10,
  })
  assert.equal(page.steps.length, 2)
  assert.equal(page.hasMore, true)
  assert.ok(Buffer.byteLength(JSON.stringify(page.steps)) <= 512 * 1024)
})
