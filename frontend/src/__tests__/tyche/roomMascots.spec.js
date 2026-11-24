import { describe, expect, it } from 'vitest'
import { ROOM_MASCOTS, roomMascot } from '../../room-mascots.js'

describe('room mascots', () => {
  it('registers twelve distinct animated SVG assets', () => {
    expect(ROOM_MASCOTS).toHaveLength(12)
    expect(new Set(ROOM_MASCOTS.map(mascot => mascot.src)).size).toBe(12)
    for (const mascot of ROOM_MASCOTS) {
      expect(mascot.src).toMatch(/room-mascots\/blob-\d{2}\.svg$/)
    }
  })

  it('keeps a room on one mascot and spreads rooms across the cast', () => {
    expect(roomMascot({ id: 'team-1' })).toBe(roomMascot({ id: 'team-1' }))
    const assigned = new Set(['team-1', 'team-2', 'team-3', 'team-4']
      .map(id => roomMascot({ id }).id))
    expect(assigned.size).toBe(4)
    expect(roomMascot({ name: 'fallback room' }).src).toMatch(/room-mascots\/blob-\d{2}\.svg$/)
  })
})
