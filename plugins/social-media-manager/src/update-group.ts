import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { GroupSchema, editPacing, groupKeyFor, retimeTurns } from './groups'
import { POST_PREFIX, PostSchema, type Post } from './posts'

/**
 * Change a session's pacing after it was created (0.30.0): how many videos go at once, and the gap between turns.
 *
 * The owner (2026-09-15): "4 at a time, 30–120 s apart" was fixed the moment a session was made. The two halves take
 * effect differently, and that is why this member exists rather than an edit of the stored row alone:
 *
 * - **At once** is read by the router from the session row on every tick, so storing it is enough — it applies to the
 *   next video the router considers.
 * - **The gap** is baked into each video's turn (`notBeforeAt`) when the session starts. So the videos whose turn has
 *   NOT come yet are spaced again with the new gap (`retimeTurns`); a video already sent, or whose turn has passed, is
 *   left exactly as it is. A session not started yet has no turns, and simply starts with the new gap.
 *
 * Nothing is sent by this member and nothing already posted is touched.
 */

const params = z.object({
  groupId: z.string().min(1).describe('The session to change.').meta(ui({ title: 'Session' })),
  concurrency: z.number().int().min(1).max(500).optional().describe('How many of the session\'s videos may be in flight at once. Applies from the next video the router looks at.').meta(ui({ title: 'At once' })),
  gapMinSec: z.number().int().min(0).max(86_400).optional().describe('The shortest gap between two turns, in seconds.').meta(ui({ title: 'Gap from (s)' })),
  gapMaxSec: z.number().int().min(0).max(86_400).optional().describe('The longest gap between two turns, in seconds. Videos whose turn has not come yet are spaced again with the new gap.').meta(ui({ title: 'Gap to (s)' })),
})

const result = z.object({
  groupId: z.string().meta(ui({ title: 'Session', summary: true })),
  changed: z.array(z.string()).describe('What changed: concurrency, gap. Empty when the edit matched what was stored.').meta(ui({ title: 'Changed', summary: true })),
  retimed: z.number().int().describe('Videos whose turn had not come yet and were spaced again.').meta(ui({ title: 'Re-timed', summary: true })),
  nextAt: z.number().int().nullable().describe('Unix seconds: the next re-timed turn, or null when none was re-timed.').meta(ui({ title: 'Next turn' })),
})

/** Every platform of the row still waiting to be handed to a phone — a row with anything sent keeps its turn. */
function untouched(post: Post): boolean {
  return post.platforms.every((id) => (post.dispatch[id]?.state ?? 'pending') === 'pending')
}

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'update-group',
  title: 'Edit a session\'s pacing',
  description: 'Changes how many videos of a session go at once and the gap between turns. Videos whose turn has not come yet are spaced again; nothing already sent is touched.',
  icon: 'gauge',
  params,
  result,
  timeout: 120_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const key = groupKeyFor(ctx.params.groupId)
    const group = await ctx.storage.global.get(key, GroupSchema)
    if (!group) throw Object.assign(new Error(`No session called "${ctx.params.groupId}" — it may have been removed.`), { code: 'E_NOT_FOUND' })

    const edit = {
      ...(ctx.params.concurrency !== undefined ? { concurrency: ctx.params.concurrency } : {}),
      ...(ctx.params.gapMinSec !== undefined ? { gapMinSec: ctx.params.gapMinSec } : {}),
      ...(ctx.params.gapMaxSec !== undefined ? { gapMaxSec: ctx.params.gapMaxSec } : {}),
    }
    const { pacing, changed } = editPacing(group.pacing, edit)
    if (changed.length === 0) return { groupId: group.id, changed: [], retimed: 0, nextAt: null }
    await ctx.storage.global.set(key, { ...group, pacing })

    let retimed = 0
    let nextAt: number | null = null
    if (changed.includes('gap')) {
      const now = Math.floor(Date.now() / 1000)
      const waiting: { key: string; post: Post }[] = []
      let cursor: string | null = null
      do {
        const opts: { prefix: string; limit: number; cursor?: string } = { prefix: POST_PREFIX, limit: 500 }
        if (cursor !== null) opts.cursor = cursor
        const page = await ctx.storage.global.list(opts)
        for (const entry of page.items) {
          const parsed = PostSchema.safeParse(entry.value)
          if (!parsed.success || parsed.data.groupId !== group.id) continue
          const at = parsed.data.notBeforeAt
          if (at !== null && at > now && untouched(parsed.data)) waiting.push({ key: entry.key, post: parsed.data })
        }
        cursor = page.nextCursor
      } while (cursor !== null)

      const turns = retimeTurns(
        waiting.map((w) => ({ videoArtifactId: w.post.videoArtifactId, notBeforeAt: w.post.notBeforeAt as number })),
        pacing.gapSec,
        now,
      )
      const byVideo = new Map(turns.map((t) => [t.videoArtifactId, t.notBeforeAt]))
      for (const row of waiting) {
        const at = byVideo.get(row.post.videoArtifactId)
        if (at === undefined || at === row.post.notBeforeAt) continue
        await ctx.storage.global.set(row.key, { ...row.post, notBeforeAt: at })
        retimed += 1
      }
      nextAt = turns[0]?.notBeforeAt ?? null
    }

    ctx.log.info('changed a session\'s pacing', { groupId: group.id, changed: changed.join(', '), concurrency: pacing.concurrency, gap: pacing.gapSec.join('-'), retimed })
    return { groupId: group.id, changed, retimed, nextAt }
  },
}

export default script
