import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { channelDraftsCell, draftActionMenus, draftDeleteConfirm, draftMenuDelete, draftsPageEmpty, draftsPageShowing } from './drafts'
import { accountTab, channelHeaderShown, isSignedOut, premiumPage, tapCentre, viewChannelTarget } from './post-video'
import { YOUTUBE_PACKAGE, capture, relaunch, sleep, waitForTree } from './youtube'

/**
 * `clear-drafts` — delete every YouTube draft on the phone's channel (0.39.0).
 *
 * The owner asked (2026-09-16) for draft cleaning as a script of its own on every platform, triggered from the Social
 * Media Manager page. The route was measured on the owner's moto that night (`drafts.ts`): Anda → "Lihat channel" → the
 * channel's "Draf" cell → each draft's "Action menu" → "Hapus" → "Hapus draf ini?" → "Hapus". A channel with no "Draf"
 * cell has no drafts. Every deletion is proven by the page's own count going down (or its empty message); a tap YouTube
 * did not take is tried again, and three misses in a row stop the run with `E_DRAFTS_NOT_CLEARED`. A dry run counts.
 *
 * An unfinished Shorts edit ("Lanjutkan video draf Anda?" on Create) is not one of these drafts and is not touched here —
 * `post-video`'s `unfinishedDraft: 'start-over'` already deletes it when it gets in the way.
 */

const paramsSchema = z.object({
  dryRun: z.boolean().default(false).describe('Open the channel\'s Drafts page and count the drafts, deleting nothing.').meta(ui({ title: 'Dry run' })),
})

const resultSchema = z.object({
  found: z.number().int().describe('Drafts on the channel\'s Drafts page.').meta(ui({ title: 'Found', summary: true })),
  removed: z.number().int().describe('Drafts deleted — 0 in a dry run.').meta(ui({ title: 'Removed', summary: true })),
  dryRun: z.boolean().meta(ui({ title: 'Dry run' })),
  reason: z.string().meta(ui({ title: 'Reason' })),
})

const MAX_DELETIONS = 60
const MISSES_IN_A_ROW = 3

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

const human = (lo: number, hi: number): Promise<void> => sleep(lo + Math.round(Math.random() * (hi - lo)))

/** Anda → "Lihat channel", past the Premium page it sometimes opens instead. Returns the channel page. */
async function openOwnChannel(ctx: ScriptContext<unknown>): Promise<UiNode> {
  const you = await waitForTree(ctx, (t) => accountTab(t) !== null, { budgetMs: 15_000 })
  const tab = accountTab(you.tree)
  if (!tab) {
    await capture(ctx, 'yt-drafts-no-you-tab', you.tree)
    fail('E_ANCHOR_NOT_FOUND', 'YouTube\'s bottom bar has no "Anda" tab — see artifact yt-drafts-no-you-tab.')
  }
  await tapCentre(ctx, tab)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const page = await waitForTree(ctx, (t) => channelHeaderShown(t) || viewChannelTarget(t) !== null || isSignedOut(t), { budgetMs: 15_000 })
    if (isSignedOut(page.tree)) fail('E_NOT_SIGNED_IN', 'YouTube on this phone is signed out. Sign in to the account, then re-run.')
    if (channelHeaderShown(page.tree)) return page.tree
    const view = viewChannelTarget(page.tree)
    if (!view) break
    await ctx.device.tap({ point: view.point })
    const opened = await waitForTree(ctx, (t) => channelHeaderShown(t) || premiumPage(t), { budgetMs: 15_000 })
    if (channelHeaderShown(opened.tree)) return opened.tree
    if (!premiumPage(opened.tree)) break
    ctx.log.warn('"Lihat channel" opened the YouTube Premium page — pressing BACK and trying again', { attempt })
    await ctx.device.key('BACK')
    await sleep(1_500)
  }
  await capture(ctx, 'yt-drafts-no-channel')
  fail('E_ANCHOR_NOT_FOUND', 'the own channel page could not be opened from "Anda" → "Lihat channel" — see artifact yt-drafts-no-channel.')
}

/** BACK only while a menu or the confirmation is over the Drafts page — never on the bare page, which BACK leaves. */
async function backToPage(ctx: ScriptContext<unknown>): Promise<UiNode> {
  let tree = await ctx.device.dump()
  if (draftMenuDelete(tree) !== null || draftDeleteConfirm(tree) !== null) {
    await ctx.device.key('BACK')
    await sleep(1_200)
    tree = await ctx.device.dump()
  }
  return tree
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'clear-drafts',
  title: 'Clear drafts',
  description: 'Deletes every YouTube draft on this phone\'s channel (Anda → Lihat channel → Draf → Hapus). Permanent. A dry run only counts them.',
  icon: 'x',
  node: { category: 'device', icon: 'x', summary: ['found', 'removed'], keywords: ['drafts', 'clean', 'delete'] },
  params: paramsSchema,
  result: resultSchema,
  timeout: 8 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    await openOwnChannel(ctx)
    // The cells arrive after the header; two readings without a "Draf" cell are "no drafts".
    let reads = 0
    const looked = await waitForTree(
      ctx,
      (t) => {
        if (channelDraftsCell(t)) return true
        if (channelHeaderShown(t)) reads += 1
        return reads >= 3
      },
      { budgetMs: 12_000 },
    )
    const cell = channelDraftsCell(looked.tree)
    if (!cell) {
      ctx.log.info('the channel page shows no "Draf" cell — no drafts')
      return { found: 0, removed: 0, dryRun: ctx.params.dryRun, reason: 'no drafts to delete' }
    }
    await human(500, 1_000)
    await tapCentre(ctx, cell)
    const page = await waitForTree(ctx, (t) => draftsPageShowing(t) && (draftActionMenus(t).length > 0 || draftsPageEmpty(t)), { budgetMs: 12_000 })
    if (!draftsPageShowing(page.tree)) {
      await capture(ctx, 'yt-drafts-page-not-open', page.tree)
      fail('E_DRAFTS_NOT_CLEARED', 'the channel\'s "Draf" cell was tapped, but the Drafts page did not open — see artifact yt-drafts-page-not-open.')
    }
    await sleep(1_200)
    let tree = await ctx.device.dump()
    const found = draftActionMenus(tree).length
    ctx.log.info(`the Drafts page shows ${found} draft(s)`)
    if (ctx.params.dryRun || found === 0) {
      return { found, removed: 0, dryRun: ctx.params.dryRun, reason: found === 0 ? 'no drafts to delete' : `dry run: would delete ${found} draft(s)` }
    }

    let removed = 0
    let misses = 0
    for (let i = 0; i < MAX_DELETIONS && misses < MISSES_IN_A_ROW; i++) {
      const menus = draftActionMenus(tree)
      if (menus.length === 0) break
      const before = menus.length
      await human(500, 1_100)
      await tapCentre(ctx, menus[0] as UiNode)
      const menu = await waitForTree(ctx, (t) => draftMenuDelete(t) !== null, { budgetMs: 4_000 })
      const del = draftMenuDelete(menu.tree)
      if (!del) {
        misses += 1
        ctx.log.warn('the draft\'s menu did not open — trying again', { misses })
        tree = await backToPage(ctx)
        continue
      }
      await human(400, 900)
      await tapCentre(ctx, del)
      const asked = await waitForTree(ctx, (t) => draftDeleteConfirm(t) !== null, { budgetMs: 4_000 })
      const yes = draftDeleteConfirm(asked.tree)
      if (!yes) {
        misses += 1
        ctx.log.warn('"Hapus draf ini?" did not come up — trying again', { misses })
        tree = await backToPage(ctx)
        continue
      }
      await human(400, 900)
      await tapCentre(ctx, yes)
      const after = await waitForTree(ctx, (t) => draftsPageShowing(t) && draftDeleteConfirm(t) === null && (draftActionMenus(t).length < before || draftsPageEmpty(t)), { budgetMs: 8_000 })
      tree = after.tree
      if (after.ok) {
        removed += 1
        misses = 0
      } else {
        misses += 1
        ctx.log.warn('the draft is still on the Drafts page after "Hapus" — trying again', { misses })
        tree = await backToPage(ctx)
      }
    }
    const left = draftActionMenus(await ctx.device.dump()).length
    if (left > 0) {
      await capture(ctx, 'yt-drafts-left')
      fail('E_DRAFTS_NOT_CLEARED', `deleted ${removed} draft(s), but ${left} are still on the Drafts page — see artifact yt-drafts-left.`)
    }
    ctx.log.info(`deleted ${removed} draft(s)`)
    return { found, removed, dryRun: false, reason: `deleted ${removed} draft(s)` }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('yt-drafts-failed').catch(() => {})
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
  },
}

export default script
