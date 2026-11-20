<template>
  <section class="room-workspace">
    <header class="room-toolbar room-header">
      <div class="room-heading">
        <button class="room-project-name" type="button" :aria-label="t('room.projectSettings')" @click="openProjectSettings">
          <span>{{ projectLabel }}</span>
          <ChevronDownOutline aria-hidden="true" />
        </button>
        <div class="room-title-row">
          <h1>
            <button class="room-chat-title" type="button" :aria-label="t('room.chatSettings')" @click="openChatSettings">
              <span>{{ activeChatLabel }}</span>
              <ChevronDownOutline aria-hidden="true" />
            </button>
          </h1>
        </div>
        <span v-if="snapshot && workdirName" class="room-subtitle">
          {{ workdirName }}
          <span class="room-subtitle-divider">·</span>
          <span :data-tone="writeAuthorized ? 'ready' : 'neutral'">
            {{ writeAuthorized ? t('room.writeEnabled') : t('room.readOnly') }}
          </span>
        </span>
      </div>

      <div v-if="snapshot" class="room-agent-strip" :aria-label="t('room.members', { count: roles.length })">
        <button
          v-for="role in roles"
          :key="role.id"
          class="room-agent-chip"
          type="button"
          :title="agentTitle(role)"
          :aria-label="`${t('room.configureRole')}: ${roleLabel(role)}`"
          @click="openRoleSettings(role.id)"
        >
          <img v-if="role.provider" :src="agentLogo(role.provider)" alt="" />
          <span>{{ roleLabel(role) }}</span>
          <span v-if="role.provider && !canSpeak(role.provider)" class="room-agent-quiet">{{ t('room.cannotSpeak') }}</span>
          <span v-if="role.is_captain" class="room-agent-badge">{{ t('room.captain') }}</span>
        </button>
        <span v-if="!roles.length" class="room-agent-idle">{{ t('room.teamIdle') }}</span>
        <button
          class="room-agent-add"
          type="button"
          :title="t('room.addAgent')"
          :aria-label="t('room.addAgent')"
          :disabled="busy || !(snapshot.room.providers?.length)"
          @click="openNewRole"
        >
          <AddOutline />
        </button>
      </div>

      <div class="room-header-actions">
        <button v-if="attentions.length" class="room-notice-pill" type="button" @click="scrollToAttention">
          {{ t('room.attentions', { count: attentions.length }) }}
        </button>
        <button v-if="snapshot" class="room-icon-button room-usage-toggle" type="button" :aria-pressed="usageOpen" :title="t('room.usagePanel')" :aria-label="t('room.usagePanel')" @click="emit('toggle-usage')">
          <PulseOutline />
        </button>
        <button v-if="snapshot" class="room-icon-button room-files-toggle" type="button" :aria-pressed="filesOpen" :title="t('room.files')" :aria-label="t('room.files')" @click="emit('toggle-files')">
          <FolderOutline />
        </button>
        <button v-if="hasWork" class="secondary-button room-work-toggle" type="button" :aria-pressed="workPanelOpen" @click="workPanelOpen = !workPanelOpen">
          {{ t('room.workPanel') }} · {{ workCount }}
        </button>
        <button class="room-icon-button room-create-button" type="button" data-testid="room-create-open" :aria-label="t('room.create')" :disabled="busy" @click="startCreating">+</button>
      </div>
    </header>

    <p v-if="error || pickerError" class="room-error room-banner" role="alert">
      {{ t('room.error') }}
      <button class="secondary-button" type="button" @click="reload">{{ t('room.refresh') }}</button>
    </p>

    <div v-if="!snapshot" class="room-landing">
      <div class="room-landing-inner">
        <h2>{{ rooms.length ? t('room.loading') : t('room.emptyProjects') }}</h2>
        <p v-if="!rooms.length" class="room-muted">{{ t('room.createHint') }}</p>
        <button v-if="!rooms.length" class="primary-button" type="button" :disabled="busy" @click="startCreating">{{ t('room.create') }}</button>
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

            <template v-for="entry in entries" :key="entry.key">
              <article
                v-if="entry.kind === 'message'"
                class="room-message"
                :class="{
                  'room-message-user': entry.isUser,
                  'room-message-agent': !entry.isUser,
                  'room-message-system': entry.isSystem,
                  'room-message-captain': entry.isCaptain,
                }"
              >
                <span v-if="!entry.isUser && !entry.isSystem" class="room-message-avatar">
                  <img v-if="entry.provider" :src="agentLogo(entry.provider)" alt="" />
                  <span v-else>{{ entry.author.slice(0, 1) }}</span>
                </span>
                <div class="room-message-body">
                  <header>
                    <strong>{{ entry.author }}</strong>
                    <span v-if="entry.isCaptain" class="room-agent-badge">{{ t('room.captain') }}</span>
                    <span v-if="entry.isReviewReply" class="room-agent-badge">{{ t('room.reviewReply') }}</span>
                    <time>{{ formatTime(entry.createdAt) }}</time>
                    <span class="room-message-status" :data-status="entry.message.status">{{ statusLabel(entry.message.status) }}</span>
                    <span v-if="turnUsage(entry.message)" class="room-turn-usage">{{ turnUsage(entry.message) }}</span>
                  </header>
                  <details v-if="liveFor(entry.message)?.reasoning" class="room-reasoning">
                    <summary>{{ t('room.thinking') }}</summary>
                    <p>{{ liveFor(entry.message).reasoning }}</p>
                  </details>
                  <MarkdownMessage
                    v-if="entry.message.content"
                    :content="entry.message.content"
                    :class="{ 'room-message-streaming': isWorking(entry.message) }"
                  />
                  <MarkdownMessage
                    v-else-if="liveFor(entry.message)?.text"
                    class="room-live-output"
                    :class="{ 'room-message-streaming': isWorking(entry.message) }"
                    :content="liveFor(entry.message).text"
                    aria-live="polite"
                  />
                  <p v-else-if="isWorking(entry.message) && !entry.handoffs.length" class="room-live-output" aria-live="polite">{{ t('room.liveOutput') }}</p>
                  <MarkdownMessage
                    v-for="handoff in entry.handoffs"
                    :key="handoff.message.id"
                    class="room-message-handoff"
                    :content="handoff.message.content"
                  />
                  <div v-if="entry.mentions.length" class="room-mention-row">
                    <span v-for="name in entry.mentions" :key="name" class="room-mention-chip">@{{ name }}</span>
                  </div>
                  <div v-if="rosterRoles(entry).length" class="room-roster" :aria-label="t('room.roster')">
                    <button
                      v-for="role in rosterRoles(entry)"
                      :key="role.id"
                      class="room-roster-card"
                      type="button"
                      :aria-label="`${t('room.configureRole')}: ${roleLabel(role)}`"
                      @click="openRoleSettings(role.id)"
                    >
                      <img v-if="role.provider" :src="agentLogo(role.provider)" alt="" />
                      <span class="room-roster-name">{{ roleLabel(role) }}</span>
                      <span v-if="role.responsibilities" class="room-roster-duty">{{ role.responsibilities }}</span>
                    </button>
                  </div>
                  <RoomRunTrace
                    v-if="entry.message.author_type === 'agent'"
                    :api="api"
                    :room-id="roomId"
                    :chat-id="chatId"
                    :run-id="entry.message.id"
                    :live="liveFor(entry.message)"
                  />
                  <div v-if="entry.message.status === 'waiting_for_input'" class="room-actions">
                    <span class="room-muted">{{ t('room.waitingForInput') }}</span>
                  </div>
                  <div v-if="canStop(entry.message)" class="room-actions">
                    <button class="secondary-button" type="button" :disabled="busy" @click="stopReply(entry.message.id)">{{ t('room.stop') }}</button>
                  </div>
                </div>
                <span v-if="entry.isUser" class="room-message-avatar room-user-avatar" :aria-label="t('room.you')"><PersonOutline /></span>
              </article>

              <article v-else-if="entry.kind === 'report'" class="room-message room-report-card">
                <div class="room-message-body">
                  <header>
                    <strong>{{ t('room.report') }} · {{ reportKindLabel(entry.report.kind) }}</strong>
                    <time>{{ formatTime(entry.report.created_at) }}</time>
                  </header>
                  <p class="room-report-task">{{ taskLabel(taskForReport(entry.report)) }}</p>
                  <p>{{ entry.report.summary }}</p>
                  <ul v-if="entry.report.evidence.length">
                    <li v-for="(evidence, index) in entry.report.evidence" :key="index">{{ evidence }}</li>
                  </ul>
                  <p v-if="entry.report.artifact_ids.length" class="room-muted">
                    {{ t('room.artifacts') }}: {{ entry.report.artifact_ids.join(' · ') }}
                  </p>
                  <div v-if="canAcceptTask(taskForReport(entry.report))" class="room-actions">
                    <button class="primary-button" type="button" :disabled="busy" @click="acceptTask(entry.report.task_id)">{{ t('room.acceptTask') }}</button>
                  </div>
                </div>
              </article>
            </template>

            <article v-for="attention in attentions" :key="attention.id" class="room-attention-card">
              <header><strong>{{ t('room.needsYou') }}</strong><span>{{ attention.type }}</span></header>
              <p>{{ attention.question }}</p>
              <form @submit.prevent="answer(attention)">
                <select v-if="attention.options?.length" v-model="answers[attention.id]" :aria-label="attention.question" required>
                  <option disabled value="">{{ t('room.chooseAnswer') }}</option>
                  <option v-for="option in attention.options" :key="optionValue(option)" :value="optionValue(option)">{{ optionLabel(option) }}</option>
                </select>
                <input v-else v-model="answers[attention.id]" :aria-label="attention.question" :placeholder="t('room.answer')" required />
                <button class="secondary-button" type="submit" :disabled="busy || !answers[attention.id]">{{ t('room.submit') }}</button>
              </form>
            </article>
          </div>
        </div>
        <div class="room-composer-wrap">
          <div v-if="roles.length" class="room-composer-mentions">
            <span class="room-muted">{{ t('room.mentionHint') }}</span>
            <button
              v-for="role in roles"
              :key="role.id"
              class="room-mention-chip"
              type="button"
              @click="insertMention(role)"
            >
              @{{ roleLabel(role) }}
            </button>
          </div>
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
          <header>
            <strong>{{ taskLabel(task) }}</strong>
            <span>{{ statusLabel(task.status) }}</span>
          </header>
          <p v-if="task.description" class="room-muted">{{ task.description }}</p>
          <p v-if="task.acceptance" class="room-muted">{{ t('room.acceptance') }}: {{ task.acceptance }}</p>
          <div v-if="canAcceptTask(task)" class="room-actions">
            <button class="primary-button" type="button" :disabled="busy" @click="acceptTask(task.id)">{{ t('room.acceptTask') }}</button>
          </div>
          <div class="room-runs">
            <p class="room-runs-title">{{ t('room.runs') }}</p>
            <p v-if="!taskRuns(task.id).length" class="room-muted">{{ t('room.noRuns') }}</p>
            <div v-for="run in taskRuns(task.id)" :key="run.id" class="room-run-entry">
              <p class="room-run-row">
                <span>{{ roleName(run.role_id) }}</span>
                <span>{{ run.lane_kind === 'mention' ? t('room.mentionLane') : t('room.executorLane') }}</span>
                <span :data-status="run.status">{{ statusLabel(run.status) }}</span>
                <span v-if="run.outcome !== 'pending'" class="room-muted">{{ run.outcome }}</span>
              </p>
              <RoomRunTrace :api="api" :room-id="roomId" :chat-id="chatId" :run-id="run.id" />
            </div>
          </div>
          <div v-if="taskReports(task.id).length" class="room-reports">
            <p v-for="report in taskReports(task.id)" :key="report.id" class="room-report-row">
              <strong>{{ reportKindLabel(report.kind) }}</strong>
              <span>{{ report.summary }}</span>
            </p>
          </div>
        </article>

        <template v-if="reviews.length">
          <h2>{{ t('room.captainReviews') }}</h2>
          <article v-for="review in reviews" :key="review.id" class="room-card room-review-card">
            <header>
              <strong>{{ reviewKindLabel(review.kind) }}</strong>
              <span :data-status="review.status">{{ statusLabel(review.status) }}</span>
            </header>
            <time class="room-muted">{{ formatTime(review.created_at) }}</time>
          </article>
        </template>

        <template v-if="captainAssignments.length">
          <h2>{{ t('room.captainAssignments') }}</h2>
          <article v-for="assignment in captainAssignments" :key="assignment.id" class="room-card">
            <header>
              <strong>{{ t('room.captainAssignment') }}</strong>
              <span :data-status="assignment.status">{{ statusLabel(assignment.status) }}</span>
            </header>
            <p class="room-muted">{{ assignmentTargetNames(assignment) }}</p>
            <time class="room-muted">{{ formatTime(assignment.created_at) }}</time>
          </article>
        </template>

        <template v-if="artifacts.length">
          <h2>{{ t('room.artifacts') }}</h2>
          <article v-for="artifact in artifacts" :key="artifact.id" class="room-card room-artifact-entry">
            <header>
              <strong>{{ artifact.path }}</strong>
              <span :data-status="artifact.status">{{ statusLabel(artifact.status) }}</span>
            </header>
            <p class="room-muted">{{ artifact.kind }} · {{ artifact.version }}</p>
            <p v-if="tasksById.get(artifact.task_id)" class="room-muted">{{ taskLabel(tasksById.get(artifact.task_id)) }}</p>
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
        <p v-if="error || pickerError" class="room-error" role="alert">{{ t('room.error') }}</p>
        <label>{{ t('room.name') }}<input v-model="name" maxlength="120" required /></label>
        <div class="room-directory">
          <button class="secondary-button" type="button" :disabled="busy || picking" @click="chooseDirectory">{{ t('room.chooseDirectory') }}</button>
          <span>{{ directory || t('room.noDirectory') }}</span>
        </div>
        <p v-if="!availableAgents.length" class="room-error">{{ t('room.noProviders') }}</p>
        <div v-else class="room-provider-picker">
          <span>{{ t('room.availableAgents') }}</span>
          <label v-for="agent in availableAgents" :key="agent.kind" class="room-provider-option">
            <input v-model="selectedProviders" type="checkbox" :value="agent.kind" />
            <img :src="agentLogo(agent.kind)" alt="" />
            <span>{{ agent.label || providerLabel(agent.kind) }}</span>
          </label>
        </div>
        <div class="room-actions">
          <button class="secondary-button" type="button" :disabled="busy" @click="creating = false">{{ t('common.cancel') }}</button>
          <button class="primary-button" :disabled="busy || picking || !canCreate">{{ t('room.create') }}</button>
        </div>
      </form>
    </div>

    <div v-show="settingsOpen" class="room-modal-backdrop room-settings-backdrop" @click.self="closeProjectSettings" @wheel.self.prevent>
      <aside ref="settingsRef" class="room-settings-modal room-project-settings-modal" role="dialog" aria-modal="true" :aria-label="t('room.projectSettings')" tabindex="-1" @keydown.esc.stop="closeProjectSettings">
        <header class="room-settings-header">
          <div>
            <strong>{{ t('room.projectSettings') }}</strong>
            <span v-if="snapshot">{{ snapshot.room.name }}</span>
          </div>
          <button class="secondary-button" type="button" @click="closeProjectSettings">{{ t('common.close') }}</button>
        </header>
        <div class="room-settings-body">
          <section class="room-settings-section">
            <div v-if="snapshot" class="room-overview" :aria-label="t('room.overview')">
              <div><strong>{{ t('room.directory') }}</strong><span class="room-workspace-path">{{ snapshot.room.workspace_label || t('room.noDirectory') }}</span></div>
              <div><strong>{{ t('room.availableAgents') }}</strong><span>{{ (snapshot.room.providers || []).map(providerLabel).join(' · ') || t('room.noProviders') }}</span></div>
              <div>
                <strong>{{ t('room.writeAccess') }}</strong>
                <button class="secondary-button" type="button" :disabled="busy" @click="toggleWriteAuthorization">
                  {{ writeAuthorized ? t('room.disableWrite') : t('room.enableWrite') }}
                </button>
                <span class="room-muted">{{ writeAuthorized ? t('room.writeEnabledHint') : t('room.writeDisabledHint') }}</span>
              </div>
            </div>
          </section>
        </div>
      </aside>
    </div>

    <div v-show="chatSettingsOpen" class="room-modal-backdrop room-settings-backdrop" @click.self="closeChatSettings" @wheel.self.prevent>
      <aside ref="chatSettingsRef" class="room-settings-modal room-chat-settings-modal" role="dialog" aria-modal="true" :aria-label="t('room.chatSettings')" tabindex="-1" @keydown.esc.stop="closeChatSettings">
        <header class="room-settings-header">
          <div>
            <strong>{{ t('room.chatSettings') }}</strong>
            <span v-if="chat">{{ chat.title }}</span>
          </div>
          <button class="secondary-button" type="button" @click="closeChatSettings">{{ t('common.close') }}</button>
        </header>
        <div class="room-settings-body">
          <section class="room-settings-section">
            <div class="room-chat-settings">
              <label class="room-setting-field">
                <span>{{ t('room.chat') }}</span>
                <select v-model="chatId" :disabled="busy || !snapshot?.chats?.length">
                  <option v-for="item in snapshot?.chats || []" :key="item.id" :value="item.id">{{ item.title }}</option>
                </select>
              </label>
              <form class="room-new-chat" @submit.prevent="newChat">
                <input v-model="chatTitle" :placeholder="t('room.chatName')" :aria-label="t('room.chatName')" maxlength="120" />
                <button class="secondary-button" :disabled="busy || !chatTitle.trim()">{{ t('room.newChat') }}</button>
              </form>
              <p class="room-muted">{{ t('room.newChatInheritHint') }}</p>
              <button
                v-if="snapshot && snapshot.chats.length > 1 && chatId !== snapshot.room.primary_chat_id"
                class="danger-button"
                type="button"
                :disabled="busy"
                @click="removeCurrentChat"
              >
                {{ t('room.deleteChat') }}
              </button>
            </div>
          </section>
        </div>
      </aside>
    </div>

    <div v-if="roleSettingsOpen" class="room-modal-backdrop room-role-backdrop" @click.self="closeRoleSettings" @wheel.self.prevent>
      <section ref="roleSettingsRef" class="room-role-modal room-role-modal-v2" role="dialog" aria-modal="true" :aria-label="t('room.roleSettings')" tabindex="-1" @keydown.esc.stop="closeRoleSettings">
        <header class="room-role-v2-header">
          <div class="room-role-v2-title">
            <span>{{ t('room.roleSettings') }}</span>
            <strong>{{ roleDraft?.displayName || t('room.addAgent') }}</strong>
          </div>
          <div class="room-role-v2-close">
            <button v-if="roleDraft?.id" class="room-icon-button room-role-delete-button" type="button" :title="t('room.deleteRole', { name: roleDraft.displayName })" :aria-label="t('room.deleteRole', { name: roleDraft.displayName })" @click="roleDeleteArmed = true">
              <TrashOutline />
            </button>
            <button class="room-icon-button" type="button" :aria-label="t('common.close')" @click="closeRoleSettings">
              <CloseOutline />
            </button>
          </div>
        </header>
        <div v-if="roleDraft" class="room-role-v2-body">
          <aside class="room-role-v2-side">
            <div class="room-role-v2-profile">
              <div class="room-role-v2-avatar">
                <img v-if="roleDraft.provider" :src="agentLogo(roleDraft.provider)" alt="" />
                <span v-else>{{ (roleDraft.displayName || '?').slice(0, 1) }}</span>
              </div>
              <label class="room-role-v2-name">
                <input v-model="roleDraft.displayName" maxlength="120" :aria-label="t('room.roleName')" />
                <PencilOutline aria-hidden="true" />
              </label>
              <span class="room-role-v2-provider-label">{{ providerLabel(roleDraft.provider) }}</span>
              <span v-if="roleDraft.provider && !canSpeak(roleDraft.provider)" class="room-agent-quiet">{{ t('room.cannotSpeak') }}</span>
              <div class="room-role-v2-provider-icons" role="group" :aria-label="t('room.agent')">
                <button
                  v-for="provider in roleProviders"
                  :key="provider"
                  class="room-role-provider-choice"
                  :class="{ active: roleDraft.provider === provider }"
                  type="button"
                  :data-provider="provider"
                  :title="providerChoiceTitle(provider)"
                  :aria-label="providerChoiceTitle(provider)"
                  @click="changeRoleProvider(provider)"
                >
                  <img :src="agentLogo(provider)" alt="" />
                </button>
              </div>
              <textarea
                v-model="roleDraft.responsibilities"
                class="room-role-v2-intro"
                :aria-label="t('room.roleResponsibilities')"
                :placeholder="t('room.noResponsibilities')"
                rows="3"
                maxlength="4000"
              />
              <button
                class="room-role-controller-toggle"
                :class="{ active: roleDraft.isCaptain }"
                type="button"
                :aria-pressed="roleDraft.isCaptain"
                @click="roleDraft.isCaptain = !roleDraft.isCaptain"
              >
                <span class="room-role-controller-switch" aria-hidden="true" />
                <span>{{ roleDraft.isCaptain ? t('room.isCaptain') : t('room.makeCaptain') }}</span>
              </button>
            </div>
          </aside>
          <div class="room-role-v2-form">
            <section class="room-role-v2-section">
              <h3>{{ t('room.rolePrompt') }}</h3>
              <div class="room-role-prompt-wrap">
                <textarea v-model="roleDraft.prompt" class="room-role-prompt" rows="6" maxlength="100000" :placeholder="t('room.rolePromptHint')" />
              </div>
            </section>
            <section class="room-role-v2-section">
              <h3>{{ t('room.nativePermission') }}</h3>
              <div class="room-mini-options">
                <label
                  v-for="mode in permissionModesFor(roleDraft.provider)"
                  :key="mode.id"
                  class="room-mini-option"
                  :class="{ active: roleDraft.nativePermission === mode.id }"
                >
                  <input v-model="roleDraft.nativePermission" type="radio" :value="mode.id" />
                  <span>{{ permissionModeLabel(mode) }}</span>
                </label>
              </div>
              <p class="room-mini-empty">{{ t('room.nativePermissionHint') }}</p>
            </section>
            <p v-if="error" class="room-error room-role-v2-error" role="alert">{{ t('room.roleSaveError') }}</p>
          </div>
        </div>
        <div v-if="roleDeleteArmed && roleDraft?.id" class="room-role-delete-confirm" role="alertdialog" :aria-label="t('room.deleteRole', { name: roleDraft.displayName })">
          <span>{{ t('room.deleteRoleConfirm', { name: roleDraft.displayName }) }}</span>
          <button class="secondary-button compact" type="button" @click="roleDeleteArmed = false">{{ t('common.cancel') }}</button>
          <button class="danger-button" type="button" :disabled="busy" @click="removeRole">{{ t('room.deleteConfirm') }}</button>
        </div>
        <footer class="room-role-v2-footer">
          <button class="secondary-button" type="button" @click="closeRoleSettings">{{ t('common.cancel') }}</button>
          <button class="primary-button" type="button" :disabled="busy || !canSaveRole" @click="saveRole">{{ t(roleDraft?.id ? 'room.saveRole' : 'room.createRole') }}</button>
        </footer>
      </section>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AddOutline,
  ChevronDownOutline,
  CloseOutline,
  FolderOutline,
  PencilOutline,
  PersonOutline,
  PulseOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { agentLogo } from '../catalog.js'
import { t } from '../i18n.js'
import { useRoomWorkspace } from '../composables/useRoomWorkspace.js'
import { agentUsageRows, formatUsageLine } from '../room-usage.js'
import MarkdownMessage from './MarkdownMessage.vue'
import RoomRunTrace from './RoomRunTrace.vue'

const props = defineProps({
  api: { type: Object, required: true },
  pickDirectory: { type: Function, required: true },
  agents: { type: Array, default: () => [] },
  createRequest: { type: Boolean, default: false },
  openRequest: { type: Object, default: null },
  filesOpen: { type: Boolean, default: false },
  usageOpen: { type: Boolean, default: false },
})
const emit = defineEmits(['create-request-consumed', 'active-change', 'toggle-files', 'toggle-usage', 'usage-change'])

const {
  rooms,
  snapshot,
  roomId,
  chatId,
  chat,
  tasks,
  roles,
  captainAssignments,
  runs,
  reports,
  reviews,
  attentions,
  artifacts,
  messages,
  liveRuns,
  usageByRun,
  hasOlderMessages,
  loadingOlderMessages,
  busy,
  error,
  writeAuthorized,
  load,
  refresh,
  openRoom,
  createRoom,
  createChat,
  deleteChat,
  send,
  loadOlderMessages,
  acceptTask: acceptTaskCommand,
  stopReply: stopReplyCommand,
  answerAttention,
  setWriteAuthorized,
  createRole,
  updateRole,
  setCaptain,
  deleteRole,
} = useRoomWorkspace({ api: props.api })

const FALLBACK_PERMISSION_MODES = {
  claude: [
    { id: 'plan', label: 'Plan', description: 'Read and analyze without editing files.', risk: 'low' },
    { id: 'acceptEdits', label: 'Accept Edits', description: 'Automatically accept file edits.', risk: 'medium' },
    { id: 'bypassPermissions', label: 'Bypass Permissions', description: 'Skip native permission checks.', risk: 'high' },
  ],
  codex: [
    { id: 'read-only', label: 'Read Only', description: 'Read files without writing.', risk: 'low' },
    { id: 'workspace-write', label: 'Workspace Write', description: 'Read and write inside the workspace sandbox.', risk: 'medium' },
    { id: 'danger-full-access', label: 'Danger Full Access', description: 'Disable the Codex sandbox.', risk: 'high' },
  ],
  default: [{ id: 'default', label: 'Native Configuration', description: 'Use the provider native permissions.', risk: 'medium' }],
}

const creating = ref(false)
const settingsOpen = ref(false)
const settingsRef = ref(null)
const chatSettingsOpen = ref(false)
const chatSettingsRef = ref(null)
const roleSettingsOpen = ref(false)
const roleSettingsRef = ref(null)
const roleDraft = ref(null)
const roleSettingsWasCaptain = ref(false)
const roleDeleteArmed = ref(false)
const workPanelOpen = ref(true)
const name = ref('')
const directory = ref('')
const chatTitle = ref('')
const draft = ref('')
const answers = ref({})
const picking = ref(false)
const pickerError = ref(false)
const timeline = ref(null)

const availableAgents = computed(() => props.agents.filter(agent => agent && agent.kind))
const selectedProviders = ref([])
const projectLabel = computed(() => snapshot.value?.room?.name || rooms.value.find(room => room.id === roomId.value)?.name || t('room.title'))
const activeChatLabel = computed(() => {
  const item = chat.value
  if (!item) return snapshot.value ? t('room.chat') : t('room.title')
  return item.id === snapshot.value?.room?.primary_chat_id ? t('room.primaryChat') : item.title
})
const workdirName = computed(() => snapshot.value?.room?.workspace_label || '')
const rolesById = computed(() => new Map(roles.value.map(role => [role.id, role])))
const tasksById = computed(() => new Map((snapshot.value?.tasks || []).map(task => [task.id, task])))

function isHandoff(message) {
  if (!message || message.author_type !== 'agent') return false
  if (message.kind === 'mention') return true
  return !message.reply_to && Array.isArray(message.mentions) && message.mentions.length > 0
}

const entries = computed(() => {
  const list = messages.value.map(message => {
    const role = rolesById.value.get(message.author_id)
    return {
      key: `message:${message.id}`,
      kind: 'message',
      createdAt: message.created_at,
      message,
      isUser: message.author_type === 'user',
      isSystem: message.author_type === 'system',
      isCaptain: role?.is_captain === true,
      isReviewReply: message.data?.reviewReply === true,
      author: message.author_type === 'user'
        ? t('room.you')
        : message.author_type === 'system'
          ? t('room.system')
          : message.author_name || role?.display_name || t('room.system'),
      provider: role?.provider || '',
      mentions: (message.mentions || []).map(id => rolesById.value.get(id)?.display_name).filter(Boolean),
      handoffs: [],
    }
  })
  for (const report of reports.value) {
    list.push({
      key: `report:${report.id}`,
      kind: 'report',
      createdAt: report.created_at,
      report,
    })
  }
  const sorted = list.sort((left, right) => {
    const byTime = String(left.createdAt).localeCompare(String(right.createdAt))
    if (byTime !== 0) return byTime
    // Same-millisecond rows must keep ledger order, never random UUID order.
    if (left.kind !== right.kind) return left.kind === 'message' ? -1 : 1
    const leftSequence = left.message?.sequence ?? 0
    const rightSequence = right.message?.sequence ?? 0
    if (leftSequence !== rightSequence) return leftSequence - rightSequence
    return left.key.localeCompare(right.key)
  })
  const folded = []
  for (const entry of sorted) {
    const previous = folded.at(-1)
    const sameAuthor = previous?.kind === 'message'
      && entry.kind === 'message'
      && previous.message.author_type === 'agent'
      && previous.message.author_id === entry.message.author_id
    if (sameAuthor && isHandoff(entry.message)) {
      previous.handoffs.push(entry)
      previous.mentions = [...new Set([...previous.mentions, ...entry.mentions])]
      continue
    }
    folded.push(entry)
  }
  return folded
})

const agentUsage = computed(() => agentUsageRows({
  roles: roles.value,
  messages: messages.value,
  usageByRun: usageByRun.value,
  liveRuns: liveRuns.value,
}))

watch(agentUsage, rows => emit('usage-change', rows), { immediate: true })

function turnUsage(message) {
  if (message?.author_type !== 'agent') return ''
  return formatUsageLine(liveFor(message)?.usage || usageByRun.value[message.id])
}

const workCount = computed(() => (
  tasks.value.length
  + reviews.value.length
  + captainAssignments.value.length
  + attentions.value.length
  + artifacts.value.length
))
const hasWork = computed(() => workCount.value > 0)
const showWorkPanel = computed(() => workPanelOpen.value && hasWork.value)
const canCreate = computed(() => Boolean(name.value.trim() && directory.value && selectedProviders.value.length))

const roleProviders = computed(() => {
  const room = snapshot.value?.room
  const launch = Array.isArray(room?.launch_providers) ? room.launch_providers : []
  const enabled = Array.isArray(room?.providers) ? room.providers : []
  const providers = []
  for (const provider of [...launch, ...enabled]) {
    if (provider && !providers.includes(provider)) providers.push(provider)
  }
  return providers
})
const canSaveRole = computed(() => Boolean(
  roleDraft.value
  && roleDraft.value.displayName.trim()
  && roleDraft.value.provider
  && roleProviders.value.includes(roleDraft.value.provider),
))

function defaultPermission(provider) {
  return permissionModesFor(provider)[0]?.id || 'default'
}

function permissionModesFor(provider) {
  return FALLBACK_PERMISSION_MODES[provider] || FALLBACK_PERMISSION_MODES.default
}

function permissionModeLabel(mode) {
  const key = `room.nativePermissionMode.${mode.id}`
  const label = t(key)
  return label === key ? mode.label : label
}

function roleLabel(role) {
  return role?.display_name || role?.id || ''
}

function rosterRoles(entry) {
  const ids = entry?.message?.data?.roleIds
  if (!Array.isArray(ids)) return []
  return ids.map(id => rolesById.value.get(id)).filter(Boolean)
}

function roleName(roleId) {
  return rolesById.value.get(roleId)?.display_name || roleId || ''
}

function assignmentTargetNames(assignment) {
  return (assignment?.target_role_ids || []).map(roleName).filter(Boolean).join(' · ')
}

function canSpeak(provider) {
  const list = snapshot.value?.room?.launch_providers
  if (!Array.isArray(list)) return true
  return list.includes(provider)
}

function agentTitle(role) {
  const base = `${roleLabel(role)} · ${providerLabel(role.provider)}`
  return role?.provider && !canSpeak(role.provider) ? `${base} · ${t('room.cannotSpeak')}` : base
}

function providerChoiceTitle(provider) {
  const label = providerLabel(provider)
  return canSpeak(provider) ? label : `${label} · ${t('room.cannotSpeak')}`
}

function providerLabel(provider) {
  return availableAgents.value.find(agent => agent.kind === provider)?.label
    || String(provider || '').replace(/^\w/, letter => letter.toUpperCase())
    || ''
}

function statusLabel(status) {
  const value = String(status || '')
  if (!value) return ''
  const key = `room.status.${value}`
  const label = t(key)
  return label === key ? value : label
}

function reportKindLabel(kind) {
  const key = `room.reportKind.${kind}`
  const label = t(key)
  return label === key ? String(kind || '') : label
}

function reviewKindLabel(kind) {
  const key = `room.reviewKind.${kind}`
  const label = t(key)
  return label === key ? String(kind || '') : label
}

function taskLabel(task) {
  if (!task) return ''
  return `#${task.number} ${task.title}`.trim()
}

function taskRuns(taskId) {
  return runs.value.filter(run => run.task_id === taskId)
}

function taskReports(taskId) {
  return reports.value.filter(report => report.task_id === taskId)
}

function taskForReport(report) {
  return tasksById.value.get(report?.task_id) || null
}

function canAcceptTask(task) {
  return task?.status === 'in_review'
}

function isWorking(message) {
  return message.author_type === 'agent' && ['queued', 'working'].includes(message.status)
}

function liveFor(message) {
  return liveRuns.value[message.id] || null
}

function canStop(message) {
  return message.author_type === 'agent'
    && ['queued', 'working', 'waiting_for_input'].includes(message.status)
}

function formatTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function optionValue(option) {
  return String(option?.id ?? option?.value ?? option?.label ?? option ?? '')
}

function optionLabel(option) {
  return String(option?.label ?? option?.name ?? option ?? '')
}

function insertMention(role) {
  const mention = `@${roleLabel(role)} `
  draft.value = draft.value ? `${draft.value.replace(/\s*$/, ' ')}${mention}` : mention
}

async function sendMessage() {
  const content = draft.value.trim()
  if (!content || !chat.value) return
  const result = await send(content)
  if (result) {
    draft.value = ''
    await nextTick()
    timeline.value?.scrollTo?.({ top: timeline.value.scrollHeight })
  }
}

async function reload() {
  pickerError.value = false
  await load()
  await refresh()
}

async function loadEarlierMessages() {
  await loadOlderMessages()
}

async function acceptTask(taskId) {
  await acceptTaskCommand(taskId)
}

async function stopReply(replyId) {
  await stopReplyCommand(replyId)
}

async function answer(attention) {
  const resolution = String(answers.value[attention.id] || '').trim()
  if (!resolution) return
  const result = await answerAttention(attention.id, resolution)
  if (result) delete answers.value[attention.id]
}

function startCreating() {
  pickerError.value = false
  directory.value = ''
  name.value = ''
  selectedProviders.value = availableAgents.value.slice(0, 1).map(agent => agent.kind)
  creating.value = true
}

async function chooseDirectory() {
  if (picking.value) return
  picking.value = true
  pickerError.value = false
  try {
    const selected = await props.pickDirectory()
    if (selected) directory.value = String(selected)
  } catch {
    pickerError.value = true
  } finally {
    picking.value = false
  }
}

async function create() {
  if (!canCreate.value) return
  const providers = [...selectedProviders.value]
  const roles = providers.map((provider, index) => ({
    displayName: availableAgents.value.find(agent => agent.kind === provider)?.label || provider,
    provider,
    prompt: '',
    isCaptain: index === 0,
  }))
  const result = await createRoom({
    name: name.value.trim(),
    workspace: directory.value,
    title: name.value.trim(),
    providers,
    roles,
  })
  if (result) {
    creating.value = false
    name.value = ''
    directory.value = ''
  }
}

function openProjectSettings() {
  settingsOpen.value = true
  nextTick(() => settingsRef.value?.focus?.())
}

function closeProjectSettings() {
  settingsOpen.value = false
}

async function toggleWriteAuthorization() {
  await setWriteAuthorized(!writeAuthorized.value)
}

function openChatSettings() {
  chatSettingsOpen.value = true
  chatTitle.value = ''
  nextTick(() => chatSettingsRef.value?.focus?.())
}

function closeChatSettings() {
  chatSettingsOpen.value = false
}

async function newChat() {
  const title = chatTitle.value.trim()
  if (!title) return
  const result = await createChat(title)
  if (result) chatTitle.value = ''
}

async function removeCurrentChat() {
  if (!chatId.value) return
  await deleteChat(chatId.value)
}

function openNewRole() {
  roleDeleteArmed.value = false
  roleSettingsWasCaptain.value = false
  roleDraft.value = {
    id: '',
    displayName: '',
    provider: roleProviders.value[0] || '',
    prompt: '',
    responsibilities: '',
    isCaptain: !roles.value.some(role => role.is_captain),
    nativePermission: defaultPermission(roleProviders.value[0] || ''),
  }
  roleSettingsOpen.value = true
  nextTick(() => roleSettingsRef.value?.focus?.())
}

function openRoleSettings(roleId) {
  const role = roles.value.find(item => item.id === roleId)
  if (!role) return
  roleDeleteArmed.value = false
  roleSettingsWasCaptain.value = role.is_captain === true
  roleDraft.value = {
    id: role.id,
    displayName: role.display_name || '',
    provider: role.provider || '',
    prompt: role.prompt || '',
    responsibilities: role.responsibilities || '',
    isCaptain: role.is_captain === true,
    nativePermission: role.native_permission || defaultPermission(role.provider || ''),
  }
  roleSettingsOpen.value = true
  nextTick(() => roleSettingsRef.value?.focus?.())
}

function changeRoleProvider(provider) {
  if (!roleDraft.value || roleDraft.value.provider === provider) return
  roleDraft.value.provider = provider
  roleDraft.value.nativePermission = defaultPermission(provider)
}

function closeRoleSettings() {
  roleSettingsOpen.value = false
  roleDeleteArmed.value = false
  roleDraft.value = null
}

async function saveRole() {
  if (!canSaveRole.value) return
  const wantsCaptain = roleDraft.value.isCaptain === true
  const payload = {
    displayName: roleDraft.value.displayName.trim(),
    provider: roleDraft.value.provider,
    prompt: roleDraft.value.prompt,
    responsibilities: roleDraft.value.responsibilities,
    nativePermission: roleDraft.value.nativePermission,
  }
  if (roleDraft.value.id) {
    // Save normal fields first, then swap the chat-level Captain atomically.
    // This keeps a custom prompt and avoids the "two Captains" intermediate
    // state that the old two-save flow exposed.
    const result = await updateRole(roleDraft.value.id, {
      ...payload,
      isCaptain: wantsCaptain && roleSettingsWasCaptain.value,
    })
    if (!result) return
    if (wantsCaptain && !roleSettingsWasCaptain.value) {
      const swapped = await setCaptain(roleDraft.value.id)
      if (!swapped) return
    }
    closeRoleSettings()
    return
  }
  const result = await createRole({ ...payload, isCaptain: false })
  if (!result) return
  if (wantsCaptain) {
    const swapped = await setCaptain(result.roleId)
    if (!swapped) return
  }
  closeRoleSettings()
}

async function removeRole() {
  if (!roleDraft.value?.id) return
  const result = await deleteRole(roleDraft.value.id)
  if (result) closeRoleSettings()
}

function scrollToAttention() {
  document.querySelector('.room-attention-card')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
}

function handleEscape(event) {
  if (event.key !== 'Escape') return
  if (roleSettingsOpen.value) {
    event.preventDefault()
    closeRoleSettings()
  } else if (chatSettingsOpen.value) {
    event.preventDefault()
    closeChatSettings()
  } else if (settingsOpen.value) {
    event.preventDefault()
    closeProjectSettings()
  } else if (creating.value) {
    event.preventDefault()
    creating.value = false
  }
}

watch(creating, (open) => {
  if (!open) return
  const previous = document.activeElement
  nextTick(() => {
    if (previous?.blur) previous.blur()
  })
})

watch([roomId, chatId], ([nextRoom, nextChat]) => {
  if (!nextRoom) return
  emit('active-change', { roomId: nextRoom, chatId: nextChat })
})

watch(() => props.createRequest, (requested) => {
  if (!requested) return
  emit('create-request-consumed')
  startCreating()
}, { immediate: true, flush: 'post' })

watch(() => props.openRequest, (request) => {
  if (!request?.roomId) return
  void openRoom(request.roomId, request.chatId)
}, { immediate: true, flush: 'post' })

watch([creating, settingsOpen, chatSettingsOpen, roleSettingsOpen], (values) => {
  document.body.classList.toggle('room-overlay-open', values.some(Boolean))
})

onMounted(() => {
  window.addEventListener('keydown', handleEscape)
  void load()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscape)
  document.body.classList.remove('room-overlay-open')
})
</script>
<style scoped>
.room-workspace { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; padding: 0; gap: 0; background: var(--surface); color: var(--text); }
.room-toolbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px clamp(16px, 3vw, 28px); border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 94%, var(--surface-raised)); }
.room-heading { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.room-project-name { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: transparent; color: var(--faint); font-size: var(--text-2xs); cursor: pointer; }
.room-project-name svg { width: 12px; height: 12px; }
.room-project-name:hover, .room-project-name:focus-visible { outline: none; color: var(--accent-text); }
.room-title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.room-title-row h1 { margin: 0; font-size: var(--text-xl); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.room-chat-title { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.room-chat-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room-chat-title svg { width: 14px; height: 14px; flex: 0 0 14px; color: var(--faint); }
.room-chat-title:hover, .room-chat-title:focus-visible { outline: none; color: var(--accent-text); }
.room-chat-title:hover svg, .room-chat-title:focus-visible svg { color: var(--accent-text); }
.room-subtitle { max-width: 34ch; overflow: hidden; color: var(--faint); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.room-agent-strip { display: flex; flex: 1 1 auto; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.room-roster { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.room-roster-card { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; width: 168px; max-width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-raised); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.room-roster-card:hover { border-color: var(--border-strong); background: var(--surface-hover); }
.room-roster-card img { width: 22px; height: 22px; object-fit: contain; }
.room-roster-name { max-width: 100%; overflow: hidden; font-size: var(--text-sm); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.room-roster-duty { display: -webkit-box; overflow: hidden; color: var(--text-soft); font-size: var(--text-2xs); line-height: 1.4; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.room-agent-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 320px; padding: 4px 9px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-raised); color: inherit; font: inherit; font-size: var(--text-xs); cursor: pointer; }
.room-agent-chip:hover { border-color: var(--border-strong); background: var(--surface-hover); }
.room-agent-chip img { width: 16px; height: 16px; flex: 0 0 16px; object-fit: contain; }
.room-agent-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room-agent-quiet { color: var(--text-muted); font-size: var(--text-xs); }
.room-agent-badge { flex: 0 0 auto; margin-left: 2px; padding: 1px 5px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-text); font-size: 10px; font-weight: 600; }
.room-agent-idle { flex: 1 1 auto; color: var(--faint); font-size: var(--text-xs); }
.room-agent-add { width: 28px; height: 28px; flex: 0 0 28px; display: inline-grid; place-items: center; padding: 0; border: 1px dashed var(--border); border-radius: 999px; background: transparent; color: var(--muted); cursor: pointer; }
.room-agent-add svg { width: 15px; height: 15px; }
.room-agent-add:hover, .room-agent-add:focus-visible { outline: none; border-color: var(--accent); color: var(--accent); }
.room-agent-add:disabled { opacity: 0.45; cursor: not-allowed; }
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
.room-message header { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: baseline; margin-bottom: 4px; }
.room-message header strong { font-size: var(--text-sm); }
.room-message time { color: var(--faint); font-size: var(--text-2xs); }
.room-message p { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.65; }
.room-message ul { margin: 8px 0 0; padding-left: 18px; color: var(--text-soft); font-size: var(--text-xs); line-height: 1.55; }
.room-report .room-message-body { padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-raised); }
.room-message-controller .room-message-body { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border)); border-radius: 12px; background: color-mix(in srgb, var(--accent-soft) 34%, var(--surface-raised)); }
.room-message-trace { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); font-size: var(--text-xs); }
.room-message-trace summary { cursor: pointer; color: var(--text-soft); }
.room-message-trace .room-trace-list { margin: 8px 0 0; }
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
.room-live-output:not(.markdown-body) { max-height: 12rem; overflow: auto; padding: 8px; border-radius: 8px; background: color-mix(in srgb, var(--border) 18%, transparent); white-space: pre-wrap; }
.room-message .markdown-body { overflow-wrap: anywhere; line-height: 1.65; }
.room-message .markdown-body p { margin: 0 0 0.6em; white-space: normal; }
.room-message .markdown-body p:last-child { margin-bottom: 0; }
.room-message .markdown-body table { width: 100%; border-collapse: collapse; margin: 0.4em 0 0.8em; font-size: var(--text-xs); }
.room-message .markdown-body th, .room-message .markdown-body td { padding: 6px 8px; border: 1px solid var(--border); text-align: left; vertical-align: top; }
.room-message .markdown-body th { color: var(--text-soft); font-weight: 600; }
.room-message-streaming::after { content: ""; display: inline-block; width: 7px; height: 0.95em; margin-left: 3px; background: var(--accent); vertical-align: text-bottom; animation: room-caret 1s steps(1) infinite; }
.room-message-handoff { margin-top: 10px; }
@keyframes room-caret { 50% { opacity: 0; } }
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
.room-project-settings-modal, .room-chat-settings-modal { width: min(720px, 100%); }
.room-role-modal { display: flex; flex-direction: column; width: min(920px, 100%); max-height: calc(100vh - 40px); overflow: hidden; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-raised); box-shadow: 0 24px 70px rgb(0 0 0 / 0.28); outline: none; }
.room-role-modal-v2 { width: min(960px, 100%); }
.room-role-v2-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px 22px; border-bottom: 1px solid var(--border); }
.room-role-v2-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.room-role-v2-title > span { color: var(--faint); font-size: var(--text-2xs); }
.room-role-v2-title > strong { display: flex; align-items: center; gap: 6px; overflow-wrap: anywhere; font-size: var(--text-lg); }
.room-role-v2-close { display: flex; align-items: center; gap: 8px; }
.room-role-delete-button:hover, .room-role-delete-button:focus-visible { border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); color: var(--danger); }
.room-role-delete-confirm { display: flex; align-items: center; gap: 8px; padding: 10px 22px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--danger) 7%, var(--surface-raised)); font-size: var(--text-xs); }
.room-role-delete-confirm > span { flex: 1; color: var(--text-soft); }
.room-role-v2-body { display: grid; flex: 1; grid-template-columns: 280px minmax(0, 1fr); min-height: 0; overflow: hidden; }
.room-role-v2-side { overflow: auto; padding: 18px; border-right: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 72%, var(--surface-raised)); }
.room-role-v2-profile { display: flex; flex-direction: column; gap: 10px; padding: 18px 16px; border: 1px solid var(--border); border-radius: 16px; background: color-mix(in srgb, var(--surface-raised) 70%, transparent); }
.room-role-v2-avatar { display: grid; place-items: center; width: 150px; height: 150px; margin: 0 auto 4px; border: 1px solid color-mix(in srgb, var(--border-strong) 78%, transparent); border-radius: 50%; background: radial-gradient(circle at 38% 30%, color-mix(in srgb, var(--surface-active) 88%, var(--accent-soft)), var(--surface)); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.04); }
.room-role-v2-avatar img { width: 76px; height: 76px; object-fit: contain; }
.room-role-v2-avatar span { color: var(--text-soft); font-size: var(--text-3xl); font-weight: 600; }
.room-role-v2-name { position: relative; display: block; }
.room-role-v2-name input { width: 100%; padding: 5px 22px 5px 6px; border-color: transparent; background: transparent; text-align: center; font-size: var(--text-lg); font-weight: 600; }
.room-role-v2-name input:hover, .room-role-v2-name input:focus { border-color: var(--border); background: var(--surface); }
.room-role-v2-name svg { position: absolute; top: 50%; right: 7px; width: 13px; height: 13px; color: var(--faint); transform: translateY(-50%); pointer-events: none; }
.room-role-v2-provider-label { color: var(--faint); font-size: var(--text-xs); text-align: center; }
.room-role-v2-provider-icons { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin: 2px 0 4px; }
.room-role-provider-choice { width: 38px; height: 38px; display: inline-grid; place-items: center; padding: 0; border: 1px solid var(--border); border-radius: 50%; background: var(--surface); cursor: pointer; }
.room-role-provider-choice img { width: 22px; height: 22px; object-fit: contain; }
.room-role-provider-choice:hover, .room-role-provider-choice:focus-visible { outline: none; border-color: var(--border-strong); }
.room-role-provider-choice.active { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 14%, transparent); }
.room-role-v2-intro { width: 100%; min-height: 72px; padding: 8px 9px; border-color: transparent; background: transparent; color: var(--text-soft); font-size: var(--text-xs); line-height: 1.55; resize: vertical; }
.room-role-v2-intro:hover, .room-role-v2-intro:focus { border-color: var(--border); background: var(--surface); }
.room-role-controller-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 9px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); color: var(--text-soft); font-family: inherit; font-size: var(--text-2xs); text-align: left; cursor: pointer; }
.room-role-controller-toggle:hover, .room-role-controller-toggle:focus-visible { outline: none; border-color: var(--border-strong); color: var(--text); }
.room-role-controller-toggle.active { border-color: color-mix(in srgb, var(--accent) 62%, var(--border)); background: var(--accent-soft); color: var(--accent-text); }
.room-role-controller-switch { width: 24px; height: 14px; flex: 0 0 24px; padding: 2px; border-radius: 999px; background: var(--surface-active); box-shadow: inset 0 0 0 1px var(--border); }
.room-role-controller-switch::after { content: ""; display: block; width: 10px; height: 10px; border-radius: 50%; background: var(--muted); transition: transform var(--dur-fast) var(--ease-standard), background var(--dur-fast) var(--ease-standard); }
.room-role-controller-toggle.active .room-role-controller-switch { background: color-mix(in srgb, var(--accent) 30%, var(--surface-active)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, var(--border)); }
.room-role-controller-toggle.active .room-role-controller-switch::after { background: var(--accent); transform: translateX(10px); }
.room-role-v2-form { display: flex; flex-direction: column; gap: 18px; min-height: 0; overflow: auto; padding: 22px; }
.room-role-v2-section { display: flex; flex-direction: column; gap: 8px; }
.room-role-v2-section h3 { margin: 0; color: var(--text-soft); font-size: var(--text-xs); font-weight: 600; }
.room-role-v2-section textarea { width: 100%; min-height: 64px; resize: vertical; }
.room-mini-options { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.room-mini-option { position: relative; display: inline-flex; align-items: center; gap: 4px; padding: 4px 9px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-soft); font-family: inherit; font-size: var(--text-2xs); font-weight: 500; line-height: 1.4; cursor: pointer; }
.room-mini-option:hover, .room-mini-option:focus-visible { outline: none; border-color: var(--border-strong); color: var(--text); }
.room-mini-option.active { border-color: color-mix(in srgb, var(--accent) 62%, var(--border)); background: var(--accent-soft); color: var(--accent-text); }
.room-mini-option input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.room-mini-empty { flex: 1 1 220px; color: var(--faint); font-size: var(--text-2xs); line-height: 1.5; }
.room-role-prompt-wrap { position: relative; }
.room-role-prompt-wrap textarea { width: 100%; min-height: 140px; padding-bottom: 26px; resize: vertical; }
.room-role-prompt-count { position: absolute; right: 10px; bottom: 8px; color: var(--faint); font-size: var(--text-2xs); pointer-events: none; }
.room-role-v2-skills .secondary-button { min-height: 28px; padding-inline: 9px; font-size: var(--text-2xs); }
.room-role-v2-footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 14px 22px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 88%, var(--surface-raised)); }
.room-role-v2-error { margin: 0; }
.room-settings-header { display: flex; gap: 12px; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid var(--border); }
.room-settings-header div { display: flex; flex-direction: column; gap: 2px; }
.room-settings-header span { color: var(--faint); font-size: var(--text-2xs); }
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
.room-permissions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); font-size: var(--text-xs); }
.room-permissions label { display: inline-flex; gap: 6px; align-items: center; }
.room-error { color: var(--danger, #b94c4c); font-size: var(--text-xs); }
.room-warning { padding: 8px 10px; border: 1px solid currentColor; border-radius: 8px; color: var(--warning, #9a6700); font-size: var(--text-xs); }
.room-write-required { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; border-color: color-mix(in srgb, var(--accent) 36%, var(--border)); background: color-mix(in srgb, var(--accent-soft) 30%, transparent); color: var(--text-soft); }
.room-write-required .room-actions { margin-left: auto; }
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
  .room-role-v2-body { grid-template-columns: 1fr; overflow: auto; }
  .room-role-v2-side { border-right: 0; border-bottom: 1px solid var(--border); }
}
</style>

<style>
body.room-overlay-open { overflow: hidden; }
</style>

<style scoped>
.room-subtitle-divider { opacity: 0.45; }
.room-subtitle [data-tone="ready"] { color: var(--accent-text); }
.room-message-status { color: var(--faint); font-size: var(--text-2xs); }
.room-message-status[data-status="working"],
.room-message-status[data-status="queued"],
.room-message-status[data-status="starting"] { color: var(--accent-text); }
.room-message-status[data-status="failed"],
.room-message-status[data-status="interrupted"],
.room-message-status[data-status="unknown"] { color: var(--danger, #b94c4c); }
.room-message-system .room-message-body { padding: 4px 0; color: var(--faint); font-size: var(--text-xs); }
.room-message-captain .room-message-body { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border)); border-radius: 12px; background: color-mix(in srgb, var(--accent-soft) 34%, var(--surface-raised)); }
.room-mention-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.room-mention-chip { display: inline-flex; align-items: center; padding: 2px 7px; border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border)); border-radius: 999px; background: var(--accent-soft); color: var(--accent-text); font: inherit; font-size: var(--text-2xs); cursor: pointer; }
.room-composer-mentions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; width: min(920px, 100%); margin: 0 auto 8px; }
.room-report-card .room-message-body { padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-raised); }
.room-report-task { color: var(--faint); font-size: var(--text-2xs); }
.room-runs, .room-reports { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); font-size: var(--text-xs); }
.room-runs-title { color: var(--faint); font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: 0.04em; }
.room-run-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 8px; align-items: baseline; margin: 4px 0; }
.room-run-row > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room-report-row { display: flex; flex-direction: column; gap: 2px; margin: 6px 0; }
.room-review-card p { white-space: pre-wrap; }
.room-provider-picker { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.room-provider-option { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); font-size: var(--text-xs); cursor: pointer; }
.room-provider-option:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.room-provider-option img { width: 16px; height: 16px; object-fit: contain; }
.room-provider-option input { margin: 0; }
@media (max-width: 950px) {
  .room-run-row { grid-template-columns: minmax(0, 1fr) auto auto; }
  .room-run-row > span:nth-child(2) { display: none; }
}
</style>

<style scoped>
.room-turn-usage { margin-left: auto; color: var(--faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.room-run-trace { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border); font-size: var(--text-xs); }
.room-run-trace > summary { display: flex; gap: 8px; align-items: center; color: var(--text-soft); cursor: pointer; }
.room-run-trace-count { padding: 1px 6px; border-radius: 999px; background: var(--surface-active); color: var(--faint); font-size: 10px; }
.room-tool-card { margin-top: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: color-mix(in srgb, var(--surface) 82%, var(--surface-raised)); }
.room-tool-card[data-status="failed"] { border-color: color-mix(in srgb, var(--danger, #b94c4c) 45%, var(--border)); }
.room-tool-card header { display: flex; gap: 8px; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
.room-tool-card header span { color: var(--faint); font-size: var(--text-2xs); }
.room-tool-card details { margin-top: 4px; }
.room-tool-card summary { color: var(--text-soft); cursor: pointer; }
.room-tool-card pre, .room-reasoning p { max-height: 16rem; overflow: auto; margin: 4px 0 0; padding: 7px 8px; border-radius: 6px; background: var(--surface); font-size: var(--text-2xs); white-space: pre-wrap; overflow-wrap: anywhere; }
.room-reasoning { margin-top: 6px; }
.room-reasoning > summary { color: var(--faint); font-size: var(--text-2xs); cursor: pointer; }
.room-usage-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0; color: var(--text-soft); font-size: var(--text-2xs); }
.room-run-entry + .room-run-entry { margin-top: 6px; }
</style>
