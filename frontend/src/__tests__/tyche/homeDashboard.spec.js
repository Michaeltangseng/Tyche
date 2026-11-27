import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HomeDashboard from '../../components/HomeDashboard.vue'
import { setLocale } from '../../i18n.js'

const rooms = [
  {
    id: 'room-1',
    name: 'Studio',
    workspace_label: 'demo',
    chats: [
      {
        id: 'older',
        title: 'Older chat',
        updated_at: '2026-11-20T08:00:00Z',
        members: [{ id: 'solo', name: 'Claude', provider: 'claude', is_captain: true }],
      },
      {
        id: 'newer',
        title: '两人按顺序讲笑话',
        activity: { name: '小李', author: 'agent', text: '该你了', created_at: '2026-11-27T10:00:00Z' },
        members: [
          { id: 'captain', name: 'Captain', provider: 'claude', is_captain: true, last_seq: 1 },
          { id: 'wang', name: '老王', provider: 'codex', last_seq: 4 },
          { id: 'li', name: '小李', provider: 'pi', last_seq: 3 },
          { id: 'extra', name: 'Forge', provider: 'gemini', last_seq: 2 },
        ],
      },
    ],
  },
]

function mountHome() {
  return mount(HomeDashboard, {
    props: {
      groups: [],
      installedCount: 2,
      onboardingCompleted: true,
      readyAgents: [{ kind: 'claude', label: 'Claude Code', ready: true }],
      refreshing: false,
      teamRooms: rooms,
      theme: 'dark',
    },
  })
}

describe('home dashboard recent chats', () => {
  it('lists room chats with a clustered member stack and opens the chosen chat', async () => {
    setLocale('zh')
    const wrapper = mountHome()
    const items = wrapper.findAll('.home-recent-item')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('两人按顺序讲笑话')
    expect(items[0].text()).toContain('小李：该你了')
    expect(items[0].get('.home-chat-stack').attributes('data-count')).toBe('3')
    expect(items[0].findAll('.home-chat-face')).toHaveLength(3)
    expect(items[1].get('.home-chat-stack').attributes('data-count')).toBe('1')
    expect(wrapper.find('.home-agent-panel').exists()).toBe(false)
    expect(wrapper.get('.home-recent-list').exists()).toBe(true)

    await items[0].trigger('click')
    expect(wrapper.emitted('select-chat')?.[0]).toEqual(['room-1', 'newer'])
    wrapper.unmount()
  })
})
