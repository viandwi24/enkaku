import type { ScriptContext } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { all, flatten, rowsById } from './tree'

export const INSTAGRAM_PACKAGE = 'com.instagram.android'

/** Plain sleep. Every settle here is a property of the app, not an operator's choice. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Save a tree and a screenshot under one label, and hand the tree back.
 *
 * An Instagram layout is not a fact this repo owns — it moves with the app
 * version, the locale and the A/B bucket — so the tree at the failing step IS
 * the bug report. Pass the tree a wait already validated: re-dumping here would
 * act on a different tree than the one that passed the check.
 */
export async function capture(ctx: ScriptContext<unknown>, label: string, tree?: UiNode): Promise<UiNode> {
  const captured = tree ?? (await ctx.device.dump())
  await ctx.artifact.file(label, JSON.stringify(captured, null, 2), { ext: 'json' })
  await ctx.artifact.screenshot(label)
  return captured
}

/** The centre of a node's bounds. */
export function centre(node: UiNode): { x: number; y: number } {
  return { x: Math.round((node.bounds.left + node.bounds.right) / 2), y: Math.round((node.bounds.top + node.bounds.bottom) / 2) }
}

/** Poll `dump()` until `ready` accepts the tree or the budget runs out. Returns the last tree either way. */
export async function waitForTree(
  ctx: ScriptContext<unknown>,
  ready: (tree: UiNode) => boolean,
  opts: { budgetMs: number; intervalMs?: number },
): Promise<{ tree: UiNode; ok: boolean; waitedMs: number }> {
  const interval = opts.intervalMs ?? 1_000
  const started = Date.now()
  let tree = await ctx.device.dump()
  while (!ready(tree)) {
    if (Date.now() - started >= opts.budgetMs) return { tree, ok: false, waitedMs: Date.now() - started }
    await sleep(interval)
    tree = await ctx.device.dump()
  }
  return { tree, ok: true, waitedMs: Date.now() - started }
}

/**
 * The bottom navigation, by id. Measured on the owner's moto g06 power
 * (Instagram 446.0, id-ID, 2026-09-14): `feed_tab` Beranda, `clips_tab` Reels,
 * `direct_tab` Pesan, `search_tab` Cara dan Jelajahi, `profile_tab` Profil.
 * Ids rather than labels: the labels are translated, the ids are not.
 */
export type NavTab = 'feed_tab' | 'clips_tab' | 'direct_tab' | 'search_tab' | 'profile_tab'

export function navTab(tree: UiNode, id: NavTab): UiNode | null {
  return rowsById(tree, id).find((n) => n.clickable) ?? null
}

/** Instagram is past its splash and drawing its own navigation. */
export function isReady(tree: UiNode): boolean {
  return navTab(tree, 'feed_tab') !== null && navTab(tree, 'profile_tab') !== null
}

/** Nodes that belong to Instagram and carry anything a person could read or press. */
export function readableInstagramNodes(tree: UiNode): UiNode[] {
  return all(tree, (n) => n.packageName === INSTAGRAM_PACKAGE && (n.text.trim() !== '' || n.desc.trim() !== '' || n.clickable))
}

/**
 * The signed-out entry screen: no navigation, and a login call to action.
 * Worded in both languages this farm meets.
 */
export function isSignedOut(tree: UiNode): boolean {
  if (isReady(tree)) return false
  const strings = flatten(tree).map((n) => `${n.text} ${n.desc}`.trim().toLowerCase()).filter((s) => s !== '')
  return strings.some((s) => /^(masuk|log in|login)$/.test(s) || s.includes('buat akun baru') || s.includes('create new account'))
}

const MEDIA_PERMISSIONS = ['READ_MEDIA_VIDEO', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VISUAL_USER_SELECTED', 'READ_EXTERNAL_STORAGE', 'POST_NOTIFICATIONS'] as const

/**
 * Grant what Instagram's gallery needs before it opens.
 *
 * Android 14+ hides the runtime-permission dialog from the farm's reader (the
 * lesson `youtube-automation-pack` 0.27.0 records), so a dialog nobody answered
 * stops a run with nothing on screen it can read. The camera is left exactly as
 * the phone has it: the upload path this pack walks (home "+" → gallery) never
 * asked for it on the walk, while the Reels tab's own "Buat reel" button did.
 * Never fatal — an older core without the capability logs and carries on.
 */
async function grantMediaBeforeLaunch(ctx: ScriptContext<unknown>): Promise<void> {
  try {
    const granted = await ctx.device.app.grantPermissions(INSTAGRAM_PACKAGE, MEDIA_PERMISSIONS)
    const failed = granted.filter((r) => r.outcome === 'failed')
    if (failed.length > 0) ctx.log.warn('some Instagram permissions could not be granted — a hidden dialog may still appear', { failed: failed.map((f) => `${f.permission}: ${f.detail ?? ''}`).join('; ') })
  } catch (err) {
    ctx.log.warn('could not set Instagram permissions before launch — continuing', { error: String(err) })
  }
}

/**
 * Instagram's feature-announcement sheet, and its "not now" button.
 *
 * Measured on the first routed `check-inbox` run on the owner's moto
 * (2026-09-14): opening the inbox raised "Memperkenalkan instan" with a primary
 * `igds_headline_primary_action_button` ("Coba") and a secondary
 * `igds_headline_secondary_action_text_button` ("Lain kali") — and the run
 * reported the sheet's words as message threads. Only the SECONDARY button is
 * ever returned: the primary one opts the account into whatever is announced.
 */
export function promoDismissButton(tree: UiNode): UiNode | null {
  if (rowsById(tree, 'igds_headline_primary_action_button').length > 0) {
    return rowsById(tree, 'igds_headline_secondary_action_text_button').find((n) => n.clickable) ?? null
  }
  /*
    0.5.0 — the camera-shortcut announcement ("Abadikan momen dengan pintasan kamera baru"), seen
    over the Reel editor on the owner's Samsung production farm (2026-09-15, screenshot only): its
    primary button is "Buka pengaturan perangkat", which would leave Instagram for the system
    settings. Should that sheet ever be drawn without the igds ids, it is still recognised by that
    primary label, and only its "Lain kali" is returned.
  */
  const nodes = flatten(tree)
  const label = (n: UiNode): string => n.desc.trim() || n.text.trim()
  if (!nodes.some((n) => PROMO_LEAVES_APP_LABELS.includes(label(n)))) return null
  return nodes.find((n) => n.clickable && PROMO_DISMISS_LABELS.includes(label(n))) ?? null
}

/** An announcement's primary button that opens the system settings — never tapped. */
const PROMO_LEAVES_APP_LABELS = ['Buka pengaturan perangkat', 'Open device settings']
const PROMO_DISMISS_LABELS = ['Lain kali', 'Not now']

/** Close any announcement sheet on screen (at most `times` in a row). Returns the tree left behind. */
export async function dismissPromos(ctx: ScriptContext<unknown>, times = 2): Promise<UiNode> {
  let tree = await ctx.device.dump()
  for (let i = 0; i < times; i++) {
    const button = promoDismissButton(tree)
    if (!button) return tree
    ctx.log.info('closed an Instagram announcement sheet with its "not now" button', { headline: rowsById(tree, 'igds_headline_headline')[0]?.text ?? '' })
    await ctx.device.tap({ point: centre(button) })
    await sleep(1_200)
    tree = await ctx.device.dump()
  }
  return tree
}

const READY_TIMEOUT_MS = 25_000
const SETTLE_TIMEOUT_MS = 15_000

function countNodes(tree: UiNode): number {
  return flatten(tree).length
}

/**
 * Force-stop, launch, and WAIT FOR THE APP — not for a fixed five seconds.
 *
 * Every member of this pack used to sleep 5 s after launch and then act. The
 * YouTube pack measured why that fails on a cold start (a tap sent while the
 * app is still drawing does nothing), so this polls for Instagram's own bottom
 * navigation and then for two same-sized dumps in a row. A phone whose
 * Instagram is signed out is reported by name instead of as "tab not found".
 */
export async function relaunch(ctx: ScriptContext<unknown>, opts?: { clearRecents?: boolean }): Promise<UiNode> {
  await grantMediaBeforeLaunch(ctx)
  await ctx.device.app.forceStop(INSTAGRAM_PACKAGE, { clearRecents: opts?.clearRecents ?? true })
  await ctx.device.app.launch(INSTAGRAM_PACKAGE)
  await sleep(2_500)
  const nav = await waitForTree(ctx, (t) => isReady(t) || isSignedOut(t), { budgetMs: READY_TIMEOUT_MS })
  if (isSignedOut(nav.tree)) {
    await capture(ctx, 'ig-signed-out', nav.tree)
    throw Object.assign(new Error('Instagram on this phone is signed out. Sign in to the account this phone should use, then re-run.'), { code: 'E_NOT_SIGNED_IN' })
  }
  if (!nav.ok) {
    ctx.log.warn(`instagram did not show its navigation within ${READY_TIMEOUT_MS / 1000}s — continuing, and the next anchor will say where the device is`)
    return nav.tree
  }
  let previous = -1
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const size = countNodes(await ctx.device.dump())
    if (size === previous) break
    previous = size
    await sleep(1_200)
  }
  return dismissPromos(ctx)
}

/**
 * Tap a bottom-nav tab and wait until the screen it names is showing.
 * `ready` is the screen's own anchor; returns the validated tree.
 */
export async function openTab(
  ctx: ScriptContext<unknown>,
  id: NavTab,
  ready: (tree: UiNode) => boolean,
  budgetMs = 15_000,
): Promise<{ tree: UiNode; ok: boolean }> {
  let tree = await ctx.device.dump()
  if (ready(tree)) return { tree, ok: true }
  for (let attempt = 0; attempt < 2; attempt++) {
    const tab = navTab(tree, id)
    if (!tab) return { tree, ok: false }
    await ctx.device.tap({ point: centre(tab) })
    const got = await waitForTree(ctx, ready, { budgetMs })
    if (got.ok) return { tree: got.tree, ok: true }
    tree = got.tree
  }
  return { tree, ok: false }
}

/** Press BACK until the navigation is showing again (at most `times`). */
export async function backToNav(ctx: ScriptContext<unknown>, times = 3): Promise<UiNode> {
  let tree = await ctx.device.dump()
  for (let i = 0; i < times && !isReady(tree); i++) {
    await ctx.device.key('BACK')
    await sleep(1_200)
    tree = await ctx.device.dump()
  }
  return tree
}
