import type { TransferKind } from '@enkaku/protocol'
import type { TransferService } from './transfer'

/**
 * The one place a transferId is minted and its progress/done broadcasts are
 * wired up (plan 39 §4.4) — shared by the HTTP routes, the `internal:install`
 * batch executor, and the script IPC bridge, so a transfer started from any
 * of the three places is visible to every viewer of the device the same way
 * (plan §4.4's `transfer.progress`/`transfer.done`).
 */
export interface TransferBroadcast {
  progress(deviceId: string, transferId: string, kind: TransferKind, sent: number, total: number | null): void
  done(deviceId: string, transferId: string, kind: TransferKind, ok: boolean, error?: string, result?: unknown): void
}

export async function runTransfer<T>(opts: {
  transfer: TransferService
  broadcast: TransferBroadcast
  deviceId: string
  kind: TransferKind
  /** Reuse an existing id (e.g. a job's own, so `ctx.signal` can drive `cancel()`) — a fresh one is minted otherwise. */
  transferId?: string
  /** Cancels the transfer when the signal fires — e.g. a batch/job's abort signal (plan 39 acceptance #9 applied to `internal:install`). */
  signal?: AbortSignal
  op: (transferId: string, onProgress: (sent: number, total: number | null) => void) => Promise<T>
  /**
   * Readiness hold (plan 43 §3.7 table, §5 step 43.7) — every install/push/pull
   * goes through THIS one function (Studio's HTTP routes, `internal:install`,
   * and the script IPC bridge), so wiring it once here covers all three
   * callers. Held for the whole transfer, released whether it succeeds,
   * fails, or is cancelled. Optional so tests/callers that do not wire
   * readiness keep working unchanged.
   */
  holdFor?: (deviceId: string) => Promise<{ release(): void }>
}): Promise<T> {
  const transferId = opts.transferId ?? crypto.randomUUID()
  const onAbort = () => opts.transfer.cancel(transferId)
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  const hold = (await opts.holdFor?.(opts.deviceId).catch(() => null)) ?? null
  try {
    const result = await opts.op(transferId, (sent, total) => opts.broadcast.progress(opts.deviceId, transferId, opts.kind, sent, total))
    opts.broadcast.done(opts.deviceId, transferId, opts.kind, true, undefined, result)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    opts.broadcast.done(opts.deviceId, transferId, opts.kind, false, message)
    throw err
  } finally {
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
    hold?.release()
  }
}
