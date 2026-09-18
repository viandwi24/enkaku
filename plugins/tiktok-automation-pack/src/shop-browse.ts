import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { between, makeRng, sleep } from './human'
import { all } from './tree'
import { capture, frameOf, jitteredPoint, navMissingReason, readableStrings, relaunch, TIKTOK_PACKAGE, verifiedPageDown } from './gesture'

/** How long to keep looking for the shop after tapping its tab. */
const SHOP_OPEN_TIMEOUT_MS = 20_000

/**
 * Whether this tree is the shop rather than whatever preceded it — the
 * consent gate or the category strip, since either one means it arrived.
 * Both labels are the ones the strip and the gate actually carry here; the
 * gate is already bilingual below, and the first chip is `Semua` on an
 * Indonesian install and `All` on an English one (both measured — see
 * `SHOP_FIRST_CHIP`).
 */
/*
  The category strip's first chip, in both languages, and in a band wide enough for both builds
  (1.49.11).

  Two things were wrong here, and finding only the first would have looked like a fix. Measured on
  the owner's moto g06 with TikTok in `en-US`, from the tree this member saved when it failed
  (`shop-missing`, 297 nodes):

    'All'               clickable  [14,650][78,720]
    'Beauty'            clickable  [417,650]
    "Women's Clothing"  clickable  [536,650]

  So (1) the chip reads `All`, not `Semua`, and (2) it sits at y=650 — OUTSIDE the 800..1300 band
  this file demanded. The strip was drawn, readable and clickable, and both checks missed it, which
  is why the member reported "the shop opened neither on a consent gate nor on a readable category
  strip" over a perfectly good shop.

  The band is widened rather than moved, because both readings are real: 800..1300 came off the
  Indonesian build on 2026-09-03, 650 off this English one on 2026-09-17. 300 keeps the search bar
  out (measured at y 85..139) and 1400 keeps the bottom nav out (1470..1556).
*/
const SHOP_FIRST_CHIP: readonly string[] = ['Semua', 'All']
const CHIP_BAND_TOP = 300
const CHIP_BAND_BOTTOM = 1_400

function isFirstChip(n: UiNode): boolean {
  return n.clickable && SHOP_FIRST_CHIP.includes(n.text.trim()) && n.bounds.top > CHIP_BAND_TOP && n.bounds.top < CHIP_BAND_BOTTOM
}

function hasShopSurface(tree: UiNode): boolean {
  const gate = all(tree, (n) => n.clickable && /^(Lanjutkan|Continue)$/.test((n.text || n.desc).trim()))
  if (gate.length > 0) return true
  return all(tree, isFirstChip).length > 0
}

/**
 * `shop-browse` — open TikTok Shop and browse it as a viewer.
 *
 * Measured on hardware 2026-09-03 (moto g06 power, Indonesian build): the
 * bottom-nav `Toko` item opens a page that, the FIRST time, is a Tokopedia
 * consent gate ("Layanan disediakan oleh PT Tokopedia") whose only action is
 * `Lanjutkan` — a pass-through to the shop's own terms, which the operator
 * asked this script to reach, and which the script therefore reports in its
 * result rather than hiding. Past the gate, the readable content is the
 * category strip (`Semua / Kecantikan / Pakaian Wanita …`); the product grid
 * is as opaque to the inspector as every other Compose surface in this app,
 * so browsing is verified page turns plus a screenshot per screen, and
 * NOTHING is ever tapped on a product, a price, or a "Beli" control.
 *
 * `category` is the one permitted navigation: a named strip chip, matched
 * against the category strip's measured bounds only.
 */

/** The bottom-nav Shop item, in both languages TikTok ships on these phones (1.49.9). */
const SHOP_TAB_DESCS: readonly string[] = ['Toko', 'Shop']

const paramsSchema = z.object({
  scrolls: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(6)
    .describe('Verified page turns down the product feed.')
    .meta(ui({ title: 'Scrolls' })),
  category: z
    .string()
    .default('')
    .describe('Optional chip from the category strip to open (e.g. "Kecantikan"). Empty stays on "Semua". Never matched against anything but the strip.')
    .meta(ui({ title: 'Category (optional)' })),
})

const resultSchema = z.object({
  reached: z.string().describe('Which evidence proved the shop was actually on screen: the consent gate, or the category strip.').meta(ui({ title: 'Reached', summary: true })),
  consentPassed: z.boolean().describe('Whether the run pressed the first-run Tokopedia "Lanjutkan" gate.').meta(ui({ title: 'Consent passed', summary: true })),
  scrollsDone: z.number().int().meta(ui({ title: 'Scrolls' })),
  scrollsMoved: z.number().int().describe('Page turns proven by a screenshot change.').meta(ui({ title: 'Moved', summary: true })),
  categoryOpened: z.string().describe('The category chip that was opened, empty when none was asked or the chip was not on the strip.').meta(ui({ title: 'Category' })),
  readableSample: z.array(z.string()).describe('What the inspector could read on the last screen — chips and chrome; products are Compose-invisible on this build, which the number says out loud.').meta(ui({ title: 'Readable sample' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

/** The category strip lives directly below the search bar; measured on y∈[919,989] of 1640, so the band test is "top edge in the top 40%, label short". */
function categoryChip(tree: UiNode, name: string): UiNode | null {
  const needle = name.trim().toLowerCase()
  return all(tree, (n) => n.clickable && n.text.trim().toLowerCase() === needle && n.bounds.top > 800 && n.bounds.top < 1_300)[0] ?? null
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'shop-browse',
  /** Plan 310 §3.3 — the script's own icon; `node.icon` (same value) stays as a fallback read for a core older than this plan. */
  icon: 'boxes',
  node: { category: 'device', icon: 'boxes', summary: ['scrolls'], keywords: ['shop', 'browse'] },
  title: 'Browse TikTok Shop',
  description: 'Opens the Shop tab (passing and REPORTING the first-run Tokopedia consent), browses the feed with verified randomised swipes, optionally opens one category chip — and never touches a product, price, or purchase control.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 15 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const rng = makeRng(Date.now() >>> 0)
    const steps: string[] = []

    // The bottom-nav Toko item — located by desc INSIDE the nav band, so it can never be the
    // results-page tab that shares its description (see `search-keyword`'s note).
    const nav = await ctx.device.dump()
    // Both spellings (1.49.9). Measured on the owner's moto g06, whose TikTok runs `en-US`: the
    // bottom nav reads `Home, Shop, Create, Inbox, Profile`. Before this, `shop-browse` failed on
    // that phone with "the Toko tab was not on the bottom navigation" while the tab was plainly
    // drawn — it just said "Shop". The `top > 1_400` band is kept: it is what stops this matching a
    // "Toko" written anywhere else on the page, and it is not language-bound.
    const tab = all(nav, (n) => n.clickable && SHOP_TAB_DESCS.includes(n.desc.trim()) && n.bounds.top > 1_400)[0]
    if (!tab) throw new Error(navMissingReason(nav, SHOP_TAB_DESCS.join('/')))
    await ctx.device.tap({ point: jitteredPoint(tab, rng) })

    /*
      Poll for the shop, do not sleep a guess at it.

      This was `sleep(3_000..5_000)` followed by ONE dump: whatever the screen
      held at that instant decided the run. TikTok Shop is a network-loaded
      surface on a budget phone, and three to five seconds is optimistic —
      the owner's farm failed here twice in one batch with the dump showing
      the FEED, i.e. the tab had simply not opened yet (2026-09-07). The
      consent gate and the category strip are both looked for on every pass,
      because either one means the shop arrived.
    */
    let consentPassed = false
    let reached = ''
    let gate = await ctx.device.dump()
    const openDeadline = Date.now() + SHOP_OPEN_TIMEOUT_MS
    while (Date.now() < openDeadline && !hasShopSurface(gate)) {
      await sleep(1_000)
      gate = await ctx.device.dump()
    }
    const lanjutkan = all(gate, (n) => n.clickable && /^(Lanjutkan|Continue)$/.test((n.text || n.desc).trim()))[0]
    if (lanjutkan) {
      consentPassed = true
      await ctx.device.tap({ point: jitteredPoint(lanjutkan, rng) })
      await sleep(between(rng, 5_000, 8_000))
      gate = await ctx.device.dump()
      steps.push('consent-gate passed (Lanjutkan)')
    }

    const chips = all(gate, isFirstChip)
    if (chips.length > 0) reached = `category strip (${chips[0]?.text.trim() ?? SHOP_FIRST_CHIP[0]} chip visible)`
    else if (consentPassed) reached = 'consent passed, strip not confirmed'
    else {
      await capture(ctx, 'shop-missing')
      throw new Error('the shop opened neither on a consent gate nor on a readable category strip — see artifact shop-missing')
    }
    steps.push(reached)

    let categoryOpened = ''
    if (ctx.params.category.trim() !== '') {
      const chip = categoryChip(gate, ctx.params.category)
      if (chip) {
        await ctx.device.tap({ point: jitteredPoint(chip, rng) })
        await sleep(between(rng, 3_000, 5_000))
        categoryOpened = ctx.params.category.trim()
        steps.push(`category:${categoryOpened}`)
      } else {
        steps.push(`category-not-on-strip:${ctx.params.category.trim()}`)
      }
    }

    const frame = await frameOf(ctx)
    let scrollsMoved = 0
    for (let i = 0; i < ctx.params.scrolls; i++) {
      ctx.progress({ scroll: i + 1, of: ctx.params.scrolls, steps })
      if (await verifiedPageDown(ctx, frame, rng)) scrollsMoved += 1
      steps.push(`scroll ${i + 1}`)
      await sleep(between(rng, 500, 1_500))
    }

    const last = await capture(ctx, 'shop-last')
    const readable = readableStrings(last, 240).slice(0, 12)

    return { reached, consentPassed, scrollsDone: ctx.params.scrolls, scrollsMoved, categoryOpened, readableSample: readable, steps }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(TIKTOK_PACKAGE)
  },
}

export default script
