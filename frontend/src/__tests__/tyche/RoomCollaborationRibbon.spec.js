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

function mountRibbon(state) {
  return mount(RoomCollaborationRibbon, {
    props: {
      state,
      roles: ROLES,
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

  it('renders the relay from real run facts with a spotlight and a stamp', () => {
    const wrapper = mountRibbon({
      mode: 'running',
      taskNumber: 3,
      taskLabel: 'Snake game',
      extraActiveTasks: 1,
      activeRoleId: 'codex',
      nodes: [
        {
          roleId: 'claude',
          state: 'done',
          status: 'completed',
          runId: 'run-1',
          activationKey: 'run-1:done',
        },
        {
          roleId: 'codex',
          state: 'active',
          status: 'running',
          runId: 'run-2',
          since: '2026-11-15T10:03:00Z',
          activationKey: 'run-2',
        },
        {
          roleId: 'pi',
          state: 'waiting',
          status: 'assigned',
          activationKey: 'pi:waiting',
        },
      ],
    })

    const nodes = wrapper.findAll('.room-relay-node')
    expect(nodes).toHaveLength(3)
    expect(nodes.map(node => node.attributes('data-state'))).toEqual(['done', 'active', 'waiting'])
    expect(nodes[0].find('.room-relay-stamp').exists()).toBe(true)
    expect(nodes[1].find('.room-relay-baton').exists()).toBe(true)
    expect(nodes[1].get('.room-relay-timer').text()).toBe('2:00')
    expect(wrapper.get('.room-relay-task').text()).toBe('#3')
    expect(wrapper.get('.room-relay-extra').text()).toBe('+1')
    expect(wrapper.text()).toContain('Standing by')
    expect(wrapper.findAll('.room-agent-chip')).toHaveLength(0)
    wrapper.unmount()
  })

  it('returns the cast with a quiet recap after the task settles', async () => {
    const wrapper = mountRibbon({
      mode: 'settled',
      tone: 'review',
      taskNumber: 3,
      taskLabel: 'Snake game',
      settledAt: '2026-11-15T10:04:00Z',
      nodes: [
        {
          roleId: 'claude',
          state: 'done',
          status: 'completed',
          runId: 'run-1',
          activationKey: 'run-1:done',
        },
        {
          roleId: 'codex',
          state: 'done',
          status: 'completed',
          activationKey: 'assignment:codex:done',
        },
      ],
    })

    expect(wrapper.findAll('.room-agent-chip')).toHaveLength(3)
    const recap = wrapper.get('.room-recap-pill')
    expect(recap.attributes('data-tone')).toBe('review')
    expect(recap.text()).toContain('Awaiting acceptance')
    expect(recap.text()).toContain('1 min ago')
    expect(recap.findAll('.room-recap-faces img')).toHaveLength(2)

    await recap.trigger('click')
    expect(wrapper.emitted('open-work')).toHaveLength(1)
    wrapper.unmount()
  })

  it('marks an interrupted run as attention in the recap', () => {
    const wrapper = mountRibbon({
      mode: 'settled',
      tone: 'attention',
      settledAt: '2026-11-15T10:04:00Z',
      nodes: [{
        roleId: 'codex',
        state: 'attention',
        status: 'failed',
        runId: 'run-2',
        activationKey: 'run-2:attention',
      }],
    })

    expect(wrapper.get('.room-recap-pill').attributes('data-tone')).toBe('attention')
    expect(wrapper.text()).toContain('Needs attention')
    wrapper.unmount()
  })
})
