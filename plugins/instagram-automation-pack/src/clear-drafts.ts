import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import {
  draftMenuDelete,
  draftRows,
  draftsListShowing,
  draftsManageButton,
  draftsTabButton,
  reelDraftDeleteConfirm,
  reelDraftMenuDelete,
  reelDraftRows,
  reelDraftsEntry,
  reelDraftsListShowing,
  type DraftRow,
} from './drafts'
import { INSTAGRAM_PACKAGE, backToNav, capture, isReady, openTab, relaunch, sleep, waitForTree } from './instagram'
import { answerCreatePrompts, gallerySurface, homeCreateButton, leaveNewPostGallery, openReelGalleryFromProfile, tapCentre, tapCreate } from './post-video'
import { rowsById } from './tree'

/**
 * `clear-drafts` — delete every Instagram draft on the phone's account (0.10.0).
 *
 * The owner asked (2026-09-16) for draft cleaning as a script of its own on every platform, triggered from the Social
 * Media Manager page. Instagram keeps drafts in TWO lists, both measured on the owner's moto that night (`drafts.ts`):
 * the new-post gallery's "Draf" → "Kelola" list, and the Reel gallery's "Draf · N" → "Draf Reel". "+" opens whichever
 * gallery the account used last, so this empties that one first, then reaches the other the ways `post-video` already
 * knows: POSTINGAN from the Reel gallery, and "Batal" + the profile's "Buat Baru" from the new-post gallery.
 *
 * Every deletion is proven by the row count going down; a tap Instagram did not take (about one in three on the moto)
 * is tried again, three misses in a row stop the run with `E_DRAFTS_NOT_CLEARED`. A dry run opens each list and counts.
 */

const paramsSchema = z.object({
  dryRun: z.boolean().default(false).describe('Open each drafts list and count the drafts, deleting nothing.').meta(ui({ title: 'Dry run' })),
})

const resultSchema = z.object({
  found: z.number().int().describe('Drafts seen across both lists.').meta(ui({ title: 'Found', summary: true })),
  removed: z.number().int().describe('Drafts deleted — 0 in a dry run.').meta(ui({ title: 'Removed', summary: true })),
  lists: z.array(z.string()).describe('The lists that were opened: "drafts" (new-post gallery) and/or "reel-drafts".').meta(ui({ title: 'Lists' })),
  dryRun: z.boolean().meta(ui({ title: 'Dry run' })),
  reason: z.string().meta(ui({ title: 'Reason' })),
})

/** A farm account never has this many; a cap keeps a list that never shrinks from running the whole timeout. */
const MAX_DELETIONS = 60
const MISSES_IN_A_ROW = 3

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

interface DraftsList {
  name: 'drafts' | 'reel-drafts'
  showing: (tree: UiNode) => boolean
  rows: (tree: UiNode) => DraftRow[]
  menuDelete: (tree: UiNode) => UiNode | null
  /** Null for the list whose "Hapus" deletes at once. */
  confirm: ((tree: UiNode) => UiNode | null) | null
}

const DRAFTS: DraftsList = { name: 'drafts', showing: draftsListShowing, rows: draftRows, menuDelete: draftMenuDelete, confirm: null }
const REEL_DRAFTS: DraftsList = { name: 'reel-drafts', showing: reelDraftsListShowing, rows: reelDraftRows, menuDelete: reelDraftMenuDelete, confirm: reelDraftDeleteConfirm }

const human = (lo: number, hi: number): Promise<void> => sleep(lo + Math.round(Math.random() * (hi - lo)))

/** Empty the list on screen, one row at a time, each deletion proven by the count. */
async function emptyList(ctx: ScriptContext<{ dryRun: boolean }>, list: DraftsList): Promise<{ found: number; removed: number }> {
  let tree = (await waitForTree(ctx, (t) => list.showing(t), { budgetMs: 10_000 })).tree
  // Rows draw a moment after the title; two readings that agree are the count.
  await sleep(1_200)
  tree = await ctx.device.dump()
  const found = list.rows(tree).length
  ctx.log.info(`the ${list.name} list shows ${found} draft(s)`)
  if (ctx.params.dryRun || found === 0) return { found, removed: 0 }

  let removed = 0
  let misses = 0
  for (let i = 0; i < MAX_DELETIONS && misses < MISSES_IN_A_ROW; i++) {
    const rows = list.rows(tree)
    if (rows.length === 0) break
    const more = rows[0]?.more
    if (!more) {
      await capture(ctx, `ig-drafts-${list.name}-no-menu`, tree)
      fail('E_DRAFTS_NOT_CLEARED', `the ${list.name} list shows a draft with no menu button this pack recognises — see artifact ig-drafts-${list.name}-no-menu.`)
    }
    await human(500, 1_100)
    await tapCentre(ctx, more)
    const menu = await waitForTree(ctx, (t) => list.menuDelete(t) !== null, { budgetMs: 4_000 })
    const del = list.menuDelete(menu.tree)
    if (!del) {
      misses += 1
      ctx.log.warn(`the draft menu did not open — trying again`, { list: list.name, misses })
      tree = await backToList(ctx, list)
      continue
    }
    await human(400, 900)
    await tapCentre(ctx, del)
    if (list.confirm) {
      const asked = await waitForTree(ctx, (t) => list.confirm?.(t) != null, { budgetMs: 4_000 })
      const yes = list.confirm(asked.tree)
      if (!yes) {
        misses += 1
        ctx.log.warn('"Hapus draf?" did not come up — trying again', { list: list.name, misses })
        tree = await backToList(ctx, list)
        continue
      }
      await human(400, 900)
      await tapCentre(ctx, yes)
    }
    const before = rows.length
    const after = await waitForTree(ctx, (t) => list.showing(t) && list.rows(t).length < before, { budgetMs: 6_000 })
    tree = after.tree
    if (after.ok) {
      removed += 1
      misses = 0
    } else {
      misses += 1
      ctx.log.warn('the draft is still in the list after "Hapus" — trying again', { list: list.name, misses })
      tree = await backToList(ctx, list)
    }
  }
  const left = list.rows(await ctx.device.dump()).length
  if (left > 0) {
    await capture(ctx, `ig-drafts-${list.name}-left`)
    fail('E_DRAFTS_NOT_CLEARED', `deleted ${removed} draft(s) from the ${list.name} list, but ${left} are still there — see artifact ig-drafts-${list.name}-left.`)
  }
  ctx.log.info(`deleted ${removed} draft(s) from the ${list.name} list`)
  return { found, removed }
}

/** BACK once only while a menu or sheet is over the list (the list itself is left by BACK too, so never on the bare list). */
async function backToList(ctx: ScriptContext<unknown>, list: DraftsList): Promise<UiNode> {
  let tree = await ctx.device.dump()
  if (!list.showing(tree) || list.menuDelete(tree) !== null || (list.confirm?.(tree) ?? null) !== null) {
    await ctx.device.key('BACK')
    await sleep(1_200)
    tree = await ctx.device.dump()
  }
  return tree
}

/** "+" from the home feed, answering what it raises, until a create gallery is up. */
async function openCreateGallery(ctx: ScriptContext<unknown>): Promise<UiNode> {
  await backToNav(ctx)
  const feed = await openTab(ctx, 'feed_tab', (t) => homeCreateButton(t) !== null, 12_000)
  const plus = homeCreateButton(feed.tree)
  if (!plus) {
    await capture(ctx, 'ig-drafts-feed', feed.tree)
    fail('E_ANCHOR_NOT_FOUND', 'the home feed has no create ("+") button — see artifact ig-drafts-feed.')
  }
  let opened = await tapCreate(ctx, plus, homeCreateButton, 'the home feed')
  opened = await answerCreatePrompts(ctx, opened, { tag: 'ig-drafts', origin: '"+"' })
  if (!opened.ok || gallerySurface(opened.tree) === null) {
    await capture(ctx, 'ig-drafts-gallery', opened.tree)
    fail('E_ANCHOR_NOT_FOUND', 'the create gallery did not open after "+" — see artifact ig-drafts-gallery.')
  }
  return opened.tree
}

/** The new-post gallery's list: its "Draf" tab and "Kelola", or nothing when the account has none there. */
async function clearNewPostDrafts(ctx: ScriptContext<{ dryRun: boolean }>): Promise<{ found: number; removed: number; opened: boolean }> {
  // The tab is drawn with the gallery's own folder menu; two readings with the menu and no tab are "no drafts".
  let reads = 0
  const looked = await waitForTree(
    ctx,
    (t) => {
      if (draftsTabButton(t)) return true
      if (rowsById(t, 'gallery_folder_menu_tv').length > 0) reads += 1
      return reads >= 2
    },
    { budgetMs: 10_000 },
  )
  const tab = draftsTabButton(looked.tree)
  if (!tab) {
    ctx.log.info('the new-post gallery shows no "Draf" tab — no drafts in that list')
    return { found: 0, removed: 0, opened: false }
  }
  await tapCentre(ctx, tab)
  const section = await waitForTree(ctx, (t) => draftsManageButton(t) !== null, { budgetMs: 8_000 })
  const manage = draftsManageButton(section.tree)
  if (!manage) {
    await capture(ctx, 'ig-drafts-no-manage', section.tree)
    fail('E_DRAFTS_NOT_CLEARED', 'the "Draf" tab opened but its "Kelola" button was not found — see artifact ig-drafts-no-manage.')
  }
  await human(500, 1_000)
  await tapCentre(ctx, manage.node)
  const result = await emptyList(ctx, DRAFTS)
  return { ...result, opened: true }
}

/** The Reel gallery's list: "Draf · N" → "Draf Reel", or nothing when the entry is not there. */
async function clearReelDrafts(ctx: ScriptContext<{ dryRun: boolean }>): Promise<{ found: number; removed: number; opened: boolean }> {
  const looked = await waitForTree(ctx, (t) => reelDraftsEntry(t) !== null, { budgetMs: 6_000 })
  const entry = reelDraftsEntry(looked.tree)
  if (!entry || entry.count === 0) {
    ctx.log.info('the Reel gallery shows no drafts entry — no Reel drafts')
    return { found: 0, removed: 0, opened: false }
  }
  await tapCentre(ctx, entry.node)
  const result = await emptyList(ctx, REEL_DRAFTS)
  return { ...result, opened: true }
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'clear-drafts',
  title: 'Clear drafts',
  description: 'Deletes every Instagram draft on this phone\'s account — the new-post gallery\'s drafts and the Reel drafts. Permanent. A dry run only counts them.',
  icon: 'x',
  node: { category: 'device', icon: 'x', summary: ['found', 'removed'], keywords: ['drafts', 'clean', 'delete'] },
  params: paramsSchema,
  result: resultSchema,
  timeout: 8 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const lists: string[] = []
    let found = 0
    let removed = 0
    const add = (name: string, r: { found: number; removed: number; opened: boolean }): void => {
      if (r.opened) lists.push(name)
      found += r.found
      removed += r.removed
    }

    const first = await openCreateGallery(ctx)
    if (gallerySurface(first) === 'reel') {
      add('reel-drafts', await clearReelDrafts(ctx))
      // To the new-post gallery: back to the Reel gallery, then its POSTINGAN destination.
      await backToGallery(ctx, 'reel')
      const feedTab = rowsById(await ctx.device.dump(), 'cam_dest_feed').find((n) => n.bounds.left >= 0 && n.bounds.right > n.bounds.left)
      if (feedTab) {
        await tapCentre(ctx, feedTab)
        const post = await waitForTree(ctx, (t) => gallerySurface(t) === 'post', { budgetMs: 10_000 })
        if (post.ok) add('drafts', await clearNewPostDrafts(ctx))
        else ctx.log.warn('POSTINGAN did not open the new-post gallery — its drafts list was not checked')
      } else {
        ctx.log.warn('the Reel gallery shows no POSTINGAN destination — the new-post gallery\'s drafts were not checked')
      }
    } else {
      add('drafts', await clearNewPostDrafts(ctx))
      // To the Reel gallery: leave the new-post gallery with "Batal", then the profile's "Buat Baru" → Reel.
      await backToGallery(ctx, 'post')
      const left = await leaveNewPostGallery(ctx)
      const reel = left.ok ? await openReelGalleryFromProfile(ctx) : null
      if (reel && gallerySurface(reel.tree) === 'reel') add('reel-drafts', await clearReelDrafts(ctx))
      else ctx.log.warn('the Reel gallery could not be reached from the profile — the Reel drafts were not checked')
    }

    const reason = found === 0 ? 'no drafts to delete' : ctx.params.dryRun ? `dry run: would delete ${found} draft(s)` : `deleted ${removed} draft(s)`
    return { found, removed, lists, dryRun: ctx.params.dryRun, reason }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('ig-drafts-failed').catch(() => {})
    await ctx.device.app.forceStop(INSTAGRAM_PACKAGE, { clearRecents: true })
  },
}

/** From a drafts list (or its section) back to the gallery it was opened from: BACK while that gallery is not drawn. */
async function backToGallery(ctx: ScriptContext<unknown>, surface: 'post' | 'reel'): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const tree = await ctx.device.dump()
    if (gallerySurface(tree) === surface || isReady(tree)) return
    await ctx.device.key('BACK')
    await sleep(1_200)
  }
}

export default script
