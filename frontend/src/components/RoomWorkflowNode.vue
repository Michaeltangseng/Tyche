<template>
  <div class="room-flow-branch">
    <button
      class="room-flow-node"
      type="button"
      :data-live="node.live ? 'true' : undefined"
      :data-children="children.length ? 'true' : undefined"
      :disabled="!node.messageId"
      :aria-label="buttonLabel"
      :title="buttonLabel"
      @click="emit('select', node)"
    >
      <span class="room-flow-face">
        <RoomMascot :mascot="roleFace(role || { id: node.roleId })" />
      </span>
      <strong>{{ roleName }}</strong>
      <small v-if="!incomingLabel && node.title">{{ node.title }}</small>
    </button>
    <div v-if="childRows.length" class="room-flow-rows">
      <div
        v-for="(row, rowIndex) in childRows"
        :key="rowIndex"
        class="room-flow-kids"
        :data-single="row.length === 1 ? 'true' : undefined"
        :data-follow="rowIndex > 0 ? 'true' : undefined"
        :style="rowIndex > 0 ? { '--row-count': row.length } : undefined"
      >
        <div v-for="child in row" :key="child.id" class="room-flow-child">
          <span v-if="labelFor(child)" class="room-flow-label" :title="labelFor(child)">{{ labelFor(child) }}</span>
          <RoomWorkflowNode
            :node="child"
            :workflow="workflow"
            :roles="roles"
            @select="emit('select', $event)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { t } from '../i18n.js'
import { roleFace } from '../room-mascots.js'
import RoomMascot from './RoomMascot.vue'

const props = defineProps({
  node: { type: Object, required: true },
  workflow: { type: Object, required: true },
  roles: { type: Array, default: () => [] },
})
const emit = defineEmits(['select'])

const rolesById = computed(() => new Map(props.roles.map(role => [role.id, role])))
const role = computed(() => rolesById.value.get(props.node.roleId) || null)
const roleName = computed(() => role.value?.display_name || '')
const incomingLabel = computed(() => props.workflow.edges.find(edge => edge.to === props.node.id)?.label || '')
const children = computed(() => {
  const byId = new Map((props.workflow.nodes || []).map(node => [node.id, node]))
  return (props.workflow.edges || [])
    .filter(edge => edge.from === props.node.id)
    .map(edge => byId.get(edge.to))
    .filter(Boolean)
})
const childRows = computed(() => {
  const rows = []
  for (let index = 0; index < children.value.length; index += 3) {
    rows.push(children.value.slice(index, index + 3))
  }
  return rows
})

const buttonLabel = computed(() => {
  const name = roleName.value
  const title = props.node.title || props.node.label || ''
  const jump = name ? t('room.workflowJump', { name }) : t('room.workTab.trace')
  if (props.node.live && name && title) return `${t('room.workflowLive', { name, title })} · ${jump}`
  if (name && title) return `${t('room.workflowStep', { name, title })} · ${jump}`
  return jump
})

function labelFor(child) {
  return props.workflow.edges.find(edge => edge.to === child.id)?.label || child.label || ''
}
</script>

<style scoped>
.room-flow-branch {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 0 0 auto;
  min-width: 84px;
}

.room-flow-node {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.room-flow-node:disabled {
  cursor: default;
}

.room-flow-node strong {
  max-width: 88px;
  overflow: hidden;
  color: var(--text-soft);
  font-size: 11px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-flow-node small {
  max-width: 96px;
  overflow: hidden;
  color: var(--faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-flow-face {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-active) 78%, transparent);
  transition: width 180ms ease, height 180ms ease, box-shadow 180ms ease;
}

.room-flow-face :deep(.room-mascot-art) {
  width: 40px;
  height: 40px;
}

.room-flow-node:hover:not(:disabled) .room-flow-face,
.room-flow-node:focus-visible .room-flow-face {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
}

.room-flow-node[data-live="true"] .room-flow-face {
  width: 64px;
  height: 64px;
  box-shadow:
    0 0 0 2px var(--accent),
    0 0 18px color-mix(in srgb, var(--accent) 42%, transparent);
}

.room-flow-node[data-live="true"] .room-flow-face :deep(.room-mascot-art) {
  width: 56px;
  height: 56px;
}

.room-flow-node[data-live="true"] strong {
  color: var(--text);
}

.room-flow-node[data-children="true"] {
  margin-bottom: 14px;
}

.room-flow-node[data-children="true"]::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 100%;
  width: 1px;
  height: 14px;
  background: color-mix(in srgb, var(--text-soft) 42%, transparent);
}

.room-flow-rows {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.room-flow-kids {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-bottom: 8px;
}

.room-flow-kids[data-follow="true"] {
  position: relative;
  margin-top: 22px;
}

.room-flow-kids[data-follow="true"]::before {
  content: "";
  position: absolute;
  top: -14px;
  left: calc(100% / (var(--row-count) * 2));
  right: calc(100% / (var(--row-count) * 2));
  height: 14px;
  border: 1px solid color-mix(in srgb, var(--text-soft) 42%, transparent);
  border-bottom: 0;
  background: transparent;
}

.room-flow-kids[data-follow="true"][data-single="true"]::before {
  left: 50%;
  right: auto;
  width: 1px;
  border: 0;
  background: color-mix(in srgb, var(--text-soft) 42%, transparent);
}

.room-flow-child {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  min-width: 84px;
  padding: 22px 8px 0;
}

.room-flow-child::before,
.room-flow-child::after {
  content: "";
  position: absolute;
  background: color-mix(in srgb, var(--text-soft) 42%, transparent);
}

.room-flow-child::before {
  top: 0;
  left: 50%;
  width: 1px;
  height: 22px;
}

.room-flow-child::after {
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
}

.room-flow-child:first-child::after {
  left: 50%;
}

.room-flow-child:last-child::after {
  right: 50%;
}

.room-flow-kids[data-single="true"] .room-flow-child::after {
  display: none;
}

.room-flow-label {
  position: absolute;
  z-index: 1;
  top: 5px;
  left: 50%;
  max-width: calc(100% - 12px);
  padding: 0 4px;
  overflow: hidden;
  transform: translateX(-50%);
  background: var(--surface-raised);
  color: var(--faint);
  font-size: 10px;
  line-height: 1.3;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
</style>
