import { ref } from 'vue'
import { readProductPreference, writeProductPreference } from './product-preferences.js'

const STORAGE_NAME = 'title-marquee'
const memory = new Map()

function storedValue() {
  try {
    const value = readProductPreference(STORAGE_NAME)
    if (value != null) memory.set(STORAGE_NAME, value)
    return value
  } catch {
    return memory.has(STORAGE_NAME) ? memory.get(STORAGE_NAME) : null
  }
}

export function readTitleMarqueeEnabled() {
  const value = storedValue()
  if (value == null || value === '') return true
  return value !== 'off'
}

export const titleMarqueeEnabled = ref(readTitleMarqueeEnabled())

export function setTitleMarqueeEnabled(enabled) {
  const next = Boolean(enabled)
  titleMarqueeEnabled.value = next
  const stored = next ? 'on' : 'off'
  memory.set(STORAGE_NAME, stored)
  try {
    writeProductPreference(STORAGE_NAME, stored)
  } catch { /* browsers keep the localStorage copy; tests keep the memory copy */ }
}
