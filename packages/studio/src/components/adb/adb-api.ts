import {
  AdbProbeResponseSchema,
  AdbRawListResponseSchema,
  AdbRawResultSchema,
  AdbRawShellResponseSchema,
  AdbTcpipResponseSchema,
  type AdbRawDevice,
} from '@enkaku/protocol'
import { api, type StatusDotState } from '@enkaku/ui'

/**
 * The `/api/adb` calls, in one place (the same shape `files-api.ts` takes).
 *
 * Every response is parsed against the shared schema, so a core that has
 * moved on from this Studio build fails loudly at the boundary instead of
 * rendering `undefined` in a table an operator is about to act on.
 */

export const listAdb = () => api('/api/adb/devices', AdbRawListResponseSchema)

export const adbConnect = (host: string, port: number) => api('/api/adb/connect', AdbRawResultSchema, { json: { host, port } })

export const adbDisconnect = (target?: string) => api('/api/adb/disconnect', AdbRawResultSchema, { json: target ? { target } : {} })

export const adbReconnectOffline = () => api('/api/adb/reconnect', AdbRawResultSchema, { json: {} })

export const adbTcpip = (serial: string, port: number) => api('/api/adb/tcpip', AdbTcpipResponseSchema, { json: { serial, port } })

export const adbProbe = (host: string, port: number) => api('/api/adb/probe', AdbProbeResponseSchema, { json: { host, port } })

export const adbShell = (serial: string, command: string) => api('/api/adb/shell', AdbRawShellResponseSchema, { json: { serial, command } })

export const adbAddForward = (serial: string, local: string, remote: string) =>
  api('/api/adb/forwards', AdbRawResultSchema, { json: { serial, local, remote } })

export const adbKillForward = (serial: string, local: string) =>
  api('/api/adb/forwards', AdbRawResultSchema, { method: 'DELETE', json: { serial, local } })

/**
 * adb's state word as one of the five dots the farm already draws.
 *
 * `device` is the only green one. `unauthorized` and `authorizing` share the
 * amber "someone must touch the phone" dot with `StatusDotState`'s own
 * `unauthorized`, which is the same situation. Everything else adb can say —
 * `bootloader`, `recovery`, `sideload`, `rescue`, a word this build has never
 * heard of — is drawn as `controlled`, an attention colour that does not
 * claim the device is usable and does not claim it is gone.
 */
export function adbStateDot(state: string): StatusDotState {
  if (state === 'device') return 'free'
  if (state === 'offline' || state === 'disconnected') return 'offline'
  if (state === 'unauthorized' || state === 'authorizing') return 'unauthorized'
  return 'controlled'
}

/** One line of plain English for an adb state, for the cell's `title`. */
export function describeAdbState(state: string): string {
  switch (state) {
    case 'device':
      return 'Ready — adb can run commands on it'
    case 'offline':
      return 'adb holds a transport for it but cannot talk to it'
    case 'unauthorized':
      return 'The RSA prompt on the phone has not been accepted'
    case 'authorizing':
      return 'The RSA handshake is in progress'
    case 'bootloader':
      return 'In fastboot — adb commands do not apply'
    case 'recovery':
      return 'In recovery'
    case 'sideload':
      return 'In sideload mode'
    default:
      return `adb reports "${state}"`
  }
}

/** How a raw row is named in a confirmation or a toast: the farm's name when it has one, else the bare serial. */
export function adbRowLabel(d: AdbRawDevice): string {
  if (d.farm.name === null) return d.serial
  return d.farm.number === null ? d.farm.name : `#${d.farm.number} ${d.farm.name}`
}
