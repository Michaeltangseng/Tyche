<template>
  <footer class="composer-zone project-room-composer-zone">
    <div class="project-target-bar">
      <span class="project-target-label">
        {{ t('projectRoom.composer.operating', { target: targetLabel }) }}
      </span>
      <span class="project-target-purpose">{{ targetPurposeLabel }}</span>
      <button
        v-if="otherGateCount"
        class="project-target-next"
        type="button"
        @click="selectNextGateTarget"
      >
        {{ t('projectRoom.composer.otherGates', { count: otherGateCount }) }}
      </button>
      <button class="project-target-chat" type="button" @click="openProjectChat">
        {{ t('projectRoom.composer.discuss') }}
      </button>
    </div>
    <div class="project-composer-box">
      <textarea
        v-model="draft"
        class="project-composer-input"
        :aria-label="t('projectRoom.composer.inputLabel')"
        :placeholder="targetHint"
        :disabled="!targetAvailable"
        rows="3"
        @keydown.meta.enter.prevent="send"
        @keydown.ctrl.enter.prevent="send"
      />
      <div class="project-composer-footer">
        <span v-if="sendErrorLabel" class="project-composer-error" role="alert">
          {{ sendErrorLabel }}
        </span>
        <button class="send-button" type="button" :disabled="!canSend" @click="send">
          {{ sendLabel }}
        </button>
      </div>
    </div>
  </footer>
</template>

<script setup>
const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  canSend,
  draft,
  openProjectChat,
  otherGateCount,
  selectNextGateTarget,
  sendErrorLabel,
  sendLabel,
  sendTargetText,
  targetAvailable,
  targetHint,
  targetLabel,
  targetPurposeLabel,
  t,
} = props.controller

function send() {
  if (!canSend.value) return
  void sendTargetText()
}
</script>
