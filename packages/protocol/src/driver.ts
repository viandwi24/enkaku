/**
 * Interface 4 lapisan driver (spec §7) — lokasi kanonik shared types.
 * Engine implementations live in packages/drivers (from Plan 03 onward).
 */
import type { FindOutcome } from './find-outcome'
import type { Selector, UiNode } from './ui-node'

/**
 * `stdout`/`stderr` separated by the device, and `exitCode` reported
 * honestly — `null` when the transport could not determine one (plan 53
 * §3.4), never a fabricated `0`.
 */
export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface Point {
  x: number
  y: number
}

export interface FrameMeta {
  width: number
  height: number
  codec: 'png' | 'h264'
  seq: number
  capturedAt: number
  /**
   * Whether this chunk can start a decode. Left undefined it means "PNG, so
   * yes"; H.264 sources must set it, because a decoder handed a delta frame
   * right after `configure()` fails outright instead of catching up.
   */
  keyframe?: boolean
}

/**
 * Optional per-call execution budget, threaded through to whatever
 * serialises access underneath (plan 22.1 §4.6) — e.g. @enkaku/adb's
 * per-device queue. Every field is transport-specific: an adb transport
 * looks `profile` up in `ADB_TIMEOUTS`; a transport with no such concept is
 * free to ignore fields it does not support.
 */
export interface TransportExecOptions {
  /** A named timeout profile (e.g. 'probe', 'input', 'appLifecycle'). */
  profile?: string
  /** Absolute execution budget in ms. */
  timeoutMs?: number
  /** How long the call may wait for its turn in a per-device queue. */
  queueTimeoutMs?: number
  /** Hard cap on returned bytes. */
  maxOutputBytes?: number
  signal?: AbortSignal
}

export interface Transport {
  id: string
  /** The adb transport address — it can change (USB ↔ ip:port). */
  serial: string
  /** Identitas device stabil (spec §7.5). */
  stableId: string
  /**
   * Session-scoped, NOT farm-scoped (plan 88 §3.7): make this transport
   * usable for the session about to start, without owning whether the
   * device stays reachable afterwards. `AdbTcpTransport` implements this as
   * ensure-connected — a no-op when adb already has it, a dial only when it
   * does not (`packages/drivers/src/transport/adb-transport.ts`).
   */
  connect(): Promise<void>
  /**
   * Session-scoped, NOT farm-scoped (plan 88 §3.7, fixes F12/H6): release
   * whatever THIS session opened, and nothing more. It must never drop the
   * device's adb transport for the whole farm — that used to be exactly
   * what `AdbTcpTransport.disconnect()` did (`host:disconnect`), so closing
   * one wall tile silently kicked a wireless/OTG phone off adb entirely.
   * Transport lifetime belongs to the registry and to an operator's
   * explicit action, never to a session closing.
   */
  disconnect(): Promise<void>
  exec(cmd: string, opts?: TransportExecOptions): Promise<ShellResult>
  /** Binary stdout (screencap and friends) — an M2 extension to spec §7. */
  execOut(cmd: string, opts?: TransportExecOptions): Promise<Uint8Array>
}

export interface DisplaySource {
  id: string
  start(): Promise<void>
  onFrame(cb: (chunk: Uint8Array, meta: FrameMeta) => void): void
  stop(): Promise<void>
}

/**
 * One point of a sampled gesture path (plan 40 §4.1) — the output of
 * `@enkaku/drivers`' `buildGesturePath`, a pure function that knows nothing
 * about scrcpy or adb. Defined here rather than in `@enkaku/drivers` because
 * `InputSink` (below) needs to reference it and the dependency only runs one
 * way: `drivers` depends on `protocol`, never the reverse.
 */
export interface GestureSample {
  x: number
  y: number
  /** Milliseconds since the gesture started (the first sample is 0). */
  atMs: number
}

export interface InputSink {
  id: string
  mode: 'sdk' | 'uhid'
  /**
   * `opts.holdMs` (spec §9.3, §17): the down→up hold duration, sampled from a
   * `[min, max]` range rather than fixed — this is test realism (a real
   * finger never holds a tap for exactly the same duration twice, and some
   * apps branch on it), explicitly not evasion. `opts.rng` makes that
   * sampling injectable so tests are deterministic; it defaults to
   * `Math.random`. Optional to supply: omitting `opts` (or `holdMs` within
   * it) falls back to each engine's own default range. Not every engine can
   * honour `holdMs` — see `AdbInput.tap` for the one that cannot and why.
   */
  tap(p: Point, opts?: { holdMs?: [number, number]; rng?: () => number }): Promise<void>
  swipe(from: Point, to: Point, ms: number): Promise<void>
  key(code: number): Promise<void>
  text(s: string): Promise<void>
  /**
   * Play a sampled gesture path (plan 40 §4.2) — a curved, eased swipe with a
   * real release velocity. Optional: an engine that cannot honour a curved
   * path (`AdbInput` — `input swipe` accepts only two points) leaves this
   * undefined rather than pretending to curve a straight line, so a caller
   * can tell "unsupported" from "ran and did nothing" by simple absence.
   */
  gesture?(samples: GestureSample[]): Promise<void>
  /**
   * Type with a per-character delay (plan 40 §4.2), so autocomplete,
   * debounced validation, and per-keystroke listeners actually run. Optional
   * for the same reason as `gesture`.
   */
  typeText?(text: string, opts: { perCharMs: [number, number]; rng?: () => number }): Promise<void>
}

/** Engine inspeksi UI (spec §7): `uiautomator-dump` (M4), `ui-server` (M4.5). */
export interface Inspector {
  id: string
  dump(): Promise<UiNode>
  find(sel: Selector): Promise<UiNode | null>
  screenshot(): Promise<Uint8Array>
  /**
   * `find`, but honest about WHY nothing usable came back (plan 74 §3.4,
   * §4.3) — not-found / rejected-oversized / ambiguous, instead of a bare
   * `null`. Optional, like `InspectorElementActions` above: an engine that
   * cannot tell the difference (or cannot afford to, for a hot polling path)
   * simply does not implement it, and `device-executor.ts` falls back to
   * `find()`'s plain not-found/ok distinction — the union is still exhaustive
   * at every consumer, just less informative for that engine.
   */
  findDetailed?(sel: Selector): Promise<FindOutcome>
}
