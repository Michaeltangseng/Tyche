/** Share of the header row the member cluster may use. The handoff stays outside it. */
export const MEMBER_STRIP_RATIO = 0.7
export const MEMBER_MORE_WIDTH = 40
export const MEMBER_ADD_WIDTH = 28
export const MEMBER_GAP = 8

/**
 * How many member chips fit in `maxWidth`, leaving room for a `+N` chip
 * whenever someone is left out. A width of 0 means the strip has not been
 * measured yet, so every chip stays visible.
 */
export function fitMemberCount(widths, maxWidth, moreWidth = MEMBER_MORE_WIDTH, gap = MEMBER_GAP) {
  const chips = Array.isArray(widths) ? widths : []
  if (!chips.length) return 0
  if (!(maxWidth > 0)) return chips.length
  let used = 0
  let count = 0
  for (let index = 0; index < chips.length; index += 1) {
    const width = Math.max(Number(chips[index]) || 0, 1)
    const gapBefore = count > 0 ? gap : 0
    const remaining = chips.length - index - 1
    const reserve = remaining > 0 ? gap + moreWidth : 0
    if (used + gapBefore + width + reserve > maxWidth && count > 0) break
    used += gapBefore + width
    count += 1
  }
  return count
}
