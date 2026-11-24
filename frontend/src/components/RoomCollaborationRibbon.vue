<template>
  <div class="room-cast" :data-mode="state.mode" :aria-label="ariaLabel">
    <Transition name="room-cast-swap" mode="out-in">
      <div v-if="state.mode === 'running'" key="relay" class="room-relay">
        <span
          v-if="state.taskNumber !== '' && state.taskNumber != null"
          class="room-relay-task"
          :title="state.taskLabel"
        >#{{ state.taskNumber }}</span>
        <div class="room-relay-chain">
          <template v-for="(node, index) in relayNodes" :key="node.roleId">
            <span v-if="index" class="room-relay-link" aria-hidden="true">
              <span class="room-relay-thread" />
              <ChevronForwardOutline class="room-relay-chevron" />
            </span>
            <button
              class="room-relay-node"
              type="button"
              :data-state="node.state"
              :data-live="node.state === 'active' ? 'true' : undefined"
              :style="{ '--agent-glow': glowFor(node.role) }"
              :title="nodeTitle(node)"
              :aria-label="nodeTitle(node)"
              @click="selectRole(node.role)"
            >
              <span class="room-relay-face">
                <img
                  v-if="hasPortrait(node.role)"
                  class="room-relay-portrait"
                  :src="portraitFor(node.role)"
                  alt=""
                />
                <span v-else class="room-relay-initial">{{ initialFor(node.role) }}</span>
                <span
                  v-if="node.state === 'active'"
                  :key="node.activationKey"
                  class="room-relay-baton"
                  aria-hidden="true"
                />
                <span v-if="node.state === 'done'" class="room-relay-stamp" aria-hidden="true">✓</span>
                <span v-else-if="node.state === 'attention'" class="room-relay-stamp attention" aria-hidden="true">!</span>
                <span v-if="node.role?.is_captain" class="room-captain-mark" :title="t('room.captain')">⚓</span>
              </span>
              <span class="room-relay-copy">
                <strong>{{ labelFor(node.role) }}</strong>
                <small :data-state="node.state">
                  <span v-if="node.state === 'active'" class="room-relay-pulse" aria-hidden="true" />
                  <span>{{ nodeStatusLabel(node) }}</span>
                  <span v-if="nodeTimer(node)" class="room-relay-timer" aria-hidden="true">{{ nodeTimer(node) }}</span>
                </small>
              </span>
            </button>
          </template>
          <button
            class="room-agent-add room-agent-add-inline"
            type="button"
            :title="t('room.addAgent')"
            :aria-label="t('room.addAgent')"
            :disabled="addDisabled"
            @click="emit('add-role')"
          >
            <AddOutline />
          </button>
        </div>
        <span
          v-if="state.extraActiveTasks"
          class="room-relay-extra"
          :title="t('room.relay.moreTasks', { count: state.extraActiveTasks })"
        >+{{ state.extraActiveTasks }}</span>
      </div>

      <div v-else key="cast" class="room-cast-row">
        <div class="room-agent-strip" :aria-label="t('room.members', { count: roles.length })">
          <button
            v-for="role in roles"
            :key="role.id"
            class="room-agent-chip"
            type="button"
            :data-speaking="replyFor(role) ? 'true' : undefined"
            :data-quiet="role.can_speak === false ? 'true' : undefined"
            :style="chipStyle(role)"
            :title="chipTitle(role)"
            :aria-label="chipAria(role)"
            @click="selectRole(role)"
          >
            <span v-if="role.provider" class="room-chip-face">
              <span class="room-chip-photo">
                <img class="room-portrait" :src="portraitFor(role)" alt="" />
              </span>
              <span v-if="role.is_captain" class="room-captain-mark" :title="t('room.captain')">⚓</span>
            </span>
            <span class="room-chip-name">{{ labelFor(role) }}</span>
            <span v-if="role.can_speak === false" class="room-agent-mute" aria-hidden="true">{{ role.unavailable ? '⚠' : '🔇' }}</span>
            <span v-if="replyFor(role)" class="room-chip-live" :title="t('room.relay.replying')">
              <span class="room-chip-live-dot" aria-hidden="true" />
              <span aria-hidden="true">{{ elapsed(replyFor(role).since) }}</span>
            </span>
          </button>
          <span v-if="!roles.length" class="room-agent-idle">{{ t('room.teamIdle') }}</span>
          <button
            class="room-agent-add"
            type="button"
            :title="t('room.addAgent')"
            :aria-label="t('room.addAgent')"
            :disabled="addDisabled"
            @click="emit('add-role')"
          >
            <AddOutline />
          </button>
          <button
            v-if="unavailableRoles.length"
            class="room-cast-warning"
            type="button"
            :title="unavailableTitle"
            :aria-label="unavailableTitle"
            @click="selectRole(unavailableRoles[0])"
          >
            <span aria-hidden="true">⚠</span>
            <span>{{ t('room.agentsUnavailable', { count: unavailableRoles.length }) }}</span>
          </button>
          <button
            v-if="state.mode === 'settled'"
            class="room-recap-pill"
            type="button"
            :data-tone="state.tone"
            :title="recapTitle"
            :aria-label="recapTitle"
            @click="emit('open-work')"
          >
            <span v-if="recapFaces.length" class="room-recap-faces" aria-hidden="true">
              <img
                v-for="node in recapFaces"
                :key="node.roleId"
                :src="portraitFor(node.role)"
                alt=""
              />
              <span v-if="recapExtra" class="room-recap-more">+{{ recapExtra }}</span>
            </span>
            <span class="room-recap-dot" :data-tone="state.tone" aria-hidden="true" />
            <span class="room-recap-text">{{ recapLabel }}</span>
            <span v-if="relativeAge(state.settledAt)" class="room-recap-age" aria-hidden="true">{{ relativeAge(state.settledAt) }}</span>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { AddOutline, ChevronForwardOutline } from '@vicons/ionicons5'
import { t } from '../i18n.js'
import { portraitGlow, rolePortrait } from '../role-portraits.js'

const props = defineProps({
  state: {
    type: Object,
    default: () => ({ mode: 'idle', nodes: [], replies: [] }),
  },
  roles: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  canAdd: { type: Boolean, default: true },
})
const emit = defineEmits(['select-role', 'add-role', 'open-work'])

const now = ref(Date.now())
let clock = null

function startClock() {
  now.value = Date.now()
  if (!clock) clock = setInterval(() => { now.value = Date.now() }, 1000)
}

function stopClock() {
  if (clock) clearInterval(clock)
  clock = null
}

watch(
  () => props.state?.mode,
  mode => {
    if (mode === 'idle') stopClock()
    else startClock()
  },
  { immediate: true },
)

onBeforeUnmount(stopClock)

const roleById = computed(() => new Map(props.roles.map(role => [role.id, role])))
const relayNodes = computed(() => (props.state?.nodes || []).map(node => ({
  ...node,
  role: roleById.value.get(node.roleId) || {
    id: node.roleId,
    display_name: node.roleId,
    provider: '',
    can_speak: true,
  },
})))
const recapNodes = computed(() => relayNodes.value.filter(node => (
  node.state === 'done' || node.state === 'attention'
)))
const unavailableRoles = computed(() => props.roles.filter(role => role?.unavailable === true))
const unavailableTitle = computed(() => (
  unavailableRoles.value.length
    ? `${unavailableRoles.value.map(role => labelFor(role)).join(', ')} · ${t('room.agentUnavailable')}`
    : ''
))
const recapFaces = computed(() => recapNodes.value.slice(0, 3))
const recapExtra = computed(() => Math.max(0, recapNodes.value.length - 3))
const addDisabled = computed(() => props.busy || !props.canAdd)
const ariaLabel = computed(() => (
  props.state?.mode === 'running'
    ? t('room.relay.label')
    : t('room.members', { count: props.roles.length })
))
const recapLabel = computed(() => {
  if (props.state?.tone === 'review') return t('room.relay.awaitingAcceptance')
  if (props.state?.tone === 'attention') return t('room.relay.needsAttention')
  return t('room.relay.completed')
})
const recapTitle = computed(() => {
  const names = recapNodes.value.map(node => labelFor(node.role)).filter(Boolean)
  const parts = []
  if (props.state?.taskNumber !== '' && props.state?.taskNumber != null) parts.push(`#${props.state.taskNumber}`)
  if (props.state?.taskLabel) parts.push(props.state.taskLabel)
  if (names.length) parts.push(names.join(' → '))
  return parts.join(' · ')
})

function replyFor(role) {
  return (props.state?.replies || []).find(reply => reply.roleId === role?.id) || null
}

function labelFor(role) {
  return role?.display_name || role?.id || ''
}

function hasPortrait(role) {
  return Boolean(role?.provider || role?.portrait)
}

function portraitFor(role) {
  return rolePortrait(role?.portrait || role?.provider)
}

function glowFor(role) {
  return portraitGlow(role?.portrait || role?.provider)
}

function chipStyle(role) {
  return { '--chip-tint': glowFor(role) }
}

function chipTitle(role) {
  const base = `${labelFor(role)} · ${role?.provider_label || role?.provider || ''}`
  if (role?.availability_note) return `${base} · ${role.availability_note}`
  return role?.can_speak === false ? `${base} · ${t('room.cannotSpeak')}` : base
}

function chipAria(role) {
  return `${t('room.configureRole')}: ${labelFor(role)}`
}

function initialFor(role) {
  return labelFor(role).slice(0, 1)
}

function selectRole(role) {
  if (role?.id) emit('select-role', role.id)
}

function elapsed(value) {
  const started = new Date(value || '').getTime()
  if (Number.isNaN(started) || !started) return ''
  const total = Math.max(0, Math.floor((now.value - started) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function relativeAge(value) {
  const at = new Date(value || '').getTime()
  if (Number.isNaN(at) || !at) return ''
  const minutes = Math.max(0, Math.floor((now.value - at) / 60000))
  if (minutes < 1) return t('room.relay.justNow')
  if (minutes < 60) return t('room.relay.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('room.relay.hoursAgo', { count: hours })
  return t('room.relay.daysAgo', { count: Math.floor(hours / 24) })
}

function nodeStatusLabel(node) {
  if (node.state === 'active') {
    if (node.status === 'queued') return t('room.status.queued')
    if (node.status === 'starting') return t('room.status.starting')
    if (node.status === 'replying') return t('room.relay.replying')
    return t('room.relay.working')
  }
  if (node.state === 'done') return t('room.relay.completed')
  if (node.state === 'attention') return t('room.relay.needsAttention')
  if (node.role?.unavailable) return t('room.unavailable')
  return t('room.relay.waiting')
}

function nodeTimer(node) {
  if (node.state !== 'active') return ''
  if (!node.since || node.status === 'queued') return ''
  return elapsed(node.since)
}

function nodeTitle(node) {
  return `${labelFor(node.role)} · ${nodeStatusLabel(node)}`
}
</script>

<style scoped>
.room-cast {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 44px;
  display: flex;
  align-items: center;
}

.room-cast-row {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
}

.room-agent-strip {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.room-agent-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  padding: 2px 8px 2px 2px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.room-agent-chip:hover,
.room-agent-chip:focus-visible {
  outline: none;
  background: rgb(255 255 255 / 0.06);
}

.room-chip-face {
  position: relative;
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  display: grid;
}

.room-chip-photo {
  display: grid;
  overflow: hidden;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--chip-tint, var(--accent)) 15%, transparent);
  transition: box-shadow 0.2s ease;
}

.room-chip-photo img {
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  object-fit: cover;
  object-position: center 12%;
  transform: scale(1.55);
}

.room-agent-chip[data-speaking="true"] .room-chip-photo {
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--chip-tint, var(--accent)) 82%, white),
    0 0 14px color-mix(in srgb, var(--chip-tint, var(--accent)) 42%, transparent);
  animation: room-chip-breathe 2.4s ease-in-out infinite;
}

.room-agent-chip[data-quiet="true"] .room-chip-photo {
  opacity: 0.5;
}

.room-captain-mark {
  position: absolute;
  right: -3px;
  bottom: -3px;
  z-index: 2;
  width: 11px;
  height: 11px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #2a1c12;
  color: #ff8a3d;
  font-size: 8px;
  line-height: 1;
}

.room-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-agent-mute {
  flex: 0 0 auto;
  font-size: 11px;
  line-height: 1;
  opacity: 0.8;
}

.room-chip-live {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent-text);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.room-chip-live-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: room-dot-breathe 1.7s ease-in-out infinite;
}

.room-agent-idle {
  flex: 1 1 auto;
  color: var(--faint);
  font-size: var(--text-xs);
}

.room-agent-add {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 1px dashed var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.room-agent-add svg {
  width: 15px;
  height: 15px;
}

.room-agent-add:hover,
.room-agent-add:focus-visible {
  outline: none;
  border-color: var(--accent);
  color: var(--accent);
}

.room-agent-add:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.room-agent-add-inline {
  width: 26px;
  height: 26px;
  flex-basis: 26px;
  margin-left: 2px;
}

.room-cast-warning {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  padding: 3px 9px;
  border: 1px solid color-mix(in srgb, var(--warning) 55%, var(--border));
  border-radius: 999px;
  background: var(--warning-soft);
  color: var(--warning);
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.room-cast-warning:hover,
.room-cast-warning:focus-visible {
  outline: none;
  border-color: var(--warning);
  background: color-mix(in srgb, var(--warning) 16%, var(--surface));
}

.room-relay {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.room-relay-task {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  line-height: 1.4;
}

.room-relay-chain {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
}

.room-relay-link {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  color: var(--faint);
}

.room-relay-thread {
  width: 12px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--border-strong));
}

.room-relay-chevron {
  width: 11px;
  height: 11px;
  opacity: 0.5;
}

.room-relay-node {
  --agent-glow: var(--accent);
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 190px;
  padding: 2px 8px 2px 2px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.16s ease, opacity 0.16s ease;
}

.room-relay-node:hover,
.room-relay-node:focus-visible {
  outline: none;
  background: rgb(255 255 255 / 0.06);
}

.room-relay-face {
  position: relative;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: grid;
  border-radius: 50%;
}

.room-relay-portrait {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: #1b2124;
  object-fit: cover;
  object-position: center 12%;
}

.room-relay-initial {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: var(--surface-active);
  color: var(--text-soft);
  font-size: var(--text-xs);
  font-weight: 600;
}

.room-relay-node[data-state="waiting"] {
  opacity: 0.72;
}

.room-relay-node[data-state="waiting"] .room-relay-portrait {
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.room-relay-node[data-state="done"] .room-relay-portrait {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--border-strong) 80%, transparent);
}

.room-relay-node[data-state="active"] .room-relay-portrait {
  box-shadow:
    0 0 0 1.5px color-mix(in srgb, var(--agent-glow) 85%, white),
    0 0 16px color-mix(in srgb, var(--agent-glow) 38%, transparent);
}

.room-relay-node[data-state="active"] .room-relay-face::after {
  content: "";
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    transparent 0deg 230deg,
    color-mix(in srgb, var(--agent-glow) 72%, transparent) 320deg,
    transparent 360deg
  );
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1px));
  animation: room-relay-aura 3.4s linear infinite;
  pointer-events: none;
}

.room-relay-baton {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--agent-glow) 70%, transparent);
  opacity: 0;
  animation: room-baton-pass 0.42s ease-out;
  pointer-events: none;
}

.room-relay-stamp {
  position: absolute;
  right: -3px;
  bottom: -2px;
  z-index: 3;
  width: 14px;
  height: 14px;
  display: grid;
  place-items: center;
  border: 1.5px solid var(--surface);
  border-radius: 50%;
  background: #1b2124;
  color: var(--text-soft);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  animation: room-stamp-in 0.26s ease-out;
}

.room-relay-stamp.attention {
  color: var(--warning);
}

.room-relay-face .room-captain-mark {
  top: -3px;
  right: auto;
  bottom: auto;
  left: -3px;
}

.room-relay-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.room-relay-copy strong {
  overflow: hidden;
  color: var(--text-soft);
  font-size: var(--text-xs);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-relay-copy small {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--faint);
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
}

.room-relay-node[data-state="active"] .room-relay-copy strong {
  color: var(--text);
}

.room-relay-node[data-state="active"] .room-relay-copy small {
  color: var(--accent-text);
}

.room-relay-pulse {
  width: 5px;
  height: 5px;
  flex: 0 0 5px;
  border-radius: 50%;
  background: currentColor;
  animation: room-dot-breathe 1.6s ease-in-out infinite;
}

.room-relay-timer {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}

.room-relay-extra {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--surface-active);
  color: var(--faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.room-recap-pill {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 9px 3px 4px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-raised) 70%, transparent);
  color: var(--text-soft);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease, color 0.16s ease;
}

.room-recap-pill:hover,
.room-recap-pill:focus-visible {
  outline: none;
  border-color: var(--border-strong);
  background: var(--surface-hover);
  color: var(--text);
}

.room-recap-faces {
  display: inline-flex;
  align-items: center;
}

.room-recap-faces img {
  width: 18px;
  height: 18px;
  margin-left: -6px;
  border: 1.5px solid var(--surface);
  border-radius: 50%;
  background: #1b2124;
  object-fit: cover;
  object-position: center 12%;
}

.room-recap-faces img:first-child {
  margin-left: 0;
}

.room-recap-more {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  margin-left: -6px;
  border: 1.5px solid var(--surface);
  border-radius: 50%;
  background: #3a3b40;
  color: var(--text-soft);
  font-size: 9px;
  font-weight: 600;
}

.room-recap-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--success);
}

.room-recap-dot[data-tone="review"] {
  background: var(--warning);
}

.room-recap-dot[data-tone="attention"] {
  background: var(--danger, #f97066);
}

.room-recap-text {
  font-weight: 600;
  white-space: nowrap;
}

.room-recap-age {
  color: var(--faint);
  white-space: nowrap;
}

.room-cast-swap-enter-active,
.room-cast-swap-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.room-cast-swap-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.room-cast-swap-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@keyframes room-chip-breathe {
  0%, 100% {
    box-shadow:
      0 0 0 1.5px color-mix(in srgb, var(--chip-tint, var(--accent)) 82%, white),
      0 0 12px color-mix(in srgb, var(--chip-tint, var(--accent)) 32%, transparent);
  }
  50% {
    box-shadow:
      0 0 0 1.5px color-mix(in srgb, var(--chip-tint, var(--accent)) 92%, white),
      0 0 20px color-mix(in srgb, var(--chip-tint, var(--accent)) 52%, transparent);
  }
}

@keyframes room-dot-breathe {
  0%, 100% { opacity: 0.55; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1.15); }
}

@keyframes room-relay-aura {
  to { transform: rotate(360deg); }
}

@keyframes room-baton-pass {
  0% { opacity: 0; transform: scale(0.72); }
  35% { opacity: 0.9; }
  100% { opacity: 0; transform: scale(1.35); }
}

@keyframes room-stamp-in {
  0% { opacity: 0; transform: scale(0.4); }
  55% { opacity: 1; transform: scale(1.12); }
  100% { opacity: 1; transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .room-agent-chip[data-speaking="true"] .room-chip-photo,
  .room-chip-live-dot,
  .room-relay-node[data-state="active"] .room-relay-face::after,
  .room-relay-baton,
  .room-relay-stamp,
  .room-relay-pulse {
    animation: none;
  }

  .room-cast-swap-enter-active,
  .room-cast-swap-leave-active {
    transition: none;
  }
}

@media (max-width: 950px) {
  .room-cast {
    min-height: 40px;
  }

  .room-recap-pill {
    margin-left: 0;
  }

  .room-relay-chain {
    width: 100%;
  }
}
</style>
