import { z } from 'zod'
import { SelectorSchema, UiNodeSchema } from '../ui-node'

/**
 * The Inspect tab's WS protocol (plan 56 §4.1). Goes through the SAME
 * `Inspector` driver interface every script already uses (`dump`/`find`/
 * `screenshot`) — nothing new runs on the device. Reading the screen is a
 * control-grade action (plan 56 §3.7): it can carry whatever text is on
 * screen (passwords included) and seizes the `instrumentation` lock, so
 * every message here is refused server-side without the manual lease, the
 * same `checkInputAllowed` gate `input.*` uses.
 */

/** Correlates the JSON `inspect.tree`/`inspect.match` reply with the binary snapshot frame on `CHANNEL.SNAPSHOT` (byte 1 of the frame, plan 56 §3.8) — one byte, so it is capped at 255. */
export const InspectRequestIdSchema = z.number().int().min(0).max(255)

export const FrameSizeSchema = z.object({ width: z.number().int(), height: z.number().int() })

// ---- client → server ----

/** Start (or join) the inspector engine for this device — ref-counted per device across every attached viewer (§3.2). */
export const InspectAttachMessage = z.object({
  type: z.literal('inspect.attach'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string() }),
})

/** Release this viewer's hold on the inspector engine; released for real once the last one leaves. */
export const InspectDetachMessage = z.object({
  type: z.literal('inspect.detach'),
  payload: z.object({ deviceId: z.string() }),
})

/** A full tree dump, optionally paired with a screenshot taken by the same inspector (§3.4) so the two describe the same instant. */
export const InspectDumpMessage = z.object({
  type: z.literal('inspect.dump'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string(), requestId: InspectRequestIdSchema, screenshot: z.boolean() }),
})

/** Run a real `Inspector.find` against the live device — the "Test on device" button (§4.4). */
export const InspectFindMessage = z.object({
  type: z.literal('inspect.find'),
  id: z.string().optional(),
  payload: z.object({ deviceId: z.string(), requestId: InspectRequestIdSchema, selector: SelectorSchema }),
})

// ---- server → client ----

export const InspectStateSchema = z.enum(['detached', 'starting', 'ready', 'unavailable'])
export type InspectState = z.infer<typeof InspectStateSchema>

export const InspectStatusMessage = z.object({
  type: z.literal('inspect.status'),
  id: z.string().optional(),
  payload: z.object({
    deviceId: z.string(),
    state: InspectStateSchema,
    engineId: z.string(),
    /** From the registry descriptor (`EngineDescriptor.capabilities`) — empty while `state` is `starting` or `unavailable`. */
    capabilities: z.array(z.string()),
    /** Why `state` is `unavailable` — always set when it is (§4.1). */
    reason: z.string().optional(),
  }),
})

export const InspectTreeMessage = z.object({
  type: z.literal('inspect.tree'),
  id: z.string().optional(),
  payload: z.object({
    deviceId: z.string(),
    requestId: InspectRequestIdSchema,
    root: UiNodeSchema,
    /** The dump's own geometry, not the video's (§4.1) — a highlight is computed against this, never the live stream's size. */
    frameSize: FrameSizeSchema,
    /** Unix epoch seconds — when this dump was taken. */
    at: z.number(),
    tookMs: z.number(),
    /** Whether a PNG follows on `CHANNEL.SNAPSHOT`, correlated by `requestId`. */
    snapshot: z.boolean(),
  }),
})

export const InspectMatchMessage = z.object({
  type: z.literal('inspect.match'),
  id: z.string().optional(),
  payload: z.object({
    deviceId: z.string(),
    requestId: InspectRequestIdSchema,
    node: UiNodeSchema.nullable(),
    tookMs: z.number(),
  }),
})
