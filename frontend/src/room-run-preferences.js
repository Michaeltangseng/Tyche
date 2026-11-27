import { ref } from 'vue'

export const openWorkbenchOnStart = ref(true)
export const rosterWaitsForInstruction = ref(true)

export function applyRoomRunPreferences(value) {
  if (!value || typeof value !== 'object') return
  if ('openWorkbenchOnStart' in value) openWorkbenchOnStart.value = value.openWorkbenchOnStart !== false
  if ('rosterWaitsForInstruction' in value) rosterWaitsForInstruction.value = value.rosterWaitsForInstruction !== false
}
