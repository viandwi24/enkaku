import type { CheckStatus } from './types'
import type { DoctorRunResult } from './run'

const BADGE: Record<CheckStatus, string> = { ok: '[ ok ]', warn: '[warn]', fail: '[fail]', skip: '[skip]' }

/** Human-readable report — the default `enkaku doctor` output. */
export function renderHuman(run: DoctorRunResult): string {
  const lines: string[] = ['enkaku doctor', '']
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const r of run.results) {
    counts[r.status]++
    lines.push(`${BADGE[r.status]} ${r.title.padEnd(16)} ${r.observed}`)
    if (r.remedy) lines.push(`         → ${r.remedy}`)
  }
  lines.push('')
  lines.push(`${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail, ${counts.skip} skip — exit code ${run.exitCode}`)
  return lines.join('\n')
}

/**
 * The same result the human renderer prints, just JSON-encoded (plan 41
 * §4.3, §6.8) — Studio's diagnostics view renders this exact shape so the
 * browser and the terminal never disagree about what is wrong.
 */
export function renderJson(run: DoctorRunResult): string {
  return JSON.stringify(run, null, 2)
}
