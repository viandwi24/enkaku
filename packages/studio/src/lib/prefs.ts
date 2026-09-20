import { z } from 'zod'

/**
 * Two client-side preference stores, deliberately NOT one shared module
 * (plan 92 §3.10, §4.9, §9 Q1 — decided 2026-08-12).
 *
 * `devicesView` (Table | Screens, plan 214 §3.4 — replaces the old `view`
 * (List | Wall)) has to forget itself on a new tab/window/session so
 * the Table stays the UNCONDITIONAL landing view (design handoff, "Screen:
 * Devices"). `sessionStorage` is the mechanical device that makes that true:
 * it survives a reload of the SAME tab (so "Screens is one click away" also
 * holds across a reload), but a brand-new tab starts with nothing in it and
 * therefore always falls through to `'table'`. There is no farm setting
 * anywhere in this chain — a farm-wide switch would let one operator's
 * choice become everyone else's front door, which is what "unconditionally"
 * rules out.
 *
 * `cardWidth` is a property of the screen someone is sitting in front of
 * (§3.11), not a landing-view choice, so it belongs in `localStorage` and
 * outlives a new tab exactly the way a screen's size does.
 *
 * Both reads go through a `try/catch` (private browsing throws on storage
 * access) and a Zod parse (a corrupt or hand-edited value degrades to the
 * schema default rather than throwing into a render).
 */

/** The Screens card-width slider's bounds, in px. Shared with the slider itself, so a stored value is always one it can show. */
export const CARD_WIDTH_MIN_PX = 96
export const CARD_WIDTH_MAX_PX = 400

const SESSION_STORAGE_KEY = 'enkaku:session-prefs'
const LOCAL_STORAGE_KEY = 'enkaku:local-prefs'

// This tab's view choice ONLY. Absent in a fresh tab/window/session — see
// the module comment above for why that absence is load-bearing.
const SessionPrefsSchema = z.object({
  /** The Devices screen's Table/Screens toggle (plan 214 §3.4). */
  devicesView: z.enum(['table', 'screens']).optional(),
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
   * Plan 203 §4.12: whether the Device Control cast shows the latency
   * overlay. A property of the screen an operator is sitting in front of,
   * like `cardWidth`, so it lives in `localStorage` and survives a new tab.
   * Off by default: it is a diagnostic, not a status readout.
   */
  latencyOverlay: z.boolean().default(false),
  /**
   * The Screens view's card-width preset (design handoff, Devices toolbar
   * "View" menu: S 112 / M 146 / L 190 / XL 240 — plan 214 §4.6). A property
   * of the screen someone is sitting in front of, exactly like
   * `latencyOverlay` above.
   */
  cardWidth: z.enum(['s', 'm', 'l', 'xl']).default('m'),
  /**
   * The Screens view's exact card width in px, set by the View menu's slider
   * (owner, 2026-09-15). Absent until the operator first moves the slider or
   * picks a preset, in which case `cardWidth` above still decides — so a
   * browser that saved only a preset keeps it. Out of range or corrupt reads
   * as absent (`.catch`) rather than failing the whole object, which would
   * also throw away `latencyOverlay` and `deviceControlHeight`.
   */
  cardWidthPx: z.number().int().min(CARD_WIDTH_MIN_PX).max(CARD_WIDTH_MAX_PX).optional().catch(undefined),
  /**
   * Whether the Screens cards draw their device's labels along the bottom
   * (owner, 2026-09-16). OFF by default: a wall is read by scanning pictures,
   * and the owner asked to choose whether the chips are there at all. The
   * table's own Labels column is a different thing and is unaffected — this
   * only decides what a CARD shows.
   */
  showCardLabels: z.boolean().default(false),
  /**
   * Device Control's dragged height, in px. The width is derived from it and
   * the live aspect ratio (`device-control/geometry.ts`), so one number is the
   * whole size. A property of the screen someone is sitting in front of, like
   * every other key in here — never a farm setting.
   */
  deviceControlHeight: z.number().int().min(320).max(1600).default(640),
  /**
   * The Files screen's lens: tiles, a compact list, or the sortable details
   * table (owner, 2026-09-20 — "kaya file manager/finder beneran"). A file
   * manager that forgets which way you look at it is not one, and this is a
   * property of the screen someone is sitting in front of exactly like
   * `cardWidth` above — never a farm setting, never `sessionStorage`: unlike
   * the Devices Table/Screens toggle there is no landing view a new tab must
   * unconditionally start in.
   */
  filesView: z.enum(['grid', 'list', 'details']).default('grid'),
  /**
   * What the library is ordered by, and which way. Two keys rather than one
   * `name-asc` string so the details table's column headers can flip the
   * direction without having to re-parse the key they are flipping.
   *
   * `added` descending is the default because it is what the screen already
   * did before it could be changed, and it is what an operator who has just
   * uploaded forty clips is looking for.
   */
  filesSort: z.enum(['name', 'added', 'size', 'duration', 'kind']).default('added'),
  filesSortDir: z.enum(['asc', 'desc']).default('desc'),
  /**
   * How many files one page holds. A choice and not a constant because the
   * right number depends on the lens: 48 tiles fill a 1600 px grid, and 48
   * rows of the details table is a third of that screen.
   *
   * It is a CLIENT-side page over the whole library (`listUploads` walks the
   * core's keyset to the end), not a window onto the core's own pages — the
   * core can only key a page on `createdAt`, so a page numbered by name or by
   * size could not be asked of it. See `listUploads` for why that walk is
   * bounded and what it costs.
   */
  filesPageSize: z.union([z.literal(24), z.literal(48), z.literal(96), z.literal(192)]).default(48),
  /**
   * How big a tile is in the Files grid. The same idea as `cardWidth` on the
   * Devices wall and for the same reason — how much of one file you want to
   * see at once is a property of the screen and the job, not of the farm.
   */
  filesTileSize: z.enum(['s', 'm', 'l']).default('m'),
})
export type LocalPrefs = z.infer<typeof LocalPrefsSchema>

/** Reads `localStorage` through the schema; any failure (private mode, corrupt value) yields the schema default. */
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
