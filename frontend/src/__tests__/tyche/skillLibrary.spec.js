import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SkillMarketDialog from '../../components/skills/SkillMarketDialog.vue'
import SkillsPage from '../../components/skills/SkillsPage.vue'
import SkillTrustPolicy from '../../components/skills/SkillTrustPolicy.vue'
import { setLocale } from '../../i18n.js'
import {
  formatBytes,
  projectionFor,
  projectionOn,
  projectionWarn,
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
  trust: 'trusted',
  eligible: ['claude'],
  available: ['claude'],
  preview: '# pptx\n\nUse the deck workflow.',
  version: '1.2.0',
  updatedAt: new Date().toISOString(),
  risk: null,
  fileCount: 1,
  totalBytes: 20,
  projections: [],
  conflict: null,
}
const native = {
  id: 'claude/global/review',
  name: 'review',
  description: 'Review changes',
  source: 'native',
  sourceKind: 'native',
  originKind: 'claude',
  trust: 'trusted',
  eligible: ['claude'],
  available: ['claude'],
  preview: '',
  version: null,
  updatedAt: null,
  risk: null,
  fileCount: 1,
  totalBytes: 10,
  projections: [],
  conflict: null,
}
const detail = {
  ...shared,
  files: [{ path: 'SKILL.md', size: 20, hash: 'a'.repeat(64) }],
  risk: { level: 'low', labels: ['scripts'], findings: [] },
  origin: { type: 'created' },
  canEdit: true,
  canRemove: true,
  canProject: true,
  projectableAgents: ['claude', 'codex'],
}

function listPayload() {
  return {
    agents: ['claude'],
    agentLabels: { claude: 'Claude' },
    agentCapabilities: {
      claude: { label: 'Claude', projectable: true },
      codex: { label: 'Codex', projectable: true },
    },
    skills: [{ ...shared }, { ...native }],
    defaults: {},
    policy: {},
    counts: {},
    storeError: null,
  }
}

function mockApi() {
  return {
    list: vi.fn().mockResolvedValue(listPayload()),
    detail: vi.fn().mockResolvedValue(detail),
    onChanged: vi.fn(() => () => {}),
    project: vi.fn().mockResolvedValue(detail),
    unproject: vi.fn().mockResolvedValue(detail),
    trust: vi.fn().mockResolvedValue(detail),
    revokeTrust: vi.fn().mockResolvedValue({}),
    setEligible: vi.fn().mockResolvedValue({}),
    importFromAgent: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    resolveProjection: vi.fn(),
    reveal: vi.fn(),
  }
}

describe('skill library presentation', () => {
  beforeEach(() => {
    localStorage.clear()
    setLocale('en')
  })

  it('counts sources and filters trust/conflict states', () => {
    const rows = [
      shared,
      native,
      { ...native, id: 'claude/global/broken', name: 'broken', trust: 'changed' },
      { ...shared, id: 'shared/library/dup', name: 'dup', description: 'Duplicate', source: 'market', sourceKind: 'market', conflict: { name: 'dup' } },
    ]
    expect(skillFilterCounts(rows)).toEqual({ all: 4, shared: 1, native: 2, market: 1, reauth: 1, conflict: 1 })
    expect(visibleSkills(rows, { filter: 'native' }).map(skill => skill.name)).toEqual(['review', 'broken'])
    expect(visibleSkills(rows, { filter: 'reauth' }).map(skill => skill.name)).toEqual(['broken'])
    expect(visibleSkills(rows, { query: 'deck' })).toEqual([])
    expect(visibleSkills(rows, { query: 'presentation' })).toEqual([shared])
  })

  it('reads projection state and formats small values', () => {
    const skill = { ...shared, projections: [{ agent: 'codex', status: 'outdated' }] }
    expect(projectionFor(skill, 'codex').status).toBe('outdated')
    expect(projectionOn(skill, 'codex')).toBe(true)
    expect(projectionWarn(skill, 'codex')).toBe(true)
    expect(projectionOn(skill, 'claude')).toBe(false)
    expect(formatBytes(2048)).toBe('2.0 KB')
    const now = Date.now()
    expect(relativeTime(new Date(now - 60_000).toISOString(), 'en', now)).toContain('minute')
  })

  it('renders the matrix and distributes a trusted shared Skill', async () => {
    const api = mockApi()
    const wrapper = mount(SkillsPage, { props: { api } })
    await flushPromises()

    expect(wrapper.text()).toContain('pptx')
    expect(wrapper.text()).toContain('review')
    expect(wrapper.text()).toContain('Shared library')
    expect(wrapper.text()).toContain('Trusted')
    expect(wrapper.get('.settings-side').text()).toContain('Distributed to')
    const rows = wrapper.findAll('tbody tr')
    expect(rows[0].text()).toContain('Update')
    expect(rows[0].text()).toContain('Delete')
    expect(rows[1].text()).toContain('—')

    await wrapper.get('tbody tr:first-child .settings-switch').trigger('click')
    await flushPromises()
    expect(api.project).toHaveBeenCalledWith({ id: 'shared/library/pptx', agent: 'claude' })

    await wrapper.findAll('.chip').find(button => button.text().includes('Agent native')).trigger('click')
    await flushPromises()
    expect(wrapper.get('table').text()).not.toContain('pptx')
    expect(wrapper.get('table').text()).toContain('review')
    wrapper.unmount()
  })

  it('previews and installs a Git market entry without an automatic trust', async () => {
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
          preview: '# Alpha\n\nInstructions.',
          version: null,
          contentHash: 'd'.repeat(64),
          risk: { level: 'none', labels: [] },
          fileCount: 1,
          totalBytes: 20,
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
      props: { api, policy: { untrustedByDefault: true } },
      global: { stubs: { teleport: true } },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('https://example.com/repo')

    await wrapper.get('.market-source').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Alpha Skill')
    await wrapper.findAll('button').find(button => button.text().includes('Install into the shared library')).trigger('click')
    await flushPromises()
    expect(api.marketInstall).toHaveBeenCalledWith({ token, trust: false })
    wrapper.unmount()
  })

  it('loads and updates the Skill trust policy', async () => {
    const api = {
      summary: vi.fn().mockResolvedValue({
        policy: { untrustedByDefault: true, revokeOnChange: true, denySkillNetwork: false },
        counts: { reauth: 2 },
      }),
      updatePolicy: vi.fn().mockResolvedValue({}),
    }
    const wrapper = mount(SkillTrustPolicy, { props: { api } })
    await flushPromises()
    expect(wrapper.text()).toContain('2 Skills need approval')
    const switches = wrapper.findAll('.settings-switch')
    await switches[2].trigger('click')
    await flushPromises()
    expect(api.updatePolicy).toHaveBeenCalledWith({ denySkillNetwork: true })
    wrapper.unmount()
  })

  it('toggles native eligibility rather than writing a projection', async () => {
    const api = mockApi()
    const wrapper = mount(SkillsPage, { props: { api } })
    await flushPromises()
    await wrapper.findAll('.chip').find(button => button.text().includes('Agent native')).trigger('click')
    await flushPromises()

    const row = wrapper.findAll('tbody tr').find(item => item.text().includes('review'))
    await row.get('.settings-switch').trigger('click')
    await flushPromises()
    expect(api.setEligible).toHaveBeenCalledWith({
      id: 'claude/global/review',
      agent: 'claude',
      enabled: false,
    })
    expect(api.project).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
