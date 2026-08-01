import type { JobRow } from '../db/schema'
import type { Logger } from '../util/logger'

export interface ExecutorContext {
  /** Di-abort saat cancel / force-release. */
  signal: AbortSignal
  /** Perpanjang lease job (dipanggil host tiap heartbeat). */
  heartbeat(): void
  log: Logger
}

export interface JobExecutor {
  /** Validasi params sebelum enqueue (schema per-executor). */
  validateParams(params: unknown): unknown
  /** Jalankan sampai selesai; resolve = success, reject = failed. */
  run(job: JobRow, ctx: ExecutorContext): Promise<unknown>
}

/**
 * Registry executor: id built-in (mis. 'internal:sleep') di-map eksplisit;
 * scriptId lain (row tabel `scripts`) jatuh ke fallback = script executor
 * berbasis child process (M4).
 */
export class ExecutorRegistry {
  private map = new Map<string, JobExecutor>()
  private fallback: JobExecutor | null = null

  register(scriptId: string, executor: JobExecutor): void {
    this.map.set(scriptId, executor)
  }

  /** Executor untuk semua scriptId yang bukan built-in. */
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
