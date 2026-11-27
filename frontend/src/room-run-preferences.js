import { ref } from 'vue'

export const openWorkbenchOnStart = ref(true)
export const rosterWaitsForInstruction = ref(true)
export const userPortrait = ref('')

export function applyRoomRunPreferences(value) {
  if (!value || typeof value !== 'object') return
  if ('openWorkbenchOnStart' in value) openWorkbenchOnStart.value = value.openWorkbenchOnStart !== false
  if ('rosterWaitsForInstruction' in value) rosterWaitsForInstruction.value = value.rosterWaitsForInstruction !== false
  if ('userPortrait' in value) {
    userPortrait.value = /^(0[1-9]|1[0-2])$/.test(String(value.userPortrait || '')) ? value.userPortrait : ''
  }
}
