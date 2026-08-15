import type { ArtifactInfo, JobDetail } from '@enkaku/protocol'

/**
 * Job-detail derivations that are worth testing on their own (plan 60).
 *
 * They live here rather than in the page because each of them encodes a
 * decision the plan argues for, and a decision nobody can run is a decision
 * that quietly reverts.
 */

/** The live phase, pushed by `job.status` while a job runs — not the phase a failure was recorded in. */
export interface JobWithPhase extends JobDetail {
  phase?: 'reset' | 'prepare' | 'run' | 'finish' | null
}

/**
 * The runner's own log, not something the script produced (plan 60 §3.5).
 *
 * It stays stored and stays in the API — the Logs tab downloads this exact
 * artefact to render a finished job's log, so filtering it server-side would
 * blank that tab. Only the Artifacts list, which is about what the RUN
 * produced, leaves it out.
 *
 * Matched by label as well as kind: a crash trace (plan 37) is a `log`
 * artefact too, and it IS a script-run output.
 */
export const isRunnerLog = (a: ArtifactInfo): boolean => a.kind === 'log' && a.label === 'job'

/** What the Artifacts tab lists: everything the run itself produced. */
export const producedArtifacts = (artifacts: ArtifactInfo[]): ArtifactInfo[] => artifacts.filter((a) => !isRunnerLog(a))

/**
 * One line saying how the run ended (plan 60 §3.4) — including WHERE it
 * failed, which the runner has always known and the job row only started
 * recording with this plan.
 */
export function outcomeLine(job: Pick<JobWithPhase, 'status' | 'errorPhase' | 'phase'>): string {
  switch (job.status) {
    case 'success':
      return 'Succeeded'
    case 'failed':
      return job.errorPhase ? `Failed during ${job.errorPhase}` : 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'expired':
      return 'Expired — no device came free before its queue deadline'
    case 'running':
      return job.phase ? `Running (${job.phase})` : 'Running'
    default:
      return 'Queued'
  }
}

/**
 * The script's return value, shown as it was stored (plan 60 §3.3). A plain
 * string prints as itself — quoting `"whoer.net"` would be pedantry — and
 * anything else is pretty-printed JSON. Nothing here narrows the value: a
 * script may return whatever JSON can carry.
 */
export function formatResult(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2) ?? String(result)
  } catch {
    // A circular structure cannot have come back from the DB, but a value
    // rendered as "[object Object]" is still better than a blank panel.
    return String(result)
  }
}

/**
 * `readFindings`, `JobFinding` and `severityTone` — the opportunistic
 * `findings[]` guess this comment used to describe — were removed by plan
 * 97 §5 step 97.5 (F20): `packages/studio/src/components/result-view/`
 * (step 97.6) is the reliable, SDK-declared replacement `docs/ux-audit.md`
 * §3 asked for, and the job detail page no longer imports any of the three.
 */
