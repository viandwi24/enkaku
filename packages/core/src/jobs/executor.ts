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

/** Registry executor: M3 hanya 'internal:sleep'; M4 menambah subprocess runner. */
export class ExecutorRegistry {
  private map = new Map<string, JobExecutor>()

  register(scriptId: string, executor: JobExecutor): void {
    this.map.set(scriptId, executor)
  }

  get(scriptId: string): JobExecutor | null {
    return this.map.get(scriptId) ?? null
  }

  has(scriptId: string): boolean {
    return this.map.has(scriptId)
  }
}
