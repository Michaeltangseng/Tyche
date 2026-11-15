import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const streamState = vi.hoisted(() => ({ current: null }))

vi.mock('../../composables/useTraceStream.js', () => ({
  useTraceStream: () => streamState.current,
}))

import InlineTrace from '../../components/trace/InlineTrace.vue'

function makeStream(steps) {
  return {
    complete: ref(true),
    hasFullTrace: ref(true),
    hasMore: ref(false),
    incomplete: ref(false),
    loadBlob: vi.fn(),
    loadOlder: vi.fn(),
    loading: ref(false),
    open: vi.fn(),
    setViewing: vi.fn(),
    steps: ref(steps),
  }
}

function mountTrace(overrides = {}) {
  const previewFile = vi.fn()
  const wrapper = mount(InlineTrace, {
    attrs: { onPreviewFile: previewFile },
    props: {
      agentRunId: 'agent-1',
      elapsedLabel: 'elapsed',
      previewFile,
      runId: 'run-1',
      status: 'completed',
      t: (key, params = {}) => (params.count == null ? key : `${key}:${params.count}`),
      workdir: '/tmp/project',
      ...overrides,
    },
  })
  return { previewFile, wrapper }
}

describe('InlineTrace activity summary', () => {
  beforeEach(() => {
    streamState.current = makeStream([
      { seq: 1, kind: 'thinking', output: 'think' },
      {
        seq: 2,
        kind: 'tool',
        toolCallId: 'tool-1',
        title: 'Write',
        status: 'running',
        input: { file_path: 'docs/requirements.md', content: 'one\ntwo\n' },
      },
      {
        seq: 3,
        kind: 'tool',
        toolCallId: 'tool-1',
        title: 'tool',
        status: 'completed',
        output: 'File created successfully at: /tmp/project/docs/requirements.md',
      },
    ])
  })

  it('collapses the process into counts and elapsed time', () => {
    const { wrapper } = mountTrace()

    const summary = wrapper.get('.agent-activity-summary')
    expect(summary.text()).toContain('trace.inline.thinking:1')
    expect(summary.text()).toContain('trace.inline.tools:1')
    expect(summary.text()).toContain('elapsed')
    expect(summary.get('.agent-activity-status').attributes('data-status')).toBe('completed')
    expect(wrapper.find('.agent-activity-details').exists()).toBe(false)

    const file = wrapper.get('.agent-file-card')
    expect(file.text()).toContain('requirements.md')
    expect(file.text()).toContain('trace.files.created')
    expect(file.text()).toContain('+2')
  })

  it('expands the detailed step list and previews a workdir file', async () => {
    const { previewFile, wrapper } = mountTrace()

    await wrapper.get('.agent-activity-summary').trigger('click')
    expect(wrapper.find('.agent-activity-details').exists()).toBe(true)
    expect(wrapper.get('.agent-activity-summary').attributes('aria-expanded')).toBe('true')
    expect(streamState.current.setViewing).toHaveBeenCalledWith(true)

    await wrapper.get('.agent-file-actions button').trigger('click')
    expect(previewFile).toHaveBeenCalledWith('docs/requirements.md')
  })

  it('shows a failure state and hides preview for paths outside the workdir', () => {
    streamState.current = makeStream([
      {
        seq: 1,
        kind: 'tool',
        toolCallId: 'tool-2',
        title: 'Edit',
        status: 'failed',
        input: { file_path: '/tmp/elsewhere/a.md', old_string: 'a', new_string: 'b' },
        output: 'The file /tmp/elsewhere/a.md has been updated successfully.',
      },
    ])
    const { wrapper } = mountTrace({ status: 'failed' })

    expect(wrapper.get('.agent-activity-status').attributes('data-status')).toBe('failed')
    expect(wrapper.get('.agent-file-card').text()).toContain('/tmp/elsewhere/a.md')
    expect(wrapper.find('.agent-file-actions button').exists()).toBe(false)
  })
})
