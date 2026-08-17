import type { ScriptContext, WaitForOptions } from '@enkaku/sdk'
import type { Bounds, Selector, UiNode } from '@enkaku/protocol'
import { sleep } from './human'
import { clearBlockingDialog } from './dialogs'
import { all, centerOf, rowsById, within } from './tree'

/**
 * The switch-account bottom sheet: how to get to it, and how to read it.
 *
 * Extracted from `switch-account.ts` (plan 108 §4.6, step 108.11) the moment a SECOND member needed
 * the same five-screen walk — `list-accounts` reads the very same sheet, read-only. This module is
 * the plan's own argument for plugins made concrete: two members of one plugin share a helper by an
 * ordinary import, not by a copy that drifts.
 *
 * Everything here is built on dump-and-walk (`tree.ts`) rather than `find()` for the sheet's own
 * rows, because three of them share `id=l_z` and `find()` cannot tell a script that — it just
 * answers with row 0 every time (plan 86 §0.1). `find()` is used ONLY for selectors plan 86 §4.2
 * verified unique screen-wide.
 */

export const TIKTOK_PACKAGE = 'com.ss.android.ugc.trill'

// Selectors verified unique screen-wide against the reference device (plan 86 §4.2) — every one of
// these is safe to `find`/`waitFor` directly, unlike the sheet's own rows (§0.1) or `desc:"Cari"`
// (§0.2, out of scope here — that trap belongs to the search flow, not this one).
export const PROFIL_TAB: Selector = { desc: 'Profil' }
export const MENU_PROFIL: Selector = { desc: 'Menu profil' }
export const SETTINGS_ROW: Selector = { desc: 'Pengaturan dan privasi' }
export const BERALIH_AKUN: Selector = { desc: 'Beralih akun' }

/**
 * The sheet's own container description (plan 86 §4.2, row A6). Spelled once, as a bare string,
 * because it is needed BOTH as a selector (`SHEET_ANCHOR`, to prove the sheet opened) and as a
 * plain tree predicate (`readSheetSnapshot` here, `ownProfileShowsHandle` in `switch-account.ts`,
 * which must prove the sheet is GONE). Two spellings of one string is how those two checks would
 * quietly stop agreeing.
 */
export const SHEET_DESC = 'Lembar bawah'
export const SHEET_ANCHOR: Selector = { desc: SHEET_DESC }

// The sheet row container's shared resource id (plan 86 §4.2) — never a selector on its own; only
// ever fed to `rowsById`.
const ROW_SHORT_ID = 'l_z'
const TAMBAH_AKUN_DESC = 'Tambah akun'

/**
 * Indonesian TalkBack's label for the current-account checkmark (plan 86 §4.2's sheet dump, node
 * `id=fef`). Locale-dependent by construction — this whole pack is Indonesian UI-first, exactly like
 * `dialogs.ts`'s `DENY_SELECTORS` already is. Plan 86 §3.3 is why that is safe: row 0 is treated as
 * the current account unconditionally regardless of what this marker says, so a wrong or absent
 * reading degrades every caller from "confirmed" to "assumed", never into a wrong tap.
 */
export const CHECKMARK_DESC = 'Tanda centang'

const MAX_SETTINGS_SCROLLS = 4 // measured on hardware to reach "Beralih akun" from the top — plan 86 §4.2, row A4
export const MAX_SHEET_SCROLL_ATTEMPTS = 5 // bounded — plan 86 §4.3; an account list this pack has never seen ships untested (§7.4)

// ---------------------------------------------------------------------------------------------
// Pure logic — no ScriptContext, no device. This is the surface `sheet.test.ts` exercises directly.
// ---------------------------------------------------------------------------------------------

export interface SheetRow {
  desc: string
  bounds: Bounds
  hasCheckmark: boolean
}

export interface SheetSnapshot {
  sheetBounds: Bounds
  /** In visual (dump) order, "Tambah akun" already dropped — it is never a target (plan 86 §3, §6.8). */
  rows: SheetRow[]
}

/**
 * Reads one dump of the switch-account sheet into the shape the rest of this pack works with.
 * `rowsById` + `within` (`tree.ts`) is the whole answer to plan 86 §0.1: enumerate every row sharing
 * `id=l_z`, then keep only the ones fully inside the sheet's own box — a row the RecyclerView is
 * still clipping at the edge is not safely tappable, even if the accessibility tree already reports
 * it. `null` means the sheet anchor is not in this tree at all (the caller has usually just waited
 * for it, so this is a genuine "it vanished between the wait and the dump", not an ordinary miss).
 */
export function readSheetSnapshot(tree: UiNode): SheetSnapshot | null {
  const sheetNode = all(tree, (n) => n.desc === SHEET_DESC)[0]
  if (!sheetNode) return null
  const rows = rowsById(sheetNode, ROW_SHORT_ID)
    .filter((r) => within(sheetNode.bounds, r.bounds))
    .filter((r) => r.desc !== TAMBAH_AKUN_DESC)
    .map((r) => ({ desc: r.desc, bounds: r.bounds, hasCheckmark: all(r, (n) => n.desc === CHECKMARK_DESC).length > 0 }))
  return { sheetBounds: sheetNode.bounds, rows }
}

/**
 * Index of the row carrying the current-account checkmark, or `null` when none was found. Callers
 * NEVER use this to pick which row is current — row 0 always is (plan 86 §3.3) — this exists only so
 * a caller can warn when the cross-check disagrees with that assumption, or report that it could not
 * read it at all.
 */
export function detectCurrentIndex(rows: SheetRow[]): number | null {
  const idx = rows.findIndex((r) => r.hasCheckmark)
  return idx === -1 ? null : idx
}

// ---------------------------------------------------------------------------------------------
// Device-facing helpers.
// ---------------------------------------------------------------------------------------------

/**
 * Every navigation step asserts on its anchor (plan 86 §3.6) instead of hoping a tap landed. One
 * timeout is treated as an ordinary hiccup — an animation still finishing, a slow cold start — and
 * gets exactly one `clearBlockingDialog` sweep (shared with `auto-scroll`; no second dialog
 * mechanism, per plan 86 §4.7) and one retry. A second miss means the caller cannot prove where the
 * device actually is, and reporting success from there would be the exact silent-failure mode plan
 * 85 was written to eliminate — so it fails loudly instead, with a screenshot artifact named after
 * the member that was walking (`artifactPrefix`), so two members' failures never share one filename.
 *
 * `allowBack: false` on every call here — this is the plan 86 hardware run-2 root-cause fix, not
 * the plan's original design. Measured on hardware (see `clearBlockingDialog`'s own comment for the
 * full evidence): the actual trigger for "anchor did not appear" was, both times it was caught in
 * the act, the ui-server inspector going briefly unresponsive — never a real dialog, and never the
 * device actually having left the intended screen. `auto-scroll` lives entirely on the feed, so
 * `clearBlockingDialog`'s BACK fallback is harmless there (nowhere to navigate back FROM other than
 * the feed itself). This walk is five linear screens — BACK is a real navigation action on every one
 * of them, undoing whatever step got it there. Pressing it on a false "not found" (the inspector
 * being deaf, not the UI being wrong) can only ever make things worse: it cannot fix an inspector
 * outage, and it can absolutely discard real, correct progress. Failing loudly with a screenshot —
 * which this function already does, on the SECOND miss — is strictly better than a blind guess for a
 * script whose entire job is proving which screen the device is on.
 */
export async function waitForAnchor(
  ctx: ScriptContext<unknown>,
  artifactPrefix: string,
  label: string,
  sel: Selector,
  opts?: WaitForOptions,
): Promise<UiNode> {
  try {
    return await ctx.device.waitFor(sel, opts)
  } catch {
    ctx.log.warn(`anchor "${label}" did not appear — sweeping for a blocking dialog once`, { selector: JSON.stringify(sel) })
    await clearBlockingDialog(ctx, { allowBack: false })
    await sleep(1_500)
    try {
      return await ctx.device.waitFor(sel, opts)
    } catch {
      const artifactLabel = `${artifactPrefix}-missing-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
      await ctx.artifact.screenshot(artifactLabel)
      throw Object.assign(
        new Error(`the "${label}" anchor never appeared, even after a dialog sweep — cannot confirm where the device actually is`),
        { code: 'E_ANCHOR_NOT_FOUND' },
      )
    }
  }
}

/**
 * Settings has no scrollable flag (plan 86 §0.4, like everywhere else in this app), so reaching
 * "Beralih akun" is a fixed number of blind gesture-scrolls, measured on hardware at 4 (§4.2, row
 * A4). Checking with a plain `find` before each one — safe here, since this desc is verified unique
 * on the Settings screen, unlike the sheet's own rows — stops as soon as it is visible instead of
 * always paying for all 4, and costs nothing when it is not.
 */
async function scrollToRevealBeralihAkun(ctx: ScriptContext<unknown>): Promise<void> {
  for (let i = 0; i < MAX_SETTINGS_SCROLLS; i++) {
    if (await ctx.device.find(BERALIH_AKUN)) return
    await ctx.device.scroll({ direction: 'down' })
    await sleep(400)
  }
}

/**
 * A drag confined to the sheet's own measured `y` range, never the screen behind it (plan 86 §4.3).
 * The margin keeps both touch points off the sheet's top handle and its bottom edge, which matters
 * because a swipe starting outside a bottom sheet in this app can dismiss it or reach the Settings
 * page underneath instead of scrolling the list.
 */
async function scrollSheet(ctx: ScriptContext<unknown>, sheetBounds: Bounds): Promise<void> {
  const margin = Math.round((sheetBounds.bottom - sheetBounds.top) * 0.12)
  const x = Math.round((sheetBounds.left + sheetBounds.right) / 2)
  const startY = sheetBounds.bottom - margin
  const endY = sheetBounds.top + margin
  await ctx.device.swipe({ x, y: startY }, { x, y: endY }, 260, { easing: 'easeInOutCubic' })
}

/**
 * Home feed → Profil → Menu profil → Pengaturan dan privasi → Beralih akun → the sheet is open
 * (plan 86 §4.2, rows A1–A6). Every step asserts on its own anchor before the next tap, so a member
 * that returns from here has PROVEN the sheet is on screen rather than assumed it.
 */
export async function openSwitchAccountSheet(ctx: ScriptContext<unknown>, artifactPrefix: string): Promise<void> {
  const profilNode = await waitForAnchor(ctx, artifactPrefix, 'home feed (Profil tab)', PROFIL_TAB, { timeout: 20_000 })
  await ctx.device.tap({ point: centerOf(profilNode.bounds) })

  const hamburgerNode = await waitForAnchor(ctx, artifactPrefix, 'profile screen (hamburger)', MENU_PROFIL)
  await ctx.device.tap({ point: centerOf(hamburgerNode.bounds) })

  const settingsRowNode = await waitForAnchor(ctx, artifactPrefix, 'profile drawer (Pengaturan dan privasi)', SETTINGS_ROW)
  await ctx.device.tap({ point: centerOf(settingsRowNode.bounds) })

  // Settings has no anchor of its own confirming "you are on this screen" — "Beralih akun" doubles
  // as both the scroll target and that confirmation, since it is verified unique screen-wide
  // (plan 86 §4.2, row A5).
  await scrollToRevealBeralihAkun(ctx)
  const beralihNode = await waitForAnchor(ctx, artifactPrefix, 'Beralih akun row', BERALIH_AKUN)
  // The dumped bounds centre, never a screen fraction (plan 86 §0.6): "Keluar" (log out) sits 98px
  // directly below this row with no gap. A tap aimed at a fraction of the screen instead of this
  // node's own measured box is how an account gets logged out by accident.
  await ctx.device.tap({ point: centerOf(beralihNode.bounds) })

  await waitForAnchor(ctx, artifactPrefix, 'switch-account sheet', SHEET_ANCHOR)
}

/** One dump of the sheet, as `scanSheet` hands it to its caller. */
export interface SheetScanPass {
  /** Every distinct row seen across every dump SO FAR, in the order first seen. */
  rows: SheetRow[]
  /** The rows this dump added to `rows` — empty means this pass revealed nothing new. */
  added: SheetRow[]
  /** 0-based. */
  attempt: number
  /** True on the final pass: `onPass` must return a value or throw, because there is no next scroll. */
  isLast: boolean
}

/**
 * Dumps the sheet, hands what has been seen so far to `onPass`, and — when `onPass` answers `null`,
 * meaning "not done yet" — scrolls bounded to the sheet's own box and dumps again (plan 86 §4.3's
 * in-sheet scrolling).
 *
 * Rows are merged across dumps by `desc` (append-only, in first-seen order) rather than re-indexed
 * from each dump's visible subset, because a `RecyclerView` recycles rows out of the tree as they
 * scroll off — indexing into "whatever is visible now" would silently renumber every position after
 * the first scroll. That merge is the single most subtle thing in this file, which is exactly why
 * both members share this one implementation of it instead of each writing their own.
 *
 * `onPass` is the ONLY thing that differs between the two members: `switch-account` returns as soon
 * as its target resolves, `list-accounts` returns once a pass adds nothing new. Neither ever taps
 * from in here — this function scrolls and reads, nothing else.
 */
export async function scanSheet<T>(
  ctx: ScriptContext<unknown>,
  artifactPrefix: string,
  onPass: (pass: SheetScanPass) => T | null | Promise<T | null>,
): Promise<T> {
  const ordered: SheetRow[] = []
  const seenDescs = new Set<string>()

  for (let attempt = 0; attempt <= MAX_SHEET_SCROLL_ATTEMPTS; attempt++) {
    const tree = await ctx.device.dump()
    const snap = readSheetSnapshot(tree)
    if (!snap) {
      await ctx.artifact.screenshot(`${artifactPrefix}-sheet-vanished`)
      throw Object.assign(new Error('the switch-account sheet anchor was confirmed by waitFor but is missing from the dump'), { code: 'E_ANCHOR_NOT_FOUND' })
    }

    const added: SheetRow[] = []
    for (const row of snap.rows) {
      if (!seenDescs.has(row.desc)) {
        seenDescs.add(row.desc)
        ordered.push(row)
        added.push(row)
      }
    }

    if (attempt === 0) {
      // A cross-check, not the safety mechanism (plan 86 §3.3, §8) — logged, never thrown.
      const checkmarkIndex = detectCurrentIndex(ordered)
      if (checkmarkIndex === null) {
        ctx.log.warn('no current-account checkmark ("Tanda centang") found in the switch-account sheet — assuming the first row is current')
      } else if (checkmarkIndex !== 0) {
        ctx.log.warn('the current-account checkmark was on a row other than the first — still treating the first row as current', { checkmarkIndex })
      }
    }

    const outcome = await onPass({ rows: ordered, added, attempt, isLast: attempt === MAX_SHEET_SCROLL_ATTEMPTS })
    if (outcome !== null) return outcome

    await scrollSheet(ctx, snap.sheetBounds)
    await sleep(500)
  }

  // Unreachable: `onPass` is contractually required to return a value or throw on its last pass.
  throw Object.assign(new Error('sheet scan loop exited without a result'), { code: 'E_INTERNAL' })
}
