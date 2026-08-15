import { hitTest, proposeSelectors, type Point, type Selector, type UiNode } from '@enkaku/protocol'

/**
 * The recorder's anchor-candidate primitive (plan 94 §3.3, §4.6, step 94.3) —
 * pure, no I/O, no timers. `RecordingSession` (`./session.ts`) owns the
 * actual anchor DUMP (an async `inspector.dump()` call) and the throttle
 * timers around it; everything here is the deterministic arithmetic that sits
 * on top, so it can be unit-tested with a hand-built `UiNode` fixture and no
 * device, matching `hitTest`/`proposeSelectors` themselves (F13,
 * `packages/protocol/src/selector-match.ts`, `./selector-analysis.ts`).
 */

/**
 * Normalised 0..1 → device pixels, using the anchor's OWN recorded
 * dimensions (`RecordingDoc.recordedOn.width/height`) — deliberately NOT
 * imported from `packages/core/src/server/ws-handlers.ts`'s own
 * `mapNormToDevice`: that file will import from `./service` (the tee lives
 * there), so importing back from here would be a cycle. The formula is a
 * three-line duplicate for the same reason `packages/session/src/
 * device-executor.ts`'s own `mapNormToDevice` copy already documents ("session
 * cannot import core's copy — cross-package direction"); here the boundary is
 * a would-be import cycle rather than a package direction, but the fix is
 * identical.
 */
export function mapNormToPixels(pos: { x: number; y: number }, size: { width: number; height: number }): Point {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), Math.max(max, 0))
  return {
    x: clamp(Math.round(pos.x * size.width), size.width - 1),
    y: clamp(Math.round(pos.y * size.height), size.height - 1),
  }
}

/**
 * Whether enough time has passed since the last anchor dump to take another
 * one (`recording.anchorMinIntervalMs`, plan 94 §3.3) — `lastAnchorAt: null`
 * (no anchor taken yet this session) is always due.
 */
export function anchorDue(nowMs: number, lastAnchorAt: number | null, minIntervalMs: number): boolean {
  return lastAnchorAt === null || nowMs - lastAnchorAt >= minIntervalMs
}

/**
 * `hitTest` the point against the anchor's tree, then rank candidates with
 * `proposeSelectors` (F13) and take the first NON-point one with exactly one
 * match — the only promotable value (`RecordingCandidateSchema.count`'s own
 * doc comment, `packages/protocol/src/recording.ts`). `null` when the point
 * misses the tree entirely, or when nothing on the hit node is unique enough
 * to propose — a step with no candidate is an ordinary, honest outcome, never
 * an error (plan 94 §3.3: "produces a confidently wrong one for a minority").
 */
export function proposeCandidateSelector(root: UiNode, point: Point): { selector: Selector; count: number } | null {
  const node = hitTest(root, point)
  if (!node) return null
  const ranked = proposeSelectors(root, node)
  const unique = ranked.find((c) => c.kind !== 'point' && c.count === 1)
  return unique ? { selector: unique.selector, count: unique.count ?? 0 } : null
}
