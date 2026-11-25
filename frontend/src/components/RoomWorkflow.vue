<template>
  <div class="room-flow" role="tree" :aria-label="t('room.workTab.trace')">
    <RoomWorkflowNode
      v-for="root in roots"
      :key="root.id"
      :node="root"
      :workflow="workflow"
      :roles="roles"
      @select="emit('select', $event)"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { t } from '../i18n.js'
import RoomWorkflowNode from './RoomWorkflowNode.vue'

const props = defineProps({
  workflow: { type: Object, required: true },
  roles: { type: Array, default: () => [] },
})
const emit = defineEmits(['select'])

const roots = computed(() => {
  const targeted = new Set((props.workflow.edges || []).map(edge => edge.to))
  return (props.workflow.nodes || []).filter(node => !targeted.has(node.id))
})
</script>

<style scoped>
.room-flow {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: flex-start;
  width: max-content;
  min-width: 100%;
  gap: 8px 0;
  margin: 8px auto 0;
}
</style>
