import type { UiNode } from '@enkaku/protocol'
import { YOUTUBE_PACKAGE } from './youtube'
import { all, rowsById } from './tree'

/*
  YouTube's drafts, read (0.39.0). Measured on the owner's moto g06 (YouTube 21.36.47, id-ID, 720x1640) on 2026-09-16,
  with a draft saved from the details screen's "Simpan draf":

  - the own channel page shows a "Draf" cell (desc "Draf", clickable, [0,423][239,821]) only while drafts exist
    (`screen-channel-with-draft.json`; none on `screen-channel-no-drafts.json`);
  - it opens a "Draf" page — the title "Draf" in the toolbar beside "Kembali ke atas" — with one cell per draft, each
    carrying its own "Action menu" button (`screen-drafts-list.json`);
  - "Action menu" opens a list of `list_item_text` "Edit" and "Hapus" (`screen-drafts-row-menu.json`);
  - "Hapus" asks "Hapus draf ini?" (`custom_confirm_dialog_title`) with `custom_confirm_dialog_cancel_button` "Batal" and
    `custom_confirm_dialog_confirm_button` "Hapus" (`screen-drafts-delete-confirm.json`);
  - with none left the page reads `message_text` "Tidak ada konten yang tersedia." (`screen-drafts-empty.json`).

  English labels ("Drafts", "Delete", "Navigate up", "No content available") are UNMEASURED.
*/

const fromYouTube = (n: UiNode): boolean => n.packageName === YOUTUBE_PACKAGE
const onScreen = (n: UiNode): boolean => n.bounds.left >= 0 && n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top
const DRAFTS = /^(draf|drafts)$/i
/** The toolbar ends at y=154 of 1640 on every screen measured; a tenth of the frame is generous. */
const TOOLBAR_FRACTION = 0.12

function frameHeight(tree: UiNode): number {
  return Math.max(tree.bounds.bottom, ...all(tree, onScreen).map((n) => n.bounds.bottom))
}

/** The channel page's "Draf" cell — only there while the channel has drafts. */
export function channelDraftsCell(tree: UiNode): UiNode | null {
  const toolbar = frameHeight(tree) * TOOLBAR_FRACTION
  return all(tree, (n) => fromYouTube(n) && onScreen(n) && n.clickable && n.bounds.top > toolbar && DRAFTS.test(n.desc.trim()))[0] ?? null
}

/** The "Draf" page: its title in the toolbar beside the back button, and no channel header. */
export function draftsPageShowing(tree: UiNode): boolean {
  const toolbar = frameHeight(tree) * TOOLBAR_FRACTION
  const inBar = (n: UiNode): boolean => fromYouTube(n) && onScreen(n) && n.bounds.bottom <= toolbar
  const title = all(tree, (n) => inBar(n) && DRAFTS.test(n.text.trim())).length > 0
  const back = all(tree, (n) => inBar(n) && n.clickable && /^(kembali ke atas|navigate up)$/i.test(n.desc.trim())).length > 0
  const channel = all(tree, (n) => fromYouTube(n) && onScreen(n) && /^(edit channel|edit saluran)$/i.test(n.desc.trim())).length > 0
  return title && back && !channel
}

/** Each draft's "Action menu" on the "Draf" page, top first. Empty on any other screen. */
export function draftActionMenus(tree: UiNode): UiNode[] {
  if (!draftsPageShowing(tree)) return []
  const toolbar = frameHeight(tree) * TOOLBAR_FRACTION
  return all(tree, (n) => fromYouTube(n) && onScreen(n) && n.clickable && n.bounds.top > toolbar && /^(action menu|menu tindakan)$/i.test(n.desc.trim())).sort(
    (a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left,
  )
}

/** The "Draf" page says it is empty. */
export function draftsPageEmpty(tree: UiNode): boolean {
  return draftsPageShowing(tree) && rowsById(tree, 'message_text').some((n) => onScreen(n) && /tidak ada konten|no content/i.test(n.text))
}

/** The row menu's "Hapus" (`list_item_text`). */
export function draftMenuDelete(tree: UiNode): UiNode | null {
  return rowsById(tree, 'list_item_text').find((n) => onScreen(n) && /^(hapus|delete)$/i.test(n.text.trim())) ?? null
}

/** "Hapus draf ini?"'s own "Hapus" — never its "Batal". */
export function draftDeleteConfirm(tree: UiNode): UiNode | null {
  const title = rowsById(tree, 'custom_confirm_dialog_title').find((n) => onScreen(n) && /draf|draft/i.test(n.text))
  if (!title) return null
  return rowsById(tree, 'custom_confirm_dialog_confirm_button').find((n) => onScreen(n) && n.clickable) ?? null
}
