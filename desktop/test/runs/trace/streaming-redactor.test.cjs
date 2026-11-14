const test = require('node:test')
const assert = require('node:assert/strict')
const { createStreamingRedactor } = require('../../../src/runs/trace/streaming-redactor.cjs')

function run(parts, options = {}) {
  const redactor = createStreamingRedactor(options)
  let output = ''
  for (const part of parts) output += redactor.push(part)
  output += redactor.end()
  return { output, state: redactor.state() }
}

function splitAt(text, ...indexes) {
  const parts = []
  let start = 0
  for (const index of indexes) {
    parts.push(text.slice(start, index))
    start = index
  }
  parts.push(text.slice(start))
  return parts
}

function assertNoFragments(output, secret, context) {
  const length = Math.min(8, secret.length)
  for (let index = 0; index + length <= secret.length; index += 1) {
    const fragment = secret.slice(index, index + length)
    assert.equal(
      output.includes(fragment),
      false,
      `${context}: leaked fragment ${JSON.stringify(fragment)}`,
    )
  }
}

test('a Bearer token split across two pushes stays redacted', () => {
  const { output } = run(['Authorization: Bearer abc', 'def'])
  assert.equal(output.includes('def'), false)
  assert.equal(output.includes('Bearer abc'), false)
  assert.ok(output.includes('[redacted]') || output.includes('credential=[redacted]'))
})

test('a known value split at every position is redacted', () => {
  const secret = 'meldwork-test-secret-1234567890'
  for (let index = 1; index < secret.length; index += 1) {
    const { output } = run(splitAt(`before ${secret} after`, index + 7), {
      knownValues: [secret],
    })
    assertNoFragments(output, secret, `split ${index}`)
  }
})

test('JWT, token assignment, and URL credentials split across pushes are redacted', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.signature'
  const jwtRun = run(splitAt(`token ${jwt}`, 14))
  assertNoFragments(jwtRun.output, jwt, 'jwt')

  const assignment = 'token=abcdef123456'
  const assignmentRun = run(splitAt(assignment, 8))
  assert.equal(assignmentRun.output.includes('abcdef123456'), false)

  const url = 'https://user:password@example.com/path'
  const urlRun = run(splitAt(url, 14))
  assert.equal(urlRun.output.includes('user:password'), false)
})

test('a private key block is discarded across chunks and processing resumes after it', () => {
  const key = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA1234567890abcdef',
    'more-secret-material',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n')
  const input = `before ${key} after`
  const redactor = createStreamingRedactor()
  let output = ''
  output += redactor.push(input.slice(0, 20))
  output += redactor.push(input.slice(20, 90))
  assert.equal(redactor.state(), 'discarding-private-key')
  output += redactor.push(input.slice(90))
  output += redactor.end()
  assert.equal(redactor.state(), 'normal')
  assert.ok(output.includes('[redacted private key]'))
  assert.equal(output.includes('MIIEowIBAAKCAQEA'), false)
  assert.equal(output.includes('more-secret-material'), false)
  assert.ok(output.includes('before '))
  assert.ok(output.includes(' after'))
})

test('a private key without an end marker never releases its body', () => {
  const redactor = createStreamingRedactor()
  let output = ''
  output += redactor.push('-----BEGIN RSA PRIVATE KEY-----\n')
  output += redactor.push('secret-body-'.repeat(1000))
  assert.equal(redactor.state(), 'discarding-private-key')
  output += redactor.end()
  assert.equal(output, '[redacted private key]')
})

test('a private key larger than 64 KiB without an end marker releases only the marker', () => {
  const redactor = createStreamingRedactor()
  let output = ''
  output += redactor.push('-----BEGIN OPENSSH PRIVATE KEY-----\n')
  output += redactor.push('A'.repeat(80 * 1024))
  output += redactor.end()
  assert.equal(output, '[redacted private key]')
})

test('a long line without whitespace is released by the forced cut', () => {
  const input = `start ${'a'.repeat(80 * 1024)}`
  const redactor = createStreamingRedactor()
  let output = redactor.push(input)
  output += redactor.end()
  assert.equal(output, input)
})

test('content before it is confirmed safe is never released', () => {
  const redactor = createStreamingRedactor({ knownValues: ['SECRET-12345678'] })
  assert.equal(redactor.push('Bearer abc'), '')
  assert.equal(redactor.end(), 'Bearer [redacted]')
})

test('random splits never leak a known or pattern-recognized secret', () => {
  const cases = [
    { text: 'prefix sk_live_1234567890abcdef suffix', secret: 'sk_live_1234567890abcdef' },
    { text: 'id AKIAIOSFODNN7EXAMPLE end', secret: 'AKIAIOSFODNN7EXAMPLE' },
    {
      text: 'key AIzaSyA1234567890abcdefghijklmnopqrstuv end',
      secret: 'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    },
    {
      text: 'Authorization: Basic dXNlcjpwYXNz',
      secret: 'dXNlcjpwYXNz',
    },
    { text: 'password=hunter2', secret: 'hunter2' },
    { text: 'https://user:password@example.com/path', secret: 'user:password' },
  ]
  let seed = 20261114
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }
  for (const { text, secret } of cases) {
    for (let round = 0; round < 20; round += 1) {
      const cutCount = Math.min(
        1 + Math.floor(random() * 19),
        Math.max(1, text.length - 1),
      )
      const cuts = new Set()
      while (cuts.size < cutCount) cuts.add(1 + Math.floor(random() * (text.length - 1)))
      const indexes = [...cuts].sort((left, right) => left - right)
      const parts = splitAt(text, ...indexes)
      const redactor = createStreamingRedactor()
      let output = ''
      try {
        for (const part of parts) output += redactor.push(part)
        output += redactor.end()
      } catch (error) {
        error.message += ` seed=20261114 cuts=${JSON.stringify(indexes)}`
        throw error
      }
      assertNoFragments(output, secret, `${text} cuts=${JSON.stringify(indexes)}`)
    }
  }
})
