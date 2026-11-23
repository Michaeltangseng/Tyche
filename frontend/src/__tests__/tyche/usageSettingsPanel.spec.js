import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UsageSettingsPanel from '../../components/UsageSettingsPanel.vue'
import { setLocale } from '../../i18n.js'

const report = {
  range: 'month',
  totals: { costUsd: 1.5, monthlyCostUsd: 1.5, tokens: 1_500_000, turns: 3, interrupted: 1, estimated: true },
  series: [
    { date: '2026-11-21', total: 0.5, providers: { claude: 0.3, codex: 0.2 } },
    { date: '2026-11-22', total: 1, providers: { claude: 1 } },
  ],
  rooms: [{ id: 'r1', name: 'snake', tokens: 1_500_000, costUsd: 1.5 }],
  agents: [{ provider: 'claude', tokens: 1_200_000, costUsd: 1.2, share: 0.8 }],
  budget: {
    monthlyBudgetUsd: 60,
    warnAtPercent: 80,
    overBudgetAction: 'warn',
    roomDailyLimitUsd: 10,
    maxTokensPerTurn: 200000,
    usedPercent: 2.5,
    overBudget: false,
    warn: false,
    enforced: false,
  },
}

describe('usage settings panel', () => {
  afterEach(() => {
    delete window.tycheDesktop
  })

  it('renders the real report and reloads for another range', async () => {
    setLocale('en')
    const api = {
      usageReport: vi.fn().mockResolvedValue(report),
      usageSettings: vi.fn().mockResolvedValue(report.budget),
      updateUsageSettings: vi.fn().mockResolvedValue(report.budget),
    }
    window.tycheDesktop = { teamRoom: api }
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('$1.50')
    expect(wrapper.text()).toContain('1.5M')
    expect(wrapper.text()).toContain('snake')
    expect(wrapper.text()).toContain('Costs are estimates')
    expect(api.usageReport).toHaveBeenCalledWith({ range: 'month' })

    const bars = wrapper.findAll('.usage-bar')
    await bars[1].trigger('mouseenter')
    expect(wrapper.get('.usage-inspect').text()).toContain('2026-11-22')
    expect(wrapper.get('.usage-inspect').text()).toContain('Claude $1.00')
    await bars[1].trigger('click')
    expect(wrapper.get('.usage-inspect').classes()).toContain('pinned')
    await bars[1].trigger('click')
    expect(wrapper.get('.usage-inspect').classes()).not.toContain('pinned')

    const claude = wrapper.findAll('.legend-item').find(button => button.text().includes('Claude'))
    await claude.trigger('click')
    expect(claude.attributes('aria-pressed')).toBe('false')
    await bars[1].trigger('mouseenter')
    expect(wrapper.get('.usage-inspect').text()).not.toContain('Claude $1.00')

    const week = wrapper.findAll('button').find(button => button.text() === 'This week')
    await week.trigger('click')
    await flushPromises()
    expect(api.usageReport).toHaveBeenCalledWith({ range: 'week' })
    wrapper.unmount()
  })
})
