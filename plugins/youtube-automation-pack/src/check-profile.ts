import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { flatten } from './tree'
import { YOUTUBE_PACKAGE, capture, relaunch, tapNode, waitForTree } from './youtube'
import { dismissPopups } from './popups'

/**
 * `check-profile` — open the "You" tab and read the account's own page.
 *
 * Reading only. It never switches account, never opens a playlist, never taps
 * Get Premium, and never enters Settings — the gear is REPORTED as present, not
 * pressed.
 *
 * ## The anchors, measured (owner's moto g06 power, 720x1640, en-US, 2026-09-18)
 *
 * The "You" tab is the last item of the bottom navigation, `desc="You"` at
 * `[576,1472][720,1556]`. The page itself is identified by the pair that only
 * this screen carries: an `Accounts` control at top-left and a `View channel`
 * node. `__fixtures__/screen-you.json` is the capture (151 nodes).
 *
 * ## Why the toolbar is matched by description and never by position
 *
 * This screen's toolbar holds THREE icons — Notifications at left=468, Search
 * at 552, Settings at 636 — where home holds two, so every icon sits 84px left
 * of where the home screen puts it. A member keying on coordinates would press
 * Search on one screen and Settings on the other. Same lesson as
 * `check-notifications`, one screen further in.
 *
 * ## `signedIn`
 *
 * A signed-out "You" page has no account name and no `View channel`. That is
 * reported rather than treated as a failure: a farm phone that has been signed
 * out is a thing the operator needs told, not an exception to bury.
 */

const paramsSchema = z.object({
  maxRows: z.number().int().min(3).max(60).default(25).describe('How many library rows to read before stopping.').meta(ui({ title: 'Max rows' })),
})

const resultSchema = z.object({
  accountName: z.string().describe('The account name on the page, or empty when signed out.').meta(ui({ title: 'Account', summary: true })),
  signedIn: z.boolean().describe('Whether the page showed an account at all.').meta(ui({ title: 'Signed in', summary: true })),
  rows: z.array(z.string()).describe('The page\'s own rows — History, Playlists, Downloads and the rest, in screen order.').meta(ui({ title: 'Rows' })),
  hasSettings: z.boolean().describe('Whether the Settings gear was present. Reported, never pressed.').meta(ui({ title: 'Settings present' })),
  steps: z.array(z.string()).describe('Each step reached, in order — where a failed run stopped.').meta(ui({ title: 'Steps' })),
})

/** How long to wait for the You page after tapping its tab. */
const YOU_ENTER_TIMEOUT_MS = 20_000

/** Chrome on this page: the bottom navigation and the toolbar, never a library row. */
const CHROME =
  /^(home|shorts|create|subscriptions|you|beranda|buat|langganan|anda|search|telusuri|settings|setelan|setelan_|notifications|notifikasi|accounts|akun|action menu|menu tindakan|get premium|navigate up)$/i

/** The bottom-nav "You" item. Matched by description, bounded to the nav band. */
export function youTabOf(tree: UiNode): UiNode | null {
  const nodes = flatten(tree)
  let height = 0
  for (const n of nodes) if (n.bounds.bottom > height) height = n.bounds.bottom
  const band = height === 0 ? 0 : height * 0.85
  return (
    nodes.find(
      (n) =>
        n.clickable &&
        (n.packageName === '' || n.packageName === YOUTUBE_PACKAGE) &&
        n.bounds.top >= band &&
        /^(you|anda|akun saya)$/i.test(n.desc.trim()),
    ) ?? null
  )
}

/**
 * Is the You page on screen?
 *
 * The pair is required. `Accounts` alone appears on the account switcher sheet,
 * and a `View channel` string could be carried by a channel page — together
 * they are this screen and nothing else.
 */
export function onYouPage(tree: UiNode): boolean {
  const nodes = flatten(tree)
  const accounts = nodes.some((n) => ACCOUNT_CONTROL.test(n.desc.trim()))
  const channel = nodes.some((n) => /^(view channel|lihat channel|lihat saluran)$/i.test(n.desc.trim()))
  return accounts && channel
}

/**
 * The account control on the You page, in every layout measured so far.
 *
 * The moto g06 (`en-US`) draws one control described `Accounts`. The owner's production fleet —
 * SM-A075F, `id-ID`, 2026-09-21 — draws a row of chips instead: `Ganti akun`, `Akun Google`,
 * `Aktifkan Mode Samaran`, and no node described `Akun` at all. The old pattern demanded exactly
 * `Akun`, so on every one of those phones the page loaded in full and was never recognised:
 * `check-profile` failed 8 of 11 runs with "the account page never appeared" over a screenshot
 * showing the account page, and the recap's `my-videos` failed on the same line.
 *
 * Still anchored at both ends, so a heading that merely MENTIONS an account is not taken for the
 * control; it is only the list of names that grew.
 */
const ACCOUNT_CONTROL = /^(accounts|akun|switch account|ganti akun|google account|akun google)$/i

/**
 * The account name.
 *
 * It is the clickable node in the header band that is not one of the page's own
 * controls — YouTube gives it no id, so it is found by position and exclusion
 * rather than by name. Empty when signed out.
 */
export function accountNameOf(tree: UiNode): string {
  const header = flatten(tree).filter((n) => n.clickable && n.bounds.top < 335 && n.bounds.top >= 154)
  for (const n of header) {
    const value = n.desc.trim() || n.text.trim()
    if (value === '' || CHROME.test(value)) continue
    if (/^(view channel|lihat channel|lihat saluran)$/i.test(value)) continue
    return value
  }
  return ''
}

/** Is the Settings gear present? Reported only — this member never opens it. */
export function hasSettingsGear(tree: UiNode): boolean {
  return flatten(tree).some((n) => n.clickable && /^(settings|setelan|pengaturan)$/i.test(n.desc.trim()))
}

/**
 * The page's rows — History, the playlists, Downloads.
 *
 * Excluded by BAND (the bottom navigation and the toolbar) plus the chrome
 * list, so a locale this pack has not seen still cannot leak a nav label in as
 * a library row.
 */
export function profileRows(tree: UiNode, maxRows: number): string[] {
  const nodes = flatten(tree)
  let height = 0
  for (const n of nodes) if (n.bounds.bottom > height) height = n.bounds.bottom
  const navTop = height === 0 ? Number.POSITIVE_INFINITY : height * 0.85
  const out: string[] = []
  for (const n of nodes) {
    if (!n.clickable) continue
    if (n.bounds.top >= navTop || n.bounds.bottom <= 154) continue
    const value = (n.desc.trim() || n.text.trim()).replace(/\s+/g, ' ')
    if (value === '' || CHROME.test(value) || out.includes(value)) continue
    out.push(value)
    if (out.length >= maxRows) break
  }
  return out
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'check-profile',
  icon: 'users',
  node: { category: 'device', icon: 'users', summary: ['maxRows'], keywords: ['youtube', 'profile', 'account', 'you', 'warm-up'] },
  title: 'Check profile',
  description: 'Opens the YouTube "You" tab and reads the account page — never switches account, opens a playlist, or enters Settings.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 8 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const steps: string[] = []

    const home = (await dismissPopups(ctx, await ctx.device.dump())).tree
    steps.push('home')
    const tab = youTabOf(home)
    if (!tab) {
      await capture(ctx, 'yt-01-no-you-tab', home)
      throw new Error('the "You" tab was not on the bottom navigation — see artifact yt-01-no-you-tab')
    }
    await tapNode(ctx, tab)
    steps.push('tapped You')

    /*
      Reaching the page is a REQUIREMENT. A run that never got here must fail
      rather than report an empty profile — the same rule `check-notifications`
      states, and the same one the Instagram pack learned in its 0.2.0.
    */
    const opened = await waitForTree(ctx, onYouPage, { budgetMs: YOU_ENTER_TIMEOUT_MS })
    if (!opened.ok) {
      /*
        The TREE, not only a screenshot. Until now this saved a picture and nothing else, and the
        picture from production showed the account page fully drawn — so the failure was the
        matcher, and the one artifact that could have said which node it missed was never saved.
        `capture` is what `search-channel` and `watch-video` already do at every step.
      */
      await capture(ctx, 'yt-02-no-you-page', opened.tree)
      throw new Error('tapped the "You" tab but the account page never appeared — see artifact yt-02-no-you-page')
    }
    steps.push('you page')

    const tree = opened.tree
    const accountName = accountNameOf(tree)
    const rows = profileRows(tree, ctx.params.maxRows)
    const hasSettings = hasSettingsGear(tree)
    steps.push(accountName === '' ? 'signed out' : `read ${rows.length} row(s)`)
    ctx.log.info(`youtube: profile — ${accountName === '' ? 'signed out' : accountName}`, { rows: rows.length, hasSettings })

    return { accountName, signedIn: accountName !== '', rows, hasSettings, steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
  },
}

export default script
