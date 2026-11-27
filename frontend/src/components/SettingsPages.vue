<template>
  <section class="settings-page mock" :class="{ 'pref-page': section === 'preferences', 'user-page': section === 'user' }" :aria-label="t(titleKey)">
    <header v-if="section !== 'skills' && section !== 'usage'" class="settings-page-title">
      <div>
        <h1>{{ t(titleKey) }}</h1>
        <p>{{ t(hintKey) }}</p>
      </div>
    </header>

    <SkillsPage v-if="section === 'skills'" :api="skillApi" />

    <template v-else-if="section === 'general'">
      <article class="settings-card">
        <h2>{{ t('settingsUi.languageAppearance') }}</h2>
        <div class="mock-line"><div><strong>{{ t('generalSettings.languageTitle') }}</strong><small>{{ t('settingsUi.languageLead') }}</small></div><div class="settings-seg"><button type="button" :class="{ active: locale === 'zh' }" @click="setLocale('zh')">中文</button><button type="button" :class="{ active: locale === 'en' }" @click="setLocale('en')">English</button></div></div>
        <div class="mock-line"><div><strong>{{ t('generalSettings.themeTitle') }}</strong><small>{{ t('settingsUi.themeLead') }}</small></div><div class="settings-seg"><button v-for="item in themes" :key="item" type="button" :class="{ active: theme === item }" @click="setThemePreference(item)">{{ t(`generalSettings.theme${item[0].toUpperCase()}${item.slice(1)}`) }}</button></div></div>
      </article>
    </template>

    <UsageSettingsPanel v-else-if="section === 'usage'" />

    <template v-else-if="section === 'preferences'">
      <div class="pref-layout">
        <div class="pref-column">
          <h2 class="pref-label">{{ t('settingsUi.displayGroup') }}</h2>
          <article class="settings-card">
            <div class="setting-row">
              <div>
                <strong>{{ t('settingsUi.titleMarquee') }}</strong>
                <small>{{ t('settingsUi.titleMarqueeHint') }}</small>
              </div>
              <button
                class="settings-switch"
            :class="{ on: draftMarquee }"
            type="button"
            role="switch"
            :aria-checked="draftMarquee ? 'true' : 'false'"
            :aria-label="t('settingsUi.titleMarquee')"
            @click="draftMarquee = !draftMarquee"
              ><i /></button>
            </div>
            <div class="setting-row">
              <div>
                <strong>{{ t('settingsUi.openWorkbench') }}</strong>
                <small>{{ t('settingsUi.openWorkbenchHint') }}</small>
              </div>
              <button
                class="settings-switch"
            :class="{ on: draftOpenWorkbench }"
            type="button"
            role="switch"
            :aria-checked="draftOpenWorkbench ? 'true' : 'false'"
            :aria-label="t('settingsUi.openWorkbench')"
            @click="draftOpenWorkbench = !draftOpenWorkbench"
              ><i /></button>
            </div>
          </article>
          <h2 class="pref-label">
            {{ t('settingsUi.chatStart') }}
            <button class="pref-info" type="button" :title="t('settingsUi.captainHint')" :aria-label="t('settingsUi.captainHint')">i</button>
          </h2>
          <article class="settings-card">
            <div class="setting-row setting-row-head">
              <small>{{ t('settingsUi.chatStartHint') }}</small>
              <div class="settings-seg chat-start-mode" role="radiogroup" :aria-label="t('settingsUi.chatStart')">
                <button type="button" role="radio" :aria-checked="chatStartMode === 'single'" :class="{ active: chatStartMode === 'single' }" @click="setChatStartMode('single')">{{ t('settingsUi.chatStartSingle') }}</button>
                <button type="button" role="radio" :aria-checked="chatStartMode === 'multi'" :class="{ active: chatStartMode === 'multi' }" @click="setChatStartMode('multi')">{{ t('settingsUi.chatStartMulti') }}</button>
              </div>
            </div>
            <div class="pref-members" :role="chatStartMode === 'multi' ? 'group' : 'radiogroup'" :aria-label="t('settingsUi.chatStart')">
              <div
                v-for="agent in captainChoices"
                :key="agent.kind"
                class="pref-member"
                :data-selected="agent.ready && memberSelected(agent.kind) ? 'true' : undefined"
                :data-unavailable="agent.ready ? undefined : 'true'"
              >
                <span class="pref-mark" :data-mode="chatStartMode" aria-hidden="true" />
                <button
                  class="pref-member-logo"
                  type="button"
                  :aria-label="t('systemSettings.openAgentDetail', { agent: agent.label })"
                  @click="openAgentDetail?.({ kind: agent.kind, label: agent.label })"
                >
                  <img :src="agent.logo" alt="" />
                </button>
                <button class="pref-member-name" type="button" :role="chatStartMode === 'multi' ? 'checkbox' : 'radio'" :aria-checked="agent.ready && memberSelected(agent.kind) ? 'true' : 'false'" :disabled="!agent.ready" @click="toggleStartMember(agent.kind)">
                  {{ agent.label }}
                </button>
                <button
                  v-if="!agent.ready"
                  class="pref-member-captain"
                  type="button"
                  @click="openAgentDetail?.({ kind: agent.kind, label: agent.label })"
                >
                  {{ agent.status || t('settingsUi.needsSetup') }} · {{ t('home.configureAgent') }}
                </button>
                <button
                  v-else-if="chatStartMode === 'multi' && memberSelected(agent.kind) && captainKind !== agent.kind"
                  class="pref-member-captain"
                  type="button"
                  @click="makeStartCaptain(agent.kind)"
                >
                  {{ t('settingsUi.makeCaptain') }}
                </button>
                <span v-else-if="captainKind === agent.kind && memberSelected(agent.kind)" class="pref-member-badge">{{ t('settingsUi.defaultCaptain') }}</span>
              </div>
              <span v-if="!captainChoices.length" class="settings-note">{{ t('room.noProviders') }}</span>
            </div>
            <div class="setting-row">
              <div>
                <strong>{{ t('settingsUi.waitForInstruction') }}</strong>
                <small>{{ t('settingsUi.waitForInstructionHint') }}</small>
              </div>
              <button
                class="settings-switch"
            :class="{ on: draftWait }"
            type="button"
            role="switch"
            :aria-checked="draftWait ? 'true' : 'false'"
            :aria-label="t('settingsUi.waitForInstruction')"
            @click="draftWait = !draftWait"
              ><i /></button>
            </div>
          </article>
        </div>
        <div class="pref-actions">
          <button class="secondary-button" type="button" :disabled="!preferencesDirty || savingPreferences" @click="cancelPreferences">{{ t('common.cancel') }}</button>
          <button class="primary-button" type="button" :disabled="!preferencesDirty || savingPreferences" @click="savePreferences">{{ t('common.save') }}</button>
        </div>
      </div>
    </template>

    <template v-else-if="section === 'user'">
      <article class="user-card">
        <div class="pref-hero">
          <span class="pref-hero-face">
            <img v-if="selectedPortrait" :src="selectedPortrait.src" alt="" />
            <b v-else>{{ t('room.you') }}</b>
          </span>
          <strong>{{ t('room.you') }}</strong>
          <small>{{ t('settingsUi.userPortraitHint') }}</small>
        </div>
        <div class="pref-portraits" role="radiogroup" :aria-label="t('settingsUi.userPortrait')">
          <button
            v-for="mascot in userPortraits"
            :key="mascot.id"
            type="button"
            role="radio"
            :aria-checked="draftPortrait === mascot.id ? 'true' : 'false'"
            :aria-label="mascot.name"
            :class="{ active: draftPortrait === mascot.id }"
            @click="setUserPortrait(mascot.id)"
          >
            <img :src="mascot.src" alt="" />
          </button>
        </div>
        <button class="agent-config-link pref-restore" type="button" :disabled="!draftPortrait" @click="setUserPortrait('')">{{ t('settingsUi.restoreDefault') }}</button>
        <div class="pref-preview" :aria-label="t('settingsUi.preview')">
          <span class="pref-preview-label">{{ t('settingsUi.preview') }}</span>
          <div class="pref-bubble user">
            <p>{{ t('settingsUi.previewUser') }}</p>
            <span class="pref-hero-face mini">
              <img v-if="selectedPortrait" :src="selectedPortrait.src" alt="" />
              <b v-else>{{ t('room.you') }}</b>
            </span>
          </div>
        </div>
        <div class="pref-actions">
          <button class="secondary-button" type="button" :disabled="!userDirty || savingUser" @click="cancelUser">{{ t('common.cancel') }}</button>
          <button class="primary-button" type="button" :disabled="!userDirty || savingUser" @click="saveUser">{{ t('common.save') }}</button>
        </div>
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
import { computed, onMounted, ref, unref, watch } from 'vue'
import { agentLabel, agentLogo, publicAsset } from '../catalog.js'
import { desktopApi } from '../desktop.js'
import { locale as currentLocale, setLocale, t } from '../i18n.js'
import { ROOM_MASCOTS } from '../room-mascots.js'
import { applyRoomRunPreferences } from '../room-run-preferences.js'
import { readTitleMarqueeEnabled, setTitleMarqueeEnabled } from '../title-marquee.js'
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
  general: ['systemSettings.general', 'settingsUi.generalHint'],
  usage: ['systemSettings.usage', 'settingsUi.usageLead'],
  user: ['systemSettings.user', 'settingsUi.userLead'],
  preferences: ['systemSettings.preferences', 'settingsUi.prefsLead'],
  about: ['systemSettings.about', 'settingsUi.aboutHint'],
  mcp: ['systemSettings.integrations', 'settingsUi.integrationsHint'],
}
const titleKey = computed(() => titles[props.section]?.[0] || 'systemSettings.title')
const hintKey = computed(() => titles[props.section]?.[1] || 'settingsUi.aboutHint')
const theme = computed(() => unref(props.themePreference))
const locale = currentLocale
const themes = ['system', 'light', 'dark']
const mark = publicAsset('logos/tyche-mark-v3.svg')
const captainKind = ref('')
const chatStartMode = ref('single')
const memberKinds = ref([])
const draftPortrait = ref('')
const committedPortrait = ref('')
const savingUser = ref(false)
const draftOpenWorkbench = ref(true)
const draftWait = ref(true)
const draftMarquee = ref(readTitleMarqueeEnabled())
const savingPreferences = ref(false)
const committedPreferences = ref(null)
const captainChoices = computed(() => (props.installedAgentKinds || []).map(item => {
  const kind = typeof item === 'string' ? item : item?.kind
  return {
    kind,
    label: (typeof item === 'object' && item?.label) || agentLabel(kind),
    logo: (typeof item === 'object' && item?.logo) || agentLogo(kind),
    ready: typeof item === 'object' ? item?.ready !== false : true,
    status: typeof item === 'object' ? item?.status || '' : '',
  }
}).filter(agent => agent.kind))
const readyChoices = computed(() => captainChoices.value.filter(agent => agent.ready))

function preferenceSnapshot() {
  return {
    workbench: draftOpenWorkbench.value,
    wait: draftWait.value,
    marquee: draftMarquee.value,
    mode: chatStartMode.value,
    captain: captainKind.value,
    members: [...memberKinds.value],
  }
}

const preferencesDirty = computed(() => JSON.stringify(preferenceSnapshot()) !== JSON.stringify(committedPreferences.value))

function applyPreferenceDraft(snapshot) {
  draftOpenWorkbench.value = snapshot.workbench
  draftWait.value = snapshot.wait
  draftMarquee.value = snapshot.marquee
  chatStartMode.value = snapshot.mode
  captainKind.value = snapshot.captain
  memberKinds.value = [...snapshot.members]
}

async function loadCaptainPreference() {
  const bridge = desktopApi()?.workPreferences
  if (!bridge?.get) return
  try {
    const value = await bridge.get()
    const choices = readyChoices.value
    const known = kind => choices.some(agent => agent.kind === kind)
    const savedCaptain = known(value?.defaultCaptainKind) ? value.defaultCaptainKind : (choices[0]?.kind || '')
    const savedMembers = (Array.isArray(value?.defaultMemberKinds) ? value.defaultMemberKinds : []).filter(known)
    const mode = value?.chatStartMode === 'multi' ? 'multi' : 'single'
    const members = mode === 'single'
      ? (savedCaptain ? [savedCaptain] : [])
      : (savedMembers.includes(savedCaptain) || !savedCaptain ? savedMembers : [savedCaptain, ...savedMembers])
    applyRoomRunPreferences(value)
    applyPreferenceDraft({
      workbench: value?.openWorkbenchOnStart !== false,
      wait: value?.rosterWaitsForInstruction !== false,
      marquee: readTitleMarqueeEnabled(),
      mode,
      captain: savedCaptain,
      members: mode === 'multi' && savedCaptain && !members.includes(savedCaptain) ? [savedCaptain, ...members] : members,
    })
    committedPreferences.value = preferenceSnapshot()
  } catch { /* keep the current selection */ }
}

const userPortraits = ROOM_MASCOTS
const selectedPortrait = computed(() => userPortraits.find(mascot => mascot.id === draftPortrait.value) || null)
const userDirty = computed(() => draftPortrait.value !== committedPortrait.value)

function portraitId(value) {
  return /^(0[1-9]|1[0-2])$/.test(String(value || '')) ? value : ''
}

async function loadUserPortrait() {
  const bridge = desktopApi()?.workPreferences
  if (!bridge?.get) return
  try {
    const value = await bridge.get()
    const portrait = portraitId(value?.userPortrait)
    draftPortrait.value = portrait
    committedPortrait.value = portrait
    applyRoomRunPreferences(value)
  } catch { /* keep the current portrait */ }
}

function setUserPortrait(id) {
  draftPortrait.value = id
}

function memberSelected(kind) {
  return chatStartMode.value === 'single' ? captainKind.value === kind : memberKinds.value.includes(kind)
}

function assignStartTeam({ mode, captain, members }) {
  chatStartMode.value = mode
  captainKind.value = captain
  memberKinds.value = members
}

function setChatStartMode(mode) {
  const captain = captainKind.value || readyChoices.value[0]?.kind || ''
  if (!captain) return
  if (mode === 'single') {
    assignStartTeam({ mode, captain, members: [captain] })
    return
  }
  const members = memberKinds.value.includes(captain) ? [...memberKinds.value] : [captain, ...memberKinds.value]
  assignStartTeam({ mode, captain, members })
}

function toggleStartMember(kind) {
  if (!readyChoices.value.some(agent => agent.kind === kind)) return
  const captain = captainKind.value || kind
  if (chatStartMode.value !== 'multi') {
    assignStartTeam({ mode: 'single', captain: kind, members: [kind] })
    return
  }
  if (memberKinds.value.includes(kind)) {
    if (memberKinds.value.length === 1) return
    const members = memberKinds.value.filter(item => item !== kind)
    assignStartTeam({ mode: 'multi', captain: members.includes(captain) ? captain : members[0], members })
    return
  }
  if (memberKinds.value.length >= 8) return
  assignStartTeam({ mode: 'multi', captain, members: [...memberKinds.value, kind] })
}

function makeStartCaptain(kind) {
  const members = memberKinds.value.includes(kind) ? [...memberKinds.value] : [...memberKinds.value, kind]
  assignStartTeam({ mode: 'multi', captain: kind, members })
}

function cancelPreferences() {
  if (!committedPreferences.value) return
  applyPreferenceDraft(committedPreferences.value)
}

async function savePreferences() {
  const bridge = desktopApi()?.workPreferences
  if (!bridge?.get || !bridge?.save || savingPreferences.value || !preferencesDirty.value) return
  savingPreferences.value = true
  const snapshot = preferenceSnapshot()
  try {
    const current = await bridge.get()
    await bridge.save({
      ...current,
      openWorkbenchOnStart: snapshot.workbench,
      rosterWaitsForInstruction: snapshot.wait,
      chatStartMode: snapshot.mode,
      defaultCaptainKind: snapshot.captain,
      defaultMemberKinds: snapshot.members,
    })
    setTitleMarqueeEnabled(snapshot.marquee)
    applyRoomRunPreferences({
      openWorkbenchOnStart: snapshot.workbench,
      rosterWaitsForInstruction: snapshot.wait,
    })
    committedPreferences.value = preferenceSnapshot()
  } catch { /* leave the draft in place so the user can retry */ }
  finally { savingPreferences.value = false }
}

function cancelUser() {
  draftPortrait.value = committedPortrait.value
}

async function saveUser() {
  const bridge = desktopApi()?.workPreferences
  if (!bridge?.get || !bridge?.save || savingUser.value || !userDirty.value) return
  savingUser.value = true
  const portrait = draftPortrait.value
  try {
    const current = await bridge.get()
    await bridge.save({ ...current, userPortrait: portrait })
    applyRoomRunPreferences({ userPortrait: portrait })
    committedPortrait.value = portrait
  } catch { /* leave the draft in place so the user can retry */ }
  finally { savingUser.value = false }
}

onMounted(() => {
  if (props.section === 'preferences') void loadCaptainPreference()
  if (props.section === 'user') void loadUserPortrait()
})
watch(() => props.section, (section) => {
  if (section === 'preferences') void loadCaptainPreference()
  if (section === 'user') void loadUserPortrait()
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
.pref-page { max-width: 680px; gap: 20px; }
.user-page { max-width: 560px; }
.pref-layout { display: grid; }
.pref-actions { display: flex; justify-content: flex-end; gap: 8px; }
.user-card { display: grid; justify-items: center; gap: 18px; padding: 28px 24px 20px; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--surface) 55%, var(--bg)); }
.user-card .pref-actions { width: 100%; }
.pref-column { display: grid; align-content: start; gap: 0; }
.pref-label { display: flex; align-items: center; margin: 18px 2px 8px; font-size: 14px; font-weight: 650; }
.pref-column > .pref-label:first-child { margin-top: 0; }
.pref-page .settings-card { display: grid; gap: 0; margin-bottom: 4px; padding: 4px 20px 12px; }
.setting-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 16px; min-height: 64px; padding: 16px 0; border-top: 1px solid var(--border); }
.setting-row:first-of-type { border-top: 0; }
.setting-row-head { min-height: 0; padding-top: 12px; border-top: 0; }
.setting-row strong { display: block; font-size: 14px; font-weight: 640; }
.setting-row small, .setting-row-head small { display: block; max-width: 42ch; margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.45; }
.setting-row-head small { margin-top: 0; }
.pref-hero { display: grid; justify-items: center; gap: 6px; text-align: center; }
.pref-hero > strong { font-size: 15px; }
.pref-hero > small { max-width: 22ch; color: var(--muted); font-size: 12px; line-height: 1.45; }
.pref-hero-face { width: 112px; height: 112px; display: grid; place-items: center; overflow: hidden; border-radius: 32px; background: color-mix(in srgb, var(--text) 8%, transparent); }
.pref-hero-face img { width: 92px; height: 92px; }
.pref-hero-face b { color: var(--muted); font-size: 22px; font-weight: 650; }
.pref-hero-face.mini { width: 28px; height: 28px; flex: none; border-radius: 9px; }
.pref-hero-face.mini img { width: 22px; height: 22px; }
.pref-hero-face.mini b { font-size: 11px; }
.pref-restore { justify-self: center; }
.pref-preview { display: grid; gap: 10px; width: 100%; padding-top: 16px; border-top: 1px solid var(--border); }
.pref-preview-label { color: var(--muted); font-size: 11px; font-weight: 650; letter-spacing: 0.04em; }
.pref-bubble { display: flex; align-items: flex-start; gap: 8px; }
.pref-bubble.user { justify-content: flex-end; align-items: flex-end; }
.pref-bubble.user p { margin: 0; padding: 7px 10px; border-radius: 10px; background: color-mix(in srgb, var(--accent) 18%, transparent); }
.pref-info { width: 16px; height: 16px; margin-left: 6px; padding: 0; border: 1px solid var(--border-strong); border-radius: 50%; background: transparent; color: var(--muted); font: inherit; font-size: 11px; line-height: 14px; cursor: help; vertical-align: 1px; }
.pref-members { display: grid; gap: 0; margin-top: 8px; }
.chat-start-mode button[aria-checked="false"] { background: transparent; color: var(--muted); }
.chat-start-mode button[aria-checked="true"] { background: var(--accent); color: var(--accent-contrast, #041416); }
.pref-member { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 4px; border: 0; border-radius: 8px; }
.pref-member[data-selected="true"] { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.pref-member[data-unavailable="true"] { opacity: 0.72; }
.pref-mark { width: 14px; height: 14px; flex: 0 0 14px; box-sizing: border-box; border: 1.5px solid var(--border-strong); border-radius: 50%; }
.pref-mark[data-mode="multi"] { border-radius: 4px; }
.pref-member[data-selected="true"] .pref-mark { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 3px var(--surface); }
.pref-member-logo, .pref-member-name, .pref-member-captain { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.pref-member-logo { width: 32px; height: 32px; display: grid; place-items: center; padding: 0; border-radius: 10px; }
.pref-member-logo img { width: 22px; height: 22px; object-fit: contain; }
.pref-member-logo:hover, .pref-member-logo:focus-visible { outline: none; background: var(--surface-hover); }
.pref-member-name { flex: 1; min-width: 0; padding: 0; text-align: left; font-size: 13px; }
.pref-portraits { display: grid; grid-template-columns: repeat(4, 64px); justify-content: center; gap: 14px; }
.pref-portraits button { position: relative; width: 64px; height: 64px; display: grid; place-items: center; padding: 2px; border: 1px solid var(--border); border-radius: 16px; background: transparent; cursor: pointer; }
.pref-portraits button img { width: 48px; height: 48px; }
.pref-portraits button.active, .pref-portraits button[aria-checked="true"] { border: 2px solid var(--accent); background: var(--accent-soft); }
.pref-portraits button[aria-checked="true"]::after { content: ''; position: absolute; right: -3px; bottom: -3px; width: 8px; height: 8px; border: 2px solid var(--surface); border-radius: 50%; background: var(--accent); }
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
.timeline { margin: 0; padding: 0 0 0 16px; border-left: 2px solid var(--accent); }
.timeline li { margin: 0 0 14px; list-style: none; }
.timeline p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.settings-about-foot { color: var(--muted); font-size: 12px; text-align: center; }
.grow { flex: 1; }
@media (max-width: 980px) {
  .stat-grid, .budget-row, .usage-split, .notice-head { grid-template-columns: 1fr; }
}
</style>
