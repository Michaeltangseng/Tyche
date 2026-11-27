<template>
  <section class="settings-page mock" :aria-label="t(titleKey)">
    <header v-if="section !== 'skills' && section !== 'usage'" class="settings-page-title">
      <div>
        <h1>
          {{ t(titleKey) }}
          <span v-if="section === 'orchestration'" class="settings-badge">{{ t('settingsUi.globalDefault') }}</span>
        </h1>
        <p>{{ t(hintKey) }}</p>
      </div>
    </header>

    <SkillsPage v-if="section === 'skills'" :api="skillApi" />

    <template v-else-if="section === 'orchestration'">
      <article class="settings-card">
        <h2>{{ t('settingsUi.defaultCaptain') }}</h2>
        <div class="mock-line">
          <select><option>Claude Code</option><option>Codex</option><option>Pi Agent</option></select>
        </div>
        <p class="settings-note">{{ t('settingsUi.captainDuty') }}</p>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.handoffRules') }}</h2>
        <div class="mock-line"><strong>{{ t('settingsUi.maxWake') }}</strong><span class="settings-stepper"><button type="button" @click="wake = Math.max(1, wake - 1)">−</button><input :value="wake" readonly /><button type="button" @click="wake = Math.min(4, wake + 1)">+</button></span><small>{{ t('settingsUi.promptNote') }}</small></div>
        <div class="mock-line"><strong>{{ t('settingsUi.maxSteps') }}</strong><span class="settings-stepper"><button type="button" @click="steps = Math.max(1, steps - 1)">−</button><input :value="steps" readonly /><button type="button" @click="steps = Math.min(50, steps + 1)">+</button></span><small>{{ t('settingsUi.loopNote') }}</small></div>
        <div class="mock-line"><button class="settings-switch" :class="{ on: confirmHandoff }" type="button" @click="confirmHandoff = !confirmHandoff"><i /></button><strong>{{ t('settingsUi.confirmHandoff') }}</strong></div>
        <div class="mock-line"><button class="settings-switch" :class="{ on: mentionUser }" type="button" @click="mentionUser = !mentionUser"><i /></button><strong>{{ t('settingsUi.mentionUser') }}</strong></div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.context') }}</h2>
        <div class="settings-choice-grid">
          <button v-for="item in contextModes" :key="item.id" class="settings-choice" :class="{ active: contextMode === item.id }" type="button" @click="contextMode = item.id">
            <strong>{{ t(item.title) }}</strong>
            <small>{{ item.meta }}</small>
            <small>{{ t(item.hint) }}</small>
          </button>
        </div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.failure') }}</h2>
        <div class="mock-line"><strong>{{ t('settingsUi.timeout') }}</strong><input class="narrow" value="10" readonly /><span>{{ t('settingsUi.minutes') }}</span><small>{{ t('settingsUi.timeoutHint') }}</small></div>
        <div class="mock-line">
          <strong>{{ t('settingsUi.onStop') }}</strong>
          <div class="settings-seg"><button v-for="item in failureModes" :key="item" type="button" :class="{ active: failure === item }" @click="failure = item">{{ t(`settingsUi.failureMode.${item}`) }}</button></div>
        </div>
        <div class="mock-line"><strong>{{ t('settingsUi.retryCount') }}</strong><span class="settings-stepper"><button type="button" @click="retries = Math.max(0, retries - 1)">−</button><input :value="retries" readonly /><button type="button" @click="retries = Math.min(5, retries + 1)">+</button></span><small>{{ t('settingsUi.retryHint') }}</small></div>
      </article>
      <article class="settings-card">
        <div class="settings-card-head"><h2>{{ t('settingsUi.templates') }}</h2><button class="primary-button" type="button">+ {{ t('settingsUi.newTemplate') }}</button></div>
        <div class="mock-line"><strong>{{ t('settingsUi.templatePlan') }}</strong><span class="flow">Claude → Codex → Pi → {{ t('settingsUi.stop') }}</span></div>
        <div class="mock-line"><strong>{{ t('settingsUi.templatePair') }}</strong><span class="flow">Codex ↔ Claude</span></div>
      </article>
      <footer class="save-bar"><span>{{ t('settingsUi.unsaved') }}</span><button class="secondary-button" type="button">{{ t('settingsUi.discard') }}</button><button class="primary-button" type="button">{{ t('settingsUi.save') }}</button></footer>
    </template>

    <template v-else-if="section === 'permissions'">
      <article class="settings-card perm-card">
        <div>
          <h2>{{ t('settingsUi.execution') }}</h2>
          <div v-for="agent in permissionAgents" :key="agent.id" class="mock-line">
            <img :src="agent.logo" alt="" />
            <strong>{{ agent.name }}</strong>
            <div class="settings-seg">
              <button v-for="mode in permissionModes" :key="mode" type="button" :class="{ active: agent.mode === mode, warn: mode === 'auto' && agent.mode === 'auto' }" @click="agent.mode = mode">{{ t(`settingsUi.permission.${mode}`) }}</button>
            </div>
          </div>
        </div>
        <aside v-if="autoCount" class="warn-panel">
          <strong>{{ t('settingsUi.autoBanner', { count: autoCount }) }}</strong>
          <p>{{ t('settingsUi.autoWarnBody') }}</p>
        </aside>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.filesCommands') }}</h2>
        <p class="settings-note">{{ t('settingsUi.filesLead') }}</p>
        <div class="mock-line"><strong>{{ t('settingsUi.writeScope') }}</strong><select><option>{{ t('settingsUi.workspaceOnly') }}</option></select><small>{{ t('settingsUi.writeScopeHint') }}</small></div>
        <div class="mock-line"><strong>{{ t('settingsUi.allowList') }}</strong><span class="settings-pills"><span class="settings-pill">git status</span><span class="settings-pill">npm test</span><span class="settings-pill">ls</span><button class="chip" type="button">+ {{ t('settingsUi.addChip') }}</button></span><small>{{ t('settingsUi.allowHint') }}</small></div>
        <div class="mock-line"><strong>{{ t('settingsUi.denyList') }}</strong><span class="settings-pills"><span class="settings-pill deny">rm -rf</span><span class="settings-pill deny">sudo</span><span class="settings-pill deny">git push --force</span><button class="chip" type="button">+ {{ t('settingsUi.addChip') }}</button></span><small>{{ t('settingsUi.denyHint') }}</small></div>
        <div class="mock-line"><strong>{{ t('settingsUi.network') }}</strong><button class="settings-switch" :class="{ on: allowNetwork }" type="button" @click="allowNetwork = !allowNetwork"><i /></button><small>{{ t('settingsUi.networkOff') }}</small></div>
      </article>
      <article class="settings-card">
        <div class="settings-card-head"><div><h2>{{ t('settingsUi.secrets') }}</h2><p>{{ t('settingsUi.secretsLead') }}</p></div><button class="primary-button" type="button">+ {{ t('settingsUi.addSecret') }}</button></div>
        <div class="mock-line"><strong>OPENAI_API_KEY</strong><span class="agent-mono">•••••••3f9a</span><small>{{ t('settingsUi.keychainShort') }}</small></div>
        <div class="mock-line"><strong>ANTHROPIC_API_KEY</strong><span class="agent-mono">•••••••c21e</span><small>{{ t('settingsUi.keychainShort') }}</small></div>
      </article>
    </template>

    <template v-else-if="section === 'general'">
      <article class="settings-card">
        <h2>{{ t('settingsUi.languageAppearance') }}</h2>
        <div class="mock-line"><div><strong>{{ t('generalSettings.languageTitle') }}</strong><small>{{ t('settingsUi.languageLead') }}</small></div><div class="settings-seg"><button type="button" :class="{ active: locale === 'zh' }" @click="setLocale('zh')">中文</button><button type="button" :class="{ active: locale === 'en' }" @click="setLocale('en')">English</button></div></div>
        <div class="mock-line"><div><strong>{{ t('generalSettings.themeTitle') }}</strong><small>{{ t('settingsUi.themeLead') }}</small></div><div class="settings-seg"><button v-for="item in themes" :key="item" type="button" :class="{ active: theme === item }" @click="setThemePreference(item)">{{ t(`generalSettings.theme${item[0].toUpperCase()}${item.slice(1)}`) }}</button></div></div>
        <div class="mock-line"><div><strong>{{ t('settingsUi.zoom') }}</strong><small>{{ t('settingsUi.zoomLead') }}</small></div><input v-model.number="zoom" type="range" min="80" max="150" step="10" /><b>{{ zoom }}%</b></div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.notifications') }}</h2>
        <div class="notice-head"><span /><span>{{ t('settingsUi.noticeCol.desktop') }}</span><span>{{ t('settingsUi.noticeCol.sound') }}</span><span>{{ t('settingsUi.noticeCol.badge') }}</span></div>
        <div v-for="row in notices" :key="row.id" class="notice-head">
          <div><strong>{{ t(`settingsUi.notice.${row.id}`) }}</strong><small>{{ t(row.lead) }}</small></div>
          <button v-for="channel in ['desktop', 'sound', 'badge']" :key="channel" class="settings-switch" :class="{ on: noticeState[`${row.id}-${channel}`] }" type="button" @click="noticeState[`${row.id}-${channel}`] = !noticeState[`${row.id}-${channel}`]"><i /></button>
        </div>
        <div class="mock-line"><div><strong>{{ t('settingsUi.unfocused') }}</strong><small>{{ t('settingsUi.unfocusedLead') }}</small></div><button class="settings-switch on" type="button"><i /></button></div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.shortcuts') }}</h2>
        <p class="settings-note">{{ t('settingsUi.shortcutLead') }}</p>
        <div v-for="item in shortcuts" :key="item.id" class="mock-line"><strong>{{ t(`settingsUi.shortcut.${item.id}`) }}</strong><span class="settings-kbd">{{ item.keys }}</span></div>
        <button class="agent-config-link" type="button">{{ t('settingsUi.viewAllShortcuts') }} →</button>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.startup') }}</h2>
        <div class="mock-line"><div><strong>{{ t('settingsUi.launchAtLogin') }}</strong><small>{{ t('settingsUi.launchHint') }}</small></div><button class="settings-switch" :class="{ on: launchAtLogin }" type="button" @click="launchAtLogin = !launchAtLogin"><i /></button></div>
        <div class="mock-line"><div><strong>{{ t('settingsUi.launchMinimized') }}</strong><small>{{ t('settingsUi.launchMinimizedHint') }}</small></div><button class="settings-switch" :class="{ on: minimized }" type="button" @click="minimized = !minimized"><i /></button></div>
        <div class="mock-line"><div><strong>{{ t('settingsUi.autoUpdate') }}</strong><small>{{ t('settingsUi.currentBuild') }}</small></div><button class="settings-switch on" type="button"><i /></button><button class="secondary-button" type="button">{{ t('settingsUi.checkUpdate') }}</button></div>
        <div class="mock-line"><div><strong>{{ t('settingsUi.updateChannel') }}</strong></div><select><option>{{ t('settingsUi.stable') }}</option></select></div>
      </article>
    </template>

    <UsageSettingsPanel v-else-if="section === 'usage'" />

    <template v-else-if="section === 'preferences'">
      <div class="settings-split">
        <article class="settings-card">
          <h2>{{ t('settingsUi.quickAdjust') }}</h2>
          <div class="settings-seg wrap">
            <button v-for="item in presets" :key="item" type="button" :class="{ active: preset === item }" @click="preset = item">{{ t(`settingsUi.preset.${item}`) }}</button>
          </div>
          <div class="mock-line column"><div class="ends"><span>{{ t('settingsUi.detailEnds') }}</span><span>30</span><span>{{ t('settingsUi.detailFull') }}</span></div><input type="range" min="0" max="100" value="30" /><small>{{ t('settingsUi.genDetail') }}</small></div>
          <div class="mock-line column"><div class="ends"><span>{{ t('settingsUi.pushWait') }}</span><span>70</span><span>{{ t('settingsUi.pushGo') }}</span></div><input type="range" min="0" max="100" value="70" /><small>{{ t('settingsUi.genPush') }}</small></div>
          <div class="mock-line column"><div class="ends"><span>{{ t('settingsUi.evidenceAct') }}</span><span>50</span><span>{{ t('settingsUi.evidenceSource') }}</span></div><input type="range" min="0" max="100" value="50" /><small>{{ t('settingsUi.genEvidence') }}</small></div>
        </article>
        <article class="settings-card">
          <h2>{{ t('settingsUi.globalInstructions') }} <small>{{ t('settingsUi.generatedBy') }}</small></h2>
          <textarea rows="8" readonly># {{ t('settingsUi.globalInstructions') }}
- {{ t('settingsUi.genDetail') }}
- {{ t('settingsUi.genPush') }}
- {{ t('settingsUi.genEvidence') }}</textarea>
          <p class="settings-note">{{ t('settingsUi.tokenInject') }}</p>
          <div class="mock-line"><strong>{{ t('settingsUi.allowOverride') }}</strong><button class="settings-switch on" type="button"><i /></button></div>
          <div class="settings-actions">
            <button class="secondary-button" type="button">{{ t('settingsUi.previewPrompt') }}</button>
            <button class="secondary-button" type="button">{{ t('settingsUi.discard') }}</button>
            <button class="primary-button" type="button">{{ t('settingsUi.save') }}</button>
          </div>
        </article>
      </div>
      <article class="settings-card">
        <h2>{{ t('settingsUi.interface') }}</h2>
        <div class="mock-line">
          <div>
            <strong>{{ t('settingsUi.titleMarquee') }}</strong>
            <small>{{ t('settingsUi.titleMarqueeHint') }}</small>
          </div>
          <button
            class="settings-switch"
            :class="{ on: titleMarqueeEnabled }"
            type="button"
            role="switch"
            :aria-checked="titleMarqueeEnabled ? 'true' : 'false'"
            :aria-label="t('settingsUi.titleMarquee')"
            @click="setTitleMarqueeEnabled(!titleMarqueeEnabled)"
          ><i /></button>
        </div>
        <div class="mock-line">
          <div>
            <strong>{{ t('settingsUi.openWorkbench') }}</strong>
            <small>{{ t('settingsUi.openWorkbenchHint') }}</small>
          </div>
          <button
            class="settings-switch"
            :class="{ on: openWorkbenchOnStart }"
            type="button"
            role="switch"
            :aria-checked="openWorkbenchOnStart ? 'true' : 'false'"
            :aria-label="t('settingsUi.openWorkbench')"
            :disabled="savingRunPreference"
            @click="setOpenWorkbench(!openWorkbenchOnStart)"
          ><i /></button>
        </div>
        <div class="mock-line">
          <div>
            <strong>{{ t('settingsUi.waitForInstruction') }}</strong>
            <small>{{ t('settingsUi.waitForInstructionHint') }}</small>
          </div>
          <button
            class="settings-switch"
            :class="{ on: rosterWaitsForInstruction }"
            type="button"
            role="switch"
            :aria-checked="rosterWaitsForInstruction ? 'true' : 'false'"
            :aria-label="t('settingsUi.waitForInstruction')"
            :disabled="savingRunPreference"
            @click="setRosterWaits(!rosterWaitsForInstruction)"
          ><i /></button>
        </div>
        <div class="mock-line column">
          <div>
            <strong>{{ t('settingsUi.userPortrait') }}</strong>
            <small>{{ t('settingsUi.userPortraitHint') }}</small>
          </div>
          <div class="pref-portraits" role="radiogroup" :aria-label="t('settingsUi.userPortrait')">
            <button
              v-for="mascot in userPortraits"
              :key="mascot.id"
              type="button"
              role="radio"
              :aria-checked="userPortrait === mascot.id ? 'true' : 'false'"
              :aria-label="mascot.name"
              :class="{ active: userPortrait === mascot.id }"
              :disabled="savingRunPreference"
              @click="setUserPortrait(userPortrait === mascot.id ? '' : mascot.id)"
            >
              <img :src="mascot.src" alt="" />
            </button>
          </div>
        </div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.chatStart') }}</h2>
        <p class="settings-note">{{ t('settingsUi.chatStartHint') }}</p>
        <div class="settings-seg chat-start-mode" role="radiogroup" :aria-label="t('settingsUi.chatStart')">
          <button type="button" role="radio" :aria-checked="chatStartMode === 'single'" :class="{ active: chatStartMode === 'single' }" :disabled="savingCaptain" @click="setChatStartMode('single')">{{ t('settingsUi.chatStartSingle') }}</button>
          <button type="button" role="radio" :aria-checked="chatStartMode === 'multi'" :class="{ active: chatStartMode === 'multi' }" :disabled="savingCaptain" @click="setChatStartMode('multi')">{{ t('settingsUi.chatStartMulti') }}</button>
        </div>
        <div class="pref-members" :role="chatStartMode === 'multi' ? 'group' : 'radiogroup'" :aria-label="t('settingsUi.chatStart')">
          <div
            v-for="agent in captainChoices"
            :key="agent.kind"
            class="pref-member"
            :data-selected="memberSelected(agent.kind) ? 'true' : undefined"
          >
            <button
              class="pref-member-logo"
              type="button"
              :aria-label="t('systemSettings.openAgentDetail', { agent: agent.label })"
              @click="openAgentDetail?.({ kind: agent.kind, label: agent.label })"
            >
              <img :src="agent.logo" alt="" />
            </button>
            <button class="pref-member-name" type="button" :role="chatStartMode === 'multi' ? 'checkbox' : 'radio'" :aria-checked="memberSelected(agent.kind)" :disabled="savingCaptain" @click="toggleStartMember(agent.kind)">
              {{ agent.label }}
            </button>
            <button
              v-if="chatStartMode === 'multi' && memberSelected(agent.kind) && captainKind !== agent.kind"
              class="pref-member-captain"
              type="button"
              :disabled="savingCaptain"
              @click="makeStartCaptain(agent.kind)"
            >
              {{ t('settingsUi.makeCaptain') }}
            </button>
            <span v-else-if="captainKind === agent.kind && memberSelected(agent.kind)" class="pref-member-badge">{{ t('settingsUi.defaultCaptain') }}</span>
          </div>
          <span v-if="!captainChoices.length" class="settings-note">{{ t('room.noProviders') }}</span>
        </div>
      </article>
    </template>

    <template v-else-if="section === 'diagnostics'">
      <article class="settings-card">
        <h2>{{ t('settingsUi.sessionData') }}</h2>
        <div class="mock-line"><strong>{{ t('settingsUi.keepLabel') }}</strong><select><option>{{ t('settingsUi.days90') }}</option></select></div>
        <div class="mock-line"><strong>{{ t('settingsUi.storageLabel') }}</strong><div class="settings-meter grow"><i style="width: 48%; background: var(--accent)" /><i style="width: 32%; background: #7c6cf0" /><i style="width: 16%; background: #8b9298" /></div><span>2.5 GB</span></div>
        <p class="settings-note">{{ t('settingsUi.storageLegend') }}</p>
        <div class="settings-actions"><button class="secondary-button" type="button">{{ t('settingsUi.exportChats') }}</button><button class="secondary-button" type="button">{{ t('settingsUi.exportMarkdown') }}</button></div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.traces') }}</h2>
        <div class="mock-line"><div><strong>{{ t('settingsUi.recordTrace') }}</strong><small>{{ t('settingsUi.recordTraceHint') }}</small></div><button class="settings-switch on" type="button"><i /></button></div>
        <div class="mock-line"><strong>{{ t('settingsUi.logLevel') }}</strong><div class="settings-seg"><button type="button">{{ t('settingsUi.levelBrief') }}</button><button class="active" type="button">{{ t('settingsUi.levelNormal') }}</button><button type="button">{{ t('settingsUi.levelVerbose') }}</button></div></div>
        <div class="mock-line"><strong>{{ t('settingsUi.debugMode') }}</strong><button class="settings-switch" type="button"><i /></button></div>
        <pre class="settings-log">20:19:02 Claude → @Codex
20:19:40 Codex
20:21:13 Pi → Captain</pre>
        <button class="agent-config-link" type="button">{{ t('settingsUi.openLogDir') }}</button>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.feedback') }}</h2>
        <div class="settings-actions"><button class="primary-button" type="button">{{ t('settingsUi.packDiagnostics') }}</button><small>{{ t('settingsUi.packHint') }}</small></div>
        <label class="mock-line"><input type="checkbox" /> {{ t('settingsUi.includeLast') }}</label>
      </article>
      <article class="settings-card settings-danger">
        <h2>{{ t('settingsUi.dangerZone') }}</h2>
        <div class="mock-line"><strong>{{ t('settingsUi.clearCache') }}</strong><span>420 MB</span><button class="secondary-button" type="button">{{ t('settingsUi.clear') }}</button></div>
        <div class="mock-line"><strong>{{ t('settingsUi.deleteSessions') }}</strong><small>{{ t('settingsUi.needConfirm') }}</small><button class="secondary-button danger" type="button">{{ t('settingsUi.delete') }}…</button></div>
        <div class="mock-line"><strong>{{ t('settingsUi.resetAll') }}</strong><span /><button class="secondary-button danger" type="button">{{ t('settingsUi.resetAll') }}</button></div>
      </article>
    </template>

    <template v-else-if="section === 'about'">
      <div class="settings-about">
        <img :src="mark" alt="" />
        <h1>Tyche</h1>
        <p>{{ t('settingsUi.product') }}</p>
        <p>{{ t('settingsUi.versionBuild') }} <span class="settings-badge">{{ t('settingsUi.latestBadge') }}</span></p>
        <div class="settings-actions">
          <button class="secondary-button" type="button">{{ t('settingsUi.checkUpdate') }}</button>
          <button class="secondary-button" type="button">{{ t('settingsUi.viewChangelog') }}</button>
        </div>
      </div>
      <article class="settings-card">
        <h2>{{ t('settingsUi.changelog') }}</h2>
        <ol class="timeline">
          <li><strong>0.8.3 · 11月20日</strong><span class="settings-badge">{{ t('settingsUi.newFeature') }}</span><p>{{ t('settingsUi.changeSkills') }}</p><p>{{ t('settingsUi.changeNav') }}</p></li>
          <li><strong>0.8.2 · 11月12日</strong><span class="settings-badge">{{ t('settingsUi.kindFix') }}</span><p>{{ t('settingsUi.changeWorktree') }}</p><p>{{ t('settingsUi.changeSteps') }}</p></li>
          <li><strong>0.8.0 · 11月1日</strong><span class="settings-badge">{{ t('settingsUi.newFeature') }}</span><p>{{ t('settingsUi.changeTemplates') }}</p></li>
        </ol>
      </article>
      <div class="settings-link-row">
        <button type="button">{{ t('settingsUi.feedbackLink') }}</button>
        <button type="button">{{ t('settingsUi.docs') }}</button>
        <button type="button">{{ t('settingsUi.community') }}</button>
      </div>
      <p class="settings-about-foot">{{ t('settingsUi.licenseLine') }}<br>{{ t('settingsUi.copyright') }}</p>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref, unref, watch } from 'vue'
import { agentLabel, agentLogo, publicAsset } from '../catalog.js'
import { desktopApi } from '../desktop.js'
import { locale as currentLocale, setLocale, t } from '../i18n.js'
import { ROOM_MASCOTS } from '../room-mascots.js'
import { applyRoomRunPreferences, openWorkbenchOnStart, rosterWaitsForInstruction, userPortrait } from '../room-run-preferences.js'
import { setTitleMarqueeEnabled, titleMarqueeEnabled } from '../title-marquee.js'
import SkillsPage from './skills/SkillsPage.vue'
import UsageSettingsPanel from './UsageSettingsPanel.vue'

const props = defineProps({
  section: { type: String, required: true },
  setThemePreference: { type: Function, required: true },
  themePreference: { type: [String, Object], required: true },
  skillApi: { type: Object, default: null },
  installedAgentKinds: { type: Array, default: () => [] },
  openAgentDetail: { type: Function, default: null },
})

const titles = {
  skills: ['systemSettings.skills', 'settingsUi.skillsLead'],
  orchestration: ['systemSettings.orchestration', 'settingsUi.orchestrationLead'],
  permissions: ['systemSettings.permissions', 'settingsUi.permissionsLead'],
  general: ['systemSettings.general', 'settingsUi.generalHint'],
  usage: ['systemSettings.usage', 'settingsUi.usageLead'],
  preferences: ['systemSettings.preferences', 'settingsUi.prefsLead'],
  diagnostics: ['systemSettings.diagnostics', 'settingsUi.diagnosticsHint'],
  about: ['systemSettings.about', 'settingsUi.aboutHint'],
  mcp: ['systemSettings.integrations', 'settingsUi.integrationsHint'],
}
const titleKey = computed(() => titles[props.section]?.[0] || 'systemSettings.title')
const hintKey = computed(() => titles[props.section]?.[1] || 'settingsUi.aboutHint')
const theme = computed(() => unref(props.themePreference))
const locale = currentLocale
const themes = ['system', 'light', 'dark']
const mark = publicAsset('logos/tyche-mark-v3.svg')
const wake = ref(1)
const steps = ref(8)
const retries = ref(2)
const confirmHandoff = ref(true)
const mentionUser = ref(false)
const contextMode = ref('summary')
const failure = ref('captain')
const allowNetwork = ref(false)
const zoom = ref(100)
const launchAtLogin = ref(false)
const minimized = ref(false)
const preset = ref('quick')
const contextModes = [
  { id: 'full', title: 'settingsUi.contextMode.full', meta: '~8K tokens', hint: 'settingsUi.contextHint.full' },
  { id: 'summary', title: 'settingsUi.contextMode.summary', meta: '~1K tokens', hint: 'settingsUi.contextHint.summary' },
  { id: 'last', title: 'settingsUi.contextMode.last', meta: '~200 tokens', hint: 'settingsUi.contextHint.last' },
]
const failureModes = ['retry', 'captain', 'notify']
const permissionModes = ['read', 'ask', 'auto']
const presets = ['quick', 'careful', 'explore', 'practical']
const permissionAgents = reactive([
  { id: 'codex', name: 'Codex', mode: 'ask', logo: publicAsset('agent-logos/codex.svg') },
  { id: 'claude', name: 'Claude Code', mode: 'ask', logo: publicAsset('agent-logos/claude.png') },
  { id: 'pi', name: 'Pi Agent', mode: 'auto', logo: publicAsset('agent-logos/pi.svg') },
  { id: 'gemini', name: 'Gemini CLI', mode: 'read', logo: publicAsset('agent-logos/gemini.svg') },
])
const autoCount = computed(() => permissionAgents.filter(agent => agent.mode === 'auto').length)
const notices = [
  { id: 'done', lead: 'settingsUi.notice.doneLead' },
  { id: 'approval', lead: 'settingsUi.notice.approvalLead' },
  { id: 'error', lead: 'settingsUi.notice.errorLead' },
]
const noticeState = reactive({
  'done-desktop': true, 'done-sound': false, 'done-badge': true,
  'approval-desktop': true, 'approval-sound': true, 'approval-badge': true,
  'error-desktop': true, 'error-sound': true, 'error-badge': true,
})
const shortcuts = [
  { id: 'summon', keys: '⌥ Space' },
  { id: 'newChat', keys: '⌘ N' },
  { id: 'mention', keys: '⌘ K' },
  { id: 'send', keys: '⏎' },
]
const captainKind = ref('')
const chatStartMode = ref('single')
const memberKinds = ref([])
const savingCaptain = ref(false)
const captainChoices = computed(() => (props.installedAgentKinds || []).map(kind => ({
  kind,
  label: agentLabel(kind),
  logo: agentLogo(kind),
})))

async function loadCaptainPreference() {
  const bridge = desktopApi()?.workPreferences
  if (!bridge?.get) return
  try {
    const value = await bridge.get()
    const choices = captainChoices.value
    const known = kind => choices.some(agent => agent.kind === kind)
    const savedCaptain = known(value?.defaultCaptainKind) ? value.defaultCaptainKind : (choices[0]?.kind || '')
    const savedMembers = (Array.isArray(value?.defaultMemberKinds) ? value.defaultMemberKinds : []).filter(known)
    const mode = value?.chatStartMode === 'multi' ? 'multi' : 'single'
    chatStartMode.value = mode
    captainKind.value = savedCaptain
    memberKinds.value = mode === 'single'
      ? (savedCaptain ? [savedCaptain] : [])
      : (savedMembers.includes(savedCaptain) || !savedCaptain ? savedMembers : [savedCaptain, ...savedMembers])
    if (mode === 'multi' && savedCaptain && !memberKinds.value.includes(savedCaptain)) {
      memberKinds.value = [savedCaptain, ...memberKinds.value]
    }
    applyRoomRunPreferences(value)
  } catch { /* keep the current selection */ }
}

const savingRunPreference = ref(false)

async function saveRunPreference(patch) {
  const bridge = desktopApi()?.workPreferences
  if (!bridge?.get || !bridge?.save || savingRunPreference.value) return
  savingRunPreference.value = true
  const previous = {
    openWorkbenchOnStart: openWorkbenchOnStart.value,
    rosterWaitsForInstruction: rosterWaitsForInstruction.value,
  }
  applyRoomRunPreferences(patch)
  try {
    const current = await bridge.get()
    await bridge.save({ ...current, ...patch })
  } catch {
    applyRoomRunPreferences(previous)
  } finally {
    savingRunPreference.value = false
  }
}

function setOpenWorkbench(enabled) {
  void saveRunPreference({ openWorkbenchOnStart: Boolean(enabled) })
}

function setRosterWaits(enabled) {
  void saveRunPreference({ rosterWaitsForInstruction: Boolean(enabled) })
}

const userPortraits = ROOM_MASCOTS

function setUserPortrait(id) {
  void saveRunPreference({ userPortrait: id })
}

function memberSelected(kind) {
  return chatStartMode.value === 'single' ? captainKind.value === kind : memberKinds.value.includes(kind)
}

async function saveStartTeam({ mode, captain, members }) {
  const bridge = desktopApi()?.workPreferences
  if (!bridge?.get || !bridge?.save || savingCaptain.value) return
  savingCaptain.value = true
  const previous = { mode: chatStartMode.value, captain: captainKind.value, members: [...memberKinds.value] }
  chatStartMode.value = mode
  captainKind.value = captain
  memberKinds.value = members
  try {
    const current = await bridge.get()
    await bridge.save({
      ...current,
      chatStartMode: mode,
      defaultCaptainKind: captain,
      defaultMemberKinds: members,
    })
  } catch {
    chatStartMode.value = previous.mode
    captainKind.value = previous.captain
    memberKinds.value = previous.members
  } finally {
    savingCaptain.value = false
  }
}

function setChatStartMode(mode) {
  const captain = captainKind.value || captainChoices.value[0]?.kind || ''
  if (!captain) return
  if (mode === 'single') {
    void saveStartTeam({ mode, captain, members: [captain] })
    return
  }
  const members = memberKinds.value.includes(captain) ? [...memberKinds.value] : [captain, ...memberKinds.value]
  void saveStartTeam({ mode, captain, members })
}

function toggleStartMember(kind) {
  const captain = captainKind.value || kind
  if (chatStartMode.value !== 'multi') {
    void saveStartTeam({ mode: 'single', captain: kind, members: [kind] })
    return
  }
  if (memberKinds.value.includes(kind)) {
    if (memberKinds.value.length === 1) return
    const members = memberKinds.value.filter(item => item !== kind)
    void saveStartTeam({ mode: 'multi', captain: members.includes(captain) ? captain : members[0], members })
    return
  }
  if (memberKinds.value.length >= 8) return
  void saveStartTeam({ mode: 'multi', captain, members: [...memberKinds.value, kind] })
}

function makeStartCaptain(kind) {
  const members = memberKinds.value.includes(kind) ? [...memberKinds.value] : [...memberKinds.value, kind]
  void saveStartTeam({ mode: 'multi', captain: kind, members })
}

onMounted(() => { if (props.section === 'preferences') void loadCaptainPreference() })
watch(() => props.section, (section) => {
  if (section === 'preferences') void loadCaptainPreference()
})
</script>

<style scoped>
.mock-line { display: flex; align-items: center; gap: 12px; min-height: 44px; }
.mock-line strong { min-width: 140px; font-size: 13px; }
.mock-line small, .settings-choice small { color: var(--muted); font-size: 12px; }
.mock-line.column { align-items: stretch; flex-direction: column; }
.mock-line img { width: 22px; height: 22px; }
.mock-line .narrow { width: 64px; }
.ends { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: 99px; background: transparent; color: var(--text-soft); font: inherit; font-size: 12px; cursor: pointer; }
.chip img { width: 16px; height: 16px; object-fit: contain; }
.chip.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); }
.pref-members { display: grid; gap: 8px; margin-top: 12px; }
.chat-start-mode button[aria-checked="false"] { background: transparent; color: var(--muted); }
.chat-start-mode button[aria-checked="true"] { background: var(--accent); color: var(--accent-contrast, #041416); }
.pref-member { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 12px; }
.pref-member[data-selected="true"] { border-color: var(--accent); background: var(--accent-soft); }
.pref-member-logo, .pref-member-name, .pref-member-captain { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.pref-member-logo { width: 32px; height: 32px; display: grid; place-items: center; padding: 0; border-radius: 10px; }
.pref-member-logo img { width: 22px; height: 22px; object-fit: contain; }
.pref-member-logo:hover, .pref-member-logo:focus-visible { outline: none; background: var(--surface-hover); }
.pref-member-name { flex: 1; min-width: 0; padding: 0; text-align: left; font-size: 13px; }
.pref-portraits { display: flex; flex-wrap: wrap; gap: 8px; }
.pref-portraits button { width: 40px; height: 40px; display: grid; place-items: center; padding: 2px; border: 1px solid var(--border); border-radius: 12px; background: transparent; cursor: pointer; }
.pref-portraits button img { width: 32px; height: 32px; }
.pref-portraits button.active, .pref-portraits button[aria-checked="true"] { border-color: var(--accent); background: var(--accent-soft); }
.pref-portraits button:hover, .pref-portraits button:focus-visible { outline: none; background: var(--surface-hover); }
.pref-member-captain, .pref-member-badge { flex: 0 0 auto; color: var(--accent-text); font-size: 12px; }
.pref-member-captain { padding: 4px 8px; border-radius: 999px; }
.pref-member-captain:hover, .pref-member-captain:focus-visible { outline: none; background: var(--surface-hover); }
.chip.warn { border-color: #f5a524; color: #f5a524; }
.mock-filters { flex-wrap: wrap; margin-bottom: 8px; }
.mock-filters input { height: 32px; min-width: 160px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); }
.settings-mini-table tr.picked td { background: var(--accent-soft); }
.stack { flex-direction: column; align-items: stretch; }
.danger { color: #f2555a; border-color: #f2555a; }
.perm-card { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 16px; }
.warn-panel { align-self: start; padding: 12px; border-radius: 10px; background: color-mix(in srgb, #f5a524 16%, transparent); color: #f5a524; font-size: 12px; }
.warn-panel p { margin: 6px 0 0; }
.notice-head { display: grid; grid-template-columns: minmax(0, 1fr) 72px 72px 72px; align-items: center; gap: 8px; min-height: 48px; }
.notice-head span, .notice-head small { color: var(--muted); font-size: 12px; }
.stat-grid { display: grid; grid-template-columns: 1.35fr repeat(3, minmax(0, 1fr)); gap: 12px; }
.stat-card { display: flex; flex-direction: column; justify-content: space-between; min-height: 118px; }
.stat-card header, .usage-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.stat-card header span, .legend { color: var(--muted); font-size: 12px; }
.stat-card h2 { margin: 8px 0 4px; font-size: 28px; letter-spacing: -0.03em; }
.stat-card small { color: var(--muted); font-size: 12px; }
.fee-meter { height: 6px; margin-top: 12px; overflow: hidden; border-radius: 99px; background: color-mix(in srgb, var(--text) 12%, transparent); }
.fee-meter i { display: block; width: 71%; height: 100%; background: linear-gradient(90deg, #2bbbad 0%, #f5a524 100%); }
.usage-split { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(220px, 0.72fr); gap: 14px; }
.legend { display: flex; align-items: center; margin: 0; }
.swatch { width: 8px; height: 8px; margin: 0 6px 0 12px; border-radius: 2px; }
.usage-chart { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 8px; margin-top: 8px; }
.usage-yaxis { display: flex; flex-direction: column; justify-content: space-between; height: 148px; color: var(--faint); font-size: 11px; }
.usage-plot { min-width: 0; }
.usage-bars { display: flex; align-items: flex-end; gap: 3px; height: 148px; padding: 0 2px; border-bottom: 1px solid var(--border); }
.usage-bars span { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.usage-bars i { display: block; width: 100%; }
.usage-bars .gemini { height: 10%; }
.usage-bars .pi { height: 16%; }
.usage-bars .claude { height: 28%; }
.usage-bars .codex { height: 46%; }
.codex { background: #4c8dff; }
.claude { background: #f5a524; }
.pi { background: #3ecf8e; }
.gemini { background: #b07cff; }
.usage-xaxis { display: flex; justify-content: space-between; margin-top: 6px; color: var(--faint); font-size: 11px; }
.room-row { display: grid; grid-template-columns: 88px minmax(0, 1fr) 58px; align-items: center; gap: 10px; min-height: 36px; }
.room-row i { display: block; height: 6px; overflow: hidden; border-radius: 99px; background: color-mix(in srgb, var(--text) 8%, transparent); }
.room-row b { display: block; height: 100%; border-radius: inherit; background: #2ec8c0; }
.room-row strong { font-size: 12px; font-weight: 600; text-align: right; }
.usage-agents td:first-child { display: flex; align-items: center; gap: 8px; }
.usage-agents img { width: 18px; height: 18px; }
.share { display: flex; align-items: center; gap: 8px; min-width: 140px; }
.share-track { flex: 1; height: 6px; }
.share i { display: block; height: 6px; border-radius: 99px; }
.budget-row { display: grid; grid-template-columns: 120px 160px minmax(180px, 1.1fr) 140px minmax(160px, 1fr); gap: 14px; align-items: start; }
.budget-row label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
.budget-row input, .budget-row select, .mock-line select, .mock-line input[type="range"] { width: 100%; height: 32px; box-sizing: border-box; }
.budget-row small { color: var(--faint); }
.usage-choice { display: inline-flex; gap: 6px; }
.usage-choice button { height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--muted); font: inherit; font-size: 12px; }
.usage-choice .pause { border-color: transparent; background: #f5a524; color: #1b1408; font-weight: 650; }
.ok { color: #3ecf8e !important; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.save-bar { display: flex; justify-content: flex-end; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.timeline { margin: 0; padding: 0 0 0 16px; border-left: 2px solid var(--accent); }
.timeline li { margin: 0 0 14px; list-style: none; }
.timeline p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.settings-about-foot { color: var(--muted); font-size: 12px; text-align: center; }
.grow { flex: 1; }
@media (max-width: 980px) {
  .perm-card, .stat-grid, .budget-row, .usage-split, .notice-head { grid-template-columns: 1fr; }
}
</style>
