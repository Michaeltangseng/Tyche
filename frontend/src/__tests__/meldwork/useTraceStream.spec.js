import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useTraceStream } from '../../composables/useTraceStream.js'

function fixture({ status = { lastSeq: 3, complete: true, incomplete: false, bytes: 10 } } = {}) {
  const listeners = []
  const page = vi.fn(async (input) => {
    if (input.direction === 'backward' && !input.cursor) {
      return {
        steps: [
          { seq: 2, kind: 'message', output: 'two' },
          { seq: 3, kind: 'message', output: 'three' },
        ],
        cursor: 'older',
        hasMore: true,
        complete: true,
      }
    }
    return {
      steps: [{ seq: 1, kind: 'message', output: 'one' }],
      cursor: 'start',
      hasMore: false,
      complete: true,
    }
  })
  const api = {
    page,
    status: vi.fn(async () => status),
    blob: vi.fn(async () => ({ text: 'blob text', totalBytes: 9, eof: true })),
    onAppended: vi.fn((listener) => {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    }),
  }
  const scope = effectScope()
  let stream
  scope.run(() => {
    stream = useTraceStream({
      runId: ref('run-1'),
      agentRunId: ref('agent-1'),
      api,
    })
  })
  return { api, listeners, scope, stream }
}

describe('useTraceStream', () => {
  it('opens the last page and pages backwards', async () => {
    const { stream, api, scope } = fixture()
    await stream.open()
    expect(api.page).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', agentRunId: 'agent-1', direction: 'backward',
    }))
    expect(stream.steps.value.map(step => step.seq)).toEqual([2, 3])
    expect(stream.hasMore.value).toBe(true)
    expect(stream.status.value.lastSeq).toBe(3)
    await stream.loadOlder()
    expect(stream.steps.value.map(step => step.seq)).toEqual([1, 2, 3])
    expect(stream.hasMore.value).toBe(false)
    scope.stop()
  })

  it('refreshes on appends only while viewing and at the bottom', async () => {
    const { stream, listeners, api, scope } = fixture()
    await stream.open()
    stream.setViewing(false)
    stream.setAtBottom(false)
    listeners[0]?.({ runId: 'run-1', agentRunId: 'agent-1', lastSeq: 4 })
    expect(api.page).toHaveBeenCalledTimes(1)
    stream.setViewing(true)
    listeners.at(-1)?.({ runId: 'run-1', agentRunId: 'agent-1', lastSeq: 5 })
    expect(api.page).toHaveBeenCalledTimes(1)
    stream.setAtBottom(true)
    listeners.at(-1)?.({ runId: 'run-1', agentRunId: 'agent-1', lastSeq: 6 })
    expect(api.page).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('loads blob pages through the trace API', async () => {
    const { stream, api, scope } = fixture()
    const result = await stream.loadBlob('blob-1', { offset: 0, length: 10 })
    expect(api.blob).toHaveBeenCalledWith({
      runId: 'run-1', agentRunId: 'agent-1', blobId: 'blob-1', offset: 0, length: 10,
    })
    expect(result.text).toBe('blob text')
    scope.stop()
  })
})
