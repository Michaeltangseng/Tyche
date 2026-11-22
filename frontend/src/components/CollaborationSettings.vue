<template>
  <section class="settings-panel collaboration-settings">
    <p class="collaboration-note">{{ t('systemSettings.notApplied') }}</p>
    <div class="general-settings-row">
      <div class="general-settings-copy">
        <h2>{{ t('systemSettings.maxWake') }}</h2>
        <p>{{ t('systemSettings.maxWakeHint') }}</p>
      </div>
      <input
        v-model.number="maxWake"
        type="number"
        min="1"
        max="4"
        step="1"
        :aria-label="t('systemSettings.maxWake')"
        @change="persist"
      />
    </div>
    <div class="general-settings-row">
      <div class="general-settings-copy">
        <h2>{{ t('systemSettings.maxSteps') }}</h2>
        <p>{{ t('systemSettings.maxStepsHint') }}</p>
      </div>
      <input
        v-model.number="maxSteps"
        type="number"
        min="1"
        max="50"
        step="1"
        :aria-label="t('systemSettings.maxSteps')"
        @change="persist"
      />
    </div>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import { t } from '../i18n.js'

const STORAGE_KEY = 'tyche-orchestration-defaults'

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '')
    return {
      maxWake: clamp(parsed.maxWake, 1, 4, 1),
      maxSteps: clamp(parsed.maxSteps, 1, 50, 8),
    }
  } catch {
    return { maxWake: 1, maxSteps: 8 }
  }
}

const stored = load()
const maxWake = ref(stored.maxWake)
const maxSteps = ref(stored.maxSteps)

function persist() {
  maxWake.value = clamp(maxWake.value, 1, 4, 1)
  maxSteps.value = clamp(maxSteps.value, 1, 50, 8)
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    maxWake: maxWake.value,
    maxSteps: maxSteps.value,
  }))
}
</script>

<style scoped>
.collaboration-note { margin: 8px 0 4px; color: var(--muted); font-size: 13px; line-height: 1.5; }
.collaboration-settings input {
  width: 72px;
  min-height: 36px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
}
</style>
