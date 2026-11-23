import { describe, expect, it } from 'vitest'
import { keptSkillIds, selectableSkills, skillTokenEstimate } from '../../skillInventory.js'

const skills = [
  { id: 'shared/library/frontend-design', source: 'shared' },
  { id: 'shared/library/review', source: 'market' },
  { id: 'claude/global/review', source: 'native', originKind: 'claude' },
]

describe('skill inventory selection', () => {
  it('selects every platform Skill and never a native one', () => {
    expect(selectableSkills(skills, 'claude').map(skill => skill.id)).toEqual([
      'shared/library/frontend-design',
      'shared/library/review',
    ])
    expect(keptSkillIds(
      ['claude/global/review', 'shared/library/frontend-design', 'claude/global/review'],
      skills,
      'claude',
    )).toEqual(['shared/library/frontend-design'])
  })

  it('does not cap the number of equipped skills', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      id: `shared/library/skill-${index}`,
      source: 'shared',
    }))
    expect(keptSkillIds(many.map(skill => skill.id), many, 'claude')).toHaveLength(9)
  })

  it('estimates about 100 tokens for each equipped skill', () => {
    expect(skillTokenEstimate(2)).toBe(200)
    expect(skillTokenEstimate(0)).toBe(0)
  })
})
