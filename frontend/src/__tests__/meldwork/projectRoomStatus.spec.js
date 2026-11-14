import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ProjectRoomStatus from '../../components/ProjectRoomStatus.vue'

function controller(overrides = {}) {
  return {
    cancelDriftResolution: vi.fn(async () => true),
    compactProject: vi.fn(async () => ({ revision: 8 })),
    diagnostics: ref(null),
    driftItems: ref([
      {
        id: 'drift-1', revision: 1, path: 'docs/a.md', checkpointId: 'cp-1',
        checkpointName: 'Requirements', foundAt: '2026-11-14T08:00:00.000Z',
        status: 'unresolved', placeholder: null, restorable: true,
      },
      {
        id: 'drift-2', revision: 1, path: 'assets/logo.png', checkpointId: 'cp-1',
        checkpointName: 'Requirements', foundAt: '2026-11-14T08:00:00.000Z',
        status: 'unresolved', placeholder: 'oversize', restorable: false,
      },
      {
        id: 'drift-3', revision: 1, path: 'docs/b.md', checkpointId: 'cp-2',
        checkpointName: 'Architecture', foundAt: '2026-11-14T08:00:00.000Z',
        status: 'resolving', placeholder: null, restorable: true,
      },
    ]),
    errorBar: ref({
      scope: 'project', checkpointId: null, effectId: 'effect-1',
      error: 'PROJECT_STORAGE_FAULT', retryable: true,
    }),
    formatNavTime: () => '08:00',
    loadDiagnostics: vi.fn(async () => ({ diagnostic: 'detail' })),
    openDriftDiff: vi.fn(),
    outOfScopeItems: ref([{
      id: 'scope-1', path: 'src/app.js', attribution: 'uncertain',
      detectedAt: '2026-11-14T08:00:00.000Z', status: 'unresolved',
    }]),
    progressItems: ref([
      { checkpointId: 'cp-1', name: 'Requirements', state: 'accepted' },
      { checkpointId: 'cp-2', name: 'Architecture', state: 'accepting' },
    ]),
    resolveDriftItems: vi.fn(async () => true),
    resolveOutOfScopeItems: vi.fn(async () => true),
    resolveResidual: vi.fn(async () => true),
    residuals: ref([{
      residualId: 'residual-1', pid: 1234, startedAt: '2026-11-14T08:00:00.000Z',
      agentKind: 'codex', programName: 'node', containerMarked: true,
    }]),
    retryProjectError: vi.fn(async () => true),
    statusErrorKey: ref(''),
    t: (key, params = {}) => (
      params.count == null ? key : `${key}:${params.count}`
    ),
    ...overrides,
  }
}

describe('project room status', () => {
  it('shows the error bar and its retry, diagnostics, and compact actions', async () => {
    const fixture = controller({
      t: (key, params = {}) => {
        if (key === 'errors.PROJECT_STORAGE_FAULT') return 'projectRoom.status.error.storageFault'
        return params.count == null ? key : `${key}:${params.count}`
      },
    })
    const wrapper = mount(ProjectRoomStatus, { props: { controller: fixture } })

    expect(wrapper.get('.status-error').text()).toContain('projectRoom.status.error.storageFault')
    expect(wrapper.get('.status-error').text()).not.toContain('PROJECT_STORAGE_FAULT')
    expect(wrapper.get('.status-error').text()).toContain('projectRoom.status.projectScope')
    await wrapper.findAll('.status-error .status-action')[0].trigger('click')
    expect(fixture.retryProjectError).toHaveBeenCalledTimes(1)
    await wrapper.findAll('.status-error .status-action')[1].trigger('click')
    expect(fixture.loadDiagnostics).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.status-diagnostics').exists()).toBe(true)
    await wrapper.findAll('.status-error .status-action')[2].trigger('click')
    expect(fixture.compactProject).toHaveBeenCalledTimes(1)
  })

  it('lists drift entries, waits on accepting checkpoints, and resolves selected entries', async () => {
    const fixture = controller()
    const wrapper = mount(ProjectRoomStatus, { props: { controller: fixture } })

    expect(wrapper.text()).toContain('docs/a.md')
    expect(wrapper.text()).toContain('assets/logo.png')
    expect(wrapper.text()).toContain('projectRoom.status.placeholder.oversize')
    expect(wrapper.text()).toContain('projectRoom.status.waitingWrite')
    expect(wrapper.text()).toContain('projectRoom.status.cancelResolution')

    const checkboxes = wrapper.findAll('.status-row input[type="checkbox"]')
    await checkboxes[0].setValue(true)
    const restore = wrapper.findAll('.status-actions .status-action')[0]
    const useWorkdir = wrapper.findAll('.status-actions .status-action')[1]
    expect(restore.attributes('disabled')).toBeUndefined()
    await useWorkdir.trigger('click')
    expect(fixture.resolveDriftItems).toHaveBeenCalledWith(['drift-1'], 'workdir')

    await checkboxes[1].setValue(true)
    expect(restore.attributes('disabled')).toBeDefined()
    expect(restore.attributes('title'))
      .toBe('projectRoom.status.placeholderRestoreUnavailable')
    await wrapper.findAll('.status-row-state .status-link')[0].trigger('click')
    expect(fixture.openDriftDiff).toHaveBeenCalledWith(fixture.driftItems.value[0])
    await wrapper.findAll('.status-row-state .status-link')[3].trigger('click')
    expect(fixture.cancelDriftResolution).toHaveBeenCalledWith('drift-3')
  })

  it('shows waiting for acceptance while the owning checkpoint is accepting', () => {
    const fixture = controller({
      driftItems: ref([{
        id: 'drift-accept', revision: 1, path: 'docs/c.md', checkpointId: 'cp-2',
        checkpointName: 'Architecture', foundAt: '2026-11-14T08:00:00.000Z',
        status: 'unresolved', placeholder: null, restorable: true,
      }]),
    })
    const wrapper = mount(ProjectRoomStatus, { props: { controller: fixture } })
    expect(wrapper.text()).toContain('projectRoom.status.waitingAccept')
    expect(wrapper.get('.status-row input[type="checkbox"]').attributes('disabled'))
      .toBeDefined()
  })

  it('handles out-of-scope entries and residual processes', async () => {
    const fixture = controller()
    const wrapper = mount(ProjectRoomStatus, { props: { controller: fixture } })

    expect(wrapper.text()).toContain('src/app.js')
    expect(wrapper.text()).toContain('projectRoom.status.attribution.uncertain')
    await wrapper.get('.status-section:nth-of-type(2) .status-action').trigger('click')
    expect(fixture.resolveOutOfScopeItems).toHaveBeenCalledWith(['scope-1'])

    expect(wrapper.text()).toContain('node')
    expect(wrapper.text()).toContain('PID 1234')
    expect(wrapper.text()).toContain('projectRoom.status.containerMarked')
    const residualButtons = wrapper.findAll('.status-section:nth-of-type(3) .status-action')
    await residualButtons[0].trigger('click')
    expect(fixture.resolveResidual).toHaveBeenCalledWith('residual-1', 'manuallyEnded')
    await residualButtons[1].trigger('click')
    expect(fixture.resolveResidual).toHaveBeenCalledWith('residual-1', 'notRelated')
  })
})
