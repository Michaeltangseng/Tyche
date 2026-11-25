<template>
  <section class="room-workspace">
    <header class="room-toolbar room-header">
      <div class="room-heading">
        <div class="room-title-row">
          <h1>
            <div
              v-if="!titleEditing"
              class="room-chat-title"
              role="button"
              tabindex="0"
              :aria-label="t('room.renameChat')"
              @click="beginTitleEdit"
              @keydown.enter.prevent="beginTitleEdit"
              @mouseenter="measureTitle"
            >
              <span ref="titleClip" class="room-chat-title-clip" :class="{ marquee: titleOverflows }">
                <span class="room-chat-title-text">{{ activeChatLabel }}</span>
              </span>
            </div>
            <div v-else class="room-chat-title editing">
              <span
                ref="titleText"
                class="room-chat-title-text"
                contenteditable="plaintext-only"
                role="textbox"
                spellcheck="false"
                :aria-label="t('room.renameChat')"
                @blur="commitTitleEdit"
                @keydown.enter.prevent="event => event.target.blur()"
                @keydown.esc.prevent="cancelTitleEdit"
              />
            </div>
          </h1>
        </div>
      </div>

      <RoomCollaborationRibbon
        v-if="snapshot"
        class="room-collaboration"
        :state="collaboration"
        :roles="castRoles"
        :busy="busy"
        :can-add="canAddRole"
        @select-role="openRoleSettings"
        @add-role="openNewRole"
        @open-work="workPanelOpen = true"
      />

      <div class="room-header-actions">
        <button v-if="attentions.length" class="room-notice-pill" type="button" @click="scrollToAttention">
          {{ t('room.attentions', { count: attentions.length }) }}
        </button>
        <button v-if="snapshot" class="room-icon-button room-usage-toggle" type="button" :aria-pressed="showWorkPanel && activeWorkTab === 'usage'" :title="t('room.usagePanel')" :aria-label="t('room.usagePanel')" @click="openUsage">
          <PulseOutline />
        </button>
        <button v-if="snapshot" class="room-icon-button room-files-toggle" type="button" :aria-pressed="filesOpen" :title="t('room.files')" :aria-label="t('room.files')" @click="emit('toggle-files')">
          <FolderOutline />
        </button>
        <button v-if="snapshot" class="secondary-button room-workspace-switch" type="button" @click="workspaceDialogOpen = true">
          {{ t('room.switchWorkspace') }}
        </button>
        <button class="room-icon-button room-create-button" type="button" data-testid="room-create-open" :aria-label="t('room.create')" :disabled="busy" @click="startCreating">+</button>
      </div>
    </header>

    <p v-if="missingCaptain" class="room-error room-banner" role="alert">{{ t('room.noProviders') }}</p>
    <p v-else-if="error || pickerError" class="room-error room-banner" role="alert">
      {{ t('room.error') }}
      <button class="secondary-button" type="button" @click="reload">{{ t('room.refresh') }}</button>
    </p>

    <div v-if="!snapshot" class="room-landing">
      <div class="room-landing-inner">
        <h2>{{ rooms.length ? t('room.loading') : t('room.emptyProjects') }}</h2>
        <p v-if="!rooms.length" class="room-muted">{{ t('room.createHint') }}</p>
        <button v-if="!rooms.length" class="primary-button" type="button" :disabled="busy" @click="startCreating">{{ t('room.createChat') }}</button>
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
              <div v-if="welcomeRoles.length" class="room-welcome-team">
                <button
                  v-for="role in welcomeRoles"
                  :key="role.id"
                  class="room-welcome-face"
                  :class="{ captain: role.is_captain }"
                  type="button"
                  :aria-label="`${t('room.configureRole')}: ${roleLabel(role)}`"
                  @click="openRoleSettings(role.id)"
                >
                  <RoomMascot :mascot="roomMascot(role)" />
                  <span v-if="role.is_captain" class="room-welcome-wave">{{ t('room.welcomeWave') }}</span>
                </button>
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
                :id="`room-message-${entry.message.id}`"
                class="room-message"
                :class="{
                  'room-message-user': entry.isUser,
                  'room-message-agent': !entry.isUser,
                  'room-message-system': entry.isSystem,
                  'room-message-captain': entry.isCaptain,
                }"
              >
                <button
                  v-if="!entry.isUser && !entry.isSystem && entry.roleId"
                  class="room-message-avatar"
                  type="button"
                  :aria-label="`${t('room.configureRole')}: ${entry.author}`"
                  @click="openRoleSettings(entry.roleId)"
                >
                  <RoomMascot v-if="entry.roleId" :mascot="roomMascot({ id: entry.roleId })" />
                  <span v-else>{{ entry.author.slice(0, 1) }}</span>
                </button>
                <span v-else-if="!entry.isUser && !entry.isSystem" class="room-message-avatar">
                  <RoomMascot v-if="entry.roleId" :mascot="roomMascot({ id: entry.roleId })" />
                  <span v-else>{{ entry.author.slice(0, 1) }}</span>
                </span>
                <div class="room-message-body">
                  <header>
                    <strong>{{ entry.author }}</strong>
                    <span v-if="entry.isCaptain" class="room-agent-badge">{{ t('room.captain') }}</span>
                    <span v-if="entry.isReviewReply" class="room-agent-badge">{{ t('room.reviewReply') }}</span>
                    <time>{{ formatTime(entry.createdAt) }}</time>
                    <span
                      v-if="isTerminalMessage(entry.message)"
                      class="room-message-stamp"
                      role="img"
                      :title="statusLabel(entry.message.status)"
                      :aria-label="statusLabel(entry.message.status)"
                    >✓</span>
                    <span v-else-if="entry.message.status" class="room-message-status" :data-status="entry.message.status">{{ statusLabel(entry.message.status) }}</span>
                    <span v-if="turnUsage(entry.message)" class="room-turn-usage">{{ turnUsage(entry.message) }}</span>
                  </header>
                  <MarkdownMessage
                    v-if="entry.message.content"
                    :content="entry.message.content"
                    :mention-profiles="mentionProfiles"
                    :class="{ 'room-message-streaming': isWorking(entry.message) }"
                  />
                  <MarkdownMessage
                    v-else-if="liveFor(entry.message)?.text"
                    class="room-live-output"
                    :class="{ 'room-message-streaming': isWorking(entry.message) }"
                    :content="liveFor(entry.message).text"
                    :mention-profiles="mentionProfiles"
                    aria-live="polite"
                  />
                  <p v-else-if="isWorking(entry.message) && !entry.handoffs.length" class="room-live-output" aria-live="polite">{{ t('room.liveOutput') }}</p>
                  <div v-if="entry.handoffs.length" class="room-handoff-list">
                    <div
                      v-for="handoff in entry.handoffs"
                      :key="handoff.message.id"
                      :id="`room-message-${handoff.message.id}`"
                      class="room-handoff"
                      :data-live="handoffLive(handoff) ? 'true' : undefined"
                    >
                      <div v-if="handoffTargets(handoff).length" class="room-handoff-strip">
                        <span class="room-handoff-face">
                          <RoomMascot v-if="entry.roleId" :mascot="roomMascot({ id: entry.roleId })" />
                          <span v-else>{{ entry.author.slice(0, 1) }}</span>
                        </span>
                        <span class="room-handoff-arrow" aria-hidden="true">→</span>
                        <span
                          v-for="target in handoffTargets(handoff)"
                          :key="target.id"
                          class="room-handoff-face"
                          :title="roleLabel(target)"
                        >
                          <RoomMascot :mascot="roomMascot(target)" />
                        </span>
                        <span class="room-handoff-label">
                          {{ t('room.handoffTo', { names: handoffTargets(handoff).map(roleLabel).join(' · ') }) }}
                        </span>
                      </div>
                      <MarkdownMessage
                        class="room-message-handoff"
                        :content="handoff.message.content"
                        :mention-profiles="mentionProfiles"
                      />
                    </div>
                  </div>
                  <div v-if="entry.mentions.length && !entry.handoffs.length" class="room-mention-row">
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
                      <RoomMascot v-if="role.provider" :mascot="roomMascot(role)" />
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
                    :thinking="replyThinking(entry.message)"
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
              <template v-if="attention.type === 'workspace_directory'">
                <header><strong>{{ t('room.needsYou') }}</strong></header>
                <p>{{ t('room.workspaceAsk') }}</p>
                <div class="room-actions">
                  <button class="primary-button" type="button" :disabled="busy" @click="workspaceDialogOpen = true">{{ t('room.switchWorkspace') }}</button>
                </div>
              </template>
              <template v-else>
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
              </template>
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
            <div v-if="uploadedFiles.length" class="room-upload-row">
              <span v-for="name in uploadedFiles" :key="name">{{ name }}</span>
            </div>
            <p v-if="uploadError" class="room-upload-error">{{ t('room.uploadFailed') }}</p>
            <textarea
              ref="composerInput"
              v-model="draft"
              :placeholder="t('room.messageHint', { name: activeChatLabel })"
              :aria-label="t('room.message')"
              rows="1"
              maxlength="100000"
              :disabled="busy || !chat"
              @keydown="handleComposerKeydown"
            />
            <div class="room-composer-bar">
              <button
                class="room-composer-tool"
                type="button"
                :title="t('room.uploadFile')"
                :aria-label="t('room.uploadFile')"
                :disabled="uploading || !roomId"
                @click="uploadWorkspaceFiles"
              >
                <AttachOutline />
              </button>
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
              <span class="room-composer-hint">{{ t('room.composerNewline') }}</span>
              <button class="room-composer-send" type="submit" :aria-label="t('room.send')" :disabled="busy || !draft.trim() || !chat">
                <ArrowUpOutline />
              </button>
            </div>
          </form>
          <!-- <p v-if="composerCaptain" class="room-composer-note">{{ t('room.composerScope', { name: roleLabel(composerCaptain) }) }}</p> -->
        </div>
      </section>

      <aside v-if="showWorkPanel" ref="ledger" class="room-ledger" :style="{ '--room-ledger-width': `${ledgerWidth}px` }" :aria-label="t('room.workPanel')">
        <div
          class="project-room-drawer-resize room-ledger-resize"
          role="separator"
          aria-orientation="vertical"
          :aria-label="t('room.ledgerResize')"
          @pointerdown.prevent="startLedgerResize"
        />
        <header class="room-ledger-header">
          <h2>{{ t('room.workPanel') }}</h2>
          <button class="secondary-button" type="button" @click="closeWorkPanel">{{ t('common.close') }}</button>
        </header>

        <nav class="room-work-tabs" role="tablist" :aria-label="t('room.workPanel')">
          <button
            v-for="tab in workTabs"
            :key="tab.id"
            class="room-work-tab"
            :class="{ active: activeWorkTab === tab.id }"
            type="button"
            role="tab"
            :aria-selected="activeWorkTab === tab.id"
            :data-work-tab="tab.id"
            @click="workTab = tab.id"
          >
            {{ t(tab.label) }}<span v-if="tab.count" class="room-work-tab-count">{{ tab.count }}</span>
          </button>
        </nav>

        <div class="room-work-scroll">
          <section v-if="activeWorkTab === 'trace'" class="room-work-panel" role="tabpanel">
            <p v-if="!workflow.nodes.length" class="room-work-empty">{{ t('room.noTrace') }}</p>
            <RoomWorkflow v-else :workflow="workflow" :roles="roles" @select="focusWorkflowMessage" />
          </section>

          <section v-else-if="activeWorkTab === 'usage'" class="room-work-panel" role="tabpanel">
            <div class="room-usage-summary room-work-card">
              <span>{{ t('room.usageTotal') }}</span>
              <strong>{{ totalUsageLine }}</strong>
            </div>
            <ul class="room-usage-list">
              <li v-for="row in agentUsage" :key="row.id">
                <div class="room-usage-agent">
                  <span class="room-usage-face">
                    <RoomMascot :mascot="roomMascot(rolesById.get(row.id) || { id: row.id })" />
                  </span>
                  <strong>{{ row.name }}</strong>
                  <span :data-status="row.status">{{ row.status === 'working' ? t('room.usageWorking') : t('room.usageIdle') }}</span>
                </div>
                <p class="room-usage-model">{{ row.model }}</p>
                <p class="room-usage-line">{{ formatUsageLine(row.usage) }}</p>
                <p v-if="row.contextPercent != null" class="room-usage-context">
                  {{ t('room.usageContext') }} {{ Math.round(row.contextPercent) }}%
                  <span class="room-usage-bar" aria-hidden="true"><span :style="{ width: `${Math.max(0, Math.min(100, row.contextPercent))}%` }" /></span>
                </p>
              </li>
            </ul>
          </section>
        </div>
      </aside>
    </div>


    <div v-if="workspaceDialogOpen" class="room-modal-backdrop" @click.self="closeWorkspaceDialog">
      <section class="room-workspace-dialog" role="dialog" aria-modal="true" :aria-label="t('room.switchWorkspace')" @keydown.esc.stop="closeWorkspaceDialog">
        <header>
          <strong>{{ t('room.switchWorkspace') }}</strong>
          <button class="room-icon-button" type="button" :aria-label="t('common.close')" @click="closeWorkspaceDialog">
            <CloseOutline />
          </button>
        </header>
        <div class="room-workspace-copy">
          <strong>{{ workspaceName }}</strong>
          <small>{{ t('room.workspaceHint') }}</small>
        </div>
        <div class="room-workspace-actions">
          <button class="secondary-button" type="button" :disabled="workspaceBusy" @click="chooseWorkspace">{{ t('room.setWorkspace') }}</button>
          <button v-if="workspaceDefault && !workspaceConfirmed" class="secondary-button" type="button" :disabled="workspaceBusy" @click="keepWorkspace">{{ t('room.keepScratch') }}</button>
        </div>
        <p v-if="workspaceNeedsMove" class="room-workspace-move">
          <span>{{ t('room.moveScratchTitle') }}</span>
          <button class="primary-button" type="button" :disabled="workspaceBusy" @click="confirmWorkspaceMove(true)">{{ t('room.moveScratchConfirm') }}</button>
          <button class="secondary-button" type="button" :disabled="workspaceBusy" @click="confirmWorkspaceMove(false)">{{ t('room.moveScratchSkip') }}</button>
        </p>
      </section>
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
                    <option
                      v-for="provider in roleProviders"
                      :key="provider"
                      :value="provider"
                      :disabled="!readyProviderKinds.has(provider)"
                      :title="providerUnavailableLabel(provider)"
                    >{{ providerOptionLabel(provider) }}</option>
                  </select>
                </span>
              </label>
            </div>
            <p v-if="roleDraft.provider && !canSpeak(roleDraft.provider)" class="room-agent-quiet">{{ providerUnavailableLabel(roleDraft.provider) }}</p>
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
            <section class="room-role-v2-section room-role-v2-skills">
              <h3>{{ t('room.roleSkills') }}</h3>
              <p class="room-agent-quiet">{{ t('room.roleSkillsHint') }}</p>
              <p v-if="!roleSkillChoices.length" class="room-agent-quiet">{{ t('room.roleSkillsEmpty') }}</p>
              <label v-for="skill in roleSkillChoices" :key="skill.id" class="room-skill-option">
                <input
                  type="checkbox"
                  :checked="roleDraft.skills.includes(skill.id)"
                  @change="toggleRoleSkill(skill.id)"
                />
                <span>{{ skill.name }}</span>
              </label>
              <p v-if="droppedSkillIds.length" class="room-agent-quiet">{{ t('room.skillUnavailable', { ids: droppedSkillIds.join(', ') }) }}</p>
              <p class="room-agent-quiet">{{ t('room.skillTokens', { count: skillTokenEstimate(roleDraft.skills.length) }) }}</p>
              <button class="secondary-button" type="button" :disabled="busy || !roleDraft.provider" @click="rememberRoleSkills">{{ t('room.rememberSkillDefault') }}</button>
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
  AtOutline,
  AttachOutline,
  CheckmarkCircleOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  CloseOutline,
  CreateOutline,
  FlashOutline,
  FolderOutline,
  PencilOutline,
  PersonOutline,
  PulseOutline,
  ArrowUpOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { agentLogo } from '../catalog.js'
import { desktopApi } from '../desktop.js'
import { portraitGlow, portraitId, rolePortrait, rolePortraits } from '../role-portraits.js'
import { roomMascot } from '../room-mascots.js'
import RoomMascot from './RoomMascot.vue'
import { t } from '../i18n.js'
import { keptSkillIds, selectableSkills, skillTokenEstimate } from '../skillInventory.js'
import { useRoomWorkspace } from '../composables/useRoomWorkspace.js'
import { agentUsageRows, formatUsageLine } from '../room-usage.js'
import { deriveRoomCollaboration } from '../roomCollaboration.js'
import { buildRoomWorkflow } from '../roomWorkflow.js'
import MarkdownMessage from './MarkdownMessage.vue'
import RoomCollaborationRibbon from './RoomCollaborationRibbon.vue'
import RoomRunTrace from './RoomRunTrace.vue'
import RoomWorkflow from './RoomWorkflow.vue'

const props = defineProps({
  api: { type: Object, required: true },
  pickDirectory: { type: Function, required: true },
  agents: { type: Array, default: () => [] },
  createRequest: { type: Boolean, default: false },
  openRequest: { type: Object, default: null },
  filesOpen: { type: Boolean, default: false },
})
const emit = defineEmits(['create-request-consumed', 'active-change', 'toggle-files', 'open-files'])

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
  renameChat,
  send,
  loadOlderMessages,
  acceptTask: acceptTaskCommand,
  stopReply: stopReplyCommand,
  answerAttention,
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

const roleSettingsOpen = ref(false)
const skillInventoryState = ref({ agents: [], skills: [], defaults: {} })
const droppedSkillIds = ref([])
const roleSettingsRef = ref(null)
const roleDraft = ref(null)
const roleSettingsWasCaptain = ref(false)
const roleDeleteArmed = ref(false)
const workspaceDialogOpen = ref(false)
const workspaceBusy = ref(false)
const workspaceNeedsMove = ref(false)
const pendingWorkspace = ref('')
const roomRecord = computed(() => snapshot.value?.room || null)
const workspaceDefault = computed(() => roomRecord.value?.workspace_default === true)
const workspaceConfirmed = computed(() => roomRecord.value?.workspace_confirmed !== false)
const workspaceName = computed(() => (
  workspaceDefault.value ? t('room.scratchLabel') : (roomRecord.value?.workspace_label || t('room.scratchLabel'))
))
const workPanelOpen = ref(true)
const ledger = ref(null)
const LEDGER_MIN = 280
const LEDGER_MAX = 760
const LEDGER_DEFAULT = 340
const LEDGER_WIDTH_KEY = 'tyche.roomLedgerWidth'

function clampLedgerWidth(value) {
  const width = Number(value)
  if (!Number.isFinite(width)) return LEDGER_DEFAULT
  return Math.min(LEDGER_MAX, Math.max(LEDGER_MIN, Math.round(width)))
}

function readLedgerWidth() {
  try {
    const stored = localStorage.getItem(LEDGER_WIDTH_KEY)
    if (stored == null || stored === '') return LEDGER_DEFAULT
    return clampLedgerWidth(stored)
  } catch {
    return LEDGER_DEFAULT
  }
}

const ledgerWidth = ref(readLedgerWidth())
let ledgerResize = null
let ledgerResizeFrame = 0

function renderedLedgerWidth() {
  const value = Number(ledger.value?.getBoundingClientRect?.().width)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : ledgerWidth.value
}

function startLedgerResize(event) {
  ledgerResize = { startX: event.clientX, lastX: event.clientX, startWidth: renderedLedgerWidth() }
  document.body.classList.add('drawer-resizing')
  window.addEventListener('pointermove', handleLedgerResize)
  window.addEventListener('pointerup', finishLedgerResize)
  window.addEventListener('pointercancel', finishLedgerResize)
}

function handleLedgerResize(event) {
  if (!ledgerResize) return
  ledgerResize.lastX = event.clientX
  if (ledgerResizeFrame) return
  ledgerResizeFrame = requestAnimationFrame(() => {
    ledgerResizeFrame = 0
    if (!ledgerResize) return
    ledgerWidth.value = clampLedgerWidth(ledgerResize.startWidth + (ledgerResize.startX - ledgerResize.lastX))
  })
}

function finishLedgerResize() {
  if (!ledgerResize) return
  ledgerWidth.value = clampLedgerWidth(ledgerResize.startWidth + (ledgerResize.startX - ledgerResize.lastX))
  ledgerResize = null
  if (ledgerResizeFrame) cancelAnimationFrame(ledgerResizeFrame)
  ledgerResizeFrame = 0
  window.removeEventListener('pointermove', handleLedgerResize)
  window.removeEventListener('pointerup', finishLedgerResize)
  window.removeEventListener('pointercancel', finishLedgerResize)
  document.body.classList.remove('drawer-resizing')
  try {
    localStorage.setItem(LEDGER_WIDTH_KEY, String(ledgerWidth.value))
  } catch {
    /* the width still applies for this session */
  }
}
const workPanelRequested = ref(false)
const workTab = ref('')
const name = ref('')
const titleEditing = ref(false)
const titleOverflows = ref(false)
const titleClip = ref(null)
const titleText = ref(null)
let titleEditCancelled = false
const draft = ref('')
const composerInput = ref(null)
const answers = ref({})
const pickerError = ref(false)
const missingCaptain = ref(false)
const timeline = ref(null)

const availableAgents = computed(() => props.agents.filter(agent => agent && agent.kind))
const readyProviderKinds = computed(() => new Set(availableAgents.value.map(agent => agent.kind)))
const selectedCaptain = ref('')
const projectLabel = computed(() => snapshot.value?.room?.name || rooms.value.find(room => room.id === roomId.value)?.name || t('room.title'))
const activeChatLabel = computed(() => {
  const item = chat.value
  if (!item) return snapshot.value ? t('room.chat') : t('room.title')
  return item.title
})
const composerCaptain = computed(() => roles.value.find(role => role.is_captain) || null)
const mentionProfiles = computed(() => roles.value.map(role => ({
  kind: role.provider || role.id,
  label: role.display_name || role.provider || '',
})).filter(profile => profile.label))
const uploadedFiles = ref([])
const uploading = ref(false)
const uploadError = ref(false)
const workdirName = computed(() => snapshot.value?.room?.workspace_label || '')
const rolesById = computed(() => new Map(roles.value.map(role => [role.id, role])))
const tasksById = computed(() => new Map((snapshot.value?.tasks || []).map(task => [task.id, task])))

function isHandoff(message) {
  if (!message || message.author_type !== 'agent') return false
  if (message.kind === 'mention') return true
  return !message.reply_to && Array.isArray(message.mentions) && message.mentions.length > 0
}

const TERMINAL_MESSAGE_STATUSES = new Set(['done', 'completed', 'accepted'])

function isTerminalMessage(message) {
  return TERMINAL_MESSAGE_STATUSES.has(message?.status)
}

function handoffTargets(handoff) {
  const ids = handoff?.message?.mentions || []
  return ids.map(id => rolesById.value.get(id)).filter(Boolean)
}

function handoffLive(handoff) {
  const activeRoleId = collaboration.value.activeRoleId
  if (!activeRoleId || collaboration.value.mode === 'idle') return false
  return handoffTargets(handoff).some(role => role.id === activeRoleId)
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
      roleId: role?.id || '',
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

function turnUsage(message) {
  if (message?.author_type !== 'agent') return ''
  return formatUsageLine(liveFor(message)?.usage || message?.data?.usage || usageByRun.value[message.id])
}

const workflow = computed(() => buildRoomWorkflow({
  tasks: tasks.value,
  runs: runs.value,
  assignments: captainAssignments.value,
  messages: messages.value,
  roles: roles.value,
}))
const hasWork = computed(() => workflow.value.nodes.length > 0)
const showWorkPanel = computed(() => (
  workPanelOpen.value && (hasWork.value || workPanelRequested.value)
))
const canCreate = computed(() => Boolean(name.value.trim() && selectedCaptain.value))

const roleProviders = computed(() => {
  const room = snapshot.value?.room
  const launch = Array.isArray(room?.launch_providers) ? room.launch_providers : []
  const enabled = Array.isArray(room?.providers) ? room.providers : []
  const providers = []
  for (const provider of [...launch, ...enabled]) {
    if (provider && readyProviderKinds.value.has(provider) && !providers.includes(provider)) {
      providers.push(provider)
    }
  }
  // Keep the role's current provider visible even when the Agent is no longer
  // available, so the user can see why the role is quiet and switch providers.
  const current = roleDraft.value?.provider
  if (current && !providers.includes(current)) providers.push(current)
  return providers
})
const canAddRole = computed(() => readyProviderKinds.value.size > 0)
const portraitPage = ref(0)
const portraitPageSize = 4
const portraitPageCount = computed(() => Math.max(1, Math.ceil(rolePortraits().length / portraitPageSize)))
const visiblePortraits = computed(() => rolePortraits().slice(portraitPage.value * portraitPageSize, (portraitPage.value + 1) * portraitPageSize))
const welcomeRoles = computed(() => [...roles.value]
  .sort((a, b) => Number(b.is_captain) - Number(a.is_captain))
  .slice(0, 4))
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
  && canSpeak(roleDraft.value.provider)
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

const castRoles = computed(() => roles.value.map(role => {
  const ready = readyProviderKinds.value.has(role.provider)
  return {
    ...role,
    provider_label: providerLabel(role.provider),
    can_speak: canSpeak(role.provider),
    unavailable: !ready,
    availability_note: ready ? '' : t('room.agentUnavailable'),
  }
}))

const collaboration = computed(() => deriveRoomCollaboration({
  tasks: tasks.value,
  runs: runs.value,
  reports: reports.value,
  messages: messages.value,
  assignments: captainAssignments.value,
  reviews: reviews.value,
  liveRuns: liveRuns.value,
}))

const workTabs = computed(() => [
  { id: 'trace', label: 'room.workTab.trace', count: workflow.value.nodes.length },
  { id: 'usage', label: 'room.workTab.usage', count: 0 },
])
const defaultWorkTab = computed(() => (workflow.value.nodes.length ? 'trace' : 'usage'))
const activeWorkTab = computed(() => workTab.value || defaultWorkTab.value)
const totalUsage = computed(() => agentUsage.value.reduce((total, row) => {
  const usage = row.usage || {}
  return {
    inputTokens: total.inputTokens + (Number(usage.inputTokens) || 0),
    outputTokens: total.outputTokens + (Number(usage.outputTokens) || 0),
    cachedInputTokens: total.cachedInputTokens + (Number(usage.cachedInputTokens) || 0),
  }
}, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }))
const totalUsageLine = computed(() => formatUsageLine(totalUsage.value))

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

function canSpeak(provider) {
  if (!provider) return false
  const list = snapshot.value?.room?.launch_providers
  if (Array.isArray(list) && !list.includes(provider)) return false
  return readyProviderKinds.value.has(provider)
}

function providerUnavailableLabel(provider) {
  if (!readyProviderKinds.value.has(provider)) return t('room.agentUnavailable')
  if (!canSpeak(provider)) return t('room.cannotSpeak')
  return ''
}

function providerOptionLabel(provider) {
  const label = providerLabel(provider)
  return readyProviderKinds.value.has(provider) ? label : `${label} · ${t('room.unavailable')}`
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

function taskLabel(task) {
  if (!task) return ''
  return `#${task.number} ${task.title}`.trim()
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

async function uploadWorkspaceFiles() {
  if (uploading.value || !roomId.value || typeof props.api?.importFiles !== 'function') return
  uploading.value = true
  uploadError.value = false
  try {
    const result = await props.api.importFiles({ roomId: roomId.value })
    const names = (result?.files || []).map(file => file?.name).filter(Boolean)
    if (names.length) uploadedFiles.value = [...new Set([...uploadedFiles.value, ...names])]
  } catch {
    uploadError.value = true
  } finally {
    uploading.value = false
  }
}

watch(chatId, () => {
  uploadedFiles.value = []
  uploadError.value = false
  workPanelRequested.value = false
  workTab.value = ''
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

async function startCreating() {
  pickerError.value = false
  missingCaptain.value = false
  const agents = availableAgents.value
  if (!agents.length) {
    missingCaptain.value = true
    return
  }
  const team = await startingTeam(agents)
  selectedCaptain.value = team.find(role => role.isCaptain)?.provider || team[0].provider
  name.value = t('room.newChatTitle')
  await create(team)
}

function roleForAgent(agents, kind, isCaptain) {
  return {
    displayName: agents.find(agent => agent.kind === kind)?.label || kind,
    provider: kind,
    prompt: '',
    isCaptain,
  }
}

async function startingTeam(agents) {
  const fallback = agents[0].kind
  let prefs = {}
  try {
    prefs = (await desktopApi()?.workPreferences?.get()) || {}
  } catch { /* the first available agent stays the Captain */ }
  const available = new Set(agents.map(agent => agent.kind))
  const captain = available.has(prefs.defaultCaptainKind) ? prefs.defaultCaptainKind : fallback
  if (prefs.chatStartMode !== 'multi') return [roleForAgent(agents, captain, true)]
  const members = [...new Set((Array.isArray(prefs.defaultMemberKinds) ? prefs.defaultMemberKinds : []).filter(kind => available.has(kind)))]
  const kinds = members.includes(captain) ? members : [captain, ...members]
  const lead = kinds.includes(captain) ? captain : kinds[0]
  return (kinds.length ? kinds : [fallback]).map(kind => roleForAgent(agents, kind, kind === lead))
}

async function create(team) {
  const roles = Array.isArray(team) && team.length ? team : null
  if (!roles && !canCreate.value) return
  const provider = roles?.[0]?.provider || selectedCaptain.value
  if (!provider) return
  const resolved = roles || [roleForAgent(availableAgents.value, provider, true)]
  const result = await createRoom({
    name: name.value.trim(),
    title: name.value.trim(),
    providers: [...new Set(resolved.map(role => role.provider))],
    roles: resolved,
  })
  if (result) name.value = ''
}

function measureTitle() {
  const clip = titleClip.value
  const text = clip?.querySelector('.room-chat-title-text')
  titleOverflows.value = Boolean(text && text.scrollWidth > clip.clientWidth + 1)
}

function beginTitleEdit() {
  if (titleEditing.value || !chat.value) return
  titleEditCancelled = false
  titleEditing.value = true
  nextTick(() => {
    const el = titleText.value
    if (!el) return
    el.textContent = chat.value?.title || ''
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
}

function cancelTitleEdit() {
  titleEditCancelled = true
  titleEditing.value = false
}

async function commitTitleEdit(event) {
  const next = String(event?.target?.textContent || '').replace(/\s+/g, ' ').trim()
  titleEditing.value = false
  if (titleEditCancelled) {
    titleEditCancelled = false
    return
  }
  if (!next || next === chat.value?.title) return
  await renameChat(next)
}

const roleSkillChoices = computed(() => selectableSkills(skillInventoryState.value.skills, roleDraft.value?.provider))

async function loadSkillInventory() {
  if (typeof props.api?.skillInventory !== 'function') return false
  try {
    const listed = await props.api.skillInventory()
    if (!listed || !Array.isArray(listed.skills)) return false
    skillInventoryState.value = listed
    return true
  } catch {
    // Keep the previous selection intact when the inventory cannot be read;
    // filtering it against an empty list would silently clear the role.
    return false
  }
}

function applyRoleSkills(provider, ids) {
  const kept = keptSkillIds(ids, skillInventoryState.value.skills, provider)
  droppedSkillIds.value = (Array.isArray(ids) ? ids : []).filter(id => !kept.includes(id))
  if (roleDraft.value) roleDraft.value.skills = kept
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
    skills: [],
  }
  droppedSkillIds.value = []
  showPortraitPage(roleDraft.value.portrait)
  roleSettingsOpen.value = true
  nextTick(() => roleSettingsRef.value?.focus?.())
  loadSkillInventory().then((loaded) => {
    if (loaded && !roleDraft.value?.id) {
      applyRoleSkills(roleDraft.value?.provider, skillInventoryState.value.defaults?.[roleDraft.value?.provider] || [])
    }
  })
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
    portrait: role.portrait || portraitId(role.provider || ''),
    prompt: role.prompt || '',
    responsibilities: role.responsibilities || '',
    isCaptain: role.is_captain === true,
    nativePermission: role.native_permission || defaultPermission(role.provider || ''),
    skills: Array.isArray(role.skills) ? [...role.skills] : [],
  }
  droppedSkillIds.value = []
  showPortraitPage(roleDraft.value.portrait)
  roleSettingsOpen.value = true
  nextTick(() => roleSettingsRef.value?.focus?.())
  const equipped = roleDraft.value.skills
  loadSkillInventory().then((loaded) => {
    if (loaded && roleDraft.value?.id === role.id) applyRoleSkills(roleDraft.value.provider, equipped)
  })
}

function changeRoleProvider(provider) {
  if (!roleDraft.value || roleDraft.value.provider === provider) return
  roleDraft.value.provider = provider
  roleDraft.value.nativePermission = defaultPermission(provider)
  applyRoleSkills(provider, roleDraft.value.skills)
}

function toggleRoleSkill(id) {
  if (!roleDraft.value) return
  const current = roleDraft.value.skills
  if (current.includes(id)) {
    roleDraft.value.skills = current.filter(item => item !== id)
    return
  }
  roleDraft.value.skills = [...current, id]
}

async function rememberRoleSkills() {
  if (!roleDraft.value?.provider || typeof props.api?.rememberSkillDefault !== 'function') return
  await props.api.rememberSkillDefault({
    agent: roleDraft.value.provider,
    skillIds: roleDraft.value.skills,
  })
  await loadSkillInventory()
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
    skills: roleDraft.value.skills,
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

function openUsage() {
  workPanelRequested.value = true
  workPanelOpen.value = true
  workTab.value = 'usage'
}

function closeWorkPanel() {
  workPanelOpen.value = false
  workPanelRequested.value = false
}

function scrollToAttention() {
  document.querySelector('.room-attention-card')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
}

let workflowFocusTimer = 0
function focusWorkflowMessage(node) {
  const id = node?.messageId
  if (!id || typeof document === 'undefined') return
  const target = document.getElementById(`room-message-${id}`)
  if (!target) return
  document.querySelectorAll('.room-message-focus').forEach(item => item.classList.remove('room-message-focus'))
  target.classList.add('room-message-focus')
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  window.clearTimeout(workflowFocusTimer)
  workflowFocusTimer = window.setTimeout(() => target.classList.remove('room-message-focus'), 1600)
}

function closeWorkspaceDialog() {
  if (workspaceBusy.value) return
  workspaceDialogOpen.value = false
  workspaceNeedsMove.value = false
  pendingWorkspace.value = ''
}

async function applyWorkspace(workspace, move) {
  if (!props.api?.setWorkspace || !roomId.value || !workspace) return null
  const input = { roomId: roomId.value, workspace }
  if (move !== undefined) input.move = move
  return props.api.setWorkspace(input)
}

async function chooseWorkspace() {
  if (workspaceBusy.value || typeof props.pickDirectory !== 'function') return
  workspaceBusy.value = true
  workspaceNeedsMove.value = false
  try {
    const selected = await props.pickDirectory()
    if (!selected) return
    const result = await applyWorkspace(String(selected))
    if (result?.needsMove) {
      pendingWorkspace.value = String(selected)
      workspaceNeedsMove.value = true
      return
    }
    pendingWorkspace.value = ''
    workspaceDialogOpen.value = false
  } finally {
    workspaceBusy.value = false
  }
}

async function confirmWorkspaceMove(move) {
  if (workspaceBusy.value || !pendingWorkspace.value) return
  workspaceBusy.value = true
  try {
    await applyWorkspace(pendingWorkspace.value, move)
    pendingWorkspace.value = ''
    workspaceNeedsMove.value = false
    workspaceDialogOpen.value = false
  } finally {
    workspaceBusy.value = false
  }
}

async function keepWorkspace() {
  if (workspaceBusy.value || !props.api?.confirmWorkspace || !roomId.value) return
  workspaceBusy.value = true
  try {
    await props.api.confirmWorkspace({ roomId: roomId.value })
    workspaceDialogOpen.value = false
  } finally {
    workspaceBusy.value = false
  }
}

function handleEscape(event) {
  if (event.key !== 'Escape') return
  if (workspaceDialogOpen.value) {
    event.preventDefault()
    closeWorkspaceDialog()
  } else if (roleSettingsOpen.value) {
    event.preventDefault()
    closeRoleSettings()
  } else if (titleEditing.value) {
    event.preventDefault()
    cancelTitleEdit()
  }
}

watch([roomId, chatId], ([nextRoom, nextChat]) => {
  if (!nextRoom) return
  emit('active-change', { roomId: nextRoom, chatId: nextChat })
})

let promptedWorkspaceAttention = ''
watch(attentions, (list) => {
  const open = list.find(item => item.type === 'workspace_directory')
  if (!open || open.id === promptedWorkspaceAttention) return
  promptedWorkspaceAttention = open.id
  workspaceDialogOpen.value = true
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

watch(activeChatLabel, () => nextTick(measureTitle))

watch(roleSettingsOpen, (open) => {
  document.body.classList.toggle('room-overlay-open', open)
})

onMounted(() => {
  window.addEventListener('keydown', handleEscape)
  void load()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscape)
  finishLedgerResize()
  document.body.classList.remove('room-overlay-open')
})
</script>
<style scoped>
.room-workspace { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; padding: 0; gap: 0; background: var(--surface); color: var(--text); }
.room-message-focus { border-radius: 12px; box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 70%, transparent); }
.room-toolbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px clamp(16px, 3vw, 28px); border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 94%, var(--surface-raised)); }
.room-heading { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.room-project-name { align-self: flex-start; display: inline-flex; align-items: center; color: var(--faint); font-size: var(--text-2xs); }
.room-title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.room-title-row h1 { margin: 0; min-width: 0; font-size: var(--text-xl); font-weight: 650; line-height: 1.2; }
.room-chat-title { display: inline-flex; align-items: center; max-width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: text; }
.room-chat-title-clip { display: block; max-width: 10ch; overflow: hidden; }
.room-chat-title-text { display: inline-block; white-space: nowrap; outline: none; }
.room-chat-title.editing .room-chat-title-text { min-width: 4ch; max-width: 36ch; }
.room-chat-title-clip.marquee:hover .room-chat-title-text { animation: room-title-marquee 7s ease-in-out infinite; }
@keyframes room-title-marquee {
  0%, 18% { transform: translateX(0); }
  82%, 100% { transform: translateX(calc(10ch - 100%)); }
}
@media (prefers-reduced-motion: reduce) {
  .room-chat-title-clip.marquee:hover .room-chat-title-text { animation: none; }
}
.room-subtitle { max-width: 34ch; overflow: hidden; color: var(--faint); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.room-collaboration { flex: 1 1 auto; min-width: 0; }
.room-roster { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.room-roster-card { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; width: 168px; max-width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-raised); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.room-roster-card:hover { border-color: var(--border-strong); background: var(--surface-hover); }
.room-roster-card img { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; object-position: center 12%; }
.room-roster-name { max-width: 100%; overflow: hidden; font-size: var(--text-sm); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.room-roster-duty { display: -webkit-box; overflow: hidden; color: var(--text-soft); font-size: var(--text-2xs); line-height: 1.4; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.room-agent-badge { flex: 0 0 auto; margin-left: 2px; padding: 1px 5px; border-radius: 999px; background: var(--surface-active); color: var(--text-soft); font-size: 10px; font-weight: 600; }
.room-header-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.room-workspace-switch { height: 32px; padding: 0 10px; font-size: var(--text-xs); }
.room-workspace-dialog { width: min(420px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-raised); box-shadow: var(--shadow); }
.room-workspace-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.room-workspace-dialog header strong { font-size: var(--text-sm); }
.room-workspace-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.room-workspace-copy small { color: var(--text-soft); font-size: var(--text-xs); line-height: 1.45; }
.room-workspace-actions, .room-workspace-move { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.room-workspace-move { margin: 0; color: var(--text-soft); font-size: var(--text-xs); }
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
.room-welcome-team { display: flex; justify-content: center; align-items: flex-end; gap: 18px; margin-bottom: 18px; }
.room-welcome-face { position: relative; display: block; padding: 0; border: 0; background: transparent; cursor: pointer; }
.room-welcome-face img { width: 48px; height: 48px; border: 1.5px solid #12161a; border-radius: 50%; object-fit: cover; background: #1b2124; box-shadow: 0 8px 20px rgb(0 0 0 / 0.28); transform-origin: 50% 85%; transition: transform 0.18s ease; }
.room-welcome-face.captain img { width: 64px; height: 64px; }
.room-welcome-face:hover img,
.room-welcome-face:focus-visible img { animation: room-welcome-wobble 0.62s ease-in-out; transform: scale(1.5); }
.room-welcome-face:focus-visible { outline: none; }
@keyframes room-welcome-wobble {
  0% { transform: scale(1) rotate(0deg); }
  30% { transform: scale(1.5) rotate(-7deg); }
  58% { transform: scale(1.42) rotate(5deg); }
  100% { transform: scale(1.5) rotate(0deg); }
}
@media (prefers-reduced-motion: reduce) {
  .room-welcome-face:hover img,
  .room-welcome-face:focus-visible img { animation: none; transform: scale(1.5); }
}
.room-welcome-wave { position: absolute; top: -6px; right: -18px; padding: 2px 7px; border-radius: 999px; background: var(--surface-raised); color: var(--text); font-size: var(--text-2xs); box-shadow: 0 4px 12px rgb(0 0 0 / 0.25); pointer-events: none; }
.room-welcome-prompts { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 16px; }
.room-welcome-prompts button { padding: 7px 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-soft); font-family: inherit; font-size: var(--text-xs); cursor: pointer; }
.room-welcome-prompts button:hover, .room-welcome-prompts button:focus-visible { outline: none; border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); color: var(--text); }
.room-message { display: flex; gap: 12px; align-items: flex-start; margin: 0 0 24px; }
.room-message-user { flex-direction: row-reverse; }
.room-message-avatar { display: grid; flex: 0 0 44px; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; background: transparent; color: var(--text-soft); font: inherit; font-size: var(--text-xs); font-weight: 600; }
button.room-message-avatar { cursor: pointer; }
button.room-message-avatar:focus-visible { outline: none; }
.room-message-avatar :deep(.room-mascot-art),
.room-welcome-face :deep(.room-mascot-art) { width: 44px; height: 44px; }
.room-handoff-face :deep(.room-mascot-art),
.room-roster-card :deep(.room-mascot-art),
.room-usage-face :deep(.room-mascot-art) { width: 100%; height: 100%; }
button.room-message-avatar:hover img,
button.room-message-avatar:focus-visible img { animation: room-welcome-wobble 0.62s ease-in-out; transform: scale(1.5); }
@media (prefers-reduced-motion: reduce) {
  button.room-message-avatar:hover img,
  button.room-message-avatar:focus-visible img { animation: none; transform: scale(1.5); }
}
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
.room-composer-wrap { padding: 4px clamp(18px, 4vw, 48px) 14px; background: transparent; }
.room-composer { position: relative; display: flex; flex-direction: column; gap: 8px; width: min(820px, 100%); margin: 0 auto; padding: 12px 12px 8px; border: 1px solid color-mix(in srgb, var(--text) 8%, transparent); border-radius: 16px; background: color-mix(in srgb, var(--surface-raised) 92%, #000); box-shadow: none; }
.room-upload-row { display: flex; flex-wrap: wrap; gap: 6px; }
.room-upload-row span { max-width: 220px; overflow: hidden; padding: 1px 7px; border-radius: 6px; background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text-soft); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.room-upload-error { margin: 0; color: var(--danger, #f97066); font-size: var(--text-2xs); }
.room-composer-bar { display: flex; align-items: center; gap: 4px; }
.room-workspace :deep(.agent-inline-mention) { display: inline-block; margin: 0 1px; padding: 0 6px; border-radius: 6px; background: color-mix(in srgb, var(--mention, #8ab4ff) 24%, transparent); color: color-mix(in srgb, var(--mention, #8ab4ff) 72%, white); font-weight: 600; line-height: 1.55; }
.room-workspace :deep(.agent-inline-mention[data-agent-kind="claude"]) { --mention: #ff8a3d; }
.room-workspace :deep(.agent-inline-mention[data-agent-kind="codex"]) { --mention: #4c93ff; }
.room-workspace :deep(.agent-inline-mention[data-agent-kind="pi"]) { --mention: #8fd0ff; }
.room-workspace :deep(.agent-inline-mention[data-agent-kind="gemini"]) { --mention: #b388ff; }
.room-workspace :deep(.agent-inline-mention[data-agent-kind="hermes"]) { --mention: #3ecf8e; }
.room-workspace :deep(.agent-inline-mention[data-agent-kind="deepseek"]) { --mention: #5b7cff; }
.room-workspace :deep(.agent-inline-mention[data-agent-kind="kimi"]) { --mention: #67d4ff; }
.room-workspace :deep(.agent-inline-mention[data-agent-kind="qwen"]) { --mention: #f0b429; }
.room-composer-hint { margin-left: auto; color: var(--faint); font-size: var(--text-2xs); }
.room-composer-note { width: min(820px, 100%); margin: 8px auto 0; color: var(--faint); font-size: var(--text-2xs); text-align: center; }
.room-mention-menu { position: absolute; right: 12px; bottom: calc(100% + 8px); left: 12px; z-index: 5; display: flex; flex-direction: column; max-height: 220px; overflow: auto; padding: 6px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-raised); box-shadow: var(--elev-2); }
.room-mention-option { display: flex; align-items: center; width: 100%; min-height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: var(--text-sm); text-align: left; cursor: pointer; }
.room-mention-option:hover, .room-mention-option:focus-visible { outline: none; background: var(--surface-hover); }
.room-composer:focus-within { border-color: color-mix(in srgb, var(--text) 16%, transparent); }
.room-composer-tool, .room-composer-send { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; cursor: pointer; }
.room-composer-tool { width: 28px; height: 28px; border-radius: 8px; background: transparent; color: var(--muted); }
.room-composer-tool:hover:not(:disabled), .room-composer-tool:focus-visible { color: var(--text); background: var(--surface-hover); }
.room-composer-tool svg, .room-composer-send svg { width: 16px; height: 16px; }
.room-composer textarea { width: 100%; min-height: 44px; max-height: 140px; margin: 0; padding: 2px 2px 0; border: 0; border-radius: 0; background: transparent; resize: none; line-height: 1.5; }
.room-composer textarea:focus-visible { outline: none; }
.room-composer-send { width: 28px; height: 28px; border-radius: 50%; background: color-mix(in srgb, var(--text) 14%, transparent); color: var(--text-soft); }
.room-composer-send:disabled { opacity: 0.45; cursor: default; }
.room-composer-send:not(:disabled) { background: var(--text); color: var(--surface); }
.room-composer-send:hover:not(:disabled) { background: var(--text); }
.room-ledger { position: relative; display: flex; flex: 0 0 var(--room-ledger-width, 340px); width: var(--room-ledger-width, 340px); flex-direction: column; min-height: 0; overflow: hidden; padding: 12px 12px 0; border-left: 1px solid var(--border); background: var(--surface-raised); }
.room-ledger-header { display: flex; flex: 0 0 auto; gap: 10px; justify-content: space-between; align-items: center; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.room-ledger-header h2 { margin: 0; }
.room-work-tabs { display: flex; flex: 0 0 auto; gap: 2px; padding: 8px 0 0; border-bottom: 1px solid var(--border); }
.room-work-tab { flex: 1 1 0; min-width: 0; padding: 7px 2px 8px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--faint); font: inherit; font-size: var(--text-2xs); font-weight: 600; text-align: center; white-space: nowrap; cursor: pointer; }
.room-work-tab:hover { color: var(--text-soft); }
.room-work-tab.active { color: var(--text); border-bottom-color: var(--accent); }
.room-work-tab-count { margin-left: 3px; color: var(--faint); font-size: 9px; font-variant-numeric: tabular-nums; }
.room-work-scroll { flex: 1; min-height: 0; overflow: auto; padding: 12px 0 14px; }
.room-work-panel { display: flex; flex-direction: column; gap: 10px; }
.room-work-empty { margin: 8px 0; color: var(--faint); font-size: var(--text-xs); line-height: 1.55; text-align: center; }
.room-work-card { margin: 0; }
.room-work-group { display: flex; flex-direction: column; gap: 8px; }
.room-work-group + .room-work-group { margin-top: 4px; }
.room-work-group-title { margin: 0 0 2px; color: var(--faint); font-size: 10px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; }
.room-work-meta { display: flex; gap: 8px; align-items: baseline; margin-top: 8px; color: var(--faint); font-size: var(--text-2xs); }
.room-work-link { padding: 0; border: 0; background: transparent; color: var(--accent-text); font: inherit; font-size: var(--text-2xs); cursor: pointer; }
.room-work-link:hover, .room-work-link:focus-visible { outline: none; text-decoration: underline; }
.room-trace-item { position: relative; padding: 10px 11px 10px 14px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--surface) 70%, var(--surface-raised)); }
.room-trace-item::before { content: ""; position: absolute; top: 12px; bottom: 12px; left: 5px; width: 2px; border-radius: 2px; background: color-mix(in srgb, var(--border-strong) 65%, transparent); }
.room-trace-item[data-live="true"] { border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); }
.room-trace-item[data-live="true"]::before { background: var(--accent); box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 55%, transparent); }
.room-trace-item header { display: flex; gap: 8px; justify-content: space-between; align-items: baseline; }
.room-trace-item header strong { overflow-wrap: anywhere; font-size: var(--text-xs); }
.room-trace-item header span { flex: 0 0 auto; color: var(--faint); font-size: 10px; }
.room-trace-item header span[data-status="running"],
.room-trace-item header span[data-status="starting"],
.room-trace-item header span[data-status="queued"],
.room-trace-item header span[data-status="active"] { color: var(--accent-text); }
.room-trace-item header span[data-status="blocked"],
.room-trace-item header span[data-status="failed"],
.room-trace-item header span[data-status="interrupted"] { color: var(--warning); }
.room-trace-targets { margin: 4px 0 0; color: var(--text-soft); font-size: var(--text-2xs); line-height: 1.45; }
.room-trace-outcome { margin: 4px 0 0; color: var(--faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.room-trace-item time { display: block; margin-top: 4px; color: var(--faint); font-size: 10px; }
.room-artifact-card { margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--surface) 70%, var(--surface-raised)); }
.room-artifact-head { display: flex; gap: 10px; justify-content: space-between; align-items: baseline; }
.room-artifact-head strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room-artifact-head span { flex: 0 0 auto; color: var(--faint); font-size: 10px; }
.room-artifact-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 4px; color: var(--faint); font-size: var(--text-2xs); }
.room-artifact-maker { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: var(--text-soft); font-size: var(--text-2xs); }
.room-artifact-face { width: 22px; height: 22px; display: grid; overflow: hidden; border-radius: 50%; background: #1b2124; }
.room-artifact-face img { width: 100%; height: 100%; object-fit: cover; object-position: center 12%; }
.room-artifact-open { align-self: flex-start; margin-top: 8px; }
.room-usage-summary { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; }
.room-usage-summary span { color: var(--faint); font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; }
.room-usage-summary strong { color: var(--text-soft); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.room-usage-list { display: flex; flex-direction: column; gap: 14px; margin: 0; padding: 2px 2px 8px; list-style: none; }
.room-usage-agent { display: flex; align-items: center; gap: 6px; }
.room-usage-face { width: 22px; height: 22px; flex: 0 0 22px; display: grid; overflow: hidden; border-radius: 50%; background: #1b2124; }
.room-usage-face img { width: 100%; height: 100%; object-fit: cover; object-position: center 12%; }
.room-usage-agent strong { font-size: var(--text-sm); }
.room-usage-agent > span:last-child { margin-left: auto; color: var(--faint); font-size: var(--text-2xs); }
.room-usage-agent > span[data-status="working"] { color: var(--accent-text); }
.room-usage-model, .room-usage-line, .room-usage-context { margin: 2px 0 0; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-variant-numeric: tabular-nums; }
.room-usage-context { display: flex; gap: 8px; align-items: center; }
.room-usage-bar { flex: 1; height: 3px; border-radius: 999px; background: var(--surface-active); overflow: hidden; }
.room-usage-bar span { display: block; height: 100%; background: var(--accent); }
.room-card { padding: 12px; border: 1px solid var(--border); border-radius: 12px; margin-bottom: 10px; overflow-wrap: anywhere; }
.room-card.room-work-card { margin-bottom: 0; }
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
.room-message-stamp { align-self: center; display: inline-grid; flex: 0 0 auto; place-items: center; width: 14px; height: 14px; border-radius: 50%; background: color-mix(in srgb, var(--text) 7%, transparent); color: var(--text-soft); font-size: 9px; font-weight: 700; line-height: 1; }
.room-handoff-list { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.room-handoff { position: relative; padding-left: 12px; border-left: 2px solid color-mix(in srgb, var(--border-strong) 65%, transparent); }
.room-handoff[data-live="true"] { border-left-color: color-mix(in srgb, var(--accent) 65%, transparent); }
.room-handoff-strip { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; color: var(--faint); font-size: var(--text-2xs); }
.room-handoff-face { display: grid; flex: 0 0 18px; place-items: center; width: 18px; height: 18px; overflow: hidden; border-radius: 50%; background: #1b2124; color: var(--text-soft); font-size: 9px; font-weight: 600; }
.room-handoff-face img { width: 100%; height: 100%; object-fit: cover; object-position: center 12%; }
.room-handoff-arrow { color: var(--faint); font-size: 11px; line-height: 1; }
.room-handoff[data-live="true"] .room-handoff-arrow { color: var(--accent-text); animation: room-handoff-flow 1.6s ease-in-out infinite; }
.room-handoff-label { overflow: hidden; color: var(--text-soft); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.room-message-handoff { margin-top: 0; }
@keyframes room-handoff-flow {
  0%, 100% { opacity: 0.65; transform: translateX(0); }
  50% { opacity: 1; transform: translateX(2px); }
}
@media (prefers-reduced-motion: reduce) {
  .room-handoff[data-live="true"] .room-handoff-arrow { animation: none; }
}
@keyframes room-caret { 50% { opacity: 0; } }
.room-trace-list { padding-left: 18px; }
.room-trace-list li { margin-bottom: 8px; }
.room-trace-list span { display: block; color: var(--text-soft); }
.room-trace-blob pre { max-height: 16rem; overflow: auto; padding: 8px; border-radius: 8px; background: var(--surface); font-size: var(--text-xs); white-space: pre-wrap; }
.room-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.room-modal-backdrop, .room-settings-backdrop { position: fixed; inset: 0; z-index: 100; background: rgb(0 0 0 / 0.34); }
.room-settings-backdrop { display: grid; place-items: center; padding: 20px; }
.room-modal-backdrop { display: grid; place-items: center; padding: 20px; }
.room-modal { width: min(560px, 100%); max-height: calc(100vh - 40px); overflow: auto; background: var(--surface-raised); box-shadow: var(--elev-3); }
.room-modal-header { display: flex; gap: 12px; justify-content: space-between; align-items: center; }
.room-modal-header h2 { margin: 0; }
.room-create { display: flex; flex-direction: column; width: min(520px, 100%); padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 14px; }
.room-create-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 60px; padding: 14px 14px 14px 20px; border-bottom: 1px solid var(--border); }
.room-create-header h2 { margin: 0; font-size: 18px; font-weight: 650; }
.room-create-header .room-icon-button { border-color: transparent; background: transparent; }
.room-create-header .room-icon-button svg { width: 18px; height: 18px; }
.room-create-header .room-icon-button:hover { background: var(--surface-hover); }
.room-create-body { display: flex; flex-direction: column; gap: 16px; min-height: 0; overflow: auto; padding: 18px 20px 6px; }
.room-create-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; margin: 0; padding: 0; border: 0; }
.room-create-field > span, .room-create-legend { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--text-soft); font-size: 12px; font-weight: 650; }
.room-create-legend { width: 100%; padding: 0; }
.room-create-legend small { color: var(--muted); font-size: 11px; font-weight: 500; }
.room-create-field input:not([type="checkbox"]) { width: 100%; height: 38px; padding: 0 11px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); }
.room-directory { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.room-directory input { min-width: 0; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; text-overflow: ellipsis; }
.room-directory .secondary-button { display: inline-flex; align-items: center; gap: 6px; height: 38px; white-space: nowrap; }
.room-directory .secondary-button svg { width: 15px; height: 15px; }
.room-create-footer { justify-content: flex-end; padding: 14px 20px 16px; }
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
.room-skill-unavailable { display: grid; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); }
.room-skill-unavailable-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: var(--text-xs); }
.room-skill-unavailable-row small { color: var(--warning, #9a6700); }
.room-skill-unavailable-row button { margin-left: auto; }
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
  .room-collaboration { order: 3; flex-basis: 100%; }
  .room-header-actions { margin-left: auto; }
  .room-body { position: relative; }
  .room-ledger { position: absolute; inset: 0 0 0 auto; z-index: 20; width: min(var(--room-ledger-width, 340px), 100%); box-shadow: -18px 0 50px rgb(0 0 0 / 0.18); }
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
.room-provider-picker { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.room-provider-option { position: relative; min-width: 0; height: 52px; display: grid; grid-template-columns: 28px minmax(0, 1fr) 16px; align-items: center; gap: 8px; margin: 0; padding: 0 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); cursor: pointer; }
.room-provider-option:hover { border-color: var(--border-strong); }
.room-provider-option:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.room-provider-option:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
.room-provider-option img { width: 28px; height: 28px; object-fit: contain; }
.room-provider-option > span { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.room-provider-option input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
.room-provider-check { width: 16px; height: 16px; color: transparent; }
.room-provider-option:has(input:checked) .room-provider-check { color: var(--accent); }
@media (max-width: 520px) {
  .room-provider-picker, .room-directory { grid-template-columns: 1fr; }
}
@media (max-width: 950px) {
  .room-run-row { grid-template-columns: minmax(0, 1fr) auto auto; }
  .room-run-row > span:nth-child(2) { display: none; }
}
</style>

<style scoped>
.room-turn-usage { margin-left: auto; color: var(--faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-variant-numeric: tabular-nums; opacity: 0.55; white-space: nowrap; transition: opacity 0.16s ease; }
.room-message:hover .room-turn-usage,
.room-message:focus-within .room-turn-usage { opacity: 1; }
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
