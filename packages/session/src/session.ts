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
  withAdbKeyFallback,
} from '@enkaku/drivers'
import type { ScrcpySession } from '@enkaku/scrcpy'
import type { DisplaySource, FrameMeta, InputSink, Inspector, Transport } from '@enkaku/protocol'
import { SessionError } from './errors'
import type { Logger } from './logger'

export interface DeviceSession {
  deviceId: string
  transport: Transport
  display: DisplaySource
  input: InputSink
  /** The effective display and input engines (possibly degraded). */
  displayEngineId: string
  inputEngineId: string
  /** The H.264 config packet (SPS/PPS) that initialises a new viewer's decoder. */
  videoConfig: (() => Uint8Array | null) | null
  /** The most recent IDR frame, so a joining viewer has something to decode. */
  videoKeyframe: (() => Uint8Array | null) | null
  /** This session's inspector engine (ui-server / uiautomator-dump). Null until it is ready. */
  inspector: Inspector | null
  /**
   * Starts the inspector if it is not running yet, and resolves when it is
   * ready (or has given up). Jobs call this; manual control never does, so the
   * adb queue stays free for video.
   */
  whenInspectorReady(): Promise<void>
  /** The effective engine id — it can differ from the DB column after a fallback. */
  inspectorEngineId: string
  /** The waitFor polling interval that suits the active engine. */
  inspectorPollIntervalMs: number
  /** Always overwritten by the latest frame metadata (this is how rotation works). */
  frameSize: { width: number; height: number }
  close(): Promise<void>
}

export interface CreateSessionDeps {
  client: AdbClient
  log: Logger
  onFrame?: (chunk: Uint8Array, meta: FrameMeta) => void
  onDisplayError?: (err: unknown) => void
  /** Start a scrcpy session (H.264 display plus control) — Plan 08. null means unavailable. */
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
  /** DeviceSettings.prep.stayAwake — keeps the screen on for the session's lifetime. */
  stayAwake?: boolean
  /** The initial value before the first frame arrives (the Plan 01 probe). */
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
    throw new SessionError('engine_not_found', `unknown transport: ${transportId}`)
  }
  await transport.connect()

  /**
   * The inspector is started lazily, on first use, and never for manual control.
   *
   * Two measurements on a real moto g06 power (Android 15) drove this:
   *   - awaiting it up front delayed the first video frame by ~50 s, because
   *     ui-server's watchdog retries twice before giving up;
   *   - starting it in the background instead was worse in a subtler way. adb
   *     access is serialised per device, so the watchdog's installs starved the
   *     screencap loop: 1 frame in 20 s, versus 11 once it gave up.
   *
   * Only scripts need an inspector, through waitFor/find. So it starts when the
   * job runner asks for it, and manual control gets the adb queue to itself.
   */
  let inspectorHandle: Awaited<ReturnType<NonNullable<CreateSessionDeps['makeInspector']>>> | null = null
  let inspectorPromise: Promise<void> | null = null
  const startInspector = (): Promise<void> => {
    if (!deps.makeInspector) return Promise.resolve()
    inspectorPromise ??= deps
      .makeInspector(opts.deviceId, transport, opts.inspection ?? null)
      .then((h) => {
        inspectorHandle = h
        session.inspector = h.inspector
        session.inspectorEngineId = h.engineId
        session.inspectorPollIntervalMs = h.pollIntervalMs
      })
      .catch((err) => {
        log.warn(`inspector could not start: ${String(err)} — scripts will use an ad-hoc dump`)
      })
    return inspectorPromise
  }

  /**
   * Wake the screen and hold it awake for the session's lifetime.
   *
   * `DeviceSettings.prep.stayAwake` existed in the schema but nothing read it.
   * Without this the phone dozes on its normal timeout and screencap returns a
   * black frame — the video looks broken when the display is merely off.
   *
   * The keyevent 82 dismisses a swipe-only lock screen. A device with a PIN,
   * pattern, or password cannot be unlocked from here, and will keep showing
   * its lock screen; that is a real limit, not a failure to handle.
   */
  if (opts.stayAwake !== false) {
    for (const cmd of ['input keyevent KEYCODE_WAKEUP', 'svc power stayon usb']) {
      await transport.exec(cmd).catch((err) => log.debug(`${cmd} failed: ${String(err)}`))
    }
    // Only nudge the lock screen when there is one. KEYCODE_MENU dismisses a
    // swipe-only keyguard, but on a phone that is already unlocked it opens the
    // launcher's wallpaper/widget menu — and the user's next tap just closes
    // that menu instead of hitting the app they aimed at.
    const locked = await transport
      .exec('dumpsys window | grep -m1 isKeyguardShowing')
      .then((out) => /isKeyguardShowing=true/.test(out))
      .catch(() => false)
    if (locked) {
      await transport.exec('input keyevent 82').catch((err) => log.debug(`keyguard nudge failed: ${String(err)}`))
    }
  }

  // Display and input: scrcpy when the session comes up, otherwise the fallback
  // screencap-loop + adb-input (plan 08 §3.8 degrade chain).
  let scrcpy: ScrcpySession | null = null
  if (opts.display !== 'screencap-loop' && deps.makeScrcpy) {
    scrcpy = await deps.makeScrcpy(opts.deviceId, transport).catch((err) => {
      log.warn(`scrcpy cannot be used (${String(err)}) — falling back to screencap-loop + adb-input`)
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
    // The UHID pointer is registered on first use, not here. Sending
    // UHID_CREATE the instant the control socket opens is too early — the
    // server is not reading control messages yet and the pointer never
    // materialises, so taps land nowhere. Registering it at the first tap
    // costs that tap about a second, once per session.
    const engine = selection.engine === 'scrcpy-uhid' ? new ScrcpyUhidInput(inputDeps) : new ScrcpySdkInput(inputDeps)
    // Volume keys do not survive scrcpy injection on every device; those go
    // over adb so the buttons in the UI actually move the volume.
    input = withAdbKeyFallback(engine, transport)
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
    videoKeyframe: scrcpyDisplay ? () => scrcpyDisplay.keyframePacket : null,
    inspector: null,
    inspectorEngineId: 'starting',
    inspectorPollIntervalMs: 500,
    whenInspectorReady: startInspector,
    frameSize: { width: opts.screenW ?? 0, height: opts.screenH ?? 0 },
    async close() {
      await session.display.stop()
      // Hand the screen back to the device's own timeout.
      if (opts.stayAwake !== false) await transport.exec('svc power stayon false').catch(() => undefined)
      await inspectorHandle?.release()
      await transport.disconnect()
    },
  }

  // Keep the size the core maps taps against identical to the size the input
  // engine declares to scrcpy.
  //
  // `frameSize` used to be updated only when a frame arrived, so while the
  // screen was static it still held the value read from the database
  // (720×1640) while scrcpy was really sending 704×1600. A tap was then
  // computed in one coordinate space and injected in another: it landed a few
  // percent off and hit nothing. The video appeared fine, the tap "succeeded",
  // and the phone ignored it — which is why this looked intermittent rather
  // than broken.
  if (scrcpy) {
    const applySize = (m: { width: number; height: number }) => {
      session.frameSize = { width: m.width, height: m.height }
    }
    if (scrcpy.meta) applySize(scrcpy.meta)
    scrcpy.onMetaChange(applySize)
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
