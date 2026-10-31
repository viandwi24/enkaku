import type { TouchCaptureSource, TouchCaptureState, TouchStroke, TouchStrokeKind } from '@enkaku/protocol'
import {
  TOUCH_CAPTURE_LONG_PRESS_MS,
  TOUCH_CAPTURE_MAX_BYTES,
  TOUCH_CAPTURE_MAX_DURATION_MS,
  TOUCH_CAPTURE_MAX_SAMPLES,
  TOUCH_CAPTURE_MAX_STROKES,
  TOUCH_CAPTURE_REPROBE_MIN_MS,
  TOUCH_CAPTURE_TAP_TRAVEL,
} from '../../config/constants'
import { EnkakuError } from '../../util/errors'
import type { Logger } from '../../util/logger'
import type { ShellPort } from '../shell-port'
import { ABS_MT_POSITION_X, ABS_MT_POSITION_Y, BTN_TOUCH, EV_ABS, EV_KEY, parseEvdevLine } from './evdev'
import { parseTouchPanels, type TouchPanelProfile } from './probe'
import { createStrokeAssembler, type RawStroke, type StrokeAssembler } from './strokes'

/**
 * Physical touch capture (plan 1000 §4.5) — one `getevent` stream per
 * device, shared by every viewer of it, assembling the operator's own finger
 * into strokes.
 *
 * ## Why this is a service and not a `MonitorKind`
 *
 * `MonitorHub` already runs shared, ref-counted `getevent`-shaped streams,
 * and reusing it was the first design. It does not fit: a monitor's product
 * is LINES, fanned out verbatim to whoever asked, and this one's product is
 * a structured stroke assembled across hundreds of lines against a
 * per-device axis probe. Bolting that onto the hub would put a parser with
 * per-device state inside a component whose whole contract is that it has
 * none. So this borrows the hub's shape — one entry per device, viewers
 * counted, the stream stopped when the last one leaves, a readiness hold
 * for its lifetime — and keeps its own state.
 *
 * ## What it deliberately does NOT do
 *
 * - **It never writes to the database.** The buffer is in memory, bounded,
 *   and dies with the capture (`TOUCH_CAPTURE_MAX_STROKES`). A device event
 *   row per stroke would be thousands of rows an hour at ONE-SECOND
 *   resolution (`device_events.at` is unix seconds), which is the one thing
 *   a touch capture must not be: the whole feature exists for millisecond
 *   intervals.
 * - **It never corrects for display rotation.** See the header of
 *   `messages/touch-capture.ts`: the panel's own orientation is what it
 *   reports, and `TouchCaptureSource.rotation` is the fact a consumer needs
 *   to correct it themselves.
 */

/** What every status message carries — one shape for `start`, `clear`, an end-of-stream and a probe update. */
export interface TouchCaptureStatus {
  deviceId: string
  state: TouchCaptureState
  reason?: string
  sources: TouchCaptureSource[]
  /** Present on a reply, absent on a pushed update — see `TouchCaptureStatusMessage`. */
  strokes?: TouchStroke[]
  viewers: number
}

export interface TouchCaptureService {
  /** Opens the capture, or joins the one already running. Idempotent per client. */
  start(clientId: string, deviceId: string): Promise<TouchCaptureStatus>
  /** Leaves. The stream stops when the last viewer does. */
  stop(clientId: string, deviceId: string): void
  /** Empties the buffer, leaving the capture running. */
  clear(deviceId: string): TouchCaptureStatus
  /** WS disconnect: drops every capture this connection was viewing. */
  releaseClient(clientId: string): void
  /** The device went offline, or the farm is shutting down. */
  stopForDevice(deviceId: string, reason?: string): void
  status(deviceId: string): TouchCaptureStatus
}

export interface TouchCaptureDeps {
  /** Resolved by the caller, local or node-owned, exactly as `MonitorHub` gets it. */
  shellPort: (deviceId: string) => ShellPort
  log: Logger
  onStroke: (deviceId: string, stroke: TouchStroke) => void
  /** A state change nobody asked for: the stream died, a re-probe found a new panel. */
  onStatus: (status: TouchCaptureStatus) => void
  /** The display rotation, when the core knows it — recorded on each source, never applied. */
  rotationFor?: (deviceId: string) => number | null
  /** Keeps the device at least awake while a capture is open, released when the last viewer leaves. */
  holdFor?: (deviceId: string) => Promise<{ release(): void }>
}

/** `getevent -pl` — one shot, through the normal per-device queue. */
const PROBE_CMD = 'getevent -pl'
/** `-l` labels what it can, `-t` timestamps every line with the device's monotonic clock. No device argument: a capture watches EVERY input device, because the farm's own UHID pointer appears as a second one mid-capture. */
const STREAM_CMD = 'getevent -lt'
const PROBE_MAX_OUTPUT_BYTES = 512 * 1024

interface Entry {
  deviceId: string
  viewers: Set<string>
  profiles: Map<string, TouchPanelProfile>
  assembler: StrokeAssembler
  strokes: TouchStroke[]
  seq: number
  state: TouchCaptureState
  reason?: string
  handle: { stop(): Promise<void> } | null
  starting: Promise<void> | null
  stopRequested: boolean
  /** Bytes since the last newline, carried across chunks. */
  partial: string
  /** `Date.now()` minus the first event's monotonic timestamp — the ONE place the two clocks meet. */
  clockOffset: number | null
  /** Per input device: the previous stroke's down, for `gapMs`. */
  lastDownTsMs: Map<string, number>
  lastProbeAt: number
  reprobing: boolean
  hold: { release(): void } | null
  rotation: number | null
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function kindOf(travel: number, durationMs: number): TouchStrokeKind {
  if (travel >= TOUCH_CAPTURE_TAP_TRAVEL) return 'swipe'
  return durationMs >= TOUCH_CAPTURE_LONG_PRESS_MS ? 'longPress' : 'tap'
}

function sourceOf(profile: TouchPanelProfile, rotation: number | null): TouchCaptureSource {
  return {
    path: profile.path,
    name: profile.name,
    protocol: profile.protocol,
    maxX: profile.maxX,
    maxY: profile.maxY,
    synthetic: profile.synthetic,
    rotation,
  }
}

export function createTouchCaptureService(deps: TouchCaptureDeps): TouchCaptureService {
  const entries = new Map<string, Entry>()
  /** clientId → the devices it is viewing, so a disconnect is O(subscriptions). */
  const clientDevices = new Map<string, Set<string>>()

  function statusOf(entry: Entry, includeStrokes = false): TouchCaptureStatus {
    return {
      deviceId: entry.deviceId,
      state: entry.state,
      ...(entry.reason ? { reason: entry.reason } : {}),
      sources: [...entry.profiles.values()].map((p) => sourceOf(p, entry.rotation)),
      ...(includeStrokes ? { strokes: [...entry.strokes] } : {}),
      viewers: entry.viewers.size,
    }
  }

  function toStroke(entry: Entry, raw: RawStroke): TouchStroke | null {
    const profile = entry.profiles.get(raw.path)
    if (!profile) return null
    const first = raw.samples[0]
    const last = raw.samples[raw.samples.length - 1]
    if (!first || !last) return null

    const nx = (v: number) => clamp01(v / profile.maxX)
    const ny = (v: number) => clamp01(v / profile.maxY)
    const from = { x: nx(first.x), y: ny(first.y) }
    const to = { x: nx(last.x), y: ny(last.y) }

    let travel = 0
    for (const s of raw.samples) travel = Math.max(travel, Math.hypot(nx(s.x) - from.x, ny(s.y) - from.y))

    const durationMs = Math.max(0, raw.endTsMs - raw.startTsMs)
    const previousDown = entry.lastDownTsMs.get(raw.path)
    entry.lastDownTsMs.set(raw.path, raw.startTsMs)
    entry.seq += 1

    return {
      id: crypto.randomUUID(),
      deviceId: entry.deviceId,
      seq: entry.seq,
      kind: kindOf(travel, durationMs),
      source: profile.path,
      sourceName: profile.name,
      synthetic: profile.synthetic,
      at: Math.round((entry.clockOffset ?? Date.now() - raw.startTsMs) + raw.startTsMs),
      deviceTsMs: raw.startTsMs,
      durationMs,
      // Deliberately per INPUT DEVICE, not per phone: a capture normally
      // watches the glass and the farm's own UHID pointer at once, and an
      // interval that mixed a human tap with an injected one would be a
      // number about nothing.
      gapMs: previousDown === undefined ? null : Math.max(0, raw.startTsMs - previousDown),
      pointerId: raw.pointerId,
      concurrent: raw.concurrent,
      from,
      to,
      fromRaw: { x: Math.round(first.x), y: Math.round(first.y) },
      toRaw: { x: Math.round(last.x), y: Math.round(last.y) },
      travel,
      samples: raw.samples.map((s) => ({
        x: nx(s.x),
        y: ny(s.y),
        atMs: Math.max(0, Math.round((s.tsMs - raw.startTsMs) * 1000) / 1000),
        ...(s.pressure !== null && profile.pressureMax ? { pressure: clamp01(s.pressure / profile.pressureMax) } : {}),
      })),
      droppedSamples: raw.droppedSamples,
    }
  }

  /**
   * A path this capture has no profile for just reported a touch. The usual
   * cause is the farm's own UHID pointer appearing AFTER the probe — Device
   * Control opens a session, `ScrcpyUhidInput` creates "Enkaku Pointer", and
   * every tap the operator makes in the browser lands on an input device
   * this capture cannot normalise. Re-probing picks it up; the throttle is
   * what keeps a phone with a chatty non-touch device (a sensor hub) from
   * re-probing on every frame.
   */
  function maybeReprobe(entry: Entry, path: string): void {
    if (entry.profiles.has(path) || entry.reprobing) return
    const now = Date.now()
    if (now - entry.lastProbeAt < TOUCH_CAPTURE_REPROBE_MIN_MS) return
    entry.reprobing = true
    entry.lastProbeAt = now
    void (async () => {
      try {
        const found = await probePanels(entry.deviceId)
        let added = false
        for (const profile of found) {
          if (entry.profiles.has(profile.path)) continue
          entry.profiles.set(profile.path, profile)
          added = true
        }
        if (added) deps.onStatus(statusOf(entry))
      } catch (err) {
        deps.log.debug(`touch capture re-probe failed for ${entry.deviceId}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        entry.reprobing = false
      }
    })()
  }

  function handleChunk(entry: Entry, chunk: Uint8Array): void {
    const combined = entry.partial + new TextDecoder().decode(chunk)
    const lines = combined.split('\n')
    entry.partial = lines.pop() ?? ''
    for (const line of lines) {
      const ev = parseEvdevLine(line)
      if (!ev) continue
      if (entry.clockOffset === null && ev.tsMs !== null) entry.clockOffset = Date.now() - ev.tsMs
      if (!entry.profiles.has(ev.path)) {
        const touchish =
          (ev.type === EV_ABS && (ev.code === ABS_MT_POSITION_X || ev.code === ABS_MT_POSITION_Y)) || (ev.type === EV_KEY && ev.code === BTN_TOUCH)
        if (touchish) maybeReprobe(entry, ev.path)
        continue
      }
      for (const raw of entry.assembler.push(ev)) {
        const stroke = toStroke(entry, raw)
        if (!stroke) continue
        entry.strokes.push(stroke)
        if (entry.strokes.length > TOUCH_CAPTURE_MAX_STROKES) entry.strokes.splice(0, entry.strokes.length - TOUCH_CAPTURE_MAX_STROKES)
        deps.onStroke(entry.deviceId, stroke)
      }
    }
  }

  async function probePanels(deviceId: string): Promise<TouchPanelProfile[]> {
    const port = deps.shellPort(deviceId)
    const result = await port.exec(PROBE_CMD, { profile: 'appLifecycle', maxOutputBytes: PROBE_MAX_OUTPUT_BYTES })
    return parseTouchPanels(result.stdout)
  }

  function releaseEntry(entry: Entry, state: TouchCaptureState, reason?: string): void {
    entry.state = state
    if (reason) entry.reason = reason
    else delete entry.reason
    entry.stopRequested = true
    const handle = entry.handle
    entry.handle = null
    entry.hold?.release()
    entry.hold = null
    if (handle) void handle.stop().catch(() => undefined)
  }

  function stopEntry(deviceId: string, reason?: string): void {
    const entry = entries.get(deviceId)
    if (!entry) return
    entries.delete(deviceId)
    for (const clientId of entry.viewers) clientDevices.get(clientId)?.delete(deviceId)
    entry.viewers.clear()
    releaseEntry(entry, 'stopped', reason)
  }

  function addViewer(clientId: string, entry: Entry): void {
    entry.viewers.add(clientId)
    let set = clientDevices.get(clientId)
    if (!set) {
      set = new Set()
      clientDevices.set(clientId, set)
    }
    set.add(entry.deviceId)
  }

  return {
    async start(clientId, deviceId) {
      const existing = entries.get(deviceId)
      if (existing) {
        addViewer(clientId, existing)
        if (existing.starting) await existing.starting
        return statusOf(existing, true)
      }

      const entry: Entry = {
        deviceId,
        viewers: new Set(),
        profiles: new Map(),
        assembler: createStrokeAssembler({
          profileFor: (path) => entries.get(deviceId)?.profiles.get(path) ?? null,
          maxSamples: TOUCH_CAPTURE_MAX_SAMPLES,
          now: () => Date.now(),
        }),
        strokes: [],
        seq: 0,
        state: 'starting',
        handle: null,
        starting: null,
        stopRequested: false,
        partial: '',
        clockOffset: null,
        lastDownTsMs: new Map(),
        lastProbeAt: 0,
        reprobing: false,
        hold: null,
        rotation: deps.rotationFor?.(deviceId) ?? null,
      }
      entries.set(deviceId, entry)
      addViewer(clientId, entry)

      const starting = (async () => {
        entry.lastProbeAt = Date.now()
        const panels = await probePanels(deviceId)
        if (panels.length === 0) {
          throw new EnkakuError(
            'E_NOT_SUPPORTED',
            'no touch panel found in `getevent -pl` on this device — its input devices report no ABS_MT_POSITION_X and no BTN_TOUCH',
          )
        }
        for (const panel of panels) entry.profiles.set(panel.path, panel)
        if (deps.holdFor) entry.hold = await deps.holdFor(deviceId)
        if (entry.stopRequested) return
        const port = deps.shellPort(deviceId)
        entry.handle = await port.stream(STREAM_CMD, {
          onData: (chunk) => handleChunk(entry, chunk),
          onEnd: (reason) => {
            if (!entries.has(deviceId)) return
            entries.delete(deviceId)
            for (const clientId of entry.viewers) clientDevices.get(clientId)?.delete(deviceId)
            entry.viewers.clear()
            releaseEntry(entry, 'stopped', `the capture stream ended (${reason})`)
            deps.onStatus(statusOf(entry))
          },
          // Both of the lane's clocks matter here and are set deliberately —
          // see `TOUCH_CAPTURE_MAX_BYTES`: the idle one is OFF, because a
          // phone nobody has touched for two minutes is the whole point.
          idleTimeoutMs: 0,
          absoluteTimeoutMs: TOUCH_CAPTURE_MAX_DURATION_MS,
          maxBytes: TOUCH_CAPTURE_MAX_BYTES,
        })
        if (entry.stopRequested) {
          const handle = entry.handle
          entry.handle = null
          void handle?.stop().catch(() => undefined)
          return
        }
        entry.state = 'active'
      })()

      entry.starting = starting
      try {
        await starting
      } catch (err) {
        entries.delete(deviceId)
        for (const id of entry.viewers) clientDevices.get(id)?.delete(deviceId)
        entry.hold?.release()
        entry.hold = null
        const message = err instanceof Error ? err.message : String(err)
        deps.log.warn(`touch capture could not start on ${deviceId}: ${message}`)
        return { deviceId, state: 'unavailable', reason: message, sources: [], strokes: [], viewers: 0 }
      } finally {
        entry.starting = null
      }
      return statusOf(entry, true)
    },

    stop(clientId, deviceId) {
      const entry = entries.get(deviceId)
      if (!entry) return
      entry.viewers.delete(clientId)
      clientDevices.get(clientId)?.delete(deviceId)
      if (entry.viewers.size === 0) stopEntry(deviceId)
    },

    clear(deviceId) {
      const entry = entries.get(deviceId)
      if (!entry) return { deviceId, state: 'stopped', sources: [], strokes: [], viewers: 0 }
      entry.strokes = []
      return statusOf(entry, true)
    },

    releaseClient(clientId) {
      const devices = clientDevices.get(clientId)
      if (!devices) return
      clientDevices.delete(clientId)
      for (const deviceId of devices) {
        const entry = entries.get(deviceId)
        if (!entry) continue
        entry.viewers.delete(clientId)
        if (entry.viewers.size === 0) stopEntry(deviceId)
      }
    },

    stopForDevice(deviceId, reason) {
      const entry = entries.get(deviceId)
      if (!entry) return
      stopEntry(deviceId, reason ?? 'the device went away')
      deps.onStatus(statusOf(entry))
    },

    status(deviceId) {
      const entry = entries.get(deviceId)
      if (!entry) return { deviceId, state: 'stopped', sources: [], strokes: [], viewers: 0 }
      return statusOf(entry, true)
    },
  }
}
