const test = require('node:test')
const assert = require('node:assert/strict')
const {
  SECRET_RULES,
  redactSecrets,
  secretSpans,
} = require('../../src/security/secret-redaction.cjs')
const corpus = require('../fixtures/redaction/corpus.json')

function spansFor(text, options) {
  return secretSpans(text, options).map(span => ({
    start: span.start,
    end: span.end,
    rule: span.rule,
    text: text.slice(span.start, span.end),
  }))
}

test('the regression corpus keeps the pre-change redactSecrets output verbatim', () => {
  assert.ok(corpus.length >= 60)
  for (const item of corpus) {
    assert.equal(redactSecrets(item.input), item.expected, item.name)
  }
})

test('redactSecrets still uses the ordered rule list', () => {
  assert.deepEqual(SECRET_RULES.map(rule => rule.name), [
    'private-key',
    'bearer',
    'basic-auth',
    'token-prefix',
    'aws-access-key',
    'google-api-key',
    'jose',
    'url-credentials',
    'sensitive-assignment',
  ])
})

test('secretSpans reports each rule on the original text', () => {
  const cases = [
    ['private-key', 'x -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- y'],
    ['bearer', 'header Bearer abc.def-123'],
    ['basic-auth', 'Basic dXNlcjpwYXNz'],
    ['token-prefix', 'key sk_live_1234567890abcdef'],
    ['aws-access-key', 'id AKIAIOSFODNN7EXAMPLE end'],
    ['google-api-key', 'key AIzaSyA1234567890abcdefghijklmnopqrstuv end'],
    ['jose', 'token eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig'],
    ['url-credentials', 'see https://user:password@example.com/path'],
    ['sensitive-assignment', 'password=hunter2'],
  ]
  for (const [rule, text] of cases) {
    const spans = secretSpans(text)
    assert.ok(spans.some(span => span.rule === rule), `${rule} on ${text}`)
    for (const span of spans) {
      assert.ok(span.start >= 0 && span.end > span.start && span.end <= text.length)
    }
  }
})

test('secondary checks keep invalid Basic and non-JOSE dotted values out of the spans', () => {
  assert.deepEqual(secretSpans('Basic dXNlcg=='), [])
  assert.deepEqual(secretSpans('version 1.2.3 build'), [])
  assert.deepEqual(secretSpans('docs/foo.bar.baz.md'), [])
})

test('known values are reported at every occurrence', () => {
  const text = 'first SECRET-VALUE-123 then SECRET-VALUE-123 again'
  const spans = spansFor(text, { knownValues: ['SECRET-VALUE-123'] })
  assert.deepEqual(spans.map(span => span.rule), ['known-value', 'known-value'])
  assert.deepEqual(spans.map(span => span.text), ['SECRET-VALUE-123', 'SECRET-VALUE-123'])
  assert.ok(spans[0].end <= spans[1].start)
})

test('overlapping pattern and known-value spans are merged once', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig'
  const spans = spansFor(`value: ${jwt}`, { knownValues: [jwt] })
  assert.equal(spans.length, 1)
  assert.equal(spans[0].text, jwt)
  assert.equal(spans[0].rule, 'jose')
})

test('touching spans are merged into one interval', () => {
  const spans = secretSpans('token=abcSECRET-123', { knownValues: ['SECRET-123'] })
  assert.equal(spans.length, 1)
})
