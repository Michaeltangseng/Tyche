const SETTINGS_SECTIONS = new Set([
  'agents', 'orchestration', 'permissions', 'general', 'workspace',
  'integrations', 'usage', 'preferences', 'diagnostics', 'about',
])

function normalizedSection(section) {
  if (section === 'knowledge-bases' || section === 'cloud-agents' || section === 'skills' || section === 'collaboration') return 'agents'
  if (SETTINGS_SECTIONS.has(section)) return section
  return 'agents'
}

export function useSystemSettingsNavigation({
  activeView,
  closeModal,
  focusedAgentKind,
  formError,
  installConfirmKind,
  loadKnowledgeBaseStatuses,
  modal,
  saving,
  systemSettingsSection,
}) {
  function openAgentManager(kind = '') {
    openSystemSettings('agents', kind)
  }

  function openSystemSettings(section = 'agents', kind = '') {
    if (saving.value) return
    if (modal.value) closeModal()
    activeView.value = 'settings'
    systemSettingsSection.value = normalizedSection(section)
    focusedAgentKind.value = systemSettingsSection.value === 'agents' ? kind : ''
    installConfirmKind.value = ''
    formError.value = ''
  }

  function selectSystemSettingsSection(section) {
    if (section === systemSettingsSection.value) return
    systemSettingsSection.value = normalizedSection(section)
    formError.value = ''
  }

  return {
    openAgentManager,
    openSystemSettings,
    selectSystemSettingsSection,
  }
}
