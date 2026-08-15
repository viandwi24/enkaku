import { buildResultSummary, RESULT_LIMITS, RESULT_STATUSES, type ParamIssue, type ResultOutcome, type ResultStatus, type SummaryField } from '@enkaku/protocol'

/**
 * The one place the parent turns a child's verdict into the four sibling
 * columns `jobs.result_status`/`result_bytes`/`result_summary`/
 * `result_issues` carry (plan 97 §3.3, §4.4, §4.5). `jobs.result` itself is
 * never reshaped here — `result` on this interface is exactly `input.value`,
 * verbatim, or `null` for the one state (`oversize`) that never received one.
 */
export interface RecordedResult {
  result: unknown
  resultStatus: ResultStatus
  resultBytes: number | null
  resultSummary: string | null
  resultIssues: ParamIssue[] | null
}

function byteLength(value: unknown): number {
  // `value` already crossed IPC as JSON (F10 — `process.send` uses the same
  // serialisation `child-entry.ts`'s own `buildResultOutcome` already
  // proved succeeds before sending it at all), so this can only throw for a
  // value this function was never handed in practice. Defensive rather than
  // asserted, so a genuinely unexpected input degrades to "0 bytes measured"
  // instead of crashing the settle path that is this function's only caller.
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return 0
  }
}

function isResultStatus(value: string): value is ResultStatus {
  return (RESULT_STATUSES as readonly string[]).includes(value)
}

/**
 * Caps the issue list to `RESULT_LIMITS.maxIssues` (already true at the IPC
 * layer — `ResultOutcomeSchema.issues` is capped there too — but re-applied
 * here rather than trusted, the same "the parent re-checks what it can
 * cheaply and independently know" rule §3.8 states for `bytes`/`status`) and
 * truncates each message to `RESULT_LIMITS.maxIssueMessageChars` so one
 * enormous Zod message cannot make `jobs.result_issues` itself another
 * unbounded column.
 */
function truncateIssues(issues: ParamIssue[]): ParamIssue[] {
  return issues.slice(0, RESULT_LIMITS.maxIssues).map((issue) => ({
    path: issue.path,
    message: issue.message.length > RESULT_LIMITS.maxIssueMessageChars ? `${issue.message.slice(0, RESULT_LIMITS.maxIssueMessageChars - 1)}…` : issue.message,
  }))
}

/**
 * Pure. `outcome` is what the child reported (§4.3) — undefined for a
 * pre-plan-97 bundle, or for any successful attempt whose child never built
 * one; a MISSING outcome is treated as `undeclared`, never as an error
 * (plan 59's rule: an older bundle meeting a newer core is a normal
 * condition on a farm that updates in stages). `summary` is the cached
 * `summaryFields()` for the script version that ran — `[]` until
 * `scripts.result_schema` itself is persisted (a later step; §4.5's own
 * note), which makes `resultSummary` legitimately `null` for every job today
 * without this function needing to know why.
 *
 * The parent's own re-measurement of `value` is authoritative over whatever
 * the child claimed (§3.8: "the parent re-checks the two things it can
 * cheaply and independently know — the byte count and the status enum") —
 * a child claiming anything but `oversize` for a value that is, independently,
 * over `maxResultBytes` is corrected here, and the value is dropped even if
 * it was (incorrectly) sent. When nothing was received at all (a genuine
 * `oversize`, or a circular value that never crossed IPC — V2), the child's
 * own self-reported byte count is the only number that exists to record.
 *
 * Returns `null` (plan 97 §3.5, step 97.4) exactly once: a `partial` verdict
 * that would downgrade an already-recorded `valid` (`existingStatus` — see
 * its own doc comment). The caller's existing "no `recorded` means leave the
 * columns alone" convention already does the right thing with that `null`.
 */
export function recordResult(input: {
  value: unknown
  outcome: ResultOutcome | undefined
  summary: SummaryField[]
  maxResultBytes: number
  /**
   * Plan 97 §3.5, §4.5, step 97.4 — the row's CURRENT `result_status`, if
   * any. `partial` (a `finish()` salvage, produced only on a `failed`/
   * `cancelled` settle) must never overwrite an already-recorded `valid` —
   * ordering is why: `finish()` runs after `run()`, and this repo re-runs
   * `finish()` in a fresh process after a timeout kill (spec §11.2, proven
   * by 98.3 asserting two differing `process.pid`s), so a late `partial`
   * COULD arrive after a good `valid` is already on the row. `null`/
   * undefined both mean "nothing recorded yet" — the ordinary case for the
   * overwhelming majority of settles, since a job settles exactly once
   * under today's call graph; this guard is deliberately defensive rather
   * than proof the ordering is reachable, the same posture this file's own
   * "a malformed/unrecognised status string falls back to undeclared" case
   * already takes.
   */
  existingStatus?: ResultStatus | null
}): RecordedResult | null {
  const { value, outcome, summary, maxResultBytes, existingStatus } = input
  // `executors/script.ts` normalises a child's ABSENT `value` (`undefined`)
  // to `null` before this function ever sees it (`result.value ?? null`,
  // pre-existing behaviour this step does not change) — so `value === null`
  // does NOT reliably mean "nothing was received" the way `undefined` would.
  // `outcome.status === 'oversize'` is the one place that ambiguity matters:
  // it is BY DESIGN the one status for which nothing crosses IPC at all
  // (§3.4), so it alone overrides `received` regardless of what `value`
  // looks like after that normalisation.
  const oversizeByChild = outcome?.status === 'oversize'
  const received = !oversizeByChild && value !== undefined
  const bytes = received ? byteLength(value) : (outcome?.bytes ?? 0)
  const claimed: ResultStatus = outcome && isResultStatus(outcome.status) ? outcome.status : 'undeclared'

  const status: ResultStatus = bytes > maxResultBytes ? 'oversize' : claimed

  // Plan 97 §3.5, step 97.4 — `partial` is salvage, not a contract: it never
  // overwrites an already-recorded `valid` (see this parameter's own doc
  // comment above for why). Returning `null` here — rather than a
  // `RecordedResult` that merely repeats the old values — lets the caller's
  // existing `recorded ? {...columns} : {}` pattern leave every result_*
  // column untouched, exactly as it already does for a failure that reported
  // no outcome at all.
  if (status === 'partial' && existingStatus === 'valid') return null

  const result = status === 'oversize' ? null : received ? value : null
  // `partial` never sets `result_issues` — there is no schema check behind
  // it to have produced any (§3.5: "there is no contract to have violated"),
  // and `buildResultOutcome`'s own salvage call sites never pass `issues` on
  // a `partial` outcome in the first place. Guarded here too, defensively,
  // rather than trusted to stay that way upstream.
  const issues = status === 'invalid' && outcome?.issues && outcome.issues.length > 0 ? truncateIssues(outcome.issues) : null
  const resultSummary = result !== null ? buildResultSummary(summary, result) : null

  return { result, resultStatus: status, resultBytes: bytes, resultSummary, resultIssues: issues }
}
