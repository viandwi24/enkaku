/**
 * The window after an operator releases a device from quarantine by hand,
 * during which neither automatic path may pull it straight back.
 *
 * Without it the release did not hold, and looked broken: a phone still above
 * the thermal threshold was re-quarantined by the next battery poll (60 s),
 * and one released from `adb:unreachable` still carried its failure streak in
 * `health.ts`, so a single further timeout re-quarantined it at once. An
 * operator who presses the button has looked at the phone and decided; the
 * farm resumes judging it when the window ends.
 *
 * In memory only, like the health counters: a core restart ends every window,
 * which errs toward quarantining again rather than toward trusting a phone
 * nobody is looking at any more.
 */
export interface QuarantineGrace {
  /** Starts (or restarts) the window for `deviceId`. */
  grant(deviceId: string): void
  /** Whether `deviceId` is inside its window right now. */
  active(deviceId: string): boolean
}

export function createQuarantineGrace(opts: { graceSec: number; now?: () => number }): QuarantineGrace {
  const now = opts.now ?? (() => Date.now())
  const until = new Map<string, number>()
  return {
    grant(deviceId) {
      if (opts.graceSec <= 0) return
      until.set(deviceId, now() + opts.graceSec * 1000)
    },
    active(deviceId) {
      const end = until.get(deviceId)
      if (end === undefined) return false
      if (now() < end) return true
      until.delete(deviceId)
      return false
    },
  }
}
