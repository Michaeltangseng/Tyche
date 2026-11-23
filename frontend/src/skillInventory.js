export function selectableSkills(skills, agent) {
  void agent
  return (Array.isArray(skills) ? skills : []).filter(skill => skill?.source !== 'native')
}

export function keptSkillIds(ids, skills, agent) {
  const allowed = new Set(selectableSkills(skills, agent).map(skill => skill.id))
  const kept = []
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!allowed.has(id) || kept.includes(id)) continue
    kept.push(id)
  }
  return kept
}

export function skillTokenEstimate(count) {
  const value = Number(count)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value) * 100
}
