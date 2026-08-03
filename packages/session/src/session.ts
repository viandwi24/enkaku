import { shellQuote, type AdbClient } from '@enkaku/adb'
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
import type { DisplaySource, FrameMeta, InputSink, Inspector, KeepAwakeMode, Quality, SessionPhase, Transport } from '@enkaku/protocol'
import { SessionError } from './errors'
import type { Logger } from './logger'
import { wakeDevice } from './wake'

/**
 * Video quality profiles (Plan 42 §3.5): the numbers behind `Quality`. `control`
 * is the device page's full-fidelity picture; `wall` is deliberately small —
 * `wall.maxTiles` (default 8) decoders in one browser tab is the budget this
 * was sized against, on a LAN. Exported so `daemon.ts`/`hosts.ts` can map a
 * requested quality onto the `startScrcpySession` options without a second
 * copy of these numbers.
 */
export const QUALITY_PROFILES: Record<Quality, { maxSize: number; maxFps: number; bitRate: number }> = {
  control: { maxSize: 1600, maxFps: 30, bitRate: 4_000_000 },
  wall: { maxSize: 480, maxFps: 5, bitRate: 800_000 },
}

export interface DeviceSession {
  deviceId: string
  transport: Transport
  display: DisplaySource
  input: InputSink
  /** The effective display and input engines (possibly degraded). */
  displayEngineId: string
  inputEngineId: string
  /** The quality profile this session is actually running at (Plan 42 §3.5, §4.5). */
  quality: Quality
  /** The H.264 config packet (SPS/PPS) that initialises a new viewer's decoder. */
  videoConfig: (() => Uint8Array | null) | null
  /** The most recent IDR frame, so a joining viewer has something to decode. */
  videoKeyframe: (() => Uint8Array | null) | null
  /**
   * Ask the encoder for a fresh keyframe (Plan 17 §3.6, §4.5) — sent when a
   * viewer subscribes, so the first thing they see is current rather than the
   * cached IDR from seconds earlier. Only present when scrcpy is the display
   * engine; the screencap-loop fallback has no such concept.
   */
  requestKeyframe?(): void
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
  /**
   * Device clipboard get/set (plan 38 §3.5, §4.4). `null` only when no engine
   * could even be attempted for this session, which does not happen today
   * (every session has EITHER scrcpy's real control-socket implementation OR
   * the adb fallback shim below) — kept nullable so a future transport that
   * genuinely cannot support it at all has somewhere honest to say so.
   */
  clipboard: {
    get(): Promise<string>
    set(text: string, opts?: { paste?: boolean }): Promise<void>
  } | null
  close(): Promise<void>
}

export interface CreateSessionDeps {
  client: AdbClient
  log: Logger
  onFrame?: (chunk: Uint8Array, meta: FrameMeta) => void
  onDisplayError?: (err: unknown) => void
  /**
   * Start a scrcpy session (H.264 display plus control) — Plan 08. null means
   * unavailable. `quality` (Plan 42 §4.5) is the resolved profile the caller
   * should map onto `max_size`/`max_fps`/`video_bit_rate` via `QUALITY_PROFILES`.
   */
  makeScrcpy?: (deviceId: string, transport: Transport, quality: Quality) => Promise<ScrcpySession | null>
  /** Rakit engine inspector (ui-server dgn fallback) — Plan 06. */
  makeInspector?: (deviceId: string, transport: Transport, requested: string | null) => Promise<{
    inspector: Inspector
    engineId: string
    pollIntervalMs: number
    release(): Promise<void>
  }>
  /** Report which start-up phase this session is in (Plan 17 §3.3, §4.3). */
  onPhase?: (phase: SessionPhase, detail?: string) => void
  /** The input engine degraded from what was requested (Plan 18 §4.2, session.degraded). */
  onInputDegraded?: (from: string, to: string, reason: string) => void
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
  /** DeviceSettings.prep.keepAwake — replaces the old `stayAwake` boolean (Plan 17 §3.4). */
  keepAwake?: KeepAwakeMode
  /** DeviceSettings.prep.standbyScreenOff — dark panel, mirroring stays alive (Plan 17 §3.5). */
  standbyScreenOff?: boolean
  /** The initial value before the first frame arrives (the Plan 01 probe). */
  screenW?: number | null
  screenH?: number | null
  /** Video quality profile (Plan 42 §3.5, §4.5). Defaults to `control` — every pre-plan-42 caller. */
  quality?: Quality
}



export async function createSession(opts: CreateSessionOpts, deps: CreateSessionDeps): Promise<DeviceSession> {
  const { client, log } = deps
  const onPhase = deps.onPhase ?? (() => {})
  const quality: Quality = opts.quality ?? 'control'

  onPhase('connecting')
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

  onPhase('waking')
  /**
   * Wake the screen and hold it awake for the session's lifetime.
   *
   * `DeviceSettings.prep.keepAwake` (formerly a plain `stayAwake` boolean)
   * existed in the schema but nothing read it. Without this the phone dozes
   * on its normal timeout and screencap returns a black frame — the video
   * looks broken when the display is merely off.
   *
   * The actual sequence lives in `wakeDevice` (`./wake.ts`), extracted by
   * Plan 43 §5 step 43.2 so the readiness manager can run the exact same
   * commands to reconcile a device toward `desired: 'awake'` without opening
   * a session at all — behaviour here is unchanged from before the extraction.
   */
  const keepAwake: KeepAwakeMode = opts.keepAwake ?? 'while-charging'
  await wakeDevice(transport, { keepAwake, log })

  onPhase('starting-video')
  // Display and input: scrcpy when the session comes up, otherwise the fallback
  // screencap-loop + adb-input (plan 08 §3.8 degrade chain).
  let scrcpy: ScrcpySession | null = null
  if (opts.display !== 'screencap-loop' && deps.makeScrcpy) {
    scrcpy = await deps.makeScrcpy(opts.deviceId, transport, quality).catch((err) => {
      log.warn(`scrcpy cannot be used (${String(err)}) — falling back to screencap-loop + adb-input`)
      return null
    })
  }

  // Standby (Plan 17 §3.5): the panel goes dark, the encoder keeps producing
  // frames. Opt-in and off by default — a dark phone on a rack is confusing
  // until you know why. Best-effort: some OEM panels wake on any input
  // regardless, and the video stream never depends on this succeeding.
  if (scrcpy && opts.standbyScreenOff) scrcpy.control.setDisplayPower(false)

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
    if (selection.degradedReason) {
      log.info(`input degrade: ${selection.degradedReason}`)
      deps.onInputDegraded?.(opts.preferredInputMode ?? 'uhid', selection.engine, selection.degradedReason)
    }
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
    // Plan 40 §3.6, §4.2, acceptance #8: `AdbInput` cannot curve a gesture
    // (`input swipe` accepts only two points) or type per character with the
    // full engine set scrcpy offers — reported once, right here at session
    // creation, rather than pretending. This fires once per `DeviceSession`
    // (this branch runs exactly once per `createSession` call), which is
    // what "once per session" means: independent of whether a script or a
    // manual drag ever actually asks for a curved gesture.
    deps.onInputDegraded?.(
      opts.preferredInputMode ?? 'uhid',
      'adb-input',
      'no scrcpy control socket available on this session — gestures fall back to a straight-line swipe (no curve, no release velocity)',
    )
  }

  /**
   * Clipboard (plan 38 §3.5, §4.4): scrcpy's real GET_CLIPBOARD/SET_CLIPBOARD
   * round trip when the control socket exists; otherwise an adb shim whose
   * `set` best-effort attempts `cmd clipboard set-text` and whose `get`
   * REFUSES with E_CLIPBOARD_UNAVAILABLE rather than returning "" — an empty
   * string would be indistinguishable from "the clipboard genuinely is
   * empty", which is a lie nobody asked for (§3.5). `paste` has no adb
   * equivalent and is silently ignored on this path; scrcpy is required for it.
   */
  const clipboard: DeviceSession['clipboard'] = scrcpy
    ? {
        get: () => scrcpy!.control.getClipboard(),
        set: (text, opts) => scrcpy!.control.setClipboard(text, opts),
      }
    : {
        async get() {
          throw Object.assign(
            new Error('reading the clipboard requires an active scrcpy session (this device is on screencap-loop)'),
            { code: 'E_CLIPBOARD_UNAVAILABLE' },
          )
        },
        async set(text) {
          await transport.exec(`cmd clipboard set-text ${shellQuote(text)}`, { profile: 'appLifecycle' })
        },
      }

  const session: DeviceSession = {
    deviceId: opts.deviceId,
    transport,
    display: null as unknown as DisplaySource,
    input,
    displayEngineId: scrcpyDisplay ? 'scrcpy' : 'screencap-loop',
    inputEngineId,
    quality,
    videoConfig: scrcpyDisplay ? () => scrcpyDisplay.configPacket : null,
    videoKeyframe: scrcpyDisplay ? () => scrcpyDisplay.keyframePacket : null,
    ...(scrcpy ? { requestKeyframe: () => scrcpy!.control.resetVideo() } : {}),
    inspector: null,
    inspectorEngineId: 'starting',
    inspectorPollIntervalMs: 500,
    whenInspectorReady: startInspector,
    frameSize: { width: opts.screenW ?? 0, height: opts.screenH ?? 0 },
    clipboard,
    async close() {
      // Restore the panel before the control socket goes away with the rest
      // of the session — leaving the phone dark for whoever uses it next
      // would be a worse surprise than the standby mode itself.
      if (scrcpy && opts.standbyScreenOff) scrcpy.control.setDisplayPower(true)
      await session.display.stop()
      // Hand the screen back to the device's own timeout.
      if (keepAwake !== 'off')
        await transport.exec('svc power stayon false', { profile: 'probe' }).catch(() => undefined)
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

    /**
     * Report the scrcpy session dying, so the manager drops it.
     *
     * `ScreencapLoop` has always reported its own failures through
     * `onDisplayError`, and the manager reacts by closing the entry. The scrcpy
     * path never did: `ScrcpySession.onClose` existed and nothing subscribed to
     * it. When the server exited — a crash, a USB blip, `cleanup=true` firing —
     * the dead session stayed in the manager's cache, and every later viewer
     * was handed it. `stream.start` then returned in ~1 ms and delivered zero
     * frames, for ever, with no error anywhere.
     *
     * Symptom: the wake-up panel sits on "Waiting for the first frame" while
     * the phone is plainly awake, and `ps -A | grep app_process` on the device
     * shows no server at all.
     */
    scrcpy.onClose((reason) => {
      deps.onDisplayError?.(new Error(`the scrcpy session ended: ${reason}`))
    })
  }

  session.display =
    scrcpyDisplay ??
    new ScreencapLoop(transport, {
      onError: deps.onDisplayError,
      onLog: (level, msg) => log[level](msg),
    })
  let firstFrameSeen = false
  session.display.onFrame((chunk, meta) => {
    session.frameSize = { width: meta.width, height: meta.height }
    if (!firstFrameSeen) {
      firstFrameSeen = true
      onPhase('ready')
    }
    deps.onFrame?.(chunk, meta)
  })

  return session
}
