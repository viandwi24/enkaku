import { z } from 'zod'
import { DeviceLabelModeSchema } from '../settings'

/**
 * Physical labelling's applied-state shape (plan 89 §4.3, §4.6). A NEW file
 * rather than an addition to `./devices.ts`: step 89.6 (the labelling
 * service, host side) was built while a concurrent worker owned that file's
 * device-shape changes for step 89.2 (the number), and CLAUDE.md's rule is
 * that WS/HTTP message shapes live in `@enkaku/protocol` — never duplicated
 * or hand-typed at a call site — not that every shape must share one file.
 * `packages/core/src/device/labelling.ts` is this schema's one producer;
 * `packages/core/src/api/devices.ts`'s label endpoints (89.6's own checklist
 * item, not yet wired — see that plan step's status note) are its intended
 * consumer.
 *
 * Mirrors `packages/core/src/db/schema.ts`'s `devices.labelState` doc comment
 * (mode, state, reason, originalCaptured, appliedAt) with one addition,
 * `capturedLockScreen` — see its own doc comment below for why tier 0 needs a
 * field tier 1 does not.
 */
export const DeviceLabelStateSchema = z.object({
  mode: DeviceLabelModeSchema,
  /**
   * `applied`  — the phone is showing exactly what was asked for.
   * `partial`  — some of it took (e.g. home wallpaper set, lock refused by an
   *              OEM skin). `reason` names which half. Never rounded up.
   * `stale`    — the phone is showing an older fingerprint; a re-apply is due.
   * `unavailable` — this device cannot do the requested mode. `reason` says why
   *              (no guest agent, no `screen-label` capability, the write was
   *              refused). Never silently downgraded to a mode that would work.
   * `unknown`  — the device is offline, or has never been asked.
   * `off`      — labelling is off for this device, which is not a failure.
   */
  state: z.enum(['off', 'applied', 'partial', 'stale', 'unavailable', 'unknown']),
  reason: z.string().nullable().default(null),
  fingerprint: z.string().nullable().default(null),
  appliedAt: z.number().int().nullable().default(null),
  /** Whether the phone's ORIGINAL wallpaper/lock-screen text was captured (H3). Gates the UI's "Restore original" — never offered when this is false. */
  originalCaptured: z.boolean().default(false),
  /**
   * Tier 0 (`lock-screen`) only — the exact prior `lock_screen_owner_info`
   * text and `_enabled` flag, captured once before the very first write, so
   * `clear` can restore it byte for byte (plan 89 §3.5's H2: unlike the
   * wallpaper, this tier's original genuinely IS readable). Always `null`
   * for tier 1, where the guest agent — not the host — holds the captured
   * original (H3); duplicating that value here would just be a second copy
   * that could drift from the one the device actually holds.
   */
  capturedLockScreen: z.object({ text: z.string(), enabled: z.boolean() }).nullable().default(null),
})
export type DeviceLabelState = z.infer<typeof DeviceLabelStateSchema>

/** The state every device starts in — never applied, nothing to restore. */
export const DEFAULT_DEVICE_LABEL_STATE: DeviceLabelState = {
  mode: 'off',
  state: 'off',
  reason: null,
  fingerprint: null,
  appliedAt: null,
  originalCaptured: false,
  capturedLockScreen: null,
}

/**
 * `POST /:id/label/clear`'s body (plan 89 §4.3) — every field optional, same
 * as `BlockBody`/`ConnectionDisconnectBody` in `packages/core/src/api/
 * devices.ts`: a bodyless call is valid and defaults to NOT restoring the
 * original (the safer default — `LabellingService.clear`'s own
 * `restoreOriginal` gate already refuses to restore when nothing was
 * captured, so this default only matters when a capture DID succeed).
 */
export const DeviceLabelClearBodySchema = z.object({ restoreOriginal: z.boolean().default(false) })

/**
 * The fleet-wide `POST /api/devices/labels/apply` body/response envelope
 * that used to live here is removed by plan 207 (MVP 07): `set-label` is now
 * one of the actions API verbs (`POST /api/actions/set-label`), and its
 * per-device result is `ActionResultSchema` with `detail: DeviceLabelState`
 * (`../actions.ts`), not a bespoke fleet envelope.
 */
