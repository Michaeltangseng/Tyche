'use strict'

const crypto = require('node:crypto')

function encodeId(id) {
  return crypto.createHash('sha256').update(String(id), 'utf8').digest('hex')
}

module.exports = { encodeId }
