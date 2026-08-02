import { AdbClient, AdbError, type AdbSocket } from '@enkaku/adb'
import type { AgentToControl } from '@enkaku/protocol'
import type { DeviceSnapshotSource, Logger } from '@enkaku/session'

/**
 * Defence in depth (plan 28 §4.3): "an agent cannot be pushed past its own
 * stream budget by a control plane that lost track" — the same phrase Plan
 * 25 §4.4 uses for the shell lane. The core's own `stream-mux` already
 * enforces the FARM'S configured `adb.maxEndpointStreams` (plan 27 §4.3,
 * `z.number().int().min(1).max(32)`) before an `adb.open.request` is ever
 * sent, so this exists purely as a second, independent backstop — it is
 * deliberately set to the SETTING'S OWN maximum (32), never its default (8),
 * because no message on the wire carries the farm's actual configured value
 * across the tunnel: pinning this to the default would make the agent
 * silently override a farm that has legitimately configured a higher limit,
 * which is worse than the (much rarer) case this guards against — a core
 * that has otherwise lost track of its own cap.
 */
const MAX_STREAMS_PER_DEVICE = 32

function errorReply(err: unknown): { code: string; message: string } {
  return {
    code: err instanceof AdbError ? err.code : 'E_ADB_FAIL',
    message: err instanceof Error ? err.message : String(err),
  }
}

interface ActiveAdbStream {
  channelId: number
  deviceId: string
  socket: AdbSocket
}

/**
 * Agent-side handler for the cloud adb endpoint (plan 28 §4.3): on
 * `adb.open.request`, opens a raw smartsocket stream against the agent's OWN
 * adb server (`AdbClient.openRaw`, plan 27 §4.1) and pipes it both ways over
 * the tunnel channel the control plane already opened — mirroring
 * `shell.ts`'s `ShellHost` pattern exactly, one channel per ADB stream
 * instead of one channel per shell/monitor session.
 */
export interface AdbRawHost {
  openRequest(msg: { id?: string; payload: { deviceId: string; service: string; channelId: number } }): Promise<void>
  /** Inbound tunnel frame on an `adb-raw` channel: bytes the user's adb wrote, to be written downstream now. */
  handleFrame(channelId: number, payload: Uint8Array): void
  /** The core side ended this stream first (plan §4.2 point 5). */
  close(payload: { channelId: number; reason: string }): void
  /** Defence in depth: the control plane closing the channel out of band (without `adb.close`) must not leave the device-side stream orphaned — mirrors `ShellHost.channelClosed`. */
  channelClosed(channelId: number): void
  closeAll(): Promise<void>
}

export function createAdbRawHost(deps: {
  client: AdbClient
  devices: DeviceSnapshotSource
  send: (msg: AgentToControl) => void
  sendFrame: (channelId: number, payload: Uint8Array) => void
  log: Logger
}): AdbRawHost {
  const streams = new Map<number, ActiveAdbStream>() // channelId -> stream
  const perDeviceCount = new Map<string, number>()

  function endStream(channelId: number, reason: string): void {
    const s = streams.get(channelId)
    if (!s) return
    streams.delete(channelId)
    const remaining = (perDeviceCount.get(s.deviceId) ?? 1) - 1
    if (remaining <= 0) perDeviceCount.delete(s.deviceId)
    else perDeviceCount.set(s.deviceId, remaining)
    // Either side may report the end first (plan §4.2 point 5) — this is a
    // push, not a reply, so it carries no `id`.
    deps.send({ type: 'adb.close', payload: { channelId, reason } })
  }

  return {
    async openRequest(msg) {
      const { deviceId, service, channelId } = msg.payload
      const reply = (payload: { ok: boolean; error?: { code: string; message: string } }) =>
        deps.send({ type: 'adb.open.reply', ...(msg.id ? { id: msg.id } : {}), payload } as AgentToControl)

      const snap = deps.devices.get(deviceId)
      if (!snap) {
        reply({ ok: false, error: { code: 'device_not_found', message: `no such device: ${deviceId}` } })
        return
      }
      const current = perDeviceCount.get(deviceId) ?? 0
      if (current >= MAX_STREAMS_PER_DEVICE) {
        reply({
          ok: false,
          error: { code: 'E_ADB_STREAM_LIMIT', message: `this agent already has ${MAX_STREAMS_PER_DEVICE} adb streams open for ${deviceId}` },
        })
        return
      }

      try {
        const socket = await deps.client.openRaw(snap.serial, service)
        streams.set(channelId, { channelId, deviceId, socket })
        perDeviceCount.set(deviceId, current + 1)
        reply({ ok: true })
        socket.streamFrom(
          (chunk) => deps.sendFrame(channelId, chunk),
          (err) => {
            deps.log.debug(`adb-raw: channel ${channelId} (${service}) backend ended: ${err ? String(err) : 'closed'}`)
            endStream(channelId, err ? 'error' : 'closed')
          },
        )
      } catch (err) {
        reply({ ok: false, error: errorReply(err) })
      }
    },

    handleFrame(channelId, payload) {
      const s = streams.get(channelId)
      if (!s) return
      try {
        // Delivery acknowledgement (§3.3): the shim's window on the control
        // plane advances ONLY on this message — never on the mere act of the
        // tunnel frame arriving here — so it must follow the actual write,
        // not precede it.
        s.socket.write(payload)
        deps.send({ type: 'adb.ack', payload: { channelId, bytes: payload.length } })
      } catch (err) {
        deps.log.warn(`adb-raw: write to channel ${channelId} failed: ${String(err)}`)
        s.socket.close(true)
        endStream(channelId, 'error')
      }
    },

    close(payload) {
      const s = streams.get(payload.channelId)
      if (!s) return
      // The socket's own `streamFrom` `onEnd` (registered in `openRequest`)
      // fires once Bun's close/error event actually lands and calls
      // `endStream` from there — not duplicated here, so the stream is
      // never torn down (and `adb.close` never sent) twice.
      s.socket.close(payload.reason === 'reset')
    },

    channelClosed(channelId) {
      const s = streams.get(channelId)
      if (s) s.socket.close(true)
    },

    async closeAll() {
      for (const s of [...streams.values()]) s.socket.close(true)
    },
  }
}
