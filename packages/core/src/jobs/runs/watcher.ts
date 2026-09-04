import { EnkakuError } from '../../util/errors'
import type { JobRunRow } from '../../db/schema'

const TERMINAL: ReadonlySet<string> = new Set(['success', 'failed', 'cancelled', 'expired'])

/**
 * How the workflow orchestrator waits on a step's child run without polling
 * (plan 211 §3.2 decision 14). `executor-host.ts`'s settle path, the expiry
 * reaper and `JobService.cancel` are its producers.
 */
export interface RunWatcher {
  /**
   * Resolves with the run row the moment its status is terminal. Re-reads
   * the row on subscription first, so a run that settled between the
   * enqueue and this call resolves immediately. Rejects with
   * `EnkakuError('job_cancelled')` when `signal` aborts.
   */
  waitForTerminal(runId: string, signal: AbortSignal): Promise<JobRunRow>
  /** Called by every producer with the settled row. Unknown ids are ignored. */
  notify(run: JobRunRow): void
}

export function createRunWatcher(deps: { getRun: (runId: string) => JobRunRow | null }): RunWatcher {
  const waiters = new Map<string, Set<(run: JobRunRow) => void>>()

  return {
    waitForTerminal(runId, signal) {
      const current = deps.getRun(runId)
      if (current && TERMINAL.has(current.status)) return Promise.resolve(current)
      return new Promise<JobRunRow>((resolve, reject) => {
        const onAbort = () => {
          const set = waiters.get(runId)
          set?.delete(settle)
          reject(new EnkakuError('E_CANCELLED', 'job_cancelled'))
        }
        const settle = (run: JobRunRow) => {
          signal.removeEventListener('abort', onAbort)
          resolve(run)
        }
        if (signal.aborted) {
          reject(new EnkakuError('E_CANCELLED', 'job_cancelled'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
        let set = waiters.get(runId)
        if (!set) {
          set = new Set()
          waiters.set(runId, set)
        }
        set.add(settle)
      })
    },

    notify(run) {
      if (!TERMINAL.has(run.status)) return
      const set = waiters.get(run.id)
      if (!set) return
      waiters.delete(run.id)
      for (const fn of set) fn(run)
    },
  }
}
