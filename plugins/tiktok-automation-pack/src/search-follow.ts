import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import type { Bounds, Selector, UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { between, makeRng, sleep } from './human'
import { waitForAnchor } from './dialogs'
import { all, centerOf, rowsById, textIn } from './tree'
import { scrollResults, searchFor } from './search'

/**
 * Finds one specific account through search and follows it, with human-shaped browsing first, and
 * does nothing when the account is already followed (plan 86 §1, §4.6). Built on `search.ts` (the
 * flow up to and including the Pengguna results tab) and `tree.ts`'s dump-and-walk primitives — every
 * repeated-row screen in this app needs them (§0.1), and this screen is no exception: `id="ugl"`
 * repeats once per result row, exactly like `id="l_z"` did on the switch-account sheet.
 *
 * Exactly one follow per run, by design (plan §2): no bulk following, no follow lists, no loops.
 */

const TIKTOK_PACKAGE = 'com.ss.android.ugc.trill'
const RESULTS_TAB = 'Pengguna'

// ---------------------------------------------------------------------------------------------
// Search-results row (§4.5) — a repeated-id screen, addressed with `rowsById` + `textIn`, never a
// bare `find()` on the shared row id.
// ---------------------------------------------------------------------------------------------

const ROW_SHORT_ID = 'ugl'
/** The row's second text line — the actual @handle, despite sitting under an obfuscated id (§4.5). */
const HANDLE_SHORT_ID = 'zjo'
/** Misleadingly named: holds the DISPLAY NAME, not the handle (§4.5) — kept only for the explicit `matchDisplayName` opt-in. */
const DISPLAY_NAME_SHORT_ID = 'tv_username'
/** The row's own inline follow button — read for the early "already following" short-circuit, never tapped directly (human shaping visits the profile instead). */
const ROW_FOLLOW_BUTTON_SHORT_ID = 'tcj'
/** One locale-formatted string, e.g. `"147,3 rb pengikut · 1,4 jt suka"` — no separate follower-count node exists (§4.5). */
const STATS_SHORT_ID = 'zro'

export interface SearchResultRow {
  handle: string
  displayName: string
  buttonText: string
  stats: string
  bounds: Bounds
}

function textInById(row: UiNode, shortId: string): string {
  return textIn(row, (n) => n.resourceId === shortId || n.resourceId.endsWith(`:id/${shortId}`)) ?? ''
}

/**
 * Enumerates the Pengguna results rows off ONE dump. `rowsById` + `textIn` scoped to each row is the
 * whole answer to §0.1 for this screen, exactly as `readSheetSnapshot` is for the switch-account
 * sheet: every row shares `id="ugl"`, so a bare `find({id:'ugl'})` would silently answer with
 * whichever row the walk reaches first, never an error.
 */
export function readResultRows(tree: UiNode): SearchResultRow[] {
  return rowsById(tree, ROW_SHORT_ID).map((row) => ({
    handle: textInById(row, HANDLE_SHORT_ID),
    displayName: textInById(row, DISPLAY_NAME_SHORT_ID),
    buttonText: textInById(row, ROW_FOLLOW_BUTTON_SHORT_ID),
    stats: textInById(row, STATS_SHORT_ID),
    bounds: row.bounds,
  }))
}

export type RowMatch = { kind: 'none' } | { kind: 'single'; row: SearchResultRow } | { kind: 'ambiguous'; rows: SearchResultRow[] }

/**
 * Exact, case-insensitive handle match. `matchDisplayName` widens the SAME pass to also accept a
 * display-name match — it is never a fallback tried only after a handle match fails (plan §3.4):
 * both criteria are evaluated together, in one filter, so a handle match sitting alongside an
 * unrelated display-name coincidence still produces `ambiguous` rather than one silently winning.
 * More than one match refuses outright, without tapping — following the wrong account is a visible,
 * social, not-quietly-reversible act, and a retry cannot undo it.
 */
export function matchRows(rows: SearchResultRow[], target: string, matchDisplayName: boolean): RowMatch {
  const wanted = target.trim().toLowerCase()
  const matches = rows.filter((r) => {
    if (r.handle.trim().toLowerCase() === wanted) return true
    return matchDisplayName && r.displayName.trim().toLowerCase() === wanted
  })
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length > 1) return { kind: 'ambiguous', rows: matches }
  return { kind: 'single', row: matches[0] as SearchResultRow }
}

/**
 * `rb` = ribu (thousand), `jt` = juta (million) — Indonesian locale formatting, comma as the decimal
 * separator, dot as the thousands separator (plan §4.5). Best-effort: `null` when the string does not
 * match the shape actually seen on hardware rather than guessing at a number.
 */
export function parseFollowerCount(stats: string): number | null {
  const match = stats.match(/([\d.,]+)\s*(rb|jt)?\s*pengikut/i)
  if (!match) return null
  const numberPart = (match[1] as string).replace(/\./g, '').replace(',', '.')
  const value = Number.parseFloat(numberPart)
  if (Number.isNaN(value)) return null
  const unit = match[2]?.toLowerCase()
  const multiplier = unit === 'rb' ? 1_000 : unit === 'jt' ? 1_000_000 : 1
  return Math.round(value * multiplier)
}

// ---------------------------------------------------------------------------------------------
// Follow-state labels — shared between a result row's inline button and the profile screen's own.
// ---------------------------------------------------------------------------------------------

export const NOT_FOLLOWING_LABEL = 'Ikuti'
/**
 * PRESUMED, never independently observed before this plan (§0.7): the reconnaissance scrolled
 * roughly 30 result rows for "scalping" and never found an account the logged-in user already
 * followed. §7.3's probe step 3 either confirms this from a real device or corrects it — if it is
 * corrected, this is the one constant to edit.
 */
export const ALREADY_FOLLOWING_LABEL = 'Mengikuti'

const FOLLOW_STATE_LABELS = new Set([NOT_FOLLOWING_LABEL, ALREADY_FOLLOWING_LABEL])

export function isAlreadyFollowing(buttonText: string): boolean {
  return buttonText.trim() === ALREADY_FOLLOWING_LABEL
}

// ---------------------------------------------------------------------------------------------
// Profile screen (§4.5) — the follow button must be read scoped to itself, NEVER by matching a
// string screen-wide: "Mengikuti" is also the stats-row label for "accounts this profile follows",
// and it sits ABOVE the button in document order, so a bare `find({text:'Mengikuti'})` would be
// answered by the stat label, not the button, exactly the failure mode §0.1/§0.3 already document.
// ---------------------------------------------------------------------------------------------

/** `id:"fds"` — resolves uniquely from `text:"Ikuti"` on a freshly-opened profile (plan §4.5). Paired with a bounds fallback per the plan's own risk table: obfuscated ids rotate between builds — and, per the hardware correction below, this id is ABSENT from the tree entirely once the button has migrated into the collapsed header. */
const PROFILE_FOLLOW_BUTTON_ID_SHORT = 'fds'
/** Stats-row labels sit at `top` ≈ 286, with the label text ~30px below the number (bottom ≈ 349 at the widest observed). */
const PROFILE_STATS_MAX_BOTTOM = 360
/**
 * The FRESHLY-OPENED profile's follow button sits at `top` ≈ 371–441; the video grid does not start
 * until `top` ≈ 669–732 (varies with bio length). This window sits comfortably clear of both.
 */
const PROFILE_FOLLOW_BUTTON_MAX_BOTTOM = 500

/**
 * CORRECTS plan §4.5 — found on hardware, not in the plan (probe job `bc6170ec-9caf-4a1c-8874-bb628bd35c3f`,
 * 2026-08-09): §4.6's own human-shaping sequence scrolls the profile grid BEFORE tapping follow, and
 * that scroll collapses the profile's expanded header into a sticky top toolbar — back arrow, avatar,
 * a follow button, and a share icon, all restacked into the `y 70–161` band the plan documents only as
 * the switch-account/search top bar. In that state `id:"fds"` is gone from the tree entirely (not
 * relocated — genuinely absent, confirmed by `ui.py dump` immediately after a `scroll down`), and the
 * button that appears there carries NO resourceId at all — observed at `[464,87-618,143]`. Scrolling
 * back up made `id:"fds"` reappear at its original bounds, confirming this is a live, reversible UI
 * state and not a one-off inspector glitch (plan §0.8's caution about outages does not apply here: the
 * miss was 100% reproducible both directions).
 *
 * The stats row (`id:"sdn"`) is ALSO absent from the tree once the header is collapsed — the whole
 * expanded-header section is recycled out, not merely scrolled off-screen — so this band can never
 * collide with the "Mengikuti" stat-label trap the plan already guards against: the stat label simply
 * does not exist in the tree at the same time this band is the one worth searching.
 */
const PROFILE_COLLAPSED_HEADER_MIN_TOP = 60
const PROFILE_COLLAPSED_HEADER_MAX_BOTTOM = 200

/** The video grid container — verified unique on a profile screen (plan §4.5) — doubles as this flow's "we have landed on a profile" anchor. */
const PROFILE_ANCHOR: Selector = { id: 'ubz' }

/**
 * CORRECTS plan §4.5 a second time — found while exploring the manual unfollow flow for the hardware
 * probe's step 5 (2026-08-09), on the SAME profile the probe had just followed: once already
 * following, `id:"fds"` is shared by TWO buttons, not one — a "Pesan" (Message) button appears
 * alongside the follow button, and "Pesan" comes FIRST in document order:
 *
 *   id=fds text="Pesan"      [170,371-246,441]
 *   id=fds text="Mengikuti"  [431,371-580,441]
 *
 * A bare `all(tree, byId)[0]` — "first match wins", the exact §0.1 failure mode this whole file
 * exists to avoid everywhere else — would silently return "Pesan" here, which is not a follow-state
 * label at all, and `followAndVerify` would misreport a genuine success as `E_FOLLOW_NOT_VERIFIED`.
 * It did not actually misfire during this plan's own hardware runs (the immediate post-tap re-render
 * apparently keeps the single-button layout; the two-button split was only observed on a FRESH
 * profile navigation, as this manual exploration was), but relying on that timing detail would be
 * fragile. The fix costs nothing: filter the id match down to nodes whose text is an actual
 * follow-state label, so "Pesan" is never a candidate regardless of document order or button count.
 */
export function findProfileFollowButton(tree: UiNode): UiNode | null {
  const byId = all(
    tree,
    (n) => (n.resourceId === PROFILE_FOLLOW_BUTTON_ID_SHORT || n.resourceId.endsWith(`:id/${PROFILE_FOLLOW_BUTTON_ID_SHORT}`)) && FOLLOW_STATE_LABELS.has(n.text.trim()),
  )[0]
  if (byId) return byId
  return (
    all(tree, (n) => {
      if (!FOLLOW_STATE_LABELS.has(n.text.trim())) return false
      const inExpandedHeaderBand = n.bounds.top > PROFILE_STATS_MAX_BOTTOM && n.bounds.top < PROFILE_FOLLOW_BUTTON_MAX_BOTTOM
      const inCollapsedHeaderBand = n.bounds.top > PROFILE_COLLAPSED_HEADER_MIN_TOP && n.bounds.top < PROFILE_COLLAPSED_HEADER_MAX_BOTTOM
      return inExpandedHeaderBand || inCollapsedHeaderBand
    })[0] ?? null
  )
}

// ---------------------------------------------------------------------------------------------
// Device-facing helpers.
// ---------------------------------------------------------------------------------------------

const MAX_SCROLLS = 20 // a constant, never a parameter (§4.6) — "a lever nobody can reason about from a form is worse than no lever."

interface ResolvedTarget {
  row: SearchResultRow
  handlesSeen: string[]
}

/**
 * Dumps the results, tries to match `target`, and — only on a genuine "not visible yet" miss, never
 * an ambiguity — scrolls and tries again, bounded by `MAX_SCROLLS`. An ambiguous match stops the run
 * immediately, without ever scrolling past it or tapping anything (plan §3.4).
 */
async function resolveTargetRow(ctx: ScriptContext<unknown>, target: string, matchDisplayName: boolean): Promise<ResolvedTarget> {
  const seen = new Set<string>()
  for (let attempt = 0; attempt <= MAX_SCROLLS; attempt++) {
    const tree = await ctx.device.dump()
    const rows = readResultRows(tree)
    for (const r of rows) if (r.handle) seen.add(r.handle)

    const result = matchRows(rows, target, matchDisplayName)
    if (result.kind === 'ambiguous') {
      throw Object.assign(
        new Error(`"${target}" matched more than one result row — refusing to guess: ${result.rows.map((r) => r.handle).join(', ')}`),
        { code: 'E_AMBIGUOUS_TARGET' },
      )
    }
    if (result.kind === 'single') return { row: result.row, handlesSeen: [...seen] }

    if (attempt === MAX_SCROLLS) break
    await scrollResults(ctx)
  }
  throw Object.assign(
    new Error(`no result row matched "${target}" after scrolling ${MAX_SCROLLS} times — handles seen: ${[...seen].join(', ') || '(none)'}`),
    { code: 'E_TARGET_NOT_FOUND' },
  )
}

/** 1–3 grid scrolls with uneven pauses — flavour, not a correctness-critical step. */
async function scrollProfileGrid(ctx: ScriptContext<unknown>, rng: () => number): Promise<void> {
  const passes = 1 + Math.floor(rng() * 3)
  for (let i = 0; i < passes; i++) {
    await ctx.device.scroll({ direction: 'down' })
    await sleep(Math.round(between(rng, 500, 2_000)))
  }
}

/**
 * Sometimes opens one grid post, watches it briefly, and closes it with BACK — a deliberate,
 * symmetric "open an overlay, then close the same overlay" navigation, not the blind recovery BACK
 * that plan §0.9 forbids elsewhere in this flow. Best-effort: the grid's exact tap geometry was not
 * hardware-verified by this plan, so a miss here is logged and skipped rather than failing the run —
 * this is timing flavour laid on top of a correctness-critical flow, not part of it.
 */
async function maybeOpenOnePost(ctx: ScriptContext<unknown>, rng: () => number): Promise<void> {
  if (rng() >= 0.4) return
  const grid = await ctx.device.find(PROFILE_ANCHOR)
  if (!grid) return
  try {
    const x = Math.round(between(rng, grid.bounds.left + 40, grid.bounds.right - 40))
    const y = Math.round(between(rng, grid.bounds.top + 40, grid.bounds.top + 300))
    await ctx.device.tap({ point: { x, y } })
    await sleep(Math.round(between(rng, 1_200, 3_500)))
    await ctx.device.key('BACK')
    await sleep(Math.round(between(rng, 500, 1_200)))
  } catch (err) {
    ctx.log.warn('opening a grid post did not go as expected — continuing without it', { error: String(err) })
  }
}

/**
 * Taps the profile follow button and RE-READS it — does not assume the tap worked (plan §4.6). A
 * failure (button missing, or its text unchanged) gets a screenshot artifact and fails the run.
 */
async function followAndVerify(ctx: ScriptContext<unknown>): Promise<{ before: string; after: string }> {
  const beforeTree = await ctx.device.dump()
  const beforeButton = findProfileFollowButton(beforeTree)
  if (!beforeButton) {
    await ctx.artifact.screenshot('search-follow-button-not-found')
    throw Object.assign(new Error('the profile follow button was not found before tapping'), { code: 'E_FOLLOW_BUTTON_NOT_FOUND' })
  }
  const beforeText = beforeButton.text.trim()
  ctx.log.info('tapping the follow button', { beforeText })
  await ctx.device.tap({ point: centerOf(beforeButton.bounds) })
  await sleep(2_000)

  const afterTree = await ctx.device.dump()
  const afterButton = findProfileFollowButton(afterTree)
  const afterText = afterButton?.text.trim() ?? ''
  if (!afterButton || !isAlreadyFollowing(afterText)) {
    await ctx.artifact.screenshot('search-follow-not-verified')
    throw Object.assign(
      new Error(`the follow button read "${beforeText}" before the tap and "${afterText || '(not found)'}" after — expected the already-following label`),
      { code: 'E_FOLLOW_NOT_VERIFIED' },
    )
  }
  ctx.log.info('follow verified', { beforeText, afterText })
  return { before: beforeText, after: afterText }
}

const paramsSchema = z.object({
  query: z.string().min(1).describe('Search query to type.').meta({ title: 'Query' }),
  target: z
    .string()
    .min(1)
    .describe('The exact handle (username) to follow. Matched case-insensitively; more than one match refuses without tapping anything.')
    .meta({ title: 'Target handle' }),
  matchDisplayName: z
    .boolean()
    .default(false)
    .describe(
      'Also match the display name, not only the handle. A deliberate, explicit opt-in — never a fallback tried after a failed handle match (plan §3.4).',
    )
    .meta({ title: 'Also match display name' }),
})

const searchFollowScript: PluginMemberScript<typeof paramsSchema> = {
  id: 'search-follow',
  title: 'Search and follow',
  description:
    'Finds one specific account through search by its exact handle and follows it, with human-shaped browsing first. Does nothing when the account is already followed. Follows at most one account per run.',
  params: paramsSchema,
  // Search, a bounded scroll hunt, a profile visit with grid scrolls and an occasional post, then the
  // follow itself — more screens than `switch-account`, so more slack for dialog sweeps and human pauses.
  timeout: 8 * 60_000,

  async prepare(ctx) {
    await ctx.device.app.forceStop(TIKTOK_PACKAGE)
    await ctx.device.app.launch(TIKTOK_PACKAGE)
    await sleep(4_000)
  },

  async run(ctx) {
    // Minted here and RETURNED in the result — not typed in as a parameter — so a run can be
    // replayed exactly by reading the seed back (the pattern `auto-scroll` already uses).
    const seed = Math.floor(Math.random() * 0xffffffff)
    const rng = makeRng(seed)

    await searchFor(ctx, ctx.params.query, RESULTS_TAB)

    const { row, handlesSeen } = await resolveTargetRow(ctx, ctx.params.target, ctx.params.matchDisplayName)
    ctx.log.info('matched exactly one result row', { handle: row.handle, displayName: row.displayName, buttonText: row.buttonText })

    // The early short-circuit reads the ROW's own inline button — never tapped, only read — so an
    // already-followed account costs nothing beyond the search itself (plan §4.6).
    if (isAlreadyFollowing(row.buttonText)) {
      ctx.log.info('already following — no tap performed', { handle: row.handle })
      return {
        query: ctx.params.query,
        target: ctx.params.target,
        matchDisplayName: ctx.params.matchDisplayName,
        handle: row.handle,
        displayName: row.displayName,
        followers: parseFollowerCount(row.stats),
        followersLabel: row.stats,
        alreadyFollowing: true,
        verified: true,
        seed,
        handlesSeen,
      }
    }

    // Human shaping before the follow — a seeded RNG, so the exact sequence below can be replayed
    // from the `seed` this run returns.
    await sleep(Math.round(between(rng, 800, 2_500))) // dwell on the results a moment
    await ctx.device.tap({ point: centerOf(row.bounds) }) // open the profile — the row's own centre, clear of its inline follow button
    await waitForAnchor(ctx, 'profile screen (video grid)', PROFILE_ANCHOR, { timeout: 15_000 })
    await sleep(Math.round(between(rng, 600, 1_800)))

    await scrollProfileGrid(ctx, rng)
    await maybeOpenOnePost(ctx, rng)
    await sleep(Math.round(between(rng, 500, 1_500)))

    const { before, after } = await followAndVerify(ctx)

    // Back to the results — leaves the device where the run started rather than one screen deeper
    // (plan §4.6's pseudocode).
    await ctx.device.key('BACK')
    await sleep(Math.round(between(rng, 400, 1_000)))

    return {
      query: ctx.params.query,
      target: ctx.params.target,
      matchDisplayName: ctx.params.matchDisplayName,
      handle: row.handle,
      displayName: row.displayName,
      followers: parseFollowerCount(row.stats),
      followersLabel: row.stats,
      alreadyFollowing: false,
      followButtonBefore: before,
      followButtonAfter: after,
      verified: true,
      seed,
      handlesSeen,
    }
  },

  /**
   * Stateless and idempotent — it may run again in a fresh process after a timeout kill.
   * `forceStop` on an already-stopped package is a no-op. Unlike `switch-account`, this script
   * leaves no deliberate account-level state behind to preserve; the follow it made (if any) is the
   * one durable effect, and it is not this hook's job to undo it.
   */
  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('search-follow-failed')
    await ctx.device.app.forceStop(TIKTOK_PACKAGE, { clearRecents: true })
  },
}

export default searchFollowScript
