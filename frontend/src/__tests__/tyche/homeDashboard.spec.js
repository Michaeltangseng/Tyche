import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HomeDashboard from '../../components/HomeDashboard.vue'
import { weeklyActivity } from '../../home-activity.js'
import { setLocale } from '../../i18n.js'

const rooms = [
  {
    id: 'room-1',
    name: 'Studio',
    workspace_label: 'demo',
    workspace_path: '/tmp/demo',
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
        activity: { name: '小李', author: 'agent', text: '该你了', created_at: '2026-11-27T04:00:00Z' },
        members: [
          { id: 'captain', name: 'Captain', provider: 'claude', is_captain: true, last_seq: 1 },
          { id: 'wang', name: '老王', provider: 'codex', last_seq: 4 },
          { id: 'li', name: '小李', provider: 'pi', last_seq: 3 },
        ],
      },
    ],
  },
]

function mountHome(extra = {}) {
  return mount(HomeDashboard, {
    props: {
      groups: [],
      installedCount: 2,
      localAgents: [
        { kind: 'claude', label: 'Claude Code', tone: 'ready', status: '可用' },
        { kind: 'codex', label: 'Codex', tone: 'warning', status: '需要登录' },
      ],
      onboardingCompleted: true,
      readyAgents: [{ kind: 'claude', label: 'Claude Code', ready: true }],
      refreshing: false,
      teamRooms: rooms,
      theme: 'dark',
      ...extra,
    },
  })
}

describe('home dashboard', () => {
  it('selects a recent chat before opening it or its folder', async () => {
    setLocale('zh')
    const wrapper = mountHome()
    const items = wrapper.findAll('.home-recent-item')
    expect(items[0].attributes('data-selected')).toBe('true')
    expect(items[0].text()).toContain('两人按顺序讲笑话')
    expect(items[0].find('.home-chat-face').exists()).toBe(false)
    expect(wrapper.text()).toContain('Claude Code')
    expect(wrapper.text()).toContain('Codex')
    expect(wrapper.text()).not.toContain('快捷任务')
    expect(wrapper.text()).toContain('1 个需要处理')
    expect(wrapper.text()).toContain('去配置')
    await wrapper.get('.home-configure').trigger('click')
    expect(wrapper.emitted('open-agent-manager')?.[0]).toEqual(['codex'])

    await items[1].trigger('click')
    expect(wrapper.emitted('select-chat')).toBeUndefined()
    expect(items[1].attributes('data-selected')).toBe('true')

    await items[1].get('.home-recent-open').trigger('click')
    expect(wrapper.emitted('select-chat')?.[0]).toEqual(['room-1', 'older'])

    await wrapper.get('.home-action[data-tone="folder"]').trigger('click')
    expect(wrapper.emitted('reveal-workspace')?.[0]).toEqual(['room-1'])

    await wrapper.get('.home-action[data-tone="agents"]').trigger('click')
    expect(wrapper.emitted('open-agent-manager')).toHaveLength(2)
    expect(wrapper.emitted('open-agent-manager')[1]).toEqual([])
    wrapper.unmount()
  })

  it('keeps open-workspace unavailable until the selected chat has a folder', async () => {
    const bare = structuredClone(rooms)
    bare[0].workspace_path = ''
    const wrapper = mountHome({ teamRooms: bare })
    const button = wrapper.get('.home-action[data-tone="folder"]')
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(wrapper.emitted('reveal-workspace')).toBeUndefined()
    wrapper.unmount()
  })

  it('shows seven days of token use and opens usage settings', async () => {
    window.tycheDesktop = {
      teamRoom: {
        usageReport: async () => ({
          series: [
            { date: '2026-11-21', providerTokens: { claude: 0 } },
            { date: '2026-11-27', providerTokens: { claude: 1200, codex: 300 } },
          ],
        }),
      },
    }
    const wrapper = mountHome()
    await flushPromises()
    expect(wrapper.findAll('.home-token-bars span')).toHaveLength(2)
    expect(wrapper.text()).toContain('1.5k')
    await wrapper.get('.home-token-panel .home-text-button').trigger('click')
    expect(wrapper.emitted('open-usage')).toHaveLength(1)
    delete window.tycheDesktop
    wrapper.unmount()
  })

  it('counts chats active on each of the last seven days', () => {
    const now = new Date('2026-11-27T12:00:00')
    const series = weeklyActivity([
      { id: 'a', at: '2026-11-27T01:00:00' },
      { id: 'a', at: '2026-11-27T02:00:00' },
      { id: 'b', at: '2026-11-27T03:00:00' },
      { id: 'c', at: '2026-11-20T03:00:00' },
    ], now)
    expect(series.days).toHaveLength(7)
    expect(series.today).toBe(2)
    expect(series.previous).toBe(1)
    expect(series.delta).toBeNull()
    const withBaseline = weeklyActivity([
      { id: 'a', at: '2026-11-27T01:00:00' },
      { id: 'p1', at: '2026-11-20T03:00:00' },
      { id: 'p2', at: '2026-11-19T03:00:00' },
      { id: 'p3', at: '2026-11-18T03:00:00' },
    ], now)
    expect(withBaseline.previous).toBe(3)
    expect(withBaseline.delta).toBe(-67)
  })
})
