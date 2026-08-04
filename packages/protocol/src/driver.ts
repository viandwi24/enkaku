/**
 * Interface 4 lapisan driver (spec §7) — lokasi kanonik shared types.
 * Engine implementations live in packages/drivers (from Plan 03 onward).
 */
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
  connect(): Promise<void>
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
  mode: 'sdk' | 'uhid' | 'aoa'
  tap(p: Point): Promise<void>
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
}
