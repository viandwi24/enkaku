import { UHID_MIN_API } from '@enkaku/scrcpy'

export type InputModePreference = 'uhid' | 'sdk' | 'aoa'
export type ResolvedInputEngine = 'scrcpy-uhid' | 'scrcpy-sdk' | 'adb-input'

export interface InputSelectionResult {
  engine: ResolvedInputEngine
  /** Alasan degrade — di-log & ditampilkan Studio saat mode bukan pilihan user. */
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
      degradedReason: 'session scrcpy tidak aktif — memakai fallback adb-input',
    }
  }
  if (opts.preferred === 'aoa') {
    return { engine: 'scrcpy-uhid', degradedReason: 'mode AOA belum tersedia (M8) — memakai UHID' }
  }
  if (opts.preferred === 'sdk') return { engine: 'scrcpy-sdk' }
  if (opts.apiLevel !== null && opts.apiLevel < UHID_MIN_API) {
    return {
      engine: 'scrcpy-sdk',
      degradedReason: `UHID butuh API ≥ ${UHID_MIN_API}, device ini API ${opts.apiLevel}`,
    }
  }
  return { engine: 'scrcpy-uhid' }
}
