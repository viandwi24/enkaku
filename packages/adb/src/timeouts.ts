import { AdbError } from './errors'

/** Nothing may exceed this, whatever a caller asks for (plan 22.1 §3.4). */
export const MAX_EXEC_TIMEOUT_MS = 120_000

export const DEFAULT_QUEUE_TIMEOUT_MS = 30_000
export const DEFAULT_CONNECT_TIMEOUT_MS = 2_000
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3_000
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
/** Per-device queue depth cap (plan 22.1 §4.5). */
export const DEFAULT_MAX_QUEUE_DEPTH = 32

/**
 * How long after a `host:track-devices` RECONNECT the tracker refuses to
 * report a device as removed.
 *
 * A dropped tracker usually means the adb server died, and `DeviceTracker`'s
 * own loop then calls `ensureServer()`, which may `start-server` a brand new
 * one. A fresh adb server begins with an EMPTY device list and re-enumerates
 * USB over the seconds that follow. The first snapshot after such a reconnect
 * is therefore a baseline, not the truth — and diffing the old snapshot
 * against it emits `remove` for EVERY device on the farm at once.
 *
 * Downstream that is indistinguishable from 80 phones being unplugged
 * simultaneously: sessions torn down, jobs failed, rows marked offline. It is
 * the cascade behind "semuanya reconnecting … sampai akhirnya disconnect"
 * (73-phone farm, 2026-09-17/18), and the reason an operator had to replug
 * USB by hand — the farm had thrown away state adb was about to hand back.
 *
 * Thirty seconds is sized against USB re-enumeration of a large farm, which
 * comfortably exceeds `DEVICE_OFFLINE_GRACE_SEC` (20 s) and so could not be
 * absorbed by that grace alone. Nothing is lost by waiting: `add`/`change`
 * still flow during the window (a device coming back is good news and is
 * reported immediately), and a device that really did leave is caught by the
 * reconciler's own `host:devices-l` sweep, which is exactly the safety net it
 * exists to be.
 */
export const DEFAULT_TRACKER_REENUMERATION_GRACE_MS = 30_000

/**
 * The streaming lane's three clocks (plan 24 §3.3) — deliberately separate
 * from `ADB_TIMEOUTS`/`MAX_EXEC_TIMEOUT_MS` above: a stream is expected to
 * stay open for minutes, which a one-shot `exec()` must never be allowed to
 * do, so the two budgets do not share a ceiling.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000
export const DEFAULT_STREAM_ABSOLUTE_TIMEOUT_MS = 600_000
export const DEFAULT_STREAM_MAX_BYTES = 5 * 1024 * 1024
/** The lane's own budget (plan 24 §3.2) — never a slice of the exec semaphore above. */
export const DEFAULT_MAX_STREAMS_PER_DEVICE = 1
export const DEFAULT_MAX_STREAMS = 4

/**
 * Per-call-site execution budgets (plan 22.1 §3.3). Callers name a profile;
 * the string of the command is never inspected to guess one.
 */
export const ADB_TIMEOUTS = {
  /** getprop, wm size, settings get — instant or broken. */
  probe: 5_000,
  /** input tap/keyevent — must not lag behind manual control. */
  input: 5_000,
  /** dumpsys battery — runs periodically, must fail fast. */
  battery: 8_000,
  /** screencap -p — the fallback video path. */
  screencap: 10_000,
  /** am start / am force-stop / pm list. */
  appLifecycle: 15_000,
  /** uiautomator dump — genuinely slow on a loaded device. */
  inspectorDump: 20_000,
  default: 15_000,
} as const

/**
 * Per-profile OUTPUT budgets, for the profiles whose output is not text.
 *
 * `DEFAULT_MAX_OUTPUT_BYTES` (256 KB) is a sane ceiling for a command that prints lines — it is
 * what stops a runaway `dumpsys` from eating the core's memory (plan 22.1 §3.4). A screenshot is
 * not lines: a 720×1640 PNG of a busy video frame measured **1,115,196 bytes** on this farm's own
 * device, four times that ceiling. Sharing the text budget made `screenshot()` fail or succeed
 * according to how well the picture happened to compress, which showed up as a script dying
 * mid-run with `adb output exceeded 262144 bytes` on one video and sailing past the next.
 *
 * A profile absent from this map keeps `DEFAULT_MAX_OUTPUT_BYTES`; nothing text-shaped is loosened.
 */
export const ADB_MAX_OUTPUT_BYTES: Partial<Record<keyof typeof ADB_TIMEOUTS, number>> = {
  // Comfortably above a full-resolution PNG of the busiest frame, and still bounded: a device that
  // starts streaming gibberish down this path is stopped long before it can exhaust memory.
  screencap: 32 * 1024 * 1024,
  // The dump is text, but a deep hierarchy on a content-heavy app runs far past 256 KB — the
  // dumps taken while building the TikTok pack were 67–84 KB, and a denser screen exceeds it.
  inspectorDump: 4 * 1024 * 1024,
}

export type AdbTimeoutProfile = keyof typeof ADB_TIMEOUTS

/**
 * Resolves the effective exec deadline: an explicit `timeoutMs` wins over a
 * named profile, which wins over `default`. The result is always clamped to
 * `MAX_EXEC_TIMEOUT_MS` — there is no way to ask for an unbounded wait.
 */
export function resolveExecTimeout(opts?: { timeoutMs?: number; profile?: AdbTimeoutProfile }): number {
  const raw = opts?.timeoutMs ?? ADB_TIMEOUTS[opts?.profile ?? 'default']
  if (!Number.isFinite(raw) || raw <= 0) throw new AdbError('E_ADB_BAD_TIMEOUT', `invalid execTimeoutMs: ${raw}`)
  return Math.min(raw, MAX_EXEC_TIMEOUT_MS)
}
