import type { AdbClient, AdbTimeoutProfile } from '@enkaku/adb'
import { EnkakuError } from '../util/errors'
import type { TunnelRouter } from '../tunnel/router'
import type { TunnelRpc } from '../tunnel/rpc'

/** plan 25 §4.3, extended with `stderr` by plan 53 §4.4 — the framed shell separates it from `stdout`. */
export interface ShellExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  truncated: boolean
}

export interface ShellStreamOptions {
  onData(chunk: Uint8Array): void
  /** A loose string, not `MonitorEndReason` — a node can report reasons
   * (`node_offline`, `backpressure`) the local vocabulary does not have.
   * The caller (`MonitorHub`) narrows it before it reaches the WS protocol. */
  onEnd(reason: string): void
  idleTimeoutMs?: number
  absoluteTimeoutMs?: number
  maxBytes?: number
}

export interface ShellStreamHandle {
  streamId: string
  stop(): Promise<void>
}

/**
 * One interface, two implementations (plan 25 §3.4, §4.3) — `MonitorHub`
 * talks to this and never needs to know whether a device is local or
 * node-owned. The local/remote CHOICE still has to be made somewhere; that
 * happens in `ws-handlers.ts`, mirroring the existing `stream.start` pattern
 * (`deps.remote?.nodeIdFor(deviceId)`), not inside the hub itself.
 */
export interface ShellPort {
  exec(cmd: string, opts?: { profile?: AdbTimeoutProfile; timeoutMs?: number; maxOutputBytes?: number }): Promise<ShellExecResult>
  stream(cmd: string, opts: ShellStreamOptions): Promise<ShellStreamHandle>
}

/** Local devices: a thin, per-serial wrapper over the existing `AdbClient` (plan 25 §4.3). */
export function createLocalShellPort(deps: { client: AdbClient; serial: string }): ShellPort {
  return {
    async exec(cmd, opts) {
      const { stdout, stderr, exitCode } = await deps.client.exec(deps.serial, cmd, {
        ...(opts?.profile ? { profile: opts.profile } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
      })
      // `AdbClient.exec` either returns full output or throws
      // E_ADB_OUTPUT_LIMIT — there is no partial-truncation outcome to
      // report locally (plan 53 §4.2, §4.3).
      return { stdout, stderr, exitCode, truncated: false }
    },

    async stream(cmd, opts) {
      const handle = await deps.client.execStream(deps.serial, cmd, {
        onData: opts.onData,
        onEnd: (reason) => opts.onEnd(reason),
        ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
        ...(opts.absoluteTimeoutMs !== undefined ? { absoluteTimeoutMs: opts.absoluteTimeoutMs } : {}),
        ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      })
      return {
        // No caller of `ShellPort.stream()` inspects `streamId` for a local
        // stream today; the pid (when known) is a meaningful label, a random
        // id otherwise (plan 24 §8: an OEM shell that never prints a bare PID).
        streamId: handle.pid !== null ? String(handle.pid) : crypto.randomUUID(),
        stop: () => handle.stop(),
      }
    },
  }
}

/**
 * Node-owned devices: `exec` rides `TunnelRpc.request`; `stream` opens a
 * `shell` binary channel first (plan 25 §4.5 step 1), then asks the node to
 * start writing into it (step 2). Every exit path — success, rejection,
 * timeout, or an explicit `stop()` — releases the channel it opened; nothing
 * here lets one leak (plan 25 §6.6).
 */
export function createRemoteShellPort(deps: { rpc: TunnelRpc; router: TunnelRouter; deviceId: string }): ShellPort {
  return {
    async exec(cmd, opts) {
      const reply = await deps.rpc.request<{
        ok: boolean
        stdout?: string
        /** Absent on an older node build that predates plan 53 — defaults to `''`, never crashes the core. */
        stderr?: string
        exitCode?: number | null
        truncated?: boolean
        error?: { code: string; message: string }
      }>(deps.deviceId, 'shell.exec.request', {
        deviceId: deps.deviceId,
        cmd,
        ...(opts?.profile ? { profile: opts.profile } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
      })
      if (!reply.ok) {
        throw new EnkakuError(reply.error?.code ?? 'E_ADB_FAIL', reply.error?.message ?? 'the node failed to run the command')
      }
      return {
        stdout: reply.stdout ?? '',
        stderr: reply.stderr ?? '',
        exitCode: reply.exitCode ?? null,
        truncated: reply.truncated ?? false,
      }
    },

    async stream(cmd, opts) {
      const channelId = deps.router.openChannel(deps.deviceId, 'shell')
      if (channelId === null) {
        throw new EnkakuError('node_offline', 'the node that owns this device is currently disconnected')
      }
      const unsubscribeData = deps.router.subscribeChannel(channelId, opts.onData)
      let ended = false
      let unwatch: (() => void) | null = null

      const finish = (reason: string): void => {
        if (ended) return
        ended = true
        unsubscribeData()
        unwatch?.()
        deps.router.closeChannel(channelId)
        opts.onEnd(reason)
      }

      try {
        const reply = await deps.rpc.request<{
          ok: boolean
          streamId?: string
          error?: { code: string; message: string }
        }>(deps.deviceId, 'shell.stream.request', {
          deviceId: deps.deviceId,
          cmd,
          channelId,
          ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
          ...(opts.absoluteTimeoutMs !== undefined ? { absoluteTimeoutMs: opts.absoluteTimeoutMs } : {}),
          ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
        })
        if (!reply.ok || !reply.streamId) {
          throw new EnkakuError(reply.error?.code ?? 'E_ADB_FAIL', reply.error?.message ?? 'the node rejected the stream request')
        }
        const streamId = reply.streamId
        unwatch = deps.rpc.watch(deps.deviceId, streamId, (payload) => {
          const p = payload as { reason?: string }
          finish(p.reason ?? 'error')
        })
        return {
          streamId,
          async stop() {
            // Best-effort, mirroring the local path's best-effort `kill <pid>`
            // (plan 24 §4.2): the caller has already decided to stop, so a
            // channel that is already gone must not surface as a new error.
            deps.router.sendToDevice(deps.deviceId, { type: 'shell.stream.stop', payload: { streamId } } as never)
            finish('stopped')
          },
        }
      } catch (err) {
        // The request itself never got a usable reply (offline, timeout, or
        // rejected) — the channel was opened optimistically before we knew
        // that, and must not be left dangling (plan 25 §4.5, §6.6).
        unsubscribeData()
        deps.router.closeChannel(channelId)
        throw err
      }
    },
  }
}
