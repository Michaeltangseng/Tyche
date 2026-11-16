import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RoomAssignmentTrace from '../../components/RoomAssignmentTrace.vue'
import { setLocale } from '../../i18n.js'

const cleanup = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()) })

function mountTrace(api) {
  setLocale('en')
  const wrapper = mount(RoomAssignmentTrace, {
    props: {
      api,
      roomId: 'room-1',
      assignment: { id: 'attempt', run_id: 'run-1' },
      workdir: '/tmp/project',
    },
  })
  cleanup.push(() => wrapper.unmount())
  return wrapper
}

function api(overrides = {}) {
  return {
    assignmentTrace: vi.fn(async () => ({
      steps: [
        { seq: 1, kind: 'tool', title: 'Read source', toolCallId: 'tool-1', input: { file_path: 'package.json' }, output: 'Opened package.json', status: 'completed' },
      ],
      cursor: 'cursor-1',
      hasMore: false,
    })),
    assignmentTraceBlob: vi.fn(async () => ({ text: 'trace output', totalBytes: 12, eof: true })),
    ...overrides,
  }
}

async function open(trace) {
  trace.element.open = true
  await trace.trigger('toggle')
  await flushPromises()
}

describe('room assignment trace', () => {
  it('loads once when expanded and renders structured activities', async () => {
    const bridge = api()
    const wrapper = mountTrace(bridge)
    expect(bridge.assignmentTrace).not.toHaveBeenCalled()
    await open(wrapper.get('.room-assignment-trace'))
    expect(bridge.assignmentTrace).toHaveBeenCalledWith({
      roomId: 'room-1', assignmentId: 'attempt', direction: 'backward', limit: 100,
    })
    expect(wrapper.get('.trace-step-list').text()).toContain('Read source')
    await wrapper.get('.room-assignment-trace').trigger('toggle')
    expect(bridge.assignmentTrace).toHaveBeenCalledTimes(1)
  })

  it('groups raw streaming messages into a readable output record', async () => {
    const bridge = api({
      assignmentTrace: vi.fn(async () => ({
        steps: [
          { seq: 1, kind: 'raw', title: 'init', raw: { type: 'init' } },
          { seq: 2, kind: 'raw', title: 'message', raw: { type: 'message', role: 'user', content: 'Task prompt' } },
          { seq: 3, kind: 'raw', title: 'message', raw: { type: 'message', role: 'assistant', content: 'Hello ' } },
          { seq: 4, kind: 'raw', title: 'message', raw: { type: 'message', role: 'assistant', content: 'world' } },
        ],
        hasMore: false,
      })),
    })
    const wrapper = mountTrace(bridge)
    await open(wrapper.get('.room-assignment-trace'))
    const text = wrapper.get('.trace-step-list').text()
    expect(text).toContain('Output record')
    expect(text).toContain('Hello world')
    expect(text).not.toContain('Task prompt')
  })

  it('loads large tool output through the assignment Blob endpoint', async () => {
    const bridge = api({
      assignmentTrace: vi.fn(async () => ({
        steps: [{
          seq: 1, kind: 'tool', title: 'Command', toolCallId: 'tool-1',
          blobs: { output: { blobId: '7-output' } }, status: 'completed',
        }],
        hasMore: false,
      })),
    })
    const wrapper = mountTrace(bridge)
    await open(wrapper.get('.room-assignment-trace'))
    await wrapper.get('.trace-step-row summary').trigger('click')
    await wrapper.get('.trace-step-load').trigger('click')
    await flushPromises()
    expect(bridge.assignmentTraceBlob).toHaveBeenCalledWith({
      roomId: 'room-1', assignmentId: 'attempt', blobId: '7-output', offset: 0, length: 256 * 1024,
    })
    expect(wrapper.get('.trace-step-output').text()).toBe('trace output')
  })
})
