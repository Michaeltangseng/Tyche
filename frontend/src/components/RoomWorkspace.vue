<template>
  <section class="room-workspace">
    <header class="room-toolbar room-header">
      <div class="room-heading">
        <button class="room-project-name" type="button" :aria-label="t('room.roomSettings')" @click="openSettings('room')">
          {{ projectLabel }}
        </button>
        <div class="room-title-row">
          <h1>{{ chat?.title || (snapshot ? t('room.chat') : t('room.title')) }}</h1>
          <div v-if="(snapshot?.chats?.length || 0) > 1" class="room-chat-toolbar">
            <select v-model="chatId" :aria-label="t('room.chat')" :disabled="busy">
              <option v-for="item in snapshot.chats" :key="item.id" :value="item.id">{{ item.title }}</option>
            </select>
          </div>
        </div>
        <span v-if="snapshot && workdirName" class="room-subtitle">{{ workdirName }}</span>
      </div>

      <div v-if="roles.length" class="room-agent-strip" :aria-label="t('room.members', { count: roles.length })">
        <button v-for="role in roles" :key="role.id" class="room-agent-chip" type="button" :title="`${roleLabel(role)} · ${providerLabel(role.provider)}`" :aria-label="`${t('room.configureRole')}: ${roleLabel(role)}`" @click="openRoleSettings(role.id)">
          <img v-if="role.provider" :src="agentLogo(role.provider)" alt="" />
          <span>{{ roleLabel(role) }}</span>
          <span v-if="isControllerSeat(role)" class="room-agent-badge">{{ t('room.controller') }}</span>
        </button>
      </div>
      <span v-else-if="snapshot" class="room-agent-idle">{{ t('room.teamIdle') }}</span>

      <div class="room-header-actions">
        <button v-if="attentions.length" class="room-notice-pill" type="button" @click="scrollToAttention">
          {{ t('room.attentions', { count: attentions.length }) }}
        </button>
        <button v-if="hasWork" class="secondary-button room-work-toggle" type="button" :aria-pressed="workPanelOpen" @click="workPanelOpen = !workPanelOpen">
          {{ t('room.workPanel') }} · {{ workCount }}
        </button>
        <button class="secondary-button room-settings-button" type="button" :aria-label="t('room.settings')" @click="openSettings('room')">
          {{ t('room.settings') }}
        </button>
        <button class="room-icon-button room-create-button" type="button" data-testid="room-create-open" :aria-label="t('room.create')" :disabled="busy" @click="startCreating">+</button>
      </div>
    </header>

    <p v-if="error || pickerError" class="room-error room-banner" role="alert">{{ t('room.error') }} <button class="secondary-button" @click="reload">{{ t('room.refresh') }}</button></p>
    <article v-if="chat?.controller_blocked" class="room-warning room-controller-blocked room-banner" role="alert">
      <span>{{ t('room.controllerBlocked') }}</span>
      <button class="secondary-button" :disabled="busy" @click="command({ type: 'resume_chat' })">{{ t('room.controllerRetry') }}</button>
    </article>
    <p v-if="staleAssignmentIds.size" class="room-warning room-banner" role="alert">{{ t('room.staleWarning', { count: staleAssignmentIds.size }) }}</p>

    <div v-if="!snapshot" class="room-landing">
      <div class="room-landing-inner">
        <h2>{{ t('room.emptyProjects') }}</h2>
        <p class="room-muted">{{ t('room.createHint') }}</p>
        <button class="primary-button" type="button" :disabled="busy" @click="startCreating">{{ t('room.create') }}</button>
      </div>
    </div>

    <div v-else class="room-body" :class="{ 'room-body-with-work': showWorkPanel }">
      <section class="room-conversation" :aria-label="t('room.chat')">
        <div ref="timeline" class="room-timeline">
          <div class="room-timeline-inner">
            <button v-if="hasOlderMessages" class="secondary-button room-load-older" type="button" :disabled="busy || loadingOlderMessages" @click="loadEarlierMessages">
              {{ loadingOlderMessages ? t('room.loadingOlder') : t('room.loadOlder') }}
            </button>
            <div v-if="!entries.length && !attentions.length && !hasWork" class="room-welcome">
              <h2>{{ t('room.emptyTitle') }}</h2>
              <p class="room-muted">{{ t('room.emptyHint') }}</p>
              <p v-if="!roles.length" class="room-muted">{{ t('room.teamHint') }}</p>
            </div>
            <article v-for="entry in entries" :key="entry.key" class="room-message" :class="{ 'room-message-user': entry.isUser, 'room-message-agent': !entry.isUser, 'room-report': entry.report }">
              <span v-if="!entry.isUser" class="room-message-avatar">
                <img v-if="entry.provider" :src="agentLogo(entry.provider)" alt="" />
                <span v-else>{{ entry.author.slice(0, 1) }}</span>
              </span>
              <div class="room-message-body">
                <header><strong>{{ entry.author }}</strong><time>{{ formatTime(entry.createdAt) }}</time></header>
                <p>{{ entry.content }}</p>
                <ul v-if="entry.evidence?.length"><li v-for="(evidence, index) in entry.evidence" :key="index">{{ evidence }}</li></ul>
                <div v-if="entry.artifacts?.length" class="room-message-artifacts">
                  <article v-for="artifact in entry.artifacts" :key="artifact.id" class="room-artifact-card">
                    <div class="room-artifact-head"><strong>{{ artifact.path }}</strong><span>{{ statusLabel(artifact.status) }}</span></div>
                    <p class="room-muted">{{ artifact.version }}</p>
                    <div class="room-actions">
                      <button class="secondary-button room-show-diff" type="button" @click="diffArtifactId = artifact.id">{{ t('room.diff') }}</button>
                      <button v-if="artifact.status === 'published'" class="secondary-button" :disabled="busy" @click="command({ type: 'accept_artifact', artifactId: artifact.id })">{{ t('room.accept') }}</button>
                      <button v-if="artifact.status === 'published'" class="secondary-button" :disabled="busy" @click="command({ type: 'reject_artifact', artifactId: artifact.id })">{{ t('room.reject') }}</button>
                    </div>
                    <RoomArtifactDiff v-if="diffArtifactId === artifact.id" :key="`${roomId}:${artifact.id}`" :api="api" :room-id="roomId" :artifact="artifact" @close="diffArtifactId = ''" />
                  </article>
                </div>
              </div>
              <span v-if="entry.isUser" class="room-message-avatar room-user-avatar" :aria-label="t('room.you')"><PersonOutline /></span>
            </article>
            <article v-for="live in liveEntries" :key="`live:${live.id}`" class="room-message room-message-agent room-live-message">
              <span class="room-message-avatar">
                <img v-if="live.provider" :src="agentLogo(live.provider)" alt="" />
                <span v-else>{{ live.author.slice(0, 1) }}</span>
              </span>
              <div class="room-message-body">
                <header><strong>{{ live.author }}</strong><span class="room-running-label">{{ t('room.status.running') }}</span></header>
                <p class="room-live-output" aria-live="polite">{{ live.content }}</p>
              </div>
            </article>
            <article v-for="attention in attentions" :key="attention.id" class="room-attention-card">
              <header><strong>{{ t('room.needsYou') }}</strong><span>{{ attention.type }}</span></header>
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
          </div>
        </div>
        <div class="room-composer-wrap">
          <form class="room-composer" @submit.prevent="sendMessage">
            <textarea v-model="draft" :placeholder="t('room.messageHint')" :aria-label="t('room.message')" rows="3" maxlength="100000" :disabled="busy || !chat" @keydown.enter.exact.prevent="sendMessage" />
            <button class="primary-button" :disabled="busy || !draft.trim() || !chat">{{ t('room.send') }}</button>
          </form>
        </div>
      </section>

      <aside v-if="showWorkPanel" class="room-ledger" :aria-label="t('room.workPanel')">
        <header class="room-ledger-header">
          <h2>{{ t('room.workPanel') }}</h2>
          <button class="secondary-button" type="button" @click="workPanelOpen = false">{{ t('common.close') }}</button>
        </header>
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
                <option v-for="role in roles.filter(item => item.status === 'active')" :key="role.id" :value="role.id">{{ roleLabel(role) }}</option>
              </select>
              <button class="secondary-button" :disabled="busy || !handoffRoles[assignment.id]" @click="command({ type: 'handoff_task', taskId: task.id, assignmentId: assignment.id, roleId: handoffRoles[assignment.id] })">{{ t('room.handoff') }}</button>
            </div>
          </div>
        </article>
        <template v-if="unlinkedArtifacts.length">
          <h2>{{ t('room.artifacts') }}</h2>
          <article v-for="artifact in unlinkedArtifacts" :key="artifact.id" class="room-card">
            <strong>{{ artifact.path }}</strong><p>{{ artifact.version }} · {{ statusLabel(artifact.status) }}</p>
            <button class="secondary-button room-show-diff" type="button" @click="diffArtifactId = artifact.id">{{ t('room.diff') }}</button>
            <RoomArtifactDiff v-if="diffArtifactId === artifact.id" :key="`${roomId}:${artifact.id}`" :api="api" :room-id="roomId" :artifact="artifact" @close="diffArtifactId = ''" />
            <div v-if="artifact.status === 'published'" class="room-actions">
              <button class="secondary-button" :disabled="busy" @click="command({ type: 'accept_artifact', artifactId: artifact.id })">{{ t('room.accept') }}</button>
              <button class="secondary-button" :disabled="busy" @click="command({ type: 'reject_artifact', artifactId: artifact.id })">{{ t('room.reject') }}</button>
            </div>
          </article>
        </template>
      </aside>
    </div>

    <div v-if="creating" class="room-modal-backdrop" @click.self="creating = false" @wheel.self.prevent>
      <form class="room-create room-modal" @submit.prevent="create" @keydown.esc.stop="creating = false">
        <header class="room-modal-header">
          <h2>{{ t('room.create') }}</h2>
          <button class="secondary-button" type="button" @click="creating = false">{{ t('common.close') }}</button>
        </header>
        <p v-if="error || pickerError" class="room-error" role="alert">{{ t('room.error') }} <button class="secondary-button" type="button" @click="reload">{{ t('room.refresh') }}</button></p>
        <label>{{ t('room.name') }}<input v-model="name" maxlength="256" required /></label>
        <div class="room-directory">
          <button class="secondary-button" type="button" :disabled="busy || picking" @click="chooseDirectory">{{ t('room.chooseDirectory') }}</button>
          <span>{{ directory || t('room.noDirectory') }}</span>
        </div>
        <p class="room-muted">{{ t('room.agentsAutoHint', { count: agents.length }) }}</p>
        <p v-if="!agents.length" class="room-error">{{ t('room.noProviders') }}</p>
        <p class="room-muted">{{ t('room.createHint') }}</p>
        <div class="room-actions">
          <button class="secondary-button" type="button" :disabled="busy" @click="creating = false">{{ t('common.cancel') }}</button>
          <button class="primary-button" :disabled="busy || picking || !name.trim() || !directory || !agents.length">{{ t('room.create') }}</button>
        </div>
      </form>
    </div>

    <div v-show="settingsOpen" class="room-modal-backdrop room-settings-backdrop" @click.self="closeSettings" @wheel.self.prevent>
      <aside ref="settingsRef" class="room-settings-modal" role="dialog" aria-modal="true" :aria-label="t('room.settings')" tabindex="-1" @keydown.esc.stop="closeSettings">
        <header class="room-settings-header">
          <div>
            <strong>{{ t('room.settings') }}</strong>
            <span v-if="snapshot">{{ snapshot.room.name }}</span>
          </div>
          <button class="secondary-button" type="button" @click="closeSettings">{{ t('common.close') }}</button>
        </header>
        <div class="room-settings-tabs" role="tablist">
          <button type="button" role="tab" :aria-selected="settingsTab === 'room'" :class="{ active: settingsTab === 'room' }" @click="settingsTab = 'room'">{{ t('room.roomSettings') }}</button>
          <button type="button" role="tab" :aria-selected="settingsTab === 'chat'" :class="{ active: settingsTab === 'chat' }" @click="settingsTab = 'chat'">{{ t('room.chatSettings') }}</button>
          <button type="button" role="tab" :aria-selected="settingsTab === 'team'" :class="{ active: settingsTab === 'team' }" @click="settingsTab = 'team'">{{ t('room.teamSettings') }}</button>
        </div>
        <div class="room-settings-body">
          <section v-show="settingsTab === 'room'" class="room-settings-section" :aria-hidden="settingsTab !== 'room'">
            <div v-if="snapshot" class="room-overview" :aria-label="t('room.overview')">
              <div><strong>{{ t('room.directory') }}</strong><span class="room-workspace-path">{{ snapshot.room.workspace || t('room.noDirectory') }}</span></div>
              <div><strong>{{ t('room.controller') }}</strong><span>{{ providerLabel(snapshot.room.providers_json?.[0]) }}</span><span class="room-status">{{ t(chat?.controller_blocked ? 'room.routingBlocked' : chat?.status === 'paused' ? 'room.routingPaused' : 'room.routingEnabled') }}</span></div>
              <div><strong>{{ t('room.availableAgents') }}</strong><span>{{ (snapshot.room.providers_json || []).map(providerLabel).join(' · ') || t('room.noProviders') }}</span></div>
            </div>
            <label v-if="snapshot" class="room-setting-field">
              <span>{{ t('room.project') }}</span>
              <select :value="roomId" :disabled="busy" @change="selectRoom($event.target.value)">
                <option v-for="item in rooms" :key="item.id" :value="item.id">{{ item.name }}</option>
              </select>
            </label>
            <button class="secondary-button" type="button" :disabled="busy" @click="startCreating">{{ t('room.create') }}</button>
            <div class="room-permissions">
              <label><input type="checkbox" :checked="Boolean(snapshot?.room?.write_authorized_root)" :disabled="busy || permissionBusy || !snapshot" @change="command({ type: 'set_workspace_write', allowWrite: $event.target.checked })" />{{ t('room.allowWrite') }}</label>
              <span class="room-muted">{{ t('room.writeHint') }}</span>
              <button class="secondary-button" :disabled="busy || !chat" @click="command({ type: chat?.status === 'paused' ? 'resume_chat' : 'pause_chat' })">{{ t(chat?.status === 'paused' ? 'room.resume' : 'room.pause') }}</button>
            </div>
          </section>

          <section v-show="settingsTab === 'chat'" class="room-settings-section" :aria-hidden="settingsTab !== 'chat'">
            <div class="room-chat-settings">
              <h3>{{ t('room.chatSettings') }}</h3>
              <label class="room-setting-field">
                <span>{{ t('room.chat') }}</span>
                <select v-model="chatId" :disabled="busy || !snapshot?.chats?.length">
                  <option v-for="item in snapshot?.chats || []" :key="item.id" :value="item.id">{{ item.title }}</option>
                </select>
              </label>
              <form class="room-new-chat" @submit.prevent="newChat">
                <input v-model="chatTitle" :placeholder="t('room.chatName')" :aria-label="t('room.chatName')" maxlength="256" />
                <button class="secondary-button" :disabled="busy || !chatTitle.trim()">{{ t('room.newChat') }}</button>
              </form>
            </div>
            <details class="room-context room-settings">
              <summary>{{ t('room.context') }}<span v-if="chat?.current_context"> · v{{ chat.current_context.revision }}</span></summary>
              <p class="room-context-content">{{ chat?.current_context?.instructions || t('room.noContext') }}</p>
              <p class="room-muted">{{ t('room.contextHint') }}</p>
              <form class="room-context-editor" @submit.prevent="sendContext">
                <textarea v-model="contextDraft" :aria-label="t('room.contextInput')" :placeholder="t('room.contextInput')" rows="2" maxlength="100000" />
                <button class="secondary-button" :disabled="busy || !chat || !contextDraft.trim()">{{ t('room.sendContext') }}</button>
              </form>
            </details>
            <details class="room-skill-settings room-settings" :aria-label="t('room.skills')">
              <summary>{{ t('room.skills') }} · {{ chat?.skill_bindings_json?.length || 0 }}</summary>
              <header><strong>{{ t('room.chatSkills') }}</strong><span class="room-muted">{{ t('room.skillsHint') }}</span></header>
              <p v-if="skillsLoading" class="room-muted">{{ t('room.skillsLoading') }}</p>
              <p v-if="skillsError" class="room-error" role="alert">{{ t('room.skillsLoadError') }} <button class="secondary-button" type="button" @click="loadSkillCatalog">{{ t('room.refresh') }}</button></p>
              <p v-else-if="!skillsLoading && !skillCatalog.length" class="room-muted">{{ t('room.skillsEmpty') }}</p>
              <p v-if="skillsSaveError" class="room-error" role="alert">{{ t(skillsSaveError) }}</p>
              <label v-for="skill in skillCatalog" :key="skillKey(skill)" class="room-skill-option">
                <input type="checkbox" :checked="hasSkill(chatSkills, skill)" :disabled="busy || chatSkillsBusy" @change="toggleChatSkill(skill, $event.target.checked)" />
                {{ skill.name || skill.slug }} <small>{{ skill.targetKind }} · {{ skill.namespace }}</small>
              </label>
              <button class="secondary-button" :disabled="busy || chatSkillsBusy || !chatSkillsDirty" @click="saveChatSkills">{{ chatSkillsBusy ? t('room.skillsSaving') : t('room.saveSkills') }}</button>
            </details>
          </section>

          <section v-show="settingsTab === 'team'" class="room-settings-section" :aria-hidden="settingsTab !== 'team'">
            <h2>{{ t('room.members', { count: roles.length }) }}</h2>
            <p v-if="!roles.length" class="room-team-empty">{{ t('room.noMembers') }}</p>
            <div class="room-team">
              <details v-for="role in roles" :key="role.id" class="room-role">
                <summary>{{ roleLabel(role) }} · {{ providerLabel(role.provider) }}<span v-if="isControllerSeat(role)" class="room-agent-badge">{{ t('room.controller') }}</span></summary>
                <button class="secondary-button room-role-open" type="button" @click="openRoleSettings(role.id)">{{ t('room.configureRole') }}</button>
                <p v-if="role.responsibilities" class="room-muted">{{ role.responsibilities }}</p>
                <p v-if="role.creation_reason && !isDefaultSeat(role)" class="room-role-reason"><strong>{{ t('room.roleCreationReason') }}:</strong> {{ role.creation_reason }}</p>
                <p v-if="role.current_prompt" class="room-role-prompt">{{ role.current_prompt }}</p>
                <p v-else class="room-muted">{{ t('room.noRolePrompt') }}</p>
                <form class="room-role-editor" @submit.prevent="saveRolePrompt(role)">
                  <textarea v-model="rolePrompts[role.id]" :aria-label="t('room.rolePrompt')" rows="3" maxlength="100000" />
                  <button class="secondary-button" :disabled="busy || rolePrompts[role.id] === (role.current_prompt || '')">{{ t('room.saveRolePrompt') }}</button>
                </form>
                <div v-if="skillCatalogFor(role).length" class="room-role-skills">
                  <strong>{{ t('room.roleSkills') }}</strong>
                  <select v-model="roleSkillModes[role.id]" :aria-label="t('room.roleSkillMode')" :disabled="busy || roleSkillsBusy[role.id]" @change="markRoleSkillsDirty(role.id)">
                    <option value="inherit">{{ t('room.skillsInherit') }}</option>
                    <option value="override">{{ t('room.skillsOverride') }}</option>
                    <option value="none">{{ t('room.skillsNone') }}</option>
                  </select>
                  <div v-if="roleSkillModes[role.id] === 'override'" class="room-skill-options">
                    <label v-for="skill in skillCatalogFor(role)" :key="skillKey(skill)" class="room-skill-option">
                      <input type="checkbox" :checked="hasSkill(roleSkills[role.id], skill)" :disabled="busy || roleSkillsBusy[role.id]" @change="toggleRoleSkill(role, skill, $event.target.checked)" />
                      {{ skill.name || skill.slug }} <small>{{ skill.targetKind }} · {{ skill.namespace }}</small>
                    </label>
                  </div>
                  <button class="secondary-button" :disabled="busy || roleSkillsBusy[role.id] || !roleSkillsDirty[role.id]" @click="saveRoleSkills(role)">{{ roleSkillsBusy[role.id] ? t('room.skillsSaving') : t('room.saveSkills') }}</button>
                </div>
              </details>
            </div>
          </section>
        </div>
      </aside>
    </div>

    <div v-if="selectedRole" class="room-modal-backdrop" @click.self="closeRoleSettings" @wheel.self.prevent>
      <section ref="roleSettingsRef" class="room-role-modal" role="dialog" aria-modal="true" :aria-label="t('room.roleSettings')" tabindex="-1" @keydown.esc.stop="closeRoleSettings">
        <header class="room-settings-header room-role-modal-header">
          <div><span>{{ t('room.roleSettings') }}</span><strong>{{ roleLabel(selectedRole) }}<span v-if="isControllerSeat(selectedRole)" class="room-agent-badge">{{ t('room.controller') }}</span></strong></div>
          <button class="secondary-button" type="button" @click="closeRoleSettings">{{ t('common.close') }}</button>
        </header>
        <div class="room-role-modal-body">
          <aside class="room-role-identity">
            <div class="room-role-avatar">
              <img v-if="selectedRole.provider" :src="agentLogo(selectedRole.provider)" alt="" />
              <span v-else>{{ roleLabel(selectedRole).slice(0, 1) }}</span>
            </div>
            <strong>{{ roleLabel(selectedRole) }}</strong>
            <span>{{ providerLabel(selectedRole.provider) }}</span>
            <p v-if="selectedRole.responsibilities">{{ selectedRole.responsibilities }}</p>
            <p v-if="selectedRole.creation_reason && !isDefaultSeat(selectedRole)" class="room-muted">{{ t('room.roleCreationReason') }}: {{ selectedRole.creation_reason }}</p>
            <p v-if="isControllerSeat(selectedRole)" class="room-muted">{{ t('room.controllerSeatHint') }}</p>
            <p class="room-muted">{{ t('room.roleReadOnly') }}</p>
          </aside>
          <div class="room-role-form">
            <label class="room-setting-field"><span>{{ t('room.roleName') }}</span><input :value="roleLabel(selectedRole)" disabled /></label>
            <label class="room-setting-field"><span>{{ t('room.roleResponsibilities') }}</span><textarea :value="selectedRole.responsibilities || t('room.noResponsibilities')" rows="2" disabled /></label>
            <label class="room-setting-field"><span>{{ t('room.agent') }}</span><input :value="providerLabel(selectedRole.provider)" disabled /></label>
            <div class="room-setting-field"><span>{{ t('room.capabilities') }}</span><p class="room-muted">{{ (selectedRole.capabilities_json || []).join(' · ') || t('room.noCapabilities') }}</p></div>
            <label class="room-setting-field"><span>{{ t('room.rolePrompt') }}</span><textarea v-model="rolePrompts[selectedRole.id]" rows="6" maxlength="100000" /></label>
            <div class="room-actions">
              <button class="primary-button" :disabled="busy || (rolePrompts[selectedRole.id] || '') === (selectedRole.current_prompt || '')" @click="saveRolePrompt(selectedRole)">{{ t('room.saveRolePrompt') }}</button>
            </div>
            <div v-if="skillCatalogFor(selectedRole).length" class="room-role-skills">
              <strong>{{ t('room.roleSkills') }}</strong>
              <select v-model="roleSkillModes[selectedRole.id]" :aria-label="t('room.roleSkillMode')" :disabled="busy || roleSkillsBusy[selectedRole.id]" @change="markRoleSkillsDirty(selectedRole.id)">
                <option value="inherit">{{ t('room.skillsInherit') }}</option>
                <option value="override">{{ t('room.skillsOverride') }}</option>
                <option value="none">{{ t('room.skillsNone') }}</option>
              </select>
              <div v-if="roleSkillModes[selectedRole.id] === 'override'" class="room-skill-options">
                <label v-for="skill in skillCatalogFor(selectedRole)" :key="skillKey(skill)" class="room-skill-option">
                  <input type="checkbox" :checked="hasSkill(roleSkills[selectedRole.id], skill)" :disabled="busy || roleSkillsBusy[selectedRole.id]" @change="toggleRoleSkill(selectedRole, skill, $event.target.checked)" />
                  {{ skill.name || skill.slug }} <small>{{ skill.targetKind }} · {{ skill.namespace }}</small>
                </label>
              </div>
              <button class="secondary-button" :disabled="busy || roleSkillsBusy[selectedRole.id] || !roleSkillsDirty[selectedRole.id]" @click="saveRoleSkills(selectedRole)">{{ roleSkillsBusy[selectedRole.id] ? t('room.skillsSaving') : t('room.saveSkills') }}</button>
            </div>
            <p v-else class="room-muted">{{ t('room.skillsEmpty') }}</p>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PersonOutline } from '@vicons/ionicons5'
import { agentLogo } from '../catalog.js'
import { t } from '../i18n.js'
import { useRoomWorkspace } from '../composables/useRoomWorkspace.js'
import RoomArtifactDiff from './RoomArtifactDiff.vue'

const props = defineProps({ api: { type: Object, required: true }, pickDirectory: { type: Function, required: true }, agents: { type: Array, default: () => [] }, createRequest: { type: Boolean, default: false } })
const emit = defineEmits(['create-request-consumed'])
const { rooms, snapshot, roomId, chatId, chat, tasks, assignments, roles, messages, reports, attentions, staleAssignments, liveAssignments,
  hasOlderMessages, loadingOlderMessages, busy, error, load, refresh, openRoom, createRoom, createChat, send, loadOlderMessages, command } = useRoomWorkspace({ api: props.api })
const creating = ref(false)
const settingsOpen = ref(false)
const settingsTab = ref('room')
const settingsRef = ref(null)
const roleSettingsId = ref('')
const roleSettingsRef = ref(null)
const workPanelOpen = ref(true)
const name = ref('')
const directory = ref('')
const chatTitle = ref('')
const diffArtifactId = ref('')
const drafts = ref({})
const draft = computed({ get: () => drafts.value[chatId.value] || '', set: value => { drafts.value[chatId.value] = value } })
const answers = ref({})
const handoffRoles = ref({})
const rolePrompts = ref({})
const skillCatalog = ref([])
const skillsLoading = ref(false)
const skillsError = ref(false)
const skillsSaveError = ref(false)
let skillLoadGeneration = 0
const contextDraft = ref('')
const chatSkills = ref([])
const chatSkillsDirty = ref(false)
const chatSkillsBusy = ref(false)
const roleSkills = ref({})
const roleSkillModes = ref({})
const roleSkillsDirty = ref({})
const roleSkillsBusy = ref({})
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
const workdirName = computed(() => (snapshot.value?.room?.workspace || '').split(/[\\/]/).filter(Boolean).at(-1) || '')
const projectLabel = computed(() => {
  const name = snapshot.value?.room?.name || t('room.title')
  return chat.value?.title === name ? t('room.title') : name
})
const linkedArtifactIds = computed(() => new Set(reports.value.flatMap(report => report.artifact_ids_json || [])))
const unlinkedArtifacts = computed(() => (snapshot.value?.artifacts || []).filter(artifact => !linkedArtifactIds.value.has(artifact.id)))
const hasWork = computed(() => tasks.value.length > 0 || unlinkedArtifacts.value.length > 0 || staleAssignmentIds.value.size > 0)
const showWorkPanel = computed(() => workPanelOpen.value && hasWork.value)
const workCount = computed(() => tasks.value.length + unlinkedArtifacts.value.length)
const selectedRole = computed(() => roles.value.find(role => role.id === roleSettingsId.value) || null)
const liveEntries = computed(() => Object.entries(liveAssignments.value).map(([id, live]) => {
  const assignment = assignments.value.find(item => item.id === id)
  const role = roles.value.find(item => item.id === assignment?.role_id)
  return { id, author: roleLabel(role), provider: role?.provider || '', content: live?.text || '', status: live?.status || 'running' }
}).filter(entry => entry.content))
const entries = computed(() => [
  ...messages.value.map(message => {
    const role = roles.value.find(item => item.id === message.author_id)
    return { key: message.id, author: message.author_type === 'user' ? t('room.you') : roleLabel(role),
      content: message.content, createdAt: message.created_at, isUser: message.author_type === 'user', provider: role?.provider || '', report: false }
  }),
  ...reports.value.map(report => {
    const assignment = assignments.value.find(item => item.id === report.assignment_id)
    const role = roles.value.find(item => item.id === assignment?.role_id)
    const artifacts = (report.artifact_ids_json || [])
      .map(id => (snapshot.value?.artifacts || []).find(artifact => artifact.id === id))
      .filter(Boolean)
    return { key: report.id, author: `${roleLabel(role)} · ${t('room.report')}`, content: report.summary,
      evidence: report.evidence_json, artifacts, report: true, isUser: false, provider: role?.provider || '', createdAt: report.created_at }
  }),
].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))))

function isDefaultSeat(role) { return role?.creation_reason === 'project_default_agent' }
function isControllerSeat(role) { return isDefaultSeat(role) && role.provider === snapshot.value?.room?.providers_json?.[0] }
function roleLabel(role) { return role ? (isDefaultSeat(role) ? providerLabel(role.provider) : role.display_name) : t('room.agent') }
function roleName(id) { return roleLabel(roles.value.find(item => item.id === id)) }
function providerLabel(kind) { return props.agents.find(agent => agent.kind === kind)?.label || kind || t('room.noProviders') }
function skillKey(skill) { return `${skill.targetKind}:${skill.namespace}:${skill.slug}` }
function plainSkill(skill) {
  return { targetKind: skill.targetKind, namespace: skill.namespace, slug: skill.slug, name: skill.name }
}
function hasSkill(bindings, skill) { return (bindings || []).some(item => skillKey(item) === skillKey(skill)) }
function skillCatalogFor(role) { return skillCatalog.value.filter(skill => !role?.provider || skill.targetKind === role.provider) }
function toggleChatSkill(skill, checked) {
  const next = chatSkills.value.filter(item => skillKey(item) !== skillKey(skill))
  if (checked) next.push({ targetKind: skill.targetKind, namespace: skill.namespace, slug: skill.slug, name: skill.name })
  chatSkills.value = next; chatSkillsDirty.value = true
}
function toggleRoleSkill(role, skill, checked) {
  const current = roleSkills.value[role.id] || []
  const next = current.filter(item => skillKey(item) !== skillKey(skill))
  if (checked) next.push({ targetKind: skill.targetKind, namespace: skill.namespace, slug: skill.slug, name: skill.name })
  roleSkills.value = { ...roleSkills.value, [role.id]: next }
  roleSkillsDirty.value = { ...roleSkillsDirty.value, [role.id]: true }
}
function markRoleSkillsDirty(roleId) { roleSkillsDirty.value = { ...roleSkillsDirty.value, [roleId]: true } }
function skillSaveErrorKey(error) {
  if (String(error?.message || '').includes('LOCAL_SKILL_MANIFEST_MISSING')) return 'room.skillsManifestMissing'
  if (String(error?.message || '').includes('LOCAL_SKILL_TRUST_REQUIRED')) return 'room.skillsTrustRequired'
  return 'room.skillsSaveError'
}
async function saveChatSkills() {
  if (typeof props.api.updateSkillBindings !== 'function') return
  chatSkillsBusy.value = true
  skillsSaveError.value = false
  const targetChat = chatId.value
  try { await props.api.updateSkillBindings({ chatId: targetChat, selections: chatSkills.value.map(plainSkill) }); if (chatId.value === targetChat) chatSkillsDirty.value = false; await refresh({ afterCurrent: true }) }
  catch (error) { if (chatId.value === targetChat) skillsSaveError.value = skillSaveErrorKey(error) }
  finally { chatSkillsBusy.value = false }
}
async function saveRoleSkills(role) {
  if (typeof props.api.updateSkillBindings !== 'function') return
  roleSkillsBusy.value = { ...roleSkillsBusy.value, [role.id]: true }
  skillsSaveError.value = false
  try {
    const mode = roleSkillModes.value[role.id]
    const input = mode === 'inherit' ? { chatId: chatId.value, roleId: role.id, inheritChat: true } : { chatId: chatId.value, roleId: role.id, selections: mode === 'none' ? [] : (roleSkills.value[role.id] || []).map(plainSkill) }
    await props.api.updateSkillBindings(input)
    roleSkillsDirty.value = { ...roleSkillsDirty.value, [role.id]: false }
    await refresh({ afterCurrent: true })
  } catch (error) { if (chatId.value === role.chat_id) skillsSaveError.value = skillSaveErrorKey(error) }
  finally { roleSkillsBusy.value = { ...roleSkillsBusy.value, [role.id]: false } }
}
const skillProviders = computed(() => [...new Set([...(snapshot.value?.room?.providers_json || []), ...roles.value.map(role => role.provider)].filter(Boolean))].sort().join(','))
async function loadSkillCatalog() {
  const generation = ++skillLoadGeneration
  skillsLoading.value = true
  skillsError.value = false
  const kinds = skillProviders.value ? skillProviders.value.split(',') : []
  const results = await Promise.allSettled(kinds.map(kind => typeof props.api.skills === 'function' ? props.api.skills(kind) : Promise.reject(new Error('SKILLS_UNAVAILABLE'))))
  if (generation !== skillLoadGeneration) return
  skillsError.value = results.some(result => result.status === 'rejected' || result.value?.supported === false)
  const skills = results.flatMap(result => result.status === 'fulfilled' ? result.value?.skills || [] : [])
  skillCatalog.value = [...new Map(skills.map(skill => [skillKey(skill), skill])).values()]
  skillsLoading.value = false
}
function syncSkillDrafts() {
  if (!chatSkillsDirty.value) chatSkills.value = chat.value?.skill_bindings_json || []
  const modes = {}; const values = {}
  for (const role of roles.value) {
    modes[role.id] = roleSkillsDirty.value[role.id] ? roleSkillModes.value[role.id] : role.skill_bindings_json === null ? 'inherit' : (role.skill_bindings_json?.length ? 'override' : 'none')
    values[role.id] = roleSkillsDirty.value[role.id] ? roleSkills.value[role.id] : role.skill_bindings_json || []
  }
  roleSkillModes.value = modes; roleSkills.value = values
}
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
function openSettings(tab = 'room') {
  settingsTab.value = ['room', 'chat', 'team'].includes(tab) ? tab : 'room'
  settingsOpen.value = true
}
function closeSettings() { settingsOpen.value = false }
function openRoleSettings(roleId) {
  const role = roles.value.find(item => item.id === roleId)
  if (role && rolePrompts.value[roleId] === undefined) rolePrompts.value = { ...rolePrompts.value, [roleId]: role.current_prompt || '' }
  settingsOpen.value = false
  roleSettingsId.value = roleId
}
function closeRoleSettings() { roleSettingsId.value = '' }
function selectRoom(id) { closeSettings(); void openRoom(id) }
function startCreating() { settingsOpen.value = false; creating.value = true }
async function scrollToAttention() { await nextTick(); if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight }
async function chooseDirectory() {
  picking.value = true
  pickerError.value = false
  try { const result = await props.pickDirectory(); if (result) directory.value = result }
  catch { pickerError.value = true }
  finally { picking.value = false }
}
async function create() {
  const providers = [...new Set(props.agents.map(agent => agent.kind).filter(Boolean))]
  if (await createRoom({ name: name.value.trim(), workspace: directory.value, providers })) creating.value = false
}
async function newChat() { if (await createChat(chatTitle.value.trim())) chatTitle.value = '' }
async function sendMessage() {
  const target = chatId.value
  const content = draft.value
  if (await send(content)) drafts.value[target] = ''
}
async function sendContext() {
  const targetChat = chatId.value
  if (await send(contextDraft.value.trim())) { if (targetChat === chatId.value) contextDraft.value = '' }
}
async function loadEarlierMessages() {
  const container = timeline.value
  const previousHeight = container?.scrollHeight || 0
  const previousTop = container?.scrollTop || 0
  await loadOlderMessages()
  await nextTick()
  if (container && timeline.value === container) {
    container.scrollTop = previousTop + container.scrollHeight - previousHeight
  }
}
async function answer(attention) {
  await command({ type: 'answer_attention', attentionId: attention.id,
    ...(attention.options_json?.length ? { optionId: answers.value[attention.id] } : { comment: answers.value[attention.id] }) })
}
function onOverlayKeydown(event) {
  if (event.key !== 'Escape') return
  if (creating.value) { event.preventDefault(); creating.value = false }
  else if (roleSettingsId.value) { event.preventDefault(); closeRoleSettings() }
  else if (settingsOpen.value) { event.preventDefault(); closeSettings() }
}
watch([settingsOpen, creating, roleSettingsId], async ([settings, create, roleId]) => {
  const open = settings || create || Boolean(roleId)
  document.body.classList.toggle('room-overlay-open', open)
  if (open) document.addEventListener('keydown', onOverlayKeydown)
  else document.removeEventListener('keydown', onOverlayKeydown)
  if (settings) { await nextTick(); settingsRef.value?.focus?.() }
  else if (roleId) { await nextTick(); roleSettingsRef.value?.focus?.() }
})
watch(() => props.createRequest, requested => {
  if (!requested) return
  startCreating()
  emit('create-request-consumed')
}, { immediate: true })
watch(roomId, () => { workPanelOpen.value = true })
watch([roomId, chatId], () => { roleSettingsId.value = ''; handoffRoles.value = {}; answers.value = {}; rolePrompts.value = {}; contextDraft.value = ''; chatSkillsDirty.value = false; roleSkillsDirty.value = {}; skillsSaveError.value = false; syncSkillDrafts(); diffArtifactId.value = ''; traceSteps.value = {}; traceLoaded.value = {}; traceErrors.value = {}; traceCursors.value = {}; traceHasMore.value = {}; traceBlobTexts.value = {}; traceBlobOffsets.value = {}; traceBlobBusy.value = {}; traceBlobEof.value = {} })
watch(roles, items => {
  const next = { ...rolePrompts.value }
  for (const role of items) if (!(role.id in next)) next[role.id] = role.current_prompt || ''
  rolePrompts.value = next
}, { immediate: true })
watch(skillProviders, () => { void loadSkillCatalog() }, { immediate: true })
watch([snapshot, roles, chatId], syncSkillDrafts, { immediate: true })
watch(() => entries.value.length, async () => { await nextTick(); if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight })
onMounted(load)
onBeforeUnmount(() => {
  document.body.classList.remove('room-overlay-open')
  document.removeEventListener('keydown', onOverlayKeydown)
})
</script>

<style scoped>
.room-workspace { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; padding: 0; gap: 0; background: var(--surface); color: var(--text); }
.room-toolbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px clamp(16px, 3vw, 28px); border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 94%, var(--surface-raised)); }
.room-heading { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.room-project-name { align-self: flex-start; padding: 0; border: 0; background: transparent; color: var(--faint); font-size: var(--text-2xs); cursor: pointer; }
.room-project-name:hover { color: var(--accent-text); }
.room-title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.room-title-row h1 { margin: 0; font-size: var(--text-xl); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.room-subtitle { max-width: 34ch; overflow: hidden; color: var(--faint); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.room-chat-toolbar { display: flex; align-items: center; gap: 6px; }
.room-chat-toolbar select { max-width: 16ch; padding: 4px 24px 4px 8px; border-color: transparent; background: transparent; color: var(--faint); font-size: var(--text-xs); }
.room-chat-toolbar select:hover, .room-chat-toolbar select:focus-visible { border-color: var(--border); background: var(--surface); color: var(--text); }
.room-agent-strip { display: flex; flex: 1 1 auto; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.room-agent-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 190px; padding: 4px 9px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-raised); color: inherit; font: inherit; font-size: var(--text-xs); cursor: pointer; }
.room-agent-chip:hover { border-color: var(--border-strong); background: var(--surface-hover); }
.room-agent-chip img { width: 16px; height: 16px; flex: 0 0 16px; object-fit: contain; }
.room-agent-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room-agent-badge { flex: 0 0 auto; margin-left: 2px; padding: 1px 5px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-text); font-size: 10px; font-weight: 600; }
.room-agent-idle { flex: 1 1 auto; color: var(--faint); font-size: var(--text-xs); }
.room-header-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.room-notice-pill { padding: 5px 11px; border: 1px solid color-mix(in srgb, var(--accent) 62%, var(--border)); border-radius: 999px; background: var(--accent-soft); color: var(--accent-text); font-size: var(--text-xs); font-weight: 600; cursor: pointer; }
.room-icon-button { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-raised); color: var(--text-soft); font-size: 20px; line-height: 1; cursor: pointer; }
.room-icon-button:hover { border-color: var(--border-strong); color: var(--text); }
.room-create-button { font-size: 18px; }
.room-banner { margin: 10px clamp(16px, 3vw, 28px) 0; }
.room-landing { flex: 1; display: grid; place-items: center; padding: 32px; }
.room-landing-inner { max-width: 460px; text-align: center; }
.room-landing-inner h2 { margin: 0 0 8px; font-size: var(--text-2xl); }
.room-landing-inner p { margin: 0 0 18px; line-height: 1.65; }
.room-body { display: flex; flex: 1; min-height: 0; overflow: hidden; }
.room-conversation { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.room-timeline { flex: 1; overflow: auto; overscroll-behavior: contain; padding: 28px clamp(16px, 4vw, 48px) 16px; }
.room-timeline-inner { width: min(920px, 100%); margin: 0 auto; }
.room-load-older { margin-bottom: 18px; }
.room-welcome { max-width: 620px; margin: clamp(32px, 9vh, 96px) auto 0; text-align: center; }
.room-welcome h2 { margin: 0 0 8px; font-size: var(--text-2xl); }
.room-welcome p { margin: 0 0 8px; line-height: 1.65; }
.room-message { display: flex; gap: 12px; align-items: flex-start; margin: 0 0 24px; }
.room-message-user { flex-direction: row-reverse; }
.room-message-avatar { display: grid; flex: 0 0 32px; place-items: center; width: 32px; height: 32px; color: var(--text-soft); font-size: var(--text-xs); font-weight: 600; }
.room-message-avatar img { width: 26px; height: 26px; object-fit: contain; }
.room-user-avatar { border-radius: 50%; background: var(--surface-active); }
.room-user-avatar svg { width: 18px; height: 18px; }
.room-message-body { min-width: 0; max-width: min(760px, calc(100% - 48px)); padding: 4px 2px; }
.room-message-user .room-message-body { max-width: min(640px, 82%); padding: 10px 14px; border-radius: 12px; background: color-mix(in srgb, var(--surface-active) 72%, transparent); }
.room-message header { display: flex; gap: 10px; align-items: baseline; margin-bottom: 4px; }
.room-message header strong { font-size: var(--text-sm); }
.room-message time { color: var(--faint); font-size: var(--text-2xs); }
.room-message p { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.65; }
.room-message ul { margin: 8px 0 0; padding-left: 18px; color: var(--text-soft); font-size: var(--text-xs); line-height: 1.55; }
.room-report .room-message-body { padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-raised); }
.room-message-artifacts { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.room-artifact-card { padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--surface) 80%, var(--surface-raised)); }
.room-artifact-head { display: flex; gap: 10px; justify-content: space-between; align-items: baseline; }
.room-artifact-head strong { overflow-wrap: anywhere; }
.room-artifact-head span { flex: 0 0 auto; color: var(--faint); font-size: var(--text-2xs); }
.room-artifact-card .room-actions { margin-top: 6px; }
.room-running-label { color: var(--accent-text); font-size: var(--text-2xs); }
.room-live-message .room-live-output { max-height: 18rem; overflow: auto; padding: 8px 10px; border-left: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 0 8px 8px 0; background: color-mix(in srgb, var(--accent-soft) 45%, transparent); }
.room-attention-card { margin: 18px 0; padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border)); border-radius: 12px; background: var(--accent-soft); }
.room-attention-card header { display: flex; gap: 10px; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.room-attention-card header span { color: var(--faint); font-size: var(--text-2xs); text-transform: uppercase; }
.room-attention-card p { margin: 0 0 10px; line-height: 1.55; }
.room-attention-card form { display: flex; flex-wrap: wrap; gap: 8px; }
.room-attention-card select, .room-attention-card input { flex: 1; min-width: min(220px, 100%); }
.room-composer-wrap { padding: 12px clamp(16px, 4vw, 48px) 18px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 92%, var(--surface-raised)); }
.room-composer { display: flex; align-items: flex-end; gap: 10px; width: min(920px, 100%); margin: 0 auto; }
.room-composer textarea { flex: 1; min-width: 0; min-height: 44px; max-height: 160px; resize: vertical; }
.room-ledger { display: flex; flex: 0 0 min(340px, 36%); flex-direction: column; min-height: 0; overflow: auto; padding: 14px; border-left: 1px solid var(--border); background: var(--surface-raised); }
.room-ledger-header { display: flex; gap: 10px; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.room-ledger-header h2 { margin: 0; }
.room-ledger > h2 { margin-top: 16px; }
.room-card { padding: 12px; border: 1px solid var(--border); border-radius: 12px; margin-bottom: 10px; overflow-wrap: anywhere; }
.room-card header { display: flex; gap: 10px; justify-content: space-between; align-items: baseline; }
.room-card p { margin: 4px 0; }
.room-card form { display: flex; flex-wrap: wrap; gap: 8px; }
.room-card select { min-width: 0; }
.room-assignment { padding-top: 8px; margin-top: 8px; border-top: 1px solid var(--border); font-size: var(--text-xs); }
.room-live-output { max-height: 12rem; overflow: auto; padding: 8px; border-radius: 8px; background: color-mix(in srgb, var(--border) 18%, transparent); white-space: pre-wrap; }
.room-trace-list { padding-left: 18px; }
.room-trace-list li { margin-bottom: 8px; }
.room-trace-list span { display: block; color: var(--text-soft); }
.room-trace-blob pre { max-height: 16rem; overflow: auto; padding: 8px; border-radius: 8px; background: var(--surface); font-size: var(--text-xs); white-space: pre-wrap; }
.room-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.room-modal-backdrop, .room-settings-backdrop { position: fixed; inset: 0; z-index: 100; background: rgb(0 0 0 / 0.34); }
.room-settings-backdrop { display: grid; place-items: center; padding: 20px; }
.room-modal-backdrop { display: grid; place-items: center; padding: 20px; }
.room-modal { width: min(560px, 100%); max-height: calc(100vh - 40px); overflow: auto; background: var(--surface-raised); box-shadow: 0 24px 70px rgb(0 0 0 / 0.28); }
.room-modal-header { display: flex; gap: 12px; justify-content: space-between; align-items: center; }
.room-modal-header h2 { margin: 0; }
.room-create { display: grid; gap: 12px; padding: 18px; border: 1px solid var(--border); border-radius: 12px; }
.room-create label { display: grid; gap: 6px; }
.room-directory { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; overflow-wrap: anywhere; }
.room-settings-modal { display: flex; flex-direction: column; width: min(880px, 100%); max-height: calc(100vh - 40px); overflow: hidden; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-raised); box-shadow: 0 24px 70px rgb(0 0 0 / 0.28); outline: none; }
.room-role-modal { display: flex; flex-direction: column; width: min(920px, 100%); max-height: calc(100vh - 40px); overflow: hidden; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-raised); box-shadow: 0 24px 70px rgb(0 0 0 / 0.28); outline: none; }
.room-role-modal-body { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 0; overflow: auto; }
.room-role-identity { display: flex; flex-direction: column; gap: 7px; padding: 22px 20px; border-right: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 70%, var(--surface-raised)); }
.room-role-avatar { display: grid; place-items: center; width: 120px; height: 120px; margin: 0 auto 8px; border: 1px solid var(--border); border-radius: 50%; background: radial-gradient(circle at 35% 30%, var(--accent-soft), var(--surface-active)); }
.room-role-avatar img { width: 64px; height: 64px; object-fit: contain; }
.room-role-avatar span { color: var(--text-soft); font-size: var(--text-3xl); font-weight: 600; }
.room-role-identity > strong { text-align: center; font-size: var(--text-lg); }
.room-role-identity > span { text-align: center; color: var(--faint); font-size: var(--text-xs); }
.room-role-identity p { margin: 6px 0 0; font-size: var(--text-xs); line-height: 1.6; }
.room-role-form { display: flex; flex-direction: column; gap: 14px; padding: 22px; }
.room-role-form textarea { width: 100%; resize: vertical; }
.room-role-form .room-role-skills { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
.room-role-form .room-role-skills .secondary-button { align-self: flex-start; }
.room-settings-header { display: flex; gap: 12px; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid var(--border); }
.room-settings-header div { display: flex; flex-direction: column; gap: 2px; }
.room-settings-header span { color: var(--faint); font-size: var(--text-2xs); }
.room-settings-tabs { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid var(--border); }
.room-settings-tabs button { padding: 10px 8px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--faint); font-size: var(--text-xs); cursor: pointer; }
.room-settings-tabs button.active { border-bottom-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.room-settings-body { display: flex; flex: 1; flex-direction: column; gap: 16px; min-height: 0; overflow: auto; padding: 16px; }
.room-settings-section { display: flex; flex-direction: column; gap: 14px; }
.room-setting-field { display: grid; gap: 6px; color: var(--text-soft); font-size: var(--text-xs); }
.room-setting-field select { width: 100%; }
.room-overview { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; font-size: var(--text-xs); }
.room-overview > div { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; min-width: 0; }
.room-workspace-path { overflow-wrap: anywhere; }
.room-status { opacity: 0.7; }
.room-settings { padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; }
.room-settings summary { cursor: pointer; font-size: var(--text-xs); }
.room-settings header { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
.room-context-content { white-space: pre-wrap; font-size: var(--text-sm); }
.room-context-editor { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
.room-context-editor textarea { flex: 1; min-width: min(100%, 220px); }
.room-chat-settings { display: flex; flex-direction: column; gap: 10px; }
.room-chat-settings h3 { margin: 0; font-size: var(--text-sm); }
.room-new-chat { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.room-new-chat input { flex: 1; min-width: min(100%, 200px); }
.room-skill-option { display: inline-flex; gap: 6px; align-items: center; margin: 6px 14px 6px 0; font-size: var(--text-xs); }
.room-team { display: flex; flex-direction: column; gap: 8px; margin: 4px 0; }
.room-role { padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; font-size: var(--text-xs); }
.room-role summary { cursor: pointer; }
.room-role-open { margin: 6px 0; }
.room-role-prompt { max-width: 42rem; line-height: 1.45; white-space: pre-wrap; }
.room-role-editor { display: grid; gap: 6px; }
.room-role-editor textarea { width: 100%; min-width: 0; resize: vertical; }
.room-team-empty { font-size: var(--text-sm); line-height: 1.6; opacity: 0.75; }
.room-permissions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); font-size: var(--text-xs); }
.room-permissions label { display: inline-flex; gap: 6px; align-items: center; }
.room-error { color: var(--danger, #b94c4c); font-size: var(--text-xs); }
.room-warning { padding: 8px 10px; border: 1px solid currentColor; border-radius: 8px; color: var(--warning, #9a6700); font-size: var(--text-xs); }
.room-controller-blocked { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.room-muted { color: var(--faint); }
h2 { font-size: var(--text-sm); }
input:not([type=checkbox]), select, textarea { max-width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: inherit; }
textarea { line-height: 1.5; }
button:disabled { cursor: not-allowed; opacity: 0.55; }
@media (max-width: 950px) {
  .room-agent-strip { order: 3; flex-basis: 100%; }
  .room-header-actions { margin-left: auto; }
  .room-body { position: relative; }
  .room-ledger { position: absolute; inset: 0 0 0 auto; z-index: 20; width: min(360px, 100%); box-shadow: -18px 0 50px rgb(0 0 0 / 0.18); }
  .room-timeline { padding: 20px 16px 12px; }
  .room-composer-wrap { padding: 10px 16px 14px; }
  .room-message-body, .room-message-user .room-message-body { max-width: calc(100% - 44px); }
  .room-welcome { margin-top: 32px; }
  .room-settings-modal, .room-role-modal { width: 100%; max-height: calc(100vh - 24px); }
  .room-role-modal-body { grid-template-columns: 1fr; }
  .room-role-identity { border-right: 0; border-bottom: 1px solid var(--border); }
}
</style>

<style>
body.room-overlay-open { overflow: hidden; }
</style>
