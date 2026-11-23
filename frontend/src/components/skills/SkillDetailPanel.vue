<template>
  <aside v-if="skill" class="settings-side skill-detail">
    <header class="skill-detail-head">
      <div>
        <h3>{{ skill.name }}</h3>
        <p>
          {{ t(sourceLabelKey(skill.source)) }}
          <template v-if="skill.version"> · v{{ skill.version }}</template>
        </p>
        <p v-if="skill.origin?.type === 'market'" class="skill-market-origin">{{ skill.origin.url }}@{{ String(skill.origin.commit || '').slice(0, 8) }}</p>
      </div>
      <i class="settings-dot" :class="trustTone(skill.trust)" />
    </header>
    <p class="skill-detail-desc">{{ skill.description || t('settingsUi.noDescription') }}</p>

    <div class="skill-detail-trust">
      <span class="skill-trust-state">
        <i class="settings-dot" :class="trustTone(skill.trust)" />
        {{ t(`settingsUi.trustState.${skill.trust}`) }}
      </span>
      <small v-if="skill.approvedAt">{{ t('settingsUi.approvedAt', { time: relative(skill.approvedAt) }) }}</small>
      <button
        v-if="skill.trust !== 'trusted'"
        class="primary-button"
        type="button"
        :disabled="busy || skill.trust === 'unavailable'"
        @click="$emit('trust')"
      >{{ t(skill.trust === 'changed' ? 'settingsUi.retrustSkill' : 'settingsUi.trustSkill') }}</button>
      <template v-else>
        <button v-if="!revokeArmed" class="secondary-button danger" type="button" :disabled="busy" @click="revokeArmed = true">{{ t('settingsUi.revokeTrust') }}</button>
        <span v-else class="skill-confirm">
          <span>{{ t('settingsUi.revokeConfirm') }}</span>
          <button type="button" @click="revokeArmed = false">{{ t('common.cancel') }}</button>
          <button type="button" class="danger" @click="revokeArmed = false; $emit('revoke')">{{ t('settingsUi.revokeTrust') }}</button>
        </span>
      </template>
    </div>

    <div v-if="skill.risk?.labels?.length" class="skill-risk">
      <div>
        <strong>{{ t('settingsUi.risk') }}</strong>
        <span class="skill-risk-level" :class="riskTone(skill.risk.level)">{{ skill.risk.level }}</span>
      </div>
      <span class="settings-pills">
        <span v-for="label in skill.risk.labels" :key="label" class="settings-pill" :class="{ deny: skill.risk.level === 'high' }">{{ riskLabel(label) }}</span>
      </span>
      <small>{{ t('settingsUi.riskAdvisory') }}</small>
    </div>

    <section class="skill-detail-section">
      <h4>{{ t('settingsUi.distributedTo') }}</h4>
      <p v-if="!skill.projections?.length" class="settings-note">{{ t('settingsUi.notDistributed') }}</p>
      <div v-for="projection in skill.projections" :key="projection.id" class="skill-projection-row">
        <div>
          <strong>{{ humanAgent(projection.agent) }}</strong>
          <span class="skill-projection-state" :class="projectionTone(projection.status)">{{ t(`settingsUi.projectionState.${projection.status}`) }}</span>
          <small v-if="projection.mode === 'nativeOrigin'" class="skill-native-note">{{ t('settingsUi.nativeOrigin') }}</small>
          <small v-if="projection.displayPath" class="skill-path">{{ projection.displayPath }}</small>
        </div>
        <div class="settings-actions skill-projection-actions">
          <template v-if="projection.status === 'drifted'">
            <button v-if="projection.mode === 'copy'" type="button" @click="$emit('resolve', { projectionId: projection.id, action: 'restore' })">{{ t('settingsUi.restoreProjection') }}</button>
            <button type="button" @click="$emit('resolve', { projectionId: projection.id, action: 'adopt' })">{{ t('settingsUi.adoptProjection') }}</button>
            <button type="button" @click="$emit('resolve', { projectionId: projection.id, action: 'unmanage' })">{{ t('settingsUi.unmanageProjection') }}</button>
          </template>
          <template v-else-if="projection.status === 'outdated'">
            <button v-if="projection.mode === 'copy'" type="button" @click="$emit('resolve', { projectionId: projection.id, action: 'restore' })">{{ t('settingsUi.updateProjection') }}</button>
            <button type="button" @click="$emit('unproject', projection.agent)">{{ t(projection.mode === 'nativeOrigin' ? 'settingsUi.unlinkNative' : 'settingsUi.unproject') }}</button>
          </template>
          <template v-else-if="projection.status === 'deployed'">
            <button type="button" @click="$emit('unproject', projection.agent)">{{ t(projection.mode === 'nativeOrigin' ? 'settingsUi.unlinkNative' : 'settingsUi.unproject') }}</button>
          </template>
          <template v-else>
            <button type="button" @click="$emit('resolve', { projectionId: projection.id, action: 'unmanage' })">{{ t('settingsUi.unmanageProjection') }}</button>
          </template>
        </div>
      </div>
      <div v-if="skill.canProject && projectableTargets.length" class="skill-project-new">
        <select v-model="projectTarget" :aria-label="t('settingsUi.projectToAgents')">
          <option v-for="agent in projectableTargets" :key="agent" :value="agent">{{ humanAgent(agent) }}</option>
        </select>
        <button class="secondary-button" type="button" :disabled="busy || !projectTarget" @click="$emit('project', projectTarget)">{{ t('settingsUi.projectToAgents') }}</button>
      </div>
    </section>

    <section class="skill-detail-section">
      <h4>{{ t('settingsUi.skillPreview') }}</h4>
      <pre class="skill-preview">{{ skill.preview || t('settingsUi.noPreview') }}</pre>
    </section>

    <section v-if="skill.files?.length" class="skill-detail-section">
      <h4>{{ t('settingsUi.files') }} · {{ t('settingsUi.fileCount', { count: skill.files.length }) }}</h4>
      <ul class="skill-files">
        <li v-for="file in skill.files" :key="file.path">
          <span class="skill-path">{{ file.path }}</span>
          <small>{{ formatBytes(file.size) }}</small>
        </li>
      </ul>
    </section>

    <div class="settings-actions skill-detail-actions">
      <button class="secondary-button" type="button" :disabled="busy" @click="$emit('reveal')">{{ t('settingsUi.openSource') }}</button>
      <button v-if="skill.canRemove" class="secondary-button danger" type="button" :disabled="busy" @click="removeArmed = true">{{ t('settingsUi.deleteSkill') }}</button>
    </div>

    <div v-if="removeArmed" class="skill-remove-confirm">
      <p>{{ t('settingsUi.deleteConfirmHint') }}</p>
      <input v-model="removeName" :placeholder="t('settingsUi.deleteConfirmPlaceholder')" />
      <div class="settings-actions">
        <button type="button" @click="removeArmed = false">{{ t('common.cancel') }}</button>
        <button type="button" class="danger" :disabled="removeName !== skill.name" @click="$emit('remove', removeName)">{{ t('settingsUi.deleteSkill') }}</button>
      </div>
    </div>
  </aside>
  <aside v-else class="settings-side skill-detail skill-detail-empty">
    <p class="settings-note">{{ t('settingsUi.selectSkill') }}</p>
  </aside>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { locale, t } from '../../i18n.js'
import {
  formatBytes,
  relativeTime,
  sourceLabelKey,
  trustTone,
} from '../../skillLibrary.js'

const props = defineProps({
  skill: { type: Object, default: null },
  agentLabels: { type: Object, default: () => ({}) },
  installedAgents: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
})
defineEmits(['trust', 'revoke', 'project', 'unproject', 'resolve', 'reveal', 'remove'])

const revokeArmed = ref(false)
const removeArmed = ref(false)
const removeName = ref('')
const projectTarget = ref('')

const projectableTargets = computed(() => {
  if (!props.skill) return []
  const projected = new Set((props.skill.projections || []).map(projection => projection.agent))
  const installed = props.installedAgents.length ? new Set(props.installedAgents) : null
  return (props.skill.projectableAgents || [])
    .filter(agent => !projected.has(agent) && (!installed || installed.has(agent)))
})

watch(projectableTargets, (targets) => {
  if (!targets.includes(projectTarget.value)) projectTarget.value = targets[0] || ''
}, { immediate: true })

watch(() => props.skill?.id, () => {
  revokeArmed.value = false
  removeArmed.value = false
  removeName.value = ''
})

function humanAgent(agent) {
  return props.agentLabels[agent] || agent
}

function relative(iso) {
  return relativeTime(iso, locale.value)
}

function projectionTone(status) {
  if (status === 'deployed') return 'ready'
  if (status === 'conflict') return 'danger'
  if (status) return 'warn'
  return ''
}

function riskTone(level) {
  if (level === 'high') return 'danger'
  if (level === 'medium') return 'warn'
  return ''
}

const RISK_LABELS = {
  'dynamic-command': 'riskDynamicCommand',
  'shell-tools': 'riskShellTools',
  hooks: 'riskHooks',
  scripts: 'riskScripts',
  network: 'riskNetwork',
  'file-write': 'riskFileWrite',
  'external-paths': 'riskExternalPaths',
  'large-assets': 'riskLargeAssets',
  'nonstandard-fields': 'riskNonstandardFields',
  unreadable: 'riskUnreadable',
}

function riskLabel(label) {
  const key = RISK_LABELS[label]
  return key ? t(`settingsUi.${key}`) : label
}
</script>

<style scoped>
.skill-detail { display: grid; gap: 14px; align-content: start; max-height: calc(100vh - 240px); overflow: auto; }
.skill-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.skill-detail-head h3 { margin: 0; font-size: 16px; }
.skill-detail-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.skill-market-origin { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px !important; }
.skill-detail-desc { margin: 0; color: var(--text-soft); font-size: 13px; line-height: 1.55; }
.skill-detail-trust { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px; border-radius: 9px; background: color-mix(in srgb, var(--text) 6%, transparent); }
.skill-detail-trust small { color: var(--muted); font-size: 11px; }
.skill-trust-state { display: inline-flex; align-items: center; font-size: 12px; font-weight: 650; }
.skill-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: #f5a524; font-size: 12px; }
.skill-confirm button { border: 0; background: transparent; color: var(--text-soft); font: inherit; font-size: 12px; cursor: pointer; }
.skill-confirm button.danger { color: #f2555a; font-weight: 650; }
.skill-risk { display: grid; gap: 6px; padding: 10px; border-radius: 9px; background: color-mix(in srgb, #f5a524 9%, transparent); }
.skill-risk > div { display: flex; align-items: center; gap: 8px; }
.skill-risk strong { font-size: 12px; }
.skill-risk small { color: var(--muted); font-size: 11px; }
.skill-risk-level { font-size: 11px; font-weight: 700; text-transform: uppercase; }
.skill-risk-level.warn { color: #f5a524; }
.skill-risk-level.danger { color: #f2555a; }
.skill-detail-section { display: grid; gap: 8px; }
.skill-detail-section h4 { margin: 0; font-size: 12px; font-weight: 650; color: var(--text-soft); }
.skill-projection-row { display: grid; gap: 6px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.skill-projection-row:last-of-type { border-bottom: 0; }
.skill-projection-row > div:first-child { display: grid; gap: 3px; }
.skill-projection-row strong { font-size: 12px; }
.skill-projection-state { display: inline-flex; width: fit-content; padding: 1px 7px; border-radius: 99px; background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--muted); font-size: 10px; font-weight: 650; }
.skill-projection-state.ready { background: color-mix(in srgb, #3ecf8e 16%, transparent); color: #3ecf8e; }
.skill-projection-state.warn { background: color-mix(in srgb, #f5a524 16%, transparent); color: #f5a524; }
.skill-projection-state.danger { background: color-mix(in srgb, #f2555a 16%, transparent); color: #f2555a; }
.skill-projection-actions { flex-wrap: wrap; }
.skill-projection-actions button { border: 0; background: transparent; color: var(--accent-text); font: inherit; font-size: 11px; cursor: pointer; padding: 0; }
.skill-native-note { color: var(--muted); }
.skill-path { overflow-wrap: anywhere; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.skill-project-new { display: flex; gap: 8px; align-items: center; }
.skill-project-new select { flex: 1; min-width: 0; height: 30px; padding: 0 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; }
.skill-preview { margin: 0; max-height: 170px; overflow: auto; padding: 9px 10px; border-radius: 8px; background: #101416; color: var(--text-soft); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.55; white-space: pre-wrap; }
.skill-files { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.skill-files li { display: flex; justify-content: space-between; gap: 8px; }
.skill-files small { color: var(--faint); font-size: 10px; white-space: nowrap; }
.skill-detail-actions { flex-wrap: wrap; }
.skill-remove-confirm { display: grid; gap: 8px; padding: 10px; border: 1px solid #f2555a; border-radius: 9px; }
.skill-remove-confirm p { margin: 0; color: #f2555a; font-size: 12px; }
.skill-remove-confirm input { height: 30px; padding: 0 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; }
.skill-remove-confirm button { border: 0; background: transparent; color: var(--text-soft); font: inherit; font-size: 12px; cursor: pointer; }
.skill-remove-confirm button.danger { color: #f2555a; font-weight: 650; }
.danger { color: #f2555a !important; }
.skill-detail-empty { min-height: 120px; }
</style>
