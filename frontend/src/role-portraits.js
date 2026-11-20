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

export function rolePortrait(provider) {
  const key = String(provider || '')
  const mapped = PROVIDER_PORTRAIT[key]
  if (mapped && BY_ID.has(mapped)) return BY_ID.get(mapped).src
  if (!key) return PORTRAITS[0].src
  let hash = 0
  for (const char of key) hash = (hash + char.charCodeAt(0)) % PORTRAITS.length
  return PORTRAITS[hash].src
}
