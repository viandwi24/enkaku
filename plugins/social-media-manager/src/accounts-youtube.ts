import type { UiNode } from '@enkaku/protocol'

/*
  Reading YouTube's accounts (0.37.0). Measured on the owner's moto g06 (YouTube 21.36.47, id-ID,
  720x1640) on 2026-09-16, from the Anda tab's account sheet (`screen-yt-accounts.json`):

  - the sheet's header is `title` "Akun", with `add_account` beside it;
  - the signed-in account is a row whose desc begins "Akun yang dipilih: <name>,<handle>,…" and which
    carries `name` ("Channel Name"), `channel_handle` ("@channel-handle") and a `byline`;
  - above it sit the Google account's own `name` and `email` — the identity the channel belongs to.

  Only ONE Google account was signed in on the measured phone, so how a SECOND account's row is
  drawn is UNMEASURED: this reader takes every row carrying a `name` inside the sheet, marks the one
  whose desc says "Akun yang dipilih"/"Selected account", and reports `assumed` when none says so.
  English labels are UNMEASURED.
*/

const YOUTUBE_PACKAGE = 'com.google.android.youtube'
const SELECTED = /^(akun yang dipilih|selected account)\b/i

const onScreen = (n: UiNode): boolean => n.bounds.left >= 0 && n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top
const fromYouTube = (n: UiNode): boolean => n.packageName === YOUTUBE_PACKAGE

function flatten(root: UiNode): UiNode[] {
  const out: UiNode[] = [root]
  for (const child of root.children) out.push(...flatten(child))
  return out
}

const idIs = (n: UiNode, short: string): boolean => n.resourceId.endsWith(`/${short}`) || n.resourceId === short

export interface YouTubeAccountRead {
  /** The channel handle without its `@` when the sheet shows one, else the account name. */
  username: string
  displayName: string | null
  /** The Google account's e-mail when the sheet shows it — the one stable id YouTube exposes here. */
  accountId: string | null
  selected: boolean
}

/** The account sheet is on screen: its "Akun" header with the add-account button beside it. */
export function youtubeAccountSheetShowing(tree: UiNode): boolean {
  const nodes = flatten(tree).filter((n) => fromYouTube(n) && onScreen(n))
  return nodes.some((n) => idIs(n, 'title') && /^(akun|accounts?)$/i.test(n.text.trim())) && nodes.some((n) => idIs(n, 'add_account'))
}

/** Every account the sheet lists, top first, with the one it marks as selected. */
export function youtubeAccountRows(tree: UiNode): YouTubeAccountRead[] {
  if (!youtubeAccountSheetShowing(tree)) return []
  const nodes = flatten(tree).filter((n) => fromYouTube(n) && onScreen(n))
  const email = nodes.find((n) => idIs(n, 'email') && n.text.trim() !== '')?.text.trim() ?? null
  /*
    The SMALLEST node holding an account's `name`, never an ancestor (0.37.0): `account_list` and the
    sheet's own `content` each contain every `name` too, and taking one of those first made the real
    row a duplicate — and dropped its "selected" with it. The row itself is marked two ways, and both
    count: its desc reads "Akun yang dipilih: …", and it carries a `selection_checkmark`.
  */
  const area = (n: UiNode): number => (n.bounds.right - n.bounds.left) * (n.bounds.bottom - n.bounds.top)
  const byUsername = new Map<string, { node: UiNode; name: string }>()
  for (const node of nodes) {
    const name = flatten(node).find((c) => idIs(c, 'name') && c.text.trim() !== '')
    if (!name) continue
    const handle = flatten(node).find((c) => idIs(c, 'channel_handle') && c.text.trim() !== '')
    /*
      A channel row, never the Google account header above it (0.37.0): that header carries a `name`
      and an `email` and no channel of its own, and counting it invented an account called "Hendi
      sunadi" beside the real "@channel-handle". A row is a channel when it names one, or when it is the
      one the sheet ticks.
    */
    if (!handle && !flatten(node).some((c) => idIs(c, 'selection_checkmark'))) continue
    const username = (handle?.text.trim() ?? name.text.trim()).replace(/^@/, '')
    const held = byUsername.get(username)
    if (!held || area(node) < area(held.node)) byUsername.set(username, { node, name: name.text.trim() })
  }
  /*
    The mark sits on the ROW, and the row is not the node the name lives in (0.37.0): `user_info`
    holds `name`/`channel_handle`, while "Akun yang dipilih: …" and `selection_checkmark` sit on the
    `account` box around it. So the mark is looked for on every node whose bounds enclose the one the
    name was read from.
  */
  const encloses = (outer: UiNode, inner: UiNode): boolean =>
    outer.bounds.left <= inner.bounds.left && outer.bounds.right >= inner.bounds.right && outer.bounds.top <= inner.bounds.top && outer.bounds.bottom >= inner.bounds.bottom
  const rows: YouTubeAccountRead[] = []
  for (const [username, { node, name }] of byUsername) {
    const marked = nodes.some((n) => encloses(n, node) && (SELECTED.test(n.desc.trim()) || n.children.some((c) => idIs(c, 'selection_checkmark'))))
    rows.push({ username, displayName: name, accountId: email, selected: marked })
  }
  return rows
}
