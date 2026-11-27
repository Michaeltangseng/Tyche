import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RoomCollaborationRibbon from '../../components/RoomCollaborationRibbon.vue'
import { setLocale } from '../../i18n.js'

const ROLES = [
  {
    id: 'claude',
    display_name: 'Claude Code',
    provider: 'claude',
    provider_label: 'Claude Code',
    is_captain: true,
    can_speak: true,
  },
  {
    id: 'codex',
    display_name: 'Codex',
    provider: 'codex',
    provider_label: 'Codex',
    is_captain: false,
    can_speak: true,
  },
  {
    id: 'pi',
    display_name: 'Pi',
    provider: 'pi',
    provider_label: 'Pi',
    is_captain: false,
    can_speak: false,
  },
]

function mountRibbon(state, roles = ROLES) {
  return mount(RoomCollaborationRibbon, {
    props: {
      state,
      roles,
      busy: false,
      canAdd: true,
    },
  })
}

beforeEach(() => {
  setLocale('en')
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-15T10:05:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('room collaboration ribbon', () => {
  it('keeps the static cast before work starts and opens a role', async () => {
    const wrapper = mountRibbon({ mode: 'idle', nodes: [], replies: [] })

    expect(wrapper.findAll('.room-agent-chip')).toHaveLength(3)
    expect(wrapper.get('.room-captain-mark').attributes('title')).toBe('Captain')
    expect(wrapper.find('.room-chip-live').exists()).toBe(false)

    await wrapper.findAll('.room-agent-chip')[1].trigger('click')
    expect(wrapper.emitted('select-role')?.at(-1)).toEqual(['codex'])

    await wrapper.get('.room-agent-add').trigger('click')
    expect(wrapper.emitted('add-role')).toHaveLength(1)
    wrapper.unmount()
  })

  it('surfaces an unavailable agent with a warning pill', async () => {
    const roles = [
      ...ROLES,
      {
        id: 'kimi',
        display_name: '笑匠丙',
        provider: 'kimi',
        provider_label: 'Kimi',
        is_captain: false,
        can_speak: false,
        unavailable: true,
        availability_note: 'This Agent is not available on this machine.',
      },
    ]
    const wrapper = mountRibbon({ mode: 'idle', nodes: [], replies: [] }, roles)

    const warning = wrapper.get('.room-cast-warning')
    expect(warning.text()).toContain('Agents unavailable: 1')
    await warning.trigger('click')
    expect(wrapper.emitted('select-role')?.at(-1)).toEqual(['kimi'])
    wrapper.unmount()
  })

  it('lights up only the agent that is replying and keeps a timer', () => {
    const wrapper = mountRibbon({
      mode: 'replying',
      nodes: [],
      replies: [{
        roleId: 'claude',
        since: '2026-11-15T10:03:00Z',
        messageId: 'message-1',
      }],
      activeRoleId: 'claude',
      activeSince: '2026-11-15T10:03:00Z',
    })

    const chips = wrapper.findAll('.room-agent-chip')
    expect(chips[0].attributes('data-speaking')).toBe('true')
    expect(chips[1].attributes('data-speaking')).toBeUndefined()
    expect(chips[0].get('.room-chip-live').text()).toBe('2:00')
    wrapper.unmount()
  })

  it('keeps the member row and leaves the header status off', () => {
    const wrapper = mountRibbon({
      mode: 'running',
      nodes: [{ roleId: 'codex', state: 'active', status: 'running' }],
      replies: [{ roleId: 'codex', messageId: 'message-codex', since: '2026-11-15T10:04:00Z' }],
    })

    expect(wrapper.findAll('.room-agent-chip')).toHaveLength(3)
    expect(wrapper.find('.room-status').exists()).toBe(false)
    expect(wrapper.find('.room-thought').exists()).toBe(false)
    wrapper.unmount()
  })

  it('collapses members that do not fit and lists them from +N', async () => {
    const wrapper = mountRibbon({ mode: 'idle', nodes: [], replies: [] })
    wrapper.get('.room-cast-row').element.setAttribute('data-measure-client', '640')
    wrapper.findAll('[data-member-chip]').forEach(chip => chip.element.setAttribute('data-measure-width', '220'))
    await wrapper.setProps({ busy: true })
    const visible = wrapper.findAll('.room-agent-chip').filter(chip => chip.element.style.display !== 'none')
    expect(visible).toHaveLength(1)
    const more = wrapper.get('.room-member-more')
    expect(more.text()).toBe('+2')
    await more.trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.room-member-popover').exists()).toBe(false)
    await more.trigger('click')
    const hidden = wrapper.get('.room-member-popover').findAll('button')
    expect(hidden).toHaveLength(2)
    await hidden[0].trigger('click')
    expect(wrapper.emitted('select-role')?.at(-1)).toEqual(['codex'])
    expect(wrapper.find('.room-member-popover').exists()).toBe(false)
    wrapper.unmount()
  })
})
