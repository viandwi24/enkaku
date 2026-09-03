import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { capture, hasId, isVisible, sleep, tapNode, YOUTUBE_PACKAGE } from './youtube'
import { flatten } from './tree'
import { between, bytesEqual, makeRng, pick, snackbarText } from './behavior'

/**
 * `download-home` — download videos offered by the home feed's own menu.
 *
 * The walk is the one measured on hardware 2026-09-03 (moto g06 power,
 * Indonesian locale): every home row carries an overflow named
 * "Menu tindakan untuk <title>" (some builds: "Opsi lainnya"), the menu that
 * opens carries a `list_item_text` row labelled "Download", and on a device
 * whose account cannot download, tapping it answers with the snackbar
 * **"Download tidak tersedia"** — a real `message` node, not a guess. That
 * snackbar ends the run honestly: `unavailable: true`, downloads 0, reason
 * straight from the screen. Nothing here ever uses a third-party downloader;
 * it presses only YouTube's own button, and sponsored rows — whose "Download"
 * is an install call to action, measured and rejected — are never candidates.
 */

const paramsSchema = z.object({
  videos: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(3)
    .describe('How many different videos to try to download.')
    .meta(ui({ title: 'Videos to download' })),
  scrollBetween: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(2)
    .describe('Randomised flings down the home feed between attempts, so the candidates are different videos.')
    .meta(ui({ title: 'Scroll between' })),
  seed: z.number().int().min(0).default(0).describe('RNG seed; 0 derives one per run.').meta(ui({ title: 'Seed (0 = random)' })),
})

const resultSchema = z.object({
  attempted: z.number().int().describe('Videos whose menu was opened and answered.').meta(ui({ title: 'Attempted', summary: true })),
  started: z.number().int().describe('Downloads this run actually started — only ever true on an account where YouTube allows downloads.').meta(ui({ title: 'Started', summary: true })),
  unavailable: z.boolean().describe('True when YouTube answered "Download tidak tersedia" / "Download unavailable" — the account or video does not offer it.').meta(ui({ title: 'Unavailable', summary: true })),
  notSignedIn: z.boolean().describe('True when the account sheet answered instead of a menu — a signed-out device cannot download.').meta(ui({ title: 'Not signed in', summary: true })),
  reasons: z.array(z.string()).describe('The screen\'s own words per attempt: the snackbar, the menu line, or why nothing happened.').meta(ui({ title: 'Reasons' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

/**
 * A real home-feed video row. Measured description on this build:
 * `Suami - Istri Cerai Rebutan Akun TikTok - 8 menit, 16 detik - Buka channel - Eno Bening - 50 ribu x ditonton`
 * — the duration segment and the channel link are what tell it from banners,
 * shelves and shorts rows.
 */
function isHomeVideoRow(n: UiNode): boolean {
  if (!n.clickable || n.bounds.bottom - n.bounds.top < 200) return false
  const d = n.desc
  return /- \d+ (menit|detik|jam|minute|second)/i.test(d) && /buka channel|open channel/i.test(d)
}

/** The row's own overflow control — both spellings measured on the home feed. */
function overflowFor(tree: UiNode, row: UiNode): UiNode | null {
  const title = row.desc.split(' - ')[0]?.trim().slice(0, 30) ?? ''
  const named = flatten(tree).find((n) => n.clickable && title !== '' && /^Menu tindakan/i.test(n.desc.trim()) && n.desc.toLowerCase().includes(title.toLowerCase()))
  if (named) return named
  return flatten(tree).find((n) => n.clickable && /^(Opsi lainnya|More actions)/i.test(n.desc.trim()) && n.bounds.top >= row.bounds.top && n.bounds.top < row.bounds.bottom) ?? null
}

/** Is the open context menu's "Download" line present — as a menu row (`list_item_text`) first, as any label second. */
function downloadLine(tree: UiNode): UiNode | null {
  const isDownload = (n: UiNode): boolean => n.text.trim().toLowerCase() === 'download' || n.text.trim().toLowerCase() === 'unduh'
  const menuRows = flatten(tree).filter((n) => hasId(n, 'list_item_text'))
  return menuRows.find(isDownload) ?? flatten(tree).find((n) => isVisible(n) && isDownload(n)) ?? null
}

function accountSheetUp(tree: UiNode): boolean {
  return flatten(tree).some((n) => (n.resourceId.endsWith(':id/add_account') || n.resourceId.endsWith(':id/account_list')) && n.bounds.bottom > 0)
}

function isSponsoredRow(row: UiNode): boolean {
  return /^bersponsor|^\s*sponsored/i.test(row.desc.trim()) || /^bersponsor|^\s*sponsored/i.test(row.text.trim())
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'download-home',
  title: 'Download home videos',
  description: 'Walks the home feed, opens each video\'s own overflow menu, and presses YouTube\'s Download — reporting the account\'s real answer, including "Download tidak tersedia".',
  params: paramsSchema,
  result: resultSchema,
  timeout: 15 * 60_000,

  async prepare(ctx) {
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
    await ctx.device.app.launch(YOUTUBE_PACKAGE)
    await sleep(5_000)
  },

  async run(ctx) {
    const rng = makeRng(ctx.params.seed || Date.now() >>> 0)
    const steps: string[] = []
    const reasons: string[] = []
    let attempted = 0
    let started = 0
    let unavailable = false
    let notSignedIn = false

    for (let round = 0; round < ctx.params.videos; round++) {
      ctx.progress({ round: round + 1, of: ctx.params.videos, steps })
      let tree = await ctx.device.dump()

      // A row that is a real video (not a sponsored install card), with its overflow on screen.
      const row = flatten(tree).find((n) => isHomeVideoRow(n) && !isSponsoredRow(n))
      if (!row) {
        steps.push(`round ${round + 1}: no candidate row`)
      } else {
        const overflow = overflowFor(tree, row)
        if (!overflow) {
          steps.push(`round ${round + 1}: no overflow on screen`)
        } else {
          await tapNode(ctx, overflow)
          await sleep(between(rng, 1_000, 1_800))
          const menu = await capture(ctx, `0${round + 1}-menu`)
          attempted += 1

          if (accountSheetUp(menu)) {
            notSignedIn = true
            reasons.push('akun: the account sheet answered the overflow — this device is signed out')
            steps.push(`round ${round + 1}: not-signed-in`)
            await ctx.device.key('BACK')
            await sleep(800)
            break
          }

          const line = downloadLine(menu)
          if (!line) {
            reasons.push('menu terbuka tanpa baris Download')
            steps.push(`round ${round + 1}: no-download-line`)
            await ctx.device.key('BACK')
            await sleep(800)
          } else {
            const before = await ctx.device.screenshot()
            await tapNode(ctx, line)
            await sleep(between(rng, 1_500, 2_800))
            const after = await capture(ctx, `0${round + 1}-answer`)
            const snack = snackbarText(after)
            const text = snack.toLowerCase()
            if (text.includes('tidak tersedia') || text.includes('unavailable')) {
              unavailable = true
              reasons.push(snack)
              steps.push(`round ${round + 1}: unavailable`)
              break
            } else if (text.includes('mulai') || text.includes('added') || text.includes('ditambahkan') || text.includes('started')) {
              started += 1
              reasons.push(snack || 'menu closed with a Download confirmation')
              steps.push(`round ${round + 1}: started`)
            } else if (bytesEqual(before, await ctx.device.screenshot())) {
              reasons.push(snack || 'layar tidak berubah setelah menekan Download')
              steps.push(`round ${round + 1}: no-change`)
            } else {
              started += 1
              reasons.push(snack || 'menu closed and the screen changed (assumed started, not confirmed)')
              steps.push(`round ${round + 1}: started(unconfirmed)`)
            }
          }
        }
      }

      if (round < ctx.params.videos - 1) {
        for (let s = 0; s < ctx.params.scrollBetween; s++) {
          await ctx.device.fling({ direction: 'down', strength: pick(rng, ['soft', 'normal'] as const) })
          await sleep(between(rng, 1_200, 2_800))
        }
      }
    }

    steps.push('done')
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
    return { attempted, started, unavailable, notSignedIn, reasons, steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
  },
}

export default script
