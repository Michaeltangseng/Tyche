<template>
  <section class="settings-panel mcp-servers-panel" :aria-busy="String(loading)">
    <div class="mcp-panel-head">
      <div>
        <h2>{{ t('mcpPanel.title') }}</h2>
        <p>{{ t('mcpPanel.hint') }}</p>
      </div>
      <button class="secondary-button" type="button" :disabled="loading" @click="load">
        <RefreshOutline :class="{ spinning: loading }" />
        {{ t('mcpPanel.refresh') }}
      </button>
    </div>

    <p v-if="error" class="settings-banner" role="alert">{{ error }}</p>
    <p v-if="loading" class="settings-note">{{ t('common.loading') }}</p>
    <p v-else-if="!servers.length" class="settings-note">{{ t('mcpPanel.empty') }}</p>
    <div v-else class="settings-mini-table-wrap">
      <table class="settings-mini-table">
        <thead>
          <tr>
            <th>{{ t('mcpPanel.name') }}</th>
            <th>{{ t('mcpPanel.transport') }}</th>
            <th>{{ t('mcpPanel.agents') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="server in servers" :key="`${server.name}-${server.transport}`">
            <td><strong>{{ server.name }}</strong></td>
            <td class="mcp-transport">{{ transportLabel(server.transport) }}</td>
            <td>{{ server.agents.join(' · ') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { RefreshOutline } from '@vicons/ionicons5'
import { desktopApi } from '../desktop.js'
import { t, translateError } from '../i18n.js'

const api = desktopApi()?.nativeMcp
const servers = ref([])
const loading = ref(false)
const error = ref('')

function transportLabel(transport) {
  return t(`mcpPanel.transport.${transport || 'unknown'}`)
}

async function load() {
  if (!api?.list || loading.value) return
  loading.value = true
  error.value = ''
  try {
    const listed = await api.list()
    servers.value = Array.isArray(listed) ? listed : []
  } catch (caught) {
    error.value = translateError(caught) || t('mcpPanel.loadFailed')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.mcp-servers-panel { display: grid; gap: 12px; }
.mcp-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.mcp-panel-head h2 { margin: 0; font-size: 16px; }
.mcp-panel-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; max-width: 640px; }
.mcp-transport { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
</style>
