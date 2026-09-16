import type { UiNode } from '@enkaku/protocol'

/*
  Reading Instagram's accounts (0.37.0). Measured on the owner's moto g06 (Instagram 446.0.0.49.77,
  id-ID, 720x1640) on 2026-09-16:

  - the profile tab's toolbar carries `action_bar_title` whose text and desc are the handle the phone
    is signed in as ("owner.account", `screen-ig-profile.json`); tapping it opens the account switcher;
  - the switcher is a bottom sheet of clickable rows whose desc IS the handle, above "Tambahkan
    Instagram", "Tambahkan Facebook" and "Buka pengaturan Akun Meta" (`screen-ig-account-switcher.json`);
  - the signed-in row carries a blue tick ON SCREEN that the accessibility tree does not expose at
    all — a search of that dump for "dipilih"/"selected"/"checked"/"aktif" found nothing. So the
    current account is taken from the toolbar handle, not from the sheet, and this pack says so
    (`evidence: 'confirmed'` only because the app itself names it in the toolbar).

  Only one Instagram account was signed in on the measured phone, so the ORDER of several rows is
  UNMEASURED; the sheet's own top-to-bottom order is used. English labels are UNMEASURED.
*/

const INSTAGRAM_PACKAGE = 'com.instagram.android'
/** Rows the sheet lists that are actions, never accounts. */
const NOT_AN_ACCOUNT = /^(tambahkan|add|buka pengaturan|open .*settings|kelola|manage)\b/i

const onScreen = (n: UiNode): boolean => n.bounds.left >= 0 && n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top
const fromInstagram = (n: UiNode): boolean => n.packageName === INSTAGRAM_PACKAGE

function flatten(root: UiNode): UiNode[] {
  const out: UiNode[] = [root]
  for (const child of root.children) out.push(...flatten(child))
  return out
}

/** The handle in the profile toolbar — the account the phone is signed in as. */
export function instagramCurrentHandle(tree: UiNode): string | null {
  const title = flatten(tree).find((n) => fromInstagram(n) && onScreen(n) && n.resourceId.endsWith('action_bar_title') && (n.text.trim() !== '' || n.desc.trim() !== ''))
  const handle = (title?.text.trim() || title?.desc.trim() || '').replace(/^@/, '')
  return handle === '' ? null : handle
}

/** The profile toolbar's handle as a tap target — what opens the switcher. */
export function instagramSwitcherButton(tree: UiNode): UiNode | null {
  return flatten(tree).find((n) => fromInstagram(n) && onScreen(n) && n.resourceId.endsWith('action_bar_title')) ?? null
}

/**
 * The handles the switcher sheet lists, top first. A row is a clickable whose desc is a handle and
 * which carries that same handle as its own text somewhere inside — the "Tambahkan …" and "Buka
 * pengaturan Akun Meta" rows carry their label as desc too, and are dropped by name.
 */
export function instagramSwitcherHandles(tree: UiNode): string[] {
  const nodes = flatten(tree)
  const handles: string[] = []
  for (const n of nodes) {
    if (!fromInstagram(n) || !onScreen(n) || !n.clickable) continue
    const desc = n.desc.trim()
    if (desc === '' || NOT_AN_ACCOUNT.test(desc)) continue
    const inside = flatten(n).some((c) => c !== n && c.text.trim() === desc)
    if (!inside) continue
    const handle = desc.replace(/^@/, '')
    if (!handles.includes(handle)) handles.push(handle)
  }
  return handles
}
