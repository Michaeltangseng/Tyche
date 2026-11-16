const MODES = Object.freeze({
  claude: Object.freeze([
    { id: 'plan', label: 'Plan', description: 'Read and analyze without editing files.', write: false, exec: false, risk: 'low' },
    { id: 'acceptEdits', label: 'Accept Edits', description: 'Automatically accept file edits.', write: true, exec: true, risk: 'medium' },
    { id: 'bypassPermissions', label: 'Bypass Permissions', description: 'Skip native permission checks. Can affect files outside the project.', write: true, exec: true, risk: 'high' },
  ]),
  codex: Object.freeze([
    { id: 'read-only', label: 'Read Only', description: 'Read files without writing.', write: false, exec: false, risk: 'low' },
    { id: 'workspace-write', label: 'Workspace Write', description: 'Read and write inside the workspace sandbox.', write: true, exec: true, risk: 'medium' },
    { id: 'danger-full-access', label: 'Danger Full Access', description: 'Disable the Codex sandbox. Can affect files outside the project.', write: true, exec: true, risk: 'high' },
  ]),
  gemini: Object.freeze([
    { id: 'default', label: 'Default', description: 'Use the Gemini CLI default approval behavior.', write: false, exec: false, risk: 'low' },
    { id: 'auto_edit', label: 'Auto Edit', description: 'Automatically accept file edits.', write: true, exec: true, risk: 'medium' },
    { id: 'yolo', label: 'YOLO', description: 'Skip approval checks. Can affect files outside the project.', write: true, exec: true, risk: 'high' },
  ]),
  pi: Object.freeze([
    { id: 'no-approve', label: 'No Approve', description: 'Read-only tools without approval.', write: false, exec: false, risk: 'low' },
    { id: 'approve', label: 'Approve', description: 'Allow tool use and file changes.', write: true, exec: true, risk: 'medium' },
  ]),
  workbuddy: Object.freeze([
    { id: 'plan', label: 'Plan', description: 'Read and analyze without editing files.', write: false, exec: false, risk: 'low' },
    { id: 'acceptEdits', label: 'Accept Edits', description: 'Automatically accept file edits.', write: true, exec: true, risk: 'medium' },
  ]),
  qwen: Object.freeze([
    { id: 'plan', label: 'Plan', description: 'Read and analyze without editing files.', write: false, exec: false, risk: 'low' },
    { id: 'auto-edit', label: 'Auto Edit', description: 'Automatically accept file edits.', write: true, exec: true, risk: 'medium' },
  ]),
  hermes: Object.freeze([
    { id: 'default', label: 'Default', description: 'Use the Hermes native approval behavior.', write: false, exec: false, risk: 'low' },
    { id: 'yolo', label: 'YOLO', description: 'Skip approval checks for tool use.', write: true, exec: true, risk: 'medium' },
  ]),
  opencode: Object.freeze([
    { id: 'plan', label: 'Plan', description: 'Read and analyze without editing files.', write: false, exec: false, risk: 'low' },
    { id: 'build', label: 'Build', description: 'Allow the native build agent to edit files.', write: true, exec: true, risk: 'medium' },
  ]),
  mimo: Object.freeze([
    { id: 'plan', label: 'Plan', description: 'Read and analyze without editing files.', write: false, exec: false, risk: 'low' },
    { id: 'build', label: 'Build', description: 'Allow the native build agent to edit files.', write: true, exec: true, risk: 'medium' },
  ]),
  zcode: Object.freeze([
    { id: 'plan', label: 'Plan', description: 'Read and analyze without editing files.', write: false, exec: false, risk: 'low' },
    { id: 'edit', label: 'Edit', description: 'Allow the native edit mode.', write: true, exec: true, risk: 'medium' },
  ]),
  deepseek: Object.freeze([
    { id: 'read', label: 'Read', description: 'Use the read-only DeepSeek profile.', write: false, exec: false, risk: 'low' },
    { id: 'write', label: 'Write', description: 'Use the writable DeepSeek profile.', write: true, exec: true, risk: 'medium' },
  ]),
  openclaw: Object.freeze([
    { id: 'read-only', label: 'Read Only', description: 'Deny file writes and command execution while keeping native read tools.', write: false, exec: false, risk: 'low' },
    { id: 'default', label: 'Native Configuration', description: 'Use OpenClaw native tool permissions.', write: true, exec: true, risk: 'medium' },
  ]),
  kimi: Object.freeze([
    { id: 'read-only', label: 'Read Only', description: 'Deny file writes and command execution while keeping native read tools.', write: false, exec: false, risk: 'low' },
    { id: 'default', label: 'Native Configuration', description: 'Use Kimi native ACP permissions.', write: true, exec: true, risk: 'medium' },
  ]),
  opencodereview: Object.freeze([
    { id: 'review', label: 'Review', description: 'Read-only code review.', write: false, exec: false, risk: 'low' },
  ]),
})

const FALLBACK = Object.freeze([
  { id: 'default', label: 'Native Configuration', description: 'Use the provider native permissions.', write: true, exec: true, risk: 'medium' },
])

function nativePermissionModes(provider) {
  return MODES[provider] || FALLBACK
}

function defaultNativePermission(provider) {
  return nativePermissionModes(provider).find(mode => !mode.write)?.id || nativePermissionModes(provider)[0].id
}

function nativePermissionDescriptor(provider, permission) {
  return nativePermissionModes(provider).find(mode => mode.id === permission) || null
}

function nativePermissionAllowsWrite(provider, permission) {
  return nativePermissionDescriptor(provider, permission)?.write === true
}

function nativePermissionAllowsExec(provider, permission) {
  const mode = nativePermissionDescriptor(provider, permission)
  return Boolean(mode && (mode.exec || mode.write))
}

function capabilitiesForNativePermission(provider, permission) {
  if (!nativePermissionDescriptor(provider, permission)) return []
  const mode = nativePermissionDescriptor(provider, permission)
  const capabilities = ['read']
  if (mode.exec || mode.write) capabilities.push('read-exec')
  if (mode.write) capabilities.push('write-drafts', 'write-workdir')
  return capabilities
}

function publicNativePermissionModes() {
  return Object.fromEntries(Object.entries({ ...MODES, default: FALLBACK }).map(([provider, modes]) => [
    provider,
    modes.map(({ id, label, description, write, exec, risk }) => ({ id, label, description, write, exec, risk })),
  ]))
}

module.exports = {
  capabilitiesForNativePermission,
  defaultNativePermission,
  nativePermissionAllowsExec,
  nativePermissionAllowsWrite,
  nativePermissionDescriptor,
  nativePermissionModes,
  publicNativePermissionModes,
}
