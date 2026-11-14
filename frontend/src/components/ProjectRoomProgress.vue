<template>
  <section class="project-room-progress" :aria-label="t('projectRoom.progress.title')">
    <div class="progress-chain">
      <button
        v-for="item in progressItems"
        :key="item.checkpointId"
        class="progress-step"
        :class="[item.state, { active: item.checkpointId === activeTargetId, blocked: item.blocked }]"
        type="button"
        :title="`${item.name} · ${item.label}`"
        :aria-label="`${item.name} · ${item.label}`"
        :aria-current="item.checkpointId === activeTargetId ? 'true' : undefined"
        @click="selectTarget(item.checkpointId)"
      >
        <span class="progress-glyph" aria-hidden="true">{{ item.glyph }}</span>
      </button>
      <span v-if="!progressItems.length" class="progress-empty">{{ t('projectRoom.progress.notStarted') }}</span>
    </div>

    <div class="progress-summary">
      <button
        class="progress-summary-main"
        type="button"
        :aria-expanded="String(expanded)"
        @click="expanded = !expanded"
      >
        <template v-if="currentItem">
          <strong>{{ currentItem.name }}</strong>
          <span>
            {{ currentItem.label }}
            <template v-if="currentItem.round"> · {{ t('projectRoom.progress.round', { count: currentItem.round }) }}</template>
            <template v-if="currentItem.leadSeatName"> · {{ currentItem.leadSeatName }}</template>
            <template v-if="currentItem.elapsed"> · {{ currentItem.elapsed }}</template>
          </span>
        </template>
        <span v-else>
          {{ progressItems.length ? t('projectRoom.progress.noTarget') : t('projectRoom.progress.notStarted') }}
        </span>
      </button>
      <span v-if="lastActivityLabel" class="progress-activity">
        {{ t('projectRoom.progress.lastActivity', { time: lastActivityLabel }) }}
      </span>
      <span class="progress-usage">{{ t('projectRoom.usage.unavailable') }}</span>
      <button
        class="progress-toggle"
        type="button"
        :aria-expanded="String(expanded)"
        @click="expanded = !expanded"
      >
        {{ expanded ? t('projectRoom.progress.collapse') : t('projectRoom.progress.expand') }}
      </button>
    </div>

    <div v-if="expanded" class="progress-list">
      <div
        v-for="item in progressItems"
        :key="item.checkpointId"
        class="progress-row"
        :class="{ active: item.checkpointId === activeTargetId }"
      >
        <button class="progress-row-main" type="button" @click="selectTarget(item.checkpointId)">
          <span class="progress-glyph" aria-hidden="true">{{ item.glyph }}</span>
          <span class="progress-row-copy">
            <strong>{{ item.name }}</strong>
            <small>
              {{ item.label }}
              <template v-if="item.leadSeatName"> · {{ item.leadSeatName }}</template>
              <template v-if="item.elapsed"> · {{ item.elapsed }}</template>
            </small>
          </span>
        </button>
        <button
          v-if="item.state === 'accepted'"
          class="progress-reopen"
          type="button"
          @click="requestReopen(item.checkpointId)"
        >
          {{ t('projectRoom.progress.reopen') }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  activeTargetId,
  currentItem,
  lastActivityLabel,
  progressItems,
  requestReopen,
  selectTarget,
  t,
} = props.controller

const expanded = ref(false)
</script>
