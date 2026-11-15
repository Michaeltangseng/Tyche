import { ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectRoomDrawer from '../../components/ProjectRoomDrawer.vue'

function workdirApi() {
  return {
    list: vi.fn(async ({ relPath = '' }) => {
      if (relPath === '') {
        return { entries: [{ name: 'docs', kind: 'directory' }], cursor: null, hasMore: false }
      }
      return {
        entries: [{ name: 'requirements.md', kind: 'file' }],
        cursor: null,
        hasMore: false,
      }
    }),
    read: vi.fn(async ({ relPath }) => ({
      kind: 'text',
      text: relPath === 'docs/requirements.md' ? 'requirements body' : 'file text',
      totalBytes: 17,
      eof: true,
      encoding: 'utf-8',
    })),
  }
}

function drawerController(overrides = {}) {
  const api = workdirApi()
  return {
    api,
    controller: {
      close: vi.fn(),
      drawer: ref(false),
      fileRequest: ref(null),
      onResize: vi.fn(),
      open: ref(true),
      projectId: ref('project-1'),
      projectSnapshot: ref({ readOnly: false, revision: 1 }),
      savePreferences: vi.fn(async () => ({})),
      t: key => key,
      theme: ref('light'),
      width: ref(500),
      workdir: ref(api),
      ...overrides,
    },
  }
}

afterEach(() => {
  document.body.className = ''
})

describe('project room file sidebar', () => {
  it('renders the workdir tree at the width owned by the app shell', async () => {
    const { api, controller } = drawerController()
    const wrapper = mount(ProjectRoomDrawer, { props: { controller } })
    await flushPromises()

    expect(wrapper.get('.project-room-drawer').attributes('style')).toContain('width: 500px')
    expect(wrapper.get('.project-room-drawer').attributes('role')).toBe('complementary')
    expect(wrapper.get('.project-room-drawer').text()).toContain('docs')
    expect(api.list).toHaveBeenCalledWith({ projectId: 'project-1', relPath: '' })
  })

  it('resizes through the app controller and saves the settled width', () => {
    const { controller } = drawerController()
    const wrapper = mount(ProjectRoomDrawer, { props: { controller } })

    wrapper.get('.project-room-drawer-resize').element.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 500, bubbles: true }),
    )
    expect(document.body.classList.contains('drawer-resizing')).toBe(true)
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 400 }))
    window.dispatchEvent(new MouseEvent('pointerup'))

    expect(controller.onResize).toHaveBeenLastCalledWith(600)
    expect(controller.savePreferences).toHaveBeenCalledWith({ drawerWidth: 600 })
    expect(document.body.classList.contains('drawer-resizing')).toBe(false)
    wrapper.unmount()
  })

  it('does not persist a width when the project is read-only', () => {
    const { controller } = drawerController()
    controller.projectSnapshot = ref({ readOnly: true, revision: 1 })
    const wrapper = mount(ProjectRoomDrawer, { props: { controller } })

    wrapper.get('.project-room-drawer-resize').element.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 500, bubbles: true }),
    )
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 420 }))
    window.dispatchEvent(new MouseEvent('pointerup'))

    expect(controller.onResize).toHaveBeenLastCalledWith(580)
    expect(controller.savePreferences).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('opens a requested file by expanding its ancestor directories', async () => {
    const { api, controller } = drawerController()
    controller.fileRequest = ref({ path: 'docs/requirements.md', token: 1 })
    const wrapper = mount(ProjectRoomDrawer, { props: { controller } })
    await flushPromises()

    expect(api.list).toHaveBeenCalledWith({ projectId: 'project-1', relPath: 'docs' })
    expect(api.read).toHaveBeenCalledWith({
      projectId: 'project-1',
      relPath: 'docs/requirements.md',
    })
    expect(wrapper.get('.file-preview').text()).toContain('requirements body')
    expect(wrapper.get('.project-room-drawer').text()).toContain('requirements.md')
  })

  it('behaves as a modal overlay in a narrow window', async () => {
    const { controller } = drawerController()
    controller.drawer = ref(true)
    const wrapper = mount(ProjectRoomDrawer, { props: { controller } })
    await flushPromises()

    expect(wrapper.find('.project-room-drawer-scrim').exists()).toBe(true)
    expect(wrapper.get('.project-room-drawer').attributes('style')).toContain('width: 500px')
    expect(wrapper.get('.project-room-drawer').attributes('role')).toBe('dialog')
    expect(document.body.classList.contains('project-room-drawer-open')).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(controller.close).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    expect(document.body.classList.contains('project-room-drawer-open')).toBe(false)
  })
})
