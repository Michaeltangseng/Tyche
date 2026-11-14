<template>
  <section class="file-preview" :aria-label="t('workdir.preview.title')">
    <header class="file-preview-header">
      <strong>{{ preview?.path || t('workdir.preview.title') }}</strong>
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
          <pre class="file-preview-text">{{ preview.text }}</pre>
          <button
            v-if="!preview.eof"
            class="secondary-button"
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
        <p v-else class="file-preview-binary">
          {{ t('workdir.preview.binary', { size: preview.size }) }}
        </p>
      </template>
    </template>
    <p v-else-if="!loading" class="file-preview-empty">{{ t('workdir.preview.selectFile') }}</p>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

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
const secretName = computed(() => {
  const name = String(preview.value?.path || '').split('/').at(-1) || ''
  return /^\.env(?:\.|$)/i.test(name)
    || /\.(?:pem|key)$/i.test(name)
    || /^id_rsa/i.test(name)
})

watch(() => preview.value?.path, () => { revealed.value = false })
</script>
