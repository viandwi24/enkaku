import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { between, makeRng, sleep } from './human'
import { all } from './tree'
import { clearBlockingDialog } from './dialogs'
import { bytesEqual, capture, frameOf, jitteredPoint, relaunch, snapshot, TIKTOK_PACKAGE, verifiedPageDown } from './gesture'

/**
 * `notification-activity` — open the Inbox ("Kotak Masuk"), read what the
 * account's activity actually says, and put it in the job's result.
 *
 * Measured 2026-09-03 on this farm's device: the bottom nav carries the unread
 * badge as its own text node (`99+` inside the tab's x-range), the first visit
 * is blocked by the system "Simpan info login untuk lain waktu?" sheet — whose
 * refusal button, "Tidak sekarang", became a new `ACK_SELECTORS` rung this
 * version — and the inbox itself is a list of SECTIONS the inspector reads in
 * full: `Pengikut baru`, `Aktivitas`, `Notifikasi sistem`, `Permintaan pesan`,
 * `Pesan toko`, each with its newest line beside it (`Hadi_10_ berkomentar:
 * amin`). Opening the Aktivitas section is the only tap beyond the nav itself;
 * no thread, no message request, and never the "Simpan info login" grant.
 */

const paramsSchema = z.object({
  scrolls: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(3)
    .describe('Verified page turns through the activity list after opening the section.')
    .meta(ui({ title: 'Scrolls' })),
  maxItems: z
    .number()
    .int()
    .min(5)
    .max(200)
    .default(40)
    .describe('Cap on the number of activity lines collected into the result.')
    .meta(ui({ title: 'Max items' })),
})

const resultSchema = z.object({
  unreadBadge: z.string().describe('The nav badge the run saw on the way in ("99+", a number, or empty when there was none).').meta(ui({ title: 'Unread badge', summary: true })),
  sections: z.array(z.string()).describe('The inbox section names the tree reported, in screen order — the "show" part, verbatim.').meta(ui({ title: 'Sections', summary: true })),
  activityOpened: z.boolean().describe('Whether the Aktivitas section itself opened (the screen changed after the tap).').meta(ui({ title: 'Activity opened', summary: true })),
  items: z.array(z.string()).describe('Activity lines read off the screens, first-seen order, up to `maxItems` — the app’s own words.').meta(ui({ title: 'Items' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const SECTION_NAMES = ['pengikut baru', 'aktivitas', 'notifikasi sistem', 'permintaan pesan', 'tiktok tako', 'pesan toko', 'followers new', 'activity', 'system notifications', 'message requests']

/** A line that reads as an ACTIVITY ENTRY rather than a header, nav label, or clock. */
function isActivityLine(value: string): boolean {
  const v = value.trim()
  if (v === '' || v.toLowerCase() === 'aktivitas') return false
  return /berkomentar|mengikuti|menyukai|mention|mengirim|berlangganan|followed you|commented|liked|replied/i.test(v)
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'notification-activity',
  node: { category: 'inspect', icon: 'bell', summary: ['scrolls', 'maxItems'], keywords: ['notification', 'inbox', 'activity'] },
  title: 'Show notification activity',
  description: 'Opens the Inbox, reports the unread badge and section list, opens the Aktivitas section and reads its entries — reporting them, tapping nothing beyond the section itself.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 8 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const rng = makeRng(Date.now() >>> 0)
    const steps: string[] = []

    // --- the nav: badge first, then the tap -------------------------------------------------
    const home = await ctx.device.dump()
    const inbox = all(home, (n) => n.clickable && n.desc.trim() === 'Kotak Masuk' && n.bounds.top > 1_400)[0]
    if (!inbox) throw new Error('the Kotak Masuk tab was not on the bottom navigation — see the first artifact')
    const badge = all(home, (n) => /^\d+\+?$/.test(n.text.trim()) && n.bounds.top >= inbox.bounds.top && n.bounds.bottom <= inbox.bounds.bottom + 2 && n.bounds.left >= inbox.bounds.left - 2 && n.bounds.right <= inbox.bounds.right + 2)[0]?.text.trim() ?? ''
    await ctx.device.tap({ point: jitteredPoint(inbox) })
    await sleep(between(rng, 2_500, 4_000))

    // The "Simpan info login" sheet and anything else standing in the way: closed-allowlist
    // refusals only, never the grant button beside them.
    await clearBlockingDialog(ctx, { allowBack: false })
    await sleep(1_000)

    // --- the inbox: sections and their newest lines ------------------------------------------
    const sheet = await capture(ctx, 'inbox')
    const sections: string[] = []
    for (const n of all(sheet, (n) => SECTION_NAMES.includes(n.desc.trim().toLowerCase()) || SECTION_NAMES.includes(n.text.trim().toLowerCase()))) {
      const name = (n.text || n.desc).trim()
      if (!sections.some((s) => s.toLowerCase() === name.toLowerCase())) sections.push(name)
    }
    steps.push(`sections: ${sections.join(', ')}`)

    const items = new Set<string>()
    const collect = (tree: UiNode) => {
      for (const n of all(tree, (v) => isActivityLine(v.desc) || isActivityLine(v.text))) items.add((n.desc || n.text).trim())
    }
    collect(sheet)

    // --- open the Aktivitas section, proved by the screen changing -----------------------------
    const activity = all(sheet, (n) => (n.text || n.desc).trim().toLowerCase() === 'aktivitas')[0]
    let activityOpened = false
    if (activity) {
      const before = await snapshot(ctx)
      await ctx.device.tap({ point: jitteredPoint(activity) })
      for (let i = 0; i < 6 && !activityOpened; i++) {
        await sleep(800)
        const now = await snapshot(ctx)
        activityOpened = !!(before && now && !bytesEqual(before, now))
      }
      steps.push(activityOpened ? 'aktivitas opened' : 'aktivitas tap did not change the screen — reading the inbox instead')

      if (activityOpened) {
        const frame = await frameOf(ctx)
        collect(await capture(ctx, 'activity'))
        for (let i = 0; i < ctx.params.scrolls && items.size < ctx.params.maxItems; i++) {
          ctx.progress({ items: items.size, steps })
          if (await verifiedPageDown(ctx, frame, rng)) collect(await capture(ctx, `activity-${i + 2}`))
          else {
            steps.push(`scroll ${i + 1}: no change — end of list`)
            break
          }
        }
      }
    } else {
      steps.push('no Aktivitas section on screen — the inbox already carries each section’s newest line')
    }

    return { unreadBadge: badge, sections, activityOpened, items: [...items].slice(0, ctx.params.maxItems), steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(TIKTOK_PACKAGE)
  },
}

export default script
