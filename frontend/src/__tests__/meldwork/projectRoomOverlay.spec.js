import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ProjectRoomOverlay from '../../components/ProjectRoomOverlay.vue'

const t = (key, params = {}) => (
  params.count == null ? key : `${key}:${params.count}`
)

function impact(overrides = {}) {
  return {
    targetCheckpointId: 'cp-0',
    affectedCheckpointIds: ['cp-1', 'cp-2'],
    activeInvocationEffectIds: ['effect-1'],
    impactHash: 'impact-hash',
    ...overrides,
  }
}

function controller(overrides = {}) {
  return {
    checkpointDefs: ref([
      { key: 'requirements', name: 'Requirements', gate: 'hard', type: 'document', dependsOn: [] },
      { key: 'architecture', name: 'Architecture', gate: 'hard', type: 'document', dependsOn: ['requirements'] },
      { key: 'milestone', name: 'Milestone', gate: 'soft', type: 'milestone', dependsOn: ['architecture'] },
    ]),
    close: vi.fn(),
    deleteProjectRoom: vi.fn(async () => ({ deleted: true })),
    onDeleted: vi.fn(),
    overlay: ref({ kind: 'reject', projectId: 'project-1', projectName: 'Project One' }),
    previewRejectUpstream: vi.fn(async () => impact()),
    previewReopenCheckpoint: vi.fn(async () => impact()),
    progressItems: ref([
      { checkpointId: 'cp-0', checkpointKey: 'requirements', name: 'Requirements', label: 'Accepted' },
      { checkpointId: 'cp-1', checkpointKey: 'architecture', name: 'Architecture', label: 'Reviewing' },
      { checkpointId: 'cp-2', checkpointKey: 'milestone', name: 'Milestone', label: 'Pending' },
    ]),
    projectName: 'Project One',
    rejectPreview: ref(null),
    submitReject: vi.fn(async () => ({ ok: true })),
    submitReopen: vi.fn(async () => ({ ok: true })),
    t,
    unlockProjectDirectory: vi.fn(async () => true),
    upstreamCheckpoints: ref([
      { checkpointId: 'cp-0', name: 'Requirements', label: 'Accepted', gate: null },
    ]),
    workdirName: 'project-one',
    ...overrides,
  }
}

describe('project room overlays', () => {
  it('walks through reject preview and submits a required reason', async () => {
    const fixture = controller()
    const wrapper = mount(ProjectRoomOverlay, { props: { controller: fixture } })

    expect(wrapper.text()).toContain('projectRoom.overlay.rejectStepOne')
    await wrapper.get('.overlay-list-row').trigger('click')
    expect(fixture.previewRejectUpstream).toHaveBeenCalledWith('cp-0')
    expect(wrapper.text()).toContain('projectRoom.overlay.affected:2')
    expect(wrapper.text()).toContain('projectRoom.overlay.cancelCalls:1')
    expect(wrapper.text()).toContain('projectRoom.overlay.hardGate')
    expect(wrapper.text()).toContain('projectRoom.overlay.milestone')

    const confirm = wrapper.get('.primary-button')
    expect(confirm.attributes('disabled')).toBeDefined()
    await wrapper.get('textarea').setValue('Needs a redesign')
    await confirm.trigger('click')
    expect(fixture.submitReject).toHaveBeenCalledWith('Needs a redesign', 'impact-hash')
    expect(fixture.close).toHaveBeenCalled()
  })

  it('returns to the preview step when the impact changed', async () => {
    const fixture = controller({
      submitReject: vi.fn(async () => ({ ok: false, impactChanged: true })),
      rejectPreview: ref(impact({ impactHash: 'new-hash', affectedCheckpointIds: ['cp-1'] })),
    })
    const wrapper = mount(ProjectRoomOverlay, { props: { controller: fixture } })
    await wrapper.get('.overlay-list-row').trigger('click')
    await wrapper.get('textarea').setValue('Reason')
    await wrapper.get('.primary-button').trigger('click')
    expect(wrapper.text()).toContain('projectRoom.overlay.impactChanged')
    expect(wrapper.text()).toContain('projectRoom.overlay.affected:1')
    expect(fixture.submitReject).toHaveBeenLastCalledWith('Reason', 'impact-hash')
  })

  it('reopens an accepted checkpoint and keeps the reason', async () => {
    const fixture = controller({
      overlay: ref({
        kind: 'reopen',
        projectId: 'project-1',
        checkpointId: 'cp-1',
        projectName: 'Project One',
      }),
      previewReopenCheckpoint: vi.fn(async () => impact()),
    })
    const wrapper = mount(ProjectRoomOverlay, { props: { controller: fixture } })
    await wrapper.vm.$nextTick()
    expect(fixture.previewReopenCheckpoint).toHaveBeenCalledWith('cp-1')
    await wrapper.get('textarea').setValue('Revisit the decision')
    await wrapper.get('.primary-button').trigger('click')
    expect(fixture.submitReopen).toHaveBeenCalledWith('cp-1', 'Revisit the decision', 'impact-hash')
    expect(fixture.close).toHaveBeenCalled()
  })

  it('confirms project room deletion and directory unlock', async () => {
    const fixture = controller({
      overlay: ref({ kind: 'delete', projectId: 'project-1', projectName: 'Project One' }),
    })
    const wrapper = mount(ProjectRoomOverlay, { props: { controller: fixture } })
    expect(wrapper.text()).toContain('projectRoom.overlay.deleteWarning')
    expect(wrapper.text()).toContain('projectRoom.overlay.deleteCannotCancel')
    await wrapper.get('.overlay-check input').setValue(true)
    await wrapper.get('.danger-button').trigger('click')
    expect(fixture.deleteProjectRoom).toHaveBeenCalledWith('project-1', true)
    expect(fixture.close).toHaveBeenCalled()
    expect(fixture.onDeleted).toHaveBeenCalled()

    const unlock = controller({
      overlay: ref({ kind: 'unlock', projectId: 'project-1' }),
    })
    const unlockWrapper = mount(ProjectRoomOverlay, { props: { controller: unlock } })
    expect(unlockWrapper.get('.primary-button').attributes('disabled')).toBeDefined()
    await unlockWrapper.get('input[type="text"]').setValue('project-one')
    expect(unlockWrapper.get('.primary-button').attributes('disabled')).toBeUndefined()
    await unlockWrapper.get('.primary-button').trigger('click')
    expect(unlock.unlockProjectDirectory).toHaveBeenCalledWith('project-one')
  })

  it('Escape goes back a reject step before closing', async () => {
    const fixture = controller()
    const wrapper = mount(ProjectRoomOverlay, { props: { controller: fixture } })
    await wrapper.get('.overlay-list-row').trigger('click')
    await wrapper.get('.project-room-overlay').trigger('keydown.esc')
    expect(fixture.close).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('projectRoom.overlay.rejectStepOne')
    await wrapper.get('.project-room-overlay').trigger('keydown.esc')
    expect(fixture.close).toHaveBeenCalled()
  })
})
