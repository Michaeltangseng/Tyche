import { describe, expect, it } from 'vitest'
import { keptSkillIds, selectableSkills, skillTokenEstimate } from '../../skillInventory.js'

const skills = [
  { id: 'claude/global/frontend-design', trust: 'trusted', eligible: ['claude'] },
  { id: 'claude/global/review', trust: 'changed', eligible: ['claude'] },
  { id: 'codex/global/tests', trust: 'trusted', eligible: ['codex'] },
]

describe('skill inventory selection', () => {
  it('keeps only trusted skills that the current agent can select', () => {
    expect(selectableSkills(skills, 'claude').map(skill => skill.id)).toEqual(['claude/global/frontend-design'])
    expect(keptSkillIds(
      ['claude/global/review', 'claude/global/frontend-design', 'codex/global/tests'],
      skills,
      'claude',
    )).toEqual(['claude/global/frontend-design'])
  })

  it('does not cap the number of equipped skills', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      id: `claude/global/skill-${index}`,
      trust: 'trusted',
      eligible: ['claude'],
    }))
    expect(keptSkillIds(many.map(skill => skill.id), many, 'claude')).toHaveLength(9)
  })

  it('estimates about 100 tokens for each equipped skill', () => {
    expect(skillTokenEstimate(2)).toBe(200)
    expect(skillTokenEstimate(0)).toBe(0)
  })
})
