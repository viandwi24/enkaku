import type { AdbClient } from '@enkaku/adb'
import {
  AdbInput,
  AdbTcpTransport,
  AdbUsbTransport,
  ScreencapLoop,
  ScrcpyDisplay,
  ScrcpySdkInput,
  ScrcpyUhidInput,
  selectInputEngine,
} from '@enkaku/drivers'
import type { ScrcpySession } from '@enkaku/scrcpy'
import type { DisplaySource, FrameMeta, InputSink, Inspector, Transport } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

export interface DeviceSession {
  deviceId: string
  transport: Transport
  display: DisplaySource
  input: InputSink
  /** Engine display & input efektif (bisa hasil degrade). */
  displayEngineId: string
  inputEngineId: string
  /** Config packet H.264 (SPS/PPS) untuk init decoder viewer baru. */
  videoConfig: (() => Uint8Array | null) | null
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
  /** Start sesi scrcpy (display H.264 + control) — Plan 08. null = tidak tersedia. */
  makeScrcpy?: (deviceId: string, transport: Transport) => Promise<ScrcpySession | null>
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
  apiLevel?: number | null
  /** DeviceSettings.input.preferredMode. */
  preferredInputMode?: 'uhid' | 'sdk' | 'aoa'
  /** Nilai awal sebelum frame pertama datang (probe Plan 01). */
  screenW?: number | null
  screenH?: number | null
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

  const inspectorHandle = deps.makeInspector
    ? await deps.makeInspector(opts.deviceId, transport, opts.inspection ?? null)
    : null

  // Display & input: scrcpy kalau sesi berhasil dibuat, selain itu fallback
  // screencap-loop + adb-input (plan 08 §3.8 degrade chain).
  let scrcpy: ScrcpySession | null = null
  if (opts.display !== 'screencap-loop' && deps.makeScrcpy) {
    scrcpy = await deps.makeScrcpy(opts.deviceId, transport).catch((err) => {
      log.warn(`scrcpy tidak bisa dipakai (${String(err)}) — fallback screencap-loop + adb-input`)
      return null
    })
  }

  const scrcpyDisplay = scrcpy ? new ScrcpyDisplay(scrcpy) : null
  const screenSize = () =>
    scrcpyDisplay?.size.width
      ? scrcpyDisplay.size
      : { width: opts.screenW ?? 0, height: opts.screenH ?? 0 }

  let input: InputSink
  let inputEngineId: string
  if (scrcpy) {
    const selection = selectInputEngine({
      preferred: opts.preferredInputMode ?? 'uhid',
      apiLevel: opts.apiLevel ?? null,
      scrcpyAvailable: true,
    })
    if (selection.degradedReason) log.info(`input degrade: ${selection.degradedReason}`)
    const inputDeps = { session: scrcpy, screenSize, onLog: (l: 'debug' | 'warn', m: string) => log[l](m) }
    input = selection.engine === 'scrcpy-uhid' ? new ScrcpyUhidInput(inputDeps) : new ScrcpySdkInput(inputDeps)
    inputEngineId = selection.engine
  } else {
    input = new AdbInput(transport)
    inputEngineId = 'adb-input'
  }

  const session: DeviceSession = {
    deviceId: opts.deviceId,
    transport,
    display: null as unknown as DisplaySource,
    input,
    displayEngineId: scrcpyDisplay ? 'scrcpy' : 'screencap-loop',
    inputEngineId,
    videoConfig: scrcpyDisplay ? () => scrcpyDisplay.configPacket : null,
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

  session.display =
    scrcpyDisplay ??
    new ScreencapLoop(transport, {
      onError: deps.onDisplayError,
      onLog: (level, msg) => log[level](msg),
    })
  session.display.onFrame((chunk, meta) => {
    session.frameSize = { width: meta.width, height: meta.height }
    deps.onFrame?.(chunk, meta)
  })

  return session
}
