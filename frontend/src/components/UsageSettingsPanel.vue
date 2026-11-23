<template>
  <section class="usage-panel" :aria-busy="String(loading)">
    <header class="usage-head">
      <div>
        <h1>{{ t('systemSettings.usage') }}</h1>
        <p>{{ t('settingsUi.usageLead') }}</p>
      </div>
      <div class="settings-seg">
        <button v-for="item in RANGES" :key="item" type="button" :class="{ active: range === item }" @click="load(item)">{{ t(`settingsUi.range.${item}`) }}</button>
      </div>
    </header>

    <p v-if="error" class="settings-banner" role="alert">{{ error }}</p>
    <p v-if="loading && !report" class="settings-note">{{ t('common.loading') }}</p>

    <template v-if="report">
      <div class="stat-grid">
        <article class="settings-card stat-card">
          <header><span>{{ range === 'month' ? t('settingsUi.monthFee') : t('settingsUi.fee') }}</span></header>
          <h2>{{ money(report.totals.costUsd) }}</h2>
          <small>{{ budgetLine }}</small>
          <div class="fee-meter"><i :style="{ width: `${Math.min(100, report.budget.usedPercent)}%` }" /></div>
        </article>
        <article class="settings-card stat-card"><header><span>{{ t('settingsUi.totalTokens') }}</span></header><h2>{{ tokens(report.totals.tokens) }}</h2></article>
        <article class="settings-card stat-card"><header><span>{{ t('settingsUi.handoffCount') }}</span></header><h2>{{ report.totals.turns }}</h2></article>
        <article class="settings-card stat-card"><header><span>{{ t('settingsUi.stoppedLoopsTitle') }}</span></header><h2>{{ report.totals.interrupted }}</h2></article>
      </div>

      <p v-if="report.totals.estimated" class="settings-note">{{ t('settingsUi.usageEstimated') }}</p>

      <div class="usage-split">
        <article class="settings-card">
          <div class="usage-card-head">
            <h2>{{ t('settingsUi.dailyTrend') }}</h2>
            <p class="legend">
              <template v-for="agent in legend" :key="agent.provider">
                <i class="swatch" :style="{ background: colorOf(agent.provider) }" />{{ agentLabel(agent.provider) }}
              </template>
            </p>
          </div>
          <p v-if="!hasChartData" class="settings-note">{{ t('settingsUi.usageNoData') }}</p>
          <div v-else class="usage-chart">
            <div class="usage-yaxis"><span>{{ money(maxDaily) }}</span><span>{{ money(maxDaily / 2) }}</span><span>$0</span></div>
            <div class="usage-plot">
              <div class="usage-bars">
                <span v-for="point in report.series" :key="point.date" :title="`${point.date} · ${money(point.total)}`" :style="{ height: barHeight(point) }">
                  <i
                    v-for="segment in segments(point)"
                    :key="segment.provider"
                    :style="{ height: `${segment.height}%`, background: colorOf(segment.provider) }"
                  />
                </span>
              </div>
              <div class="usage-xaxis"><span v-for="label in xLabels" :key="label">{{ label }}</span></div>
            </div>
          </div>
        </article>
        <article class="settings-card">
          <h2>{{ t('settingsUi.byRoom') }}</h2>
          <p v-if="!report.rooms.length" class="settings-note">{{ t('settingsUi.usageNoData') }}</p>
          <div v-for="room in report.rooms" :key="room.id" class="room-row">
            <span :title="room.name">{{ room.name }}</span>
            <i><b :style="{ width: roomWidth(room) }" /></i>
            <strong>{{ money(room.costUsd) }}</strong>
          </div>
        </article>
      </div>

      <article class="settings-card">
        <h2>{{ t('settingsUi.byAgent') }}</h2>
        <p v-if="!report.agents.length" class="settings-note">{{ t('settingsUi.usageNoData') }}</p>
        <table v-else class="settings-mini-table usage-agents">
          <thead><tr><th>Agent</th><th>Token</th><th>{{ t('settingsUi.fee') }}</th><th>{{ t('settingsUi.share') }}</th></tr></thead>
          <tbody>
            <tr v-for="agent in report.agents" :key="agent.provider">
              <td><img :src="agentLogo(agent.provider)" :alt="agentLabel(agent.provider)" /><span>{{ agentLabel(agent.provider) }}</span></td>
              <td>{{ tokens(agent.tokens) }}</td>
              <td>{{ money(agent.costUsd) }}</td>
              <td class="share">
                <span class="share-track"><i :style="{ width: `${Math.round(agent.share * 100)}%`, background: colorOf(agent.provider) }" /></span>
                <span>{{ Math.round(agent.share * 100) }}%</span>
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <article class="settings-card">
        <h2>{{ t('settingsUi.budget') }}</h2>
        <div class="budget-row">
          <label>{{ t('settingsUi.monthlyBudget') }}
            <input v-model.number="settings.monthlyBudgetUsd" type="number" min="0" step="1" @change="saveSettings" />
          </label>
          <label>{{ t('settingsUi.at80') }}
            <select v-model.number="settings.warnAtPercent" @change="saveSettings">
              <option v-for="value in [50, 70, 80, 90, 100]" :key="value" :value="value">{{ value }}%</option>
            </select>
          </label>
          <label>{{ t('settingsUi.afterBudget') }}
            <span class="settings-note">{{ t('settingsUi.warnOnly') }}</span>
          </label>
          <label>{{ t('settingsUi.roomDaily') }}
            <input v-model.number="settings.roomDailyLimitUsd" type="number" min="0" step="1" @change="saveSettings" />
          </label>
          <label>{{ t('settingsUi.chainCap') }}
            <input v-model.number="settings.maxTokensPerTurn" type="number" min="0" step="1000" @change="saveSettings" />
            <small>{{ t('settingsUi.chainHint') }}</small>
          </label>
        </div>
        <p class="settings-note">{{ t('settingsUi.budgetNote') }}</p>
      </article>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { agentLogo } from '../catalog.js'
import { desktopApi } from '../desktop.js'
import { t, translateError } from '../i18n.js'
import { formatTokenCount } from '../room-usage.js'

const RANGES = ['today', 'week', 'month']
const AGENT_LABELS = {
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini', pi: 'Pi',
  deepseek: 'DeepSeek', qwen: 'Qwen', kimi: 'Kimi', hermes: 'Hermes',
}
const COLORS = {
  claude: '#f5a524', codex: '#4c8dff', pi: '#3ecf8e', gemini: '#b07cff',
  deepseek: '#2dd4bf', qwen: '#f472b6', kimi: '#a78bfa',
}
const FALLBACK_COLORS = ['#67e8f9', '#93c5fd', '#fca5a5', '#fcd34d', '#c4b5fd']

const api = desktopApi()?.teamRoom
const range = ref('month')
const report = ref(null)
const loading = ref(false)
const error = ref('')
const settings = reactive({
  monthlyBudgetUsd: 60,
  warnAtPercent: 80,
  overBudgetAction: 'warn',
  roomDailyLimitUsd: 10,
  maxTokensPerTurn: 200000,
})

const legend = computed(() => (report.value?.agents || []).slice(0, 4))
const maxDaily = computed(() => Math.max(0, ...(report.value?.series || []).map(point => point.total)))
const hasChartData = computed(() => maxDaily.value > 0)
const budgetLine = computed(() => t('settingsUi.budgetLineDynamic', {
  budget: money(report.value?.budget?.monthlyBudgetUsd || 0),
  percent: Math.round(report.value?.budget?.usedPercent || 0),
}))
const xLabels = computed(() => {
  const series = report.value?.series || []
  if (!series.length) return []
  if (series.length === 1) return [series[0].date.slice(5)]
  return [series[0].date.slice(5), series[Math.floor(series.length / 2)].date.slice(5), series[series.length - 1].date.slice(5)]
})

function money(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '$0.00'
  return `$${number.toFixed(number >= 100 ? 0 : 2)}`
}

function tokens(value) {
  return formatTokenCount(Number(value) || 0)
}

function agentLabel(provider) {
  return AGENT_LABELS[provider] || String(provider || '')
}

function colorOf(provider) {
  if (COLORS[provider]) return COLORS[provider]
  let hash = 0
  for (const char of String(provider || '')) hash = (hash * 31 + char.charCodeAt(0)) % 997
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]
}

function barHeight(point) {
  if (!maxDaily.value) return '0%'
  return `${Math.max(0, (point.total / maxDaily.value) * 100)}%`
}

function segments(point) {
  const total = point.total || 0
  if (!total) return []
  return Object.entries(point.providers || {})
    .filter(([, cost]) => cost > 0)
    .map(([provider, cost]) => ({ provider, height: (cost / total) * 100 }))
}

function roomWidth(room) {
  const max = Math.max(0, ...(report.value?.rooms || []).map(item => item.costUsd))
  if (!max) return '0%'
  return `${Math.max(2, (room.costUsd / max) * 100)}%`
}

function applySettings(value) {
  if (!value || typeof value !== 'object') return
  for (const key of Object.keys(settings)) {
    if (value[key] !== undefined) settings[key] = value[key]
  }
}

async function load(nextRange = range.value) {
  range.value = nextRange
  if (!api?.usageReport) {
    error.value = t('settingsUi.usageUnavailable')
    return
  }
  loading.value = true
  error.value = ''
  try {
    const next = await api.usageReport({ range: nextRange })
    report.value = next
    applySettings(next?.budget)
  } catch (caught) {
    error.value = translateError(caught) || t('settingsUi.errorGeneric')
  } finally {
    loading.value = false
  }
}

async function saveSettings() {
  if (!api?.updateUsageSettings) return
  try {
    const next = await api.updateUsageSettings({ ...settings })
    applySettings(next)
    await load()
  } catch (caught) {
    error.value = translateError(caught) || t('settingsUi.errorGeneric')
  }
}

onMounted(() => load())
</script>

<style scoped>
.usage-panel { display: grid; gap: 16px; align-content: start; }
.usage-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.usage-head h1 { margin: 0; font-size: 28px; }
.usage-head p { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.stat-grid { display: grid; grid-template-columns: 1.35fr repeat(3, minmax(0, 1fr)); gap: 12px; }
.stat-card { display: flex; flex-direction: column; justify-content: space-between; min-height: 118px; }
.stat-card header, .usage-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.stat-card header span, .legend { color: var(--muted); font-size: 12px; }
.stat-card h2 { margin: 8px 0 4px; font-size: 28px; letter-spacing: -0.03em; }
.stat-card small { color: var(--muted); font-size: 12px; }
.fee-meter { height: 6px; margin-top: 12px; overflow: hidden; border-radius: 99px; background: color-mix(in srgb, var(--text) 12%, transparent); }
.fee-meter i { display: block; height: 100%; background: linear-gradient(90deg, #2bbbad 0%, #f5a524 100%); }
.usage-split { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(220px, 0.72fr); gap: 14px; }
.legend { display: flex; flex-wrap: wrap; align-items: center; margin: 0; }
.swatch { width: 8px; height: 8px; margin: 0 6px 0 12px; border-radius: 2px; }
.usage-chart { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px; margin-top: 8px; }
.usage-yaxis { display: flex; flex-direction: column; justify-content: space-between; height: 148px; color: var(--faint); font-size: 11px; }
.usage-plot { min-width: 0; }
.usage-bars { display: flex; align-items: flex-end; gap: 3px; height: 148px; padding: 0 2px; border-bottom: 1px solid var(--border); }
.usage-bars > span { display: flex; flex: 1; flex-direction: column-reverse; min-width: 0; justify-content: flex-start; }
.usage-bars i { display: block; width: 100%; }
.usage-xaxis { display: flex; justify-content: space-between; margin-top: 6px; color: var(--faint); font-size: 11px; }
.room-row { display: grid; grid-template-columns: 88px minmax(0, 1fr) 64px; align-items: center; gap: 10px; min-height: 36px; }
.room-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room-row i { display: block; height: 6px; overflow: hidden; border-radius: 99px; background: color-mix(in srgb, var(--text) 8%, transparent); }
.room-row b { display: block; height: 100%; border-radius: inherit; background: #2ec8c0; }
.room-row strong { font-size: 12px; font-weight: 600; text-align: right; }
.usage-agents td:first-child { display: flex; align-items: center; gap: 8px; }
.usage-agents img { width: 18px; height: 18px; }
.share { display: flex; align-items: center; gap: 8px; min-width: 140px; }
.share-track { flex: 1; height: 6px; border-radius: 99px; background: color-mix(in srgb, var(--text) 8%, transparent); }
.share i { display: block; height: 6px; border-radius: 99px; }
.budget-row { display: grid; grid-template-columns: 120px 140px minmax(120px, 1fr) 140px minmax(160px, 1fr); gap: 14px; align-items: start; }
.budget-row label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
.budget-row input, .budget-row select { width: 100%; height: 32px; box-sizing: border-box; }
.budget-row small { color: var(--faint); }
@media (max-width: 980px) {
  .stat-grid, .budget-row, .usage-split { grid-template-columns: 1fr; }
}
</style>
