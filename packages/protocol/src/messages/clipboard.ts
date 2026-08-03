import { z } from 'zod'

/**
 * Device clipboard get/set over WS (plan 38 §4.5).
 *
 * `clipboard.get`/`clipboard.set` are request/reply, correlated by `id` like
 * `monitor.oneshot` and `lease.acquire` — NOT broadcast to every viewer the
 * way `shell.echo`/`shell.result` are (plan 26 §3.8). Clipboard content is
 * very often a password or a one-time token, so `clipboard.value` goes ONLY
 * to the requesting connection (§4.5); fanning it out to every viewer of the
 * device the way the terminal transcript is would be a privacy hole
 * introduced by accident.
 */

// ---- client -> server ----

export const ClipboardGetMessage = z.object({
  type: z.literal('clipboard.get'),
  id: z.string(),
  payload: z.object({ deviceId: z.string() }),
})

export const ClipboardSetMessage = z.object({
  type: z.literal('clipboard.set'),
  id: z.string(),
  payload: z.object({
    deviceId: z.string(),
    /** Bounds one WS message (plan 38 §9 Q3) — not a content restriction beyond that. */
    text: z.string().max(65536),
    /** Immediately pastes into the focused field on the device. Off by default — explicit opt-in (plan 38 §3.4). */
    paste: z.boolean().default(false),
  }),
})

// ---- server -> client (unicast: the requesting connection only) ----

export const ClipboardValueMessage = z.object({
  type: z.literal('clipboard.value'),
  id: z.string(),
  payload: z.object({ deviceId: z.string(), text: z.string() }),
})

export const ClipboardOkMessage = z.object({
  type: z.literal('clipboard.ok'),
  id: z.string(),
  payload: z.object({ deviceId: z.string() }),
})
