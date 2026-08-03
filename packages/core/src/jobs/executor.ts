import type { JobRow } from '../db/schema'
import type { Logger } from '../util/logger'

export interface ExecutorContext {
  /** Aborted on cancel or force-release. */
  signal: AbortSignal
  /** Extend the job lease (called by the host on every heartbeat). */
  heartbeat(): void
  log: Logger
  /**
   * Registers a callback for a crash-based abort (plan 37 §4.4) — kept
   * SEPARATE from `signal`, which is reserved for user-initiated
   * cancel/force-release (`ExecutorHost.abort`) and always means "abandon
   * the job", never "the target app crashed, fail on that specific basis".
   * Optional: only the script executor wires this today (the sleep and
   * remote-bridge executors have no crash-attributable subprocess to abort).
   */
  onCrash?: (cb: (e: { package: string; exception: string; message: string }) => void) => void
}

export interface JobExecutor {
  /** Validate params before enqueueing (a per-executor schema). */
  validateParams(params: unknown): unknown
  /** Run to completion; resolve means success, reject means failure. */
  run(job: JobRow, ctx: ExecutorContext): Promise<unknown>
}

/**
 * Registry executor: id built-in (mis. 'internal:sleep') di-map eksplisit;
 * scriptId lain (row tabel `scripts`) jatuh ke fallback = script executor
 * built on child processes (M4).
 */
export class ExecutorRegistry {
  private map = new Map<string, JobExecutor>()
  private fallback: JobExecutor | null = null

  register(scriptId: string, executor: JobExecutor): void {
    this.map.set(scriptId, executor)
  }

  /** The executor for every scriptId that is not built in. */
  setFallback(executor: JobExecutor): void {
    this.fallback = executor
  }

  get(scriptId: string): JobExecutor | null {
    return this.map.get(scriptId) ?? this.fallback
  }

  isBuiltIn(scriptId: string): boolean {
    return this.map.has(scriptId)
  }
}
