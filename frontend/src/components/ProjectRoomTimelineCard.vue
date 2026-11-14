<template>
  <div class="project-timeline-card" :data-kind="card.kind">
    <template v-if="card.kind === 'checkpoint'">
      <div class="project-timeline-separator">
        <span>{{ card.name }}</span>
        <small>
          {{ card.reopened ? t('projectRoom.timeline.reopened') : t('projectRoom.timeline.started') }}
          <template v-if="card.at"> · {{ formatNavTime(card.at) }}</template>
          <template v-if="reasonLabel"> · {{ reasonLabel }}</template>
        </small>
      </div>
    </template>

    <template v-else-if="card.kind === 'gate'">
      <button class="project-timeline-gate" type="button" @click="selectGate(card.checkpointId)">
        <strong>{{ t('projectRoom.timeline.gateTitle', { name: card.name }) }}</strong>
        <span>{{ reasonLabel }}</span>
        <small>{{ t('projectRoom.timeline.openGate') }}</small>
      </button>
    </template>

    <template v-else-if="card.kind === 'gate-decided'">
      <details class="project-timeline-decided">
        <summary>
          {{ t('projectRoom.timeline.gateDecided', {
            name: card.name, outcome: outcomeLabel, reason: reasonLabel,
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
      <div class="project-timeline-running">
        <div class="project-timeline-running-header">
          <span v-if="card.activeInvocations?.length" class="project-timeline-running-team">
            <span
              v-for="invocation in card.activeInvocations"
              :key="invocation.effectId"
              class="project-timeline-running-agent"
            >
              <img :src="agentLogo(invocation.agentKind, theme)" :alt="agentLabel(invocation.agentKind)" />
              <span>{{ agentLabel(invocation.agentKind) }}</span>
              <small>{{ roleLabel(invocation.role) }}</small>
            </span>
          </span>
          <span class="project-timeline-running-state">{{ runningLabel }}</span>
        </div>
        <InlineTrace
          v-for="invocation in card.activeInvocations || []"
          :key="`trace:${invocation.effectId}`"
          :agent-run-id="invocation.effectId"
          :default-open="true"
          :run-id="card.checkpointId"
          live
          :t="t"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { agentLabel, agentLogo } from '../catalog.js'
import InlineTrace from './trace/InlineTrace.vue'

const props = defineProps({
  card: { type: Object, required: true },
  formatNavTime: { type: Function, default: () => '' },
  selectGate: { type: Function, default: null },
  stopDelivery: { type: Function, default: null },
  t: { type: Function, required: true },
  theme: { type: String, default: 'light' },
})

const reasonLabel = computed(() => (
  props.card.reason ? props.t(`projectRoom.gate.reason.${props.card.reason}`) : ''
))
const outcomeLabel = computed(() => (
  props.card.outcome ? props.t(`projectRoom.gate.outcome.${props.card.outcome}`) : ''
))

const WAITING_ON_KEYS = {
  human: 'projectRoom.state.gate',
  retry: 'projectRoom.state.paused',
  lead: 'projectRoom.state.leading',
  reviewers: 'projectRoom.state.reviewing',
  drafts: 'projectRoom.state.drafting',
  upstream: 'projectRoom.state.pending',
  'drift-check': 'projectRoom.state.checking',
  candidate: 'projectRoom.state.submitted',
  accepting: 'projectRoom.state.accepting',
}

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

function roleLabel(role) {
  const key = `projectRoom.timeline.role.${role || 'lead'}`
  const label = props.t(key)
  return label === key ? String(role || '') : label
}
</script>
