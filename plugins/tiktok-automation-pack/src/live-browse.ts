import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { between, makeRng, sleep } from './human'
import { searchFor } from './search'
import { clearBlockingDialog } from './dialogs'
import { bytesEqual, capture, captureSafe, frameOf, readGate, relaunch, snapshot, TIKTOK_PACKAGE, verifiedPageDown } from './gesture'

/**
 * `live-browse` — scroll TikTok's LIVE results and optionally sit in one room.
 *
 * Entry is a keyword search on the LIVE tab (the query defaults to "live";
 * measured 2026-09-03 the tab strip is `Teratas / LIVE / Pengguna / Video /
 * Toko / Tempat` and the LIVE tab confirms selection by the pack's
 * clickable:false rule). Everything past that point is built on the two facts
 * that probe measured:
 *
 * 1. The results GRID exposes no labels to the inspector at all — browsing it
 *    is verified page turns (screenshot byte-diff), never anchor taps.
 * 2. A live ROOM inside is opaque too — worse than the grid: the last readable
 *    tree (a policy-consent popup) stayed stale while the room played behind
 *    it. So "am I in a live stream" is answered by MOTION: two screenshots a
 *    few seconds apart differ exactly when the stream is moving, and the room
 *    is exited with BACK without tapping anything in it. The one thing that
 *    never happens here: touching the gift, follow, or comment row of a live
 *    room, all of which sit at the bottom edge a swipe could otherwise reach.
 */

const paramsSchema = z.object({
  query: z
    .string()
    .min(1)
    .default('live')
    .describe('Keyword searched before switching to the LIVE tab.')
    .meta(ui({ title: 'Search keyword' })),
  scrolls: z
    .number()
    .int()
    .min(0)
    .max(30)
    .default(5)
    .describe('Verified page turns down the results grid before opening a room.')
    .meta(ui({ title: 'Scrolls' })),
  open: z
    .enum(['none', 'one'])
    .default('one')
    .describe('Stop after browsing, or tap one grid cell by measured geometry and watch it.')
    .meta(ui({ title: 'Open a room', labels: { none: 'No — browse only', one: 'Open one and watch' } })),
  watchMs: z
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .default(60_000)
    .describe('How long to stay in the room. Ignored when not opening.')
    .meta(ui({ title: 'Watch for (ms)' })),
})

const resultSchema = z.object({
  query: z.string().meta(ui({ title: 'Keyword', summary: true })),
  scrollsDone: z.number().int().describe('Page turns attempted.').meta(ui({ title: 'Scrolls', summary: true })),
  scrollsMoved: z.number().int().describe('Page turns PROVEN by a screenshot change.').meta(ui({ title: 'Moved', summary: true })),
  opened: z.boolean().meta(ui({ title: 'Room opened' })),
  playing: z
    .boolean()
    .describe('True only when two screenshots inside the room differed — the stream moving. The inspector cannot see a live room on this build; motion is the honest proof and a still room says `false`.')
    .meta(ui({ title: 'Stream moving', summary: true })),
  evidence: z.string().meta(ui({ title: 'Evidence', summary: true })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'live-browse',
  title: 'Browse TikTok LIVE',
  description: 'Searches the keyword, turns the LIVE results grid with verified randomised swipes, and optionally watches one room — proving it plays by screenshot motion, touching nothing inside.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 20 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const rng = makeRng(Date.now() >>> 0)
    const steps: string[] = []

    await searchFor(ctx, ctx.params.query, 'LIVE')
    steps.push('live-tab')
    const grid = await capture(ctx, 'live-grid')
    steps.push(`grid readable labels below tabs: 0 (measured Compose opacity) — first readable nodes: ${grid.children.length}`)
    const frame = await frameOf(ctx)

    let scrollsMoved = 0
    for (let i = 0; i < ctx.params.scrolls; i++) {
      ctx.progress({ scroll: i + 1, of: ctx.params.scrolls, steps })
      const moved = await verifiedPageDown(ctx, frame, rng)
      if (moved) scrollsMoved += 1
      steps.push(`scroll ${i + 1}${moved ? '' : ' (no move)'}`)
      await sleep(between(rng, 600, 1_800))
    }

    if (ctx.params.open === 'none') {
      return { query: ctx.params.query, scrollsDone: ctx.params.scrolls, scrollsMoved, opened: false, playing: false, evidence: 'not requested', steps }
    }

    // Tap a first-row cell by the same inferred geometry `keyword-videos` documents; the grid's
    // cells are unlabelled, and saying WHICH cell was aimed at is how the next build that moves
    // the grid becomes a measured fact instead of a mystery.
    const col = Math.floor(rng() * 2)
    await ctx.device.tap({ point: { x: Math.round((col === 0 ? 0.27 : 0.73) * frame.width + between(rng, -0.04, 0.04) * frame.width), y: Math.round((0.4 + between(rng, -0.03, 0.03)) * frame.height) } })
    steps.push(`tapped cell ${col + 1},1 (inferred grid geometry)`)
    await sleep(between(rng, 4_000, 7_000))

    // A policy-consent popup sits in front of the first room (measured). It is `setCancelable(false)`
    // — BACK cannot close it — so the ONE safe tap here is its "Mengerti" label, via the pack's
    // existing closed-allowlist sweep. Nothing else in a room is ever tapped. The sweep's own finds
    // cannot throw on this device — an unreachable inspector reads as "not-found" (dialogs.ts).
    await clearBlockingDialog(ctx, { allowBack: false })

    // Measured twice in a row (jobs f2f45632 and dd278a4c, 2026-09-03): entering a live room KILLS
    // the ui-server — `/screenshot/0` goes from answering to refusing within the room. So through
    // the whole dwell this run takes at most a few screenshots, every one of them optional: a dead
    // inspector is one outcome, a still room another, and neither is ever reported as the other.
    const frames: Uint8Array[] = []
    for (let waited = 0; waited < ctx.params.watchMs; waited += 4_000) {
      await sleep(Math.min(4_000, ctx.params.watchMs - waited))
      const shot = await snapshot(ctx)
      if (shot) frames.push(shot)
      ctx.progress({ frames: frames.length, steps })
    }
    let playing = false
    let framesAlive = frames.length >= 2
    for (let i = 1; i < frames.length && !playing; i++) playing = !bytesEqual(frames[i - 1] as Uint8Array, frames[i] as Uint8Array)
    if (framesAlive) steps.push(playing ? 'room moving (screenshot diff)' : 'room frames identical — motion not confirmed')
    else steps.push('inspector unresponsive inside the room (measured behaviour of live rooms on this device)')

    // Leave by BACK, not by any control inside the room — the X at the room's top-right is the app's
    // own exit and is a tap the inspector may not even report (rooms are opaque), so BACK is the
    // only exit this script trusts. BACK is a key event; it needs no inspector.
    await ctx.device.key('BACK')
    steps.push('left room (BACK)')

    // Then WAIT for the inspector to come back — the room may have taken it down, and the next
    // thing this run does is try to prove the device survived. A bounded poll, never a bare sleep.
    const recovered = await readGate(ctx, () => true, { budgetMs: 25_000, intervalMs: 2_500 })
    let evidence: string
    if (!framesAlive) {
      evidence = recovered
        ? 'entered a room by inferred cell geometry; the inspector died inside it (measured twice on this device) and recovered after BACK — the room itself could not be observed'
        : 'entered a room by inferred cell geometry; the inspector died inside it and had not recovered by the budget — the run exits blind and says so'
    } else {
      evidence = playing ? 'screenshot motion — two frames differed' : 'room frames identical — motion could not be confirmed'
    }
    if (recovered) await captureSafe(ctx, 'after-room')

    return {
      query: ctx.params.query,
      scrollsDone: ctx.params.scrolls,
      scrollsMoved,
      opened: true,
      playing,
      evidence,
      steps,
    }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(TIKTOK_PACKAGE)
  },
}

export default script
