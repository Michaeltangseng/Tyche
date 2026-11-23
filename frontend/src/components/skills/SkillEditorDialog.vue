<template>
  <Teleport to="body">
    <div class="skill-dialog-backdrop" @click.self="close" @wheel.self.prevent>
      <form class="skill-dialog skill-editor" role="dialog" aria-modal="true" :aria-label="t('settingsUi.newSkillTitle')" @submit.prevent="submit" @keydown.esc.stop="close">
        <header class="skill-dialog-head">
          <div>
            <h2>{{ t('settingsUi.newSkillTitle') }}</h2>
            <p>{{ t('settingsUi.newSkillLead') }}</p>
          </div>
          <button class="skill-dialog-close" type="button" :aria-label="t('common.cancel')" @click="close">×</button>
        </header>

        <p v-if="error" class="settings-banner" role="alert">{{ error }}</p>

        <div class="skill-editor-grid">
          <label>
            <span>{{ t('settingsUi.newSkillName') }}</span>
            <input v-model.trim="name" type="text" maxlength="64" :placeholder="t('settingsUi.newSkillNamePlaceholder')" @input="nameTouched = true" />
            <small :class="{ 'skill-invalid': nameTouched && !validName }">{{ t('settingsUi.newSkillNameHint') }}</small>
          </label>
          <label>
            <span>{{ t('settingsUi.newSkillDescription') }}</span>
            <input v-model.trim="description" type="text" maxlength="240" :placeholder="t('settingsUi.newSkillDescriptionPlaceholder')" />
          </label>
        </div>

        <label class="skill-editor-body">
          <span>{{ t('settingsUi.newSkillBody') }}</span>
          <textarea v-model="body" rows="12" :placeholder="bodyPlaceholder" />
          <small>{{ t('settingsUi.newSkillBodyHint') }}</small>
        </label>

        <div class="skill-editor-targets">
          <span>{{ t('settingsUi.newSkillTargets') }}</span>
          <p v-if="!targetAgents.length" class="settings-note">{{ t('settingsUi.noAgents') }}</p>
          <label v-for="agent in targetAgents" :key="agent" class="skill-editor-target">
            <input v-model="targets" type="checkbox" :value="agent" />
            {{ agentLabel(agent) }}
          </label>
        </div>

        <footer class="skill-dialog-foot">
          <button class="secondary-button" type="button" @click="close">{{ t('common.cancel') }}</button>
          <button class="primary-button" type="submit" :disabled="busy || !canSubmit">{{ t('settingsUi.createSkill') }}</button>
        </footer>
      </form>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t, translateError } from '../../i18n.js'

const props = defineProps({
  api: { type: Object, required: true },
  agents: { type: Array, default: () => [] },
  agentLabels: { type: Object, default: () => ({}) },
  agentCapabilities: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['close', 'done'])

const name = ref('')
const description = ref('')
const body = ref('')
const targets = ref([])
const nameTouched = ref(false)
const busy = ref(false)
const error = ref('')

const validName = computed(() => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name.value))
const canSubmit = computed(() => validName.value && description.value.trim().length > 0)
const targetAgents = computed(() => props.agents.filter(agent => props.agentCapabilities[agent]?.projectable !== false))
const bodyPlaceholder = computed(() => `# ${name.value || 'my-skill'}\n\n${t('settingsUi.newSkillBodyPlaceholder')}`)

function agentLabel(agent) {
  return props.agentLabels[agent] || agent
}

async function submit() {
  if (busy.value || !canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    const created = await props.api.create({
      name: name.value,
      description: description.value,
      body: body.value,
      targets: targets.value,
    })
    emit('done', created)
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
.skill-dialog { display: grid; gap: 14px; width: min(720px, 100%); max-height: min(780px, calc(100vh - 48px)); overflow: auto; padding: 18px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg); box-shadow: 0 24px 70px rgb(0 0 0 / 0.45); }
.skill-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.skill-dialog-head h2 { margin: 0; font-size: 18px; }
.skill-dialog-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.skill-dialog-close { width: 28px; height: 28px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; }
.skill-dialog-close:hover { background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); }
.skill-editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.skill-editor label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
.skill-editor label > span { color: var(--text-soft); font-weight: 600; }
.skill-editor input[type="text"], .skill-editor textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; font-size: 13px; }
.skill-editor textarea { min-height: 180px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.55; }
.skill-editor small { color: var(--muted); font-size: 11px; }
.skill-editor small.skill-invalid { color: #f5a524; }
.skill-editor-body { display: grid; gap: 5px; }
.skill-editor-targets { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
.skill-editor-targets > span { width: 100%; color: var(--text-soft); font-size: 12px; font-weight: 600; }
.skill-editor-target { display: inline-flex; align-items: center; gap: 6px; color: var(--text-soft); font-size: 12px; }
.skill-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 640px) {
  .skill-editor-grid { grid-template-columns: 1fr; }
}
</style>
