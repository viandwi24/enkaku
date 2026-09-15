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
 * first place). §3.5 said the feed is never dumped (E3 — the inspector cannot see it on the moto),
 * so this used to never return `'feed'`. The Samsung fleet's feed dumps are complete, and since
 * 1.35.0 a tree with the bottom nav's three tabs on screen reads `'feed'` — see the last branch. A
 * tree matching none of the screens comes back `'unknown'` rather than a guess.
 */
export function detectScreen(root: UiNode): ScreenId {
  const has = (shortId: string) => findNode(root, (n) => hasId(n, shortId)) !== null

  // `tv_quick_publish`/`tv_top_text` (confirmed in screen-editor.json) mark the editor. The
  // discard-draft modal (E14) is drawn ON TOP of the still-mounted editor — confirmed in
  // screen-exit-modal.json, which carries the identical pair — and there is no seventh `ScreenId`
  // for that modal (clearing it is `modals.ts`'s job, plan 113.1); an editor with a dialog over it
  // is still, correctly, `'editor'`.
  //
  // `tv_top_text` ALONE is no longer enough, and the camera is the reason. A TikTok update moved
  // that id onto the camera's own "Tambah suara" pill: `screen-camera-2026-09.json` (read
  // 2026-09-11 on the same moto g06 the 2026-08-17 fixtures came from) carries `tv_top_text`
  // beside `upload_hot_area`, where `screen-camera-wall.json` carried neither. Because this rule
  // runs first, every camera read as the editor, and `post-video` failed at its very first screen
  // with "expected the camera screen but the dump reads editor" — the tap had worked, the screen
  // was right, and the classifier called it wrong.
  //
  // The discriminator is the gallery button. No editor fixture has ever carried `upload_hot_area`,
  // and every camera does: it is the one thing a camera screen exists to offer this flow. So
  // `tv_quick_publish` stays sufficient on its own, and `tv_top_text` counts only where the
  // gallery button is absent.
  if (has('tv_quick_publish') || (has('tv_top_text') && !has('upload_hot_area'))) return 'editor'

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
  // this function refuses to anchor on. E13 found it carries one `EditText`, the caption field.
  //
  // "Any EditText" was not enough (1.35.0). On the Samsung fleet's For You feed (production bundle
  // 997c7cfe, `screen-feed-samsung-player-edittext.json`) two EditTexts sit inside the video player
  // (`player_view > … > r5y`), one with inverted bounds and one drawn on the frame, and the "add phone
  // number" sheet carries one too ("Nomor telepon", `screen-feed-samsung-phone-sheet.json`). Both read
  // as `'post'`, so `post-video` failed "expected the camera screen but the dump reads post" on a feed.
  // So the post screen now needs BOTH halves of what a person sees there: a caption field drawn on the
  // frame and outside the player, and an on-screen "Posting" button — `sp3` on the moto
  // (screen-post.json), `t6b`/`tc0` [367,1397][697,1487] on the Samsungs (screen-post-samsung.json),
  // matched by its label, never by those ids.
  if (postScreenShowing(root)) return 'post'

  // The English camera, read from its labels (1.45.2). Production, 2026-09-15, pack 1.45.1, English TikTok on the
  // Samsung SM-A075F fleet: a post-video run failed "expected the camera screen but the dump reads unknown after 5
  // settle rounds (no modal matched)" (artifact post-video-unexpected-screen-unknown). That dump carries neither
  // `video_record_new_scene_root` nor `upload_hot_area` — every trill id on it is obfuscated (`u_`, `p0c`, `l9x`,
  // `uwi`, …) — and its readable labels are "Record video" (clickable), "Add sound", "Music", "Close", "Flip",
  // "Flash", the durations "10m"/"60s"/"15s" and the capture modes "PHOTO", "TEXT", "POST", "CREATE". See
  // `cameraLabelsShowing` for why this rule runs HERE, after the post screen, and what keeps it off every other screen.
  if (cameraLabelsShowing(root)) return 'camera'

  // The feed's own bottom nav, all three tabs drawn on screen (1.35.0). The inspector usually cannot
  // read an autoplaying feed (E3), but the Samsung fleet's dumps of it are complete, and a feed that
  // reads `'unknown'` cannot be told apart from a screen that has not arrived. The own profile carries
  // the same bottom nav, so it reads `'feed'` too — to this flow both mean "not in the upload walk".
  if (feedNavShowing(root)) return 'feed'

  return 'unknown'
}

/** The post screen's publish button labels. The English spellings are confident; `Publicar` is unverified. */
export const POST_BUTTON_LABELS = ['Posting', 'Post', 'Publicar']

/** The resource ids of the subtrees that hold the feed's video player — nothing inside them is ever the caption field. */
const PLAYER_SUBTREE_IDS = ['player_view', 'video_visible_area_container']

/** The width the dump spans: its root's, or the widest top-level window when the root reports 0,0,0,0 (seen in this pack's fixtures). */
function frameWidthOf(root: UiNode): number {
  return Math.max(root.bounds.right, ...root.children.map((c) => c.bounds.right), 0)
}

/** Drawn on the frame: a real size, not above or left of the screen, and not past its right edge (a page kept in the tree off to the side). */
function onFrame(n: UiNode, width: number): boolean {
  const b = n.bounds
  return b.right > b.left && b.bottom > b.top && b.left >= 0 && b.top >= 0 && (width <= 0 || b.right <= width + 2)
}

/**
 * The post screen, read from what it shows: an EditText on the frame and outside every player subtree,
 * and an on-screen, non-editable node labelled "Posting". Exported for the tests.
 */
export function postScreenShowing(root: UiNode): boolean {
  const width = frameWidthOf(root)
  const player = new Set<UiNode>()
  for (const container of findAll(root, (n) => PLAYER_SUBTREE_IDS.some((id) => hasId(n, id)))) walk(container, (n) => player.add(n))
  const field = findNode(root, (n) => n.className === 'android.widget.EditText' && !player.has(n) && onFrame(n, width))
  if (!field) return false
  return findNode(root, (n) => !/EditText|AutoCompleteTextView/.test(n.className) && matchesLabel(n.text, POST_BUTTON_LABELS) && onFrame(n, width)) !== null
}

/**
 * The camera's record button, by text or desc. "Record video" was read off the English production dump (2026-09-15).
 * The id-ID camera fixtures carry no readable label on it (`desc: '@2131823324'`, an unresolved resource), so there is
 * no Indonesian spelling here — the id rule above already recognises those cameras.
 */
const CAMERA_RECORD_LABELS = ['Record video']

/**
 * The camera's capture-mode strip, matched in its own upper case. The English four were read off the production dump
 * (2026-09-15); "POSTING"/"BUAT"/"FOTO"/"TEKS" are the same strip in `screen-camera-wall.json` and
 * `screen-camera-2026-09.json`. Case matters here, unlike the other label lists in this file: the post screen's button
 * reads "Post" and the feed's nav tab "Create", and neither is written in capitals.
 */
const CAMERA_MODE_LABELS = ['POST', 'CREATE', 'PHOTO', 'TEXT', 'POSTING', 'BUAT', 'FOTO', 'TEKS']

/**
 * The camera, from what it shows rather than its ids (1.45.2): a record button drawn on the frame, at least two
 * capture-mode labels, and no Next button anywhere in the tree. Exported for the tests.
 *
 * What keeps it off every other screen:
 * - the feed carries no "Record video" (the feed fixtures carry none of these labels);
 * - the picker, the preview and the editor each carry a Next button (`NEXT_BUTTON_LABELS`, confirmed in
 *   screen-picker/preview/editor.json), which the camera does not — and that holds even on a build whose
 *   `viewpager_choose_media`/`tv_quick_publish` ids are obfuscated too, where the camera subtree may stay mounted
 *   underneath them exactly as it does on the moto (E9);
 * - the post screen is decided by `postScreenShowing` before this runs, so a camera kept mounted under it cannot win.
 */
export function cameraLabelsShowing(root: UiNode): boolean {
  const width = frameWidthOf(root)
  const record = findNode(root, (n) => (matchesLabel(n.text, CAMERA_RECORD_LABELS) || matchesLabel(n.desc, CAMERA_RECORD_LABELS)) && onFrame(n, width))
  if (!record) return false
  const modes = new Set<string>()
  walk(root, (n) => {
    for (const t of [n.text.trim(), n.desc.trim()]) if (CAMERA_MODE_LABELS.includes(t)) modes.add(t)
  })
  if (modes.size < 2) return false
  return findNode(root, isNextButton) === null
}

/** The bottom nav's three tabs, by desc (or text), in id-ID and en. */
const FEED_NAV_TABS: string[][] = [
  ['Beranda', 'Home'],
  ['Buat', 'Create'],
  ['Profil', 'Profile'],
]

/** `value` reads as `label`: the same words, case-insensitive, optionally followed by a non-letter ("Profil, 2 notifikasi") — `post-video.ts`'s `labelMatches` rule. */
function readsAs(value: string, label: string): boolean {
  const v = value.trim().toLowerCase()
  const l = label.toLowerCase()
  if (!v.startsWith(l)) return false
  return v.length === l.length || !/[\p{L}\p{N}]/u.test(v.charAt(l.length))
}

/** True when Beranda, Buat and Profil (or Home, Create and Profile) are all drawn on screen. Exported for the tests. */
export function feedNavShowing(root: UiNode): boolean {
  const width = frameWidthOf(root)
  const drawn = findAll(root, (n) => onFrame(n, width) && (n.desc.trim() !== '' || n.text.trim() !== ''))
  return FEED_NAV_TABS.every((labels) => drawn.some((n) => labels.some((l) => readsAs(n.desc, l) || n.text.trim().toLowerCase() === l.toLowerCase())))
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
