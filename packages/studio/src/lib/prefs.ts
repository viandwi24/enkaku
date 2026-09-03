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
  /**
   * Plan 101 §5 step 101.8 (owner-specified, 2026-08-16): the default
   * bumped from `'m'` to `'l'` — a side-by-side against `refs/ui` found our
   * Wall reading noticeably smaller than the reference's own large,
   * few-columns tiles. The reference is a data-bound mockup with no
   * literal grid CSS to read an exact pixel target off (`gridTemplateColumns`
   * is computed by script, not present in the markup), so rather than
   * inventing a new number, this widens the STARTING size using a mapping
   * plan 92 §3.11 already specified and already ships (`TILE_SIZE_PX`,
   * unchanged by this step) — Large was already the biggest of three
   * legitimate, tested sizes; it simply was not the one an operator saw
   * first. `s`/`m` stay reachable exactly as before.
   */
  tileSize: z.enum(['s', 'm', 'l']).default('l'),
  /**
   * Plan 101 (M66) §3.4, step 101.2 — the sidebar's collapsed/expanded
   * state (222px / 72px). Unlike `view` above, there is no "must always be
   * this on a fresh tab" rule here — collapse is a property of the SCREEN
   * an operator is sitting in front of, the same reasoning `tileSize`
   * already uses, so it belongs beside it in `localStorage` rather than in
   * the per-tab `sessionStorage` store.
   */
  sidebarCollapsed: z.boolean().default(false),
  /**
   * Plan 102 (M67) §5 step 102.6 — the workflow editor's List <-> Canvas
   * toggle. The list stays the default and the editor of record (§3.5); a
   * property of the screen someone is sitting in front of, not a "must
   * always start this way" rule, so it belongs beside `sidebarCollapsed`
   * above rather than in the per-tab session store.
   */
  workflowEditorView: z.enum(['list', 'canvas']).default('list'),
  /**
   * Plan 101 (M66) §5 step 101.7 — the devices grid's page size (List and
   * Wall alike, ungrouped only — see `app/page.tsx`'s own note on why
   * grouping and pagination do not combine). A property of the screen an
   * operator is sitting in front of, exactly `tileSize`'s own reasoning, so
   * it belongs beside it in `localStorage` rather than resetting to the
   * default every time a fresh tab lands here.
   */
  /**
   * Plain tens, not grid multiples (field report, 2026-08-26). The old
   * `12/24/48/96` was chosen so a tile grid's last row always filled — it
   * divides by 2, 3, 4 and 6. That reasoning is real but it is the grid's,
   * not the operator's: someone running 35 devices thinks in twenties, and
   * `24` also collided confusingly with `wall.decodeTileCeiling`'s unrelated
   * default of the same number, which cost the owner time hunting a bug that
   * was two independent settings wearing one figure.
   *
   * The cost is accepted and stated: at 20 per page on a 6-column grid the
   * last row is partial. A readable number beats a tidy final row.
   *
   * `.catch(20)` matters — a browser holding `12`, `24`, `48` or `96` from
   * before this change would otherwise fail the union and reset every OTHER
   * preference in this object along with it.
   */
  pageSize: z
    .union([z.literal(20), z.literal(40), z.literal(60), z.literal(80), z.literal(100), z.literal(160), z.literal(200)])
    .catch(20)
    .default(20),
  /**
   * Plan 203 §4.12: whether the Device Control cast shows the latency
   * overlay. A property of the screen an operator is sitting in front of,
   * like `tileSize`, so it lives in `localStorage` and survives a new tab.
   * Off by default: it is a diagnostic, not a status readout.
   */
  latencyOverlay: z.boolean().default(false),
})
export type LocalPrefs = z.infer<typeof LocalPrefsSchema>
export type TileSize = LocalPrefs['tileSize']
export type PageSize = LocalPrefs['pageSize']

/** The `140 / 180 / 260` px minimum tile widths §3.11 specifies, keyed by the S/M/L a person actually picks. */
export const TILE_SIZE_PX: Record<TileSize, number> = { s: 140, m: 180, l: 260 }

/** The devices grid's page-size choices — plain tens (see `pageSize` above for why the grid-friendly `12/24/48/96` was dropped). */
export const PAGE_SIZE_OPTIONS: readonly PageSize[] = [20, 40, 60, 80, 100, 160, 200]

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
