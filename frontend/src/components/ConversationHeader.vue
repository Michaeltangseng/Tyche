<template>
  <header class="conversation-header" :class="{ 'editing-title': inlineTitleEditing }">
    <div
      class="conversation-identity"
      :class="{ 'has-team': activeGroup.projectId && activeGroup.projectRole === 'main' }"
    >
      <div v-if="activeGroup.conversationType === 'direct'" class="conversation-avatar single">
        <img :src="agentLogo(activeGroup.directAgentKind, theme)" alt="" />
      </div>
      <div v-else-if="!activeGroup.projectId" class="conversation-avatar stack">
        <img
          v-for="kind in activeGroup.agentKinds.slice(0, 3)"
          :key="kind"
          :src="agentLogo(kind, theme)"
          alt=""
        />
      </div>
      <div ref="titleBlock" class="conversation-title-block" tabindex="-1">
        <form v-if="inlineTitleEditing" class="inline-title-form" @submit.prevent="saveInlineTitle">
          <input
            ref="titleInput"
            v-model="inlineTitleDraft"
            :aria-label="t('settings.conversationName')"
            :placeholder="groupName(activeGroup)"
            :disabled="saving"
            maxlength="60"
            @keydown.esc.stop.prevent="cancelInlineTitleEdit"
          />
          <button
            type="submit"
            :title="t('common.save')"
            :aria-label="t('common.save')"
            :disabled="saving"
          >
            <CheckmarkCircleOutline />
          </button>
          <button
            type="button"
            :title="t('common.cancel')"
            :aria-label="t('common.cancel')"
            :disabled="saving"
            @click="cancelInlineTitleEdit"
          >
            <CloseOutline />
          </button>
        </form>
        <h1 v-else>
          <button
            ref="titleButton"
            class="conversation-title-button"
            type="button"
            :title="t('conversation.renameTitle')"
            :aria-label="t('conversation.renameTitle')"
            :disabled="saving"
            @click="beginInlineTitleEdit"
          >
            <span>{{ groupName(activeGroup) }}</span>
            <PencilOutline />
          </button>
        </h1>
        <p v-if="activeGroup.projectId && activeGroup.projectRole === 'main'" class="conversation-capabilities">
          <span>{{ conversationPermissionLabel(activeGroup) }}</span>
        </p>
        <p v-else class="conversation-capabilities">
          <span>{{ activeGroup.conversationType === 'direct' ? t('conversation.direct') : t('conversation.members', { count: activeGroup.agentKinds.length }) }}</span>
          <span class="meta-separator">/</span>
          <span>{{ conversationPermissionLabel(activeGroup) }}</span>
          <template v-if="activeDirectAgent">
            <template v-if="activeDirectAgent.ready">
              <span class="meta-separator">/</span>
              <span>{{ agentSkillLabel(activeDirectAgent.kind) }}</span>
            </template>
            <span class="meta-separator">/</span>
            <span>{{ agentImageLabel(activeDirectAgent) }}</span>
          </template>
        </p>
      </div>
      <div v-if="activeGroup.projectId && activeGroup.projectRole === 'main'" class="project-team-strip">
        <button
          v-for="seat in projectSeats"
          :key="seat.id"
          class="project-team-member"
          type="button"
          :title="`${seat.roleName || seat.id} · ${agentLabel(seat.agentKind)}`"
          :aria-label="`${seat.roleName || seat.id} · ${agentLabel(seat.agentKind)}`"
          @click="openSeatSettings(seat.id)"
        >
          <img :src="agentLogo(seat.agentKind, theme)" :alt="agentLabel(seat.agentKind)" />
          <span>{{ seat.roleName || seat.id }}</span>
        </button>
        <button
          class="project-team-add"
          type="button"
          :title="t('projectRoom.seats.add')"
          :aria-label="t('projectRoom.seats.add')"
          @click="openSeatSettings('')"
        >
          <AddOutline />
        </button>
      </div>
    </div>
    <div class="conversation-header-actions">
      <button
        v-if="activeGroup.projectId && activeGroup.projectRole === 'main'"
        class="icon-button"
        type="button"
        :title="t('projectRoom.drawer.open')"
        :aria-label="t('projectRoom.drawer.open')"
        :aria-pressed="projectDrawerOpen ? 'true' : 'false'"
        @click="toggleProjectDrawer"
      >
        <DocumentsOutline />
      </button>
    </div>
  </header>
</template>

<script setup>
import { ref } from 'vue'
import {
  AddOutline,
  CheckmarkCircleOutline,
  CloseOutline,
  DocumentsOutline,
  PencilOutline,
} from '@vicons/ionicons5'
import { agentLabel, agentLogo } from '../catalog.js'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  activeDirectAgent,
  activeGroup,
  agentImageLabel,
  agentSkillLabel,
  beginInlineTitleEdit,
  cancelInlineTitleEdit,
  conversationPermissionLabel,
  groupName,
  inlineTitleDraft,
  inlineTitleEditing,
  openSeatSettings,
  projectDrawerOpen,
  projectSeats,
  saveInlineTitle,
  saving,
  t,
  theme,
  toggleProjectDrawer,
} = props.controller

const titleBlock = ref(null)
const titleInput = ref(null)
const titleButton = ref(null)
function focusTitleBlock() {
  titleBlock.value?.focus?.()
}

function focusTitleInput() {
  titleInput.value?.focus?.()
  titleInput.value?.select?.()
}

function focusTitleButton() {
  titleButton.value?.focus?.()
}

defineExpose({
  focusTitleBlock,
  focusTitleButton,
  focusTitleInput,
})
</script>
