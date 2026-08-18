import type { UiNode } from '@enkaku/protocol'
import { centerOf } from '@enkaku/protocol'

/**
 * The six-screen upload machine (plan 113 §3.5, §4.3) — pure dump-and-walk primitives, no `ctx`,
 * no device calls. `index.ts`'s `post-video` member takes one `dump()` per screen and hands the
 * tree to these functions; that split is what makes the whole flow testable against the fixtures
 * in `__fixtures__/` without a device (plan 113 §5 step 113.2).
 *
 * Why dump-and-walk instead of `find`/`waitFor`: E3 found the inspector cannot see the animated
 * feed at all (`E_DEADLINE` on `dump`/`find` alike, three retries), and E9 found that even on a
 * STATIC screen, `find({ text: 'Berikutnya' })` refuses as `ambiguous` — the picker is still
 * mounted in the window stack underneath the preview screen, so two nodes read the same label.
 * `dump()` once per screen and walking the returned tree (334–584 ms on the walked device, six
 * screens ≈ 3 s total) is the only way to resolve that ambiguity structurally instead of guessing
 * which of two matches is the real one.
 *
 * E10's own finding governs every id used below: TikTok's view ids are obfuscated and rotate with
 * the app (`pfc`, `pfm`, `gya`, `sp3`, `g9g`, `wz7`, `j_f`, `gge`, `x7f` were all observed and are
 * never referenced here). Exactly seven ids survived that obfuscation and are the ONLY ones
 * `detectScreen` anchors on: `video_record_new_scene_root`, `upload_hot_area`,
 * `viewpager_choose_media`, `video_image_mixed_bottom_view_root`, `tv_title`, `tv_top_text`,
 * `tv_quick_publish`. Every one of the seven is confirmed present in its matching fixture — see
 * the comments on each branch of `detectScreen` for which fixture proves which id. Everything
 * else in this file that reads a node (`pickerCells`, `captionField`) does so by role
 * (`className`) and content, never by an obfuscated id, for the same reason.
 */

export type ScreenId = 'feed' | 'camera' | 'picker' | 'preview' | 'editor' | 'post' | 'unknown'

/** Matches a `Selector`'s `{ id }` rule (`@enkaku/protocol`'s `matches()`): exact, or the app-qualified `pkg:id/<short>` form. */
function hasId(n: UiNode, shortId: string): boolean {
  return n.resourceId === shortId || n.resourceId.endsWith(`:id/${shortId}`)
}

/** Every node in `node`'s subtree, depth-first, including `node` itself. The one recursion every other helper here builds on. */
export function walk(node: UiNode, fn: (n: UiNode, depth: number) => void): void {
  const visit = (n: UiNode, depth: number): void => {
    fn(n, depth)
    for (const child of n.children) visit(child, depth + 1)
  }
  visit(node, 0)
}

/** The first node matching `pred`, depth-first — the ambiguity-free alternative to `find()` this whole file exists for (E9). */
export function findNode(root: UiNode, pred: (n: UiNode) => boolean): UiNode | null {
  if (pred(root)) return root
  for (const child of root.children) {
    const found = findNode(child, pred)
    if (found) return found
  }
  return null
}

/** Every node matching `pred`, depth-first. */
export function findAll(root: UiNode, pred: (n: UiNode) => boolean): UiNode[] {
  const out: UiNode[] = []
  walk(root, (n) => {
    if (pred(n)) out.push(n)
  })
  return out
}

/**
 * Same walk as `findNode` — kept as its own export because the caller's INTENT differs.
 * `findNode` asks for a node to read or tap; `subtreeOf` asks for a node to use as a SCOPE for a
 * further `findNode`/`findAll` call (the picker's grid, the preview screen's stale bottom bar).
 * A reader sees which one a call site means without reading the body.
 */
export function subtreeOf(root: UiNode, pred: (n: UiNode) => boolean): UiNode | null {
  return findNode(root, pred)
}

/** Every node in `subtreeRoot`, as a `Set` — the only way to test "is this node inside that subtree" when a `UiNode` carries no parent pointer to walk upward from (used by `nextButtonIn`'s `preview` branch). */
function nodeSet(subtreeRoot: UiNode): Set<UiNode> {
  const set = new Set<UiNode>()
  walk(subtreeRoot, (n) => set.add(n))
  return set
}

/** Tap point for a node's own bounds. Thin wrapper over `@enkaku/protocol`'s `centerOf(Bounds)` so callers here pass a `UiNode`, not its `.bounds`, at every call site. */
export function centreOf(n: UiNode): { x: number; y: number } {
  return centerOf(n.bounds)
}

/**
 * Which of the six screens this dump was taken on — the seven E10 ids, checked most-specific
 * first, because several of them are NOT mutually exclusive (the app keeps earlier screens
 * mounted underneath later ones, which is exactly what makes E9's ambiguity possible in the
 * first place). Never returns `'feed'`: §3.5 says the feed is never dumped (E3 — the inspector
 * cannot see it), so there is no anchor to detect it by; a caller that starts on the feed knows
 * that by NOT having called this function yet, not by this function saying so. A tree matching
 * none of the six static screens comes back `'unknown'` rather than a guess.
 */
export function detectScreen(root: UiNode): ScreenId {
  const has = (shortId: string) => findNode(root, (n) => hasId(n, shortId)) !== null

  // `tv_quick_publish`/`tv_top_text` (confirmed in screen-editor.json) mark the editor. The
  // discard-draft modal (E14) is drawn ON TOP of the still-mounted editor — confirmed in
  // screen-exit-modal.json, which carries the identical pair — and there is no seventh `ScreenId`
  // for that modal (clearing it is `modals.ts`'s job, plan 113.1); an editor with a dialog over it
  // is still, correctly, `'editor'`.
  if (has('tv_quick_publish') || has('tv_top_text')) return 'editor'

  // `viewpager_choose_media` (confirmed in screen-picker.json and screen-preview.json) marks the
  // picker's own gallery grid — but E9 means its PRESENCE alone cannot tell `'picker'` and
  // `'preview'` apart: the picker stays mounted, byte-for-byte identical, underneath the preview
  // screen, so every one of the seven ids appears in both fixtures. What differs is the
  // "Berikutnya" button `nextButtonIn` already resolves structurally (see its own comment): on
  // the picker it exists only INSIDE `video_image_mixed_bottom_view_root`'s subtree; on the
  // preview screen a second, freshly drawn one sits OUTSIDE it. Reusing that resolution here
  // avoids re-deriving the same structural rule a second time.
  if (has('viewpager_choose_media')) {
    return nextButtonIn(root, 'preview') ? 'preview' : 'picker'
  }

  // `video_record_new_scene_root`/`upload_hot_area` (confirmed in screen-camera-wall.json, E8) are
  // also present on the picker/preview screens — but by the time this branch runs, the
  // `viewpager_choose_media` check above has already ruled those out.
  if (has('video_record_new_scene_root') || has('upload_hot_area')) return 'camera'

  // The post screen (screen-post.json) carries NONE of the seven ids — its own resourceIds
  // (`gya`, `sp3`, `g9g`, all confirmed present in that fixture) are exactly the obfuscated kind
  // this function refuses to anchor on. The one structural fact the walk DID confirm (E13) is
  // that it carries exactly one `EditText` — the caption field — so that identifies it instead.
  if (findNode(root, (n) => n.className === 'android.widget.EditText')) return 'post'

  return 'unknown'
}

export interface PickerCell {
  node: UiNode
  durationText: string | null
  centre: { x: number; y: number }
}

/**
 * Every cell in the picker's gallery grid, in document order. Scoped to the `viewpager_choose_media`
 * anchor, then to the `GridView` role beneath it (confirmed in screen-picker.json: exactly one
 * `android.widget.GridView`, whose DIRECT children are the cell containers) — the grid's own id
 * (`j_f`) is exactly the obfuscated kind this file refuses to anchor on, so it is found by
 * `className`, not by name. `durationText` reads the cell's own duration overlay (E11) — the only
 * non-empty `TextView` inside a cell in the fixture (id `gge`, again read by role and content,
 * never by that id) — which is what lets a caller check the cell it is about to tap is the video
 * that was just pushed, rather than assuming "first cell" is always right.
 */
export function pickerCells(root: UiNode): PickerCell[] {
  const pager = subtreeOf(root, (n) => hasId(n, 'viewpager_choose_media'))
  if (!pager) return []
  const grid = findNode(pager, (n) => n.className === 'android.widget.GridView') ?? pager
  return grid.children.map((cell) => ({
    node: cell,
    durationText: findNode(cell, (n) => n.className === 'android.widget.TextView' && n.text.trim() !== '')?.text ?? null,
    centre: centreOf(cell),
  }))
}

/** The picker's sort order (E11) — `tv_title`'s own text, e.g. `"Terbaru"` ("newest first"). `null` when the anchor itself is not on this tree. */
export function pickerSortLabel(root: UiNode): string | null {
  return findNode(root, (n) => hasId(n, 'tv_title'))?.text ?? null
}

/** The post screen's only `EditText` (E13) — found by class, never by its obfuscated id (`gya`, confirmed in screen-post.json and named in E10 as one never to anchor on). */
export function captionField(root: UiNode): UiNode | null {
  return findNode(root, (n) => n.className === 'android.widget.EditText')
}

/** Confirmed by the hardware walk (E9's own quote: `find({ text: 'Berikutnya' }) → ambiguous`); no other locale string has been observed for this button. */
const NEXT_BUTTON_LABELS = ['Berikutnya', 'Next', 'Siguiente', 'Selanjutnya']

/**
 * Label matching is a LIST and is case-insensitive, because this pack must survive a device whose
 * TikTok is not in Indonesian. Every text this file matches was read off an id-ID device (the only
 * one this pack has ever run on), and a farm's phones will not all share a locale — an SKU sourced
 * in another market arrives in another language, and a text selector that only knows one word fails
 * there with no clue as to why.
 *
 * The English spellings are the confident ones. `Siguiente` and `Selanjutnya` are plausible and
 * UNVERIFIED — kept because a wrong extra candidate costs nothing (it simply never matches) while a
 * missing one costs the whole run, but nobody should read this list as evidence the pack has been
 * tested in those locales. It has not.
 */
function matchesLabel(text: string, labels: string[]): boolean {
  const t = text.trim().toLowerCase()
  return labels.some((l) => t === l.toLowerCase())
}

/**
 * Matched by TEXT alone, never by `className` — the widget carrying the label differs by screen.
 * On the picker/preview screens it is an `android.widget.Button` that is itself the clickable
 * target (confirmed in screen-picker.json/screen-preview.json). On the editor screen the label is
 * an `android.widget.TextView` (`pfm`, `clickable: false`) nested inside a `LinearLayout`
 * (`pfk`, `clickable: true`) that IS the target — confirmed in screen-editor.json. Returning the
 * text node either way is still a safe tap: its bounds sit fully inside the clickable ancestor's
 * on every fixture checked, so `centreOf()` on either node lands on the same touch target.
 */
function isNextButton(n: UiNode): boolean {
  return matchesLabel(n.text, NEXT_BUTTON_LABELS)
}

/**
 * The screen's own "Berikutnya" (Next) button — resolving E9's ambiguity structurally instead of
 * a bare `find({ text: 'Berikutnya' })`, which refuses on the preview screen because two nodes
 * carry that exact label.
 *
 * Verified against the fixtures' own ancestor chains:
 * - `'picker'` (screen-picker.json): the single "Berikutnya" match is nested INSIDE
 *   `video_image_mixed_bottom_view_root`'s subtree (`…video_image_mixed_bottom_view_root > … >
 *   wz7`) — that subtree IS the picker's own bottom bar, so scoping the search to it is correct
 *   and sufficient.
 * - `'preview'` (screen-preview.json): TWO matches exist. The stale one is that exact same node,
 *   still nested inside `video_image_mixed_bottom_view_root` — the picker has not been unmounted
 *   (E9). The live one (`pfc`) is a SIBLING of that whole branch, one level up, under the shared
 *   `s0j` container (`s0j > cza > pfc` vs. `s0j > fsz > … > video_image_mixed_bottom_view_root >
 *   … > wz7`). Excluding every node inside the stale subtree — by node identity, since a `UiNode`
 *   carries no parent pointer to walk upward from — leaves exactly the live one.
 * - every other screen this pack walks with a Next button (`'editor'`, screen-editor.json) has
 *   exactly one match, so no scoping is needed.
 */
export function nextButtonIn(root: UiNode, screen: ScreenId): UiNode | null {
  if (screen === 'picker') {
    const bar = subtreeOf(root, (n) => hasId(n, 'video_image_mixed_bottom_view_root'))
    return findNode(bar ?? root, isNextButton)
  }

  if (screen === 'preview') {
    const stale = subtreeOf(root, (n) => hasId(n, 'video_image_mixed_bottom_view_root'))
    const staleNodes = stale ? nodeSet(stale) : new Set<UiNode>()
    return findNode(root, (n) => isNextButton(n) && !staleNodes.has(n))
  }

  return findNode(root, isNextButton)
}
