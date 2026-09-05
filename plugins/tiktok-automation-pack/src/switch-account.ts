import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { sleep } from './human'
import { all, centerOf } from './tree'
import { ACCOUNTS_KEY, AccountsSchema, storedPositionOf, type StoredAccounts } from './accounts'
import {
  MAX_SHEET_SCROLL_ATTEMPTS,
  MENU_PROFIL,
  PROFIL_TAB,
  SHEET_DESC,
  TIKTOK_PACKAGE,
  openSwitchAccountSheet,
  scanSheet,
  waitForAnchor,
  type SheetRow,
} from './sheet'

/**
 * Moves the device to a different logged-in TikTok account, by list position or by username, and
 * PROVES it landed there before reporting success (plan 86 §1, §4.3).
 *
 * The five-screen walk to the switch-account sheet, and the dump-and-walk reading of its rows, live
 * in `sheet.ts` — shared verbatim with `list-accounts` (plan 108 step 108.11). What stays here is
 * what only a SWITCH needs: parsing a target, resolving it to a row, tapping it, and verifying the
 * device actually landed on it.
 */

/** Names every screenshot artifact this member writes, so a failed run says which member failed. */
const ARTIFACT_PREFIX = 'switch-account'

// The sheet primitives are re-exported so `switch-account.test.ts` — and anything else that already
// imports them from here — keeps working against exactly the code it always did. There is one
// implementation (`sheet.ts`); these are names for it, not a second copy.
export { detectCurrentIndex, readSheetSnapshot } from './sheet'
export type { SheetSnapshot } from './sheet'
/** @deprecated the sheet's row shape is `SheetRow` in `sheet.ts` now — this alias keeps older imports compiling. */
export type SwitchAccountRow = SheetRow

// ---------------------------------------------------------------------------------------------
// Pure logic — no ScriptContext, no device. This is the surface the unit tests exercise directly
// (plan 86 §7.1); everything below the `run()`/`prepare()`/`finish()` section wires it to a device.
// ---------------------------------------------------------------------------------------------

export type ParsedTarget = { kind: 'position'; position: number } | { kind: 'username'; username: string }

/**
 * What "I did not specify a target" means: the first account that is not the one already signed in.
 *
 * Position 2 is the only defensible default. Position 1 is the current account (plan 86 §3.3), and
 * no username could be a default without guessing at somebody's account list.
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
 * `/^\d+$/` after trimming means "list position"; anything else means "username" (plan 86 §3.2).
 * Position 1 is rejected here, independent of the device, because it is true of every account list
 * this script will ever see: position 1 is always the currently signed-in account (plan 86 §3.3).
 */
export function parseTarget(raw: string): ParsedTarget {
  const trimmed = raw.trim() === '' ? DEFAULT_TARGET : raw.trim()
  if (/^\d+$/.test(trimmed)) {
    const position = Number.parseInt(trimmed, 10)
    if (position === 1) {
      // The safety mechanism (plan 86 §3.3), not the checkmark — this check needs no dump, no find,
      // and no locale to be correct.
      throw Object.assign(new Error('position 1 is the currently signed-in account — nothing to switch to'), { code: 'E_TARGET_IS_CURRENT' })
    }
    return { kind: 'position', position }
  }
  return { kind: 'username', username: trimmed }
}

/**
 * Resolves a parsed target against the rows observed so far. `rows[0]` is always "current" (plan 86
 * §3.3); a position indexes into this exact array (1-based, `Tambah akun` already excluded — this is
 * what makes it unreachable by position, not a separate check), and a username matches
 * case-insensitively against each row's `desc`, which is the row's own unique username (§4.2).
 *
 * `storedPosition` is what `list-accounts` last wrote for this username (plan 108 step 108.11) — a
 * SHORT-CUT, never an override. The row it names is accepted only when that row's own `desc` still
 * IS the wanted username; otherwise the live sheet decides, exactly as it did before there was a
 * stored list at all. That check is not defensive padding: an account list changes whenever an
 * account is added, removed, or switched, so a stored slot number is a claim about a moment that has
 * already passed, and a tap aimed at a stale slot lands on whoever occupies it now. The username
 * read off the live row is the only thing this pack ever treats as ground truth.
 */
export function resolveTargetRow(target: ParsedTarget, rows: SheetRow[], storedPosition: number | null = null): SheetRow {
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
  const hinted = storedPosition === null ? undefined : rows[storedPosition - 1]
  const match = hinted !== undefined && hinted.desc.toLowerCase() === wanted ? hinted : rows.find((r) => r.desc.toLowerCase() === wanted)
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

/**
 * True when the stored list pointed at a row that is no longer the wanted account — the list is
 * stale and the live sheet is about to decide instead. Pure, so the warning and the resolution
 * cannot disagree about when it fires.
 */
export function storedPositionIsStale(rows: SheetRow[], username: string, storedPosition: number | null): boolean {
  if (storedPosition === null) return false
  const row = rows[storedPosition - 1]
  return row === undefined || row.desc.toLowerCase() !== username.trim().toLowerCase()
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
 * 1. **The own-handle selector gap plan 86 §4.2/§4.5 left open.** Neither section gives a verified
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
 *    (plan 86 §4.2's dump) list every account's username verbatim — including the target's — so a
 *    bare "is this string anywhere on screen" check can be satisfied by the sheet never having
 *    closed at all. Checking the sheet's anchor is absent is the other half of "prove it landed",
 *    not an afterthought: text matching alone cannot tell "landed on the profile" from "still one
 *    tap short of it".
 */
export function ownProfileShowsHandle(tree: UiNode, handle: string): boolean {
  const wantedHandle = `@${handle.trim()}`.toLowerCase()
  const handleFound = all(tree, (n) => n.text.trim().toLowerCase() === wantedHandle).length > 0
  const sheetStillOpen = all(tree, (n) => n.desc === SHEET_DESC).length > 0
  return handleFound && !sheetStillOpen
}

// ---------------------------------------------------------------------------------------------
// Device-facing helpers.
// ---------------------------------------------------------------------------------------------

/**
 * What slot the stored account list says this username is in, or `null` when it cannot say — which
 * is every one of the four cases this member must survive without a stored list existing at all:
 * no entry for this device yet, an entry written in a shape this code no longer understands, a list
 * that simply does not name this username, and (upstream of here) a bare position target, which
 * never asks.
 *
 * The read is `ctx.kv.device.*`: a script can only ever reach its OWN device's scope, resolved
 * parent-side from the job (plan 108 §3.1, finding G4), and the namespace is the plugin's, which is
 * how `list-accounts`' write and this read meet without either naming one (G2).
 *
 * `get(key, schema)` THROWS on a shape mismatch rather than returning null, so the catch here is not
 * belt-and-braces — it is the stale-shape path, and its only correct behaviour is to fall back to
 * reading the device, never to fail a job that can still do its work.
 */
async function readStoredPosition(ctx: ScriptContext<unknown>, username: string): Promise<number | null> {
  let stored: StoredAccounts | null
  try {
    stored = await ctx.kv.device.get(ACCOUNTS_KEY, AccountsSchema)
  } catch (err) {
    ctx.log.warn('the stored account list is in a shape this script does not understand — reading the live sheet instead', { error: String(err) })
    return null
  }
  if (!stored) {
    ctx.log.info('no account list has been read on this device yet — reading the live sheet', { hint: 'run "List accounts" to store one' })
    return null
  }
  const position = storedPositionOf(stored, username)
  if (position === null) {
    ctx.log.info('the stored account list does not name this username — reading the live sheet', { username, storedAccounts: stored.accounts.length })
    return null
  }
  ctx.log.info('the stored account list names this username', { username, position, readAt: stored.readAt })
  return position
}

interface SheetResolution {
  current: SheetRow
  target: SheetRow
  /** Every distinct username observed across every dump, in the order first seen — for `E_NO_SUCH_ACCOUNT` and the result object. */
  accounts: string[]
}

/**
 * Walks the sheet through `scanSheet` (`sheet.ts`, which owns the dump/merge/scroll loop) and
 * resolves `target` against everything seen so far. Scrolling stops the moment the target resolves;
 * a miss earns another scroll ONLY when it is "not on screen yet" — "this is genuinely the current
 * account" is a fact about row 0 that the very first dump already established, and no amount of
 * scrolling changes it.
 */
async function resolveTargetInSheet(ctx: ScriptContext<unknown>, target: ParsedTarget, storedPosition: number | null): Promise<SheetResolution> {
  let staleWarned = false
  return scanSheet<SheetResolution>(ctx, ARTIFACT_PREFIX, ({ rows, isLast }) => {
    if (target.kind === 'username' && !staleWarned && storedPositionIsStale(rows, target.username, storedPosition)) {
      staleWarned = true
      ctx.log.warn('the stored account list no longer matches the sheet at that slot — falling back to matching the username against the live rows', {
        username: target.username,
        storedPosition,
      })
    }

    const current = rows[0]
    if (current) {
      try {
        const row = resolveTargetRow(target, rows, storedPosition)
        return { current, target: row, accounts: rows.map((r) => r.desc) }
      } catch (err) {
        if (isErrorCode(err, 'E_TARGET_IS_CURRENT')) throw err
        if (isLast) {
          throw Object.assign(
            new Error(`no matching account after scrolling the sheet ${MAX_SHEET_SCROLL_ATTEMPTS} times — accounts seen: ${rows.map((r) => r.desc).join(', ') || '(none)'}`),
            { code: 'E_NO_SUCH_ACCOUNT' },
          )
        }
      }
    } else if (isLast) {
      throw Object.assign(new Error('the switch-account sheet listed no accounts at all'), { code: 'E_NO_SUCH_ACCOUNT' })
    }
    return null
  })
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

// Plan 97 §3.2, §4.2, §5 step 97.8 — what `run()` actually returns, typed the
// same way `paramsSchema` above already is: `kind`/`unit` on the one field
// that is genuinely a count, `summary: true` on the two fields an operator
// reads first off a job list row.
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
  // Plan 303 §4.5 — presents this member as a workflow node; never changes how it executes.
  /** Plan 310 §3.3 — the script's own icon; `node.icon` (same value) stays as a fallback read for a core older than this plan. */
  icon: 'users',
  node: { category: 'device', icon: 'users', summary: ['target'], keywords: ['switch', 'account', 'login'] },
  params: paramsSchema,
  // Generous relative to how few steps this script has: most of the budget is slack for dialog
  // sweeps and the (untested — plan 86 §7.4) in-sheet scroll path, not for any single step being slow.
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

    // Read BEFORE any navigation: it costs one local KV read, it cannot fail the job (every failure
    // mode answers `null`), and having it in hand means the sheet walk below is identical whether or
    // not a list was ever stored.
    const storedPosition = target.kind === 'username' ? await readStoredPosition(ctx, target.username) : null

    await openSwitchAccountSheet(ctx, ARTIFACT_PREFIX)

    const { current, target: targetRow, accounts } = await resolveTargetInSheet(ctx, target, storedPosition)

    ctx.log.info('switching account', { from: current.desc, to: targetRow.desc })
    await ctx.device.tap({ point: centerOf(targetRow.bounds) })

    const feedNode = await waitForAnchor(ctx, ARTIFACT_PREFIX, 'home feed after switch', PROFIL_TAB, { timeout: 20_000 })
    await ctx.device.tap({ point: centerOf(feedNode.bounds) })
    await waitForAnchor(ctx, ARTIFACT_PREFIX, 'profile screen (verify pass)', MENU_PROFIL)

    // Verify the switch actually landed: read the profile screen and confirm the target's OWN handle
    // is there, AND that the switch-account sheet is gone (`ownProfileShowsHandle` — see its own
    // comment for the two hardware-measured gaps this closes). Fails CLOSED: no match is reported as
    // a verification failure, never as a success (plan 86 §3.6).
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
   * Stateless and idempotent (plan 86 §3.5) — it may run again in a fresh process after a timeout
   * kill, and `forceStop` on an already-stopped package is a no-op. It deliberately does NOT try to
   * switch back to whichever account the job started on: unlike `auto-scroll`, a completed account
   * switch is meant to OUTLIVE the job that made it (§3.5) — reverting it here would make the script
   * pointless, and a "revert" step could not itself be idempotent, since a second `finish()` run has
   * no way to know whether the first one already reverted.
   */
  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('switch-account-failed')
    await ctx.device.app.forceStop(TIKTOK_PACKAGE, { clearRecents: true })
  },
}

export default switchAccountScript
