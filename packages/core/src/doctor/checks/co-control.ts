import type { Check } from '../types'

/**
 * Co-control observability (plan 91 §4.10, §5 step 91.10, tests H2, H4):
 * reads `GET /api/adb/stats`'s `input` block (`ws-handlers.ts`'s
 * `inputStats()`) and reports three things, none of which requires real
 * hardware — this check is read-only, exactly like every other one in this
 * directory (plan 41 §4.3, §7):
 *
 * 1. **Lane wait budget** (H2) — a lane whose `waitMsP95` exceeds half of
 *    `coControl.queueWaitMs` means an assist action is regularly waiting a
 *    meaningful fraction of the whole refusal budget behind a job/agent
 *    action; half, not the full budget, so this warns before an operator
 *    ever actually SEES an `E_INPUT_BUSY` refusal, not after.
 * 2. **Uncollected grants** — a leak detector. `co-control.ts`'s reaper
 *    sweeps every `~5s`; a grant still sitting well past its own `expiresAt`
 *    means the reaper is not collecting, and a grant that outlives the hold
 *    it was subordinate to is exactly the state that strands a device (§3.2
 *    — the WHOLE point of subordination is that this can never happen).
 * 3. **Orphaned mirror groups** — the same leak shape for Mirror: a group
 *    whose owner's WS connection is no longer open should have been ended by
 *    `stopAllForClient` on WS close (§8 risk table's own "a mirror group
 *    outlives its owner's tab" row); one still present means that path
 *    failed silently.
 *
 * Never `fail` — matches `streamsCheck`'s own precedent (budget pressure and
 * a leak are both actionable-but-not-fatal, the same "warn, not fail" shape
 * a saturated stream-lane budget already gets).
 */
export const coControlCheck: Check = {
  id: 'co-control',
  title: 'Assist and Mirror (co-control)',
  async run(ctx) {
    const input = await ctx.coControl.probe()
    if (input === null) {
      return { status: 'skip', observed: 'no running core detected — co-control observability is only known while the core is up' }
    }

    const laneEntries = Object.entries(input.lanes)
    const laneSummary = laneEntries
      .map(([lane, s]) => `${lane}: depth=${s.depth} p50=${s.waitMsP50}ms p95=${s.waitMsP95}ms refusals=${s.refusals}`)
      .join(', ')
    const observed =
      `${laneSummary || 'no active lanes'} — assists=${input.assistsActive} mirrorGroups=${input.mirrorGroups}` +
      ` mirrorMembers=${input.mirrorMembers} queueWaitMs=${input.queueWaitMs}`

    const budgetMs = input.queueWaitMs / 2
    const overBudget = laneEntries.filter(([, s]) => s.waitMsP95 > budgetMs)

    const remedies: string[] = []
    if (overBudget.length > 0) {
      const names = overBudget.map(([lane, s]) => `${lane} (p95 ${s.waitMsP95}ms > half the ${input.queueWaitMs}ms budget)`).join(', ')
      remedies.push(
        `${names} — an assist is regularly waiting a meaningful fraction of the refusal budget behind a job/agent action; raise coControl.queueWaitMs, or check whether one script's own actions (e.g. a long typeText) are unusually long`,
      )
    }
    if (input.uncollectedGrants > 0) {
      remedies.push(
        `${input.uncollectedGrants} assist grant(s) are past their own expiry and not yet collected by the reaper — a grant that outlives the hold it was subordinate to can strand a device; if this persists across a doctor re-run a few seconds apart, restart the core`,
      )
    }
    if (input.orphanedMirrorGroups > 0) {
      remedies.push(
        `${input.orphanedMirrorGroups} mirror group(s) have no open connection matching their owner — the owning tab likely closed without a clean WS disconnect; if this persists across a doctor re-run a few seconds apart, restart the core`,
      )
    }

    if (remedies.length === 0) {
      return { status: 'ok', observed }
    }
    return { status: 'warn', observed, remedy: remedies.join('. ') }
  },
}
