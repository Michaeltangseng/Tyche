const CATALOG = require('./market-catalog.json')

function catalogEntries() {
  return Array.isArray(CATALOG?.entries) ? CATALOG.entries : []
}

module.exports = { catalogEntries }
