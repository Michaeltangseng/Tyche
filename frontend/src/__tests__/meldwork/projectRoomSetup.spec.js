import { ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ProjectRoomCreateDialog from '../../components/ProjectRoomCreateDialog.vue'
import ProjectRoomSeatSettings from '../../components/ProjectRoomSeatSettings.vue'

const t = (key, params = {}) => {
  if (params.count != null) return `${key}:${params.count}`
  if (params.name) return `${key}:${params.name}`
  return key
}

function template() {
  return {
    id: 'builtin-default',
    version: 1,
    name: 'Default playbook',
    checkpointDefs: [{
      key: 'requirements',
      name: 'Requirements',
      gate: 'hard',
      roundLimit: 3,
      leadSeatId: 'seat-lead',
      reviewerSeatIds: ['seat-review'],
      draftSeatIds: [],
    }],
    seatTemplates: [
      {
        key: 'seat-lead', roleName: 'Lead', duty: 'Write.', agentKind: 'codex',
        capabilities: ['read'], profileText: 'Lead profile',
      },
      {
        key: 'seat-review', roleName: 'Reviewer', duty: 'Review.', agentKind: 'claude',
        capabilities: ['read'], profileText: 'Review profile',
      },
    ],
  }
}

function createController(overrides = {}) {
  const api = {
    chooseWorkdir: vi.fn(async () => ({ token: 'token-1', displayName: 'demo-work' })),
    templates: vi.fn(async () => ({ templates: [template()] })),
    capabilities: vi.fn(async () => ({
      capabilities: {
        readExec: true, managedProcess: true, fullTrace: true, writeSessionContinuity: true,
      },
    })),
    create: vi.fn(async input => ({ projectId: 'project-1', input })),
    ...overrides.api,
  }
  return {
    ...overrides,
    agentOptions: ref([
      { kind: 'codex', label: 'Codex', available: true },
      { kind: 'claude', label: 'Claude Code', available: true },
    ]),
    api,
    close: vi.fn(),
    onCreated: vi.fn(async () => {}),
    onOpenExisting: vi.fn(),
    t,
  }
}

function seatController(overrides = {}) {
  const api = {
    capabilities: vi.fn(async () => ({
      capabilities: {
        readExec: true, managedProcess: true, fullTrace: true, writeSessionContinuity: true,
      },
    })),
    updateSeat: vi.fn(async () => ({})),
    updateProfile: vi.fn(async () => ({})),
    rollbackProfile: vi.fn(async () => ({})),
    addSeat: vi.fn(async () => ({})),
    removeSeat: vi.fn(async () => ({})),
    ...overrides.api,
  }
  const projectSnapshot = ref({
    config: {
      configRevision: 2,
      seats: [{
        id: 'seat-lead',
        roleName: 'Lead',
        duty: 'Write.',
        agentKind: 'codex',
        capabilities: ['read'],
        checkpointRoles: [],
        profileVersionId: 'profile-1',
        profile: { id: 'profile-1', version: 1, text: 'Old profile' },
        profileVersions: [{
          id: 'profile-1', version: 1, text: 'Old profile', source: 'default',
        }],
      }],
      playbook: { checkpointDefs: [{ leadSeatId: 'seat-lead', reviewerSeatIds: [] }] },
    },
  })
  return {
    ...overrides,
    agentOptions: ref([{ kind: 'codex', label: 'Codex', available: true }]),
    api,
    close: vi.fn(),
    projectId: ref('project-1'),
    projectSnapshot,
    refreshProject: vi.fn(async () => {}),
    t,
  }
}

describe('project room creation', () => {
  it('walks through workdir, playbook, seats, and creates the project room', async () => {
    const fixture = createController()
    const wrapper = mount(ProjectRoomCreateDialog, { props: { controller: fixture } })
    await flushPromises()

    await wrapper.findAll('.setup-section .primary-button')[0].trigger('click')
    await flushPromises()
    expect(fixture.api.chooseWorkdir).toHaveBeenCalled()
    expect(wrapper.text()).toContain('projectRoom.setup.selected:demo-work')

    await wrapper.findAll('.setup-section .primary-button')[1].trigger('click')
    expect(wrapper.find('.setup-playbook').exists()).toBe(true)
    expect(wrapper.text()).toContain('Requirements')
    await wrapper.findAll('.setup-section .primary-button')[0].trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.setup-seat-chip')).toHaveLength(2)
    expect(wrapper.findAll('.setup-seat-detail')).toHaveLength(1)
    expect(wrapper.find('.setup-seat-detail').text()).toContain('Lead')

    await wrapper.findAll('.setup-section .primary-button')[0].trigger('click')
    await flushPromises()
    expect(fixture.api.create).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token-1',
      name: 'demo-work',
      templateId: 'builtin-default',
      templateVersion: 1,
      seats: expect.arrayContaining([
        expect.objectContaining({ id: 'seat-lead', agentKind: 'codex' }),
        expect.objectContaining({ id: 'seat-review', agentKind: 'claude' }),
      ]),
    }))
    expect(fixture.onCreated).toHaveBeenCalledWith('project-1')
    expect(fixture.close).toHaveBeenCalled()
  })

  it('adds a seat from the local Agent avatars and selects it for editing', async () => {
    const fixture = createController()
    const wrapper = mount(ProjectRoomCreateDialog, { props: { controller: fixture } })
    await flushPromises()
    await wrapper.findAll('.setup-section .primary-button')[0].trigger('click')
    await flushPromises()
    await wrapper.findAll('.setup-section .primary-button')[1].trigger('click')
    await wrapper.findAll('.setup-section .primary-button')[0].trigger('click')
    await flushPromises()

    const claudeTile = wrapper.findAll('.setup-agent-tile')
      .find(tile => tile.text().includes('Claude Code'))
    await claudeTile.trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.setup-seat-chip')).toHaveLength(3)
    expect(wrapper.find('.setup-seat-detail').text()).toContain('projectRoom.setup.newSeat')
    expect(wrapper.find('.setup-seat-detail select').element.value).toBe('claude')
    expect(wrapper.findAll('.setup-seat-chip.active')).toHaveLength(1)
  })

  it('opens an existing project room instead of creating a duplicate', async () => {
    const fixture = createController({
      api: {
        chooseWorkdir: vi.fn(async () => ({
          existingProjectId: 'project-existing',
          displayName: 'existing',
        })),
      },
    })
    const wrapper = mount(ProjectRoomCreateDialog, { props: { controller: fixture } })
    await flushPromises()
    await wrapper.findAll('.setup-section .primary-button')[0].trigger('click')
    expect(fixture.onOpenExisting).toHaveBeenCalledWith('project-existing')
    expect(fixture.close).toHaveBeenCalled()
  })
})

describe('project room seat settings', () => {
  it('saves a seat with the current config revision', async () => {
    const fixture = seatController()
    const wrapper = mount(ProjectRoomSeatSettings, { props: { controller: fixture } })
    await flushPromises()
    expect(wrapper.text()).toContain('Lead')
    expect(wrapper.text()).toContain('projectRoom.seats.profileSource.default')
    expect(wrapper.text()).not.toContain('v1 · default')
    await wrapper.get('.setup-seat input[type="text"]').setValue('Lead writer')
    await wrapper.get('.setup-seat .primary-button').trigger('click')
    await flushPromises()
    expect(fixture.api.updateSeat).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      configRevision: 2,
      seat: expect.objectContaining({ id: 'seat-lead', roleName: 'Lead writer' }),
    }))
    expect(fixture.refreshProject).toHaveBeenCalled()
  })

  it('reloads on a stale config revision and saves profiles', async () => {
    const fixture = seatController({
      api: {
        updateSeat: vi.fn(async () => {
          throw Object.assign(new Error('PROJECT_CONFIG_STALE'), {
            code: 'PROJECT_CONFIG_STALE',
          })
        }),
      },
    })
    const wrapper = mount(ProjectRoomSeatSettings, { props: { controller: fixture } })
    await flushPromises()
    await wrapper.get('.setup-seat .primary-button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('projectRoom.seats.staleReloaded')
    expect(fixture.refreshProject).toHaveBeenCalled()

    await wrapper.get('.setup-seat textarea').setValue('New profile')
    const profileButton = wrapper.findAll('.setup-seat .secondary-button')
      .find(button => button.text() === 'projectRoom.seats.saveProfile')
    await profileButton.trigger('click')
    await flushPromises()
    expect(fixture.api.updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      seatId: 'seat-lead',
      text: 'New profile',
      configRevision: 2,
    }))
  })
})
