<template>
  <ol class="room-flow" :aria-label="t('room.workTab.trace')">
    <li
      v-for="(layer, index) in workflow.layers"
      :key="index"
      class="room-flow-layer"
      :data-branch="layer.length > 1 ? 'true' : undefined"
    >
      <div v-for="node in layer" :key="node.id" class="room-flow-step">
        <div v-if="index" class="room-flow-link" aria-hidden="true">
          <span class="room-flow-stem" />
          <span v-if="node.label" class="room-flow-label" :title="node.title || node.label">{{ node.label }}</span>
        </div>
        <div
          class="room-flow-node"
          :data-live="node.live ? 'true' : undefined"
          :aria-label="nodeLabel(node)"
        >
          <span class="room-flow-face">
            <RoomMascot :mascot="roomMascot(roleFor(node) || { id: node.roleId })" />
          </span>
          <strong>{{ roleName(node) }}</strong>
          <small v-if="!index && node.title">{{ node.title }}</small>
        </div>
      </div>
    </li>
  </ol>
</template>

<script setup>
import { computed } from 'vue'
import { t } from '../i18n.js'
import { roomMascot } from '../room-mascots.js'
import RoomMascot from './RoomMascot.vue'

const props = defineProps({
  workflow: { type: Object, required: true },
  roles: { type: Array, default: () => [] },
})

const rolesById = computed(() => new Map(props.roles.map(role => [role.id, role])))

function roleFor(node) {
  return rolesById.value.get(node?.roleId) || null
}

function roleName(node) {
  return roleFor(node)?.display_name || ''
}

function nodeLabel(node) {
  const name = roleName(node)
  const title = node?.title || node?.label || ''
  if (node?.live && name && title) return t('room.workflowLive', { name, title })
  if (name && title) return t('room.workflowStep', { name, title })
  return name || title
}
</script>

<style scoped>
.room-flow {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.room-flow-layer {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  gap: 18px;
  width: 100%;
}

.room-flow-layer[data-branch="true"] {
  position: relative;
}

.room-flow-layer[data-branch="true"]::before {
  content: "";
  position: absolute;
  top: 0;
  left: 22%;
  right: 22%;
  border-top: 1px solid var(--border-strong);
}

.room-flow-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 0;
  max-width: 112px;
}

.room-flow-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-height: 18px;
  margin-bottom: 4px;
}

.room-flow-stem {
  width: 1px;
  height: 16px;
  background: var(--border-strong);
}

.room-flow-label,
.room-flow-node small {
  max-width: 96px;
  overflow: hidden;
  color: var(--faint);
  font-size: 10px;
  line-height: 1.3;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-flow-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.room-flow-node strong {
  max-width: 96px;
  overflow: hidden;
  color: var(--text-soft);
  font-size: 11px;
  font-weight: 650;
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

.room-flow-node[data-live="true"] .room-flow-face {
  width: 68px;
  height: 68px;
  box-shadow:
    0 0 0 2px var(--accent),
    0 0 22px color-mix(in srgb, var(--accent) 48%, transparent);
}

.room-flow-node[data-live="true"] .room-flow-face :deep(.room-mascot-art) {
  width: 60px;
  height: 60px;
}

.room-flow-node[data-live="true"] strong {
  color: var(--text);
}
</style>
