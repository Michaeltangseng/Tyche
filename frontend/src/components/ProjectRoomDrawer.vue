<template>
  <div v-if="open" class="project-room-drawer-layer" :class="{ drawer }">
    <button
      v-if="drawer"
      class="project-room-drawer-scrim"
      type="button"
      :aria-label="t('projectRoom.drawer.close')"
      @click="close"
    />
    <aside
      ref="panelElement"
      class="project-room-drawer"
      :role="drawer ? 'dialog' : 'complementary'"
      :aria-modal="drawer ? 'true' : undefined"
      :aria-label="t('projectRoom.drawer.title')"
      :style="drawer ? undefined : { width: `${width}px` }"
      tabindex="-1"
    >
      <header class="project-room-drawer-header">
        <div class="project-room-drawer-tabs" role="tablist">
          <button
            v-for="tab in tabs"
            :key="tab.value"
            type="button"
            role="tab"
            :aria-selected="String(activeTab === tab.value)"
            :class="{ active: activeTab === tab.value }"
            @click="selectTab(tab.value)"
          >
            {{ t(tab.labelKey) }}
          </button>
        </div>
        <button
          class="icon-button"
          type="button"
          :title="t('projectRoom.drawer.close')"
          :aria-label="t('projectRoom.drawer.close')"
          @click="close"
        >
          <CloseOutline />
        </button>
      </header>

      <section v-if="activeTab === 'files'" class="project-room-drawer-body" role="tabpanel">
        <h3>{{ t('projectRoom.drawer.acceptedDocs') }}</h3>
        <p v-if="!acceptedDocuments.length" class="project-room-drawer-empty">
          {{ t('projectRoom.drawer.noAcceptedDocs') }}
        </p>
        <div v-for="item in acceptedDocuments" :key="item.checkpointId" class="accepted-doc">
          <header>
            <strong>{{ item.name }}</strong>
            <span class="accepted-doc-flags">
              <span v-if="item.stale" class="accepted-doc-pending">
                {{ t('projectRoom.state.stale') }}
              </span>
              <span v-if="item.hasPendingVersion" class="accepted-doc-pending">
                {{ t('projectRoom.drawer.pendingVersion') }}
              </span>
            </span>
          </header>
          <small>
            {{ t('projectRoom.drawer.version', { id: item.acceptedVersion.id }) }}
            <template v-if="item.acceptedVersion.acceptedAt">
              · {{ formatNavTime(item.acceptedVersion.acceptedAt) }}
            </template>
          </small>
          <ul>
            <li v-for="file in item.acceptedVersion.files || []" :key="file">{{ file }}</li>
          </ul>
        </div>
      </section>

      <section v-else class="project-room-drawer-body" role="tabpanel">
        <p class="project-room-drawer-empty">{{ t('projectRoom.drawer.traceUnavailable') }}</p>
      </section>

      <div
        class="project-room-drawer-resize"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('projectRoom.drawer.resize')"
        @pointerdown.prevent="startResize"
      />
    </aside>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CloseOutline } from '@vicons/ionicons5'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  close,
  drawer,
  formatNavTime,
  onResize,
  open,
  projectId,
  projectSnapshot,
  savePreferences,
  t,
} = props.controller

const tabs = [
  { value: 'files', labelKey: 'projectRoom.drawer.files' },
  { value: 'trace', labelKey: 'projectRoom.drawer.trace' },
]
const DEFAULT_WIDTH = 420
const MIN_WIDTH = 280
const MAX_WIDTH = 760
const activeTab = ref('files')
const width = ref(DEFAULT_WIDTH)
const panelElement = ref(null)
let resizeState = null

const acceptedDocuments = computed(() => (
  (projectSnapshot.value?.progress || [])
    .filter(item => item.acceptedVersion)
    .map(item => ({
      checkpointId: item.checkpointId,
      name: item.name,
      stale: item.state === 'stale',
      hasPendingVersion: item.hasPendingVersion === true,
      acceptedVersion: item.acceptedVersion,
    }))
))

function applyPreferences() {
  const preferences = projectSnapshot.value?.preferences || {}
  if (Number.isInteger(preferences.drawerWidth)) {
    width.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, preferences.drawerWidth))
  } else {
    width.value = DEFAULT_WIDTH
  }
  activeTab.value = preferences.drawerTab === 'trace' ? 'trace' : 'files'
}

watch(() => projectSnapshot.value?.preferences, applyPreferences, { immediate: true })
watch(() => projectId.value, applyPreferences)

function persistPreferences(preferences) {
  if (projectSnapshot.value?.readOnly) return
  void savePreferences(preferences)
}

function selectTab(tab) {
  if (activeTab.value === tab) return
  activeTab.value = tab
  persistPreferences({ drawerTab: tab })
}

function startResize(event) {
  resizeState = {
    startX: event.clientX,
    startWidth: width.value,
  }
  window.addEventListener('pointermove', handleResize)
  window.addEventListener('pointerup', finishResize, { once: true })
}

function handleResize(event) {
  if (!resizeState) return
  width.value = Math.min(
    MAX_WIDTH,
    Math.max(MIN_WIDTH, resizeState.startWidth + (resizeState.startX - event.clientX)),
  )
  onResize?.(width.value)
}

function finishResize() {
  window.removeEventListener('pointermove', handleResize)
  resizeState = null
  persistPreferences({ drawerWidth: width.value })
}

watch([open, drawer], ([isOpen, isDrawer]) => {
  document.body.classList.toggle('project-room-drawer-open', Boolean(isOpen && isDrawer))
}, { immediate: true })

function handleEscape(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  close()
}

onMounted(() => {
  panelElement.value?.focus?.()
  window.addEventListener('keydown', handleEscape)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', handleResize)
  window.removeEventListener('keydown', handleEscape)
  document.body.classList.remove('project-room-drawer-open')
})
</script>
