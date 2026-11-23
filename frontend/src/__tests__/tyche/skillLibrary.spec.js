import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SkillMarketDialog from '../../components/skills/SkillMarketDialog.vue'
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
    expect(wrapper.text()).toContain('review')
    expect(wrapper.text()).toContain('Shared library')
    expect(wrapper.text()).toContain('Claude native')
    expect(wrapper.text()).toContain('Create presentations')
    expect(wrapper.get('.settings-side').text()).toContain('pptx')

    const rows = wrapper.findAll('tbody tr')
    expect(rows[0].text()).toContain('Update')
    expect(rows[0].text()).toContain('Delete')
    expect(rows[1].text()).not.toContain('Delete')
    expect(rows[1].find('.skills-native-toggle').exists()).toBe(false)
    expect(rows[1].find('.skills-cell-state').exists()).toBe(false)
    wrapper.unmount()
  })

  it('previews and installs a Git market entry without a trust step', async () => {
    const sourceId = `src-${'a'.repeat(32)}`
    const token = `market-${'b'.repeat(32)}`
    const api = {
      marketSources: vi.fn().mockResolvedValue([{
        id: sourceId,
        url: 'https://example.com/repo',
        ref: 'main',
        subpath: '',
        installedCount: 0,
        lastCheckedAt: null,
      }]),
      marketPreview: vi.fn().mockResolvedValue({
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
        }],
      }),
      marketInstall: vi.fn().mockResolvedValue({ id: 'shared/library/alpha' }),
      marketCheckUpdates: vi.fn().mockResolvedValue({ updates: [] }),
      marketPreviewUpdate: vi.fn(),
      marketApplyUpdate: vi.fn(),
      marketAddSource: vi.fn(),
      marketRemoveSource: vi.fn(),
    }
    const wrapper = mount(SkillMarketDialog, {
      props: { api },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('https://example.com/repo')

    await wrapper.get('.market-source').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Alpha Skill')
    expect(wrapper.text()).not.toContain('Trust after install')
    await wrapper.findAll('button').find(button => button.text().includes('Install into the shared library')).trigger('click')
    await flushPromises()
    expect(api.marketInstall).toHaveBeenCalledWith({ token, repo: false })
    wrapper.unmount()
  })

  it('installs a repo entry as a whole repo', async () => {
    const sourceId = `src-${'a'.repeat(32)}`
    const token = `market-${'b'.repeat(32)}`
    const api = {
      marketSources: vi.fn().mockResolvedValue([{
        id: sourceId,
        url: 'https://example.com/repo',
        ref: 'main',
        subpath: '',
        installedCount: 0,
        lastCheckedAt: null,
      }]),
      marketPreview: vi.fn().mockResolvedValue({
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
          repoMode: true,
        }],
      }),
      marketInstall: vi.fn().mockResolvedValue({ id: 'shared/library/alpha' }),
      marketCheckUpdates: vi.fn().mockResolvedValue({ updates: [] }),
      marketPreviewUpdate: vi.fn(),
      marketApplyUpdate: vi.fn(),
      marketAddSource: vi.fn(),
      marketRemoveSource: vi.fn(),
    }
    const wrapper = mount(SkillMarketDialog, {
      props: { api },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()
    await wrapper.get('.market-source').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Install the whole repo')
    await wrapper.findAll('button').find(button => button.text().includes('Install into the shared library')).trigger('click')
    await flushPromises()
    expect(api.marketInstall).toHaveBeenCalledWith({ token, repo: true })
    wrapper.unmount()
  })
})
