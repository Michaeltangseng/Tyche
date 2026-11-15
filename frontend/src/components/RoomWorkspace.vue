<template>
  <section class="room-workspace">
    <header class="room-toolbar">
      <h1>{{ t('room.title') }}</h1>
      <select :value="roomId" :aria-label="t('room.project')" :disabled="busy" @change="openRoom($event.target.value)">
        <option v-if="!rooms.length" value="">{{ t('room.noProjects') }}</option>
        <option v-for="item in rooms" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select>
      <button class="secondary-button" :disabled="busy" @click="creating = !creating">{{ t('room.create') }}</button>
    </header>

    <form v-if="creating" class="room-create" @submit.prevent="create" @keydown.esc.stop="creating = false">
      <label>{{ t('room.name') }}<input v-model="name" maxlength="256" required /></label>
      <div class="room-directory">
        <button class="secondary-button" type="button" :disabled="busy || picking" @click="chooseDirectory">{{ t('room.chooseDirectory') }}</button>
        <span>{{ directory || t('room.noDirectory') }}</span>
      </div>
      <fieldset>
        <legend>{{ t('room.providers') }}</legend>
        <label v-for="agent in agents" :key="agent.kind" class="room-provider">
          <input v-model="providers" type="checkbox" :value="agent.kind" />{{ agent.label }}
        </label>
        <p v-if="!agents.length">{{ t('room.noProviders') }}</p>
      </fieldset>
      <p class="room-muted">{{ t('room.createHint') }}</p>
      <div class="room-actions">
        <button class="secondary-button" type="button" :disabled="busy" @click="creating = false">{{ t('common.cancel') }}</button>
        <button class="primary-button" :disabled="busy || picking || !name.trim() || !directory || !providers.length">{{ t('room.create') }}</button>
      </div>
    </form>

    <p v-if="error || pickerError" class="room-error" role="alert">{{ t('room.error') }} <button class="secondary-button" @click="reload">{{ t('room.refresh') }}</button></p>
    <template v-if="snapshot">
      <div class="room-chat-toolbar">
        <select v-model="chatId" :aria-label="t('room.chat')" :disabled="busy">
          <option v-for="item in snapshot.chats" :key="item.id" :value="item.id">{{ item.title }}</option>
        </select>
        <form class="room-new-chat" @submit.prevent="newChat">
          <input v-model="chatTitle" :placeholder="t('room.chatName')" :aria-label="t('room.chatName')" maxlength="256" />
          <button class="secondary-button" :disabled="busy || !chatTitle.trim()">{{ t('room.newChat') }}</button>
        </form>
      </div>
      <div class="room-permissions">
        <label><input type="checkbox" :checked="Boolean(snapshot.room.write_authorized_root)" :disabled="busy || permissionBusy" @change="command({ type: 'set_workspace_write', allowWrite: $event.target.checked })" />{{ t('room.allowWrite') }}</label>
        <span class="room-muted">{{ t('room.writeHint') }}</span>
        <button class="secondary-button" :disabled="busy || !chat" @click="command({ type: chat.status === 'paused' ? 'resume_chat' : 'pause_chat' })">{{ t(chat?.status === 'paused' ? 'room.resume' : 'room.pause') }}</button>
      </div>

      <div class="room-body">
        <section class="room-conversation" :aria-label="t('room.chat')">
          <div ref="timeline" class="room-timeline">
            <p class="room-muted">{{ t('room.teamHint') }}</p>
            <div class="room-team">
              <details v-for="role in roles" :key="role.id" class="room-role">
                <summary>{{ role.display_name }} · {{ role.provider }}</summary>
                <p v-if="role.responsibilities" class="room-muted">{{ role.responsibilities }}</p>
                <p v-if="role.current_prompt" class="room-role-prompt">{{ role.current_prompt }}</p>
                <p v-else class="room-muted">{{ t('room.noRolePrompt') }}</p>
                <form class="room-role-editor" @submit.prevent="saveRolePrompt(role)">
                  <textarea v-model="rolePrompts[role.id]" :aria-label="t('room.rolePrompt')" rows="3" maxlength="100000" />
                  <button class="secondary-button" :disabled="busy || rolePrompts[role.id] === (role.current_prompt || '')">{{ t('room.saveRolePrompt') }}</button>
                </form>
              </details>
            </div>
            <p v-if="!entries.length" class="room-muted">{{ t('room.emptyChat') }}</p>
            <article v-for="entry in entries" :key="entry.key" class="room-message" :class="{ 'room-report': entry.report }">
              <header><strong>{{ entry.author }}</strong><time>{{ formatTime(entry.createdAt) }}</time></header>
              <p>{{ entry.content }}</p>
              <ul v-if="entry.evidence?.length"><li v-for="(evidence, index) in entry.evidence" :key="index">{{ evidence }}</li></ul>
            </article>
          </div>
          <form class="room-composer" @submit.prevent="sendMessage">
            <textarea v-model="draft" :placeholder="t('room.messageHint')" :aria-label="t('room.message')" rows="3" maxlength="100000" :disabled="busy || !chat" />
            <button class="primary-button" :disabled="busy || !draft.trim() || !chat">{{ t('room.send') }}</button>
          </form>
        </section>

        <aside class="room-ledger">
          <p v-if="staleAssignmentIds.size" class="room-warning" role="alert">{{ t('room.staleWarning', { count: staleAssignmentIds.size }) }}</p>
          <h2>{{ t('room.attentions', { count: attentions.length }) }}</h2>
          <p v-if="!attentions.length" class="room-muted">{{ t('room.noAttention') }}</p>
          <article v-for="attention in attentions" :key="attention.id" class="room-card">
            <p>{{ attention.question }}</p>
            <form @submit.prevent="answer(attention)">
              <select v-if="attention.options_json?.length" v-model="answers[attention.id]" :aria-label="attention.question" required>
                <option disabled value="">{{ t('room.chooseAnswer') }}</option>
                <option v-for="option in attention.options_json" :key="optionId(option)" :value="optionId(option)">{{ typeof option === 'string' ? option : option.label }}</option>
              </select>
              <input v-else v-model="answers[attention.id]" :aria-label="attention.question" :placeholder="t('room.answer')" required />
              <button class="secondary-button" :disabled="busy || !answers[attention.id]">{{ t('room.submit') }}</button>
            </form>
          </article>
          <h2>{{ t('room.tasks') }}</h2>
          <p v-if="!tasks.length" class="room-muted">{{ t('room.noTasks') }}</p>
          <article v-for="task in tasks" :key="task.id" class="room-card">
            <header><strong>{{ task.objective }}</strong><span>{{ statusLabel(task.status) }}</span></header>
            <button v-if="!['cancelled', 'done'].includes(task.status)" class="secondary-button" :disabled="busy" @click="command({ type: 'stop_task', taskId: task.id })">{{ t('room.stop') }}</button>
            <div v-for="assignment in taskAssignments(task.id)" :key="assignment.id" class="room-assignment">
              <p>{{ roleName(assignment.role_id) }} · {{ statusLabel(assignment.status) }}<span v-if="assignment.outcome === 'unknown'"> · {{ t('room.exitUnknown') }}</span><span v-if="staleAssignmentIds.has(assignment.id)"> · {{ t('room.stale') }}</span></p>
              <p v-if="assignment.ended_reason" class="room-muted">{{ t('room.attemptEnded') }}</p>
              <details v-if="assignment.run_id" class="room-trace">
                <summary>{{ t('room.trace') }}</summary>
                <button class="secondary-button" type="button" :disabled="busy || traceBusy[assignment.id]" @click="loadTrace(assignment)">{{ t('room.loadTrace') }}</button>
                <p v-if="traceErrors[assignment.id]" class="room-error">{{ t('room.error') }}</p>
                <ol v-if="traceSteps[assignment.id]?.length" class="room-trace-list">
                  <li v-for="(step, index) in traceSteps[assignment.id]" :key="`${assignment.id}:${index}:${step.seq || ''}`">
                    <strong>{{ step.title || step.kind || t('room.trace') }}</strong>
                    <span v-if="step.detail || step.message">{{ step.detail || step.message }}</span>
                    <div v-for="(blob, field) in step.blobs || {}" :key="`${assignment.id}:${step.seq}:${field}`" class="room-trace-blob">
                      <button v-if="!traceBlobEof[`${assignment.id}:${step.seq}:${field}`]" class="secondary-button" type="button" :disabled="traceBlobBusy[`${assignment.id}:${step.seq}:${field}`]" @click="loadTraceBlob(assignment, step, field)">
                        {{ traceBlobOffsets[`${assignment.id}:${step.seq}:${field}`] ? t('room.moreTraceOutput') : t('room.showTraceOutput', { field }) }}
                      </button>
                      <pre v-if="traceBlobTexts[`${assignment.id}:${step.seq}:${field}`]">{{ traceBlobTexts[`${assignment.id}:${step.seq}:${field}`] }}</pre>
                    </div>
                  </li>
                </ol>
                <button v-if="traceHasMore[assignment.id]" class="secondary-button" type="button" :disabled="busy || traceBusy[assignment.id]" @click="loadTrace(assignment, true)">{{ t('room.moreTrace') }}</button>
                <p v-else-if="traceLoaded[assignment.id]" class="room-muted">{{ t('room.traceEmpty') }}</p>
              </details>
              <div v-if="canRetry(assignment)" class="room-actions">
                <button class="secondary-button" :disabled="busy" @click="command({ type: 'retry_task', taskId: task.id, assignmentId: assignment.id })">{{ t('room.retry') }}</button>
                <select v-model="handoffRoles[assignment.id]" :aria-label="t('room.handoffTo')">
                  <option value="">{{ t('room.handoffTo') }}</option>
                  <option v-for="role in roles.filter(item => item.status === 'active')" :key="role.id" :value="role.id">{{ role.display_name }}</option>
                </select>
                <button class="secondary-button" :disabled="busy || !handoffRoles[assignment.id]" @click="command({ type: 'handoff_task', taskId: task.id, assignmentId: assignment.id, roleId: handoffRoles[assignment.id] })">{{ t('room.handoff') }}</button>
              </div>
            </div>
          </article>
          <h2>{{ t('room.artifacts') }}</h2>
          <article v-for="artifact in snapshot.artifacts" :key="artifact.id" class="room-card">
            <strong>{{ artifact.path }}</strong><p>{{ artifact.version }} · {{ statusLabel(artifact.status) }}</p>
            <button class="secondary-button room-show-diff" type="button" @click="diffArtifactId = artifact.id">{{ t('room.diff') }}</button>
            <RoomArtifactDiff v-if="diffArtifactId === artifact.id" :key="`${roomId}:${artifact.id}`" :api="api" :room-id="roomId" :artifact="artifact" @close="diffArtifactId = ''" />
            <div v-if="artifact.status === 'published'" class="room-actions">
              <button class="secondary-button" :disabled="busy" @click="command({ type: 'accept_artifact', artifactId: artifact.id })">{{ t('room.accept') }}</button>
              <button class="secondary-button" :disabled="busy" @click="command({ type: 'reject_artifact', artifactId: artifact.id })">{{ t('room.reject') }}</button>
            </div>
          </article>
        </aside>
      </div>
    </template>
    <p v-else-if="!creating && !error" class="room-empty">{{ t('room.emptyProjects') }}</p>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { t } from '../i18n.js'
import { useRoomWorkspace } from '../composables/useRoomWorkspace.js'
import RoomArtifactDiff from './RoomArtifactDiff.vue'

const props = defineProps({ api: { type: Object, required: true }, pickDirectory: { type: Function, required: true }, agents: { type: Array, default: () => [] } })
const { rooms, snapshot, roomId, chatId, chat, tasks, assignments, roles, messages, reports, attentions, staleAssignments,
  busy, error, load, refresh, openRoom, createRoom, createChat, send, command } = useRoomWorkspace({ api: props.api })
const creating = ref(false)
const name = ref('')
const directory = ref('')
const providers = ref([])
const chatTitle = ref('')
const diffArtifactId = ref('')
const drafts = ref({})
const draft = computed({ get: () => drafts.value[chatId.value] || '', set: value => { drafts.value[chatId.value] = value } })
const answers = ref({})
const handoffRoles = ref({})
const rolePrompts = ref({})
const picking = ref(false)
const pickerError = ref(false)
const timeline = ref(null)
const permissionBusy = computed(() => snapshot.value?.assignments.some(item => item.status === 'running' || item.outcome === 'unknown'))
const staleAssignmentIds = computed(() => new Set(staleAssignments.value
  .filter(item => assignments.value.some(assignment => assignment.id === item.assignmentId))
  .map(item => item.assignmentId)))
const traceSteps = ref({})
const traceLoaded = ref({})
const traceBusy = ref({})
const traceErrors = ref({})
const traceCursors = ref({})
const traceHasMore = ref({})
const traceBlobTexts = ref({})
const traceBlobOffsets = ref({})
const traceBlobBusy = ref({})
const traceBlobEof = ref({})
const entries = computed(() => [
  ...messages.value.map(message => ({ key: message.id, author: message.author_type === 'user' ? t('room.you') : roleName(message.author_id), content: message.content, createdAt: message.created_at })),
  ...reports.value.map(report => ({ key: report.id, author: `${roleName(assignments.value.find(item => item.id === report.assignment_id)?.role_id)} · ${t('room.report')}`, content: report.summary, evidence: report.evidence_json, report: true, createdAt: report.created_at })),
].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))))

function roleName(id) { return roles.value.find(item => item.id === id)?.display_name || t('room.agent') }
function taskAssignments(id) { return assignments.value.filter(item => item.task_id === id) }
function canRetry(item) { return ['failed', 'waiting', 'blocked', 'cancelled'].includes(item.status) && item.outcome !== 'unknown' && !assignments.value.some(next => next.previous_assignment_id === item.id) }
function statusLabel(status) { const key = `room.status.${status}`; return t(key) === key ? t('room.status.waiting') : t(key) }
function optionId(option) { return typeof option === 'string' ? option : option.id || option.optionId }
function formatTime(value) { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
async function loadTrace(assignment, older = false) {
  traceBusy.value = { ...traceBusy.value, [assignment.id]: true }
  traceErrors.value = { ...traceErrors.value, [assignment.id]: false }
  try {
    const page = await props.api.assignmentTrace({ roomId: roomId.value, assignmentId: assignment.id, direction: 'backward', limit: 100, ...(older && traceCursors.value[assignment.id] ? { cursor: traceCursors.value[assignment.id] } : {}) })
    const previous = older ? (traceSteps.value[assignment.id] || []) : []
    traceSteps.value = { ...traceSteps.value, [assignment.id]: [...(page?.steps || []), ...previous] }
    traceCursors.value = { ...traceCursors.value, [assignment.id]: page?.cursor || '' }
    traceHasMore.value = { ...traceHasMore.value, [assignment.id]: Boolean(page?.hasMore) }
    traceLoaded.value = { ...traceLoaded.value, [assignment.id]: true }
  } catch { traceErrors.value = { ...traceErrors.value, [assignment.id]: true } }
  finally { traceBusy.value = { ...traceBusy.value, [assignment.id]: false } }
}
async function loadTraceBlob(assignment, step, field) {
  const key = `${assignment.id}:${step.seq}:${field}`
  const offset = traceBlobOffsets.value[key] || 0
  traceBlobBusy.value = { ...traceBlobBusy.value, [key]: true }
  try {
    const result = await props.api.assignmentTraceBlob({ roomId: roomId.value, assignmentId: assignment.id,
      blobId: step.blobs[field].blobId, offset, length: 256 * 1024 })
    traceBlobTexts.value = { ...traceBlobTexts.value, [key]: `${traceBlobTexts.value[key] || ''}${result?.text || ''}` }
    traceBlobOffsets.value = { ...traceBlobOffsets.value, [key]: offset + new TextEncoder().encode(result?.text || '').length }
    if (result?.eof) traceBlobEof.value = { ...traceBlobEof.value, [key]: true }
  } catch { traceErrors.value = { ...traceErrors.value, [assignment.id]: true } }
  finally { traceBlobBusy.value = { ...traceBlobBusy.value, [key]: false } }
}
async function saveRolePrompt(role) {
  const prompt = String(rolePrompts.value[role.id] || '')
  if (!prompt.trim()) return
  if (await command({ type: 'update_role_prompt', roleId: role.id, prompt })) rolePrompts.value[role.id] = prompt
}
async function reload() { await load(); await refresh() }
async function chooseDirectory() {
  picking.value = true
  pickerError.value = false
  try { const result = await props.pickDirectory(); if (result) directory.value = result }
  catch { pickerError.value = true }
  finally { picking.value = false }
}
async function create() {
  if (await createRoom({ name: name.value.trim(), workspace: directory.value, providers: providers.value })) creating.value = false
}
async function newChat() { if (await createChat(chatTitle.value.trim())) chatTitle.value = '' }
async function sendMessage() {
  const target = chatId.value
  const content = draft.value
  if (await send(content)) drafts.value[target] = ''
}
async function answer(attention) {
  await command({ type: 'answer_attention', attentionId: attention.id,
    ...(attention.options_json?.length ? { optionId: answers.value[attention.id] } : { comment: answers.value[attention.id] }) })
}
watch([roomId, chatId], () => { handoffRoles.value = {}; answers.value = {}; rolePrompts.value = {}; diffArtifactId.value = ''; traceSteps.value = {}; traceLoaded.value = {}; traceErrors.value = {}; traceCursors.value = {}; traceHasMore.value = {}; traceBlobTexts.value = {}; traceBlobOffsets.value = {}; traceBlobBusy.value = {}; traceBlobEof.value = {} })
watch(roles, items => {
  const next = { ...rolePrompts.value }
  for (const role of items) if (!(role.id in next)) next[role.id] = role.current_prompt || ''
  rolePrompts.value = next
}, { immediate: true })
watch(() => entries.value.length, async () => { await nextTick(); if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight })
onMounted(load)
</script>

<style scoped>
.room-workspace { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: auto; padding: 24px; gap: 16px; }
.room-toolbar, .room-chat-toolbar, .room-permissions, .room-actions, .room-new-chat { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
h1 { font-size: 20px; margin: 0 auto 0 0; } h2 { font-size: 14px; margin: 10px 0; }
input:not([type=checkbox]), select, textarea { border: 1px solid var(--border); background: var(--surface); color: inherit; border-radius: 8px; padding: 8px 10px; max-width: 100%; }
.room-create { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; }
.room-create label:not(.room-provider) { display: grid; gap: 6px; } .room-provider { display: inline-flex; align-items: center; gap: 6px; margin-right: 16px; }
fieldset { border: 1px solid var(--border); border-radius: 8px; } .room-directory { display: flex; gap: 12px; align-items: center; overflow-wrap: anywhere; }
.room-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 32%); gap: 20px; flex: 1; min-height: 300px; overflow: hidden; }
.room-conversation { display: flex; flex-direction: column; min-height: 0; } .room-timeline { overflow: auto; flex: 1; padding: 4px 12px 16px 0; }
.room-message, .room-card { border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-bottom: 12px; overflow-wrap: anywhere; }
.room-message header, .room-card header { display: flex; gap: 12px; justify-content: space-between; align-items: baseline; }
.room-message p { white-space: pre-wrap; line-height: 1.6; } time, .room-muted { font-size: 12px; opacity: .65; }
.room-team { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; } .room-role { border: 1px solid var(--border); border-radius: 10px; padding: 6px 9px; font-size: 12px; max-width: 100%; } .room-role summary { cursor: pointer; } .room-role-prompt { white-space: pre-wrap; line-height: 1.45; max-width: 42rem; } .room-role-editor { display: grid; gap: 6px; } .room-role-editor textarea { min-width: min(36rem, 75vw); max-width: 100%; resize: vertical; }
.room-composer { display: flex; align-items: end; gap: 10px; padding-top: 12px; } .room-composer textarea { flex: 1; resize: vertical; min-width: 0; }
.room-ledger { overflow: auto; min-height: 0; } .room-assignment { border-top: 1px solid var(--border); margin-top: 10px; font-size: 12px; }
.room-card form { display: flex; gap: 8px; flex-wrap: wrap; } .room-card select { min-width: 0; } .room-empty { margin: auto; opacity: .65; }
.room-error { color: var(--danger, #b94c4c); } .room-warning { color: var(--warning, #9a6700); border: 1px solid currentColor; border-radius: 8px; padding: 8px 10px; font-size: 12px; }
@media (max-width: 950px) { .room-body { display: flex; flex-direction: column; overflow: visible; } .room-conversation { min-height: 400px; } .room-timeline { max-height: 55vh; } .room-ledger { overflow: visible; } }
</style>
