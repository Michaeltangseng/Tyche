const SENSITIVE_ASSIGNMENT_KEY = /(?:api[_ -]?key|access[_ -]?key|secret[_ -]?access[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|database[_ -]?url|connection[_ -]?string|dsn|token|secret|password|credential|authorization|private[_ -]?key|session[_ -]?ref)/i
const BASIC_AUTH_CANDIDATE = /\bBasic[ \t]+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/gi
const JOSE_COMPACT_CANDIDATE = /(?<![0-9A-Za-z_-])(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){4}|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2})(?![0-9A-Za-z_-])/g

function decodeCanonicalBase64(value, encoding) {
  try {
    const decoded = Buffer.from(value, encoding)
    if (!decoded.length) return null
    const normalized = value.replace(/=+$/, '')
    return decoded.toString(encoding).replace(/=+$/, '') === normalized ? decoded : null
  } catch {
    return null
  }
}

function isBasicCredential(value) {
  return decodeCanonicalBase64(value, 'base64')?.includes(0x3a) === true
}

function hasJoseHeader(value) {
  const headerBytes = decodeCanonicalBase64(value.split('.')[0], 'base64url')
  if (!headerBytes) return false
  try {
    const header = JSON.parse(headerBytes.toString('utf8'))
    if (!header || typeof header !== 'object' || Array.isArray(header)) return false
    return [header.alg, header.enc].some(item => typeof item === 'string' && item.trim())
  } catch {
    return false
  }
}

// Order matters: redactSecrets applies these in sequence, exactly as the
// previous chained implementation did.
const SECRET_RULES = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
    replacement: '[redacted private key]',
  },
  {
    name: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: 'Bearer [redacted]',
  },
  {
    name: 'basic-auth',
    pattern: BASIC_AUTH_CANDIDATE,
    replace: (match, credential) => (
      isBasicCredential(credential) ? 'Basic [redacted]' : match
    ),
  },
  {
    name: 'token-prefix',
    pattern: /\b(sk|rk|pk|ghp|github_pat|xox[baprs]?)[_-][A-Za-z0-9_-]{12,}\b/gi,
    replacement: '[redacted]',
  },
  {
    name: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[redacted]',
  },
  {
    name: 'google-api-key',
    pattern: /(?<![0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
    replacement: '[redacted]',
  },
  {
    name: 'jose',
    pattern: JOSE_COMPACT_CANDIDATE,
    replace: match => (hasJoseHeader(match) ? '[redacted]' : match),
  },
  {
    name: 'url-credentials',
    pattern: /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
    replacement: '$1[redacted]@',
  },
  {
    name: 'sensitive-assignment',
    pattern: /(["']?)[A-Za-z0-9_.-]*(?:api[_ -]?key|access[_ -]?key(?:[_ -]?id)?|secret[_ -]?access[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|database[_ -]?url|connection[_ -]?string|dsn|token|secret|password|credential|authorization|private[_ -]?key|session[_ -]?ref(?:erence)?)[A-Za-z0-9_.-]*\1\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|\[[^\]\r\n]*\]|[^\s,;}\]]+)/gi,
    replacement: 'credential=[redacted]',
    appliesTo: text => SENSITIVE_ASSIGNMENT_KEY.test(text),
  },
]

function redactSecrets(value) {
  let text = String(value || '')
  for (const rule of SECRET_RULES) {
    if (rule.appliesTo && !rule.appliesTo(text)) continue
    text = rule.replace
      ? text.replace(rule.pattern, rule.replace)
      : text.replace(rule.pattern, rule.replacement)
  }
  return text
}

function cloneGlobal(pattern) {
  const flags = new Set(pattern.flags)
  flags.add('g')
  return new RegExp(pattern.source, [...flags].join(''))
}

function mergeSpans(spans) {
  spans.sort((left, right) => left.start - right.start || right.end - left.end)
  const merged = []
  for (const span of spans) {
    const previous = merged[merged.length - 1]
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end)
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

function secretSpans(value, { knownValues = [] } = {}) {
  const text = String(value || '')
  const spans = []
  for (const rule of SECRET_RULES) {
    if (rule.appliesTo && !rule.appliesTo(text)) continue
    const pattern = cloneGlobal(rule.pattern)
    let match
    while ((match = pattern.exec(text)) !== null) {
      const replaced = rule.replace ? rule.replace(...match) : rule.replacement
      if (replaced !== match[0]) {
        spans.push({ start: match.index, end: match.index + match[0].length, rule: rule.name })
      }
      if (match[0].length === 0) pattern.lastIndex += 1
    }
  }
  for (const valueItem of knownValues) {
    const needle = String(valueItem ?? '')
    if (!needle) continue
    let from = 0
    while (from <= text.length - needle.length) {
      const index = text.indexOf(needle, from)
      if (index < 0) break
      spans.push({ start: index, end: index + needle.length, rule: 'known-value' })
      from = index + needle.length
    }
  }
  return mergeSpans(spans)
}

module.exports = { SECRET_RULES, redactSecrets, secretSpans }
