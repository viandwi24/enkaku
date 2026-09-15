import type { UiNode } from '@enkaku/protocol'
import { INSTAGRAM_PACKAGE } from './instagram'
import { all, rowsById } from './tree'

/*
  Instagram's drafts, read (0.10.0). Every id, label and bound below was transcribed from dumps of the owner's moto g06
  (Instagram 446.0.0.49.77, id-ID, 720x1640) on 2026-09-16:

  - the new-post gallery ("Postingan baru") carries a `drafts_tab_text` "Draf" (desc "Lihat draf") beside "Terbaru" only
    while the account HAS drafts (`screen-new-post-drafts-tab.json` with six, `screen-new-post-no-drafts.json` with none);
  - that tab opens a "DRAF" section whose `gallery_manage_button` reads "Kelola (6)";
  - "Kelola" opens the drafts list (`screen-drafts-manage.json`): a Compose page with no ids — a "Draf" title, a
    "Kembali" button, and one row per draft whose desc is "Draf <name>, Dibuat <date>", each with "Edit" and "Lainnya";
  - "Lainnya" raises a menu of "Sematkan", "Ganti nama", "Hapus" (`screen-drafts-row-menu.json`), and "Hapus" deletes
    that draft AT ONCE — no confirmation — measured six times; about one tap in three was not taken and had to be
    repeated, so every deletion is checked by the row count;
  - with none left, the list is its title and "Kembali" alone (`screen-drafts-manage-empty.json`).

  English labels ("Drafts", "Manage", "More", "Delete", "Back", "Created") are UNMEASURED.
*/

const onScreen = (n: UiNode): boolean => n.bounds.left >= 0 && n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top
const fromInstagram = (n: UiNode): boolean => n.packageName === INSTAGRAM_PACKAGE
/** The drafts list's own title bar ends at y=161 of 1640 (its "Kembali"); a fifth of the frame is generous. */
const TOP_BAR_FRACTION = 0.2

/** The new-post gallery's "Draf" tab — only there while the account has drafts. */
export function draftsTabButton(tree: UiNode): UiNode | null {
  return rowsById(tree, 'drafts_tab_text').find((n) => onScreen(n) && n.clickable) ?? null
}

/** "Kelola (6)" in the gallery's DRAF section, with the count it names (null when it names none). */
export function draftsManageButton(tree: UiNode): { node: UiNode; count: number | null } | null {
  const node = rowsById(tree, 'gallery_manage_button').find((n) => onScreen(n) && /^(kelola|manage)\b/i.test(n.text.trim()))
  if (!node) return null
  const match = /\((\d+)\)/.exec(node.text)
  return { node, count: match ? Number(match[1]) : null }
}

function frameHeight(tree: UiNode): number {
  return Math.max(tree.bounds.bottom, ...all(tree, onScreen).map((n) => n.bounds.bottom))
}

/** The drafts list itself: its "Draf" title and its "Kembali" in the title bar, and no create gallery drawn. */
export function draftsListShowing(tree: UiNode): boolean {
  const topBar = frameHeight(tree) * TOP_BAR_FRACTION
  const inBar = (n: UiNode): boolean => fromInstagram(n) && onScreen(n) && n.bounds.bottom <= topBar
  const title = all(tree, (n) => inBar(n) && /^(draf|drafts)$/i.test(n.text.trim())).length > 0
  const back = all(tree, (n) => inBar(n) && n.clickable && /^(kembali|back)$/i.test(n.desc.trim())).length > 0
  const gallery = rowsById(tree, 'new_post_title').some(onScreen) || rowsById(tree, 'gallery_title_text').some(onScreen)
  return title && back && !gallery
}

export interface DraftRow {
  /** The row, desc "Draf 0915-1, Dibuat 15 Sep, 11.45 PM". */
  row: UiNode
  /** Its "Lainnya" button, or null when this reading has none in the row's band. */
  more: UiNode | null
}

/** The drafts list's rows, top first, each with its own "Lainnya". */
export function draftRows(tree: UiNode): DraftRow[] {
  const rows = all(tree, (n) => fromInstagram(n) && onScreen(n) && /^(draf|draft)\s.+,\s*(dibuat|created)\b/i.test(n.desc.trim())).sort((a, b) => a.bounds.top - b.bounds.top)
  const mores = all(tree, (n) => fromInstagram(n) && onScreen(n) && n.clickable && /^(lainnya|more|more options)$/i.test(n.desc.trim()))
  return rows.map((row) => {
    const more = mores.find((m) => {
      const middle = (m.bounds.top + m.bounds.bottom) / 2
      return middle >= row.bounds.top && middle <= row.bounds.bottom
    })
    return { row, more: more ?? null }
  })
}

/** The row menu's "Hapus" — the only thing in that menu this pack ever taps. */
export function draftMenuDelete(tree: UiNode): UiNode | null {
  return all(tree, (n) => fromInstagram(n) && onScreen(n) && /^(hapus|delete)$/i.test(n.text.trim())).sort((a, b) => a.bounds.top - b.bounds.top)[0] ?? null
}

/*
  The Reel drafts (0.10.0), a list of its own with real ids — measured on the same moto the same night:

  - the Reel gallery ("Reel baru") shows a `gallery_destination_item` whose `button_name` reads "Draf · 2"
    (`screen-reel-gallery-drafts-entry.json`); it opens "Draf Reel";
  - "Draf Reel" (`action_bar_title`) lists `gallery_drafts_list_item_container` rows (desc "Video draf 0916-1"), each
    with `overflow_launcher` "Opsi lainnya" (`screen-reel-drafts-list.json`);
  - that opens a context menu of `context_menu_item`s — Duplikatkan, Sematkan, Ganti nama, Buka di Edits, Hapus
    (`screen-reel-drafts-row-menu.json`);
  - "Hapus" there asks "Hapus draf?" in an action sheet whose rows are "Hapus" and "Batal"
    (`screen-reel-drafts-delete-confirm.json`), and its "Hapus" deletes the draft.
*/

/** The Reel gallery's drafts entry ("Draf · 2"), with its count. */
export function reelDraftsEntry(tree: UiNode): { node: UiNode; count: number | null } | null {
  const label = rowsById(tree, 'button_name').find((n) => onScreen(n) && /^(draf|drafts)\b/i.test(n.text.trim()))
  if (!label) return null
  const item = rowsById(tree, 'gallery_destination_item').find((n) => onScreen(n) && n.bounds.left <= label.bounds.left && label.bounds.right <= n.bounds.right && n.bounds.top <= label.bounds.top && label.bounds.bottom <= n.bounds.bottom)
  const match = /(\d+)/.exec(label.text)
  return { node: item ?? label, count: match ? Number(match[1]) : null }
}

/** "Draf Reel" is on screen. */
export function reelDraftsListShowing(tree: UiNode): boolean {
  return rowsById(tree, 'action_bar_title').some((n) => onScreen(n) && /^(draf reel|reel drafts|drafts)$/i.test(n.text.trim()))
}

/** "Draf Reel"'s rows, top first, each with its own "Opsi lainnya". */
export function reelDraftRows(tree: UiNode): DraftRow[] {
  const rows = rowsById(tree, 'gallery_drafts_list_item_container').filter(onScreen).sort((a, b) => a.bounds.top - b.bounds.top)
  const mores = rowsById(tree, 'overflow_launcher').filter((n) => onScreen(n) && n.clickable)
  return rows.map((row) => ({
    row,
    more:
      mores.find((m) => {
        const middle = (m.bounds.top + m.bounds.bottom) / 2
        return middle >= row.bounds.top && middle <= row.bounds.bottom
      }) ?? null,
  }))
}

/** The row's context menu "Hapus" (`context_menu_item`). */
export function reelDraftMenuDelete(tree: UiNode): UiNode | null {
  return rowsById(tree, 'context_menu_item').find((n) => onScreen(n) && n.clickable && /^(hapus|delete)$/i.test((n.desc || n.text).trim())) ?? null
}

/** "Hapus draf?"'s own "Hapus" row — never its "Batal". */
export function reelDraftDeleteConfirm(tree: UiNode): UiNode | null {
  const header = rowsById(tree, 'action_sheet_header_text_view').find((n) => onScreen(n) && /^(hapus draf|delete draft)/i.test(n.text.trim()))
  if (!header) return null
  return rowsById(tree, 'action_sheet_row_text_view').find((n) => onScreen(n) && /^(hapus|delete)$/i.test(n.text.trim())) ?? null
}
