/**
 * `M:SS` from a raw second count. Moved here from
 * `components/device/DeviceHeader.tsx` (deleted by plan 215 §5 step
 * 215.11) — `RecordPanel.tsx`, outside this plan's scope, is the only other
 * caller left, and needs somewhere to import it from.
 */
export function mmss(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
