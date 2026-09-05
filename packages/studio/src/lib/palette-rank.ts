/**
 * The ranking one `matchScore` function serves for every command palette in
 * Studio (plan 310 §4.2's own instruction: "extract it... so the two
 * palettes cannot drift into ranking differently"). Originally private to
 * `flow/NodePalette.tsx`; `scripts/ScriptPalette.tsx` is the second caller
 * this was pulled out for.
 *
 * The rule is deliberately simple and stated once, here: a title-prefix
 * match ranks first, then any haystack-prefix match, then any haystack
 * substring match, in that order; anything else does not match at all
 * (`null`). Ties within a rank are broken by the caller (both current
 * callers sort ties by title).
 */
export interface PaletteMatchable {
  title: string
  /** `null`/`undefined` both mean "nothing to search here". */
  description?: string | null
  /** Search terms beyond `title`/`description` — a plugin id, an `exportId`, `keywords`, and the like. */
  keywords?: readonly string[]
}

export function matchScore(query: string, item: PaletteMatchable): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const title = item.title.toLowerCase()
  const haystacks = [title, (item.description ?? '').toLowerCase(), ...(item.keywords ?? []).map((k) => k.toLowerCase())]
  if (title.startsWith(q)) return 0
  if (haystacks.some((h) => h.startsWith(q))) return 1
  if (haystacks.some((h) => h.includes(q))) return 2
  return null
}
