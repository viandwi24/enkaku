import type { ArtifactInfo } from '@enkaku/protocol'

/**
 * Job-detail derivations that are worth testing on their own (plan 60).
 *
 * They live here rather than in the page because each of them encodes a
 * decision the plan argues for, and a decision nobody can run is a decision
 * that quietly reverts.
 *
 * `JobWithPhase` and `outcomeLine` were removed by plan 218 §4.4: the
 * Summary tab's phase strip is gone with the old job detail page, and the
 * failure line the new Jobs screen draws instead (§4.9.2) reads straight off
 * `JobRunDetail.errorPhase`/`failureClass`/`error` — it needs no live
 * `phase` field and no sentence-building helper of its own.
 */

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
