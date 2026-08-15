import { z } from 'zod'

/**
 * Two client-side preference stores, deliberately NOT one shared module
 * (plan 92 §3.10, §4.9, §9 Q1 — decided 2026-08-12).
 *
 * `view` (List | Wall) has to forget itself on a new tab/window/session so
 * the Wall stays the UNCONDITIONAL landing view — "wall first emang wajib
 * tampilannya itu". `sessionStorage` is the mechanical device that makes
 * that true: it survives a reload of the SAME tab (so "List is one click
 * away" also holds across a reload), but a brand-new tab starts with
 * nothing in it and therefore always falls through to `'wall'`. There is no
 * farm setting anywhere in this chain — `wall.defaultView` was proposed and
 * then cut for exactly this reason (§9 Q1): a farm-wide switch would let one
 * operator's choice become everyone else's front door, which is what
 * "unconditionally" rules out.
 *
 * `tileSize` is a property of the screen someone is sitting in front of
 * (§3.11), not a landing-view choice, so it belongs in `localStorage` and
 * outlives a new tab exactly the way a screen's size does.
 *
 * Both reads go through a `try/catch` (private browsing throws on storage
 * access) and a Zod parse (a corrupt or hand-edited value degrades to the
 * schema default rather than throwing into a render).
 */

const SESSION_STORAGE_KEY = 'enkaku:session-prefs'
const LOCAL_STORAGE_KEY = 'enkaku:local-prefs'

// This tab's view choice ONLY. Absent in a fresh tab/window/session — see
// the module comment above for why that absence is load-bearing.
const SessionPrefsSchema = z.object({
  view: z.enum(['list', 'wall']).optional(),
})
export type SessionPrefs = z.infer<typeof SessionPrefsSchema>

/** Reads `sessionStorage` through the schema; any failure (private mode, corrupt value) yields `{}`. */
export function readSessionPrefs(): SessionPrefs {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return {}
    const parsed = SessionPrefsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

export function writeSessionPrefs(patch: Partial<SessionPrefs>): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...readSessionPrefs(), ...patch }))
  } catch {
    // Private browsing, or storage disabled outright — the choice simply
    // does not persist; it never crashes the click that made it.
  }
}

// A genuine cross-session preference — survives a new tab on purpose.
const LocalPrefsSchema = z.object({
  tileSize: z.enum(['s', 'm', 'l']).default('m'),
})
export type LocalPrefs = z.infer<typeof LocalPrefsSchema>
export type TileSize = LocalPrefs['tileSize']

/** The `140 / 180 / 260` px minimum tile widths §3.11 specifies, keyed by the S/M/L a person actually picks. */
export const TILE_SIZE_PX: Record<TileSize, number> = { s: 140, m: 180, l: 260 }

/** Reads `localStorage` through the schema; any failure (private mode, corrupt value) yields the schema default (`'m'`). */
export function readLocalPrefs(): LocalPrefs {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    const parsed = LocalPrefsSchema.safeParse(raw ? JSON.parse(raw) : {})
    return parsed.success ? parsed.data : LocalPrefsSchema.parse({})
  } catch {
    return LocalPrefsSchema.parse({})
  }
}

export function writeLocalPrefs(patch: Partial<LocalPrefs>): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ ...readLocalPrefs(), ...patch }))
  } catch {
    // Same as writeSessionPrefs above — never throws into the click handler.
  }
}
