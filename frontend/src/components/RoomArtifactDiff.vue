<template>
  <section ref="panel" class="room-artifact-diff" tabindex="-1" :aria-label="t('room.diff')" :aria-busy="loading" @keydown.esc.stop.prevent="$emit('close')">
    <header><strong>{{ t('room.diff') }} · {{ artifact.path }}</strong><button class="secondary-button" type="button" @click="$emit('close')">{{ t('room.closeDiff') }}</button></header>
    <p v-if="loading" role="status">{{ t('room.loadingDiff') }}</p>
    <p v-else-if="failed" role="alert">{{ t('room.diffError') }} <button class="secondary-button" type="button" @click="load">{{ t('room.refresh') }}</button></p>
    <template v-else-if="diff">
      <p v-if="diff.truncated" role="status">{{ t('room.diffTruncated') }}</p>
      <pre v-if="diff.text">{{ diff.text }}</pre>
      <p v-else>{{ t('room.noDiff') }}</p>
    </template>
  </section>
</template>

<script setup>
import { nextTick, onMounted, onScopeDispose, ref } from 'vue'
import { t } from '../i18n.js'

const props = defineProps({ api: { type: Object, required: true }, roomId: { type: String, required: true }, artifact: { type: Object, required: true } })
defineEmits(['close'])
const panel = ref(null)
const diff = ref(null)
const loading = ref(true)
const failed = ref(false)
let disposed = false
async function load() {
  loading.value = true
  failed.value = false
  try {
    const result = await props.api.artifactDiff({ roomId: props.roomId, artifactId: props.artifact.id })
    if (!disposed) diff.value = result
  } catch { if (!disposed) failed.value = true }
  finally { if (!disposed) loading.value = false }
}
onMounted(async () => { await nextTick(); panel.value?.focus(); void load() })
onScopeDispose(() => { disposed = true })
</script>

<style scoped>
.room-artifact-diff { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px; min-width: 0; }
.room-artifact-diff header { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.room-artifact-diff pre { overflow: auto; max-height: 55vh; white-space: pre; font-size: 12px; line-height: 1.5; padding: 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
</style>
