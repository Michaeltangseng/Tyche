<template>
  <Teleport to="body">
    <div class="skill-dialog-backdrop" @click.self="close" @wheel.self.prevent>
      <section class="skill-dialog" role="dialog" aria-modal="true" :aria-label="t('settingsUi.importTitle')" tabindex="-1" @keydown.esc.stop="close">
        <header class="skill-dialog-head">
          <div>
            <h2>{{ t('settingsUi.importTitle') }}</h2>
            <p>{{ t('settingsUi.importLead') }}</p>
          </div>
          <button class="skill-dialog-close" type="button" :aria-label="t('common.cancel')" @click="close">×</button>
        </header>

        <p v-if="error" class="settings-banner" role="alert">{{ error }}</p>

        <div class="skill-import-toolbar">
          <input v-model="query" type="search" :placeholder="t('settingsUi.searchSkill')" :aria-label="t('settingsUi.searchSkill')" />
          <label class="skill-import-check">
            <input v-model="trustSelected" type="checkbox" />
            {{ t('settingsUi.importTrust') }}
          </label>
          <select v-model="onConflict" :aria-label="t('settingsUi.importConflict')">
            <option value="rename">{{ t('settingsUi.importConflictRename') }}</option>
            <option value="replace">{{ t('settingsUi.importConflictReplace') }}</option>
          </select>
        </div>

        <div class="skill-import-body">
          <div class="skill-import-list">
            <p v-if="!nativeSkills.length" class="settings-note">{{ t('settingsUi.importEmpty') }}</p>
            <label
              v-for="skill in nativeSkills"
              :key="skill.id"
              class="skill-import-row"
              :class="{ picked: activeId === skill.id, checked: selected.includes(skill.id) }"
              @click="activeId = skill.id"
            >
              <input type="checkbox" :checked="selected.includes(skill.id)" @change.stop="toggle(skill.id)" />
              <span class="skill-import-copy">
                <strong>{{ skill.name }}</strong>
                <small>{{ agentLabel(skill.originKind) }} · {{ t(`settingsUi.trustState.${skill.trust}`) }}</small>
                <small v-if="skill.description" class="skill-import-desc">{{ skill.description }}</small>
              </span>
              <span v-if="skill.conflict" class="skill-import-badge">{{ t('settingsUi.trustState.conflict') }}</span>
            </label>
          </div>

          <aside class="skill-import-preview">
            <template v-if="active">
              <h3>{{ active.name }}</h3>
              <p>{{ t(sourceLabelKey(active.source)) }} · {{ agentLabel(active.originKind) }}</p>
              <p>{{ active.description || t('settingsUi.noDescription') }}</p>
              <div class="skill-import-meta">
                <span>{{ t(`settingsUi.trustState.${active.trust}`) }}</span>
                <span v-if="active.version">v{{ active.version }}</span>
                <span>{{ t('settingsUi.fileCount', { count: active.fileCount || 0 }) }}</span>
              </div>
              <div v-if="active.conflict" class="skill-import-conflict">
                <strong>{{ t('settingsUi.trustState.conflict') }}</strong>
                <small>{{ t('settingsUi.conflictHint') }}</small>
              </div>
              <pre class="skill-preview">{{ active.preview || t('settingsUi.noPreview') }}</pre>
            </template>
            <p v-else class="settings-note">{{ t('settingsUi.selectSkill') }}</p>
          </aside>
        </div>

        <footer class="skill-dialog-foot">
          <button class="secondary-button" type="button" @click="close">{{ t('common.cancel') }}</button>
          <button class="primary-button" type="button" :disabled="busy || !selected.length" @click="submit">
            {{ t('settingsUi.importSelected', { count: selected.length }) }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t, translateError } from '../../i18n.js'
import { sourceLabelKey } from '../../skillLibrary.js'

const props = defineProps({
  api: { type: Object, required: true },
  skills: { type: Array, default: () => [] },
  agentLabels: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['close', 'done'])

const query = ref('')
const selected = ref([])
const activeId = ref('')
const trustSelected = ref(true)
const onConflict = ref('rename')
const busy = ref(false)
const error = ref('')

const nativeSkills = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return props.skills
    .filter(skill => skill.source === 'native')
    .filter(skill => !needle || `${skill.name} ${skill.description || ''}`.toLowerCase().includes(needle))
})

const active = computed(() => (
  nativeSkills.value.find(skill => skill.id === activeId.value)
  || nativeSkills.value.find(skill => selected.value.includes(skill.id))
  || nativeSkills.value[0]
  || null
))

watch(active, (value) => {
  if (value && !activeId.value) activeId.value = value.id
}, { immediate: true })

function agentLabel(agent) {
  return props.agentLabels[agent] || agent
}

function toggle(id) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter(item => item !== id)
    : [...selected.value, id]
}

async function submit() {
  if (busy.value || !selected.value.length) return
  busy.value = true
  error.value = ''
  try {
    const result = await props.api.importFromAgent({
      ids: selected.value,
      trust: trustSelected.value,
      onConflict: onConflict.value,
    })
    emit('done', result)
  } catch (caught) {
    error.value = translateError(caught) || t('settingsUi.errorGeneric')
  } finally {
    busy.value = false
  }
}

function close() {
  if (!busy.value) emit('close')
}

function handleKey(event) {
  if (event.key === 'Escape') close()
}

onMounted(() => {
  window.addEventListener('keydown', handleKey)
  document.body.style.overflow = 'hidden'
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKey)
  document.body.style.overflow = ''
})
</script>

<style scoped>
.skill-dialog-backdrop { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 24px; background: rgb(0 0 0 / 0.42); }
.skill-dialog { display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto; gap: 12px; width: min(820px, 100%); max-height: min(760px, calc(100vh - 48px)); padding: 18px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg); box-shadow: 0 24px 70px rgb(0 0 0 / 0.45); }
.skill-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.skill-dialog-head h2 { margin: 0; font-size: 18px; }
.skill-dialog-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.skill-dialog-close { width: 28px; height: 28px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; }
.skill-dialog-close:hover { background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); }
.skill-import-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.skill-import-toolbar input[type="search"], .skill-import-toolbar select { height: 30px; padding: 0 9px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); font: inherit; font-size: 12px; }
.skill-import-toolbar input[type="search"] { flex: 1; min-width: 180px; }
.skill-import-check { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.skill-import-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 0.8fr); gap: 12px; min-height: 0; }
.skill-import-list { display: grid; gap: 4px; align-content: start; overflow: auto; padding-right: 4px; }
.skill-import-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 9px; align-items: start; padding: 9px; border: 1px solid transparent; border-radius: 9px; cursor: pointer; }
.skill-import-row:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.skill-import-row.picked { border-color: color-mix(in srgb, var(--accent) 42%, transparent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.skill-import-row.checked { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.skill-import-row input { margin-top: 3px; }
.skill-import-copy { display: grid; gap: 2px; min-width: 0; }
.skill-import-copy strong { font-size: 13px; }
.skill-import-copy small { color: var(--muted); font-size: 11px; }
.skill-import-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-import-badge { align-self: center; padding: 2px 7px; border-radius: 99px; background: color-mix(in srgb, #f5a524 16%, transparent); color: #f5a524; font-size: 10px; font-weight: 650; white-space: nowrap; }
.skill-import-preview { display: grid; gap: 8px; align-content: start; overflow: auto; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--surface) 55%, var(--bg)); }
.skill-import-preview h3 { margin: 0; font-size: 14px; }
.skill-import-preview p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.skill-import-meta { display: flex; flex-wrap: wrap; gap: 6px; color: var(--muted); font-size: 11px; }
.skill-import-meta span { padding: 1px 7px; border-radius: 99px; background: color-mix(in srgb, var(--text) 7%, transparent); }
.skill-import-conflict { display: grid; gap: 3px; padding: 8px; border-radius: 8px; background: color-mix(in srgb, #f5a524 12%, transparent); color: #f5a524; font-size: 11px; }
.skill-preview { margin: 0; max-height: 300px; overflow: auto; padding: 9px 10px; border-radius: 8px; background: #101416; color: var(--text-soft); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.55; white-space: pre-wrap; }
.skill-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 760px) {
  .skill-import-body { grid-template-columns: 1fr; }
}
</style>
