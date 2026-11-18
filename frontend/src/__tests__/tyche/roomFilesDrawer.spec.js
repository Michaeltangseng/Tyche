import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RoomFilesDrawer from '../../components/RoomFilesDrawer.vue'
import { setLocale } from '../../i18n.js'

const cleanup = []
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()) })

function mountDrawer(overrides = {}) {
  setLocale('en')
  const api = {
    filesList: vi.fn(async () => ({
      entries: [
        { name: 'docs', kind: 'directory', size: 0, mtime: '2026-11-16T00:00:00Z' },
        { name: 'README.md', kind: 'file', size: 5, mtime: '2026-11-16T00:00:00Z' },
      ],
      hasMore: false,
    })),
    filesRead: vi.fn(async () => ({ kind: 'text', text: 'hello', totalBytes: 5, eof: true, encoding: 'utf-8' })),
    ...overrides,
  }
  const wrapper = mount(RoomFilesDrawer, {
    props: { api, roomId: 'room-1', width: 420 },
  })
  cleanup.push(() => wrapper.unmount())
  return { wrapper, api }
}

describe('room files drawer', () => {
  it('lists the room workspace and previews a selected file', async () => {
    const { wrapper, api } = mountDrawer()
    await flushPromises()
    expect(api.filesList).toHaveBeenCalledWith({ roomId: 'room-1', relPath: '' })
    expect(wrapper.get('.project-room-drawer').text()).toContain('Files')
    expect(wrapper.get('.workdir-tree').text()).toContain('README.md')

    await wrapper.get('.workdir-tree-file').trigger('click')
    await flushPromises()
    expect(api.filesRead).toHaveBeenCalledWith({ roomId: 'room-1', relPath: 'README.md' })
    expect(wrapper.get('.file-preview').text()).toContain('hello')
  })

  it('lists every agent total on the usage tab', async () => {
    const { wrapper } = mountDrawer()
    await wrapper.setProps({
      panel: 'usage',
      usage: [{
        id: 'captain',
        name: 'Claude Code',
        model: 'claude-haiku',
        status: 'idle',
        usage: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 0 },
        contextPercent: 3,
      }],
    })
    expect(wrapper.get('.room-usage-list').text()).toContain('Claude Code')
    expect(wrapper.get('.room-usage-list').text()).toContain('in 1.2k · out 340 · cache 0')
    expect(wrapper.get('.room-usage-list').text()).toContain('Context 3%')
    await wrapper.get('.project-room-drawer-tabs button').trigger('click')
    expect(wrapper.emitted('switch')[0]).toEqual(['files'])
  })

  it('emits close from the header and Escape', async () => {
    const { wrapper } = mountDrawer()
    await flushPromises()
    await wrapper.get('.project-room-drawer-header .icon-button').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toHaveLength(2)
  })
})
