import { z } from 'zod'
import { NormPointSchema } from './input'

/**
 * Physical touch capture (plan 1000) — the operator's own finger on the
 * glass, read back off the phone's evdev stream (`getevent`) and assembled
 * into strokes here.
 *
 * **This is the mirror image of `input.*`.** Those messages carry input the
 * farm SENDS; everything in this file describes input the farm OBSERVED,
 * including its own, so the two can be compared side by side. Plan 94 §3.3
 * declined this deliberately and recorded the operator's browser input
 * instead; plan 1000 §3.1 reopens it for the one thing that path can never
 * answer — what a real finger does, in real milliseconds, when nobody is
 * synthesising it.
 *
 * Two properties every consumer depends on:
 *
 * - **Coordinates are the TOUCH PANEL's, normalised 0..1 against that
 *   panel's own `ABS_MT_POSITION_X/Y` maximum** (`TouchCaptureSource.maxX`/
 *   `maxY`), never a display pixel and never rotation-corrected. A panel
 *   reports in its natural (as-mounted) orientation and knows nothing about
 *   the display's current rotation, so a stroke recorded on a landscape
 *   screen is stored as the panel saw it. `rotation` on the source says what
 *   the display was doing at capture time when the core could read it, so a
 *   consumer can correct it; nothing here corrects it silently.
 * - **Time is the DEVICE's monotonic clock** (`deviceTsMs`, exact, from
 *   evdev), with `at` derived once per stream from the host's clock at the
 *   first event. Intervals (`gapMs`, `durationMs`, every sample's `atMs`)
 *   are always computed from the monotonic clock, so they survive an NTP
 *   step on either side; `at` alone is the approximate one, and is labelled
 *   as such wherever it is rendered.
 */

/** How a touch panel reports contacts — decided from its ABS axes at probe time (plan 1000 §4.2). */
export const TouchProtocolSchema = z.enum(['mt-b', 'mt-a', 'st'])
export type TouchProtocol = z.infer<typeof TouchProtocolSchema>

/**
 * One input device the capture is reading. A phone normally has exactly one
 * real touchscreen — but a device under farm control also carries the UHID
 * pointer `ScrcpyUhidInput` creates ("Enkaku Pointer"), which lands in
 * `/dev/input/` like any other. That one is reported with `synthetic: true`
 * rather than hidden: "did the tap I injected actually reach the kernel, and
 * where" is the second question this feature exists to answer.
 */
export const TouchCaptureSourceSchema = z
  .object({
    /** `/dev/input/eventN`. */
    path: z.string(),
    /** The kernel's own name for it, e.g. `goodix_ts`, `Enkaku Pointer`. */
    name: z.string(),
    protocol: TouchProtocolSchema,
    /** `ABS_MT_POSITION_X`'s maximum — the divisor behind every normalised `x`. */
    maxX: z.number().int().positive(),
    maxY: z.number().int().positive(),
    /** The farm's own injected pointer, not a finger (matched on the name `ScrcpyUhidInput` creates). */
    synthetic: z.boolean(),
    /** The display's rotation (0/90/180/270) when capture started, when the core could read it — see the file header. */
    rotation: z.number().int().nullable(),
  })
  .strict()
export type TouchCaptureSource = z.infer<typeof TouchCaptureSourceSchema>

/**
 * One position report inside a stroke. `atMs` is elapsed time since that
 * stroke's own down, from the device's monotonic clock — the same contract
 * `NormGestureSampleSchema` uses, so a captured stroke can be handed
 * straight to `input.gesture` for replay without rescaling either axis.
 */
export const TouchCaptureSampleSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    atMs: z.number().min(0),
    /** `ABS_MT_PRESSURE`, normalised against the panel's own maximum — absent when the panel does not report it. */
    pressure: z.number().min(0).max(1).optional(),
  })
  .strict()
export type TouchCaptureSample = z.infer<typeof TouchCaptureSampleSchema>

/**
 * Tap, long press, swipe — decided from the stroke's own travel and hold
 * (plan 1000 §4.4), the same two-question test `observeStream` already
 * applies to browser input, so the words mean the same thing on both paths.
 */
export const TouchStrokeKindSchema = z.enum(['tap', 'longPress', 'swipe'])
export type TouchStrokeKind = z.infer<typeof TouchStrokeKindSchema>

/** One contact, down to up (plan 1000 §4.4). */
export const TouchStrokeSchema = z
  .object({
    id: z.string(),
    deviceId: z.string(),
    /** Position in this capture, from 1, so a gap in a copied JSON export is visible. */
    seq: z.number().int().positive(),
    kind: TouchStrokeKindSchema,
    source: z.string(),
    sourceName: z.string(),
    synthetic: z.boolean(),
    /** Approximate wall clock, epoch ms — see the file header before using it for anything but a label. */
    at: z.number(),
    /** The device's own monotonic clock at the down, ms. Exact; every interval is computed from it. */
    deviceTsMs: z.number(),
    /** Down → up. */
    durationMs: z.number().min(0),
    /** Since the PREVIOUS stroke's down on this device — the "interval" an operator reads. `null` for the first stroke of a capture. */
    gapMs: z.number().min(0).nullable(),
    /** The evdev slot (mt-b) or 0 — stable for the life of the contact, never across contacts. */
    pointerId: z.number().int().nonnegative(),
    /** Another contact was down at the same time: this stroke is one finger of a multi-touch gesture, not a gesture on its own. */
    concurrent: z.boolean(),
    from: NormPointSchema,
    to: NormPointSchema,
    /** The same two points in the panel's own units, kept so a report can be compared against `getevent` output directly. */
    fromRaw: z.object({ x: z.number().int(), y: z.number().int() }).strict(),
    toRaw: z.object({ x: z.number().int(), y: z.number().int() }).strict(),
    /** The largest normalised distance any sample reached from the down point — what decides tap vs swipe. */
    travel: z.number().min(0),
    samples: z.array(TouchCaptureSampleSchema).min(1),
    /** Samples the cap dropped from the middle of the path; 0 for every ordinary stroke. */
    droppedSamples: z.number().int().nonnegative(),
  })
  .strict()
export type TouchStroke = z.infer<typeof TouchStrokeSchema>

/**
 * `unavailable` is the honest answer for a device whose panel could not be
 * probed (no `ABS_MT_POSITION_X` anywhere in `getevent -pl`, a node-owned
 * device, a phone that refuses the read) — never an empty `active` capture
 * that would look like a phone nobody is touching.
 */
export const TouchCaptureStateSchema = z.enum(['starting', 'active', 'stopped', 'unavailable'])
export type TouchCaptureState = z.infer<typeof TouchCaptureStateSchema>

// ---- client → server ----

/** Opens (or joins) the capture on this device. Idempotent per connection. */
export const TouchCaptureStartMessage = z.object({
  type: z.literal('touch.capture.start'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

/** Leaves it. The underlying `getevent` stream stops when the last viewer leaves. */
export const TouchCaptureStopMessage = z.object({
  type: z.literal('touch.capture.stop'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

/** Empties the buffer without stopping the capture — the operator starting a fresh measurement. */
export const TouchCaptureClearMessage = z.object({
  type: z.literal('touch.capture.clear'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

// ---- server → client ----

export const TouchCaptureStatusMessage = z.object({
  type: z.literal('touch.capture.status'),
  id: z.string().optional(),
  payload: z.object({
    deviceId: z.string(),
    state: TouchCaptureStateSchema,
    /** Why it is `unavailable`, or why an `active` capture stopped on its own. */
    reason: z.string().optional(),
    sources: z.array(TouchCaptureSourceSchema),
    /**
     * Everything the buffer holds — sent on a REPLY (join, clear, an
     * explicit status) so a reopened tab is not blank.
     *
     * Absent on a status the server PUSHES on its own (a re-probe found a
     * second panel, the stream died): the buffer is up to
     * `TOUCH_CAPTURE_MAX_STROKES` strokes with every sample of each, and
     * resending all of it to say "a panel appeared" would be a megabyte to
     * carry one boolean. A client that receives no `strokes` keeps the ones
     * it has — it has not missed any, since every stroke also arrives on
     * its own `touch.capture.stroke`.
     */
    strokes: z.array(TouchStrokeSchema).optional(),
    viewers: z.number().int().nonnegative(),
  }),
})

export const TouchCaptureStrokeMessage = z.object({
  type: z.literal('touch.capture.stroke'),
  payload: z.object({ deviceId: z.string(), stroke: TouchStrokeSchema }),
})
