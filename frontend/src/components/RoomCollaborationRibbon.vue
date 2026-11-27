<template>
  <div class="room-cast" :data-mode="state.mode" :aria-label="ariaLabel">
    <div ref="castRow" class="room-cast-row">
      <div ref="memberHost" class="room-member-cluster">
        <button
          v-for="role in roles"
          v-show="shownIds.has(role.id)"
          :key="role.id"
          class="room-agent-chip"
          type="button"
          data-member-chip
          :data-role-id="role.id"
          :data-speaking="replyFor(role) ? 'true' : undefined"
          :data-quiet="role.can_speak === false ? 'true' : undefined"
          :style="chipStyle(role)"
          :title="chipTitle(role)"
          :aria-label="chipAria(role)"
          @click="selectRole(role)"
        >
          <span v-if="role.provider" class="room-chip-face">
            <span class="room-chip-photo">
              <RoomMascot :mascot="roleFace(role)" />
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
        <div v-if="hiddenRoles.length" class="room-member-more-anchor">
          <button
            ref="memberMore"
            class="room-member-more"
            type="button"
            data-member-more
            :aria-expanded="membersOpen ? 'true' : 'false'"
            aria-haspopup="dialog"
            :aria-label="t('room.moreMembers', { count: hiddenRoles.length })"
            @click.stop="membersOpen = !membersOpen"
          >+{{ hiddenRoles.length }}</button>
          <div
            v-if="membersOpen"
            ref="memberPopover"
            class="room-member-popover"
            role="dialog"
            :aria-label="t('room.moreMembers', { count: hiddenRoles.length })"
            @keydown.esc.prevent.stop="membersOpen = false"
          >
            <button
              v-for="role in hiddenRoles"
              :key="role.id"
              class="room-member-popover-row"
              type="button"
              @click="pickHidden(role)"
            >
              <span class="room-chip-face">
                <span class="room-chip-photo">
                  <RoomMascot :mascot="roleFace(role)" />
                </span>
              </span>
              <span>{{ labelFor(role) }}</span>
            </button>
          </div>
        </div>
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
      </div>
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
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue'
import { AddOutline } from '@vicons/ionicons5'
import { t } from '../i18n.js'
import {
  MEMBER_ADD_WIDTH,
  MEMBER_GAP,
  MEMBER_MORE_WIDTH,
  MEMBER_STRIP_RATIO,
  fitMemberCount,
} from '../memberStrip.js'
import { portraitGlow } from '../role-portraits.js'
import { roleFace } from '../room-mascots.js'
import RoomMascot from './RoomMascot.vue'

const props = defineProps({
  state: {
    type: Object,
    default: () => ({ mode: 'idle', nodes: [], replies: [] }),
  },
  roles: { type: Array, default: () => [] },
  busy: { type: Boolean, default: false },
  canAdd: { type: Boolean, default: true },
})
const emit = defineEmits(['select-role', 'add-role'])

const now = ref(Date.now())
const castRow = ref(null)
const memberHost = ref(null)
const memberMore = ref(null)
const memberPopover = ref(null)
const membersOpen = ref(false)
const visibleCount = ref(Number.POSITIVE_INFINITY)
const widthCache = new Map()
let clock = null
let resizeObserver = null

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

const shownIds = computed(() => new Set(props.roles.slice(0, visibleCount.value).map(role => role.id)))
const hiddenRoles = computed(() => props.roles.slice(Math.min(visibleCount.value, props.roles.length)))
const unavailableRoles = computed(() => props.roles.filter(role => role?.unavailable === true))
const unavailableTitle = computed(() => (
  unavailableRoles.value.length
    ? `${unavailableRoles.value.map(role => labelFor(role)).join(', ')} · ${t('room.agentUnavailable')}`
    : ''
))
const addDisabled = computed(() => props.busy || !props.canAdd)
const ariaLabel = computed(() => (
  props.state?.mode === 'running'
    ? t('room.relay.label')
    : t('room.members', { count: props.roles.length })
))
watch(hiddenRoles, (hidden) => {
  if (!hidden.length) membersOpen.value = false
})

function measured(node, attribute, natural) {
  const marked = Number(node?.getAttribute?.(attribute))
  return marked > 0 ? marked : natural
}

function measureMembers() {
  const row = castRow.value
  const host = memberHost.value
  if (!row || !host) return
  const chips = [...host.querySelectorAll('[data-member-chip]')]
  for (const chip of chips) {
    const id = chip.dataset.roleId
    const width = measured(chip, 'data-measure-width', chip.offsetWidth)
    if (id && width > 0) widthCache.set(id, width)
  }
  const widths = props.roles.map(role => widthCache.get(role.id) || 0)
  const reserved = [...row.querySelectorAll('.room-cast-warning')]
    .reduce((total, node) => total + measured(node, 'data-measure-width', node.offsetWidth) + MEMBER_GAP, 0)
  const rowWidth = measured(row, 'data-measure-client', row.clientWidth)
  const available = rowWidth > 0 ? rowWidth - reserved : 0
  const cap = available > 0 ? Math.min(rowWidth * MEMBER_STRIP_RATIO, available) : 0
  const budget = cap - MEMBER_ADD_WIDTH - MEMBER_GAP
  const next = !cap || widths.some(width => !width)
    ? props.roles.length
    : fitMemberCount(widths, budget, MEMBER_MORE_WIDTH, MEMBER_GAP)
  if (next !== visibleCount.value) visibleCount.value = next
}

function closeOpenMenus(event) {
  if (event.key !== 'Escape' || !membersOpen.value) return
  event.preventDefault()
  event.stopPropagation()
  membersOpen.value = false
}

function onMembersPointer(event) {
  const target = event.target
  if (membersOpen.value && !memberPopover.value?.contains(target) && !memberMore.value?.contains(target)) {
    membersOpen.value = false
  }
}

watch(membersOpen, (open) => {
  if (!open) return
  nextTick(() => memberPopover.value?.querySelector('button')?.focus())
})

onMounted(() => {
  window.addEventListener('keydown', closeOpenMenus)
  window.addEventListener('pointerdown', onMembersPointer)
  if (typeof ResizeObserver === 'function' && castRow.value) {
    resizeObserver = new ResizeObserver(() => measureMembers())
    resizeObserver.observe(castRow.value)
  }
  measureMembers()
})

onUpdated(() => {
  measureMembers()
})

onBeforeUnmount(() => {
  stopClock()
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', closeOpenMenus)
  window.removeEventListener('pointerdown', onMembersPointer)
})

function replyFor(role) {
  return (props.state?.replies || []).find(reply => reply.roleId === role?.id) || null
}

function labelFor(role) {
  return role?.display_name || role?.id || ''
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

function selectRole(role) {
  if (role?.id) emit('select-role', role.id)
}

function pickHidden(role) {
  membersOpen.value = false
  selectRole(role)
}

function elapsed(value) {
  const started = new Date(value || '').getTime()
  if (Number.isNaN(started) || !started) return ''
  const total = Math.max(0, Math.floor((now.value - started) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
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
  gap: 8px;
}

.room-member-cluster {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 70%;
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
  overflow: visible;
  width: 26px;
  height: 26px;
  border-radius: 0;
  background: transparent;
  transition: box-shadow 0.2s ease;
}

.room-chip-photo :deep(.room-mascot-art) {
  width: 100%;
  height: 100%;
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

.room-member-more-anchor {
  position: relative;
  flex: 0 0 auto;
}

.room-member-more {
  flex: 0 0 auto;
  min-width: 28px;
  height: 28px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-active);
  color: var(--text-soft);
  font: inherit;
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}

.room-member-more:hover,
.room-member-more:focus-visible {
  outline: none;
  border-color: var(--border-strong);
  color: var(--text);
}

.room-member-popover {
  position: absolute;
  z-index: 6;
  top: calc(100% + 6px);
  right: 0;
  display: grid;
  gap: 2px;
  min-width: 180px;
  max-width: 260px;
  max-height: 280px;
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-raised);
  box-shadow: 0 16px 40px rgb(0 0 0 / 0.35);
}

.room-member-popover-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 8px 4px 4px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--text-xs);
  text-align: left;
  cursor: pointer;
}

.room-member-popover-row:hover,
.room-member-popover-row:focus-visible {
  outline: none;
  background: rgb(255 255 255 / 0.06);
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

@media (prefers-reduced-motion: reduce) {
  .room-agent-chip[data-speaking="true"] .room-chip-photo,
  .room-chip-live-dot {
    animation: none;
  }
}

@media (max-width: 950px) {
  .room-cast {
    min-height: 40px;
  }
}
</style>
