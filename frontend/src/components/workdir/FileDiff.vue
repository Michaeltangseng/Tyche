<template>
  <section class="file-diff" :aria-label="t('workdir.diff.title')">
    <header class="file-diff-header">
      <strong>{{ diff?.path || t('workdir.diff.title') }}</strong>
      <span v-if="diff?.change">{{ changeLabel }}</span>
    </header>
    <p v-if="error" class="file-diff-error" role="alert">{{ error }}</p>
    <template v-if="diff">
      <p v-if="!diff.change?.diffAvailable" class="file-diff-empty">
        {{ changeLabel }}
      </p>
      <DiffView
        v-else-if="hunks.length"
        :data="diffData"
        :diff-view-mode="DiffModeEnum.Unified"
        :diff-view-theme="theme"
        :diff-view-font-size="12"
      />
      <p v-else class="file-diff-empty">{{ t('workdir.diff.noText') }}</p>
    </template>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { DiffModeEnum, DiffView } from '@git-diff-view/vue'
import '@git-diff-view/vue/styles/diff-view.css'

const props = defineProps({
  controller: { type: Object, required: true },
})

const { diff, error, t, theme } = props.controller

const CHANGE_KEYS = {
  added: 'workdir.change.added',
  deleted: 'workdir.change.deleted',
  'content-changed': 'workdir.change.content-changed',
  'mode-changed': 'workdir.change.mode-changed',
  'large-file-changed': 'workdir.change.large-file-changed',
  'type-changed': 'workdir.change.type-changed',
  'link-target-changed': 'workdir.change.link-target-changed',
  unchanged: 'workdir.change.unchanged',
}

const changeLabel = computed(() => {
  const change = String(diff.value?.change?.change || '')
  const key = CHANGE_KEYS[change]
  return key ? t(key) : change
})

const hunks = computed(() => {
  const lines = String(diff.value?.diff?.text || '').split('\n')
  const result = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) result.push(current.join('\n'))
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) result.push(current.join('\n'))
  return result
})

const diffData = computed(() => ({
  oldFile: { fileName: diff.value?.path || '', fileLang: 'text', content: null },
  newFile: { fileName: diff.value?.path || '', fileLang: 'text', content: null },
  hunks: hunks.value,
}))
</script>
