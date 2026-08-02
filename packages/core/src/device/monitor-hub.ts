import { STREAMING_MONITOR_KINDS, type MonitorEndReason, type MonitorKind } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import type { ShellPort } from './shell-port'
import { buildMonitorCommand } from './monitors'

/** Passed to `execOut`'s budget; a generous ceiling since `dumpsys meminfo` on a busy device is not tiny. */
const ONESHOT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
/** What actually goes out over the WS — a device dump has no reason to be larger than this in a UI pane. */
const ONESHOT_MAX_CHARS = 200_000

/**
 * `ps` / `meminfo` / `df` (plan 24 §4.3 table) — one-shot, through the
 * NORMAL per-device queue (`appLifecycle` profile), never the streaming
 * lane. No hub involvement: no subscribers, no ring buffer, no fan-out.
 *
 * `shellPort` resolves local vs. remote (plan 25 §4.3) — this function does
 * not know or care which one it got; the resolution (and any
 * device_not_found / agent_offline / E_ADB_UNAVAILABLE it throws) lives one
 * layer up, in `ws-handlers.ts`, exactly like `stream.start` already does.
 */
export async function runOneshotMonitor(
  deps: { shellPort: (deviceId: string) => ShellPort },
  deviceId: string,
  kind: MonitorKind,
): Promise<{ text: string; truncated: boolean }> {
  if (STREAMING_MONITOR_KINDS.includes(kind)) {
    throw new EnkakuError('E_BAD_REQUEST', `monitor "${kind}" is a stream — use monitor.start, not monitor.oneshot`)
  }
  const port = deps.shellPort(deviceId)
  const cmd = buildMonitorCommand(kind, {})
  const result = await port.exec(cmd, { profile: 'appLifecycle', maxOutputBytes: ONESHOT_MAX_OUTPUT_BYTES })
  const charTruncated = result.stdout.length > ONESHOT_MAX_CHARS
  return {
    text: charTruncated ? result.stdout.slice(0, ONESHOT_MAX_CHARS) : result.stdout,
    truncated: result.truncated || charTruncated,
  }
}

/** A ring buffer of the last N lines per active stream (plan 24 §3.5): a late joiner sees context immediately. */
const MAX_BACKLOG_LINES = 2000
/** Lines are batched and flushed on this cadence (plan 24 §4.4) — a chatty logcat must not become one WS frame per chunk. */
const FLUSH_INTERVAL_MS = 100

export interface MonitorHub {
  /**
   * Subscribe `clientId` to `(deviceId, kind, options)`. Starts the adb
   * stream on the first subscriber; a later subscriber to the exact same
   * (already-canonicalised) command joins the SAME stream and immediately
   * gets its backlog (plan 24 §3.5).
   */
  subscribe(
    clientId: string,
    deviceId: string,
    kind: MonitorKind,
    options: unknown,
  ): Promise<{ streamId: string; backlog: string[] }>
  /** Stops the stream once its last subscriber leaves. */
  unsubscribe(clientId: string, streamId: string): void
  /** WS disconnect: drops every subscription this connection held. */
  releaseClient(clientId: string): void
  /** Device went offline / its session closed: every stream on it stops, regardless of subscribers. */
  stopForDevice(deviceId: string): void
}

export interface MonitorHubDeps {
  /**
   * Resolves a `ShellPort` for a device (plan 25 §4.3) — local or remote,
   * chosen by the caller (`ws-handlers.ts`) with the same resolution the
   * video path already uses. Throws a coded `EnkakuError` (device_not_found /
   * E_ADB_UNAVAILABLE / agent_offline) when the device cannot be reached;
   * `MonitorHub` neither knows nor needs to know which case that was.
   */
  shellPort: (deviceId: string) => ShellPort
  log: Logger
  /** Batched, at most once per FLUSH_INTERVAL_MS per stream (plan 24 §4.4). */
  onData: (streamId: string, lines: string[]) => void
  onEnded: (streamId: string, reason: MonitorEndReason) => void
  /** Drives the shared-viewer badge (plan 24 §4.7). */
  onSubscribersChanged: (streamId: string, count: number) => void
}

/** The known reasons the WS protocol can carry (`MonitorEndReasonSchema`,
 * `messages/shell.ts`) — unchanged by plan 25 so Studio's exhaustive
 * `Record<MonitorEndReason, string>` needs no update (acceptance #1). A
 * remote stream can end with a reason the local vocabulary never had
 * (`agent_offline`, `backpressure`); anything not in this set is reported as
 * `error` — still a clear, prompt end, just not a more specific label. */
const KNOWN_END_REASONS: ReadonlySet<MonitorEndReason> = new Set(['closed', 'idle', 'deadline', 'bytes', 'stopped', 'error'])

function toMonitorEndReason(reason: string): MonitorEndReason {
  return (KNOWN_END_REASONS as ReadonlySet<string>).has(reason) ? (reason as MonitorEndReason) : 'error'
}

interface Entry {
  streamId: string
  deviceId: string
  kind: MonitorKind
  cmd: string
  subscribers: Set<string>
  ringBuffer: string[]
  handle: { stop(): Promise<void> } | null
  /** Non-null while the adb stream is being established; subsequent subscribers await this instead of starting a second one. */
  starting: Promise<void> | null
  pendingLines: string[]
  flushTimer: ReturnType<typeof setTimeout> | null
  /** Bytes since the last newline, carried over across chunks. */
  partial: string
  /** Set when `stopEntry` runs before `starting` has resolved — the handle must be stopped the instant it exists. */
  stopRequested: boolean
}

function hashCommand(cmd: string): string {
  return new Bun.CryptoHasher('sha256').update(cmd).digest('hex').slice(0, 16)
}

/**
 * The stream registry (plan 24 §4.5). Keyed by `deviceId:kind:hash(cmd)` —
 * hashing the fully-resolved command (not the raw options) is what makes two
 * requests that resolve to the identical adb command share one stream, which
 * is the actual definition of "the same monitor" here.
 */
export function createMonitorHub(deps: MonitorHubDeps): MonitorHub {
  const entries = new Map<string, Entry>()
  /** clientId -> every streamId it is subscribed to, for O(subscriptions) cleanup on disconnect. */
  const clientStreams = new Map<string, Set<string>>()

  function addSubscriber(clientId: string, entry: Entry): void {
    const isNewForClient = !entry.subscribers.has(clientId)
    entry.subscribers.add(clientId)
    let set = clientStreams.get(clientId)
    if (!set) {
      set = new Set()
      clientStreams.set(clientId, set)
    }
    set.add(entry.streamId)
    if (isNewForClient) deps.onSubscribersChanged(entry.streamId, entry.subscribers.size)
  }

  function flush(entry: Entry): void {
    entry.flushTimer = null
    if (entry.pendingLines.length === 0) return
    const lines = entry.pendingLines
    entry.pendingLines = []
    deps.onData(entry.streamId, lines)
  }

  function scheduleFlush(entry: Entry): void {
    if (entry.flushTimer) return
    entry.flushTimer = setTimeout(() => flush(entry), FLUSH_INTERVAL_MS)
  }

  function handleChunk(entry: Entry, chunk: Uint8Array): void {
    const combined = entry.partial + new TextDecoder().decode(chunk)
    const parts = combined.split('\n')
    entry.partial = parts.pop() ?? ''
    if (parts.length === 0) return
    for (const line of parts) {
      entry.ringBuffer.push(line)
      entry.pendingLines.push(line)
    }
    if (entry.ringBuffer.length > MAX_BACKLOG_LINES) {
      entry.ringBuffer.splice(0, entry.ringBuffer.length - MAX_BACKLOG_LINES)
    }
    scheduleFlush(entry)
  }

  function detachAllSubscribers(entry: Entry): void {
    for (const clientId of entry.subscribers) {
      clientStreams.get(clientId)?.delete(entry.streamId)
    }
    entry.subscribers.clear()
  }

  function handleEnded(entry: Entry, reason: MonitorEndReason): void {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      flush(entry)
    }
    entry.handle = null
    entries.delete(entry.streamId)
    detachAllSubscribers(entry)
    deps.onEnded(entry.streamId, reason)
  }

  async function startStream(entry: Entry): Promise<void> {
    try {
      const port = deps.shellPort(entry.deviceId)
      const handle = await port.stream(entry.cmd, {
        onData: (chunk) => handleChunk(entry, chunk),
        onEnd: (reason) => handleEnded(entry, toMonitorEndReason(reason)),
      })
      if (entry.stopRequested) {
        void handle.stop().catch(() => {})
        return
      }
      entry.handle = handle
    } catch (err) {
      entries.delete(entry.streamId)
      detachAllSubscribers(entry)
      deps.log.warn(`monitor stream ${entry.streamId} (${entry.kind} on ${entry.deviceId}) failed to start: ${String(err)}`)
      throw err
    } finally {
      entry.starting = null
    }
  }

  function stopEntry(entry: Entry): void {
    entries.delete(entry.streamId)
    entry.stopRequested = true
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    const handle = entry.handle
    entry.handle = null
    // Best-effort: if the handle is not ready yet, `startStream`'s
    // `stopRequested` check stops it the instant it exists instead.
    if (handle) void handle.stop().catch(() => {})
  }

  return {
    async subscribe(clientId, deviceId, kind, options) {
      if (!STREAMING_MONITOR_KINDS.includes(kind)) {
        throw new EnkakuError('E_BAD_REQUEST', `monitor "${kind}" is one-shot — use monitor.oneshot, not monitor.start`)
      }
      // Validates the options AND is the single source of the command string
      // (plan 24 §3.7, §4.3) — nothing here ever builds one itself.
      const cmd = buildMonitorCommand(kind, options)
      const streamId = `${deviceId}:${kind}:${hashCommand(cmd)}`

      let entry = entries.get(streamId)
      if (!entry) {
        entry = {
          streamId,
          deviceId,
          kind,
          cmd,
          subscribers: new Set(),
          ringBuffer: [],
          handle: null,
          starting: null,
          pendingLines: [],
          flushTimer: null,
          partial: '',
          stopRequested: false,
        }
        entries.set(streamId, entry)
        entry.starting = startStream(entry)
      }
      addSubscriber(clientId, entry)
      if (entry.starting) await entry.starting
      return { streamId, backlog: [...entry.ringBuffer] }
    },

    unsubscribe(clientId, streamId) {
      const entry = entries.get(streamId)
      if (!entry) return
      if (!entry.subscribers.delete(clientId)) return
      clientStreams.get(clientId)?.delete(streamId)
      deps.onSubscribersChanged(streamId, entry.subscribers.size)
      if (entry.subscribers.size === 0) stopEntry(entry)
    },

    releaseClient(clientId) {
      const streams = clientStreams.get(clientId)
      if (!streams) return
      clientStreams.delete(clientId)
      for (const streamId of [...streams]) {
        const entry = entries.get(streamId)
        if (!entry) continue
        entry.subscribers.delete(clientId)
        deps.onSubscribersChanged(streamId, entry.subscribers.size)
        if (entry.subscribers.size === 0) stopEntry(entry)
      }
    },

    stopForDevice(deviceId) {
      for (const entry of [...entries.values()]) {
        if (entry.deviceId === deviceId) stopEntry(entry)
      }
    },
  }
}
