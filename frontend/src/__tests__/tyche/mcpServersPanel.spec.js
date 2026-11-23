import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import McpServersPanel from '../../components/McpServersPanel.vue'
import { setLocale } from '../../i18n.js'

describe('MCP servers panel', () => {
  afterEach(() => {
    delete window.tycheDesktop
  })

  it('lists read-only MCP servers from the native inventory', async () => {
    setLocale('en')
    window.tycheDesktop = {
      nativeMcp: {
        list: vi.fn().mockResolvedValue([
          { name: 'filesystem', transport: 'stdio', agents: ['Claude', 'Gemini'] },
          { name: 'github', transport: 'http', agents: ['Claude'] },
        ]),
      },
    }
    const wrapper = mount(McpServersPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('MCP Servers')
    expect(wrapper.text()).toContain('filesystem')
    expect(wrapper.text()).toContain('Claude · Gemini')
    expect(wrapper.text()).toContain('github')
    expect(wrapper.text()).toContain('http')
    wrapper.unmount()
  })
})
