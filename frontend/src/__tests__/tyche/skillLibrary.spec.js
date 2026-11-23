import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SkillsPage from '../../components/skills/SkillsPage.vue'
import { setLocale } from '../../i18n.js'
import {
  formatBytes,
  relativeTime,
  skillFilterCounts,
  visibleSkills,
} from '../../skillLibrary.js'

const shared = {
  id: 'shared/library/pptx',
  name: 'pptx',
  description: 'Create presentations',
  source: 'shared',
  sourceKind: 'shared',
  originKind: 'shared',
  version: '1.2.0',
  updatedAt: new Date().toISOString(),
}
const native = {
  id: 'claude/global/review',
  name: 'review',
  description: 'Review changes',
  source: 'native',
  sourceKind: 'native',
  originKind: 'claude',
  version: null,
  updatedAt: null,
}
const detail = {
  ...shared,
  origin: { type: 'created' },
  canEdit: true,
  canRemove: true,
}

function listPayload() {
  return {
    agents: ['claude'],
    agentLabels: { claude: 'Claude' },
    skills: [{ ...shared }, { ...native }],
    defaults: {},
    counts: {},
    storeError: null,
  }
}

function mockApi() {
  return {
    list: vi.fn().mockResolvedValue(listPayload()),
    detail: vi.fn().mockResolvedValue(detail),
    onChanged: vi.fn(() => () => {}),
    create: vi.fn().mockResolvedValue(detail),
    update: vi.fn().mockResolvedValue(detail),
    promote: vi.fn().mockResolvedValue(detail),
    remove: vi.fn().mockResolvedValue({ removed: true }),
    reveal: vi.fn().mockResolvedValue({ opened: true }),
    marketSources: vi.fn().mockResolvedValue([]),
    marketAddSource: vi.fn(),
    marketRemoveSource: vi.fn(),
    marketPreview: vi.fn(),
    marketInstall: vi.fn(),
    marketCheckUpdates: vi.fn().mockResolvedValue({ updates: [] }),
    marketPreviewUpdate: vi.fn(),
    marketApplyUpdate: vi.fn(),
  }
}

describe('skill library presentation', () => {
  beforeEach(() => {
    localStorage.clear()
    setLocale('en')
  })

  it('counts sources and filters native Skills', () => {
    const rows = [
      shared,
      native,
      { ...native, id: 'claude/global/broken', name: 'broken' },
      { ...shared, id: 'shared/library/dup', name: 'dup', description: 'Duplicate', source: 'market', sourceKind: 'market' },
    ]
    expect(skillFilterCounts(rows)).toEqual({ all: 4, shared: 1, market: 1, native: 2 })
    expect(visibleSkills(rows, { filter: 'native' }).map(skill => skill.name)).toEqual(['review', 'broken'])
    expect(visibleSkills(rows, { filter: 'market' }).map(skill => skill.name)).toEqual(['dup'])
    expect(visibleSkills(rows, { query: 'deck' })).toEqual([])
    expect(visibleSkills(rows, { query: 'presentation' })).toEqual([shared])
  })

  it('formats small values', () => {
    expect(formatBytes(2048)).toBe('2.0 KB')
    const now = Date.now()
    expect(relativeTime(new Date(now - 60_000).toISOString(), 'en', now)).toContain('minute')
  })

  it('renders the platform catalog and keeps native rows read-only', async () => {
    const api = mockApi()
    const wrapper = mount(SkillsPage, { props: { api } })
    await flushPromises()

    expect(wrapper.text()).toContain('pptx')
    expect(wrapper.text()).toContain('Shared library')
    expect(wrapper.text()).toContain('Create presentations')
    expect(wrapper.text()).not.toContain('review')

    const platformRow = wrapper.find('tbody tr')
    expect(platformRow.text()).toContain('Update')
    expect(platformRow.text()).toContain('Delete')

    const nativeTab = wrapper.findAll('.skills-tabs button').find(button => button.text().includes('Agent native Skills'))
    await nativeTab.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('review')
    expect(wrapper.get('.skills-subtabs').text()).toContain('Claude')
    const nativeRow = wrapper.find('tbody tr')
    expect(nativeRow.text()).not.toContain('Delete')
    expect(nativeRow.find('.skills-native-toggle').exists()).toBe(false)
    expect(nativeRow.find('.skills-cell-state').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the platform empty state and promotes a native Skill', async () => {
    const api = mockApi()
    api.list.mockResolvedValue({ ...listPayload(), skills: [{ ...native }] })
    const wrapper = mount(SkillsPage, { props: { api } })
    await flushPromises()
    expect(wrapper.text()).toContain('No platform Skills yet')

    const nativeTab = wrapper.findAll('.skills-tabs button').find(button => button.text().includes('Agent native Skills'))
    await nativeTab.trigger('click')
    await flushPromises()
    const promote = wrapper.findAll('.skill-promote').find(button => button.text().includes('Promote'))
    await promote.trigger('click')
    await flushPromises()
    expect(api.promote).toHaveBeenCalledWith({ id: 'claude/global/review' })
    wrapper.unmount()
  })

  it('offers the real GitHub sources when the market is empty', async () => {
    const api = mockApi()
    api.marketAddSource.mockResolvedValue({ id: `src-${'a'.repeat(32)}` })
    const wrapper = mount(SkillsPage, { props: { api } })
    await flushPromises()
    await openMarket(wrapper)
    expect(wrapper.text()).toContain('anthropics/skills')
    expect(wrapper.text()).toContain('openai/skills')

    const add = wrapper.findAll('.market-recommended-card .skill-promote')[0]
    await add.trigger('click')
    await flushPromises()
    expect(api.marketAddSource).toHaveBeenCalledWith({
      url: 'https://github.com/anthropics/skills',
      ref: '',
      subpath: '',
    })
    wrapper.unmount()
  })

  function marketApi(entry) {
    const sourceId = `src-${'a'.repeat(32)}`
    const token = `market-${'b'.repeat(32)}`
    const api = mockApi()
    api.marketSources.mockResolvedValue([{
      id: sourceId,
      url: 'https://example.com/repo',
      ref: 'main',
      subpath: '',
      installedCount: 0,
      lastCheckedAt: null,
    }])
    api.marketPreview.mockResolvedValue({
      source: { id: sourceId, url: 'https://example.com/repo', ref: 'main', commit: 'c'.repeat(40) },
      commit: 'c'.repeat(40),
      entries: [{
        token,
        name: 'alpha',
        description: 'Alpha Skill',
        version: null,
        contentHash: 'd'.repeat(64),
        relativePath: 'skills/alpha',
        validName: true,
        ...entry,
      }],
    })
    return { api, token }
  }

  async function openMarket(wrapper) {
    const tab = wrapper.findAll('.skills-tabs button').find(button => button.text().includes('Skill market'))
    await tab.trigger('click')
    await flushPromises()
  }

  it('installs a market entry from the source tab without a trust step', async () => {
    const { api, token } = marketApi({})
    const wrapper = mount(SkillsPage, { props: { api } })
    await flushPromises()
    await openMarket(wrapper)
    expect(wrapper.text()).toContain('Alpha Skill')

    const add = wrapper.findAll('.skill-promote').find(button => button.text() === 'Add')
    await add.trigger('click')
    await flushPromises()
    expect(api.marketInstall).toHaveBeenCalledWith({ token, repo: false })
    wrapper.unmount()
  })

  it('installs a repo entry as a whole repo', async () => {
    const { api, token } = marketApi({ repoMode: true })
    const wrapper = mount(SkillsPage, { props: { api } })
    await flushPromises()
    await openMarket(wrapper)
    expect(wrapper.text()).toContain('Repo')

    const add = wrapper.findAll('.skill-promote').find(button => button.text() === 'Add')
    await add.trigger('click')
    await flushPromises()
    expect(api.marketInstall).toHaveBeenCalledWith({ token, repo: true })
    wrapper.unmount()
  })
})
