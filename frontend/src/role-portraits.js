import { publicAsset } from './catalog.js'

const PORTRAITS = Object.freeze([
  { id: 'claude', src: publicAsset('role-portraits/claude.jpg') },
  { id: 'codex', src: publicAsset('role-portraits/codex.jpg') },
  { id: 'pi', src: publicAsset('role-portraits/pi.jpg') },
  { id: 'gemini', src: publicAsset('role-portraits/gemini.jpg') },
  { id: 'hermes', src: publicAsset('role-portraits/hermes.jpg') },
  { id: 'deepseek', src: publicAsset('role-portraits/deepseek.jpg') },
  { id: 'kimi', src: publicAsset('role-portraits/kimi.jpg') },
  { id: 'qwen', src: publicAsset('role-portraits/qwen.jpg') },
])

const BY_ID = new Map(PORTRAITS.map(portrait => [portrait.id, portrait]))

const PORTRAIT_GLOW = Object.freeze({
  claude: '#ff8a3d',
  codex: '#4c93ff',
  pi: '#8fd0ff',
  gemini: '#b388ff',
  hermes: '#3ecf8e',
  deepseek: '#5b7cff',
  kimi: '#67d4ff',
  qwen: '#f0b429',
})

const PROVIDER_PORTRAIT = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  pi: 'pi',
  gemini: 'gemini',
  hermes: 'hermes',
  deepseek: 'deepseek',
  kimi: 'kimi',
  qwen: 'qwen',
  opencode: 'hermes',
  opencodereview: 'deepseek',
  mimo: 'kimi',
  openclaw: 'pi',
  workbuddy: 'qwen',
  zcode: 'codex',
})

export function rolePortraits() {
  return PORTRAITS
}

export function portraitId(provider) {
  const key = String(provider || '')
  const mapped = PROVIDER_PORTRAIT[key]
  if (mapped && BY_ID.has(mapped)) return mapped
  if (!key) return PORTRAITS[0].id
  let hash = 0
  for (const char of key) hash = (hash + char.charCodeAt(0)) % PORTRAITS.length
  return PORTRAITS[hash].id
}

export function rolePortrait(provider) {
  const key = String(provider || '')
  if (BY_ID.has(key)) return BY_ID.get(key).src
  return BY_ID.get(portraitId(key)).src
}

export function portraitGlow(provider) {
  return PORTRAIT_GLOW[portraitId(provider)] || '#3ec4d0'
}
