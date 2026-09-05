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
import { applyRotation, type RotationLock } from './orientation'
import { applyTextInput, type TextInputSetup } from './text-input'
import { resolveVideoProfile, type VideoProfile } from './video-profile'
import { wakeDevice } from './wake'
import { refuseUiServer } from './inspector-factory'

/**
 * Plan 91 §4.1, §4.5 — the arbiter's bounded-queue budget. `daemon.ts`'s
 * `createSessionManager({...})` call threads the real, live farm setting
 * through `SessionManagerDeps` → `CreateSessionDeps` (fixed 2026-08-13 —
 * `docs/plans/96-m61-hotfixes.md` §96.13); these constants remain the
 * fallback for any caller that supplies no accessor at all — a test/fixture
 * `SessionManager`, or the node package's own mini-core, which runs no
 * input arbiter at all (`00-overview.md` §4.1's `node` boundary).
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
   * (a job and a person controlling it, plan 91's whole premise) never
   * interleave one pointer's down/move/up.
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
   * fixture-compatibility reason `SessionManager.restartAt`
   * is optional (`packages/session/src/manager.ts`).
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
   * The host port this session's active scrcpy forward is bound to (plan 223
   * §4.2/§4.3) — null when the display engine is `screencap-loop` (no scrcpy
   * forward exists) or the session predates a successful connect. Read by
   * `SessionManager.forwards()`; nothing else in this package owns a second,
   * independent forward-tracking store.
   */
  forwardPort: number | null
  /** This session's scrcpy `scid`, or null under the same condition as `forwardPort` above. */
  scrcpyScid: string | null
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
   * Starts the inspector if nothing has yet, and resolves once it is ready
   * (or has fallen back). Start-once; every caller joins the same start.
   * Never rejects (plan 208 §3.2). The engine is session-scoped: started
   * here or by `prewarmInspector()` below, whichever runs first, and
   * released only by `close()` — a tab attaching to it (`inspect.attach`)
   * is a viewer, never an owner.
   */
  whenInspectorReady(): Promise<void>
  /**
   * The same start as `whenInspectorReady()`, invoked by the always-on
   * builder `INSPECTOR_PREWARM_DELAY_MS` after the first frame (plan 206
   * §3.9). Identical to `whenInspectorReady` on purpose: there is one
   * engine per session and one way to start it (plan 208 §3.2).
   */
  prewarmInspector(): Promise<void>
  /**
   * Give up on the current inspector engine and drop to `uiautomator-dump`,
   * which shells `uiautomator dump` and has no on-device server to lose.
   *
   * Called when a call fails at the transport level — a closed port, a
   * refused connection — which means the engine is gone rather than busy.
   * Idempotent: already on the bottom rung is a no-op.
   */
  demoteInspector(reason: string): void
  /**
   * Resolves once this session's text-input keyboard has been set up — and
   * STARTS that setup if nothing has yet (plan 125 §3.8, §4.5, §5 step 125.8).
   *
   * ### The contract this replaces, stated plainly
   *
   * Before 125.8, `applyTextInput` ran inside `createSession` on the
   * pre-video chain, so "the session resolved" implied "the IME is set". Plan
   * 125 §3.8 moves that work after the first frame, which means `acquire()`
   * resolving no longer carries that implication — and plan 125 §8's risk row
   * says the guarantee must not simply be dropped ("a job that needs text
   * input awaits the session's `ready`, which still gates on the same work
   * completing"). **This method is where that guarantee now lives.** Every
   * caller that is about to type awaits it first:
   * `packages/session/src/device-executor.ts`'s `type()` and
   * `packages/core/src/server/ws-handlers.ts`'s `input.text`, both
   * immediately before they call `resolveTextRoute` — which is exactly the
   * point at which `agentCapabilities`/`imeCurrent` are read and must be
   * true. A script therefore still cannot start typing before the IME is
   * set; the wait simply moved off the path where nobody was typing.
   *
   * The cost is not new work, only relocated work: the same bootstrap, paid
   * by the first caller who actually needs a keyboard rather than by every
   * viewer who only wanted a picture.
   *
   * Idempotent and start-once, like `whenInspectorReady` above. Never
   * rejects: a failed setup leaves `textInput.agentCapabilities: null` /
   * `imeCurrent: false`, which `resolveTextRoute` already reads as "rung 1
   * unavailable" and falls below.
   *
   * Optional for the same fixture-compatibility reason `requestKeyframe`,
   * `videoProfile` and `rotation` are: dozens of hand-built `DeviceSession`
   * literals across `packages/session`/`packages/core` exist for scenarios
   * with nothing to do with typing. `createSession` (the only production
   * implementation) always sets it, and both real callers reach it through
   * `?.()` so a fixture without one behaves exactly as it did before this
   * plan.
   */
  whenTextInputReady?(): Promise<void>
  // The separate early-release method plan 56 once gave the Inspect tab is
  // gone (plan 208 §3.2): a method that exists and does nothing is the
  // compatibility shim plan 200 §2.1 forbids. `close()` below is the only
  // release — the engine is session-scoped, not tab-scoped, so a tab
  // detaching (`inspect.detach`) releases nothing.
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
   * Text-input routing facts (plan 90 §3.2, §3.3, §4.5), mirroring `clipboard`'s shape above.
   *
   * **Filled in asynchronously since plan 125 §3.8 (step 125.8).** They used to be computed
   * before the session was even returned; they are now written in place when the deferred
   * `applyTextInput` completes (see `whenTextInputReady` above). Until then they read
   * `null`/`false` — the same values an install with no guest agent has always reported, which
   * `resolveTextRoute` already treats as "rung 1 unavailable". Read them FRESH off the session
   * at each call, never captured into a local at session start, or a caller pins the
   * pre-bootstrap answer for the session's whole life.
   *
   * `resolveTextRoute` (`./text-input.ts`)
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
  /**
   * The screen-rotation lock in force on this session (plan 85 §3.7) — the
   * live handle, not a snapshot: `rotation.set(mode)` re-locks a session that
   * is ALREADY RUNNING, which is what `SessionManager.setRotation` (and, above
   * it, `PATCH /api/devices/:id`) calls when an operator changes
   * `DeviceSettings.prep.rotation` on a device whose screen is on a wall tile
   * right now. Before this existed the setting was apply-once at session
   * creation, so changing it mid-stream did nothing whatsoever and said
   * nothing about it.
   *
   * `rotation.outcome.applied` is read back from the device, never inferred
   * from a write's exit code, so "the lock is in force" and "we asked for the
   * lock" are distinguishable — see `RotationOutcome`.
   *
   * Optional for the same fixture-compatibility reason `requestKeyframe` and
   * `videoProfile` are: many tests across `packages/session`/`packages/core`
   * build an ad-hoc object literal shaped like `DeviceSession` for scenarios
   * that have nothing to do with rotation. `createSession` (the only
   * production implementation) always sets it.
   */
  rotation?: RotationLock
  /**
   * A device-side clipboard change (plan 209 §3.2 D10, §4.9): scrcpy's
   * `CLIPBOARD` device message, forwarded from `ScrcpySession.onDeviceMessage`.
   * `() => () => {}` on a session with no scrcpy control channel. Returns an
   * unsubscribe.
   */
  onClipboardChanged(cb: (text: string) => void): () => void
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
   * from `daemon.ts`'s own live settings accessors (fixed 2026-08-13 —
   * `docs/plans/96-m61-hotfixes.md` §96.13).
   */
  arbiterQueueWaitMs?: () => number
  arbiterMaxQueueDepth?: () => number
  /**
   * Plan 100 §4.3, step 100.6 — `FarmSettings.display.fallbackRetryCount`,
   * read fresh on every retry decision (the same freshness discipline
   * `arbiterQueueWaitMs` etc. already use). Undefined falls back
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
  preferredInputMode?: 'uhid' | 'sdk'
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
  /**
   * Plan 100 §3.2, §4.2, §5 step 100.4 — set only by `SessionManager`'s
   * fast-path `control` build (a second, concurrent scrcpy session beside
   * an already-open `wall` entry for the SAME device). The open `wall`
   * entry is live proof the device is already awake, rotated, tagged, and
   * has its text-input keyboard set — so `wakeDevice`/`applyRotation`/
   * `applyTextInput`/`applyFarmTag` are skipped entirely (not merely
   * called with a no-op argument), and their revert thunks become no-ops
   * too: nothing was applied by THIS session, so nothing is this session's
   * to revert on `close()` — the entry that actually applied these
   * device-scoped settings (the still-open `wall` entry) remains the one
   * that reverts them, when IT closes. `onPhase('waking')` is also skipped
   * (§4.3/§4.5, §5 step 100.5's "no wake-phase breadcrumb"), so the fast
   * path's phase sequence is `connecting → starting-video → waiting-frame
   * → ready`, one step shorter than the ordinary four-step sequence.
   */
  skipDevicePrep?: boolean
  /**
   * Plan 125 §3.7, §4.5, §5 step 125.7 — "one wake per session start, and the
   * readiness manager is the authority".
   *
   * **The defect this closes.** On a cold `stream.start` the wake block ran
   * TWICE, serially: `ws-handlers.ts`'s `readiness.hold(deviceId, 'viewer')`
   * → `ensureAwake` → `wakeDevice`, and then `sessions.acquire` →
   * `createSession` → `wakeDevice` again, because this function never
   * consulted the readiness manager and `skipDevicePrep` above only covers
   * the narrow "a `control` build beside an already-open `wall` entry" case.
   * Plan 96 §22 measured `svc power stayon` alone at **1422 ms** on the
   * owner's hardware, so the duplicate cost ≈3.2 s — burned before
   * `starting-video` was even entered (plan 125 §0.7).
   *
   * **What sets it.** `SessionManagerDeps.deviceIsAwake` (`./manager.ts`),
   * read fresh at build time and wired in `daemon.ts` to the readiness
   * manager's own `actual(deviceId) !== 'asleep'`. That is the authority
   * §3.7 names: readiness is the thing that woke the device, so it is the
   * thing that knows the wake already happened. A device readiness reports
   * `awake` or `hot` gets zero wakes here; anything else gets exactly one.
   *
   * **Why this is not `skipDevicePrep` with a different name.** It skips the
   * wake ONLY — rotation, text input and the farm tag are unaffected,
   * because none of them can be inferred from "the screen is on". Nor does
   * it imply another entry owns the device's prep.
   *
   * **The revert half is what makes it safe** (`close()` below, and the
   * `requireScrcpy` bail-out): a session that did not claim `stayon` must
   * not release it either. Releasing a hold this session never took would
   * hand the screen back to the device's own timeout out from under the
   * readiness manager that IS holding it — and the owner's phones live in a
   * sealed box where a dark, unreachable phone costs hardware disassembly
   * (§0.2). The skip therefore REMOVES two adb writes per session (the wake
   * and its matching release); it adds none, and it can only ever leave a
   * phone more awake than before, never less.
   *
   * The fallback when this is wrong is unchanged and one layer up:
   * `readiness.ensureAwake`'s own early-out (`packages/core/src/device/
   * readiness.ts`) still re-wakes any device whose `actual` reads `asleep`.
   */
  skipWake?: boolean
  /**
   * Plan 206 §3.6, §4.4 — set by the always-on builder on EVERY base build
   * (not only the fast path any more), and alongside `skipDevicePrep` for a
   * fast-path `control` build. A build with this set must produce a REAL
   * scrcpy session or fail outright: silently falling back to
   * screencap-loop + adb-input here would be exactly the silent downgrade
   * this plan forbids (a session shown under a wall/control label that is
   * really the PNG fallback). `makeScrcpy` returning null/rejecting throws
   * `SessionError('E_SCRCPY_UNAVAILABLE', ...)` instead of degrading —
   * `packages/scrcpy/src/session.ts`'s own bounded `connectWithRetry` is
   * what already turns a platform's rejection (a non-zero server exit, or a
   * handshake that never completes) into that rejected promise, so this is
   * H2's "detect the platform's own rejection" signal, not a new timeout
   * invented here.
   *
   * Ignored (never throws) when `opts.display === 'screencap-loop'` is the
   * device's OWN deliberate configuration — that device was never going to
   * run scrcpy regardless of the wall entry, and treating its ordinary
   * fallback as "control unavailable" would be a false degrade for an
   * operator who chose PNG-only on purpose. That early-out belongs here,
   * not in the manager, because only this function knows which branch
   * `scrcpy` ended up null from.
   */
  requireScrcpy?: boolean
}



/**
 * Is this the engine being gone, rather than the engine saying no?
 *
 * Matched on the message because these arrive from `fetch` and the socket
 * layer with no code of their own. Deliberately narrow: a timeout or a
 * "could not get idle state" is a working engine refusing, and must never
 * cost a device its fast inspector.
 */
function isEngineGone(message: string): boolean {
  return (
    message.includes('Unable to connect') ||
    message.includes('socket connection was closed') ||
    message.includes('ECONNREFUSED') ||
    message.includes('the instrumentation ended')
  )
}

export async function createSession(opts: CreateSessionOpts, deps: CreateSessionDeps): Promise<DeviceSession> {
  const { client, log } = deps
  const onPhase = deps.onPhase ?? (() => {})
  const quality: Quality = opts.quality ?? 'control'
  // plan 92 §3.5, §4.2 (preset-only since plan 212 §4.5) — the resolved
  // numbers this session's encoder starts with. When the caller supplies
  // none (a test/fixture, or the node package's mini-core, which carries no
  // farm settings store), fall back to the schema defaults for `quality`
  // alone — `defaultFarmSettings().capture`'s defaults ARE
  // `CONTROL_PRESETS.sharp`/`WALL_PRESETS.balanced`, so this is
  // byte-identical to the pre-plan-92 `QUALITY_PROFILES` constants.
  const videoProfile: VideoProfile = opts.videoProfile ?? resolveVideoProfile(defaultFarmSettings().capture, null, quality)

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
   * The inspector is session-scoped (plan 208 §3.2): started once, by
   * whichever of `prewarmInspector()` (the always-on builder, plan 206
   * §3.9) or `whenInspectorReady()` (a job, or an Inspect tab's
   * `inspect.attach`) runs first, and torn down only by this session's
   * `close()` below — never released early by a tab detaching.
   *
   * Two measurements on a real moto g06 power (Android 15) are why the
   * start is not moved earlier than the first frame:
   *   - awaiting it up front delayed the first video frame by ~50 s, because
   *     ui-server's watchdog retries twice before giving up;
   *   - starting it in the background instead was worse in a subtler way. adb
   *     access is serialised per device, so the watchdog's installs starved the
   *     screencap loop: 1 frame in 20 s, versus 11 once it gave up.
   *
   * `prewarmInspector()` runs `INSPECTOR_PREWARM_DELAY_MS` after the first
   * frame (plan 206's `onFirstFrame`), which respects that measurement
   * without leaving the engine lazy for the rest of the session.
   */
  let inspectorHandle: Awaited<ReturnType<NonNullable<CreateSessionDeps['makeInspector']>>> | null = null
  let inspectorPromise: Promise<void> | null = null
  /**
   * The engine to ask for on the NEXT start, once the configured one has
   * proved it cannot stay up on this device.
   *
   * `ui-server` runs a JSON-RPC server inside an `am instrument` process on
   * the phone, and on some builds that process crashes seconds after
   * reporting ready — the owner's Android 15 phone does it every session.
   * Its watchdog already gives up after three cycles, and its own doc comment
   * says "the session manager runs the fallback"; nothing ever did, so the
   * session kept a dead engine and every later call hit a closed port
   * (2026-09-04). `uiautomator-dump` is the rung below: slower, and with no
   * server to crash.
   */
  let inspectorFallback: string | null = null
  /**
   * Every inspector call, watched for the engine dying underneath it.
   *
   * The demote used to be wired in ONE place — the WS handler for
   * `inspect.*` — so a click in Device Control recovered and a running SCRIPT
   * did not: a job calling `dump()` got the raw "socket connection was closed
   * unexpectedly" and failed the run (owner, 2026-09-05). Guarding the engine
   * itself covers every caller there will ever be, and retries the call once
   * on the replacement so the caller never sees the swap.
   *
   * Only transport-level failures demote. A timeout, a bad selector, or a
   * screen that will not settle are the engine WORKING and saying no.
   */
  function guardEngine(engine: Inspector): Inspector {
    const run = async <T>(name: string, call: (e: Inspector) => Promise<T>): Promise<T> => {
      try {
        return await call(engine)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!isEngineGone(message)) throw err
        session.demoteInspector(`${name}: ${message}`)
        await inspectorPromise
        const replacement = session.inspector
        if (!replacement || replacement === engine) throw err
        return await call(replacement)
      }
    }
    return {
      get id() {
        return engine.id
      },
      dump: () => run('dump', (e) => e.dump()),
      find: (sel) => run('find', (e) => e.find(sel)),
      screenshot: () => run('screenshot', (e) => e.screenshot()),
      ...(engine.findDetailed ? { findDetailed: (sel: Parameters<NonNullable<Inspector['findDetailed']>>[0]) => run('findDetailed', (e) => e.findDetailed!(sel)) } : {}),
      // `watch` and `lastDump` pass straight through: one owns a long-lived
      // subscription that a retry cannot meaningfully replay, and the other
      // is a synchronous cache read that cannot fail at the transport.
      ...(engine.watch ? { watch: (onChange: () => void) => engine.watch!(onChange) } : {}),
      ...(engine.lastDump ? { lastDump: () => engine.lastDump!() } : {}),
    } as Inspector
  }

  const startInspector = (): Promise<void> => {
    if (!deps.makeInspector) return Promise.resolve()
    inspectorPromise ??= (async () => {
      const t0 = Date.now()
      try {
        const h = await deps.makeInspector!(opts.deviceId, transport, inspectorFallback ?? opts.inspection ?? null)
        inspectorHandle = h
        session.inspector = guardEngine(h.inspector)
        session.inspectorEngineId = h.engineId
        session.inspectorPollIntervalMs = h.pollIntervalMs
        log.info(`inspector ready: ${h.engineId} on ${opts.deviceId} in ${Date.now() - t0} ms`)
      } catch (err) {
        /**
         * A failed start used to leave `inspectorEngineId` at `'starting'`
         * and `inspectorPromise` set. Both were wrong, and together they
         * produced the worst possible answer: every caller was told "the
         * inspector is still starting; retry in a moment" forever, while
         * `??=` guaranteed no start would ever be attempted again — there
         * was nothing to wait for, and waiting was the only thing offered
         * (owner, 2026-09-04, on the first farm where the ui-tree engine was
         * actually reachable).
         *
         * So: say `'failed'`, which the API surfaces as `liveInspection`, and
         * drop the memo so the NEXT caller genuinely retries. A retry is
         * cheap (the engine ladder re-probes) and the alternative is a
         * session that can never inspect again without being torn down.
         */
        session.inspectorEngineId = 'failed'
        inspectorPromise = null
        log.warn(`inspector could not start on ${opts.deviceId} after ${Date.now() - t0} ms: ${String(err)}`)
      }
    })()
    return inspectorPromise
  }

  // Plan 100 §4.2, §5 step 100.4: the fast-path control build skips this
  // whole block (and its own phase breadcrumb) — the still-open wall entry
  // for this device is live proof it already ran, successfully, moments ago.
  const skipDevicePrep = opts.skipDevicePrep ?? false
  if (!skipDevicePrep) onPhase('waking')
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
  /**
   * Plan 125 §3.7, §4.5, §5 step 125.7 — see `CreateSessionOpts.skipWake` for
   * the whole argument. Two independent reasons to skip, kept as two booleans
   * rather than one because they mean different things and revert differently:
   * `skipDevicePrep` says "another open entry owns this device's prep",
   * `skipWake` says "the readiness manager already has this screen on".
   *
   * `wakeDevice` itself is not free even when it changes nothing: it is a
   * `settings get` pair, `svc power stayon` (1422 ms measured — plan 96 §22),
   * a `KEYCODE_WAKEUP`, and a `dumpsys window` keyguard probe. Skipping it is
   * the single largest saving on the cold cast path.
   */
  const skipWake = skipDevicePrep || (opts.skipWake ?? false)
  if (!skipWake) await wakeDevice(transport, { keepAwake, log })

  /**
   * Rotation lock (Plan 85 §3.7, §4.1, step 85.8): the identical shape to
   * `wakeDevice` right above — a device-scoped preference applied here and
   * reverted in `close()` below. `applyRotation` reads the device's current
   * `accelerometer_rotation` before touching anything, so the revert it
   * returns can put it back exactly rather than to a hardcoded value.
   * `'device'` (the default) touches nothing and the revert is a no-op.
   *
   * Rotation is the ONE member of the fast path's skip list (§4.2:
   * "skips wake/rotate/text-input/farm-tag") that this call does NOT skip,
   * and the asymmetry is deliberate. Waking a device that is already awake is
   * genuinely redundant — the wall entry holding the screen on is proof of the
   * fact it would re-derive. A rotation lock is not the same kind of
   * redundant: the wall entry may have been opened BEFORE the operator changed
   * the setting, or with a different value, or its own write may have been
   * declined by the device. So a fast-path build re-asserts the lock
   * (`owned: false`) — it writes, but it captures nothing and reverts nothing,
   * leaving the still-open wall entry as the sole owner of the device's true
   * pre-farm state. Two extra shell calls; no way for them to be wrong.
   */
  const rotation: RotationMode = opts.rotation ?? 'device'
  const rotationLock = await applyRotation(transport, { rotation, log, owned: !skipDevicePrep })
  const revertRotation = () => rotationLock.revert()

  /**
   * Text-input keyboard (plan 90 §3.2, §3.3, §4.5, §5 step 90.5) — **no longer on the critical
   * line** (plan 125 §3.8, §4.5, §5 step 125.8).
   *
   * `applyTextInput` reads the device's current `secure default_input_method`, switches to the
   * agent's IME, and confirms the switch by reading the setting back; `agentCapabilities`/
   * `imeCurrent` are what `resolveTextRoute` (`./text-input.ts`) consults on every
   * `input.text`/`type()` call, so the ladder never needs a live round trip per keystroke.
   *
   * ### Why it moved (plan 125 §0.7's cost table, §3.8)
   *
   * It ran on EVERY ordinary session build, because `DeviceSettings.prep.textInput` defaults to
   * `'auto'`, and it is not a couple of shell calls — it triggers a full guest-agent app
   * bootstrap: 3 `appops` calls, an `am start` with a ~500 ms measured handover
   * (`packages/drivers/src/network/guest-agent/launcher.ts`), an 8 × 500 ms `hello()` ladder
   * (`client.ts`), up to `PAIRING_ROUNDS = 3` full repeats (`packages/core/src/api/
   * guest-agent.ts`), then 4 more `ime`/`settings` calls. **And text input is not needed to
   * paint a frame.** Every millisecond of it sat between the operator's click and the picture.
   *
   * ### What it is now
   *
   * A lazily-started, start-once promise, kicked off from TWO places and never from a third:
   *
   * 1. **The first frame** (`session.display.onFrame` below, right after `onPhase('ready')`) —
   *    §3.8's "runs after the first frame". This is the ordinary path: the device is visible in
   *    a fraction of the time, and the IME arrives a moment later, which is when a human could
   *    first type anyway.
   * 2. **`whenTextInputReady()`** — on demand, for a caller that genuinely needs the keyboard.
   *    That second trigger is not a nicety: a session whose display never produces a frame (a
   *    dead encoder, a screencap loop that cannot read the panel) must not leave a script
   *    blocked forever on work that was never started.
   *
   * Its failure stays exactly as non-fatal as it already was (§3.8's own requirement).
   * `applyTextInput` already swallows every device-side failure internally — each `exec` there
   * carries its own `.catch` — and reports the outcome honestly as `agentCapabilities: null` /
   * `imeCurrent: false`, which `resolveTextRoute` reads as "rung 1 unavailable" and falls below.
   * The `.catch` added below is belt-and-braces for the one thing deferral changes: this promise
   * is no longer awaited by `createSession` itself, so an unhandled rejection would surface as a
   * process-level warning rather than at a call site — and `whenTextInputReady()` must never
   * reject on a caller who only wanted to know whether the keyboard was ready.
   *
   * `skipDevicePrep` short-circuits it to the no-op setup exactly as before (plan 100 §4.2): the
   * still-open wall entry already owns this device's keyboard, and this entry reverts nothing.
   */
  const textInputMode: TextInputMode = opts.textInput ?? 'auto'
  const NO_TEXT_INPUT: TextInputSetup = { revert: async () => {}, agentCapabilities: null, imeCurrent: false }
  let textInputSetup: TextInputSetup = NO_TEXT_INPUT
  let textInputPromise: Promise<void> | null = null
  const startTextInput = (): Promise<void> => {
    if (skipDevicePrep) return Promise.resolve()
    textInputPromise ??= applyTextInput(transport, {
      mode: textInputMode,
      ...(deps.withGuestAgentClient ? { withGuestAgentClient: deps.withGuestAgentClient } : {}),
      log,
    })
      .then((setup) => {
        textInputSetup = setup
        // Published onto the live session object, not returned: both readers
        // (`ws-handlers.ts`'s `input.text` and `device-executor.ts`'s `type()`)
        // read `session.textInput.*` fresh at call time, so mutating in place
        // is what makes the deferred answer reach them at all.
        session.textInput.agentCapabilities = setup.agentCapabilities
        session.textInput.imeCurrent = setup.imeCurrent
      })
      .catch((err) => {
        // Identical swallow to the pre-125.8 call site's own `.catch` — a
        // keyboard that could not be set up must never take the video with it.
        log.warn(`text input could not be set up: ${String(err)} — typing falls back to the remaining rungs`)
      })
    return textInputPromise
  }
  /**
   * Undo whatever `startTextInput` managed to apply — awaiting a setup still
   * in flight FIRST.
   *
   * That await is the load-bearing half. Deferring the setup opens a window
   * that did not exist before 125.8: `close()` can now land while the IME
   * switch is mid-write, and reverting the no-op `NO_TEXT_INPUT` in that
   * window would leave the device's default input method pinned to the agent's
   * keyboard **permanently** — a device-scoped setting outliving the session
   * that made it, on a phone nobody can reach (§0.2). Waiting out an in-flight
   * bootstrap costs a close some time; it can never cost a phone its keyboard.
   *
   * `textInputPromise` cannot reject (see the `.catch` above), so this needs no
   * guard of its own. `revert()` itself is idempotent by contract, so calling
   * this twice is safe — the same rule rotation and the farm tag already keep.
   */
  const revertTextInput = async (): Promise<void> => {
    if (textInputPromise) await textInputPromise
    await textInputSetup.revert()
  }

  /**
   * Farm-traffic marker (spec §9.4/§17, plan 87 §4.12, §5 step 87.13): the
   * same shape as `applyRotation` right above — device-scoped, applied here,
   * reverted in `close()`. Defaults to `true` ("on by default" is the spec's
   * own wording); `applyFarmTag` is what actually enforces "never claim a
   * device is tagged when it is not" when the underlying `setprop` fails.
   */
  const tagTraffic = opts.tagTraffic ?? true
  const revertFarmTag = skipDevicePrep ? async () => {} : await applyFarmTag(transport, { tagTraffic, log })

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
  let scrcpyFailureReason: string | null = null
  if (opts.display !== 'screencap-loop' && deps.makeScrcpy) {
    scrcpy = await deps.makeScrcpy(opts.deviceId, transport, videoProfile).catch((err) => {
      displayAttemptFailed = true
      scrcpyFailureReason = err instanceof Error ? err.message : String(err)
      log.info(`scrcpy cannot be used (${scrcpyFailureReason}); this build ${opts.requireScrcpy ? 'fails' : 'falls back to screencap-loop + adb-input'}`)
      return null
    })
  }

  // Plan 100 §3.2, §3.7 item 2, §4.4, §5 step 100.4: a fast-path `control`
  // build must produce a real second scrcpy session or fail outright — see
  // `CreateSessionOpts.requireScrcpy`'s own doc comment for why silently
  // falling to screencap-loop here would be exactly the silent downgrade
  // §3.7 forbids. Excluded when the device's OWN configuration is
  // `screencap-loop` (never even attempted scrcpy above): that device was
  // never going to run scrcpy regardless of the wall entry, and reporting
  // "control unavailable" for it would be a false degrade.
  if (opts.requireScrcpy && opts.display !== 'screencap-loop' && !scrcpy) {
    // Defensive, not load-bearing in production (the one real caller,
    // `SessionManager`'s fast path, always pairs `requireScrcpy` with
    // `skipDevicePrep`, so these three are already no-ops) — but a caller
    // that ever set `requireScrcpy` WITHOUT `skipDevicePrep` must not leak
    // an applied rotation/IME/farm-tag/stayon on a session that is about to
    // vanish with no `close()` ever called on it.
    // `!skipWake` (plan 125 §3.7, step 125.7), not merely `keepAwake !== 'off'`:
    // a build that skipped the wake never claimed `stayon`, so releasing it
    // here would hand the screen back to the device's own timeout out from
    // under whoever IS holding it (the readiness manager, or the open wall
    // entry). Same rule, same reason, as `close()`'s own release below.
    if (keepAwake !== 'off' && !skipWake) await transport.exec('svc power stayon false', { profile: 'probe' }).catch(() => undefined)
    await revertRotation()
    await revertTextInput()
    await revertFarmTag()
    await transport.disconnect().catch(() => undefined)
    throw new SessionError('E_SCRCPY_UNAVAILABLE', scrcpyFailureReason ?? 'scrcpy-server could not be started on this device')
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
  /** Plan 209 §4.9: kept so `close()` can `destroy()` the virtual keyboard/pointer before the scrcpy session closes. */
  let uhidEngine: ScrcpyUhidInput | null = null
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
    const engine =
      selection.engine === 'scrcpy-uhid'
        ? (uhidEngine = new ScrcpyUhidInput(inputDeps))
        : new ScrcpySdkInput(inputDeps)
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
    forwardPort: scrcpy ? scrcpy.port : null,
    scrcpyScid: scrcpy ? scrcpy.scid : null,
    ...(scrcpy ? { requestKeyframe: () => scrcpy!.control.resetVideo() } : {}),
    inspector: null,
    inspectorEngineId: 'starting',
    inspectorPollIntervalMs: 500,
    whenInspectorReady: startInspector,
    // Plan 208 §3.2: identical to `whenInspectorReady` — one engine, one way
    // to start it. The always-on builder calls this `INSPECTOR_PREWARM_DELAY_MS`
    // after the first frame (plan 206 §3.9); a job or `inspect.attach` that
    // reaches `whenInspectorReady()` first just joins the same start.
    prewarmInspector: startInspector,
    demoteInspector: (reason: string) => {
      if (inspectorFallback === 'uiautomator-dump') return
      log.warn(`inspector ${session.inspectorEngineId} is not answering on ${opts.deviceId} (${reason}) — falling back to uiautomator-dump, which has no server to lose`)
      inspectorFallback = 'uiautomator-dump'
      // Device-wide, not just this session: the next window must not start
      // the same doomed instrumentation over again.
      if (session.inspectorEngineId === 'ui-server') refuseUiServer(opts.deviceId)
      const dying = inspectorHandle
      inspectorHandle = null
      inspectorPromise = null
      session.inspector = null
      session.inspectorEngineId = 'failed'
      void dying?.release?.().catch(() => undefined)
      /**
       * Rebuild NOW, not on the next call.
       *
       * Waiting for a caller means the press that demoted the engine is
       * followed by one more failure ("still starting, retry") before the
       * replacement exists — and the whole point of the fallback is that the
       * feature is there when someone reaches for it. `uiautomator-dump`
       * costs a shell round-trip to construct, not a server start, so this is
       * cheap enough to do eagerly.
       */
      void startInspector()
    },
    whenTextInputReady: startTextInput,
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
    // Plan 85 §3.7 — the LIVE handle (see `DeviceSession.rotation`), so a
    // settings change reaches a session that is already streaming instead of
    // waiting for a cold start that may never come on a wall tile.
    rotation: rotationLock,
    onClipboardChanged: (cb) =>
      scrcpy
        ? scrcpy.onDeviceMessage((m) => {
            if (m.type === 'clipboard') cb(m.text)
          })
        : () => {},
    async close() {
      // Plan 209 §4.9: UHID_DESTROY the virtual keyboard (if it was ever
      // created) before the control socket goes away with the rest of the
      // session — best-effort, matching the rest of this function.
      await uhidEngine?.destroy().catch(() => undefined)
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
      // Hand the screen back to the device's own timeout. Skipped whenever
      // this session did not claim `stayon` in the first place — releasing a
      // hold we never took would hand the screen back out from under whoever
      // IS holding it and relying on it staying awake.
      //
      // `skipWake` covers BOTH cases (plan 125 §3.7, step 125.7): a
      // fast-path control entry beside a still-open wall entry (plan 100
      // §4.2, the original reason this condition existed), and — new — a
      // build the readiness manager told us was already awake. The second
      // case also closes a pre-existing leak: before step 125.7 a session on
      // a `desired: 'awake'` device wrote `stayon false` here on close,
      // while `readiness.keepAwakeApplied` still believed it held the device
      // awake, so `ensureAwake`'s early-out declined to put it back. A phone
      // in a sealed box then went dark with nothing left to notice (§0.2).
      if (keepAwake !== 'off' && !skipWake)
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
      //
      // `revertTextInput()` rather than `textInputSetup.revert()` since plan
      // 125 step 125.8 moved the setup off the critical line: it awaits a
      // bootstrap still in flight before reverting, so a close racing the
      // deferred setup cannot leave the agent's IME pinned as the device's
      // default. See `revertTextInput`'s own comment.
      await revertTextInput()
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
      // Plan 125 §3.8, §4.5, §5 step 125.8 — the guest-agent bootstrap starts
      // HERE, after the first frame, instead of blocking it. Fire-and-forget:
      // `startTextInput` swallows its own failure (see its `.catch`), and this
      // callback is on the frame dispatch path, which must never await device
      // work of any kind.
      void startTextInput()
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
    session.forwardPort = attempted.port
    session.scrcpyScid = attempted.scid
    liveScrcpy = attempted
    fallbackRetryAttempt = 0
    await oldDisplay.stop().catch((err) => log.warn(`failed to stop the screencap-loop fallback after recovering scrcpy for ${opts.deviceId}: ${String(err)}`))
    onPhase('ready', 'recovered: scrcpy is live again after the screencap-loop fallback')
    log.info(`screencap-loop fallback: ${opts.deviceId} recovered to scrcpy`)
  }

  if (displayAttemptFailed) armFallbackRetry()

  return session
}
