import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import WorkdirTree from '../../components/workdir/WorkdirTree.vue'
import FilePreview from '../../components/workdir/FilePreview.vue'
import FileDiff from '../../components/workdir/FileDiff.vue'

const t = (key, params = {}) => (params.size == null ? key : `${key}:${params.size}`)

describe('WorkdirTree', () => {
  it('expands directories, selects files, and keeps repository metadata closed', async () => {
    const controller = {
      error: ref(''),
      expanded: ref(new Set()),
      loading: ref(false),
      rows: ref([
        { name: 'docs', kind: 'directory', path: 'docs', depth: 0 },
        { name: '.git', kind: 'metadata', path: '.git', depth: 0 },
        { name: 'a.md', kind: 'file', path: 'docs/a.md', depth: 1 },
        { name: 'link', kind: 'link', path: 'link', linkTarget: 'docs/a.md', depth: 0 },
      ]),
      select: vi.fn(),
      selected: ref(''),
      t,
      toggle: vi.fn(),
    }
    const wrapper = mount(WorkdirTree, { props: { controller } })
    await wrapper.findAll('.workdir-tree-entry')[0].trigger('click')
    expect(controller.toggle).toHaveBeenCalledWith('docs')
    expect(wrapper.text()).toContain('workdir.tree.repositoryMetadata')
    expect(wrapper.text()).toContain('→ docs/a.md')
    await wrapper.findAll('.workdir-tree-file')[0].trigger('click')
    expect(controller.select).toHaveBeenCalledWith('docs/a.md')
  })
})

describe('FilePreview', () => {
  it('warns before showing a secret-looking file', async () => {
    const controller = {
      error: ref(''),
      loading: ref(false),
      loadMorePreview: vi.fn(),
      preview: ref({ kind: 'text', path: '.env', text: 'SECRET=1', eof: true }),
      t,
    }
    const wrapper = mount(FilePreview, { props: { controller } })
    expect(wrapper.text()).toContain('workdir.preview.secretWarning')
    expect(wrapper.text()).not.toContain('SECRET=1')
    await wrapper.get('.file-preview-secret button').trigger('click')
    expect(wrapper.text()).toContain('SECRET=1')
  })

  it('renders text and image previews and loads more text', async () => {
    const controller = {
      error: ref(''),
      loading: ref(false),
      loadMorePreview: vi.fn(),
      preview: ref({ kind: 'text', path: 'a.md', text: 'part', eof: false }),
      t,
    }
    const wrapper = mount(FilePreview, { props: { controller } })
    expect(wrapper.get('.file-preview-text').text()).toBe('part')
    await wrapper.get('.file-preview button.secondary-button').trigger('click')
    expect(controller.loadMorePreview).toHaveBeenCalled()
    controller.preview.value = {
      kind: 'image', path: 'a.png', mime: 'image/png', dataBase64: 'AAAA',
    }
    await wrapper.vm.$nextTick()
    expect(wrapper.get('img').attributes('src')).toBe('data:image/png;base64,AAAA')
  })
})

describe('FileDiff', () => {
  it('shows the change label when no text diff is available', () => {
    const controller = {
      diff: ref({
        path: 'a.png',
        change: { change: 'large-file-changed', diffAvailable: false },
      }),
      error: ref(''),
      t,
      theme: 'light',
    }
    const wrapper = mount(FileDiff, {
      props: { controller },
      global: { stubs: { DiffView: true } },
    })
    expect(wrapper.text()).toContain('workdir.change.large-file-changed')
    expect(wrapper.find('diff-view-stub').exists()).toBe(false)
  })

  it('renders the text diff in the shared diff view', () => {
    const controller = {
      diff: ref({
        path: 'a.md',
        change: { change: 'content-changed', diffAvailable: true },
        diff: { text: '@@ -1 +1 @@\n-old\n+new' },
      }),
      error: ref(''),
      t,
      theme: 'light',
    }
    const wrapper = mount(FileDiff, {
      props: { controller },
      global: { stubs: { DiffView: true } },
    })
    expect(wrapper.find('diff-view-stub').exists()).toBe(true)
  })
})
