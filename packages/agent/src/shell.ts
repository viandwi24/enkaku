import { AdbClient, AdbError, ADB_TIMEOUTS, type AdbStreamHandle, type AdbTimeoutProfile } from '@enkaku/adb'
import type { AgentToControl } from '@enkaku/protocol'
import type { DeviceSnapshotSource, Logger } from '@enkaku/session'

/** Lines/chunks are batched on the exact same cadence the core uses for its own local streams (plan 24 §4.4, plan 25 §4.4) — a chatty logcat must not become one tunnel frame per raw chunk here either. */
const FLUSH_INTERVAL_MS = 100
/**
 * Backpressure (plan 25 §3.5): once the agent's own outbound tunnel buffer
 * exceeds this, it stops trying to keep up and ends the stream with a
 * truthful reason instead of growing an unbounded batch. Matches the local
 * lane's own byte cap (`DEFAULT_STREAM_MAX_BYTES`) in order of magnitude —
 * there is nothing sacred about the exact number, only that it is bounded.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

function isAdbTimeoutProfile(value: string | undefined): value is AdbTimeoutProfile {
  return value !== undefined && value in ADB_TIMEOUTS
}

function errorReply(err: unknown): { code: string; message: string } {
  return {
    code: err instanceof AdbError ? err.code : 'E_ADB_FAIL',
    message: err instanceof Error ? err.message : String(err),
  }
}

interface ActiveStream {
  streamId: string
  channelId: number
  handle: AdbStreamHandle | null
  batch: Uint8Array[]
  batchBytes: number
  flushTimer: ReturnType<typeof setTimeout> | null
  /** Set the instant the backpressure threshold is crossed, so the eventual `onEnd('stopped')` this triggers is reported as `backpressure` instead — by the time it fires the buffer may already have drained. */
  backpressured: boolean
}

/**
 * Agent-side handlers for the correlated shell requests (plan 25 §4.4):
 * `shell.exec.request` runs through the agent's own `AdbClient.exec` with the
 * Plan 22.1 profiles; `shell.stream.request` runs through `execStream` (Plan
 * 24 §4.2) and writes batched output into the channel the control plane
 * already opened, the same way `hosts.ts` already streams video frames.
 */
export interface ShellHost {
  execRequest(msg: { id?: string; payload: { deviceId: string; cmd: string; profile?: string; timeoutMs?: number; maxOutputBytes?: number } }): Promise<void>
  streamRequest(msg: {
    id?: string
    payload: { deviceId: string; cmd: string; channelId: number; idleTimeoutMs?: number; absoluteTimeoutMs?: number; maxBytes?: number }
  }): Promise<void>
  streamStop(payload: { streamId: string }): void
  /** Defence in depth: if the control plane ever closes a shell channel out of band (without `shell.stream.stop`), the stream it fed must not become an orphaned device process. */
  channelClosed(channelId: number): void
  closeAll(): Promise<void>
}

export function createShellHost(deps: {
  client: AdbClient
  devices: DeviceSnapshotSource
  send: (msg: AgentToControl) => void
  sendFrame: (channelId: number, payload: Uint8Array) => void
  bufferedAmount: () => number
  log: Logger
}): ShellHost {
  const streams = new Map<string, ActiveStream>() // streamId -> ActiveStream
  const byChannel = new Map<number, string>() // channelId -> streamId

  function flush(s: ActiveStream): void {
    s.flushTimer = null
    if (s.batch.length === 0) return
    const total = s.batch.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of s.batch) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    s.batch = []
    s.batchBytes = 0
    deps.sendFrame(s.channelId, out)
  }

  function scheduleFlush(s: ActiveStream): void {
    if (s.flushTimer) return
    s.flushTimer = setTimeout(() => flush(s), FLUSH_INTERVAL_MS)
  }

  function endStream(streamId: string, reason: string): void {
    const s = streams.get(streamId)
    if (!s) return
    streams.delete(streamId)
    byChannel.delete(s.channelId)
    if (s.flushTimer) {
      clearTimeout(s.flushTimer)
      flush(s)
    }
    deps.send({ type: 'shell.stream.ended', payload: { streamId, reason } })
  }

  return {
    async execRequest(msg) {
      const { deviceId, cmd, profile, timeoutMs, maxOutputBytes } = msg.payload
      const reply = (payload: unknown) =>
        deps.send({ type: 'shell.exec.reply', ...(msg.id ? { id: msg.id } : {}), payload } as AgentToControl)
      const snap = deps.devices.get(deviceId)
      if (!snap) {
        reply({ ok: false, error: { code: 'device_not_found', message: `no such device: ${deviceId}` } })
        return
      }
      try {
        const stdout = await deps.client.exec(snap.serial, cmd, {
          ...(isAdbTimeoutProfile(profile) ? { profile } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
        })
        reply({ ok: true, stdout, exitCode: null, truncated: false })
      } catch (err) {
        reply({ ok: false, error: errorReply(err) })
      }
    },

    async streamRequest(msg) {
      const { deviceId, cmd, channelId, idleTimeoutMs, absoluteTimeoutMs, maxBytes } = msg.payload
      const reply = (payload: unknown) =>
        deps.send({ type: 'shell.stream.reply', ...(msg.id ? { id: msg.id } : {}), payload } as AgentToControl)
      const snap = deps.devices.get(deviceId)
      if (!snap) {
        reply({ ok: false, error: { code: 'device_not_found', message: `no such device: ${deviceId}` } })
        return
      }
      const streamId = crypto.randomUUID()
      const active: ActiveStream = { streamId, channelId, handle: null, batch: [], batchBytes: 0, flushTimer: null, backpressured: false }
      try {
        const handle = await deps.client.execStream(snap.serial, cmd, {
          onData: (chunk) => {
            // Backpressure (§3.5): the agent's own outbound buffer is already
            // past the threshold — stop batching more and end the stream
            // truthfully rather than growing without bound.
            if (deps.bufferedAmount() > MAX_BUFFERED_BYTES) {
              active.backpressured = true
              void active.handle?.stop().catch(() => {})
              return
            }
            active.batch.push(chunk)
            active.batchBytes += chunk.length
            scheduleFlush(active)
          },
          onEnd: (reason) => endStream(streamId, active.backpressured ? 'backpressure' : reason),
          ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
          ...(absoluteTimeoutMs !== undefined ? { absoluteTimeoutMs } : {}),
          ...(maxBytes !== undefined ? { maxBytes } : {}),
        })
        active.handle = handle
        streams.set(streamId, active)
        byChannel.set(channelId, streamId)
        reply({ ok: true, streamId })
      } catch (err) {
        reply({ ok: false, error: errorReply(err) })
      }
    },

    streamStop(payload) {
      const s = streams.get(payload.streamId)
      if (!s?.handle) return
      // `handle.stop()` itself calls `onEnd('stopped')`, which is what
      // actually sends `shell.stream.ended` and cleans up — mirroring the
      // core's own `MonitorHub.stopEntry` (fire-and-forget, best-effort).
      void s.handle.stop().catch(() => {})
    },

    channelClosed(channelId) {
      const streamId = byChannel.get(channelId)
      if (!streamId) return
      const s = streams.get(streamId)
      if (s?.handle) void s.handle.stop().catch(() => {})
    },

    async closeAll() {
      for (const s of [...streams.values()]) {
        if (s.handle) await s.handle.stop().catch(() => {})
      }
    },
  }
}
