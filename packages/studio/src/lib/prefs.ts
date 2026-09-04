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
   * Plan 102 (M67) §5 step 102.6 — the workflow editor's List <-> Canvas
   * toggle. The list stays the default and the editor of record (§3.5); a
   * property of the screen someone is sitting in front of, not a "must
   * always start this way" rule, so it belongs beside `cardWidth` above
   * rather than in the per-tab session store.
   */
  workflowEditorView: z.enum(['list', 'canvas']).default('list'),
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
   * `workflowEditorView`/`latencyOverlay` above.
   */
  cardWidth: z.enum(['s', 'm', 'l', 'xl']).default('m'),
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
