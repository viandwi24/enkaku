import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { ACCOUNT_PREFIX, AccountRowSchema, accountKeyFor, mergeAccountReading, numberAccounts, type Account, type AccountEvidence } from './accounts'
import { instagramCurrentHandle, instagramSwitcherButton, instagramSwitcherHandles } from './accounts-instagram'
import { tiktokSwitchSheetAccounts, tiktokSwitchSheetShowing } from './accounts-tiktok'
import { youtubeAccountRows, youtubeAccountSheetShowing } from './accounts-youtube'
import { PLATFORM_IDS } from './platforms'

/**
 * `sync-accounts` — read which accounts are signed in on this phone, per platform (0.37.0).
 *
 * The owner asked (2026-09-16) for the Social Media Manager to own this: open each app on the phone,
 * find its account list, store every account it names and mark the one in use. One app can hold
 * several accounts — the measured TikTok phone held two — so a row is a LIST, never a single handle.
 *
 * **Read-only on the phone.** Every walk stops at the account list and reads it; no account row is
 * ever tapped, because the one tap that changes which account is signed in is the tap this member
 * must not make. Each platform is attempted on its own: one app that will not open leaves the others
 * read and their rows written, and records its own error in its own row (`mergeAccountReading` keeps
 * the last good reading beside it).
 *
 * Every anchor below was measured on the owner's moto g06 on 2026-09-16 — see `accounts-tiktok.ts`,
 * `accounts-instagram.ts` and `accounts-youtube.ts` for the dumps and what is still UNMEASURED.
 */

const PACKAGES = {
  tiktok: 'com.ss.android.ugc.trill',
  instagram: 'com.instagram.android',
  youtube: 'com.google.android.youtube',
} as const

const params = z.object({
  platforms: z
    .array(z.enum(PLATFORM_IDS))
    .min(1)
    .default([...PLATFORM_IDS])
    .describe('Which apps to read on this phone. Each is attempted on its own; one failing does not stop the rest.')
    .meta(ui({ title: 'Platforms' })),
})

const result = z.object({
  platforms: z
    .array(
      z.object({
        platform: z.string(),
        accounts: z.number().int(),
        current: z.string().nullable(),
        error: z.string().nullable(),
      }),
    )
    .describe('One line per app read, with how many accounts it listed and which one is signed in.')
    .meta(ui({ title: 'Platforms' })),
  reason: z.string().meta(ui({ title: 'Reason', summary: true })),
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll the phone until `ready` reads true, or the budget runs out. Returns the last tree either way. */
async function waitFor(ctx: ScriptContext<unknown>, ready: (tree: UiNode) => boolean, budgetMs: number): Promise<{ tree: UiNode | null; ok: boolean }> {
  const deadline = Date.now() + budgetMs
  let tree: UiNode | null = null
  for (;;) {
    try {
      tree = await ctx.device.dump()
      if (ready(tree)) return { tree, ok: true }
    } catch {
      // A dump that failed is not an answer about the screen — try again until the budget is out.
    }
    if (Date.now() >= deadline) return { tree, ok: false }
    await sleep(1_000)
  }
}

const flatten = (root: UiNode): UiNode[] => [root, ...root.children.flatMap(flatten)]
const onScreen = (n: UiNode): boolean => n.bounds.left >= 0 && n.bounds.right > n.bounds.left && n.bounds.bottom > n.bounds.top
const centre = (n: UiNode): { x: number; y: number } => ({ x: Math.round((n.bounds.left + n.bounds.right) / 2), y: Math.round((n.bounds.top + n.bounds.bottom) / 2) })

/** The first on-screen node whose desc (or text) is exactly one of `labels`, in either app language. */
function labelled(tree: UiNode, labels: readonly string[]): UiNode | null {
  const wanted = labels.map((l) => l.toLowerCase())
  return flatten(tree).find((n) => onScreen(n) && (wanted.includes(n.desc.trim().toLowerCase()) || wanted.includes(n.text.trim().toLowerCase()))) ?? null
}

/** Tap a labelled node and wait for what it opens. Returns the tree it reached, or null when the label was not there. */
async function tapLabel(ctx: ScriptContext<unknown>, tree: UiNode, labels: readonly string[], ready: (t: UiNode) => boolean, budgetMs = 10_000): Promise<UiNode | null> {
  const node = labelled(tree, labels)
  if (!node) return null
  await ctx.device.tap({ point: centre(node) })
  const got = await waitFor(ctx, ready, budgetMs)
  return got.ok ? got.tree : null
}

/**
 * Save what was on screen when a platform could not be read (0.41.0).
 *
 * Ten production runs on 2026-09-16 failed to read TikTok on four phones and YouTube on three, and
 * every one of those runs saved exactly ONE artifact: its log. So "the TikTok switch-account sheet did
 * not open" arrived with no way to see what HAD opened — and with the farm being shut down, that
 * evidence is gone for good. Every other member in these packs captures a tree and a screenshot when
 * it fails; this one now does too, before the `finally` below closes the app.
 *
 * Neither failure here is fatal: a capture that cannot be taken must not turn a readable platform into
 * an unreadable one.
 */
async function capture(ctx: ScriptContext<unknown>, label: string): Promise<void> {
  await ctx.artifact.screenshot(label).catch((err: unknown) => ctx.log.warn(`could not save the ${label} screenshot`, { error: String(err) }))
  try {
    const tree = await ctx.device.dump()
    await ctx.artifact.file(label, JSON.stringify(tree, null, 2), { ext: 'json' })
  } catch (err) {
    ctx.log.warn(`could not save the ${label} tree`, { error: String(err) })
  }
}

async function launch(ctx: ScriptContext<unknown>, pkg: string): Promise<void> {
  await ctx.device.app.forceStop(pkg, { clearRecents: true })
  await ctx.device.app.launch(pkg)
  await sleep(3_000)
}

interface Reading {
  accounts: Account[]
  evidence: AccountEvidence
}

/** TikTok: Profile → "Profile menu" → "Settings and privacy" → (scroll) → "Switch account" → the sheet. */
async function readTikTok(ctx: ScriptContext<unknown>): Promise<Reading> {
  await launch(ctx, PACKAGES.tiktok)
  const home = await waitFor(ctx, (t) => labelled(t, ['Profile', 'Profil']) !== null, 25_000)
  if (!home.ok || !home.tree) throw new Error('TikTok did not show its bottom navigation')
  const profile = await tapLabel(ctx, home.tree, ['Profile', 'Profil'], (t) => labelled(t, ['Profile menu', 'Menu profil']) !== null, 15_000)
  if (!profile) throw new Error('the TikTok profile did not open')
  const drawer = await tapLabel(ctx, profile, ['Profile menu', 'Menu profil'], (t) => labelled(t, ['Settings and privacy', 'Pengaturan dan privasi']) !== null, 12_000)
  if (!drawer) throw new Error('the TikTok profile menu did not open')
  const settings = await tapLabel(ctx, drawer, ['Settings and privacy', 'Pengaturan dan privasi'], (t) => flatten(t).some((n) => onScreen(n) && n.desc.trim() !== ''), 12_000)
  if (!settings) throw new Error('TikTok settings did not open')

  // "Switch account" sits at the very bottom of settings, under "Login" — measured at four swipes on
  // the moto. Each swipe is followed by a read, so a shorter list stops as soon as the row shows.
  let tree: UiNode | null = settings
  let row = tree ? labelled(tree, ['Switch account', 'Beralih akun']) : null
  for (let swipe = 0; swipe < 6 && !row; swipe++) {
    await ctx.device.swipe({ x: 360, y: 1_300 }, { x: 360, y: 400 }, 500)
    await sleep(1_200)
    tree = (await waitFor(ctx, () => true, 4_000)).tree
    row = tree ? labelled(tree, ['Switch account', 'Beralih akun']) : null
  }
  if (!row || !tree) throw new Error('TikTok settings has no "Switch account" row')
  await ctx.device.tap({ point: centre(row) })
  const sheet = await waitFor(ctx, (t) => tiktokSwitchSheetShowing(t) && tiktokSwitchSheetAccounts(t).length > 0, 12_000)
  if (!sheet.ok || !sheet.tree) throw new Error('the TikTok switch-account sheet did not open')
  const rows = tiktokSwitchSheetAccounts(sheet.tree)
  const marked = rows.findIndex((r) => r.checked)
  return numberAccounts(
    rows.map((r) => ({ username: r.username })),
    marked === -1 ? null : marked,
  )
}

/** Instagram: the profile tab names the signed-in handle; its own title opens the switcher sheet. */
async function readInstagram(ctx: ScriptContext<unknown>): Promise<Reading> {
  await launch(ctx, PACKAGES.instagram)
  const home = await waitFor(ctx, (t) => flatten(t).some((n) => onScreen(n) && n.resourceId.endsWith('profile_tab')), 25_000)
  if (!home.ok || !home.tree) throw new Error('Instagram did not show its bottom navigation')
  const tab = flatten(home.tree).find((n) => onScreen(n) && n.resourceId.endsWith('profile_tab'))
  if (!tab) throw new Error('Instagram has no profile tab')
  await ctx.device.tap({ point: centre(tab) })
  const profile = await waitFor(ctx, (t) => instagramCurrentHandle(t) !== null, 15_000)
  if (!profile.ok || !profile.tree) throw new Error('the Instagram profile did not open')
  const current = instagramCurrentHandle(profile.tree)
  const button = instagramSwitcherButton(profile.tree)
  if (!button || current === null) throw new Error('the Instagram profile does not name the signed-in account')
  await ctx.device.tap({ point: centre(button) })
  const sheet = await waitFor(ctx, (t) => instagramSwitcherHandles(t).length > 0, 10_000)
  // The sheet is a convenience: the toolbar already named the account in use, so a sheet that does
  // not open still yields that one account rather than failing the platform.
  const handles = sheet.ok && sheet.tree ? instagramSwitcherHandles(sheet.tree) : [current]
  const list = handles.includes(current) ? handles : [current, ...handles]
  const numbered = numberAccounts(
    list.map((username) => ({ username })),
    list.indexOf(current),
  )
  // Instagram marks nothing in the tree; the toolbar naming the account IS the app saying so.
  return { accounts: numbered.accounts, evidence: 'confirmed' }
}

/** YouTube: the You tab's account chip opens the account sheet. */
async function readYouTube(ctx: ScriptContext<unknown>): Promise<Reading> {
  await launch(ctx, PACKAGES.youtube)
  const home = await waitFor(ctx, (t) => labelled(t, ['Anda', 'You']) !== null, 25_000)
  if (!home.ok || !home.tree) throw new Error('YouTube did not show its bottom navigation')
  const you = await tapLabel(ctx, home.tree, ['Anda', 'You'], (t) => labelled(t, ['Akun', 'Account']) !== null, 15_000)
  if (!you) throw new Error('the YouTube You tab did not open')
  const sheet = await tapLabel(ctx, you, ['Akun', 'Account'], (t) => youtubeAccountSheetShowing(t), 12_000)
  if (!sheet) throw new Error('the YouTube account sheet did not open')
  const rows = youtubeAccountRows(sheet)
  if (rows.length === 0) throw new Error('the YouTube account sheet listed no channel')
  const marked = rows.findIndex((r) => r.selected)
  return numberAccounts(
    rows.map((r) => ({ username: r.username, displayName: r.displayName, accountId: r.accountId })),
    marked === -1 ? null : marked,
  )
}

const READERS: Record<string, (ctx: ScriptContext<unknown>) => Promise<Reading>> = {
  tiktok: readTikTok,
  instagram: readInstagram,
  youtube: readYouTube,
}

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'sync-accounts',
  title: 'Sync accounts',
  description: 'Reads which accounts are signed in on this phone for each platform picked, and stores them. Never taps an account — it changes nothing about which account is signed in.',
  icon: 'users',
  node: { category: 'device', icon: 'users', summary: ['platforms'], keywords: ['accounts', 'sync', 'sign in'] },
  params,
  result,
  timeout: 10 * 60_000,

  async run(ctx) {
    const lines: { platform: string; accounts: number; current: string | null; error: string | null }[] = []
    for (const platform of ctx.params.platforms) {
      const reader = READERS[platform]
      const key = accountKeyFor(platform, ctx.job.deviceId)
      const previous = await ctx.storage.global.get(key, AccountRowSchema).catch(() => null)
      let reading: Reading | null = null
      let error: string | null = null
      try {
        if (!reader) throw new Error(`this build has no account reader for ${platform}`)
        reading = await reader(ctx)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        ctx.log.warn(`could not read the ${platform} accounts on this phone`, { error })
        // Before the `finally` closes the app — see `capture`. This is the only record of the screen.
        await capture(ctx, `accounts-${platform}-failed`)
      } finally {
        await ctx.device.app.forceStop(PACKAGES[platform as keyof typeof PACKAGES], { clearRecents: true }).catch(() => undefined)
      }
      const row = mergeAccountReading(previous ?? null, {
        platform: platform as (typeof PLATFORM_IDS)[number],
        deviceId: ctx.job.deviceId,
        deviceName: null,
        accounts: reading?.accounts ?? [],
        evidence: reading?.evidence ?? 'none',
        readAt: Math.floor(Date.now() / 1000),
        error,
      })
      await ctx.storage.global.set(key, row)
      const current = row.accounts.find((a) => a.current)?.username ?? null
      lines.push({ platform, accounts: row.accounts.length, current, error })
      if (error === null) ctx.log.info(`read ${row.accounts.length} ${platform} account(s) on this phone`, { current })
    }
    const read = lines.filter((l) => l.error === null)
    const failed = lines.filter((l) => l.error !== null)
    const reason =
      read.length === 0
        ? `no platform could be read (${failed.map((l) => l.platform).join(', ')})`
        : `read ${read.map((l) => `${l.platform}: ${l.accounts}`).join(', ')}${failed.length > 0 ? `; could not read ${failed.map((l) => l.platform).join(', ')}` : ''}`
    if (read.length === 0) {
      /*
        A sync that read nothing is not a success (0.41.0). Ten production runs on 2026-09-16 all
        reported `success` while seven of fifteen stored rows carried an error, so the operator saw
        green jobs beside a half-empty Accounts tab with nothing tying the two together. The core
        derives no summary from a result (`resultSummaryFields: () => []`), so a clearer `reason` alone
        would still have shown green — only a thrown error reaches the Jobs list. A run that read at
        least one platform still succeeds, because it did store something; one that read none has done
        nothing at all and now says so where it can be seen.
      */
      throw new Error(`${reason} — nothing was stored for this phone`)
    }
    if (failed.length > 0) {
      ctx.log.warn(`read ${read.length} of ${lines.length} platform(s) on this phone — the rest kept whatever the last sync stored`, {
        failed: failed.map((l) => `${l.platform}: ${l.error}`).join('; '),
      })
    }
    return { platforms: lines, reason }
  },
}

export { ACCOUNT_PREFIX }
export default script
