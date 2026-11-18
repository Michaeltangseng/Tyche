import { beforeEach, describe, expect, it } from 'vitest'

import { readProductPreference, writeProductPreference } from '../../product-preferences.js'

describe('Tyche product preferences', () => {
  beforeEach(() => localStorage.clear())

  it('migrates a legacy preference once and keeps the Tyche key authoritative', () => {
    const legacyKey = `${['round', 'relay'].join('')}-theme`
    localStorage.setItem(legacyKey, 'dark')

    expect(readProductPreference('theme')).toBe('dark')
    expect(localStorage.getItem('tyche-theme')).toBe('dark')
    expect(localStorage.getItem(legacyKey)).toBeNull()

    writeProductPreference('theme', 'light')
    expect(readProductPreference('theme')).toBe('light')
  })
})
