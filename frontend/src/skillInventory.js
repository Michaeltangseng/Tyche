export const MAX_ROLE_SKILLS = 8

export function selectableSkills(skills, agent) {
  return (Array.isArray(skills) ? skills : []).filter(skill => (
    skill?.trust === 'trusted' && (
      Array.isArray(skill.available)
        ? skill.available.includes(agent)
        : Array.isArray(skill.eligible) && skill.eligible.includes(agent)
    )
  ))
}

export function keptSkillIds(ids, skills, agent) {
  const allowed = new Set(selectableSkills(skills, agent).map(skill => skill.id))
  const kept = []
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!allowed.has(id) || kept.includes(id)) continue
    kept.push(id)
    if (kept.length >= MAX_ROLE_SKILLS) break
  }
  return kept
}

export function skillTokenEstimate(count) {
  const value = Number(count)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value) * 100
}
