import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { GroupSchema, groupKeyFor, planSchedule } from './groups'
import { POST_PREFIX, PostSchema, type Post } from './posts'

/**
 * Press Start: hand the group's rows their turns.
 *
 * ## Why starting is stamping, not sending
 *
 * Nothing is dispatched here. Each row is stamped with the instant it becomes
 * eligible (`notBeforeAt`) and the ROUTER sends it when that instant arrives,
 * subject to the group's `concurrency` and to a phone actually being free.
 * Three things follow, and all three are the reason it is built this way:
 *
 * - a group survives anything — a plugin restart, a re-activated version, a
 *   core restart — because the schedule is data on the rows, not a timer in
 *   memory;
 * - "Start" answers instantly for forty videos, because it writes forty rows
 *   rather than waiting on forty phones;
 * - the farm is never flooded: the first video is due now, the fortieth is due
 *   about forty gaps from now.
 *
 * ## Starting twice is not starting again
 *
 * A row that already has a turn keeps it. So pressing Start on a group that is
 * half-done re-stamps ONLY what never got a turn, and a video already posted
 * is not re-posted — the run's own history decides, not the button.
 */

const params = z.object({
  groupId: z
    .string()
    .min(1)
    .describe('The group to start.')
    .meta(ui({ title: 'Group' })),
  restamp: z
    .boolean()
    .default(false)
    .describe('Also re-time rows that already have a turn but have not sent yet. Use it after changing your mind about the pacing; it never re-sends anything already posted.')
    .meta(ui({ title: 'Re-time waiting rows' })),
})

const result = z.object({
  groupId: z.string().meta(ui({ title: 'Group', summary: true })),
  title: z.string().meta(ui({ title: 'Title', summary: true })),
  started: z.number().int().describe('How many rows were given a turn.').meta(ui({ title: 'Started', summary: true })),
  alreadyRunning: z.number().int().describe('Rows that already had a turn and were left alone.').meta(ui({ title: 'Already going' })),
  settled: z.number().int().describe('Rows with nothing left to send.').meta(ui({ title: 'Done already' })),
  firstAt: z.number().int().describe('Unix seconds: when the first row becomes eligible.').meta(ui({ title: 'First turn' })),
  lastAt: z.number().int().describe('Unix seconds: when the last row becomes eligible.').meta(ui({ title: 'Last turn' })),
})

/** A row still has something to send when any of its platforms has never been handed to phones. */
function hasWorkLeft(post: Post): boolean {
  return post.platforms.some((id) => (post.dispatch[id]?.state ?? 'pending') === 'pending')
}

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'start-group',
  title: 'Start group',
  description: 'Gives every waiting video in the group its turn, spaced by the gap you chose. The router sends them as the turns come round.',
  icon: 'play',
  params,
  result,
  timeout: 180_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const group = await ctx.storage.global.get(groupKeyFor(ctx.params.groupId), GroupSchema)
    if (!group) {
      throw Object.assign(new Error(`No group called "${ctx.params.groupId}" — it may have been removed.`), { code: 'E_NOT_FOUND' })
    }

    // The group's own rows, read through the schema: a row this build cannot
    // parse is left alone rather than rewritten, the same rule the router keeps.
    const rows: { key: string; post: Post }[] = []
    let cursor: string | null = null
    do {
      const opts: { prefix: string; limit: number; cursor?: string } = { prefix: POST_PREFIX, limit: 500 }
      if (cursor !== null) opts.cursor = cursor
      const page = await ctx.storage.global.list(opts)
      for (const entry of page.items) {
        const parsed = PostSchema.safeParse(entry.value)
        if (parsed.success && parsed.data.groupId === group.id) rows.push({ key: entry.key, post: parsed.data })
      }
      cursor = page.nextCursor
    } while (cursor !== null)

    const now = Math.floor(Date.now() / 1000)
    const waiting = rows.filter((r) => hasWorkLeft(r.post))
    const toStamp = waiting.filter((r) => r.post.notBeforeAt === null || ctx.params.restamp)
    const alreadyRunning = waiting.length - toStamp.length
    const settled = rows.length - waiting.length

    if (toStamp.length === 0) {
      ctx.log.info('nothing to start in this group', { groupId: group.id, rows: rows.length, alreadyRunning, settled })
      return { groupId: group.id, title: group.title, started: 0, alreadyRunning, settled, firstAt: now, lastAt: now }
    }

    /*
      The schedule is planned over the videos that still need one, in the
      group's own order — so a group started, half-posted and started again
      paces what is LEFT rather than replaying the original forty turns.
    */
    const schedule = planSchedule({
      videoArtifactIds: toStamp.map((r) => r.post.videoArtifactId),
      pacing: group.pacing,
      startAt: now,
    })
    const byVideo = new Map(schedule.map((s) => [s.videoArtifactId, s.notBeforeAt]))

    for (const row of toStamp) {
      const at = byVideo.get(row.post.videoArtifactId)
      if (at === undefined) continue
      await ctx.storage.global.set(row.key, { ...row.post, notBeforeAt: at })
    }

    const times = schedule.map((s) => s.notBeforeAt)
    const firstAt = Math.min(...times)
    const lastAt = Math.max(...times)
    ctx.log.info('group started', {
      groupId: group.id,
      title: group.title,
      started: toStamp.length,
      alreadyRunning,
      settled,
      spreadOverMin: Math.round((lastAt - firstAt) / 60),
      concurrency: group.pacing.concurrency,
    })
    return { groupId: group.id, title: group.title, started: toStamp.length, alreadyRunning, settled, firstAt, lastAt }
  },
}

export default script
