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
          :data-speaking="roleSpeaking(role) ? 'true' : undefined"
          :data-quiet="role.provider && !canSpeak(role.provider) ? 'true' : undefined"
          :style="chipStyle(role)"
          :title="agentTitle(role)"
          :aria-label="`${t('room.configureRole')}: ${roleLabel(role)}`"
          @click="openRoleSettings(role.id)"
        >
          <span v-if="role.provider" class="room-chip-face">
            <span class="room-chip-photo">
              <img class="room-portrait" :src="faceSrc(role)" alt="" />
            </span>
            <span v-if="role.is_captain" class="room-captain-mark" :title="t('room.captain')">⚓</span>
          </span>
          <span class="room-chip-name">{{ roleLabel(role) }}</span>
          <span v-if="role.provider && !canSpeak(role.provider)" class="room-agent-mute" aria-hidden="true">🔇</span>
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
              <div v-if="welcomeRoles.length" class="room-welcome-stage">
                <button
                  v-if="welcomeCard"
                  class="room-welcome-card-backdrop"
                  type="button"
                  tabindex="-1"
                  aria-hidden="true"
                  @click="dismissWelcomeCard"
                />
                <div class="room-welcome-team">
                  <button
                    v-for="role in welcomeRoles"
                    :key="role.id"
                    class="room-welcome-face"
                    :class="{ captain: role.is_captain, open: welcomeCard?.id === role.id }"
                    type="button"
                    :aria-expanded="welcomeCard?.id === role.id ? 'true' : 'false'"
                    :aria-label="roleLabel(role)"
                    @click.stop="toggleWelcomeCard(role)"
                  >
                    <img class="room-portrait" :src="faceSrc(role)" alt="" />
                    <span v-if="role.is_captain" class="room-welcome-wave">{{ t('room.welcomeWave') }}</span>
                  </button>
                </div>
                <div v-if="welcomeCard" class="room-welcome-card" role="dialog" :aria-label="roleLabel(welcomeCard)">
                  <header>
                    <strong>{{ roleLabel(welcomeCard) }}</strong>
                    <span v-if="welcomeCard.is_captain" class="room-agent-badge">{{ t('room.captain') }}</span>
                  </header>
                  <dl>
                    <div>
                      <dt>{{ t('room.roleEngine') }}</dt>
                      <dd>{{ providerLabel(welcomeCard.provider) }}</dd>
                    </div>
                    <div>
                      <dt>{{ t('room.nativePermission') }}</dt>
                      <dd>{{ welcomePermission(welcomeCard) }}</dd>
                    </div>
                  </dl>
                  <p v-if="welcomeCard.is_captain">{{ t('room.captainDuty') }}</p>
                  <button class="room-welcome-card-config" type="button" @click="openWelcomeRole">{{ t('room.configureRole') }}</button>
                </div>
              </div>
              <h2>{{ t('room.emptyTitle') }}</h2>
              <p class="room-muted">{{ t('room.emptyHint') }}</p>
              <p v-if="!roles.length" class="room-muted">{{ t('room.teamHint') }}</p>
              <div v-if="welcomePrompts.length" class="room-welcome-prompts">
                <button v-for="prompt in welcomePrompts" :key="prompt" type="button" @click="draft = prompt">{{ prompt }}</button>
              </div>
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
                  <img v-if="entry.provider || entry.portrait" class="room-portrait" :src="rolePortrait(entry.portrait || entry.provider)" alt="" />
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
                  <details v-if="replyThinking(entry.message)" class="room-reasoning">
                    <summary>{{ t('room.thinking') }}</summary>
                    <p>{{ replyThinking(entry.message) }}</p>
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
                      <img v-if="role.provider" class="room-portrait" :src="faceSrc(role)" alt="" />
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
                    :steps="entry.message.data?.trace || null"
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
          <form class="room-composer" @submit.prevent="sendMessage">
            <div v-if="mentionQuery !== null && mentionOptions.length" class="room-mention-menu" role="listbox" :aria-label="t('room.mentionHint')">
              <button
                v-for="role in mentionOptions"
                :key="role.id"
                class="room-mention-option"
                type="button"
                role="option"
                @click="insertMention(role)"
              >
                @{{ roleLabel(role) }}
              </button>
            </div>
            <button
              class="room-composer-tool"
              type="button"
              :title="t('room.mentionHint')"
              :aria-label="t('room.mentionHint')"
              :disabled="busy || !roles.length"
              @click="focusComposer"
            >
              <AtOutline />
            </button>
            <div class="room-composer-field">
              <textarea
                ref="composerInput"
                v-model="draft"
                :placeholder="t('room.messageHint')"
                :aria-label="t('room.message')"
                rows="1"
                maxlength="100000"
                :disabled="busy || !chat"
                @keydown="handleComposerKeydown"
              />
            </div>
            <button class="room-composer-send" type="submit" :aria-label="t('room.send')" :disabled="busy || !draft.trim() || !chat">
              <SendOutline />
            </button>
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
            <strong>
              {{ roleDraft?.displayName || t('room.addAgent') }}
              <span v-if="roleDraft?.isCaptain" class="room-agent-badge">{{ t('room.captain') }}</span>
            </strong>
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
                <img v-if="roleDraft.portrait || roleDraft.provider" class="room-portrait" :src="rolePortrait(roleDraft.portrait || roleDraft.provider)" alt="" />
                <span v-else>{{ (roleDraft.displayName || '?').slice(0, 1) }}</span>
              </div>
              <h3 class="room-role-v2-heading">{{ t('room.rolePortrait') }}</h3>
              <div class="room-portrait-pager">
                <button class="room-portrait-arrow" type="button" :aria-label="t('room.portraitPrev')" :disabled="portraitPage === 0" @click="portraitPage -= 1">
                  <ChevronBackOutline />
                </button>
                <div class="room-role-v2-provider-icons" role="group" :aria-label="t('room.rolePortrait')">
                  <button
                    v-for="portrait in visiblePortraits"
                    :key="portrait.id"
                    class="room-role-provider-choice"
                    :class="{ active: roleDraft.portrait === portrait.id }"
                    type="button"
                    :data-portrait="portrait.id"
                    :aria-label="portrait.id"
                    :aria-pressed="roleDraft.portrait === portrait.id"
                    @click="roleDraft.portrait = portrait.id"
                  >
                    <img class="room-portrait" :src="portrait.src" alt="" />
                    <CheckmarkCircleOutline v-if="roleDraft.portrait === portrait.id" class="room-role-portrait-check" />
                  </button>
                </div>
                <button class="room-portrait-arrow" type="button" :aria-label="t('room.portraitNext')" :disabled="portraitPage >= portraitPageCount - 1" @click="portraitPage += 1">
                  <ChevronForwardOutline />
                </button>
              </div>
              <button
                class="room-role-controller-toggle"
                :class="{ active: roleDraft.isCaptain }"
                type="button"
                :aria-pressed="roleDraft.isCaptain"
                @click="roleDraft.isCaptain = !roleDraft.isCaptain"
              >
                <span class="room-role-controller-switch" aria-hidden="true" />
                <span class="room-role-controller-copy">
                  <span>{{ roleDraft.isCaptain ? t('room.isCaptain') : t('room.makeCaptain') }}</span>
                  <small>{{ t('room.captainDuty') }}</small>
                </span>
              </button>
            </div>
          </aside>
          <div class="room-role-v2-form">
            <div class="room-role-identity">
              <label>
                <span>{{ t('room.roleName') }}</span>
                <input v-model="roleDraft.displayName" maxlength="120" :aria-label="t('room.roleName')" />
              </label>
              <label>
                <span>{{ t('room.roleEngine') }}</span>
                <span class="room-role-engine-field">
                  <img v-if="agentLogo(roleDraft.provider)" :src="agentLogo(roleDraft.provider)" alt="" />
                  <select :value="roleDraft.provider" :aria-label="t('room.roleEngine')" @change="changeRoleProvider($event.target.value)">
                    <option v-for="provider in roleProviders" :key="provider" :value="provider">{{ providerLabel(provider) }}</option>
                  </select>
                </span>
              </label>
            </div>
            <p v-if="roleDraft.provider && !canSpeak(roleDraft.provider)" class="room-agent-quiet">{{ t('room.cannotSpeak') }}</p>
            <section class="room-role-v2-section">
              <h3>{{ t('room.rolePrompt') }}</h3>
              <div class="room-role-prompt-wrap">
                <textarea v-model="roleDraft.prompt" class="room-role-prompt" rows="6" maxlength="100000" :placeholder="t('room.rolePromptHint')" />
                <span class="room-role-prompt-count">{{ t('room.promptCount', { count: roleDraft.prompt.length }) }}</span>
              </div>
            </section>
            <section class="room-role-v2-section">
              <h3>{{ t('room.nativePermission') }}</h3>
              <div class="room-permission-cards">
                <label
                  v-for="mode in permissionModesFor(roleDraft.provider)"
                  :key="mode.id"
                  class="room-permission-card"
                  :data-risk="mode.risk"
                  :class="{ active: roleDraft.nativePermission === mode.id }"
                >
                  <input v-model="roleDraft.nativePermission" type="radio" :value="mode.id" />
                  <span class="room-permission-mark" aria-hidden="true">
                    <CheckmarkCircleOutline v-if="mode.risk === 'low'" />
                    <CreateOutline v-else-if="mode.risk === 'medium'" />
                    <FlashOutline v-else />
                  </span>
                  <span class="room-permission-copy">
                    <strong>{{ permissionModeLabel(mode) }}</strong>
                    <small>{{ permissionModeDescription(mode) }}</small>
                  </span>
                </label>
              </div>
              <p v-if="permissionModesFor(roleDraft.provider).some(mode => mode.id === roleDraft.nativePermission && mode.risk === 'high')" class="room-permission-warning">
                {{ t('room.nativePermissionHighRisk') }}
              </p>
            </section>
            <section class="room-role-preview" :aria-label="t('room.rolePreview')">
              <h3>{{ t('room.rolePreview') }}</h3>
              <div class="room-role-preview-card">
                <span class="room-role-preview-face" :style="{ '--portrait-glow': portraitGlow(roleDraft.portrait || roleDraft.provider) }">
                  <img :src="rolePortrait(roleDraft.portrait || roleDraft.provider)" alt="" />
                </span>
                <div class="room-role-preview-copy">
                  <header>
                    <strong>{{ roleDraft.displayName || t('room.roleName') }}</strong>
                    <span v-if="roleDraft.isCaptain" class="room-agent-badge">{{ t('room.captain') }}</span>
                  </header>
                  <p>{{ t('room.rolePreviewHello') }}</p>
                </div>
              </div>
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
  AtOutline,
  CheckmarkCircleOutline,
  ChevronBackOutline,
  ChevronDownOutline,
  ChevronForwardOutline,
  CloseOutline,
  CreateOutline,
  FlashOutline,
  FolderOutline,
  PencilOutline,
  PersonOutline,
  PulseOutline,
  SendOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { agentLogo } from '../catalog.js'
import { portraitGlow, portraitId, rolePortrait, rolePortraits } from '../role-portraits.js'
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
const composerInput = ref(null)
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
      portrait: role?.portrait || '',
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
  return formatUsageLine(liveFor(message)?.usage || message?.data?.usage || usageByRun.value[message.id])
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
const portraitPage = ref(0)
const portraitPageSize = 4
const portraitPageCount = computed(() => Math.max(1, Math.ceil(rolePortraits().length / portraitPageSize)))
const visiblePortraits = computed(() => rolePortraits().slice(portraitPage.value * portraitPageSize, (portraitPage.value + 1) * portraitPageSize))
const welcomeRoles = computed(() => [...roles.value]
  .sort((a, b) => Number(b.is_captain) - Number(a.is_captain))
  .slice(0, 4))
const welcomeCardId = ref('')
const welcomeCard = computed(() => roles.value.find(role => role.id === welcomeCardId.value) || null)
const welcomePrompts = computed(() => {
  const captain = roles.value.find(role => role.is_captain) || roles.value[0]
  const other = roles.value.find(role => role && role !== captain)
  const prompts = []
  if (captain?.display_name) prompts.push(t('room.welcomeSplit', { name: captain.display_name }))
  if (other?.display_name) prompts.push(t('room.welcomeAsk', { name: other.display_name }))
  prompts.push(t('room.welcomePlan'))
  return prompts.slice(0, 3)
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

function permissionModeDescription(mode) {
  const key = `room.nativePermissionMode.${mode.id}.description`
  const label = t(key)
  return label === key ? (mode.description || '') : label
}

function faceSrc(role) {
  return rolePortrait(role?.portrait || role?.provider)
}

function chipStyle(role) {
  return { '--chip-tint': portraitGlow(role?.portrait || role?.provider) }
}

function roleSpeaking(role) {
  return messages.value.some(message => (
    message.author_id === role?.id
    && ['queued', 'working', 'starting'].includes(message.status)
  ))
}

function showPortraitPage(id) {
  const index = rolePortraits().findIndex(item => item.id === id)
  portraitPage.value = index < 0 ? 0 : Math.floor(index / portraitPageSize)
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

function replyThinking(message) {
  return liveFor(message)?.reasoning || message?.data?.thinking || ''
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

const mentionQuery = computed(() => {
  const match = draft.value.match(/(?:^|\s)@([^\s@]*)$/)
  return match ? match[1] : null
})

const mentionOptions = computed(() => {
  if (mentionQuery.value == null) return []
  const query = mentionQuery.value.toLowerCase()
  return roles.value.filter(role => roleLabel(role).toLowerCase().includes(query))
})

function focusComposer() {
  if (!/(?:^|\s)@[^\s@]*$/.test(draft.value)) {
    const separator = draft.value && !/\s$/.test(draft.value) ? ' ' : ''
    draft.value = `${draft.value}${separator}@`
  }
  nextTick(() => composerInput.value?.focus())
}

function insertMention(role) {
  const mention = `@${roleLabel(role)} `
  if (/(?:^|\s)@[^\s@]*$/.test(draft.value)) {
    draft.value = draft.value.replace(/(^|\s)@[^\s@]*$/, `$1${mention}`)
  } else {
    draft.value = draft.value ? `${draft.value.replace(/\s*$/, ' ')}${mention}` : mention
  }
  nextTick(() => composerInput.value?.focus())
}

function handleComposerKeydown(event) {
  if (event.key === 'Escape' && mentionQuery.value != null) {
    event.preventDefault()
    event.stopPropagation()
    draft.value = draft.value.replace(/(^|\s)@[^\s@]*$/, '$1')
    return
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  if (mentionQuery.value != null && mentionOptions.value.length) {
    insertMention(mentionOptions.value[0])
    return
  }
  sendMessage()
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
    title: t('room.lobby'),
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
    portrait: portraitId(roleProviders.value[0] || ''),
    prompt: '',
    responsibilities: '',
    isCaptain: !roles.value.some(role => role.is_captain),
    nativePermission: defaultPermission(roleProviders.value[0] || ''),
  }
  showPortraitPage(roleDraft.value.portrait)
  roleSettingsOpen.value = true
  nextTick(() => roleSettingsRef.value?.focus?.())
}

function toggleWelcomeCard(role) {
  welcomeCardId.value = welcomeCardId.value === role?.id ? '' : (role?.id || '')
}

function dismissWelcomeCard() {
  welcomeCardId.value = ''
}

function welcomePermission(role) {
  const modes = permissionModesFor(role?.provider)
  const mode = modes.find(item => item.id === role?.native_permission) || modes[0]
  return mode ? permissionModeLabel(mode) : ''
}

function openWelcomeRole() {
  const roleId = welcomeCardId.value
  welcomeCardId.value = ''
  if (roleId) openRoleSettings(roleId)
}

function onWelcomeCardKey(event) {
  if (event.key === 'Escape') dismissWelcomeCard()
}

function onWelcomePointer(event) {
  const target = event.target
  if (target?.closest?.('.room-welcome-card, .room-welcome-face')) return
  dismissWelcomeCard()
}

function unbindWelcomeCard() {
  if (typeof document === 'undefined') return
  document.removeEventListener('keydown', onWelcomeCardKey)
  document.removeEventListener('pointerdown', onWelcomePointer)
}

watch(welcomeCardId, (id) => {
  unbindWelcomeCard()
  if (!id || typeof document === 'undefined') return
  document.addEventListener('keydown', onWelcomeCardKey)
  document.addEventListener('pointerdown', onWelcomePointer)
})

function openRoleSettings(roleId) {
  const role = roles.value.find(item => item.id === roleId)
  if (!role) return
  roleDeleteArmed.value = false
  roleSettingsWasCaptain.value = role.is_captain === true
  roleDraft.value = {
    id: role.id,
    displayName: role.display_name || '',
    provider: role.provider || '',
    portrait: role.portrait || portraitId(role.provider || ''),
    prompt: role.prompt || '',
    responsibilities: role.responsibilities || '',
    isCaptain: role.is_captain === true,
    nativePermission: role.native_permission || defaultPermission(role.provider || ''),
  }
  showPortraitPage(roleDraft.value.portrait)
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
    portrait: roleDraft.value.portrait,
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
  unbindWelcomeCard()
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
.room-agent-strip { display: flex; flex: 1 1 auto; flex-wrap: wrap; gap: 12px; align-items: center; min-width: 0; }
.room-roster { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.room-roster-card { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; width: 168px; max-width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-raised); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.room-roster-card:hover { border-color: var(--border-strong); background: var(--surface-hover); }
.room-roster-card img { width: 22px; height: 22px; object-fit: contain; }
.room-roster-name { max-width: 100%; overflow: hidden; font-size: var(--text-sm); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.room-roster-duty { display: -webkit-box; overflow: hidden; color: var(--text-soft); font-size: var(--text-2xs); line-height: 1.4; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.room-agent-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 180px; padding: 2px 6px 2px 2px; border: 0; border-radius: 999px; background: transparent; color: inherit; font: inherit; font-size: var(--text-xs); cursor: pointer; }
.room-agent-chip:hover { background: rgb(255 255 255 / 0.06); }
.room-chip-face { position: relative; width: 22px; height: 22px; flex: 0 0 22px; display: grid; }
.room-chip-photo { display: grid; overflow: hidden; width: 22px; height: 22px; border-radius: 50%; background: color-mix(in srgb, var(--chip-tint, var(--accent)) 15%, transparent); }
.room-chip-photo img { width: 100%; height: 100%; border: 0; border-radius: 0; background: transparent; object-fit: cover; object-position: center 12%; transform: scale(1.55); }
.room-agent-chip[data-speaking="true"] .room-chip-photo { box-shadow: 0 0 0 2px color-mix(in srgb, var(--chip-tint, var(--accent)) 75%, white); }
.room-agent-chip[data-quiet="true"] .room-chip-photo { opacity: 0.5; }
.room-captain-mark { position: absolute; right: -3px; bottom: -3px; width: 10px; height: 10px; display: grid; place-items: center; border-radius: 50%; background: #2a1c12; color: #ff8a3d; font-size: 8px; line-height: 1; }
.room-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room-agent-mute { flex: 0 0 auto; font-size: 11px; line-height: 1; opacity: 0.8; }
.room-agent-quiet { color: var(--text-muted); font-size: var(--text-xs); }
.room-agent-badge { flex: 0 0 auto; margin-left: 2px; padding: 1px 5px; border-radius: 999px; background: var(--surface-active); color: var(--text-soft); font-size: 10px; font-weight: 600; }
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
.room-welcome-stage { position: relative; z-index: 2; }
.room-welcome-card-backdrop { position: fixed; inset: 0; z-index: 4; border: 0; background: transparent; cursor: default; }
.room-welcome-team { position: relative; z-index: 6; display: flex; justify-content: center; align-items: flex-end; gap: 14px; margin-bottom: 18px; }
.room-welcome-face { position: relative; display: block; padding: 0; border: 0; background: transparent; cursor: pointer; }
.room-welcome-face img { width: 48px; height: 48px; border: 1.5px solid #12161a; border-radius: 50%; object-fit: cover; background: #1b2124; box-shadow: 0 8px 20px rgb(0 0 0 / 0.28); transform-origin: 50% 85%; transition: transform 0.18s ease; }
.room-welcome-face.captain img { width: 64px; height: 64px; }
.room-welcome-face:hover img,
.room-welcome-face:focus-visible img,
.room-welcome-face.open img { animation: room-welcome-wobble 0.62s ease-in-out; transform: scale(1.16); }
.room-welcome-face:focus-visible { outline: none; }
@keyframes room-welcome-wobble {
  0% { transform: scale(1) rotate(0deg); }
  30% { transform: scale(1.18) rotate(-7deg); }
  58% { transform: scale(1.14) rotate(5deg); }
  100% { transform: scale(1.16) rotate(0deg); }
}
@media (prefers-reduced-motion: reduce) {
  .room-welcome-face:hover img,
  .room-welcome-face:focus-visible img,
  .room-welcome-face.open img { animation: none; transform: scale(1.08); }
}
.room-welcome-wave { position: absolute; top: -6px; right: -18px; padding: 2px 7px; border-radius: 999px; background: var(--surface-raised); color: var(--text); font-size: var(--text-2xs); box-shadow: 0 4px 12px rgb(0 0 0 / 0.25); pointer-events: none; }
.room-welcome-card { position: absolute; z-index: 6; left: 50%; top: calc(100% - 10px); width: min(260px, calc(100vw - 48px)); transform: translateX(-50%); padding: 12px 14px 10px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-raised); box-shadow: var(--elev-2); text-align: left; }
.room-welcome-card header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.room-welcome-card header strong { font-size: var(--text-sm); }
.room-welcome-card dl { display: grid; gap: 6px; margin: 0; }
.room-welcome-card dl div { display: flex; justify-content: space-between; gap: 12px; }
.room-welcome-card dt { color: var(--faint); font-size: var(--text-2xs); }
.room-welcome-card dd { margin: 0; color: var(--text); font-size: var(--text-xs); text-align: right; }
.room-welcome-card p { margin: 8px 0 0; color: var(--text-soft); font-size: var(--text-2xs); line-height: 1.45; }
.room-welcome-card-config { margin-top: 10px; padding: 0; border: 0; background: transparent; color: var(--accent-text); font: inherit; font-size: var(--text-xs); cursor: pointer; }
.room-welcome-card-config:hover, .room-welcome-card-config:focus-visible { outline: none; text-decoration: underline; }
.room-welcome-prompts { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 16px; }
.room-welcome-prompts button { padding: 7px 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-soft); font-family: inherit; font-size: var(--text-xs); cursor: pointer; }
.room-welcome-prompts button:hover, .room-welcome-prompts button:focus-visible { outline: none; border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); color: var(--text); }
.room-message { display: flex; gap: 12px; align-items: flex-start; margin: 0 0 24px; }
.room-message-user { flex-direction: row-reverse; }
.room-message-avatar { display: grid; flex: 0 0 44px; place-items: center; width: 44px; height: 44px; color: var(--text-soft); font-size: var(--text-xs); font-weight: 600; }
.room-message-avatar img { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: #1b2124; }
.room-user-avatar { border-radius: 50%; background: var(--surface-active); }
.room-user-avatar svg { width: 22px; height: 22px; }
.room-message-body { min-width: 0; max-width: min(760px, calc(100% - 60px)); padding: 4px 2px; }
.room-message-user .room-message-body { max-width: min(640px, 82%); padding: 10px 14px; border-radius: 12px; background: color-mix(in srgb, var(--surface-active) 72%, transparent); }
.room-message header { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: baseline; margin-bottom: 4px; }
.room-message header strong { font-size: var(--text-sm); }
.room-message time { color: var(--faint); font-size: var(--text-2xs); }
.room-message p { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.65; }
.room-message ul { margin: 8px 0 0; padding-left: 18px; color: var(--text-soft); font-size: var(--text-xs); line-height: 1.55; }
.room-report .room-message-body { padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-raised); }
.room-message-controller .room-message-body,
.room-message-captain .room-message-body { padding: 0; border: 0; border-radius: 0; background: transparent; }
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
.room-composer-wrap { padding: 8px clamp(18px, 4vw, 48px) 18px; background: transparent; }
.room-composer { position: relative; display: flex; align-items: flex-end; gap: 6px; width: min(760px, 100%); margin: 0 auto; padding: 8px 8px 8px 6px; border-radius: 22px; background: color-mix(in srgb, var(--surface-raised) 88%, var(--surface-active) 12%); box-shadow: 0 10px 28px rgb(0 0 0 / 0.22); }
.room-mention-menu { position: absolute; right: 12px; bottom: calc(100% + 8px); left: 12px; z-index: 5; display: flex; flex-direction: column; max-height: 220px; overflow: auto; padding: 6px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-raised); box-shadow: var(--elev-2); }
.room-mention-option { display: flex; align-items: center; width: 100%; min-height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: var(--text-sm); text-align: left; cursor: pointer; }
.room-mention-option:hover, .room-mention-option:focus-visible { outline: none; background: var(--surface-hover); }
.room-composer:focus-within { box-shadow: 0 12px 30px rgb(0 0 0 / 0.28); }
.room-composer-tool, .room-composer-send { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; cursor: pointer; }
.room-composer-tool { width: 32px; height: 32px; border-radius: 10px; background: transparent; color: var(--muted); }
.room-composer-tool:hover:not(:disabled), .room-composer-tool:focus-visible { color: var(--text); background: var(--surface-hover); }
.room-composer-tool svg, .room-composer-send svg { width: 16px; height: 16px; }
.room-composer-field { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 2px 0; }
.room-composer textarea { flex: 1 1 160px; width: auto; min-width: 120px; min-height: 28px; max-height: 120px; margin: 0; padding: 4px 2px; border: 0; border-radius: 0; background: transparent; resize: none; line-height: 1.45; }
.room-composer textarea:focus-visible { outline: none; }
.room-composer-send { width: 34px; height: 34px; border-radius: 50%; background: var(--surface-active); color: var(--faint); }
.room-composer-send:disabled { opacity: 1; }
.room-composer-send:not(:disabled) { background: var(--accent); color: #fff; }
.room-composer-send:hover:not(:disabled) { background: var(--accent-hover); }
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
.room-role-v2-body { display: grid; flex: 1; grid-template-columns: 300px minmax(0, 1fr); min-height: 0; overflow: hidden; }
.room-role-v2-side { overflow: auto; padding: 18px; border-right: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 72%, var(--surface-raised)); }
.room-role-v2-profile { display: flex; flex-direction: column; gap: 10px; padding: 18px 16px; border: 1px solid var(--border); border-radius: 16px; background: color-mix(in srgb, var(--surface-raised) 70%, transparent); }
.room-role-v2-avatar { display: grid; place-items: center; width: 208px; height: 208px; margin: 0 auto 4px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--border-strong) 78%, transparent); border-radius: 50%; background: #1b2124; box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.04); }
.room-role-v2-avatar img { width: 100%; height: 100%; object-fit: cover; }
.room-role-v2-avatar span { color: var(--text-soft); font-size: var(--text-3xl); font-weight: 600; }
.room-role-v2-heading { margin: 4px 0 0; color: var(--text-soft); font-size: var(--text-xs); font-weight: 600; text-align: left; }
.room-role-engine { display: inline-flex; align-items: center; gap: 6px; align-self: center; padding: 3px 8px 3px 4px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-soft); font-size: var(--text-2xs); }
.room-role-engine img { width: 16px; height: 16px; object-fit: contain; }
.room-role-v2-provider-label { color: var(--faint); font-size: var(--text-xs); text-align: center; }
.room-portrait-pager { display: grid; grid-template-columns: 22px minmax(0, 1fr) 22px; align-items: center; gap: 4px; }
.room-portrait-arrow { width: 22px; height: 44px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--text-soft); cursor: pointer; }
.room-portrait-arrow svg { width: 16px; height: 16px; }
.room-portrait-arrow:hover, .room-portrait-arrow:focus-visible { outline: none; background: var(--surface-active); color: var(--text); }
.room-portrait-arrow:disabled { opacity: 0.28; cursor: default; background: transparent; }
.room-role-v2-provider-icons { display: grid; grid-template-columns: repeat(4, 40px); justify-content: start; gap: 6px; width: 100%; margin: 0; }
.room-portrait-pager .room-role-provider-choice { width: 40px; height: 40px; }
.room-role-provider-choice { position: relative; width: 44px; height: 44px; display: inline-grid; place-items: center; padding: 0; overflow: visible; border: 2px solid transparent; border-radius: 50%; background: #1b2124; cursor: pointer; }
.room-role-provider-choice img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
.room-role-provider-choice:hover, .room-role-provider-choice:focus-visible { outline: none; border-color: var(--border-strong); }
.room-role-provider-choice.active { border-color: var(--accent); }
.room-role-portrait-check { position: absolute; right: -3px; bottom: -3px; width: 16px; height: 16px; padding: 1px; border-radius: 50%; background: var(--accent); color: #062126; }
.room-role-controller-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text-soft); font-family: inherit; font-size: var(--text-xs); text-align: left; cursor: pointer; }
.room-role-controller-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.room-role-controller-copy small { color: var(--faint); font-size: var(--text-2xs); }
.room-role-controller-toggle:hover, .room-role-controller-toggle:focus-visible { outline: none; border-color: var(--border-strong); color: var(--text); }
.room-role-controller-toggle.active { border-color: color-mix(in srgb, var(--accent) 62%, var(--border)); background: var(--accent-soft); color: var(--accent-text); }
.room-role-controller-switch { width: 24px; height: 14px; flex: 0 0 24px; padding: 2px; border-radius: 999px; background: var(--surface-active); box-shadow: inset 0 0 0 1px var(--border); }
.room-role-controller-switch::after { content: ""; display: block; width: 10px; height: 10px; border-radius: 50%; background: var(--muted); transition: transform var(--dur-fast) var(--ease-standard), background var(--dur-fast) var(--ease-standard); }
.room-role-controller-toggle.active .room-role-controller-switch { background: color-mix(in srgb, var(--accent) 30%, var(--surface-active)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, var(--border)); }
.room-role-controller-toggle.active .room-role-controller-switch::after { background: var(--accent); transform: translateX(10px); }
.room-role-identity { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 12px; }
.room-role-identity label { display: flex; flex-direction: column; gap: 6px; min-width: 0; color: var(--text-soft); font-size: var(--text-xs); }
.room-role-identity input, .room-role-identity select { width: 100%; min-width: 0; }
.room-role-engine-field { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0 8px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.room-role-engine-field img { width: 16px; height: 16px; flex: 0 0 16px; object-fit: contain; }
.room-role-engine-field select { border: 0; background: transparent; }
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
.room-permission-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 8px; }
.room-permission-card { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 8px; align-items: center; min-height: 72px; padding: 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); cursor: pointer; }
.room-permission-card input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.room-permission-card strong, .room-permission-card small { display: block; }
.room-permission-card strong { color: var(--text); font-size: var(--text-xs); }
.room-permission-card small { color: var(--muted); font-size: var(--text-2xs); line-height: 1.4; }
.room-permission-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--surface-active); color: var(--text-soft); }
.room-permission-mark svg { width: 16px; height: 16px; }
.room-permission-card.active { border-color: color-mix(in srgb, var(--accent) 70%, var(--border)); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); }
.room-permission-card.active .room-permission-mark { background: color-mix(in srgb, var(--accent) 22%, var(--surface)); color: var(--accent-text); }
.room-permission-card[data-risk="high"] .room-permission-mark { background: var(--warning-soft); color: var(--warning); }
.room-permission-card[data-risk="high"].active { border-color: color-mix(in srgb, var(--warning) 78%, var(--border)); background: color-mix(in srgb, var(--warning) 14%, var(--surface)); }
.room-permission-card[data-risk="high"].active .room-permission-mark { background: color-mix(in srgb, var(--warning) 24%, var(--surface)); color: var(--warning); }
.room-permission-warning { margin: 0; padding: 8px 10px; border-radius: 10px; background: var(--warning-soft); color: var(--warning); font-size: var(--text-2xs); line-height: 1.45; }
.room-role-preview h3 { margin: 0 0 4px; color: var(--text-soft); font-size: var(--text-xs); font-weight: 600; text-align: left; }
.room-role-preview-card { display: flex; align-items: center; justify-content: flex-start; gap: 18px; margin: 0; padding: 10px 4px 4px; border: 0; background: transparent; text-align: left; }
.room-role-preview-face { position: relative; width: 88px; height: 88px; flex: 0 0 88px; }
.room-role-preview-face::before { content: ""; position: absolute; z-index: 0; inset: -8px; background: radial-gradient(circle, color-mix(in srgb, var(--portrait-glow) 34%, transparent) 0%, transparent 72%); pointer-events: none; }
.room-role-preview-face img { position: relative; z-index: 1; width: 88px; height: 88px; border-radius: 50%; object-fit: cover; background: transparent; }
.room-role-preview-copy { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.room-role-preview-card header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.room-role-preview-card strong { font-size: var(--text-md); }
.room-role-preview-card p { margin: 0; color: var(--text-soft); font-size: var(--text-sm); line-height: 1.5; }
@media (max-width: 820px) {
  .room-role-v2-body { grid-template-columns: 1fr; }
  .room-permission-cards { grid-template-columns: 1fr; }
}
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
  .room-composer-wrap { padding: 8px 14px 14px; }
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
.room-subtitle [data-tone="ready"] { color: var(--text-soft); }
.room-message-status { color: var(--faint); font-size: var(--text-2xs); }
.room-message-status[data-status="working"],
.room-message-status[data-status="queued"],
.room-message-status[data-status="starting"] { color: var(--accent-text); }
.room-message-status[data-status="failed"],
.room-message-status[data-status="interrupted"],
.room-message-status[data-status="unknown"] { color: var(--danger, #b94c4c); }
.room-message-system .room-message-body { padding: 4px 0; color: var(--faint); font-size: var(--text-xs); }
.room-message-captain .room-message-body { padding: 0; border: 0; border-radius: 0; background: transparent; }
.room-mention-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.room-mention-chip { display: inline-flex; align-items: center; padding: 2px 7px; border: 0; border-radius: 999px; background: var(--surface-active); color: var(--text-soft); font: inherit; font-size: var(--text-2xs); }
.room-composer-mentions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0; }
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
