import type { AdbdShimDeps, RawStream } from '@enkaku/adb'
import { EnkakuError } from '../util/errors'
import type { TunnelRouter } from './router'
import type { TunnelRpc } from './rpc'

/**
 * Cloud mode's `AdbdShimDeps.openService` (plan 28 §4.2) — the ONE seam Plan
 * 27's shim exposes (plan 27 §4.1). Local mode implements it with
 * `AdbClient.openRaw`; this is the remote implementation: each call opens a
 * tunnel channel (`kind: 'adb-raw'`), asks the agent to run the same
 * `host:transport:<serial>` + `<service>` call against its OWN adb server
 * (`adb.open.request`/`adb.open.reply`, correlated by `TunnelRpc` exactly
 * like `shell.exec.request`), then returns a `RawStream` whose reads and
 * writes ride tunnel frames on that channel.
 *
 * The delivery-acknowledged write (§3.3, the plan's single most important
 * correctness detail): `write()` returns a `Promise<void>` that resolves
 * only once the agent's `adb.ack` confirms the bytes were actually written
 * downstream — never merely because they were handed to the tunnel. The
 * modified `stream-mux.ts` `handleWrte` awaits exactly this promise before
 * sending the WRTE's OKAY back to the user's adb client, so the whole path
 * stays genuinely stop-and-wait end to end: at most one chunk per stream is
 * ever "in flight, unacknowledged" — there is nothing to buffer without
 * bound in the control plane, because the next chunk simply cannot arrive
 * until this one is acknowledged.
 */
export function createRemoteOpenService(deps: {
  rpc: TunnelRpc
  router: TunnelRouter
  deviceId: string
}): AdbdShimDeps['openService'] {
  return async (_serial: string, service: string): Promise<RawStream> => {
    const channelId = deps.router.openChannel(deps.deviceId, 'adb-raw')
    if (channelId === null) {
      throw new EnkakuError('agent_offline', 'the agent that owns this device is currently disconnected')
    }

    let released = false
    let unsubscribeData: (() => void) | null = null
    let unwatchClose: (() => void) | null = null

    /** Every exit path releases the channel exactly once (plan §4.2 point 5, acceptance #7). */
    const releaseChannel = (): void => {
      if (released) return
      released = true
      unsubscribeData?.()
      unwatchClose?.()
      deps.router.closeChannel(channelId)
    }

    try {
      const reply = await deps.rpc.request<{ ok: boolean; error?: { code: string; message: string } }>(
        deps.deviceId,
        'adb.open.request',
        { deviceId: deps.deviceId, service, channelId },
      )
      if (!reply.ok) {
        throw new EnkakuError(reply.error?.code ?? 'E_ADB_FAIL', reply.error?.message ?? 'the agent refused to open the service')
      }
    } catch (err) {
      // The channel was opened optimistically before we knew the agent would
      // accept — offline, timeout, or an explicit refusal must not leak it.
      releaseChannel()
      throw err
    }

    // ---- ack-driven delivery window (§3.3) ----
    // The ADB wire protocol is itself stop-and-wait per stream (plan 27
    // §3.2), and `stream-mux`'s modified `handleWrte` never calls `write()`
    // again before the previous call's promise settles and its OKAY reaches
    // the host — so in correct operation at most one write is ever queued
    // here. `sendQueue` plus the single `inFlight` slot below are FIFO
    // defence-in-depth against a peer that does not honour that invariant,
    // not a design that expects to hold more than one entry: nothing here
    // grows without bound because nothing upstream lets it.
    const sendQueue: Array<{ chunk: Uint8Array; resolve: () => void }> = []
    let inFlight: { resolve: () => void; unwatchAck: () => void } | null = null
    let onDataCb: ((chunk: Uint8Array) => void) | null = null
    let onEndCb: ((err?: unknown) => void) | null = null
    let ended = false

    // An arrow function assigned to a `const`, deliberately NOT a hoisted
    // `function` declaration — TS does not carry the `channelId !== null`
    // narrowing above into a hoisted function's body (it could in principle
    // be called from anywhere), but does preserve it for a `const` closure
    // ordered normally in the flow.
    const pumpSendQueue = (): void => {
      if (inFlight || ended) return
      const next = sendQueue.shift()
      if (!next) return
      const unwatchAck = deps.rpc.watch(deps.deviceId, `adb:${channelId}:ack`, () => {
        inFlight = null
        next.resolve()
        pumpSendQueue()
      })
      inFlight = { resolve: next.resolve, unwatchAck }
      deps.router.sendFrame(channelId, next.chunk)
    }

    const end = (reason: string): void => {
      if (ended) return
      ended = true
      // Nothing left waiting on an `adb.ack` that will now never arrive must
      // hang forever — settle it so `stream-mux` sends the OKAY, and its own
      // `beginClose` (driven by the `onEnd` call right below) sends the CLSE
      // right after.
      inFlight?.unwatchAck()
      inFlight?.resolve()
      inFlight = null
      while (sendQueue.length > 0) sendQueue.shift()?.resolve()
      releaseChannel()
      onEndCb?.(reason)
    }

    unsubscribeData = deps.router.subscribeChannel(channelId, (payload) => onDataCb?.(payload))
    unwatchClose = deps.rpc.watch(deps.deviceId, `adb:${channelId}:close`, (payload) => {
      const p = payload as { reason?: string }
      end(p.reason ?? 'agent_offline')
    })

    return {
      write(chunk) {
        return new Promise<void>((resolve) => {
          if (ended) {
            resolve()
            return
          }
          sendQueue.push({ chunk, resolve })
          pumpSendQueue()
        })
      },

      streamFrom(onData, onEnd) {
        onDataCb = onData
        onEndCb = onEnd
      },

      close(force) {
        if (ended) return
        deps.router.sendToDevice(deps.deviceId, {
          type: 'adb.close',
          payload: { channelId, reason: force ? 'reset' : 'closed' },
        } as never)
        end('closed')
      },
    }
  }
}
