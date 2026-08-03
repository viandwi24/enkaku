import { resolveDataDir } from '../util/paths'
import { createRealDoctorContext } from './context'
import { renderHuman, renderJson } from './render'
import { runChecks } from './run'

export type { Check, CheckResult, CheckStatus, DoctorContext } from './types'
export { runChecks, type DoctorCheckOutcome, type DoctorRunResult } from './run'
export { renderHuman, renderJson } from './render'
export { CHECKS } from './checks/index'

/**
 * The `enkaku doctor` CLI entrypoint (plan 41 §3.4, §4.4): builds the real
 * context, runs every check, prints the report, and returns the process
 * exit code (the caller — `index.ts`/`entry-release.gen.ts` — is the one
 * that actually calls `process.exit`, so this stays testable without
 * exiting the test runner).
 */
export async function runDoctor(opts: { json: boolean }): Promise<number> {
  const dataDir = resolveDataDir()
  const ctx = await createRealDoctorContext(dataDir)
  const result = await runChecks(ctx)
  console.log(opts.json ? renderJson(result) : renderHuman(result))
  return result.exitCode
}
