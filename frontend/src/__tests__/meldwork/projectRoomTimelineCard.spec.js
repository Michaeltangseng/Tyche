import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ProjectRoomTimelineCard from '../../components/ProjectRoomTimelineCard.vue'

const t = (key, params = {}) => {
  if (params.name) return `${key}:${params.name}`
  if (params.outcome) return `${key}:${params.outcome}`
  return key
}

function mountCard(card, overrides = {}) {
  return mount(ProjectRoomTimelineCard, {
    props: {
      card,
      formatNavTime: () => '09:00',
      selectGate: vi.fn(),
      stopDelivery: vi.fn(),
      t,
      ...overrides,
    },
  })
}

describe('project timeline cards', () => {
  it('renders checkpoint and decided/voided gate summaries', () => {
    const checkpoint = mountCard({
      kind: 'checkpoint', name: 'Requirements', at: '2026-11-14T09:00:00Z',
      generation: 1, reopened: false, reason: 'doc-new-version',
    })
    expect(checkpoint.text()).toContain('Requirements')
    expect(checkpoint.text()).toContain('projectRoom.timeline.started')
    expect(checkpoint.text()).toContain('projectRoom.gate.reason.doc-new-version')

    const decided = mountCard({
      kind: 'gate-decided', name: 'Requirements', at: '2026-11-14T09:00:00Z',
      outcome: 'accept', reason: 'needs-human', comment: 'Accepted.',
    })
    expect(decided.text()).toContain('projectRoom.timeline.gateDecided')
    expect(decided.text()).toContain('Accepted.')

    const voided = mountCard({
      kind: 'gate-voided', name: 'Requirements', at: '2026-11-14T09:00:00Z',
    })
    expect(voided.text()).toContain('projectRoom.timeline.gateVoided')
  })

  it('opens a live gate and stops a queued interjection', async () => {
    const selectGate = vi.fn()
    const gate = mountCard({
      kind: 'gate', name: 'Architecture', checkpointId: 'cp-2',
      reason: 'needs-human',
    }, { selectGate })
    await gate.get('.project-timeline-gate').trigger('click')
    expect(selectGate).toHaveBeenCalledWith('cp-2')

    const stopDelivery = vi.fn()
    const interjection = mountCard({
      kind: 'interjection', name: 'Requirements', checkpointId: 'cp-1',
      content: 'Consider this.',
    }, { stopDelivery })
    expect(interjection.text()).toContain('Consider this.')
    await interjection.get('.project-timeline-action').trigger('click')
    expect(stopDelivery).toHaveBeenCalledWith('cp-1')
  })

  it('labels a running checkpoint and translates who it waits for', () => {
    const wrapper = mountCard({
      kind: 'running', name: 'Requirements', checkpointId: 'cp-1',
      state: 'leading', waitingOn: 'reviewers', generation: 1,
    })
    expect(wrapper.text()).toContain('Requirements')
    expect(wrapper.text()).toContain('projectRoom.state.leading')
    expect(wrapper.text()).toContain('projectRoom.state.reviewing')
    expect(wrapper.text()).not.toContain('reviewers')
  })
})
