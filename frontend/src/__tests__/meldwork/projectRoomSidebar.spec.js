import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../i18n.js'
import { mountApp } from './app-test-harness.js'

function group(id, name, overrides = {}) {
  return {
    id,
    name,
    topic: '',
    conversationType: 'group',
    agentKinds: ['codex'],
    workdir: '/tmp/meldwork-workspace',
    allowWrite: true,
    createdAt: '2026-07-29T08:00:00Z',
    updatedAt: '2026-07-29T08:00:00Z',
    ...overrides,
  }
}

function projectRoom(overrides = {}) {
  return {
    projectId: 'project-1',
    name: 'Project One',
    displayName: 'repo',
    readOnly: false,
    readOnlyReason: '',
    deleting: null,
    pendingGateCount: 1,
    unresolvedDriftCount: 0,
    residualCount: 0,
    ...overrides,
  }
}

function pendingDecision(overrides = {}) {
  return {
    type: 'gate',
    projectId: 'project-1',
    projectName: 'Project One',
    checkpointId: 'checkpoint-1',
    checkpointName: 'Requirements',
    reason: 'needs-human',
    itemId: 'gate-1',
    waitingSince: '2026-07-29T08:00:00Z',
    waitingMs: 5 * 60 * 1000,
    ...overrides,
  }
}

function seedProjects(state) {
  state.groups.push(
    group('main-1', 'Main chat', { projectId: 'project-1', projectRole: 'main' }),
    group('chat-1', 'Tech talk', { projectId: 'project-1' }),
    group('ordinary-1', 'Ordinary group'),
  )
  state.projectRooms = [projectRoom()]
  state.pendingDecisions = { items: [pendingDecision()], total: 1 }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('meldwork-theme', 'light')
  localStorage.setItem('meldwork-onboarding-seen-v1', '1')
  setLocale('en')
})

afterEach(() => {
  delete window.meldworkDesktop
  document.body.className = ''
  document.body.innerHTML = ''
})

describe('project room sidebar', () => {
  it('groups project chats under project rooms and opens the main chat from a pending decision', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      seedProjects(state)
    })

    expect(wrapper.findAll('.project-room-entry')).toHaveLength(1)
    expect(wrapper.get('.project-room-open').text()).toContain('Project One')
    expect(wrapper.get('.pending-decisions-count').text()).toBe('1')
    expect(wrapper.find('.pending-decisions-list').exists()).toBe(false)
    expect(wrapper.findAll('#sidebar-group-list .group-conversation-row')).toHaveLength(1)
    expect(wrapper.get('#sidebar-group-list').text()).toContain('Ordinary group')
    expect(wrapper.get('#sidebar-group-list').text()).not.toContain('Main chat')
    expect(wrapper.get('#sidebar-group-list').text()).not.toContain('Tech talk')
    expect(wrapper.findAll('.project-room-group')).toHaveLength(0)

    await wrapper.get('.project-room-toggle').trigger('click')
    expect(wrapper.findAll('.project-room-group')).toHaveLength(2)
    expect(wrapper.get('.project-room-groups').text()).toContain('Main chat')
    expect(wrapper.get('.project-room-groups').text()).toContain('Tech talk')

    await wrapper.get('.pending-decisions-heading').trigger('click')
    expect(wrapper.findAll('.pending-decision-row')).toHaveLength(1)
    expect(wrapper.get('.pending-decision-row').text()).toContain('Project One')
    expect(wrapper.get('.pending-decision-row').text()).toContain('Requirements')
    expect(wrapper.get('.pending-decision-row').text()).toContain('5 min')

    await wrapper.get('.pending-decision-row').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.project-room-group.active')).toHaveLength(1)
    expect(wrapper.get('.project-room-group.active').text()).toContain('Main chat')
    wrapper.unmount()
  })

  it('marks read-only and deleting project rooms', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push(
        group('main-1', 'Main chat', { projectId: 'project-1', projectRole: 'main' }),
        group('main-2', 'Main chat', { projectId: 'project-2', projectRole: 'main' }),
      )
      state.projectRooms = [
        projectRoom({ readOnly: true, pendingGateCount: 0 }),
        projectRoom({
          projectId: 'project-2',
          name: 'Project Two',
          deleting: { phase: 'draining', startedAt: '2026-07-29T08:00:00Z' },
          pendingGateCount: 0,
        }),
      ]
      state.pendingDecisions = { items: [], total: 0 }
    })

    const rooms = wrapper.findAll('.project-room-entry')
    expect(rooms).toHaveLength(2)
    expect(rooms[0].text()).toContain('Read-only')
    expect(rooms[1].text()).toContain('Deleting: draining')
    wrapper.unmount()
  })

  it('shows progress and the project composer in the main project chat', async () => {
    const { wrapper, bridge } = await mountApp(({ state, bridge: desktopBridge }) => {
      seedProjects(state)
      state.messages.push({
        id: 'message-1',
        groupId: 'main-1',
        role: 'agent',
        content: 'Working on the requirements.',
        createdAt: '2026-07-29T09:50:00Z',
        projectRoom: { checkpointId: 'cp-1' },
      })
      desktopBridge.projectRoom.snapshot.mockResolvedValue({
        projectId: 'project-1',
        revision: 1,
        progress: [{
          checkpointId: 'cp-1',
          checkpointKey: 'requirements',
          name: 'Requirements',
          state: 'leading',
          round: 1,
          roundsSinceHuman: 1,
          leadSeatId: 'seat-1',
          leadSeatName: 'Lead',
          reviewerSeatIds: [],
          waitingOn: 'lead',
          hasGate: false,
          blocked: false,
        }],
        gates: [],
        driftItems: [],
        outOfScopeItems: [],
        residuals: [],
        config: {},
      })
    })

    await wrapper.get('.project-room-open').trigger('click')
    await flushPromises()

    expect(wrapper.find('.project-room-progress').exists()).toBe(true)
    expect(wrapper.get('.project-room-progress').text()).toContain('Requirements')
    expect(wrapper.get('.project-room-progress').text()).toContain('Lead working')
    expect(wrapper.get('.project-room-progress').text()).toContain('Last activity')
    expect(wrapper.find('.project-room-composer-zone').exists()).toBe(true)
    expect(wrapper.find('.composer-context-row').exists()).toBe(false)
    expect(wrapper.get('.project-target-bar').text()).toContain('Operating on: Requirements')
    expect(wrapper.get('.project-target-bar').text()).toContain('Interjection')
    expect(wrapper.get('.project-composer-input').attributes('placeholder'))
      .toContain('Comment on Requirements')

    await wrapper.get('.project-composer-input').setValue('A note')
    await wrapper.get('.project-room-composer-zone .send-button').trigger('click')
    await flushPromises()
    expect(bridge.projectRoom.interject).toHaveBeenCalledWith({
      projectId: 'project-1',
      checkpointId: 'cp-1',
      purpose: 'interjection',
      text: 'A note',
    })
    wrapper.unmount()
  })

  it('shows no project room entries when the workspace snapshot does not include them', async () => {
    const { wrapper } = await mountApp(({ state }) => {
      state.groups.push(
        group('main-1', 'Main chat', { projectId: 'project-1', projectRole: 'main' }),
        group('ordinary-1', 'Ordinary group'),
      )
    })

    expect(wrapper.find('.project-room-nav-section').exists()).toBe(false)
    expect(wrapper.find('.pending-decisions-section').exists()).toBe(false)
    expect(wrapper.findAll('#sidebar-group-list .group-conversation-row')).toHaveLength(1)
    expect(wrapper.get('#sidebar-group-list').text()).toContain('Ordinary group')
    expect(wrapper.get('#sidebar-group-list').text()).not.toContain('Main chat')
    wrapper.unmount()
  })
})
