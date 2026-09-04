/**
 * A one-shot, resettable notification with a timeout — the primitive that lets
 * `waitFor` await "the next change, or a bounded re-check, whichever comes
 * first" without racing two promises that both stay alive (plan 222 §3.5).
 *
 * `fire()` while nothing is waiting is REMEMBERED, and consumed by the next
 * `wait()`. That is the whole reason this exists rather than a bare promise: a
 * change delivered while the previous evaluation was still in flight would
 * otherwise be lost, and the wait would sleep out its entire safety-net window
 * on a condition that had already become true.
 */
export interface ChangeSignal {
  fire(): void
  /** Resolves on the next `fire()`, on a pending one, or after `ms`. Never rejects. */
  wait(ms: number): Promise<void>
}

export function createChangeSignal(): ChangeSignal {
  let pending = false
  let resolveNow: (() => void) | null = null
  return {
    fire() {
      pending = true
      const r = resolveNow
      resolveNow = null
      r?.()
    },
    wait(ms) {
      if (pending) {
        pending = false
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          resolveNow = null
          resolve()
        }, ms)
        resolveNow = () => {
          clearTimeout(timer)
          pending = false
          resolve()
        }
      })
    },
  }
}
