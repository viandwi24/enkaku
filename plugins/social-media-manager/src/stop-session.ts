import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { GroupSchema, groupKeyFor, isWarmup } from './groups'
import { POST_PREFIX, PostSchema, type Post } from './posts'
import { resumeWarmupRun, stopPostRow, stopWarmupRun } from './session-control'
import { WARMUP_PREFIX, WarmupRunSchema, type WarmupRun } from './warmup-runs'

/**
 * Stop a session, or start it again. One member for both kinds and both
 * directions (0.57.0).
 *
 * ## Why one member and not four
 *
 * "Stop this auto-post session", "stop this warm-up", "start it again" are the
 * same sentence about the same row: the session carries its `kind`, and the
 * only thing that differs is which rows have to be pulled back. Four members
 * would be four places for the gate and the cleanup to drift apart — and the
 * one failure this must not have is a session whose flag says stopped while a
 * job it dispatched is still running on a phone.
 *
 * ## What stopping actually does
 *
 * Three things, and it is worth being exact because "stop" could mean any of
 * them alone:
 *
 * 1. **Sets the flag**, which is what stops anything NEW going out. The router
 *    reads it each tick (`index.ts`'s `stoppedIds`).
 * 2. **Cancels what is already out** — `job.cancel` on every job the session's
 *    rows are waiting on, because a job the farm is running is not the
 *    plugin's to simply forget.
 * 3. **Puts that work back in the queue**, so the session still owes it. The
 *    owner's words were *"memaksa yang lagi running di cancel, dan waiting di
 *    masukan ke antrian terus"* — the phone is freed now, and nothing is lost.
 *
 * The flag is written FIRST, before a single job is cancelled. If the cancel
 * loop then fails half way — the farm restarts, a job is already gone — what
 * is left is a stopped session with a job still running, which the next tick
 * settles normally. The other order would leave a session that cancelled its
 * work and then carried on dispatching more.
 *
 * ## What starting does
 *
 * Clears the flag, and re-bases a warm-up's remaining schedule onto now
 * (`resumeWarmupRun`) so the gaps the operator chose survive a long stop. A
 * post session needs no equivalent: its turns are stamped by `start-group`,
 * which is the member an operator presses for that.
 */

const params = z.object({
  groupId: z.string().min(1).describe('The session to stop or start.').meta(ui({ title: 'Session' })),
  action: z
    .enum(['stop', 'start'])
    .default('stop')
    .describe('Stop pulls back everything still running and sends nothing more. Start lets the session carry on from where it was.')
    .meta(ui({ title: 'Action', labels: { stop: 'Stop', start: 'Start' } })),
})

const result = z.object({
  groupId: z.string().meta(ui({ title: 'Session', summary: true })),
  title: z.string().meta(ui({ title: 'Title', summary: true })),
  stopped: z.boolean().describe('What the session is now.').meta(ui({ title: 'Stopped' })),
  cancelled: z.number().int().describe('Jobs cancelled on the farm.').meta(ui({ title: 'Cancelled', summary: true })),
  /** Cancelling is the one step that can partly fail, and a count that hid it would be a count that lied. */
  couldNotCancel: z.number().int().describe('Jobs the farm would not cancel — already finished, or already gone.').meta(ui({ title: 'Could not cancel' })),
  pulled: z.number().int().describe('Activities or uploads put back in the queue.').meta(ui({ title: 'Back in the queue', summary: true })),
  summary: z.string().meta(ui({ title: 'Summary' })),
})

const JobInfo = z.object({ id: z.string().optional(), status: z.string().optional() }).loose()

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'stop-session',
  title: 'Stop or start a session',
  description: 'Stops a session: cancels what is running on the phones now and leaves the rest in the queue. Starting it again carries on from where it was.',
  icon: 'pause',
  params,
  result,
  timeout: 180_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const key = groupKeyFor(ctx.params.groupId)
    const group = await ctx.storage.global.get(key, GroupSchema)
    if (!group) {
      throw Object.assign(new Error(`No session called "${ctx.params.groupId}" — it may have been removed.`), { code: 'E_NOT_FOUND' })
    }

    const stop = ctx.params.action === 'stop'
    const now = Math.floor(Date.now() / 1000)

    // The flag first — see the header. A half-done cancel must leave a session
    // that sends nothing, never one that cancelled and then carried on.
    await ctx.storage.global.set(key, { ...group, stopped: stop })

    let cancelled = 0
    let couldNotCancel = 0
    let pulled = 0

    const cancel = async (jobIds: readonly string[]): Promise<void> => {
      for (const jobId of jobIds) {
        try {
          await ctx.farm.call('job.cancel', { jobId }, JobInfo)
          cancelled += 1
        } catch (err) {
          // A job that finished a second ago, or that the farm has already
          // dropped, refuses cancellation — and that is fine: the row is
          // pulled back either way and the work goes again.
          couldNotCancel += 1
          ctx.log.info('a job could not be cancelled', { jobId, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }

    if (isWarmup(group)) {
      const rows: { key: string; version: number; run: WarmupRun }[] = []
      let cursor: string | null = null
      do {
        const opts: { prefix: string; limit: number; cursor?: string } = { prefix: `${WARMUP_PREFIX}${group.id}:`, limit: 500 }
        if (cursor !== null) opts.cursor = cursor
        const page = await ctx.storage.global.list(opts)
        for (const entry of page.items) {
          const parsed = WarmupRunSchema.safeParse(entry.value)
          if (parsed.success) rows.push({ key: entry.key, version: entry.version, run: parsed.data })
        }
        cursor = page.nextCursor
      } while (cursor !== null)

      for (const row of rows) {
        const next = stop ? stopWarmupRun(row.run, now) : { row: resumeWarmupRun(row.run, now), cancel: [] as string[], pulled: 0 }
        if (next.row === row.run) continue
        pulled += next.pulled
        await cancel(next.cancel)
        await ctx.storage.global.set(row.key, next.row)
      }
    } else {
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

      // Starting a post session pulls nothing back — its rows keep the turns
      // `start-group` stamped, and the gate alone decides whether they go.
      if (stop) {
        for (const row of rows) {
          const next = stopPostRow(row.post, now)
          if (next.row === row.post) continue
          pulled += next.pulled
          await cancel(next.cancel)
          await ctx.storage.global.set(row.key, next.row)
        }
      }
    }

    const summary = stop
      ? pulled === 0
        ? 'Stopped. Nothing was running, so nothing had to be pulled back.'
        : `Stopped. ${cancelled} ${cancelled === 1 ? 'job' : 'jobs'} cancelled and ${pulled} back in the queue.`
      : 'Started. The router sends the rest on its next pass.'

    ctx.log.info(stop ? 'session stopped' : 'session started', { groupId: group.id, kind: group.kind, cancelled, couldNotCancel, pulled })
    return { groupId: group.id, title: group.title, stopped: stop, cancelled, couldNotCancel, pulled, summary }
  },
}

export default script
