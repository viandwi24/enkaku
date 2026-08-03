import { CHECKS } from './checks/index'
import type { Check, CheckResult, DoctorContext } from './types'

export interface DoctorCheckOutcome extends CheckResult {
  id: string
  title: string
}

export interface DoctorRunResult {
  results: DoctorCheckOutcome[]
  /** 1 when any check `fail`s, 0 otherwise — warnings do not affect it (plan 41 §6.9). */
  exitCode: 0 | 1
}

/**
 * Runs every check in the fixed order, in sequence (checks may share I/O —
 * e.g. `port` and `core` both reach for the same core process — so running
 * them one at a time keeps the output deterministic). A check that throws is
 * reported as `fail` rather than aborting the whole run: one bad check must
 * not hide the rest of the report.
 */
export async function runChecks(ctx: DoctorContext, checks: Check[] = CHECKS): Promise<DoctorRunResult> {
  const results: DoctorCheckOutcome[] = []
  for (const check of checks) {
    let result: CheckResult
    try {
      result = await check.run(ctx)
    } catch (err) {
      result = {
        status: 'fail',
        observed: `check threw: ${err instanceof Error ? err.message : String(err)}`,
        remedy: 'this looks like a doctor bug — please report it with this output',
      }
    }
    results.push({ id: check.id, title: check.title, ...result })
  }
  const exitCode = results.some((r) => r.status === 'fail') ? 1 : 0
  return { results, exitCode }
}
