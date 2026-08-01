import type { AdbClient } from '@enkaku/adb'
import { AdbInput, AdbTcpTransport, AdbUsbTransport, ScreencapLoop } from '@enkaku/drivers'
import type { DisplaySource, FrameMeta, InputSink, Inspector, Transport } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

export interface DeviceSession {
  deviceId: string
  transport: Transport
  display: DisplaySource
  input: InputSink
  /** Engine inspector session ini (ui-server / uiautomator-dump). */
  inspector: Inspector | null
  /** Engine id efektif — bisa berbeda dari kolom DB karena fallback. */
  inspectorEngineId: string
  /** Interval polling waitFor yang cocok untuk engine aktif. */
  inspectorPollIntervalMs: number
  /** Selalu di-overwrite oleh meta frame terbaru (mekanisme rotasi). */
  frameSize: { width: number; height: number }
  close(): Promise<void>
}

export interface CreateSessionDeps {
  client: AdbClient
  log: Logger
  onFrame?: (chunk: Uint8Array, meta: FrameMeta) => void
  onDisplayError?: (err: unknown) => void
  /** Rakit engine inspector (ui-server dgn fallback) — Plan 06. */
  makeInspector?: (deviceId: string, transport: Transport, requested: string | null) => Promise<{
    inspector: Inspector
    engineId: string
    pollIntervalMs: number
    release(): Promise<void>
  }>
}

export interface CreateSessionOpts {
  deviceId: string
  serial: string
  stableId: string
  transport?: string | null
  display?: string | null
  input?: string | null
  inspection?: string | null
  /** Nilai awal sebelum frame pertama datang (probe Plan 01). */
  screenW?: number | null
  screenH?: number | null
}

/**
 * Fallback chain eksplisit (plan 03 §4.7): kolom DB default menyebut engine
 * yang belum ada (scrcpy/scrcpy-uhid/ui-server, spec §12) → resolve ke
 * engine M2 yang tersedia. Nilai kolom DB TIDAK ditulis ulang.
 */
function resolveDisplayId(requested: string | null | undefined, log: Logger): 'screencap-loop' {
  if (requested && requested !== 'screencap-loop') {
    log.info(`display '${requested}' belum tersedia di M2 — fallback ke 'screencap-loop'`)
  }
  return 'screencap-loop'
}

function resolveInputId(requested: string | null | undefined, log: Logger): 'adb-input' {
  if (requested && requested !== 'adb-input') {
    log.info(`input '${requested}' belum tersedia di M2 — fallback ke 'adb-input'`)
  }
  return 'adb-input'
}

export async function createSession(opts: CreateSessionOpts, deps: CreateSessionDeps): Promise<DeviceSession> {
  const { client, log } = deps

  const transportId = opts.transport ?? 'adb-usb'
  let transport: Transport
  if (transportId === 'adb-usb') {
    transport = new AdbUsbTransport({ client, serial: opts.serial, stableId: opts.stableId })
  } else if (transportId === 'adb-tcp') {
    transport = new AdbTcpTransport({ client, serial: opts.serial, stableId: opts.stableId })
  } else {
    throw new EnkakuError('E_ENGINE_NOT_FOUND', `transport tidak dikenal: ${transportId}`)
  }
  await transport.connect()

  resolveDisplayId(opts.display, log)
  resolveInputId(opts.input, log)

  const inspectorHandle = deps.makeInspector
    ? await deps.makeInspector(opts.deviceId, transport, opts.inspection ?? null)
    : null

  const session: DeviceSession = {
    deviceId: opts.deviceId,
    transport,
    display: null as unknown as DisplaySource,
    input: new AdbInput(transport),
    inspector: inspectorHandle?.inspector ?? null,
    inspectorEngineId: inspectorHandle?.engineId ?? 'none',
    inspectorPollIntervalMs: inspectorHandle?.pollIntervalMs ?? 500,
    frameSize: { width: opts.screenW ?? 0, height: opts.screenH ?? 0 },
    async close() {
      await session.display.stop()
      await inspectorHandle?.release()
      await transport.disconnect()
    },
  }

  session.display = new ScreencapLoop(transport, {
    onError: deps.onDisplayError,
    onLog: (level, msg) => log[level](msg),
  })
  session.display.onFrame((chunk, meta) => {
    session.frameSize = { width: meta.width, height: meta.height }
    deps.onFrame?.(chunk, meta)
  })

  return session
}
