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
  type GuestAgentClientRunner,
} from '@enkaku/drivers'
import type { ScrcpySession } from '@enkaku/scrcpy'
import { defaultFarmSettings, type DisplaySource, type FrameMeta, type GuestAgentCapability, type InputSink, type Inspector, type KeepAwakeMode, type Quality, type RotationMode, type SessionPhase, type TextInputMode, type Transport } from '@enkaku/protocol'
import { SessionError } from './errors'
import { applyFarmTag } from './farm-tag'
import { createInputArbiter, type InputArbiter } from './input-arbiter'
import type { Logger } from './logger'
import { applyRotation } from './orientation'
import { applyTextInput } from './text-input'
import { resolveVideoProfile, type VideoProfile } from './video-profile'
import { wakeDevice } from './wake'

/**
 * Plan 91 §4.1, §4.5 — the arbiter's bounded-queue budget, mirroring
 * `coControl.queueWaitMs`/`coControl.maxQueueDepth`'s own schema defaults
 * (`packages/protocol/src/settings.ts`). `daemon.ts`'s `createSessionManager({...})`
 * call threads the real, live farm setting through `SessionManagerDeps` →
 * `CreateSessionDeps` (fixed 2026-08-13 — `docs/plans/96-m61-hotfixes.md`
 * §96.13); these constants remain the fallback for any caller that supplies
 * no accessor at all — a test/fixture `SessionManager`, or the node
 * package's own mini-core, which does not run co-control (`00-overview.md`
 * §4.1's `node` boundary).
 */
const DEFAULT_ARBITER_QUEUE_WAIT_MS = 5_000
const DEFAULT_ARBITER_MAX_QUEUE_DEPTH = 32

/**
 * Plan 100 §4.3, step 100.6 (closes 96.22/G10/G11) — the screencap-loop
 * fallback used to be chosen once, at open, and never re-attempted: a single
 * transient `makeScrcpy` failure pinned a device to PNG screencaps (measured
 * at 87% device CPU) for the session's whole life, with no way back short of
 * a full core restart. `armFallbackRetry`/`attemptFallbackRecovery` below
 * re-attempt `makeScrcpy` on this bounded backoff and swap the session's live
 * display source in place on success — carrying every existing frame
 * subscriber across the swap, never rebuilding the session.
 *
 * 10s, 30s, 60s, then a 5-minute steady state — bounded by
 * `FarmSettings.display.fallbackRetryCount` (default 6), read fresh on every
 * decision like every other farm setting this file consults. A device that
 * genuinely cannot run scrcpy (not merely unlucky at the moment it opened)
 * settles honestly into the degraded state once the budget is spent, rather
 * than polling forever.
 */
const FALLBACK_RETRY_SCHEDULE_MS = [10_000, 30_000, 60_000]
const FALLBACK_RETRY_STEADY_STATE_MS = 300_000
const DEFAULT_FALLBACK_RETRY_COUNT = 6

function fallbackRetryDelayMs(attempt: number): number {
  return FALLBACK_RETRY_SCHEDULE_MS[attempt - 1] ?? FALLBACK_RETRY_STEADY_STATE_MS
}

export interface DeviceSession {
  deviceId: string
  transport: Transport
  display: DisplaySource
  /**
   * Plan 91 §3.1, §3.3, §4.1 — fixes F6/H1. The raw sink has no
   * serialisation: two overlapping callers interleave writes on the ONE
   * shared virtual pointer, which produces a phone that misbehaves rather
   * than a phone that is shared. `input` stays on the session ONLY so
   * `arbiter` (below) can wrap it — every other caller migrated to
   * `session.arbiter.for(source)` in the same commit (`00-overview.md` §4.3).
   * Calling this directly bypasses that serialisation.
   */
  input: InputSink
  /**
   * Every input write goes through this (plan 91 §3.3, §4.1): three
   * independent, non-preemptive priority lanes (`pointer`/`keys`/`text`)
   * over the SAME `input` sink above, so two input sources on one device
   * (a job and an assisting human, plan 91's whole premise) never interleave
   * one pointer's down/move/up.
   */
  arbiter: InputArbiter
  /** The effective display and input engines (possibly degraded). */
  displayEngineId: string
  inputEngineId: string
  /** The quality profile this session is actually running at (Plan 42 §3.5, §4.5). */
  quality: Quality
  /**
   * The resolved numbers this session's encoder was actually started with
   * (plan 92 §3.8, §4.3 rule 1) — `opts.videoProfile` when the caller
   * supplied one, otherwise the same schema-default fallback `createSession`
   * itself falls back to. Every session `createSession` returns sets this;
   * it is typed optional only so the dozens of hand-built `DeviceSession`
   * fixtures across `packages/core`'s WS-handler tests (none of them about
   * video) do not all need to grow a stub in this commit — the same
   * fixture-compatibility reason `SessionManager.videoStats`/`restartAt`
   * are optional (`packages/session/src/manager.ts`).
   * `SessionManager.reprofile()` reads the equivalent value it tracks on its
   * own `Entry` (never this field directly, so it never has to branch on the
   * optionality) to decide whether a session needs restarting — comparing
   * resolved numbers, never settings identity, so a farm settings save that
   * touched an unrelated field restarts nothing.
   */
  videoProfile?: VideoProfile
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
   * ready (or has given up). Jobs call this; manual control never starts it
   * IMPLICITLY — the Inspect tab (plan 56 §4.3) is the one caller that starts
   * it explicitly, through `inspect.attach`, so the adb queue stays free for
   * video the rest of the time.
   */
  whenInspectorReady(): Promise<void>
  /**
   * Gives the inspector engine back (plan 56 §3.2, §4.3) — releases the
   * handle's own `release()` (stops the watchdog, frees its port/lock) and
   * resets `inspector`/`inspectorEngineId` so the NEXT `whenInspectorReady()`
   * builds a fresh engine rather than resolving against a dead handle. The
   * Inspect tab calls this once its last viewer detaches; jobs never call it
   * — a script's inspector lives for the session, not for one `find`.
   */
  releaseInspector(): Promise<void>
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
  /**
   * Text-input routing facts (plan 90 §3.2, §3.3, §4.5) — computed once at session start by
   * `applyTextInput()`, mirroring `clipboard`'s shape above. `resolveTextRoute` (`./text-input.ts`)
   * is the one place that turns these fields plus a candidate string into a rung; the WS handler
   * and the script executor both call it rather than re-deriving any of this themselves.
   */
  textInput: {
    mode: TextInputMode
    /** From the guest agent's own `hello()`, learned once at session start; `null` when `mode: 'device'` or no agent client is wired for this session. */
    agentCapabilities: GuestAgentCapability[] | null
    /** Whether the agent's IME is this device's live default input method, confirmed by reading `secure default_input_method` back after `ime set` — never assumed from the write alone. */
    imeCurrent: boolean
    /**
     * Commits through the agent's `text.commit` (rung 1). Throws `E_TEXT_AGENT_UNAVAILABLE` when
     * no guest-agent client is wired for this session — callers are expected to have already
     * checked `agentCapabilities`/`imeCurrent` via `resolveTextRoute` before calling this.
     */
    commitViaAgent(text: string, perCharMs?: [number, number]): Promise<{ committed: number; imeCurrent: boolean }>
  }
  close(): Promise<void>
}

export interface CreateSessionDeps {
  client: AdbClient
  log: Logger
  onFrame?: (chunk: Uint8Array, meta: FrameMeta) => void
  onDisplayError?: (err: unknown) => void
  /**
   * Start a scrcpy session (H.264 display plus control) — Plan 08. null means
   * unavailable. `profile` (Plan 42 §4.5, plan 92 §4.2) is the ALREADY-RESOLVED
   * video profile (`opts.videoProfile`, or `createSession`'s own fallback) —
   * the caller maps `profile.maxSize`/`profile.maxFps`/`profile.bitRate`
   * straight onto `max_size`/`max_fps`/`video_bit_rate`; there is no lookup
   * table left to consult (`QUALITY_PROFILES` was deleted by plan 92 §4.2).
   */
  makeScrcpy?: (deviceId: string, transport: Transport, profile: VideoProfile) => Promise<ScrcpySession | null>
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
  /**
   * Plan 90 §3.2, §3.3, §4.5, §5 step 90.5 — a guest-agent client runner already scoped to THIS
   * device (mirrors `GuestAgentClientRunner`'s existing shape,
   * `packages/drivers/src/identity/mock-location.ts`, and the "one `withClient` call at a time"
   * contract it documents). Undefined means no agent client is wired for this session — the same
   * "no agent installed" reading `applyTextInput` gives an install that genuinely has none.
   *
   * **Wiring note:** `daemon.ts`'s `createSessionManager({...})` call now constructs a real value
   * for this (fixed 2026-08-13 — `docs/plans/96-m61-hotfixes.md` §96.6: `withGuestAgentClient:
   * (deviceId) => (fn) => guestAgent.withGuestAgentClient(deviceId, fn)`), so a session on a device
   * with an installed, capable agent gets a real runner here in production. `undefined` is still
   * the honest reading for a test/fixture `SessionManager` that supplies none, or a session on a
   * device with no agent reachable — in both cases text input falls to the remaining rungs exactly
   * as if no agent existed, never a crash.
   */
  withGuestAgentClient?: GuestAgentClientRunner
  /**
   * Plan 91 §4.1, §4.5 — the input arbiter's bounded-queue budget, read fresh
   * on every submission (like every other farm setting) — `input-arbiter.ts`'s
   * own `submit()` calls these functions on each new action, never once at
   * session build time, so a value mutated after this session already exists
   * still reaches it. Undefined falls back to this file's own
   * `DEFAULT_ARBITER_QUEUE_WAIT_MS`/`DEFAULT_ARBITER_MAX_QUEUE_DEPTH`.
   * `SessionManagerDeps.arbiterQueueWaitMs`/`arbiterMaxQueueDepth`
   * (`packages/session/src/manager.ts`) forward these two straight through
   * from `daemon.ts`'s live `coControl.queueWaitMs`/`coControl.maxQueueDepth`
   * settings accessors (fixed 2026-08-13 — `docs/plans/96-m61-hotfixes.md`
   * §96.13).
   */
  arbiterQueueWaitMs?: () => number
  arbiterMaxQueueDepth?: () => number
  /**
   * Plan 100 §4.3, step 100.6 — `FarmSettings.display.fallbackRetryCount`,
   * read fresh on every retry decision (the same freshness discipline
   * `arbiterQueueWaitMs`/`idleTtlSec` etc. already use). Undefined falls back
   * to this file's own `DEFAULT_FALLBACK_RETRY_COUNT`.
   */
  fallbackRetryCount?: () => number
  /**
   * Test seam for the screencap-loop fallback's background retry timer —
   * defaults to the real `setTimeout`/`clearTimeout`. A test supplies a fake
   * pair (e.g. firing `fn` synchronously, or on an explicit trigger) instead
   * of waiting out real 10s/30s/60s/300s wall-clock delays.
   */
  scheduleFallbackRetry?: (fn: () => void | Promise<void>, ms: number) => unknown
  cancelFallbackRetry?: (handle: unknown) => void
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
  /** DeviceSettings.prep.rotation — screen orientation lock, reverted on close (Plan 85 §3.7, §4.1). */
  rotation?: RotationMode
  /** DeviceSettings.prep.textInput — which keyboard types during this session, reverted on close (Plan 90 §3.2, §4.4, §5 step 90.5). */
  textInput?: TextInputMode
  /**
   * DeviceSettings.instrumentation.tagTraffic — mark this device as part of
   * an Enkaku farm for the life of the session, reverted on close (spec
   * §9.4/§17; plan 87 §4.12, §5 step 87.13). Defaults to `true` when omitted
   * — "on by default" is the spec's own wording for this setting.
   */
  tagTraffic?: boolean
  /** The initial value before the first frame arrives (the Plan 01 probe). */
  screenW?: number | null
  screenH?: number | null
  /** Video quality profile (Plan 42 §3.5, §4.5). Defaults to `control` — every pre-plan-42 caller. */
  quality?: Quality
  /**
   * The already-resolved video numbers this session's encoder should start
   * with (plan 92 §3.5, §4.2, §4.3) — replaces `quality` as a lookup key
   * into a fixed table (`QUALITY_PROFILES`, deleted). The caller
   * (`packages/session/src/manager.ts`'s `createEntry`) resolves this via
   * `resolveVideoProfile(farm, device, quality)` before calling
   * `createSession`, so farm and per-device settings are already applied by
   * the time this reaches `makeScrcpy`. Omitted only by a caller with no
   * settings to resolve against (a test/fixture, or the node package's own
   * mini-core) — `createSession` falls back to the schema defaults for
   * `quality` alone, which are `CONTROL_PRESETS.sharp`/`WALL_PRESETS.balanced`
   * and therefore byte-identical to the pre-plan-92 constants.
   */
  videoProfile?: VideoProfile
}



export async function createSession(opts: CreateSessionOpts, deps: CreateSessionDeps): Promise<DeviceSession> {
  const { client, log } = deps
  const onPhase = deps.onPhase ?? (() => {})
  const quality: Quality = opts.quality ?? 'control'
  // plan 92 §3.5, §4.2 — the resolved numbers this session's encoder starts
  // with. When the caller supplies none (a test/fixture, or the node
  // package's mini-core, which carries no farm settings store), fall back to
  // the schema defaults for `quality` alone — `defaultFarmSettings().video`'s
  // defaults ARE `CONTROL_PRESETS.sharp`/`WALL_PRESETS.balanced`, so this is
  // byte-identical to the pre-plan-92 `QUALITY_PROFILES` constants.
  const videoProfile: VideoProfile = opts.videoProfile ?? resolveVideoProfile(defaultFarmSettings().video, null, quality)

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
   * The inspector is started lazily, on first use, and never IMPLICITLY for
   * manual control.
   *
   * Two measurements on a real moto g06 power (Android 15) drove this:
   *   - awaiting it up front delayed the first video frame by ~50 s, because
   *     ui-server's watchdog retries twice before giving up;
   *   - starting it in the background instead was worse in a subtler way. adb
   *     access is serialised per device, so the watchdog's installs starved the
   *     screencap loop: 1 frame in 20 s, versus 11 once it gave up.
   *
   * Scripts need an inspector through waitFor/find, so the job runner starts
   * it. Manual control never starts it on its own either — but the Inspect
   * tab (plan 56 §3.2, §4.3) DOES, explicitly, through `inspect.attach`: an
   * operator who opens that tab has consciously chosen to pay the
   * instrumentation-lock and adb-queue cost `whenInspectorReady` was written
   * to avoid paying by default. `releaseInspector` below is what lets that
   * cost be given back once the tab closes, rather than being paid for the
   * rest of the session.
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
  const releaseInspector = async (): Promise<void> => {
    const handle = inspectorHandle
    inspectorHandle = null
    inspectorPromise = null
    session.inspector = null
    session.inspectorEngineId = 'starting'
    await handle?.release()
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

  /**
   * Rotation lock (Plan 85 §3.7, §4.1, step 85.8): the identical shape to
   * `wakeDevice` right above — a device-scoped preference applied here and
   * reverted in `close()` below. `applyRotation` reads the device's current
   * `accelerometer_rotation` before touching anything, so the revert thunk it
   * returns can put it back exactly rather than to a hardcoded value.
   * `'device'` (the default) touches nothing and the thunk is a no-op.
   */
  const rotation: RotationMode = opts.rotation ?? 'device'
  const revertRotation = await applyRotation(transport, { rotation, log })

  /**
   * Text-input keyboard (plan 90 §3.2, §3.3, §4.5, §5 step 90.5): the identical shape to
   * `applyRotation` right above. `mode: 'device'` (or no guest-agent client wired for this
   * session) touches nothing and the revert thunk is a no-op. Otherwise reads the device's
   * current `secure default_input_method`, switches to the agent's IME, and confirms the switch
   * actually took by reading the setting back — `agentCapabilities`/`imeCurrent` below are what
   * `resolveTextRoute` (`./text-input.ts`) reads on every `input.text`/`type()` call, so the
   * ladder never needs a live round trip per keystroke.
   */
  const textInputMode: TextInputMode = opts.textInput ?? 'auto'
  const textInputSetup = await applyTextInput(transport, {
    mode: textInputMode,
    ...(deps.withGuestAgentClient ? { withGuestAgentClient: deps.withGuestAgentClient } : {}),
    log,
  })

  /**
   * Farm-traffic marker (spec §9.4/§17, plan 87 §4.12, §5 step 87.13): the
   * same shape as `applyRotation` right above — device-scoped, applied here,
   * reverted in `close()`. Defaults to `true` ("on by default" is the spec's
   * own wording); `applyFarmTag` is what actually enforces "never claim a
   * device is tagged when it is not" when the underlying `setprop` fails.
   */
  const tagTraffic = opts.tagTraffic ?? true
  const revertFarmTag = await applyFarmTag(transport, { tagTraffic, log })

  onPhase('starting-video')
  // Display and input: scrcpy when the session comes up, otherwise the fallback
  // screencap-loop + adb-input (plan 08 §3.8 degrade chain).
  let scrcpy: ScrcpySession | null = null
  // Plan 100 §4.3 step 100.6: distinguishes a DELIBERATE `screencap-loop`
  // configuration (`opts.display === 'screencap-loop'`, never retried — that
  // is the operator's own choice) from an ATTEMPTED-AND-FAILED scrcpy build
  // (the transient-failure case 96.22 recorded, which the retry below exists
  // to heal). Only the latter arms the background retry.
  let displayAttemptFailed = false
  if (opts.display !== 'screencap-loop' && deps.makeScrcpy) {
    scrcpy = await deps.makeScrcpy(opts.deviceId, transport, videoProfile).catch((err) => {
      displayAttemptFailed = true
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
   * Plan 91 §3.1, §3.3, §4.1 — the arbiter wraps the raw `input` sink built
   * above, ONCE per session, so every caller shares the same three lanes
   * (fixes F6/H1: two callers writing to the one shared virtual pointer with
   * no coordination). `input` itself is unchanged and stays on the session
   * only so the arbiter has something to wrap — every other caller migrates
   * to `session.arbiter.for(source)` in this same commit.
   */
  const arbiter = createInputArbiter(input, {
    queueWaitMs: deps.arbiterQueueWaitMs ?? (() => DEFAULT_ARBITER_QUEUE_WAIT_MS),
    maxQueueDepth: deps.arbiterMaxQueueDepth ?? (() => DEFAULT_ARBITER_MAX_QUEUE_DEPTH),
    log,
  })

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

  // Plan 100 §4.3 step 100.6: the LIVE scrcpy session backing `session.display`
  // right now — starts equal to `scrcpy` above, and is repointed at the fresh
  // one if the fallback retry below ever recovers. `close()` reads THIS, not
  // the outer `scrcpy` const, so a device that recovered from the fallback
  // still gets its standby-screen restore against the session actually open.
  let liveScrcpy: ScrcpySession | null = scrcpy

  // Plan 100 §4.3 step 100.6 — the fallback retry timer's own state, declared
  // here (rather than beside `armFallbackRetry`/`attemptFallbackRecovery`
  // below, which need the fully-built `session` object to swap onto) so
  // `close()` above can reference them.
  let closed = false
  let fallbackRetryAttempt = 0
  let fallbackRetryTimer: unknown = null
  const scheduleFallbackRetry = deps.scheduleFallbackRetry ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const cancelFallbackRetry = deps.cancelFallbackRetry ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  const session: DeviceSession = {
    deviceId: opts.deviceId,
    transport,
    display: null as unknown as DisplaySource,
    input,
    arbiter,
    displayEngineId: scrcpyDisplay ? 'scrcpy' : 'screencap-loop',
    inputEngineId,
    quality,
    videoProfile,
    videoConfig: scrcpyDisplay ? () => scrcpyDisplay.configPacket : null,
    videoKeyframe: scrcpyDisplay ? () => scrcpyDisplay.keyframePacket : null,
    ...(scrcpy ? { requestKeyframe: () => scrcpy!.control.resetVideo() } : {}),
    inspector: null,
    inspectorEngineId: 'starting',
    inspectorPollIntervalMs: 500,
    whenInspectorReady: startInspector,
    releaseInspector,
    frameSize: { width: opts.screenW ?? 0, height: opts.screenH ?? 0 },
    clipboard,
    textInput: {
      mode: textInputMode,
      agentCapabilities: textInputSetup.agentCapabilities,
      imeCurrent: textInputSetup.imeCurrent,
      async commitViaAgent(text, perCharMs) {
        if (!deps.withGuestAgentClient) {
          throw Object.assign(new Error('no guest agent is reachable for this session'), { code: 'E_TEXT_AGENT_UNAVAILABLE' })
        }
        const result = await deps.withGuestAgentClient((client) => client.textCommit(text, perCharMs))
        return { committed: result.committed, imeCurrent: result.ime === 'current' }
      },
    },
    async close() {
      // Plan 100 §4.3 step 100.6: stop arming further retries and cancel any
      // in-flight timer FIRST — a retry that fires after close() has already
      // torn the session down must not resurrect a display on a dead session
      // (see `attemptFallbackRecovery`'s own `closed` check below).
      closed = true
      if (fallbackRetryTimer !== null) {
        cancelFallbackRetry(fallbackRetryTimer)
        fallbackRetryTimer = null
      }
      // Restore the panel before the control socket goes away with the rest
      // of the session — leaving the phone dark for whoever uses it next
      // would be a worse surprise than the standby mode itself. `liveScrcpy`,
      // not the outer `scrcpy` const: a session that recovered from the
      // screencap-loop fallback is now backed by a DIFFERENT scrcpy session.
      if (liveScrcpy && opts.standbyScreenOff) liveScrcpy.control.setDisplayPower(true)
      await session.display.stop()
      // Hand the screen back to the device's own timeout.
      if (keepAwake !== 'off')
        await transport.exec('svc power stayon false', { profile: 'probe' }).catch(() => undefined)
      // Hand rotation back the same way — stateless and idempotent (see
      // `orientation.ts`): `close()` can run more than once (a timeout kill
      // followed by a normal close, for instance), and calling this twice
      // must be safe. It always re-issues the exact command it captured at
      // apply time, so a second call is a no-op on the device, not a fresh
      // mutation of some remembered "already reverted" flag.
      await revertRotation()
      // Same idempotent-thunk contract as rotation right above — safe to
      // call more than once, including after a `SIGKILL` mid-session: the
      // next process's own `close()` (or the next session's `applyTextInput`
      // read-first step) re-issues the exact restore command captured at
      // apply time, never a fresh mutation of some remembered flag.
      await textInputSetup.revert()
      // Same idempotent-thunk contract as rotation right above — safe to
      // call more than once (a timeout kill followed by a normal close).
      await revertFarmTag()
      await inspectorHandle?.release()
      // Plan 88 §3.7 (fixes F12/H6): this call stays, but its MEANING
      // changed. It used to drop the whole adb transport for `adb-tcp` —
      // `host:disconnect` on session close — so closing one wall tile
      // silently kicked a wireless/OTG phone off adb entirely, sometimes
      // unrecoverably from Studio. `Transport.disconnect()` is now defined
      // as session-scoped only (`packages/protocol/src/driver.ts`);
      // `AdbTcpTransport.disconnect()` is a documented no-op
      // (`packages/drivers/src/transport/adb-transport.ts`). This call
      // remains so a future transport WITH real session-scoped state (a
      // socket pool, a per-session token) still has somewhere to release it.
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

  /**
   * Plan 100 §4.3 step 100.6 — arms the next bounded-backoff retry, unless
   * the session has since closed or the retry budget (`fallbackRetryCount`,
   * default `DEFAULT_FALLBACK_RETRY_COUNT`) is spent. Read fresh on every
   * call, like every other farm-setting accessor in this file, so a farm
   * setting raised mid-fallback still takes effect on the NEXT decision.
   */
  function armFallbackRetry(): void {
    if (closed) return
    const maxAttempts = deps.fallbackRetryCount?.() ?? DEFAULT_FALLBACK_RETRY_COUNT
    if (fallbackRetryAttempt >= maxAttempts) {
      log.info(
        `screencap-loop fallback: gave up re-attempting scrcpy for ${opts.deviceId} after ${maxAttempts} attempt(s) — settling into the degraded state until a fresh session`,
      )
      return
    }
    fallbackRetryAttempt++
    // Passed directly (not wrapped in `void fn()`) so a test's fake scheduler
    // can `await` the real promise `attemptFallbackRecovery` returns — a real
    // `setTimeout` ignores the return value either way.
    fallbackRetryTimer = scheduleFallbackRetry(attemptFallbackRecovery, fallbackRetryDelayMs(fallbackRetryAttempt))
  }

  /**
   * One retry attempt: rebuild scrcpy exactly like the initial attempt did,
   * and on success swap `session.display` in place — never rebuilding the
   * session or touching `entry.frameSubscribers` (`packages/session/src/
   * manager.ts`'s `dispatchFrame` reads `deps.onFrame` fresh per call, so a
   * subscriber attached before the swap keeps receiving frames through it
   * with no re-subscribe). Only the DISPLAY source is swapped — input stays
   * on whatever engine the session opened with (deliberate, minimal scope:
   * §4.3 only asks for the display source to heal; re-wiring the input
   * arbiter/UHID pointer mid-session is unrequested scope this step leaves
   * alone).
   */
  async function attemptFallbackRecovery(): Promise<void> {
    fallbackRetryTimer = null
    if (closed || !deps.makeScrcpy) return
    const attempted = await deps.makeScrcpy(opts.deviceId, transport, videoProfile).catch((err) => {
      log.debug(`screencap-loop fallback: retry ${fallbackRetryAttempt} failed for ${opts.deviceId}: ${String(err)}`)
      return null
    })
    if (closed) {
      // The session closed while this retry was in flight — a display must
      // never be resurrected on a session that is already gone.
      await attempted?.close().catch(() => undefined)
      return
    }
    if (!attempted) {
      armFallbackRetry()
      return
    }
    const oldDisplay = session.display
    const newDisplay = new ScrcpyDisplay(attempted)
    newDisplay.onFrame((chunk, meta) => {
      session.frameSize = { width: meta.width, height: meta.height }
      deps.onFrame?.(chunk, meta)
    })
    await newDisplay.start()
    attempted.onClose((reason) => {
      deps.onDisplayError?.(new Error(`the scrcpy session ended: ${reason}`))
    })
    // Swap first, THEN stop the old display — the new one is already
    // delivering frames through the same `deps.onFrame` dispatcher by the
    // time the screencap loop's polling stops, so there is no gap where
    // neither display is feeding subscribers.
    session.display = newDisplay
    session.displayEngineId = 'scrcpy'
    session.videoConfig = () => newDisplay.configPacket
    session.videoKeyframe = () => newDisplay.keyframePacket
    session.requestKeyframe = () => attempted.control.resetVideo()
    liveScrcpy = attempted
    fallbackRetryAttempt = 0
    await oldDisplay.stop().catch((err) => log.warn(`failed to stop the screencap-loop fallback after recovering scrcpy for ${opts.deviceId}: ${String(err)}`))
    onPhase('ready', 'recovered: scrcpy is live again after the screencap-loop fallback')
    log.info(`screencap-loop fallback: ${opts.deviceId} recovered to scrcpy`)
  }

  if (displayAttemptFailed) armFallbackRetry()

  return session
}
