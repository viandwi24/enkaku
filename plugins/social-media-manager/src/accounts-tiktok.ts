import type { UiNode } from '@enkaku/protocol'

/*
  Reading TikTok's accounts (0.37.0). Measured on the owner's moto g06 (TikTok 46.6.3, app language
  English, 720x1640) on 2026-09-16, walking Profile → "Profile menu" → "Settings and privacy" →
  (scroll) → "Switch account" (`screen-tt-switch-account.json`):

  - the sheet is `fxs` desc "Bottom sheet", titled `pmf` "Switch account";
  - each account is a clickable `lli` row whose desc IS the handle, with `n7z` carrying the same
    handle as text; the row the phone is signed in as holds `fj7` desc "Checkmark";
  - the last row is "Add account" — an action, never an account.

  Two accounts were signed in on the measured phone (`dewi_purnama280`, ticked, and
  `user2578127329501`), so the multi-account shape IS measured here, unlike Instagram and YouTube.
  The Indonesian build's own ids and labels are the TikTok pack's (`sheet.ts`, plan 86): row id `l_z`,
  sheet desc "Lembar bawah", checkmark desc "Tanda centang" — both vocabularies are accepted below,
  since a farm phone may run either language.
*/

const TIKTOK_PACKAGE = 'com.ss.android.ugc.trill'
const SHEET_DESCS = ['Bottom sheet', 'Lembar bawah']
const ROW_IDS = ['lli', 'l_z']
const HANDLE_IDS = ['n7z', 'l_0']
const CHECKMARK_DESCS = ['Checkmark', 'Tanda centang']
const NOT_AN_ACCOUNT = /^(add account|tambah akun)$/i

const onScreen = (n: UiNode): boolean => n.bounds.left >= 0 && n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top
const fromTikTok = (n: UiNode): boolean => n.packageName === TIKTOK_PACKAGE

function flatten(root: UiNode): UiNode[] {
  const out: UiNode[] = [root]
  for (const child of root.children) out.push(...flatten(child))
  return out
}

const idIs = (n: UiNode, shorts: readonly string[]): boolean => shorts.some((s) => n.resourceId.endsWith(`/${s}`) || n.resourceId === s)

export interface TikTokAccountRead {
  username: string
  /** True for the row carrying the sheet's own checkmark. */
  checked: boolean
}

/** The switch-account sheet is on screen. */
export function tiktokSwitchSheetShowing(tree: UiNode): boolean {
  return flatten(tree).some((n) => fromTikTok(n) && onScreen(n) && SHEET_DESCS.includes(n.desc.trim()))
}

/**
 * The accounts the sheet lists, top first, with the checkmark noted. "Add account" is dropped, and a
 * row is only read inside the sheet's own box — a row the list is still clipping is not a reading.
 */
export function tiktokSwitchSheetAccounts(tree: UiNode): TikTokAccountRead[] {
  const nodes = flatten(tree).filter((n) => fromTikTok(n) && onScreen(n))
  const sheet = nodes.find((n) => SHEET_DESCS.includes(n.desc.trim()))
  if (!sheet) return []
  const inside = (n: UiNode): boolean =>
    n.bounds.left >= sheet.bounds.left && n.bounds.right <= sheet.bounds.right && n.bounds.top >= sheet.bounds.top && n.bounds.bottom <= sheet.bounds.bottom
  const out: TikTokAccountRead[] = []
  for (const row of nodes) {
    if (!idIs(row, ROW_IDS) || !inside(row)) continue
    const handleNode = flatten(row).find((c) => idIs(c, HANDLE_IDS) && c.text.trim() !== '')
    const username = (row.desc.trim() || handleNode?.text.trim() || '').replace(/^@/, '')
    if (username === '' || NOT_AN_ACCOUNT.test(username)) continue
    if (out.some((a) => a.username === username)) continue
    out.push({ username, checked: flatten(row).some((c) => CHECKMARK_DESCS.includes(c.desc.trim())) })
  }
  return out
}
