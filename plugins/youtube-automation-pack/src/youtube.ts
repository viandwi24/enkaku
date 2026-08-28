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
 * nothing has to be normalised and un-normalised on the way.
 */
export async function tapNode(ctx: ScriptContext<unknown>, node: UiNode): Promise<void> {
  await ctx.device.tap({ point: centre(node) })
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
