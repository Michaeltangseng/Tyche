<template>
  <div class="project-timeline-card" :data-kind="card.kind">
    <template v-if="card.kind === 'checkpoint'">
      <div class="project-timeline-separator">
        <span>{{ card.name }}</span>
        <small>
          {{ card.reopened ? t('projectRoom.timeline.reopened') : t('projectRoom.timeline.started') }}
          <template v-if="card.at"> · {{ formatNavTime(card.at) }}</template>
          <template v-if="card.reason"> · {{ card.reason }}</template>
        </small>
      </div>
    </template>

    <template v-else-if="card.kind === 'gate'">
      <button class="project-timeline-gate" type="button" @click="selectGate(card.checkpointId)">
        <strong>{{ t('projectRoom.timeline.gateTitle', { name: card.name }) }}</strong>
        <span>{{ card.reason }}</span>
        <small>{{ t('projectRoom.timeline.openGate') }}</small>
      </button>
    </template>

    <template v-else-if="card.kind === 'gate-decided'">
      <details class="project-timeline-decided">
        <summary>
          {{ t('projectRoom.timeline.gateDecided', {
            name: card.name, outcome: card.outcome, reason: card.reason,
          }) }}
          <small v-if="card.at"> · {{ formatNavTime(card.at) }}</small>
        </summary>
        <p v-if="card.comment">{{ card.comment }}</p>
        <p v-else class="project-timeline-muted">{{ t('projectRoom.timeline.noComment') }}</p>
      </details>
    </template>

    <template v-else-if="card.kind === 'gate-voided'">
      <p class="project-timeline-voided">
        {{ t('projectRoom.timeline.gateVoided', { name: card.name }) }}
      </p>
    </template>

    <template v-else-if="card.kind === 'interjection'">
      <div class="project-timeline-interjection">
        <p>{{ card.content }}</p>
        <button class="project-timeline-action" type="button" @click="stopDelivery(card.checkpointId)">
          {{ t('projectRoom.timeline.stopAndDeliver') }}
        </button>
      </div>
    </template>

    <template v-else-if="card.kind === 'running'">
      <p class="project-timeline-running">
        <span>{{ runningLabel }}</span>
        <small v-if="card.waitingOn"> · {{ card.waitingOn }}</small>
      </p>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  card: { type: Object, required: true },
  formatNavTime: { type: Function, default: () => '' },
  selectGate: { type: Function, default: null },
  stopDelivery: { type: Function, default: null },
  t: { type: Function, required: true },
})

const runningLabel = computed(() => {
  const key = {
    checking: 'projectRoom.state.checking',
    drafting: 'projectRoom.state.drafting',
    leading: 'projectRoom.state.leading',
    submitted: 'projectRoom.state.submitted',
    reviewing: 'projectRoom.state.reviewing',
    accepting: 'projectRoom.state.accepting',
  }[props.card.state] || 'projectRoom.state.unknown'
  return `${props.card.name} · ${props.t(key)}`
})
</script>
