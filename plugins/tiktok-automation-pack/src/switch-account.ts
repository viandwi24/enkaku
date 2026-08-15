import type { PluginMemberScript, ScriptContext, WaitForOptions } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { Bounds, Selector, UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { sleep } from './human'
import { clearBlockingDialog } from './dialogs'
import { all, centerOf, rowsById, within } from './tree'

/**
 * Moves the device to a different logged-in TikTok account, by list position or by username, and
 * PROVES it landed there before reporting success (plan 86 §1, §4.3). Built entirely on dump-and-walk
 * (`tree.ts`) rather than `find()` for the switch-account sheet, because three rows on that sheet
 * share `id=l_z` and `find()` cannot tell a script that — it just answers with row 0 every time
 * (plan 86 §0.1).
 */

const TIKTOK_PACKAGE = 'com.ss.android.ugc.trill'

// Selectors verified unique screen-wide against the reference device (plan 86 §4.2) — every one of
// these is safe to `find`/`waitFor` directly, unlike the sheet's own rows (§0.1) or `desc:"Cari"`
// (§0.2, out of scope here — that trap belongs to the search flow, not this one).
const PROFIL_TAB: Selector = { desc: 'Profil' }
const MENU_PROFIL: Selector = { desc: 'Menu profil' }
const SETTINGS_ROW: Selector = { desc: 'Pengaturan dan privasi' }
const BERALIH_AKUN: Selector = { desc: 'Beralih akun' }
const SHEET_ANCHOR: Selector = { desc: 'Lembar bawah' }

// The sheet row container's shared resource id (plan 86 §4.2) — never a selector on its own; only
// ever fed to `rowsById`.
const ROW_SHORT_ID = 'l_z'
const TAMBAH_AKUN_DESC = 'Tambah akun'

/**
 * Indonesian TalkBack's label for the current-account checkmark (plan 86 §4.2's sheet dump, node
 * `id=fef`). Locale-dependent by construction — this whole pack is Indonesian UI-first, exactly like
 * `dialogs.ts`'s `DENY_SELECTORS` already is. §3.3 is why that is safe: position 1 is refused
 * unconditionally regardless of what this marker says, so a wrong or absent reading degrades this
 * check from "confirmed" to "assumed", never into a wrong tap.
 */
const CHECKMARK_DESC = 'Tanda centang'

const MAX_SETTINGS_SCROLLS = 4 // measured on hardware to reach "Beralih akun" from the top — plan 86 §4.2, row A4
const MAX_SHEET_SCROLL_ATTEMPTS = 5 // bounded — plan 86 §4.3; an account list this pack has never seen ships untested (§7.4)

// ---------------------------------------------------------------------------------------------
// Pure logic — no ScriptContext, no device. This is the surface the unit tests exercise directly
// (plan 86 §7.1); everything below the `run()`/`prepare()`/`finish()` section wires it to a device.
// ---------------------------------------------------------------------------------------------

export type ParsedTarget = { kind: 'position'; position: number } | { kind: 'username'; username: string }

/**
 * What "I did not specify a target" means: the first account that is not the one already signed in.
 *
 * Position 2 is the only defensible default. Position 1 is the current account (plan §3.3), and no
 * username could be a default without guessing at somebody's account list.
 */
export const DEFAULT_TARGET = '2'

/**
 * `target` is one plain string, not a `z.union` and not a second field — plan 86 §3.2 rejects both
 * alternatives on this pack's own history: `commentProbe` was an enum whose default the run form
 * failed to apply, so pressing Run with nothing touched submitted an empty string and the job died
 * on a validation error before doing anything.
 *
 * That history is also why a blank target resolves to `DEFAULT_TARGET` here rather than being
 * rejected, which is what this function did first. `.default()` in the schema only fires when the
 * key is ABSENT; the run form's observed behaviour is to submit `""` for a field nobody touched, so
 * a schema default alone would not have covered the very case it exists for. Rejecting a blank with
 * a tidy coded error is still a job that dies before doing anything — a better error message for a
 * failure that should not happen at all.
 *
 * `/^\d+$/` after trimming means "list position"; anything else means "username" (plan §3.2).
 * Position 1 is rejected here, independent of the device, because it is true of every account list
 * this script will ever see: position 1 is always the currently signed-in account (plan §3.3).
 */
export function parseTarget(raw: string): ParsedTarget {
  const trimmed = raw.trim() === '' ? DEFAULT_TARGET : raw.trim()
  if (/^\d+$/.test(trimmed)) {
    const position = Number.parseInt(trimmed, 10)
    if (position === 1) {
      // The safety mechanism (plan §3.3), not the checkmark below — this check needs no dump, no
      // find, and no locale to be correct.
      throw Object.assign(new Error('position 1 is the currently signed-in account — nothing to switch to'), { code: 'E_TARGET_IS_CURRENT' })
    }
    return { kind: 'position', position }
  }
  return { kind: 'username', username: trimmed }
}

export interface SwitchAccountRow {
  desc: string
  bounds: Bounds
  hasCheckmark: boolean
}

export interface SheetSnapshot {
  sheetBounds: Bounds
  /** In visual (dump) order, "Tambah akun" already dropped — it is never a target (plan §3, §6.8). */
  rows: SwitchAccountRow[]
}

/**
 * Reads one dump of the switch-account sheet into the shape the rest of this file works with.
 * `rowsById` + `within` (`tree.ts`) is the whole answer to §0.1: enumerate every row sharing
 * `id=l_z`, then keep only the ones fully inside the sheet's own box — a row the RecyclerView is
 * still clipping at the edge is not safely tappable, even if the accessibility tree already reports
 * it. `null` means the sheet anchor is not in this tree at all (the caller has usually just waited
 * for it, so this is a genuine "it vanished between the wait and the dump", not an ordinary miss).
 */
export function readSheetSnapshot(tree: UiNode): SheetSnapshot | null {
  const sheetNode = all(tree, (n) => n.desc === 'Lembar bawah')[0]
  if (!sheetNode) return null
  const rows = rowsById(sheetNode, ROW_SHORT_ID)
    .filter((r) => within(sheetNode.bounds, r.bounds))
    .filter((r) => r.desc !== TAMBAH_AKUN_DESC)
    .map((r) => ({ desc: r.desc, bounds: r.bounds, hasCheckmark: all(r, (n) => n.desc === CHECKMARK_DESC).length > 0 }))
  return { sheetBounds: sheetNode.bounds, rows }
}

/**
 * Index of the row carrying the current-account checkmark, or `null` when none was found. Callers
 * NEVER use this to pick which row is current — row 0 always is (plan §3.3) — this exists only so a
 * caller can warn when the cross-check disagrees with that assumption or cannot read it at all.
 */
export function detectCurrentIndex(rows: SwitchAccountRow[]): number | null {
  const idx = rows.findIndex((r) => r.hasCheckmark)
  return idx === -1 ? null : idx
}

/**
 * Resolves a parsed target against the rows observed so far. `rows[0]` is always "current" (§3.3);
 * a position indexes into this exact array (1-based, `Tambah akun` already excluded — this is what
 * makes it unreachable by position, not a separate check), and a username matches case-insensitively
 * against each row's `desc`, which is the row's own unique username (plan §4.2).
 */
export function resolveTargetRow(target: ParsedTarget, rows: SwitchAccountRow[]): SwitchAccountRow {
  if (target.kind === 'position') {
    const row = rows[target.position - 1]
    if (!row) {
      throw Object.assign(
        new Error(`position ${target.position} was requested but only ${rows.length} account(s) were found: ${rows.map((r) => r.desc).join(', ') || '(none)'}`),
        { code: 'E_NO_SUCH_ACCOUNT' },
      )
    }
    return row
  }
  const wanted = target.username.toLowerCase()
  const match = rows.find((r) => r.desc.toLowerCase() === wanted)
  if (!match) {
    throw Object.assign(
      new Error(`no account named "${target.username}" — accounts found: ${rows.map((r) => r.desc).join(', ') || '(none)'}`),
      { code: 'E_NO_SUCH_ACCOUNT' },
    )
  }
  if (match === rows[0]) {
    throw Object.assign(new Error(`"${target.username}" is the currently signed-in account — nothing to switch to`), { code: 'E_TARGET_IS_CURRENT' })
  }
  return match
}

function isErrorCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === code
}

/**
 * True when `tree` (a dump of the OWN profile screen) shows `handle` actually landed, AND the
 * switch-account sheet is confirmed gone.
 *
 * Two things this closes, both found on hardware, not assumed:
 *
 * 1. **The own-handle selector gap plan §4.2/§4.5 left open.** Neither section gives a verified
 *    selector for one's OWN profile handle (only for someone else's, reached through search — a
 *    different flow). Read by hand off the live device: `id=sd0 text="dewi_purnama280"` (the DISPLAY
 *    NAME) sits above `id=s_y text="@dewi_purnama280"` (the actual handle, "@"-prefixed). Both ids
 *    are obfuscated three-character names this app rotates between builds, so this keys off the
 *    "@"-prefixed TEXT, never either id. Matching the BARE username (no "@") against the whole tree,
 *    as the pre-fix code did, depends on a display name being set at all: `user2578127329501` has
 *    none (its profile shows "+ Tambah nama" instead), so the bare string never appears anywhere on
 *    that account's own profile screen — only the "@"-prefixed handle does. Reproduced on hardware
 *    (2026-08-09): a switch that plainly landed — the profile screen showed "@user2578127329501" —
 *    was reported `E_SWITCH_NOT_VERIFIED` by the old bare-text check, a false failure on a real
 *    success, not a hypothetical.
 * 2. **A still-open sheet must never read as a landed switch.** The switch-account sheet's own rows
 *    (plan §4.2's dump) list every account's username verbatim — including the target's — so a bare
 *    "is this string anywhere on screen" check can be satisfied by the sheet never having closed at
 *    all. Checking `SHEET_ANCHOR` is absent is the other half of "prove it landed", not an
 *    afterthought: text matching alone cannot tell "landed on the profile" from "still one tap short
 *    of it".
 */
export function ownProfileShowsHandle(tree: UiNode, handle: string): boolean {
  const wantedHandle = `@${handle.trim()}`.toLowerCase()
  const handleFound = all(tree, (n) => n.text.trim().toLowerCase() === wantedHandle).length > 0
  const sheetStillOpen = all(tree, (n) => n.desc === 'Lembar bawah').length > 0
  return handleFound && !sheetStillOpen
}

// ---------------------------------------------------------------------------------------------
// Device-facing helpers.
// ---------------------------------------------------------------------------------------------

/**
 * Every navigation step asserts on its anchor (plan §3.6) instead of hoping a tap landed. One
 * timeout is treated as an ordinary hiccup — an animation still finishing, a slow cold start — and
 * gets exactly one `clearBlockingDialog` sweep (shared with `auto-scroll`; no second dialog
 * mechanism, per plan §4.7) and one retry. A second miss means this script cannot prove where the
 * device actually is, and reporting success from there would be the exact silent-failure mode plan
 * 85 was written to eliminate — so it fails loudly instead, with a screenshot artifact.
 *
 * `allowBack: false` on every call here — this is the plan 86 hardware run-2 root-cause fix, not
 * the plan's original design. Measured on hardware (see `clearBlockingDialog`'s own comment for the
 * full evidence): the actual trigger for "anchor did not appear" was, both times it was caught in
 * the act, the ui-server inspector going briefly unresponsive — never a real dialog, and never the
 * device actually having left the intended screen. `auto-scroll` lives entirely on the feed, so
 * `clearBlockingDialog`'s BACK fallback is harmless there (nowhere to navigate back FROM other than
 * the feed itself). This script is a five-screen linear walk — BACK is a real navigation action on
 * every one of those screens, undoing whatever step got it there. Pressing it on a false "not found"
 * (the inspector being deaf, not the UI being wrong) can only ever make things worse: it cannot fix
 * an inspector outage, and it can absolutely discard real, correct progress. Failing loudly with a
 * screenshot — which this function already does one level up, on the SECOND miss — is strictly
 * better than a blind guess for a script whose entire job is proving which screen the device is on.
 */
async function waitForAnchor(ctx: ScriptContext<unknown>, label: string, sel: Selector, opts?: WaitForOptions): Promise<UiNode> {
  try {
    return await ctx.device.waitFor(sel, opts)
  } catch {
    ctx.log.warn(`anchor "${label}" did not appear — sweeping for a blocking dialog once`, { selector: JSON.stringify(sel) })
    await clearBlockingDialog(ctx, { allowBack: false })
    await sleep(1_500)
    try {
      return await ctx.device.waitFor(sel, opts)
    } catch {
      const artifactLabel = `switch-account-missing-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
      await ctx.artifact.screenshot(artifactLabel)
      throw Object.assign(
        new Error(`the "${label}" anchor never appeared, even after a dialog sweep — cannot confirm where the device actually is`),
        { code: 'E_ANCHOR_NOT_FOUND' },
      )
    }
  }
}

/**
 * Settings has no scrollable flag (plan §0.4, like everywhere else in this app), so reaching
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
 * A drag confined to the sheet's own measured `y` range, never the screen behind it (plan §4.3). The
 * margin keeps both touch points off the sheet's top handle and its bottom edge, which matters
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

interface SheetResolution {
  current: SwitchAccountRow
  target: SwitchAccountRow
  /** Every distinct username observed across every dump, in the order first seen — for `E_NO_SUCH_ACCOUNT` and the result object. */
  accounts: string[]
}

/**
 * Dumps the sheet, tries to resolve `target` against what is visible, and — only when the miss is
 * "not on screen yet", never "this is genuinely the current account" — scrolls bounded to the
 * sheet's own box and tries again (plan §4.3's in-sheet scrolling). Rows are merged across dumps by
 * `desc` (append-only, in first-seen order) rather than re-indexed from each dump's visible subset,
 * because a `RecyclerView` recycles rows out of the tree as they scroll off — indexing into
 * "whatever is visible now" would silently renumber every position after the first scroll.
 */
async function resolveTargetInSheet(ctx: ScriptContext<unknown>, target: ParsedTarget): Promise<SheetResolution> {
  const ordered: SwitchAccountRow[] = []
  const seenDescs = new Set<string>()

  for (let attempt = 0; attempt <= MAX_SHEET_SCROLL_ATTEMPTS; attempt++) {
    const tree = await ctx.device.dump()
    const snap = readSheetSnapshot(tree)
    if (!snap) {
      await ctx.artifact.screenshot('switch-account-sheet-vanished')
      throw Object.assign(new Error('the switch-account sheet anchor was confirmed by waitFor but is missing from the dump'), { code: 'E_ANCHOR_NOT_FOUND' })
    }

    for (const row of snap.rows) {
      if (!seenDescs.has(row.desc)) {
        seenDescs.add(row.desc)
        ordered.push(row)
      }
    }

    if (attempt === 0) {
      // A cross-check, not the safety mechanism (plan §3.3, §8) — logged, never thrown.
      const checkmarkIndex = detectCurrentIndex(ordered)
      if (checkmarkIndex === null) {
        ctx.log.warn('no current-account checkmark ("Tanda centang") found in the switch-account sheet — assuming the first row is current')
      } else if (checkmarkIndex !== 0) {
        ctx.log.warn('the current-account checkmark was on a row other than the first — still treating the first row as current', { checkmarkIndex })
      }
    }

    const current = ordered[0]
    if (current) {
      try {
        const row = resolveTargetRow(target, ordered)
        return { current, target: row, accounts: ordered.map((r) => r.desc) }
      } catch (err) {
        // "This IS the current account" is never fixed by scrolling — it is a fact about row 0,
        // which the very first dump already established. Only a genuine not-yet-visible miss earns
        // another attempt.
        if (isErrorCode(err, 'E_TARGET_IS_CURRENT')) throw err
        if (attempt === MAX_SHEET_SCROLL_ATTEMPTS) {
          throw Object.assign(
            new Error(`no matching account after scrolling the sheet ${MAX_SHEET_SCROLL_ATTEMPTS} times — accounts seen: ${ordered.map((r) => r.desc).join(', ') || '(none)'}`),
            { code: 'E_NO_SUCH_ACCOUNT' },
          )
        }
      }
    } else if (attempt === MAX_SHEET_SCROLL_ATTEMPTS) {
      throw Object.assign(new Error('the switch-account sheet listed no accounts at all'), { code: 'E_NO_SUCH_ACCOUNT' })
    }

    await scrollSheet(ctx, snap.sheetBounds)
    await sleep(500)
  }

  // Unreachable: the loop above always returns or throws on its last iteration.
  throw Object.assign(new Error('sheet resolution loop exited without a result'), { code: 'E_INTERNAL' })
}

const paramsSchema = z.object({
  target: z
    .string()
    // Every `auto-scroll` parameter carries a default; this one was the odd exception, so pressing
    // Run without typing anything killed the job on a validation error. See `parseTarget` for why
    // the blank case is ALSO handled there and not by this default alone.
    .default(DEFAULT_TARGET)
    .describe(
      'List position (2, 3, …) or username of the account to switch to. Leave empty to switch to position 2. Position 1 — the currently signed-in account — and "Tambah akun" are never valid targets.',
    )
    .meta({ title: 'Target account' }),
})

// Plan 97 §3.2, §4.2, §5 step 97.8 — what `run()` actually returns
// (`:427-433`), typed the same way `paramsSchema` above already is:
// `kind`/`unit` on the one field that is genuinely a count, `summary: true`
// on the two fields an operator reads first off a job list row.
const resultSchema = z.object({
  from: z.string().describe('The account handle the switch started from.').meta(ui({ title: 'Switched from' })),
  to: z
    .string()
    .describe('The account handle the switch landed on, verified by re-reading the own-profile screen.')
    .meta(ui({ title: 'Switched to', summary: true })),
  position: z
    .number()
    .int()
    .describe("The target account's 1-based position in the switch-account sheet.")
    .meta(ui({ title: 'Sheet position', kind: 'count' })),
  accounts: z
    .array(z.string())
    .describe('Every account handle visible in the switch-account sheet, in the order they were listed.')
    .meta(ui({ title: 'Accounts in sheet' })),
  verified: z
    .boolean()
    .describe('Whether the own-profile handle after the switch matched the target — this run never reports success otherwise.')
    .meta(ui({ title: 'Verified', summary: true })),
})

const switchAccountScript: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'switch-account',
  title: 'Switch account',
  result: resultSchema,
  description: 'Switches to another logged-in TikTok account, by list position or by username, and verifies the switch landed before reporting success.',
  params: paramsSchema,
  // Generous relative to how few steps this script has: most of the budget is slack for dialog
  // sweeps and the (untested — plan §7.4) in-sheet scroll path, not for any single step being slow.
  timeout: 5 * 60_000,

  async prepare(ctx) {
    await ctx.device.app.forceStop(TIKTOK_PACKAGE)
    await ctx.device.app.launch(TIKTOK_PACKAGE)
    // Mirrors `relaunch()` in `index.ts` (auto-scroll uses the same pause for the same reason): let
    // the launch storm settle before the run's own anchor wait starts polling into it.
    await sleep(4_000)
  },

  async run(ctx) {
    // Parsed and validated before a single tap happens — an invalid target (empty, or position 1)
    // fails here, before any navigation, so criterion "changes nothing on the device" holds for the
    // account itself (this script's `prepare` already relaunched the app, which is ordinary job
    // hygiene, not an account-level change).
    const target = parseTarget(ctx.params.target)

    const profilNode = await waitForAnchor(ctx, 'home feed (Profil tab)', PROFIL_TAB, { timeout: 20_000 })
    await ctx.device.tap({ point: centerOf(profilNode.bounds) })

    const hamburgerNode = await waitForAnchor(ctx, 'profile screen (hamburger)', MENU_PROFIL)
    await ctx.device.tap({ point: centerOf(hamburgerNode.bounds) })

    const settingsRowNode = await waitForAnchor(ctx, 'profile drawer (Pengaturan dan privasi)', SETTINGS_ROW)
    await ctx.device.tap({ point: centerOf(settingsRowNode.bounds) })

    // Settings has no anchor of its own confirming "you are on this screen" — "Beralih akun" doubles
    // as both the scroll target and that confirmation, since it is verified unique screen-wide
    // (plan §4.2, row A5).
    await scrollToRevealBeralihAkun(ctx)
    const beralihNode = await waitForAnchor(ctx, 'Beralih akun row', BERALIH_AKUN)
    // The dumped bounds centre, never a screen fraction (plan §0.6): "Keluar" (log out) sits 98px
    // directly below this row with no gap. A tap aimed at a fraction of the screen instead of this
    // node's own measured box is how an account gets logged out by accident.
    await ctx.device.tap({ point: centerOf(beralihNode.bounds) })

    await waitForAnchor(ctx, 'switch-account sheet', SHEET_ANCHOR)

    const { current, target: targetRow, accounts } = await resolveTargetInSheet(ctx, target)

    ctx.log.info('switching account', { from: current.desc, to: targetRow.desc })
    await ctx.device.tap({ point: centerOf(targetRow.bounds) })

    const feedNode = await waitForAnchor(ctx, 'home feed after switch', PROFIL_TAB, { timeout: 20_000 })
    await ctx.device.tap({ point: centerOf(feedNode.bounds) })
    await waitForAnchor(ctx, 'profile screen (verify pass)', MENU_PROFIL)

    // Verify the switch actually landed: read the profile screen and confirm the target's OWN handle
    // is there, AND that the switch-account sheet is gone (`ownProfileShowsHandle` — see its own
    // comment for the two hardware-measured gaps this closes). Fails CLOSED: no match is reported as
    // a verification failure, never as a success (plan §3.6).
    const profileTree = await ctx.device.dump()

    if (!ownProfileShowsHandle(profileTree, targetRow.desc)) {
      await ctx.artifact.screenshot('switch-account-verify-mismatch')
      throw Object.assign(
        new Error(`switched, but could not find "@${targetRow.desc}" as the OWN profile handle afterwards (or the switch-account sheet was still open) — the switch may not have landed on the requested account`),
        { code: 'E_SWITCH_NOT_VERIFIED' },
      )
    }

    ctx.log.info('account switch verified', { from: current.desc, to: targetRow.desc })

    return {
      from: current.desc,
      to: targetRow.desc,
      position: accounts.indexOf(targetRow.desc) + 1,
      accounts,
      verified: true,
    }
  },

  /**
   * Stateless and idempotent (plan §3.5) — it may run again in a fresh process after a timeout kill,
   * and `forceStop` on an already-stopped package is a no-op. It deliberately does NOT try to switch
   * back to whichever account the job started on: unlike `auto-scroll`, a completed account switch is
   * meant to OUTLIVE the job that made it (§3.5) — reverting it here would make the script pointless,
   * and a "revert" step could not itself be idempotent, since a second `finish()` run has no way to
   * know whether the first one already reverted.
   */
  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('switch-account-failed')
    await ctx.device.app.forceStop(TIKTOK_PACKAGE, { clearRecents: true })
  },
}

export default switchAccountScript
