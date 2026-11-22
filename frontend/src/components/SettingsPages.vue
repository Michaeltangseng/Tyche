<template>
  <section class="settings-page" :aria-label="t(titleKey)">
    <header class="settings-page-title">
      <div>
        <h1>
          {{ t(titleKey) }}
          <span v-if="section === 'orchestration'" class="settings-badge">{{ t('settingsUi.globalDefault') }}</span>
        </h1>
        <p>{{ t(hintKey) }}</p>
      </div>
      <div v-if="section === 'skills'" class="settings-actions">
        <button class="secondary-button" type="button">{{ t('settingsUi.browseMarket') }}</button>
        <button class="secondary-button" type="button">{{ t('settingsUi.importAgents') }}</button>
        <button class="primary-button" type="button">{{ t('settingsUi.newSkill') }}</button>
      </div>
      <div v-else-if="section === 'usage'" class="settings-seg">
        <button v-for="item in ranges" :key="item" type="button" :class="{ active: range === item }" @click="range = item">{{ t(`settingsUi.range.${item}`) }}</button>
      </div>
    </header>

    <template v-if="section === 'skills'">
      <div class="settings-split">
        <div class="settings-card">
          <div class="settings-actions" style="margin-bottom: 12px">
            <input :placeholder="t('settingsUi.searchSkill')" :aria-label="t('settingsUi.searchSkill')" />
            <div class="settings-seg">
              <button v-for="item in skillFilters" :key="item" type="button" :class="{ active: skillFilter === item }" @click="skillFilter = item">{{ t(`settingsUi.skillFilter.${item}`) }}</button>
            </div>
          </div>
          <table class="settings-mini-table">
            <thead><tr><th>Skill</th><th>Codex</th><th>Claude</th><th>Pi</th><th>Gemini</th><th>{{ t('settingsUi.trust') }}</th><th>{{ t('settingsUi.updated') }}</th></tr></thead>
            <tbody>
              <tr v-for="skill in skills" :key="skill.name" :style="selectedSkill === skill.name ? 'background: var(--accent-soft)' : ''" @click="selectedSkill = skill.name">
                <td><strong>{{ skill.name }}</strong><br><small>{{ t(skill.source) }}</small></td>
                <td><button class="settings-switch" :class="{ on: skill.codex }" type="button" @click.stop="skill.codex = !skill.codex"><i /></button></td>
                <td><button class="settings-switch" :class="{ on: skill.claude }" type="button" @click.stop="skill.claude = !skill.claude"><i /></button></td>
                <td><button class="settings-switch" :class="{ on: skill.pi }" type="button" @click.stop="skill.pi = !skill.pi"><i /></button></td>
                <td><button class="settings-switch" :class="{ on: skill.gemini }" type="button" @click.stop="skill.gemini = !skill.gemini"><i /></button></td>
                <td><span :class="skill.trust === 'changed' ? 'settings-dot warn' : 'settings-dot ready'" />{{ t(`settingsUi.trustState.${skill.trust}`) }}</td>
                <td>{{ skill.when }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <aside class="settings-side">
          <h3>frontend-design</h3>
          <p>v1.4 · {{ t('settingsUi.sharedLibrary') }}</p>
          <p>{{ t('settingsUi.skillBlurb') }}</p>
          <p><strong>{{ t('settingsUi.distributedTo') }}</strong><br>Codex<br>Claude</p>
          <pre class="settings-log"># frontend-design</pre>
          <div class="settings-actions" style="flex-direction: column; align-items: stretch">
            <button class="primary-button" type="button">{{ t('settingsUi.distribute') }}</button>
            <button class="secondary-button" type="button">{{ t('settingsUi.openSource') }}</button>
            <button class="secondary-button" type="button">{{ t('settingsUi.revokeTrust') }}</button>
          </div>
        </aside>
      </div>
    </template>

    <template v-else-if="section === 'orchestration'">
      <article class="settings-card">
        <h2>{{ t('settingsUi.defaultCaptain') }}</h2>
        <div class="settings-field"><strong>{{ t('settingsUi.defaultCaptain') }}</strong><select><option>Claude Code</option><option>Codex</option></select><small>{{ t('settingsUi.defaultCaptainHint') }}</small></div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.handoffRules') }}</h2>
        <div class="settings-field"><strong>{{ t('settingsUi.maxWake') }}</strong><span class="settings-stepper"><button type="button" @click="wake = Math.max(1, wake - 1)">−</button><input :value="wake" readonly /><button type="button" @click="wake = Math.min(4, wake + 1)">+</button></span><small>{{ t('settingsUi.maxWakeHint') }}</small></div>
        <div class="settings-field"><strong>{{ t('settingsUi.maxSteps') }}</strong><span class="settings-stepper"><button type="button" @click="steps = Math.max(1, steps - 1)">−</button><input :value="steps" readonly /><button type="button" @click="steps = Math.min(50, steps + 1)">+</button></span><small>{{ t('settingsUi.maxStepsHint') }}</small></div>
        <div class="settings-field"><strong>{{ t('settingsUi.confirmHandoff') }}</strong><button class="settings-switch" :class="{ on: confirmHandoff }" type="button" @click="confirmHandoff = !confirmHandoff"><i /></button><small>{{ t('settingsUi.confirmHandoffHint') }}</small></div>
        <div class="settings-field"><strong>{{ t('settingsUi.mentionUser') }}</strong><button class="settings-switch" :class="{ on: mentionUser }" type="button" @click="mentionUser = !mentionUser"><i /></button><small>{{ t('settingsUi.mentionUserHint') }}</small></div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.context') }}</h2>
        <div class="settings-choice-grid">
          <button v-for="item in contextModes" :key="item" class="settings-choice" :class="{ active: contextMode === item }" type="button" @click="contextMode = item">
            <strong>{{ t(`settingsUi.contextMode.${item}`) }}</strong>
            <small>{{ t(`settingsUi.contextHint.${item}`) }}</small>
          </button>
        </div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.failure') }}</h2>
        <div class="settings-field"><strong>{{ t('settingsUi.timeout') }}</strong><input value="10" readonly /><small>{{ t('settingsUi.minutes') }}</small></div>
        <div class="settings-field"><strong>{{ t('settingsUi.onStop') }}</strong><div class="settings-seg"><button v-for="item in failureModes" :key="item" type="button" :class="{ active: failure === item }" @click="failure = item">{{ t(`settingsUi.failureMode.${item}`) }}</button></div><span /></div>
      </article>
      <article class="settings-card">
        <div class="settings-card-head"><h2>{{ t('settingsUi.templates') }}</h2><button class="secondary-button" type="button">{{ t('settingsUi.newTemplate') }}</button></div>
        <div class="settings-field"><strong>{{ t('settingsUi.templatePlan') }}</strong><span>Claude → Codex → Pi → {{ t('settingsUi.stop') }}</span><span /></div>
        <div class="settings-field"><strong>{{ t('settingsUi.templatePair') }}</strong><span>Codex ↔ Claude</span><span /></div>
      </article>
    </template>

    <template v-else-if="section === 'permissions'">
      <div v-if="autoCount" class="settings-banner">{{ t('settingsUi.autoBanner', { count: autoCount }) }}</div>
      <article class="settings-card">
        <h2>{{ t('settingsUi.execution') }}</h2>
        <div v-for="agent in permissionAgents" :key="agent.id" class="settings-field">
          <strong>{{ agent.name }}</strong>
          <div class="settings-seg">
            <button v-for="mode in permissionModes" :key="mode" type="button" :class="{ active: agent.mode === mode, warn: mode === 'auto' && agent.mode === 'auto' }" @click="agent.mode = mode">{{ t(`settingsUi.permission.${mode}`) }}</button>
          </div>
          <span />
        </div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.filesCommands') }}</h2>
        <div class="settings-field"><strong>{{ t('settingsUi.writeScope') }}</strong><select><option>{{ t('settingsUi.workspaceOnly') }}</option></select><small>{{ t('settingsUi.writeScopeHint') }}</small></div>
        <div class="settings-field"><strong>{{ t('settingsUi.allowList') }}</strong><span class="settings-pills"><span class="settings-pill">git status</span><span class="settings-pill">npm test</span><span class="settings-pill">ls</span></span><small>{{ t('settingsUi.allowHint') }}</small></div>
        <div class="settings-field"><strong>{{ t('settingsUi.denyList') }}</strong><span class="settings-pills"><span class="settings-pill deny">rm -rf</span><span class="settings-pill deny">sudo</span><span class="settings-pill deny">git push --force</span></span><small>{{ t('settingsUi.denyHint') }}</small></div>
        <div class="settings-field"><strong>{{ t('settingsUi.network') }}</strong><button class="settings-switch" :class="{ on: allowNetwork }" type="button" @click="allowNetwork = !allowNetwork"><i /></button><small>{{ t('settingsUi.networkHint') }}</small></div>
      </article>
      <article class="settings-card">
        <div class="settings-card-head"><h2>{{ t('settingsUi.skillTrust') }}</h2><button class="secondary-button" type="button">{{ t('settingsUi.revoke') }}</button></div>
        <p>frontend-design · Claude Code · {{ t('settingsUi.trustState.trusted') }}</p>
      </article>
      <article class="settings-card">
        <div class="settings-card-head"><h2>{{ t('settingsUi.secrets') }}</h2><button class="primary-button" type="button">{{ t('settingsUi.addSecret') }}</button></div>
        <div class="settings-field"><strong>OPENAI_API_KEY</strong><span class="agent-mono">•••••••3f9a</span><small>{{ t('settingsUi.keychain') }}</small></div>
        <div class="settings-field"><strong>ANTHROPIC_API_KEY</strong><span class="agent-mono">•••••••c21e</span><small>{{ t('settingsUi.keychain') }}</small></div>
      </article>
    </template>

    <template v-else-if="section === 'general'">
      <article class="settings-card">
        <h2>{{ t('settingsUi.languageAppearance') }}</h2>
        <div class="settings-field"><strong>{{ t('generalSettings.languageTitle') }}</strong><div class="settings-seg"><button type="button" :class="{ active: locale === 'zh' }" @click="setLocale('zh')">中文</button><button type="button" :class="{ active: locale === 'en' }" @click="setLocale('en')">English</button></div><small>{{ t('generalSettings.languageHint') }}</small></div>
        <div class="settings-field"><strong>{{ t('generalSettings.themeTitle') }}</strong><div class="settings-seg"><button v-for="item in themes" :key="item" type="button" :class="{ active: theme === item }" @click="setThemePreference(item)">{{ t(`generalSettings.theme${item[0].toUpperCase()}${item.slice(1)}`) }}</button></div><small>{{ t('generalSettings.themeHint') }}</small></div>
        <div class="settings-field"><strong>{{ t('settingsUi.zoom') }}</strong><input v-model.number="zoom" type="range" min="80" max="150" step="10" /><small>{{ zoom }}%</small></div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.notifications') }}</h2>
        <div v-for="row in notices" :key="row.id" class="settings-field">
          <strong>{{ t(`settingsUi.notice.${row.id}`) }}</strong>
          <span class="settings-actions"><button v-for="channel in row.channels" :key="channel" class="settings-switch" :class="{ on: noticeState[`${row.id}-${channel}`] }" type="button" @click="noticeState[`${row.id}-${channel}`] = !noticeState[`${row.id}-${channel}`]"><i /></button></span>
          <small>{{ t(`settingsUi.noticeHint.${row.id}`) }}</small>
        </div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.shortcuts') }}</h2>
        <div v-for="item in shortcuts" :key="item.id" class="settings-field"><strong>{{ t(`settingsUi.shortcut.${item.id}`) }}</strong><span><kbd class="settings-kbd">{{ item.keys }}</kbd></span><span /></div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.startup') }}</h2>
        <div class="settings-field"><strong>{{ t('settingsUi.launchAtLogin') }}</strong><button class="settings-switch" :class="{ on: launchAtLogin }" type="button" @click="launchAtLogin = !launchAtLogin"><i /></button><span /></div>
        <div class="settings-field"><strong>{{ t('settingsUi.autoUpdate') }}</strong><button class="settings-switch on" type="button"><i /></button><small>{{ t('settingsUi.upToDate') }}</small></div>
      </article>
    </template>

    <template v-else-if="section === 'workspace'">
      <article class="settings-card">
        <h2>{{ t('settingsUi.defaultDirs') }}</h2>
        <div class="settings-field"><strong>{{ t('settingsUi.projectDir') }}</strong><input value="~/Projects" readonly /><button class="secondary-button" type="button">{{ t('settingsUi.choose') }}</button></div>
        <div class="settings-field"><strong>{{ t('settingsUi.outputDir') }}</strong><select><option>{{ t('settingsUi.docsDir') }}</option></select><small>{{ t('settingsUi.outputHint') }}</small></div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.roomBinding') }}</h2>
        <div v-for="room in rooms" :key="room.name" class="settings-field">
          <strong>{{ room.name }}</strong>
          <span>{{ room.path }}</span>
          <button v-if="!room.bound" class="secondary-button" type="button">{{ t('settingsUi.bind') }}</button>
          <span v-else />
        </div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.concurrency') }}</h2>
        <div class="settings-choice-grid">
          <button v-for="item in concurrencyModes" :key="item" class="settings-choice" :class="{ active: concurrency === item }" type="button" @click="concurrency = item">
            <strong>{{ t(`settingsUi.concurrencyMode.${item}`) }}</strong>
            <small>{{ t(`settingsUi.concurrencyHint.${item}`) }}</small>
          </button>
        </div>
        <div class="settings-field"><strong>{{ t('settingsUi.merge') }}</strong><div class="settings-seg"><button type="button" :class="{ active: merge === 'captain' }" @click="merge = 'captain'">{{ t('settingsUi.mergeCaptain') }}</button><button type="button" :class="{ active: merge === 'review' }" @click="merge = 'review'">{{ t('settingsUi.mergeReview') }}</button></div><span /></div>
      </article>
    </template>

    <template v-else-if="section === 'integrations'">
      <article class="settings-card">
        <h2>{{ t('systemSettings.knowledgeBases') }}</h2>
        <div class="settings-choice-grid">
          <div class="settings-choice"><strong>{{ t('settingsUi.feishu') }}</strong><small>{{ t('settingsUi.cliMissing') }}</small></div>
          <div class="settings-choice"><strong>{{ t('settingsUi.dingtalk') }}</strong><small>{{ t('settingsUi.cliMissing') }}</small></div>
          <div class="settings-choice"><strong>Obsidian</strong><small>~/Notes/Vault</small></div>
        </div>
      </article>
      <article class="settings-card">
        <div class="settings-card-head"><h2>MCP Server</h2><span class="settings-actions"><button class="primary-button" type="button">{{ t('settingsUi.addMcp') }}</button><button class="secondary-button" type="button">{{ t('settingsUi.importJson') }}</button></span></div>
        <table class="settings-mini-table">
          <thead><tr><th>{{ t('settingsUi.name') }}</th><th>{{ t('settingsUi.transport') }}</th><th>{{ t('systemSettings.columnStatus') }}</th><th>{{ t('settingsUi.availableAgents') }}</th></tr></thead>
          <tbody>
            <tr><td>filesystem</td><td>stdio</td><td><i class="settings-dot ready" />{{ t('settingsUi.running') }}</td><td>Codex · Pi</td></tr>
            <tr><td>github</td><td>stdio</td><td><i class="settings-dot ready" />{{ t('settingsUi.running') }}</td><td>Claude</td></tr>
            <tr><td>postgres</td><td>stdio</td><td><i class="settings-dot danger" />{{ t('settingsUi.failed') }}</td><td>—</td></tr>
          </tbody>
        </table>
        <p class="settings-note">{{ t('settingsUi.mcpHint') }}</p>
      </article>
    </template>

    <template v-else-if="section === 'usage'">
      <div class="settings-choice-grid">
        <article class="settings-card"><h2>$42.80</h2><p class="settings-note">{{ t('settingsUi.monthCost') }} · 71%</p><div class="settings-meter"><i style="width: 71%; background: var(--accent)" /></div></article>
        <article class="settings-card"><h2>1.8M</h2><p class="settings-note">{{ t('settingsUi.tokens') }}</p></article>
        <article class="settings-card"><h2>36</h2><p class="settings-note">{{ t('settingsUi.handoffs') }}</p></article>
        <article class="settings-card"><h2>2</h2><p class="settings-note">{{ t('settingsUi.stoppedLoops') }}</p></article>
      </div>
      <article class="settings-card">
        <h2>{{ t('settingsUi.dailyCost') }}</h2>
        <div class="settings-bars"><i style="height: 40%" /><i style="height: 70%" /><i style="height: 55%" /><i style="height: 90%" /><i style="height: 48%" /><i style="height: 62%" /><i style="height: 30%" /></div>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.budget') }}</h2>
        <div class="settings-field"><strong>{{ t('settingsUi.monthlyBudget') }}</strong><input value="60" readonly /><small>USD</small></div>
        <div class="settings-field"><strong>{{ t('settingsUi.onExceed') }}</strong><div class="settings-seg"><button type="button" class="active">{{ t('settingsUi.warnOnly') }}</button><button type="button">{{ t('settingsUi.pauseAgents') }}</button></div><span /></div>
      </article>
    </template>

    <template v-else-if="section === 'preferences'">
      <div class="settings-split">
        <article class="settings-card">
          <h2>{{ t('settingsUi.quickAdjust') }}</h2>
          <div class="settings-seg" style="margin-bottom: 12px">
            <button v-for="item in presets" :key="item" type="button" :class="{ active: preset === item }" @click="preset = item">{{ t(`settingsUi.preset.${item}`) }}</button>
          </div>
          <div v-for="dial in dials" :key="dial" class="settings-field"><strong>{{ t(`settingsUi.dial.${dial}`) }}</strong><input type="range" min="0" max="100" value="50" /><small>50</small></div>
        </article>
        <article class="settings-card">
          <h2>{{ t('settingsUi.globalInstructions') }}</h2>
          <textarea rows="8" :placeholder="t('settingsUi.instructionsPlaceholder')" />
          <p class="settings-note">{{ t('settingsUi.tokenEstimate') }}</p>
        </article>
      </div>
    </template>

    <template v-else-if="section === 'diagnostics'">
      <article class="settings-card">
        <h2>{{ t('settingsUi.sessionData') }}</h2>
        <div class="settings-field"><strong>{{ t('settingsUi.retention') }}</strong><select><option>{{ t('settingsUi.days90') }}</option></select><span /></div>
        <div class="settings-meter"><i style="width: 28%; background: var(--accent)" /><i style="width: 18%; background: #7c6cf0" /><i style="width: 12%; background: #8b9298" /></div>
        <p class="settings-note">{{ t('settingsUi.storageSplit') }}</p>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.traces') }}</h2>
        <pre class="settings-log">20:19:02 Claude → @Codex
20:19:40 Codex
20:21:13 Pi → Captain</pre>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.feedback') }}</h2>
        <button class="primary-button" type="button">{{ t('settingsUi.packDiagnostics') }}</button>
      </article>
      <article class="settings-card settings-danger">
        <h2>{{ t('settingsUi.danger') }}</h2>
        <div class="settings-field"><strong>{{ t('settingsUi.clearCache') }}</strong><span>420 MB</span><button class="secondary-button" type="button">{{ t('settingsUi.clear') }}</button></div>
        <div class="settings-field"><strong>{{ t('settingsUi.deleteSessions') }}</strong><small>{{ t('settingsUi.irreversible') }}</small><button class="secondary-button" type="button">{{ t('settingsUi.delete') }}</button></div>
      </article>
    </template>

    <template v-else-if="section === 'about'">
      <div class="settings-about">
        <img :src="mark" alt="" />
        <h1>Tyche</h1>
        <p>{{ t('settingsUi.product') }}</p>
        <p>{{ t('settingsUi.versionLine') }}</p>
        <div class="settings-actions">
          <button class="secondary-button" type="button">{{ t('settingsUi.checkUpdate') }}</button>
          <button class="secondary-button" type="button">{{ t('settingsUi.changelog') }}</button>
        </div>
      </div>
      <article class="settings-card">
        <h2>{{ t('settingsUi.changelog') }}</h2>
        <div class="settings-field"><strong>0.8.3</strong><span>{{ t('settingsUi.releaseSkills') }}</span><span class="settings-badge">{{ t('settingsUi.newFeature') }}</span></div>
        <div class="settings-field"><strong>0.8.2</strong><span>{{ t('settingsUi.releaseWorktree') }}</span><span /></div>
        <div class="settings-field"><strong>0.8.0</strong><span>{{ t('settingsUi.releaseTemplates') }}</span><span /></div>
      </article>
      <div class="settings-link-row">
        <button type="button">{{ t('settingsUi.feedbackLink') }}</button>
        <button type="button">{{ t('settingsUi.docs') }}</button>
        <button type="button">{{ t('settingsUi.community') }}</button>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, reactive, ref, unref } from 'vue'
import { publicAsset } from '../catalog.js'
import { locale as currentLocale, setLocale, t } from '../i18n.js'

const props = defineProps({
  section: { type: String, required: true },
  setThemePreference: { type: Function, required: true },
  themePreference: { type: [String, Object], required: true },
})

const titles = {
  skills: ['systemSettings.skills', 'settingsUi.skillsHint'],
  orchestration: ['systemSettings.orchestration', 'settingsUi.orchestrationHint'],
  permissions: ['systemSettings.permissions', 'settingsUi.permissionsHint'],
  general: ['systemSettings.general', 'settingsUi.generalHint'],
  workspace: ['systemSettings.workspace', 'settingsUi.workspaceHint'],
  integrations: ['systemSettings.integrations', 'settingsUi.integrationsHint'],
  usage: ['systemSettings.usage', 'settingsUi.usageHint'],
  preferences: ['systemSettings.preferences', 'settingsUi.preferencesHint'],
  diagnostics: ['systemSettings.diagnostics', 'settingsUi.diagnosticsHint'],
  about: ['systemSettings.about', 'settingsUi.aboutHint'],
}
const titleKey = computed(() => titles[props.section]?.[0] || 'systemSettings.title')
const hintKey = computed(() => titles[props.section]?.[1] || 'settingsUi.aboutHint')
const theme = computed(() => unref(props.themePreference))
const locale = currentLocale
const themes = ['system', 'light', 'dark']
const mark = publicAsset('logos/tyche-mark-v3.svg')
const wake = ref(1)
const steps = ref(8)
const confirmHandoff = ref(false)
const mentionUser = ref(false)
const contextMode = ref('summary')
const failure = ref('captain')
const allowNetwork = ref(false)
const zoom = ref(100)
const launchAtLogin = ref(false)
const range = ref('month')
const preset = ref('practical')
const concurrency = ref('worktree')
const merge = ref('captain')
const skillFilter = ref('all')
const selectedSkill = ref('frontend-design')
const contextModes = ['full', 'summary', 'last']
const failureModes = ['retry', 'captain', 'notify']
const permissionModes = ['read', 'ask', 'auto']
const ranges = ['today', 'week', 'month']
const skillFilters = ['all', 'shared', 'native', 'market']
const presets = ['quick', 'careful', 'explore', 'practical']
const dials = ['detail', 'initiative', 'evidence']
const permissionAgents = reactive([
  { id: 'codex', name: 'Codex', mode: 'ask' },
  { id: 'claude', name: 'Claude Code', mode: 'ask' },
  { id: 'pi', name: 'Pi Agent', mode: 'auto' },
  { id: 'gemini', name: 'Gemini CLI', mode: 'read' },
])
const autoCount = computed(() => permissionAgents.filter(agent => agent.mode === 'auto').length)
const skills = reactive([
  { name: 'frontend-design', source: 'settingsUi.sharedLibrary', codex: true, claude: true, pi: true, gemini: false, trust: 'trusted', when: '2d' },
  { name: 'code-review', source: 'settingsUi.sharedLibrary', codex: true, claude: false, pi: false, gemini: false, trust: 'trusted', when: '5d' },
  { name: 'git-commit-style', source: 'settingsUi.nativeCodex', codex: false, claude: true, pi: false, gemini: false, trust: 'changed', when: '1h' },
])
const notices = [
  { id: 'done', channels: ['desktop', 'badge'] },
  { id: 'approval', channels: ['desktop', 'sound', 'badge'] },
  { id: 'error', channels: ['desktop', 'sound', 'badge'] },
]
const noticeState = reactive({
  'done-desktop': true, 'done-badge': true,
  'approval-desktop': true, 'approval-sound': true, 'approval-badge': true,
  'error-desktop': true, 'error-sound': true, 'error-badge': true,
})
const shortcuts = [
  { id: 'summon', keys: '⌥ Space' },
  { id: 'newChat', keys: '⌘ N' },
  { id: 'mention', keys: '⌘ K' },
  { id: 'send', keys: '⏎' },
]
const rooms = [
  { name: 'test-room', path: '~/Projects/test-room · main', bound: true },
  { name: 'snake', path: '~/Projects/snake · main', bound: true },
  { name: 'room3', path: '—', bound: false },
]
const concurrencyModes = ['worktree', 'lock', 'none']
</script>

<style scoped>
.settings-page textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; font-size: 13px; padding: 8px 10px; }
.settings-page input[type="search"], .settings-page input[type="text"] { height: 32px; }
.settings-mini-table tr { cursor: pointer; }
</style>
