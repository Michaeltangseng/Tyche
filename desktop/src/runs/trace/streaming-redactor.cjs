'use strict'

const { redactSecrets, secretSpans } = require('../../security/secret-redaction.cjs')

const PRIVATE_KEY_OPENING = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i
const WHITESPACE = /\s/

function redactKnownValues(value, knownValues) {
  let text = String(value || '')
  for (const known of knownValues) {
    if (!known) continue
    text = text.split(known).join('[redacted]')
  }
  return text
}

function redactAll(value, knownValues) {
  return redactSecrets(redactKnownValues(value, knownValues))
}

function createStreamingRedactor({
  knownValues = [],
  minWindow = 1024,
  holdLimit = 64 * 1024,
} = {}) {
  const values = [...new Set(
    knownValues
      .map(value => String(value ?? ''))
      .filter(Boolean),
  )].sort((left, right) => right.length - left.length)
  const window = Math.max(
    minWindow,
    ...values.map(value => value.length),
  )

  const DISCARDING = 'discarding-private-key'
  let pending = ''
  let mode = 'normal'
  let discardTail = ''
  let privateKeyEnd = ''

  function releaseNormal(buffer) {
    let cut = -1
    const limit = buffer.length - window
    let trailingWordStart = buffer.length
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      if (WHITESPACE.test(buffer[index])) {
        trailingWordStart = index + 1
        break
      }
    }
    const maximum = Math.min(limit, trailingWordStart)
    if (maximum > 0) {
      const spans = secretSpans(buffer, { knownValues: values })
      for (let candidate = maximum; candidate > 0; candidate -= 1) {
        if (candidate < buffer.length && !WHITESPACE.test(buffer[candidate - 1])) continue
        const crosses = spans.some(span => span.start < candidate && span.end > candidate)
        if (crosses) continue
        const reachesEnd = spans.some(span => span.end === buffer.length && span.start < candidate)
        if (reachesEnd) continue
        cut = candidate
        break
      }
    }
    if (cut <= 0 && buffer.length > holdLimit) {
      const spans = secretSpans(buffer, { knownValues: values })
      let forced = buffer.length - window
      let changed = true
      while (changed) {
        changed = false
        for (const span of spans) {
          if (span.start < forced && span.end > forced) {
            forced = span.start
            changed = true
            break
          }
        }
      }
      if (forced > 0) cut = forced
    }
    if (cut <= 0) {
      pending = buffer
      return ''
    }
    const released = redactAll(buffer.slice(0, cut), values)
    pending = buffer.slice(cut)
    return released
  }

  function consumeDiscard(input) {
    const combined = discardTail + input
    const end = privateKeyEnd.toLowerCase()
    const index = combined.toLowerCase().indexOf(end)
    if (index < 0) {
      discardTail = combined.slice(-Math.max(0, privateKeyEnd.length - 1))
      return { output: '', remaining: '', done: false }
    }
    discardTail = ''
    mode = 'normal'
    privateKeyEnd = ''
    return {
      output: '',
      remaining: combined.slice(index + privateKeyEnd.length),
      done: true,
    }
  }

  function push(chunk) {
    let input = String(chunk || '')
    if (!input) return ''
    let output = ''
    while (input.length > 0) {
      if (mode === DISCARDING) {
        const consumed = consumeDiscard(input)
        output += consumed.output
        input = consumed.remaining
        if (!consumed.done) break
        continue
      }
      const buffer = pending + input
      pending = ''
      const opening = buffer.match(PRIVATE_KEY_OPENING)
      if (!opening || opening.index === undefined) {
        output += releaseNormal(buffer)
        break
      }
      output += redactAll(buffer.slice(0, opening.index), values)
      output += '[redacted private key]'
      mode = DISCARDING
      discardTail = ''
      privateKeyEnd = opening[0].replace(/BEGIN/i, 'END')
      input = buffer.slice(opening.index + opening[0].length)
    }
    return output
  }

  function end() {
    if (mode === DISCARDING) {
      discardTail = ''
      return ''
    }
    const released = redactAll(pending, values)
    pending = ''
    return released
  }

  function state() {
    return mode
  }

  return { end, push, state }
}

module.exports = { createStreamingRedactor }
