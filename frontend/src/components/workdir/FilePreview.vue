<template>
  <section class="file-preview" :aria-label="t('workdir.preview.title')">
    <header class="file-preview-header">
      <div class="file-preview-breadcrumb" :title="preview?.path || ''">
        <template v-for="(segment, index) in pathSegments" :key="`${segment}:${index}`">
          <ChevronForwardOutline v-if="index" class="file-preview-separator" aria-hidden="true" />
          <span :class="{ 'file-preview-file-name': index === pathSegments.length - 1 }">{{ segment }}</span>
        </template>
      </div>
      <div class="file-preview-actions">
        <span v-if="preview" class="file-preview-meta">{{ previewMeta }}</span>
        <button
          v-if="preview?.path"
          class="file-preview-action"
          type="button"
          :title="copiedPath ? t('workdir.preview.copiedPath') : t('workdir.preview.copyPath')"
          :aria-label="copiedPath ? t('workdir.preview.copiedPath') : t('workdir.preview.copyPath')"
          @click="copyPath"
        >
          <CheckmarkCircleOutline v-if="copiedPath" />
          <CopyOutline v-else />
        </button>
      </div>
    </header>
    <p v-if="error" class="file-preview-error" role="alert">{{ error }}</p>
    <template v-if="preview">
      <section v-if="secretName && !revealed" class="file-preview-secret" role="alert">
        <p>{{ t('workdir.preview.secretWarning') }}</p>
        <button class="primary-button" type="button" @click="revealed = true">
          {{ t('workdir.preview.reveal') }}
        </button>
      </section>
      <template v-else>
        <template v-if="preview.kind === 'text'">
          <div class="file-preview-code" :class="{ 'no-gutter': !showLineNumbers }">
            <pre v-if="showLineNumbers" class="file-preview-gutter" aria-hidden="true">{{ lineNumbers }}</pre>
            <pre class="file-preview-text">{{ preview.text }}</pre>
          </div>
          <button
            v-if="!preview.eof"
            class="secondary-button file-preview-load-more"
            type="button"
            :disabled="loading"
            @click="loadMorePreview"
          >
            {{ t('workdir.preview.loadMore') }}
          </button>
        </template>
        <img
          v-else-if="preview.kind === 'image'"
          class="file-preview-image"
          :src="`data:${preview.mime};base64,${preview.dataBase64}`"
          :alt="preview.path"
        />
        <div v-else class="file-preview-binary">
          <FileTrayOutline aria-hidden="true" />
          <p>{{ t('workdir.preview.binary', { size: preview.size }) }}</p>
        </div>
      </template>
    </template>
    <div v-else-if="!loading" class="file-preview-empty">
      <DocumentTextOutline aria-hidden="true" />
      <p>{{ t('workdir.preview.selectFile') }}</p>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import {
  CheckmarkCircleOutline,
  ChevronForwardOutline,
  CopyOutline,
  DocumentTextOutline,
  FileTrayOutline,
} from '@vicons/ionicons5'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  error,
  loading,
  loadMorePreview,
  preview,
  t,
} = props.controller

const revealed = ref(false)
const copiedPath = ref(false)
let copyTimer = null
const secretName = computed(() => {
  const name = String(preview.value?.path || '').split('/').at(-1) || ''
  return /^\.env(?:\.|$)/i.test(name)
    || /\.(?:pem|key)$/i.test(name)
    || /^id_rsa/i.test(name)
})
const pathSegments = computed(() => String(preview.value?.path || '').split('/').filter(Boolean))
const lines = computed(() => String(preview.value?.text || '').split('\n'))
const showLineNumbers = computed(() => (
  preview.value?.kind === 'text' && lines.value.length <= 5000
))
const lineNumbers = computed(() => lines.value.map((_, index) => index + 1).join('\n'))
const previewMeta = computed(() => {
  if (!preview.value) return ''
  if (preview.value.kind === 'text') {
    return t('workdir.preview.lineCount', { count: lines.value.length })
  }
  return t('workdir.preview.fileSize', { size: preview.value.size || preview.value.totalBytes || 0 })
})

watch(() => preview.value?.path, () => {
  revealed.value = false
  copiedPath.value = false
})

async function copyPath() {
  const path = String(preview.value?.path || '')
  if (!path) return
  try {
    await navigator.clipboard.writeText(path)
    copiedPath.value = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copiedPath.value = false }, 1500)
  } catch {
    copiedPath.value = false
  }
}
</script>
