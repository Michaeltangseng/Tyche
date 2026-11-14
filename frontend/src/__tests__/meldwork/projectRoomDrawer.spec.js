import { nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectRoomDrawer from '../../components/ProjectRoomDrawer.vue'

const at = '2026-01-01T09:30:00.000Z'

function progressItem(overrides = {}) {
  return {
    checkpointId: 'cp-1',
    name: 'Requirements',
    state: 'accepted',
    hasPendingVersion: false,
    acceptedVersion: {
      id: 'version-2',
      files: ['docs/requirements.md'],
      acceptedAt: at,
    },
    ...overrides,
  }
}

function drawerController(overrides = {}) {
  return {
    close: vi.fn(),
    drawer: ref(false),
    formatNavTime: vi.fn(() => '09:30'),
    onResize: vi.fn(),
    open: ref(true),
    projectId: ref('project-1'),
    projectSnapshot: ref({
      readOnly: false,
      preferences: { drawerWidth: 500, drawerTab: 'files' },
      progress: [progressItem()],
    }),
    savePreferences: vi.fn(async () => ({})),
    t: key => key,
    ...overrides,
  }
}

afterEach(() => {
  document.body.className = ''
})

describe('project room drawer', () => {
  it('lists accepted documents with pending and stale markers', () => {
    const controller = drawerController()
    controller.projectSnapshot.value.progress = [
      progressItem(),
      progressItem({
        checkpointId: 'cp-2',
        name: 'Architecture',
        state: 'stale',
        hasPendingVersion: true,
        acceptedVersion: { id: 'version-1', files: ['docs/architecture.md'], acceptedAt: at },
      }),
      progressItem({
        checkpointId: 'cp-3',
        name: 'Research',
        state: 'pending',
        acceptedVersion: null,
      }),
    ]
    const wrapper = mount(ProjectRoomDrawer, { props: { controller } })

    const documents = wrapper.findAll('.accepted-doc')
    expect(documents).toHaveLength(2)
    expect(documents[0].text()).toContain('projectRoom.drawer.version')
    expect(documents[0].text()).toContain('docs/requirements.md')
    expect(documents[1].text()).toContain('projectRoom.state.stale')
    expect(documents[1].text()).toContain('projectRoom.drawer.pendingVersion')
    expect(documents[1].text()).toContain('docs/architecture.md')
  })

  it('restores the width and tab remembered for the project', async () => {
    const controller = drawerController()
    controller.projectSnapshot.value.preferences = { drawerWidth: 560, drawerTab: 'trace' }
    const wrapper = mount(ProjectRoomDrawer, { props: { controller } })

    expect(wrapper.get('.project-room-drawer').attributes('style')).toContain('width: 560px')
    expect(wrapper.get('.project-room-drawer-tabs .active').text()).toBe('projectRoom.drawer.trace')
    expect(wrapper.get('.project-room-drawer-body').text())
      .toContain('projectRoom.drawer.traceUnavailable')

    controller.projectSnapshot.value = {
      ...controller.projectSnapshot.value,
      preferences: { drawerWidth: 300, drawerTab: 'files' },
    }
    await nextTick()
    expect(wrapper.get('.project-room-drawer').attributes('style')).toContain('width: 300px')
    expect(wrapper.get('.project-room-drawer-tabs .active').text()).toBe('projectRoom.drawer.files')
  })

  it('saves the selected tab unless the project is read-only', async () => {
    const controller = drawerController()
    const wrapper = mount(ProjectRoomDrawer, { props: { controller } })

    await wrapper.findAll('.project-room-drawer-tabs button')[1].trigger('click')
    expect(controller.savePreferences).toHaveBeenCalledWith({ drawerTab: 'trace' })

    controller.savePreferences.mockClear()
    controller.projectSnapshot.value = {
      ...controller.projectSnapshot.value,
      readOnly: true,
      preferences: { ...controller.projectSnapshot.value.preferences, drawerTab: 'files' },
    }
    await nextTick()
    await wrapper.findAll('.project-room-drawer-tabs button')[1].trigger('click')
    expect(controller.savePreferences).not.toHaveBeenCalled()
  })

  it('resizes with the pointer and saves the settled width', async () => {
    const controller = drawerController()
    const wrapper = mount(ProjectRoomDrawer, { props: { controller } })

    wrapper.get('.project-room-drawer-resize').element.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 500, bubbles: true }),
    )
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }))
    window.dispatchEvent(new MouseEvent('pointerup'))

    expect(controller.onResize).toHaveBeenLastCalledWith(600)
    expect(controller.savePreferences).toHaveBeenCalledWith({ drawerWidth: 600 })
  })

  it('behaves as a modal overlay in a narrow window', async () => {
    const controller = drawerController()
    controller.drawer = ref(true)
    const wrapper = mount(ProjectRoomDrawer, { props: { controller } })

    expect(wrapper.find('.project-room-drawer-scrim').exists()).toBe(true)
    expect(wrapper.get('.project-room-drawer').attributes('style')).toBeUndefined()
    expect(wrapper.get('.project-room-drawer').attributes('role')).toBe('dialog')
    expect(document.body.classList.contains('project-room-drawer-open')).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(controller.close).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    expect(document.body.classList.contains('project-room-drawer-open')).toBe(false)
  })
})
