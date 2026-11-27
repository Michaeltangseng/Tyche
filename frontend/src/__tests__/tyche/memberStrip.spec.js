import { describe, expect, it } from 'vitest'
import { fitMemberCount } from '../../memberStrip.js'

describe('member strip fit', () => {
  it('reserves room for +N once a chip no longer fits', () => {
    expect(fitMemberCount([120, 120, 120], 244, 40, 8)).toBe(1)
    expect(fitMemberCount([80, 80, 80], 280, 40, 8)).toBe(3)
    expect(fitMemberCount([80, 80, 80], 0, 40, 8)).toBe(3)
  })
})
