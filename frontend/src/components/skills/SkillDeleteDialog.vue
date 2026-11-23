<template>
  <Teleport to="body">
    <div class="skill-dialog-backdrop" @click.self="close" @wheel.self.prevent>
      <form class="skill-dialog skill-delete" role="dialog" aria-modal="true" :aria-label="t('settingsUi.deleteSkillTitle')" @submit.prevent="submit" @keydown.esc.stop="close">
        <header class="skill-dialog-head">
          <div>
            <h2>{{ t('settingsUi.deleteSkillTitle') }}</h2>
            <p>{{ t('settingsUi.deleteSkillLead') }}</p>
          </div>
          <button class="skill-dialog-close" type="button" :aria-label="t('common.cancel')" @click="close">×</button>
        </header>

        <p v-if="error" class="settings-banner" role="alert">{{ error }}</p>

        <div class="skill-delete-target">
          <strong>{{ skill?.name }}</strong>
        </div>

        <label class="skill-delete-confirm">
          <span>{{ t('settingsUi.deleteConfirmHint') }}</span>
          <input v-model.trim="confirmName" type="text" :placeholder="t('settingsUi.deleteConfirmPlaceholder')" autocomplete="off" />
        </label>

        <footer class="skill-dialog-foot">
          <button class="secondary-button" type="button" @click="close">{{ t('common.cancel') }}</button>
          <button class="danger-button" type="submit" :disabled="busy || !canDelete">{{ t('settingsUi.deleteSkill') }}</button>
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
  skill: { type: Object, default: null },
})
const emit = defineEmits(['close', 'done'])

const confirmName = ref('')
const busy = ref(false)
const error = ref('')
const canDelete = computed(() => Boolean(props.skill?.name) && confirmName.value === props.skill.name)

async function submit() {
  if (busy.value || !canDelete.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await props.api.remove({
      id: props.skill.id,
      confirmName: confirmName.value,
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
.skill-dialog { display: grid; gap: 14px; width: min(460px, 100%); padding: 18px; border: 1px solid #f2555a; border-radius: 14px; background: var(--bg); box-shadow: 0 24px 70px rgb(0 0 0 / 0.45); }
.skill-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.skill-dialog-head h2 { margin: 0; font-size: 18px; color: #f2555a; }
.skill-dialog-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.skill-dialog-close { width: 28px; height: 28px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; }
.skill-dialog-close:hover { background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); }
.skill-delete-target { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border-radius: 9px; background: color-mix(in srgb, var(--text) 6%, transparent); }
.skill-delete-target strong { font-size: 13px; }
.skill-delete-target small { color: var(--muted); font-size: 11px; }
.skill-delete-confirm { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
.skill-delete-confirm input { height: 32px; padding: 0 9px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); font: inherit; font-size: 13px; }
.skill-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
