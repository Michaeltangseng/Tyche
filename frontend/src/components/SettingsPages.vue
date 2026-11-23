<template>
  <section class="settings-page mock" :aria-label="t(titleKey)">
    <header v-if="section !== 'mcp' && section !== 'skills'" class="settings-page-title">
      <div>
        <h1>
          {{ t(titleKey) }}
          <span v-if="section === 'orchestration'" class="settings-badge">{{ t('settingsUi.globalDefault') }}</span>
        </h1>
        <p>{{ t(hintKey) }}</p>
      </div>
      <div v-if="section === 'usage'" class="settings-seg">
        <button v-for="item in ranges" :key="item" type="button" :class="{ active: range === item }" @click="range = item">{{ t(`settingsUi.range.${item}`) }}</button>
      </div>
    </header>

    <template v-if="section === 'mcp'">
      <article class="settings-card">
        <h2>{{ t('settingsUi.knowledgeTitle') }}</h2>
        <div class="settings-choice-grid">
          <div class="settings-choice"><strong>{{ t('settingsUi.feishuDocs') }}</strong><small>{{ t('settingsUi.cliMissing') }}</small><button class="secondary-button" type="button">{{ t('settingsUi.installCli') }}</button></div>
          <div class="settings-choice"><strong>{{ t('settingsUi.dingDocs') }}</strong><small>{{ t('settingsUi.cliMissing') }}</small><button class="secondary-button" type="button">{{ t('settingsUi.installCli') }}</button></div>
          <div class="settings-choice"><strong>Obsidian</strong><small class="ok">{{ t('settingsUi.connected') }} · ~/Notes/Vault</small><small>{{ t('settingsUi.obsidianUse') }}</small></div>
        </div>
      </article>
      <article class="settings-card">
        <div class="settings-card-head">
          <h2>MCP Server</h2>
          <span class="settings-actions">
            <button class="primary-button" type="button">+ {{ t('settingsUi.addMcpServer') }}</button>
            <button class="secondary-button" type="button">{{ t('settingsUi.fromJson') }}</button>
          </span>
        </div>
        <table class="settings-mini-table">
          <thead><tr><th>{{ t('settingsUi.name') }}</th><th>{{ t('settingsUi.transport') }}</th><th>{{ t('systemSettings.columnStatus') }}</th><th>{{ t('settingsUi.availableAgents') }}</th><th /></tr></thead>
          <tbody>
            <tr v-for="row in mcpRows" :key="row.name">
              <td><strong>{{ row.name }}</strong></td>
              <td>{{ row.transport }}</td>
              <td><i class="settings-dot" :class="row.tone" />{{ t(row.status) }}</td>
              <td>{{ row.agents }}</td>
              <td class="settings-actions">
                <button v-if="row.log" class="agent-config-link" type="button">{{ t('settingsUi.viewLog') }}</button>
                <button class="settings-switch" :class="{ on: row.on }" type="button" @click="row.on = !row.on"><i /></button>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="settings-note">{{ t('settingsUi.mcpSync') }}</p>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.otherConnections') }}</h2>
        <div class="mock-line"><strong>{{ t('settingsUi.githubAccount') }}</strong><span><i class="settings-dot ready" />{{ t('settingsUi.connected') }} · @tyche-dev</span></div>
        <div class="mock-line"><strong>{{ t('settingsUi.webhook') }}</strong><span><i class="settings-dot" />{{ t('settingsUi.notConfigured') }}</span></div>
      </article>
    </template>

    <SkillsPage v-else-if="section === 'skills'" :api="skillApi" :installed-agents="installedAgentKinds" />

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
        <div class="settings-card-head"><div><h2>{{ t('settingsUi.skillTrust') }}</h2><p>{{ t('settingsUi.trustLead') }}</p></div><button class="agent-config-link" type="button">{{ t('settingsUi.revoke') }}</button></div>
        <div class="mock-line"><strong>frontend-design · Claude Code · {{ t('settingsUi.trustState.trusted') }} · {{ t('settingsUi.trustRow') }}</strong></div>
        <p class="settings-note">{{ t('settingsUi.noOtherTrust') }}</p>
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

    <template v-else-if="section === 'usage'">
      <div class="stat-grid">
        <article class="settings-card stat-card">
          <header><span>{{ t('settingsUi.monthFee') }}</span></header>
          <h2>$42.80</h2>
          <small>{{ t('settingsUi.budgetLine') }}</small>
          <div class="fee-meter"><i /></div>
        </article>
        <article class="settings-card stat-card"><header><span>{{ t('settingsUi.totalTokens') }}</span></header><h2>8.6M</h2></article>
        <article class="settings-card stat-card"><header><span>{{ t('settingsUi.handoffCount') }}</span></header><h2>214</h2></article>
        <article class="settings-card stat-card"><header><span>{{ t('settingsUi.stoppedLoopsTitle') }}</span></header><h2>3</h2></article>
      </div>
      <div class="usage-split">
        <article class="settings-card">
          <div class="usage-card-head">
            <h2>{{ t('settingsUi.dailyTrend') }}</h2>
            <p class="legend"><i class="swatch codex" />Codex <i class="swatch claude" />Claude <i class="swatch pi" />Pi <i class="swatch gemini" />Gemini</p>
          </div>
          <div class="usage-chart">
            <div class="usage-yaxis"><span>$30</span><span>$20</span><span>$10</span><span>$0</span></div>
            <div class="usage-plot">
              <div class="usage-bars">
                <span v-for="(bar, index) in bars" :key="index" :style="{ height: `${bar}px` }">
                  <i class="gemini" /><i class="pi" /><i class="claude" /><i class="codex" />
                </span>
              </div>
              <div class="usage-xaxis"><span>4/1</span><span>4/7</span><span>4/14</span><span>4/21</span><span>4/30</span></div>
            </div>
          </div>
        </article>
        <article class="settings-card">
          <h2>{{ t('settingsUi.byRoom') }}</h2>
          <div v-for="room in roomCosts" :key="room.name" class="room-row">
            <span>{{ room.name }}</span>
            <i><b :style="{ width: room.width }" /></i>
            <strong>{{ room.cost }}</strong>
          </div>
        </article>
      </div>
      <article class="settings-card">
        <h2>{{ t('settingsUi.byAgent') }}</h2>
        <table class="settings-mini-table usage-agents">
          <thead><tr><th>Agent</th><th>Token</th><th>{{ t('settingsUi.fee') }}</th><th>{{ t('settingsUi.share') }}</th></tr></thead>
          <tbody>
            <tr v-for="agent in usageAgents" :key="agent.name">
              <td><img :src="agent.logo" alt="" /><span>{{ agent.name }}</span></td>
              <td>{{ agent.tokens }}</td>
              <td>{{ agent.cost }}</td>
              <td class="share"><span class="share-track"><i :class="agent.tone" :style="{ width: agent.share }" /></span><span>{{ agent.share }}</span></td>
            </tr>
          </tbody>
        </table>
      </article>
      <article class="settings-card">
        <h2>{{ t('settingsUi.budget') }}</h2>
        <div class="budget-row">
          <label>{{ t('settingsUi.monthlyBudget') }}<input value="$60" readonly /></label>
          <label>{{ t('settingsUi.at80') }}<select><option>{{ t('settingsUi.remindMe') }}</option></select></label>
          <label>{{ t('settingsUi.afterBudget') }}
            <span class="usage-choice"><button type="button">{{ t('settingsUi.warnOnly') }}</button><button class="pause" type="button">{{ t('settingsUi.pauseAll') }}</button></span>
          </label>
          <label>{{ t('settingsUi.roomDaily') }}<input value="$10" readonly /></label>
          <label>{{ t('settingsUi.chainCap') }}<input value="200K" readonly /><small>{{ t('settingsUi.chainHint') }}</small></label>
        </div>
      </article>
    </template>

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
        <h2>{{ t('settingsUi.collaborators') }}</h2>
        <div class="settings-actions">
          <button v-for="name in collaborators" :key="name" class="chip" :class="{ active: picked.has(name) }" type="button" @click="toggleCollaborator(name)">{{ name }}</button>
          <span class="settings-note">{{ t('settingsUi.defaultOnNewRoom') }}</span>
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
import { computed, reactive, ref, unref } from 'vue'
import { publicAsset } from '../catalog.js'
import { locale as currentLocale, setLocale, t } from '../i18n.js'
import SkillsPage from './skills/SkillsPage.vue'

const props = defineProps({
  section: { type: String, required: true },
  setThemePreference: { type: Function, required: true },
  themePreference: { type: [String, Object], required: true },
  skillApi: { type: Object, default: null },
  installedAgentKinds: { type: Array, default: () => [] },
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
const range = ref('month')
const preset = ref('quick')
const contextModes = [
  { id: 'full', title: 'settingsUi.contextMode.full', meta: '~8K tokens', hint: 'settingsUi.contextHint.full' },
  { id: 'summary', title: 'settingsUi.contextMode.summary', meta: '~1K tokens', hint: 'settingsUi.contextHint.summary' },
  { id: 'last', title: 'settingsUi.contextMode.last', meta: '~200 tokens', hint: 'settingsUi.contextHint.last' },
]
const failureModes = ['retry', 'captain', 'notify']
const permissionModes = ['read', 'ask', 'auto']
const ranges = ['today', 'week', 'month']
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
const mcpRows = reactive([
  { name: 'filesystem', transport: 'stdio', status: 'settingsUi.running', tone: 'ready', agents: 'Codex · Pi', on: true },
  { name: 'github', transport: 'stdio', status: 'settingsUi.running', tone: 'ready', agents: 'Claude', on: true },
  { name: 'browser', transport: 'http', status: 'settingsUi.disabled', tone: '', agents: '—', on: false },
  { name: 'postgres', transport: 'stdio', status: 'settingsUi.failed', tone: 'danger', agents: '—', on: true, log: true },
])
const bars = [62, 70, 48, 58, 84, 76, 54, 66, 92, 80, 72, 98, 108, 86, 94, 116, 124, 110, 132, 120, 138, 112, 100, 126, 118, 96, 108, 88, 78, 104]
const roomCosts = [
  { name: 'snake', width: '86%', cost: '$18.20' },
  { name: 'test-room', width: '72%', cost: '$15.40' },
  { name: 'room3', width: '44%', cost: '$9.20' },
]
const usageAgents = [
  { name: 'Claude Code', logo: publicAsset('agent-logos/claude.png'), tokens: '3.9M', cost: '$21.30', share: '50%', tone: 'claude' },
  { name: 'Codex', logo: publicAsset('agent-logos/codex.svg'), tokens: '2.8M', cost: '$12.10', share: '28%', tone: 'codex' },
  { name: 'Pi', logo: publicAsset('agent-logos/pi.svg'), tokens: '1.4M', cost: '$6.20', share: '14%', tone: 'pi' },
  { name: 'Gemini', logo: publicAsset('agent-logos/gemini.svg'), tokens: '0.5M', cost: '$3.20', share: '8%', tone: 'gemini' },
]
const collaborators = ['Codex', 'Claude Code', 'Pi Agent', 'Gemini CLI']
const picked = reactive(new Set(['Codex', 'Claude Code']))
function toggleCollaborator(name) {
  if (picked.has(name)) picked.delete(name)
  else picked.add(name)
}
</script>

<style scoped>
.mock-line { display: flex; align-items: center; gap: 12px; min-height: 44px; }
.mock-line strong { min-width: 140px; font-size: 13px; }
.mock-line small, .settings-choice small { color: var(--muted); font-size: 12px; }
.mock-line.column { align-items: stretch; flex-direction: column; }
.mock-line img { width: 22px; height: 22px; }
.mock-line .narrow { width: 64px; }
.ends { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; }
.chip { height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: 99px; background: transparent; color: var(--text-soft); font: inherit; font-size: 12px; cursor: pointer; }
.chip.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-text); }
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
