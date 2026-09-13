import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { GroupSchema, groupKeyFor, planSchedule } from './groups'
import { POST_PREFIX, PostSchema, failedDevices, rollUp, type Attempt, type Post } from './posts'

/**
 * Try the whole batch again — but only the parts that failed.
 *
 * ## Why a group needs its own retry
 *
 * With forty videos, "Re-run failed" per row is forty decisions and forty
 * clicks, and the operator's actual intent is one sentence: *everything that
 * did not go out, send it again*. This is that sentence.
 *
 * ## What it will not do
 *
 * - It never re-sends a phone that POSTED. The failed set comes from the
 *   row's own attempts (`failedDevices`), which is the same rule
 *   `retry-failed` keeps, and for the same reason: posting a video twice to
 *   one account cannot be taken back.
 * - It never re-sends an `unverified` attempt. That is a phone whose script
 *   could not confirm the post landed, and it may well have — those stay for
 *   a person to look at, and the result says how many were left alone.
 * - It never touches another group's rows, or an ungrouped one.
 *
 * The retried rows are re-paced with the group's own gaps, so a retry of
 * thirty failures is thirty staggered turns rather than thirty phones at once.
 */

const params = z.object({
  groupId: z.string().min(1).describe('The group to retry.').meta(ui({ title: 'Group' })),
})

const result = z.object({
  groupId: z.string().meta(ui({ title: 'Group', summary: true })),
  title: z.string().meta(ui({ title: 'Title', summary: true })),
  rows: z.number().int().describe('Rows re-queued.').meta(ui({ title: 'Rows re-queued', summary: true })),
  phones: z.number().int().describe('Phone attempts re-queued across those rows.').meta(ui({ title: 'Phones' })),
  leftAlone: z.number().int().describe('Attempts left alone because they posted, or could not be confirmed.').meta(ui({ title: 'Left alone', summary: true })),
})

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'retry-group',
  title: 'Retry failed in group',
  description:
    'Re-queues every phone in this group whose upload failed, spaced by the group\'s own gaps. Phones that posted are left alone, and so is anything that could not be confirmed.',
  icon: 'refresh-cw',
  params,
  result,
  timeout: 180_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const group = await ctx.storage.global.get(groupKeyFor(ctx.params.groupId), GroupSchema)
    if (!group) {
      throw Object.assign(new Error(`No group called "${ctx.params.groupId}" — it may have been removed.`), { code: 'E_NOT_FOUND' })
    }

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
    const rewritten: { key: string; post: Post; videoArtifactId: string }[] = []
    let phones = 0
    let leftAlone = 0

    for (const { key, post } of rows) {
      const dispatch: Post['dispatch'] = { ...post.dispatch }
      let touched = false

      for (const platformId of post.platforms) {
        const state = post.dispatch[platformId]
        if (!state) continue
        const failed = failedDevices(state)
        if (failed.length === 0) {
          // Nothing to retry here — but count what is deliberately untouched,
          // so the operator can see that "3 left alone" is a decision, not a miss.
          leftAlone += state.attempts.filter((a) => a.state === 'success' || a.state === 'unverified').length
          continue
        }
        const kept: Attempt[] = state.attempts.filter((a) => a.state !== 'failed')
        leftAlone += kept.filter((a) => a.state === 'success' || a.state === 'unverified').length
        phones += failed.length
        dispatch[platformId] = { ...state, attempts: kept, state: rollUp(kept), deviceCount: kept.length, note: null }
        touched = true
      }

      if (touched) rewritten.push({ key, post: { ...post, dispatch }, videoArtifactId: post.videoArtifactId })
    }

    if (rewritten.length === 0) {
      ctx.log.info('nothing failed in this group', { groupId: group.id, rows: rows.length, leftAlone })
      return { groupId: group.id, title: group.title, rows: 0, phones: 0, leftAlone }
    }

    /*
      Re-paced with the group's own gaps. A retry of thirty failures is thirty
      staggered turns — the same reason the first run was staggered, and the
      moment it matters most, because a batch that failed for a fleet-wide
      reason (the farm offline, an app updated) will otherwise retry thirty
      phones in the same second.
    */
    const schedule = planSchedule({
      videoArtifactIds: rewritten.map((r) => r.videoArtifactId),
      pacing: group.pacing,
      startAt: now,
    })
    const byVideo = new Map(schedule.map((s) => [s.videoArtifactId, s.notBeforeAt]))

    for (const row of rewritten) {
      await ctx.storage.global.set(row.key, { ...row.post, notBeforeAt: byVideo.get(row.videoArtifactId) ?? now })
    }

    ctx.log.info('group retry queued', { groupId: group.id, title: group.title, rows: rewritten.length, phones, leftAlone })
    return { groupId: group.id, title: group.title, rows: rewritten.length, phones, leftAlone }
  },
}

export default script
