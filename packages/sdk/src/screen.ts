import type { UiNode } from '@enkaku/protocol'

/** The system's own bars are on every screen and are never the reason an app's control is missing. */
const SYSTEM_UI = 'com.android.systemui'

/** A node covers the screen when it spans nearly its full width and at least half its height. */
const COVER_WIDTH_FRACTION = 0.9
const COVER_HEIGHT_FRACTION = 0.5

function flatten(tree: UiNode): UiNode[] {
  const out: UiNode[] = []
  const walk = (n: UiNode): void => {
    out.push(n)
    for (const c of n.children) walk(c)
  }
  walk(tree)
  return out
}

/**
 * Which OTHER app is holding the screen, or `null` when the app under test is still there.
 *
 * Every pack in this repo eventually learns the same lesson, and each one learnt it separately at
 * the cost of a production incident. A run whose app is not in front looks, from inside the pack,
 * exactly like a run whose app has lost a button: the anchor is not found, and the failure gets
 * worded against a control that could not have been there. The reader then goes looking at the
 * app's UI, which is the one place the answer is not.
 *
 *   - `youtube` 0.39.14 — a Play Store sheet over the launch produced five different accusations
 *     from one cause, the loudest being "that is usually a signed-out YouTube" on a phone that was
 *     signed in perfectly well.
 *   - `tiktok` 1.51.0 — `shop-browse` reported "the Shop tab was not on the bottom navigation" and
 *     the artifact it had already saved was Android Settings, with no TikTok node anywhere in it.
 *     That farm had 1082 failed jobs out of 2867.
 *
 * Both packs had written this function, independently, with identical logic and different return
 * types; Instagram was about to be the third. `aimInside` was moved here for the same reason and
 * records the same rule: three copies is how these packs drift apart.
 *
 * It answers by SHAPE, never by a list of known intruders — the phones in question were held by
 * Settings, by a Play sheet and by the launcher, and the next one will be something else. Any
 * package that is not the app under test and not the system UI, covering nearly the whole width
 * and at least half the height, with no node of the app under test anywhere in the tree.
 *
 * Two exclusions carry their own weight. The launcher COUNTS: standing alone it means the app
 * failed to come up at all. A small overlay does NOT: the app is still behind it, and a missing
 * control then means something else entirely.
 *
 * Deliberately returns the package NAME rather than a boolean. Both original copies needed the
 * name in the end, and YouTube's re-derived it afterwards by taking the first non-YouTube package
 * in the tree — which is not necessarily the one doing the covering.
 */
export function foreignAppOnTop(tree: UiNode, ownPackage: string): string | null {
  const nodes = flatten(tree)
  if (nodes.some((n) => n.packageName === ownPackage)) return null

  const width = Math.max(0, ...nodes.map((n) => n.bounds.right))
  const height = Math.max(0, ...nodes.map((n) => n.bounds.bottom))
  // An empty or unmeasurable tree is not evidence of anything, and must not be read as an intruder.
  if (width === 0 || height === 0) return null

  const cover = nodes.find(
    (n) =>
      n.packageName !== '' &&
      n.packageName !== ownPackage &&
      n.packageName !== SYSTEM_UI &&
      n.bounds.right - n.bounds.left >= width * COVER_WIDTH_FRACTION &&
      n.bounds.bottom - n.bounds.top >= height * COVER_HEIGHT_FRACTION,
  )
  return cover?.packageName ?? null
}

/**
 * Samsung's accidental-touch protection ("pocket mode") — the headline it shows, or `null`.
 *
 * This is not an app and not a dialog: it is a full-screen `com.android.systemui` window that
 * swallows every touch until someone swipes up. `foreignAppOnTop` cannot see it, and must not —
 * it excludes the system UI on purpose, because the system's own bars are on every screen.
 *
 * So a run that meets one reads a tree with NO app node in it at all, and every pack in this repo
 * words that as its own app having lost a control. Measured on the owner's farm (2026-09-18):
 * fourteen post-video runs across all three platforms failed this way in three days — Instagram
 * said its bottom navigation was missing, TikTok said the camera screen read "unknown", YouTube
 * said its details screen never opened. Not one of those phones had anything wrong with the app.
 *
 * Keyed on the `unintentional_` resource-id prefix, which is what the overlay's own views carry
 * (`unintentional_title`, `unintentional_body`, `unintentional_drag_to_unlock`, and three
 * `unintentional_locker_img_cue_mtrl_*` chevrons). The TEXT is deliberately not the key: the
 * production trees are Indonesian ("Perlindungan dari sentuhan tidak sengaja"), an English phone
 * words it differently, and this pack has already paid twice for matching a localised label —
 * see `youtube-automation-pack` 0.45.0 and 0.50.0, the same defect in two languages.
 *
 * Returns the headline so a log can name what it found, falling back to the id when the title
 * carries no text.
 */
export function touchBlockerOnTop(tree: UiNode): string | null {
  const nodes = flatten(tree)
  const own = nodes.filter((n) => /(?:^|\/)unintentional_/.test(n.resourceId))
  if (own.length === 0) return null
  const title = own.find((n) => /(?:^|\/)unintentional_title$/.test(n.resourceId))
  return title?.text.trim() || own[0]?.text.trim() || 'accidental-touch protection'
}
