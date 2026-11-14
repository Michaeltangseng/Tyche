import { computed, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ProjectRoomComposer from '../../components/ProjectRoomComposer.vue'
import ProjectRoomProgress from '../../components/ProjectRoomProgress.vue'

function progressController(overrides = {}) {
  return {
    activeTargetId: 'cp-1',
    currentItem: {
      checkpointId: 'cp-1',
      name: 'Requirements',
      label: 'Reviewing',
      round: 2,
      leadSeatName: 'Lead',
      elapsed: '12 min elapsed',
      state: 'reviewing',
    },
    lastActivityLabel: '09:50',
    progressItems: [
      {
        checkpointId: 'cp-1', name: 'Requirements', label: 'Reviewing', glyph: '◉', state: 'reviewing',
      },
      {
        checkpointId: 'cp-2', name: 'Architecture', label: 'Accepted', glyph: '✓', state: 'accepted',
      },
    ],
    requestReopen: vi.fn(),
    selectTarget: vi.fn(),
    t: key => key,
    ...overrides,
  }
}

function composerController(overrides = {}) {
  const draft = ref('')
  return {
    canSend: computed(() => draft.value.trim().length > 0),
    draft,
    openProjectChat: vi.fn(),
    otherGateCount: 1,
    selectNextGateTarget: vi.fn(),
    sendErrorLabel: '',
    sendLabel: 'Send and continue',
    sendTargetText: vi.fn(),
    targetAvailable: true,
    targetHint: 'Write an opinion',
    targetLabel: 'Requirements',
    targetPurposeLabel: 'Gate comment',
    t: key => key,
    ...overrides,
  }
}

describe('project room progress', () => {
  it('renders the chain, summary, full list, and reopen entry', async () => {
    const controller = progressController()
    const wrapper = mount(ProjectRoomProgress, { props: { controller } })

    expect(wrapper.findAll('.progress-step')).toHaveLength(2)
    expect(wrapper.get('.progress-summary').text()).toContain('Requirements')
    expect(wrapper.get('.progress-summary').text()).toContain('Reviewing')
    expect(wrapper.get('.progress-summary').text()).toContain('projectRoom.progress.round')
    expect(wrapper.get('.progress-summary').text()).toContain('projectRoom.progress.lastActivity')
    expect(wrapper.find('.progress-list').exists()).toBe(false)

    await wrapper.get('.progress-toggle').trigger('click')
    expect(wrapper.findAll('.progress-row')).toHaveLength(2)
    expect(wrapper.get('.progress-reopen').text()).toBe('projectRoom.progress.reopen')
    await wrapper.get('.progress-reopen').trigger('click')
    expect(controller.requestReopen).toHaveBeenCalledWith('cp-2')

    await wrapper.findAll('.progress-step')[1].trigger('click')
    expect(controller.selectTarget).toHaveBeenCalledWith('cp-2')
  })
})

describe('project room composer', () => {
  it('binds the per-target draft and sends it explicitly', async () => {
    const controller = composerController()
    const wrapper = mount(ProjectRoomComposer, { props: { controller } })

    expect(wrapper.get('.project-target-label').text()).toBe('projectRoom.composer.operating')
    expect(wrapper.get('.project-target-purpose').text()).toBe('Gate comment')
    expect(wrapper.get('textarea').attributes('placeholder')).toBe('Write an opinion')
    expect(wrapper.get('.send-button').attributes('disabled')).toBeDefined()

    await wrapper.get('textarea').setValue('Please revise')
    expect(controller.draft.value).toBe('Please revise')
    expect(wrapper.get('.send-button').attributes('disabled')).toBeUndefined()
    await wrapper.get('.send-button').trigger('click')
    expect(controller.sendTargetText).toHaveBeenCalledTimes(1)
  })

  it('shows send errors, target switching, and the project chat entry', async () => {
    const controller = composerController({ sendErrorLabel: 'Target changed' })
    const wrapper = mount(ProjectRoomComposer, { props: { controller } })

    expect(wrapper.get('.project-composer-error').text()).toBe('Target changed')
    await wrapper.get('.project-target-next').trigger('click')
    expect(controller.selectNextGateTarget).toHaveBeenCalledTimes(1)
    await wrapper.get('.project-target-chat').trigger('click')
    expect(controller.openProjectChat).toHaveBeenCalledTimes(1)
  })

  it('disables input when the target is unavailable', () => {
    const wrapper = mount(ProjectRoomComposer, {
      props: { controller: composerController({ targetAvailable: false }) },
    })
    expect(wrapper.get('textarea').attributes('disabled')).toBeDefined()
  })
})
