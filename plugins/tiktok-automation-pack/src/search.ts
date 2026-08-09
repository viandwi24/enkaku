import type { ScriptContext } from '@enkaku/sdk'
import type { Selector, UiNode } from '@enkaku/protocol'
import { sleep } from './human'
import { clearBlockingDialog, waitForAnchor } from './dialogs'
import { all, centerOf } from './tree'

/**
 * The reusable search helper (plan 86 §1, §4.4): open search, type a query the way a person types,
 * submit, land on a chosen results tab, and scroll for more results. `switch-account.ts` proved the
 * anchor-and-loud-failure pattern on hardware; this file is that pattern applied to a second flow, so
 * `search-follow.ts` (and anything later that needs TikTok search — plan §9 item 4) inherits it rather
 * than re-deriving it.
 */

/**
 * `desc:"Cari"` is not safe to `find()` bare (plan §0.2): TikTok injects a per-video "search this
 * content" chip into some captions, carrying the IDENTICAL content-desc as the persistent top-bar
 * search icon, and the active inspector engine can never report `ambiguous` — a bare find silently
 * returns whichever node the walk reaches first, sometimes the chip. The chip only ever appears low
 * in the caption block (observed at `top: 1424`); the real icon never sits below `top: 200` (observed
 * at `top: 72`). `id:"jvu"` is the real icon and re-verified unique, but it is a three-character
 * generated id of the kind this app rotates between builds — not a durable answer either. The bounds
 * filter is.
 */
const SEARCH_ICON_MAX_TOP = 200

/** `id:"tv_search_textview"` — the one descriptive, non-obfuscated id in this app (plan §4.4 B3). */
const SUBMIT_ID_SHORT = 'tv_search_textview'
const SUBMIT_TEXT = 'Cari'
/** The submit button sits inside the search bar (`y 77-154`); the fallback bounds filter excludes the suggestion/history rows that start at `y >= 161` (plan §4.4). */
const SUBMIT_MAX_TOP = 200

/**
 * `id:"hhu"` — obfuscated, and its `text` is a rotating placeholder query, so text-matching it is
 * unreliable (plan §4.4 B2). Used ONLY to read bounds off an already-taken dump so the input can be
 * focused BY POINT, never fed to `tap(selector)` or matched by its text.
 */
const QUERY_INPUT_ID_SHORT = 'hhu'

/** The real top-bar search icon, never the per-video "search this content" chip (§0.2). Pure and testable without a device. */
export function findSearchIcon(tree: UiNode): UiNode | null {
  return all(tree, (n) => n.desc === 'Cari' && n.bounds.top < SEARCH_ICON_MAX_TOP)[0] ?? null
}

/** The query input's own node, located by its (obfuscated, rotating) id — bounds only, never text. */
export function findQueryInput(tree: UiNode): UiNode | null {
  return all(tree, (n) => n.resourceId === QUERY_INPUT_ID_SHORT || n.resourceId.endsWith(`:id/${QUERY_INPUT_ID_SHORT}`))[0] ?? null
}

/** `id:"tv_search_textview"` first; a bounds-filtered `text:"Cari"` fallback (plan §4.4 B3). */
export function findSubmitButton(tree: UiNode): UiNode | null {
  const byId = all(tree, (n) => n.resourceId === SUBMIT_ID_SHORT || n.resourceId.endsWith(`:id/${SUBMIT_ID_SHORT}`))[0]
  if (byId) return byId
  return all(tree, (n) => n.text === SUBMIT_TEXT && n.bounds.top < SUBMIT_MAX_TOP)[0] ?? null
}

const TAB_CONFIRM_ATTEMPTS = 6
const TAB_CONFIRM_INTERVAL_MS = 500

/**
 * Confirms the requested tab is selected BY CONTENT, never by waiting for it to become clickable
 * (plan §0.5): the currently SELECTED tab on this screen's tab strip reports `clickable:false` and
 * regains `clickable:true` only once another tab is chosen. So "clickable:false on the tab we just
 * tapped" IS the positive confirmation, not a readiness gate to wait past.
 */
async function confirmTabSelected(ctx: ScriptContext<unknown>, tab: string): Promise<void> {
  for (let i = 0; i < TAB_CONFIRM_ATTEMPTS; i++) {
    const node = await ctx.device.find({ desc: tab })
    if (node && node.clickable === false) return
    await sleep(TAB_CONFIRM_INTERVAL_MS)
  }
  await ctx.artifact.screenshot(`search-tab-not-confirmed-${tab.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`)
  throw Object.assign(new Error(`the "${tab}" results tab never reported itself selected`), { code: 'E_TAB_NOT_CONFIRMED' })
}

export interface SearchForResult {
  query: string
  tab: string
}

/**
 * Opens search from the home feed, types `query` the way a person types, submits, and lands on
 * `tab` (e.g. `"Pengguna"`). Every step names an anchor and fails loudly with a screenshot when it
 * cannot prove where the device landed (plan §3.6) — this is `switch-account.ts`'s pattern, applied
 * to a second flow.
 */
export async function searchFor(ctx: ScriptContext<unknown>, query: string, tab: string): Promise<SearchForResult> {
  // 1. The search icon, by dump-and-walk with a bounds filter (§0.2) — never a bare `find({desc:'Cari'})`.
  let feedTree = await ctx.device.dump()
  let icon = findSearchIcon(feedTree)
  if (!icon) {
    ctx.log.warn('the search icon was not in the first dump — sweeping for a blocking dialog once')
    await clearBlockingDialog(ctx, { allowBack: false })
    await sleep(1_500)
    feedTree = await ctx.device.dump()
    icon = findSearchIcon(feedTree)
    if (!icon) {
      await ctx.artifact.screenshot('search-icon-not-found')
      throw Object.assign(
        new Error('the search icon (desc:"Cari", top < 200) was not found on the home feed, even after a dialog sweep'),
        { code: 'E_SEARCH_ICON_NOT_FOUND' },
      )
    }
  }
  await ctx.device.tap({ point: centerOf(icon.bounds) })

  // 2. Land on the search page — confirmed by its submit control, the one descriptive id in this app.
  await waitForAnchor(ctx, 'search page (submit control)', { id: SUBMIT_ID_SHORT }, { timeout: 15_000 })

  // 3. Focus the query input BY POINT, never by selector (§4.4 B2) — `id:"hhu"` is obfuscated and
  //    rotates between builds, and its `text` is a rotating placeholder query, so text-matching it is
  //    unreliable. The bounds come off a dump already taken for this purpose.
  const searchTree = await ctx.device.dump()
  const input = findQueryInput(searchTree)
  if (!input) {
    await ctx.artifact.screenshot('search-input-not-found')
    throw Object.assign(new Error('the query input was not found on the search page'), { code: 'E_SEARCH_INPUT_NOT_FOUND' })
  }
  await ctx.device.tap({ point: centerOf(input.bounds) })
  await sleep(300)

  // 4. Type with the SDK's own per-character human cadence (the `natural` timing profile's
  //    `perCharMs`) — never a hand-rolled per-character loop.
  await ctx.device.type(query)
  await sleep(400)

  // 5. Submit. `id:"tv_search_textview"` first, falling back to a bounds-filtered `text:"Cari"`
  //    (§4.4 B3). ENTER was never needed on hardware. Re-dump in case typing shifted the layout (a
  //    clear-field button appears once text is entered) — never tap a stale bounds box.
  const submitTree = await ctx.device.dump()
  const submit = findSubmitButton(submitTree) ?? findSubmitButton(searchTree)
  if (!submit) {
    await ctx.artifact.screenshot('search-submit-not-found')
    throw Object.assign(new Error('the search submit control ("Cari") was not found'), { code: 'E_SEARCH_SUBMIT_NOT_FOUND' })
  }
  // Never tap below the search bar while suggestions are open (plan §4.4): the area below `y >= 161`
  // holds search-history rows whose per-row delete X (`desc:"Tutup"`, `id:"lkj"`) erases history. The
  // submit button lives inside the bar itself (`y 77-154`), so tapping its own measured bounds is safe.
  await ctx.device.tap({ point: centerOf(submit.bounds) })

  // 6. Land on the results tab strip and select the requested tab. Do NOT wait for it to become
  //    clickable to confirm the switch (§0.5) — confirm by content instead, in `confirmTabSelected`.
  const tabSelector: Selector = { desc: tab }
  await waitForAnchor(ctx, `results tab strip (${tab})`, tabSelector, { timeout: 15_000 })
  const tabNode = await ctx.device.find(tabSelector)
  if (tabNode) await ctx.device.tap({ point: centerOf(tabNode.bounds) })
  await confirmTabSelected(ctx, tab)

  return { query, tab }
}

/**
 * Gesture-scrolls the results list. Nothing on any list screen in this app reports `scrollable:true`
 * (§0.4) — this never checks for it, and never should; scrolling here is always a gesture, never a
 * queried capability.
 */
export async function scrollResults(ctx: ScriptContext<unknown>): Promise<void> {
  await ctx.device.scroll({ direction: 'down' })
  await sleep(500)
}
