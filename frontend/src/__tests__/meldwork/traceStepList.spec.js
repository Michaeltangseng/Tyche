import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import TraceStepList from '../../components/trace/TraceStepList.vue'

function controller(overrides = {}) {
  return {
    complete: ref(true),
    hasMore: ref(false),
    incomplete: ref(false),
    loadBlob: vi.fn(async () => ({ text: 'blob output' })),
    loadOlder: vi.fn(),
    loading: ref(false),
    steps: ref([
      { seq: 1, kind: 'thinking', output: 'I should inspect.', raw: { type: 'thinking', coalesced: true } },
      { seq: 2, kind: 'message', output: 'Hello.', raw: { type: 'message', coalesced: true } },
      {
        seq: 3, kind: 'tool', toolCallId: 'tool-1', title: 'Bash',
        status: 'running', command: 'ls -la', input: { command: 'ls -la' },
        raw: { type: 'tool_call' },
      },
      {
        seq: 4, kind: 'tool', toolCallId: 'tool-1', title: 'Bash',
        status: 'completed', output: 'total 2', raw: { type: 'tool_call_update' },
      },
    ]),
    t: (key, params = {}) => (params.count == null ? key : `${key}:${params.count}`),
    ...overrides,
  }
}

describe('TraceStepList', () => {
  it('groups tool steps by toolCallId and renders thinking and messages', () => {
    const wrapper = mount(TraceStepList, { props: { controller: controller() } })
    expect(wrapper.findAll('.trace-tool-activity')).toHaveLength(1)
    expect(wrapper.get('.trace-tool-activity').text()).toContain('Bash')
    expect(wrapper.get('.trace-tool-activity').text()).toContain('ls -la')
    expect(wrapper.text()).toContain('trace.steps.thinking')
    expect(wrapper.text()).toContain('I should inspect.')
  })

  it('switches between structured and raw views', async () => {
    const wrapper = mount(TraceStepList, { props: { controller: controller() } })
    await wrapper.get('.trace-step-view-toggle').trigger('click')
    expect(wrapper.find('.trace-raw-view').exists()).toBe(true)
    expect(wrapper.text()).toContain('Hello.')
    await wrapper.get('.trace-step-view-toggle').trigger('click')
    expect(wrapper.find('.trace-raw-view').exists()).toBe(false)
  })

  it('loads blob output on demand', async () => {
    const steps = ref([{
      seq: 1, kind: 'tool', toolCallId: 'tool-1', title: 'Read',
      status: 'completed', blobs: { output: { blobId: 'blob-1', bytes: 100 } },
    }])
    const fixture = controller({ steps })
    const wrapper = mount(TraceStepList, { props: { controller: fixture } })
    await wrapper.get('.trace-tool-load').trigger('click')
    await wrapper.vm.$nextTick()
    expect(fixture.loadBlob).toHaveBeenCalledWith('blob-1', { offset: 0, length: 100 })
    expect(wrapper.text()).toContain('blob output')
  })

  it('shows an incomplete warning and a load-older action', async () => {
    const fixture = controller({ incomplete: ref(true), hasMore: ref(true) })
    const wrapper = mount(TraceStepList, { props: { controller: fixture } })
    expect(wrapper.text()).toContain('trace.steps.incomplete')
    await wrapper.get('.trace-step-more').trigger('click')
    expect(fixture.loadOlder).toHaveBeenCalledTimes(1)
  })
})
