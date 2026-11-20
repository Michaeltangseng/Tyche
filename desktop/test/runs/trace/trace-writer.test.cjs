const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { encodeId } = require('../../../src/runs/trace/trace-ids.cjs')
const { createTraceSink } = require('../../../src/runs/trace/trace-writer.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-trace-writer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    root,
    tracesRoot: path.join(root, 'traces'),
    runDir: path.join(root, 'traces', encodeId('run-1')),
    file: path.join(root, 'traces', encodeId('run-1'), `${encodeId('agent-1')}.jsonl`),
  }
}

function manualTimers() {
  const timers = new Map()
  let id = 0
  return {
    setTimeoutFn(fn, ms) {
      id += 1
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeoutFn(timer) {
      timers.delete(timer)
    },
    fire(ms) {
      for (const [timer, entry] of [...timers]) {
        if (entry.ms !== ms) continue
        timers.delete(timer)
        entry.fn()
      }
    },
    size: () => timers.size,
  }
}

function makeSink(t, options = {}) {
  const paths = fixture(t)
  let clock = Date.parse('2026-11-14T08:00:00.000Z')
  const appended = []
  const sink = createTraceSink({
    tracesRoot: paths.tracesRoot,
    runId: 'run-1',
    agentRunId: 'agent-1',
    groupId: 'group-1',
    projectId: 'project-1',
    agentKind: 'claude',
    outputFormat: 'stream-json',
    now: () => new Date(clock += 1000).toISOString(),
    onAppended: payload => appended.push(payload),
    ...options,
  })
  return { ...paths, sink, appended }
}

function readSteps(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

test('writes meta.json and appends complete steps with private permissions', (t) => {
  const { runDir, file, sink } = makeSink(t)
  sink.ingest('acp', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello world' },
  })
  sink.end()

  const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'))
  assert.equal(meta.runId, 'run-1')
  assert.equal(meta.groupId, 'group-1')
  assert.equal(meta.projectId, 'project-1')
  assert.ok(meta.createdAt)
  assert.equal(fs.statSync(runDir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const steps = readSteps(file)
  assert.equal(steps.length, 1)
  assert.equal(steps[0].seq, 1)
  assert.equal(steps[0].kind, 'message')
  assert.equal(steps[0].output, 'hello world')
  assert.ok(steps[0].at)
})

test('batches appends on the one-second timer and reports lastSeq', (t) => {
  const timers = manualTimers()
  const { file, sink, appended } = makeSink(t, timers)
  sink.ingest('structured', { type: 'one', value: 1 })
  sink.ingest('structured', { type: 'two', value: 2 })
  assert.deepEqual(readSteps(file), [])
  timers.fire(1000)
  const steps = readSteps(file)
  assert.equal(steps.length, 2)
  assert.deepEqual(appended.at(-1), { runId: 'run-1', agentRunId: 'agent-1', lastSeq: 2 })
  sink.end()
})

test('flushes once the buffered bytes reach 64 KiB', (t) => {
  const timers = manualTimers()
  const { file, sink } = makeSink(t, timers)
  const payload = 'x'.repeat(1024)
  for (let index = 0; index < 70; index += 1) {
    sink.ingest('structured', { type: 'item', payload })
  }
  assert.ok(readSteps(file).length > 0)
  sink.end()
  assert.equal(timers.size(), 0)
})

test('stream text is split at four KiB after redaction', (t) => {
  const timers = manualTimers()
  const { file, sink } = makeSink(t, {
    ...timers,
    childEnv: { TEST_API_KEY: 'tyche-test-secret-123456' },
  })
  sink.ingest('acp', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `secret tyche-test-secret-123456 ${'word '.repeat(2000)}` },
  })
  sink.end()
  const steps = readSteps(file)
  assert.ok(steps.length > 1)
  assert.ok(steps.every(step => step.kind === 'message'))
  assert.equal(steps.some(step => step.output.includes('tyche-test-secret-123456')), false)
  assert.equal(fs.readFileSync(file, 'utf8').includes('tyche-test-secret-123456'), false)
})

test('a short released stream chunk waits for the 500ms boundary', (t) => {
  const timers = manualTimers()
  const { file, sink } = makeSink(t, timers)
  sink.ingest('acp', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `${'a '.repeat(700)}done` },
  })
  assert.deepEqual(readSteps(file), [])
  timers.fire(500)
  timers.fire(1000)
  assert.ok(readSteps(file).length >= 1)
  sink.end()
})

test('fields over 256 KiB are written to blobs and referenced from the step', (t) => {
  const { file, runDir, sink } = makeSink(t)
  const text = 'y'.repeat(300 * 1024)
  sink.ingest('acp', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-1',
    title: 'Read',
    status: 'completed',
    content: [{ type: 'text', text }],
  })
  sink.end()
  const steps = readSteps(file)
  assert.equal(steps.length, 1)
  assert.equal(steps[0].output, undefined)
  assert.ok(steps[0].blobs.output.blobId)
  const blobFile = path.join(runDir, `${encodeId('agent-1')}.blobs`, `${steps[0].blobs.output.blobId}.txt`)
  assert.equal(fs.readFileSync(blobFile, 'utf8'), text)
})

test('content before it is released never reaches the trace file', (t) => {
  const { file, sink } = makeSink(t)
  sink.ingest('acp', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Bearer abc' },
  })
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', '')
  sink.ingest('acp', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'def' },
  })
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', '')
  sink.end()
  assert.equal(fs.readFileSync(file, 'utf8').includes('abcdef'), false)
})

test('a write failure does not throw and ends with an incomplete marker', (t) => {
  let failures = 1
  const paths = fixture(t)
  const sink = createTraceSink({
    tracesRoot: paths.tracesRoot,
    runId: 'run-1',
    agentRunId: 'agent-1',
    groupId: 'group-1',
    outputFormat: 'unknown',
    writeFault: () => {
      if (failures > 0) {
        failures -= 1
        throw Object.assign(new Error('TRACE_WRITE_FAILED'), { code: 'TRACE_WRITE_FAILED' })
      }
    },
  })
  assert.doesNotThrow(() => sink.ingest('structured', { type: 'one' }))
  assert.doesNotThrow(() => sink.end())
  const steps = readSteps(paths.file)
  assert.ok(steps.some(step => step.kind === 'lifecycle' && step.title === 'trace-incomplete'))
})

test('invalid run identifiers are rejected at creation', (t) => {
  const paths = fixture(t)
  assert.throws(() => createTraceSink({
    tracesRoot: paths.tracesRoot,
    runId: 'bad id',
    agentRunId: 'agent-1',
    groupId: 'group-1',
  }), { code: 'TRACE_INPUT_INVALID' })
})
