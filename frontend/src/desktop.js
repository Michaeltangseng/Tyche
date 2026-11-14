export {
  normalizeCapsuleEvent,
  normalizeMessageTrace,
  normalizeRunAgent,
  normalizeRunEvent,
} from './desktop-normalization.js'
export { mergeRunEvent } from './desktop-run-events.js'
export { emptySnapshot, normalizeSnapshot } from './desktop-snapshot.js'

export function desktopApi() {
  return typeof window !== 'undefined' ? window.meldworkDesktop || null : null
}

export const PROJECT_ROOM_METHODS = Object.freeze([
  'getPreferences', 'setPreferences', 'chooseWorkdir', 'create', 'rename', 'delete',
  'retryDeletion', 'snapshot', 'updateSeat', 'addSeat', 'removeSeat', 'updateProfile',
  'rollbackProfile', 'updatePlaybook', 'saveAsTemplate', 'compact', 'diagnostics',
  'timelineHistory', 'start', 'interject', 'stopAndDeliver', 'decideGate',
  'previewReject', 'previewReopen', 'reopen', 'resolveDrift', 'cancelDriftResolution',
  'resolveOutOfScope', 'retryEffect', 'residual', 'unlockDirectory',
])

export function createProjectRoomApi(bridge = desktopApi()?.projectRoom || null) {
  if (!bridge) return null
  const api = {}
  for (const method of PROJECT_ROOM_METHODS) {
    if (typeof bridge[method] === 'function') {
      api[method] = input => bridge[method](input)
    }
  }
  if (typeof bridge.onChanged === 'function') {
    api.onChanged = callback => bridge.onChanged(callback)
  }
  if (typeof bridge.onOpen === 'function') {
    api.onOpen = callback => bridge.onOpen(callback)
  }
  return Object.freeze(api)
}

export function projectRoomApi() {
  return createProjectRoomApi()
}

const PROJECT_ERROR_CODE = /^PROJECT_[A-Z0-9_]+$/

export function projectRoomErrorKey(error) {
  const code = String(error?.code || error?.message || error || '').trim().toUpperCase()
  return PROJECT_ERROR_CODE.test(code) ? `errors.${code}` : 'error.generic'
}

export function errorCode(error) {
  return String(error?.code || error?.message || error || '').trim()
}
