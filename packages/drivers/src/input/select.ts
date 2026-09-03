import { UHID_MIN_API } from '@enkaku/scrcpy'

export type InputModePreference = 'uhid' | 'sdk'
export type ResolvedInputEngine = 'scrcpy-uhid' | 'scrcpy-sdk' | 'adb-input'

export interface InputSelectionResult {
  engine: ResolvedInputEngine
  /** Why it degraded — logged and shown in Studio when the mode is not what was chosen. */
  degradedReason?: string
}

/**
 * Resolusi mode input (plan 08 §3.8): preferensi user → gating apiLevel →
 * ketersediaan engine. Degrade chain: uhid → sdk → adb-input.
 */
export function selectInputEngine(opts: {
  preferred: InputModePreference
  apiLevel: number | null
  scrcpyAvailable: boolean
}): InputSelectionResult {
  if (!opts.scrcpyAvailable) {
    return {
      engine: 'adb-input',
      degradedReason: 'no active scrcpy session — using the adb-input fallback',
    }
  }
  if (opts.preferred === 'sdk') return { engine: 'scrcpy-sdk' }
  if (opts.apiLevel !== null && opts.apiLevel < UHID_MIN_API) {
    return {
      engine: 'scrcpy-sdk',
      degradedReason: `UHID needs API ≥ ${UHID_MIN_API}, this device is API ${opts.apiLevel}`,
    }
  }
  return { engine: 'scrcpy-uhid' }
}
