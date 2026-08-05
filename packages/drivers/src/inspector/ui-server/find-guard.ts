import type { UiNode } from '@enkaku/protocol'

/**
 * A match that cannot be acted on is not a match (plan 60 §3.1).
 *
 * Measured on a moto g06 power (720×1640), through the product's own script
 * runner:
 *
 * ```
 * find({ id: 'com.android.chrome:id/url_bar' })
 *   → className: android.widget.FrameLayout
 *     bounds:    0,0 → 720,1640     (the entire screen)
 *     clickable: false
 * ```
 *
 * The Inspect panel, dumping the same screen at the same moment, showed that
 * id as an EditText at the top — so `objInfo` and the tree disagreed, and
 * `objInfo` was the one that was wrong. The damage is not the bounds: `tap`
 * aims at a node's centre, so a full-screen node's centre is the middle of the
 * page. `tap({ id: 'url_bar' })` pressed an advertisement, navigated
 * elsewhere, and every assertion afterwards measured a different page.
 *
 * The check is host-side, on the answer `objInfo` hands back, and it is
 * deliberately narrow:
 *
 * - **Area, not an exact match** (§4.1) — a node one pixel short of the full
 *   screen is the same container. The ratio is compared against the screen's
 *   own area, so a rotated device needs no special case: a full-screen node in
 *   landscape has the same area as one in portrait.
 * - **Bounds only, never `clickable`.** §3.1 mentions both, but a `find` does
 *   not know whether its caller is about to tap: the whoer.net case in §3.2
 *   turns on reading a node (`lite-your-ip-value`) that is not clickable at
 *   all. Rejecting non-clickable nodes would break reading the page in order
 *   to fix tapping it.
 * - **Nothing about the node's class or id.** A container is a container
 *   whatever it calls itself.
 *
 * A caller that genuinely wants the root can `dump()` and read it (§3.2) —
 * which is also the escape hatch for the false negative in §8's risk table.
 */

/**
 * Bounds covering this fraction of the viewport or more are a container, not a
 * match for a specific selector. 95% rather than 100% so a node one pixel (or
 * one status bar) short of the full screen is caught too (§4.1).
 */
export const IMPLAUSIBLE_AREA_RATIO = 0.95

/** Bounds this close to the full screen are a container, not a match for a specific id. */
export function isImplausibleMatch(node: UiNode, screen: { width: number; height: number }): boolean {
  // An unknown screen size (nothing probed, `wm size` unreadable) means the
  // guard has nothing to compare against. It stays out of the way rather than
  // guessing — a silent false negative would be exactly the class of failure
  // this plan exists to remove.
  if (screen.width <= 0 || screen.height <= 0) return false

  const width = Math.max(0, node.bounds.right - node.bounds.left)
  const height = Math.max(0, node.bounds.bottom - node.bounds.top)
  const area = width * height
  if (area <= 0) return false

  return area / (screen.width * screen.height) >= IMPLAUSIBLE_AREA_RATIO
}
