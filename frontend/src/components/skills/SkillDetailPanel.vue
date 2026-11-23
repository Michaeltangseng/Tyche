<template>
  <aside v-if="skill" class="settings-side skill-detail">
    <header class="skill-detail-head">
      <div>
        <h3>{{ skill.name }}</h3>
        <p>
          {{ sourceText(skill) }}
          <template v-if="skill.version"> · v{{ skill.version }}</template>
        </p>
        <p v-if="skill.origin?.type === 'market'" class="skill-market-origin">{{ skill.origin.url }}@{{ String(skill.origin.commit || '').slice(0, 8) }}</p>
        <p v-if="skill.repoSkill" class="skill-repo-note">{{ t('settingsUi.repoSkill') }}</p>
      </div>
    </header>
    <p class="skill-detail-desc">{{ skill.description || t('settingsUi.noDescription') }}</p>

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
import { ref, watch } from 'vue'
import { t } from '../../i18n.js'
import { sourceLabelKey } from '../../skillLibrary.js'

const props = defineProps({
  skill: { type: Object, default: null },
  agentLabels: { type: Object, default: () => ({}) },
  busy: { type: Boolean, default: false },
})
defineEmits(['reveal', 'remove'])

const removeArmed = ref(false)
const removeName = ref('')

watch(() => props.skill?.id, () => {
  removeArmed.value = false
  removeName.value = ''
})

function sourceText(skill) {
  if (skill.source === 'native') {
    return t('settingsUi.sourceNativeOf', { agent: props.agentLabels[skill.originKind] || skill.originKind })
  }
  return t(sourceLabelKey(skill.source))
}
</script>

<style scoped>
.skill-detail { display: grid; gap: 14px; align-content: start; max-height: calc(100vh - 240px); overflow: auto; }
.skill-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.skill-detail-head h3 { margin: 0; font-size: 16px; }
.skill-detail-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.skill-market-origin { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px !important; }
.skill-repo-note { color: var(--accent-text) !important; font-size: 11px !important; }
.skill-detail-desc { margin: 0; color: var(--text-soft); font-size: 13px; line-height: 1.55; }
.skill-detail-actions { flex-wrap: wrap; }
.skill-remove-confirm { display: grid; gap: 8px; padding: 10px; border: 1px solid #f2555a; border-radius: 9px; }
.skill-remove-confirm p { margin: 0; color: #f2555a; font-size: 12px; }
.skill-remove-confirm input { height: 30px; padding: 0 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; }
.skill-remove-confirm button { border: 0; background: transparent; color: var(--text-soft); font: inherit; font-size: 12px; cursor: pointer; }
.skill-remove-confirm button.danger { color: #f2555a; font-weight: 650; }
.danger { color: #f2555a !important; }
.skill-detail-empty { min-height: 120px; }
</style>
