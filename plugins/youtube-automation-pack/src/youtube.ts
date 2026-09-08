import type { ScriptContext } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { all, flatten } from './tree'

export const YOUTUBE_PACKAGE = 'com.google.android.youtube'

/** Plain sleep. `ctx.device` has no wait of its own, and every settle here is a property of the app rather than an operator's choice. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `resourceId` ends `:id/<short>` — the same rule a `{ id }` selector uses in `@enkaku/protocol`'s `selector-match.ts`. */
export function hasId(node: UiNode, shortId: string): boolean {
  return node.resourceId === shortId || node.resourceId.endsWith(`:id/${shortId}`)
}

/**
 * Save a tree and a screenshot under one label.
 *
 * Called at every step of `search-channel`, deliberately. A YouTube layout is
 * not a fact this repo owns — it changes with the app version, the locale and
 * the A/B bucket the device happens to be in — so when a run fails the tree at
 * the failing step IS the bug report. Cheap, and the alternative is guessing.
 */
export async function capture(ctx: ScriptContext<unknown>, label: string, tree?: UiNode): Promise<UiNode> {
  /*
   * `tree` is passed by every caller that has already waited for one, and that
   * is not an optimisation — it closes a check-then-act race that cost a real
   * regression.
   *
   * `waitForTree` polls until a tree satisfies a predicate and hands that tree
   * back. Re-dumping here to save the artifact meant acting on a DIFFERENT
   * tree than the one that passed the check: a results page that satisfied the
   * predicate was re-dumped a moment later as bare chrome (YouTube had
   * re-rendered), so the run believed results were ready, then searched an
   * empty page and reported no channel. Save and act on the tree that was
   * actually validated.
   */
  const captured = tree ?? (await ctx.device.dump())
  await ctx.artifact.file(label, JSON.stringify(captured, null, 2), { ext: 'json' })
  await ctx.artifact.screenshot(label)
  return captured
}

/** The centre of a node's bounds — what a tap needs when a selector cannot be trusted to be unique. */
export function centre(node: UiNode): { x: number; y: number } {
  return {
    x: Math.round((node.bounds.left + node.bounds.right) / 2),
    y: Math.round((node.bounds.top + node.bounds.bottom) / 2),
  }
}

/**
 * A point inside the node, but NOT always its centre.
 *
 * A thumb that lands on the exact same pixel every repetition is a sharper
 * tell than no jitter at all; the farm's own `tapJitterMs` recentres the
 * TAP (hold length, micro-offset), and this insets the AIM: a uniform point
 * in the middle 70% of the node, so it can never escape the node onto the
 * control next door. Nodes thinner than 24px on an axis keep the plain
 * centre there — insetting a rail icon would risk the gap beside it.
 */
export function insetPoint(node: UiNode): { x: number; y: number } {
  const { left, top, right, bottom } = node.bounds
  const w = right - left
  const h = bottom - top
  const cx = Math.round((left + right) / 2)
  const cy = Math.round((top + bottom) / 2)
  if (w <= 0 || h <= 0) return { x: cx, y: cy }
  const fx = w < 24 ? 0 : 0.15
  const fy = h < 24 ? 0 : 0.15
  return {
    x: Math.round(left + w * (fx + Math.random() * (1 - 2 * fx))),
    y: Math.round(top + h * (fy + Math.random() * (1 - 2 * fy))),
  }
}

/**
 * Tap a node this script located by walking the tree.
 *
 * `tap({ point })` and NOT `tapNorm`, which is what this pack reached for
 * first: `DeviceApi` declares `tapNorm`, `packages/session/src/device-executor.ts`
 * implements the `'tapNorm'` case — and the IPC bridge between them
 * (`packages/session/src/runner/child-entry.ts`'s `deviceApi`) does not forward
 * it. A script calling it fails at RUNTIME with "ctx.device.tapNorm is not a
 * function", having typechecked and published cleanly. Measured here on
 * 2026-08-26, on the first run of this member.
 *
 * `{ point }` is a real selector (`SelectorSchema`, the last and most fragile
 * rung) and takes device pixels, which is what `bounds` are already in — so
 * nothing has to be normalised and un-normalised on the way. The point itself
 * comes from {@link insetPoint}: inside the node, never pixel-identical twice.
 */
export async function tapNode(ctx: ScriptContext<unknown>, node: UiNode): Promise<void> {
  await ctx.device.tap({ point: insetPoint(node) })
}

/** A node big enough to be a real target and not a zero-sized placeholder. RecyclerViews are full of the latter. */
export function isVisible(node: UiNode): boolean {
  return node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top
}

/**
 * The first node matching any of `preds`, tried in order.
 *
 * Order is the whole point: every step below has a preferred anchor (a resource
 * id, which survives translation) and one or more fallbacks (a content
 * description, which does not — this farm's devices are not guaranteed to be in
 * English, and `tiktok-automation-pack` already met a fully Indonesian UI).
 * Reporting WHICH rung matched is how the guess becomes a measured fact after
 * one real run.
 */
export function firstMatch(tree: UiNode, preds: readonly { via: string; test: (n: UiNode) => boolean }[]): { node: UiNode; via: string } | null {
  const nodes = flatten(tree).filter(isVisible)
  for (const pred of preds) {
    const node = nodes.find(pred.test)
    if (node) return { node, via: pred.via }
  }
  return null
}

/** Every node whose text or description equals `value`, case-insensitively. */
export function labelled(tree: UiNode, value: string): UiNode[] {
  const needle = value.trim().toLowerCase()
  return all(tree, (n) => n.text.trim().toLowerCase() === needle || n.desc.trim().toLowerCase() === needle)
}


/**
 * Poll `dump()` until `ready` accepts the tree, or the budget runs out.
 *
 * A fixed sleep after a submit is a guess about a network, and the first run of
 * this pack on hardware is the worked example: three seconds after pressing
 * search, the results page had rendered its chrome — the search bar, the bottom
 * nav — and none of its result rows. The script dumped that, found the QUERY
 * text still sitting in the search bar, decided it had found the channel, and
 * tapped its way back to the suggestions screen.
 *
 * So: wait for the thing you need rather than for a duration. Returns the last
 * tree either way, so a caller that times out still has something to capture
 * and report instead of an exception with nothing attached.
 */
/**
 * The labels YouTube's bottom bar carries, in both languages it ships here.
 *
 * Any one of them means the app is past its splash and drawing its own chrome.
 * Matching is on `text` OR `desc`, case-insensitively (`labelled`), so this is
 * a list to try rather than one pattern — and it is deliberately not a
 * resource id: those rotate between YouTube builds, and a wrong id matches on
 * no phone at all, which is worse than a label in the wrong language.
 */
const READY_LABELS = ['Home', 'Beranda', 'Shorts', 'Subscriptions', 'Langganan'] as const

/** How long to keep looking for that bar after a cold launch before going ahead anyway. */
const READY_TIMEOUT_MS = 25_000

/** True once YouTube is showing its own navigation rather than a splash. */
export function isReady(tree: UiNode): boolean {
  return READY_LABELS.some((label) => labelled(tree, label).length > 0)
}

/**
 * Force-stop, launch, and WAIT FOR THE APP — not for a fixed five seconds.
 *
 * Every launch site in this pack slept `5_000` and then acted. On the owner's
 * phones that is not enough after a `clearRecents` cold start: all six actions
 * of a two-device warm-up failed on 2026-09-08, every one of them a tap that
 * landed before YouTube could act on it ("tapped the Shorts tab but the Shorts
 * rail never appeared", "the search screen opened with no text field").
 *
 * The principle is already in this file — `waitForTree`'s own comment says a
 * fixed sleep after a submit is a guess about a network. It was applied to
 * search results and never to the launch that precedes them.
 *
 * The short blind settle stays: the inspector cannot dump a window that does
 * not exist yet, and polling into that costs a round trip per attempt. After
 * the budget we continue anyway, so a phone whose inspector will not answer
 * still gets its run and the caller's own anchor reports what it actually
 * found.
 */
export async function relaunch(ctx: ScriptContext<unknown>, opts?: { clearRecents?: boolean }): Promise<void> {
  await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: opts?.clearRecents ?? true })
  await ctx.device.app.launch(YOUTUBE_PACKAGE)
  await sleep(3_000)
  const nav = await waitForTree(ctx, isReady, { budgetMs: READY_TIMEOUT_MS })
  if (!nav.ok) {
    ctx.log.warn(`youtube did not show its navigation within ${READY_TIMEOUT_MS / 1000}s — continuing, and the next anchor will say where the device is`)
    return
  }

  /*
    The navigation is not readiness. It is drawn early — measured at one second
    after the settle on the owner's SM-A075F — and a tap sent then does nothing
    at all, while the identical tap twelve seconds after launch opens the
    screen it names. (Both measured directly, 2026-09-08: the same
    `input.tap` through the same session, once at each moment.)

    So wait for the tree to stop changing. Two consecutive dumps of the same
    size mean the app has finished drawing whatever it was drawing, which is
    the closest thing to "ready" this side of the app telling us — and it costs
    nothing on a phone that was already settled.
  */
  let previous = -1
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const size = countNodes(await ctx.device.dump())
    if (size === previous) {
      ctx.log.info(`youtube settled at ${size} nodes, ${Math.round((Date.now() - (deadline - SETTLE_TIMEOUT_MS)) / 1000)}s after its navigation appeared`)
      return
    }
    previous = size
    await sleep(1_500)
  }
  ctx.log.warn(`youtube was still redrawing after ${SETTLE_TIMEOUT_MS / 1000}s — continuing anyway`)
}

/** How long to wait for the tree to stop changing once the navigation is up. */
const SETTLE_TIMEOUT_MS = 20_000

function countNodes(tree: UiNode): number {
  let n = 0
  const walk = (node: UiNode): void => {
    n += 1
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return n
}

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
