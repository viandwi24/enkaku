import { z } from 'zod'
import { TransferKindSchema } from '../messages/transfer'

/**
 * `GET /api/transfers` (plan 107 §3.1, §3.4, §4, step 107.2) — every
 * install/push/pull `runTransfer` (`packages/core/src/device/transfer-dispatch.ts`)
 * currently knows about, so a client that was NOT already subscribed to
 * `transfer.progress`/`transfer.done` — a second tab, or the same tab after a
 * reload — can discover an operation it did not watch start. Plan 107 §3.1's
 * finding: install already mints a `transferId` and already streams progress
 * (`transfer.progress`/`transfer.done`); the gap was never a progress bar, it
 * was that nothing could discover an operation whose start it missed (G2).
 *
 * **Backed by an IN-MEMORY registry, not a database row** — plan 107 §3.4's
 * smaller of two options (`packages/core/src/device/transfer-registry.ts`).
 * State plainly what that loses: **a core restart forgets every entry**,
 * including one whose `adb push`/`pm install` is still running on the phone —
 * the transfer is server-side work outliving the HTTP request that started
 * it, not a client connection, so the underlying operation can survive the
 * process that was tracking it. `GET /api/transfers` answers "what is THIS
 * PROCESS aware of right now", never "what has ever run" or "what is
 * currently running on the device regardless of core uptime". A reader who
 * does not know that will wrongly treat an empty list right after a restart
 * as proof nothing is happening.
 *
 * Shaped so a later swap to a durable `transfers` table (plan 107 §3.4's
 * other option — survives restart, consistent with jobs/batches,
 * but a schema change and a retention question for something usually over in
 * seconds) would not change this response shape or any client reading it —
 * only `transfer-registry.ts`'s internals, and this file's own producer,
 * would change. That is the condition plan 107 §3.4 sets for choosing the
 * smaller step safely rather than merely cheaply.
 *
 * `sent`/`total` are a POINT-IN-TIME snapshot from the single poll that
 * fetched this list — never a repeated push. This is not the farm-wide
 * per-chunk broadcast F27 closed (plan 93 §3.9, plan 107 §3.3): the live
 * per-chunk stream stays exactly where F27 put it, scoped to viewers of the
 * device via `transfer.progress`/`transfer.done`. This list exists only to
 * tell a client WHICH device(s) and transferId(s) to subscribe to — the
 * snapshot fields are a convenience so a reload shows last-known progress
 * immediately, not a substitute for the live channel.
 */
export const TransferStateSchema = z.enum(['running', 'done'])
export type TransferState = z.infer<typeof TransferStateSchema>

/**
 * Plan 106 §5 step 106.8 — `'preparation'` for a transfer the device-
 * preparation runner started (`ui-server-component.ts`'s install, routed
 * through this same machinery per plan 106 §9 Q5's recommendation), never an
 * operator's own `POST /api/devices/:id/install`, a batch's `internal:install`,
 * or a script's `ctx.device.install` — those three (and push/pull) stay
 * `'operator'`, the default. Lets a tray (plan 107 §3.5) label a
 * preparation-initiated install distinctly ("Preparing <device>") rather
 * than as though an operator started it.
 */
export const TransferOriginSchema = z.enum(['operator', 'preparation'])
export type TransferOrigin = z.infer<typeof TransferOriginSchema>

export const TransferRecordSchema = z.object({
  transferId: z.string(),
  deviceId: z.string(),
  kind: TransferKindSchema,
  state: TransferStateSchema,
  /** unix seconds. */
  startedAt: z.number().int(),
  /** unix seconds — the last progress tick, or the moment it finished. */
  updatedAt: z.number().int(),
  /** Defaults to `'operator'` so every pre-106.8 producer of this shape (the object literals `transfer-registry.ts` builds) needs no change to keep validating. */
  origin: TransferOriginSchema.default('operator'),
  sent: z.number().int().min(0),
  /** Total bytes when known (a push/install knows the local file size up front; a pull only after `stat`) — mirrors `TransferProgressMessage.payload.total`. */
  total: z.number().int().nullable(),
  /** `null` while `state === 'running'`. */
  ok: z.boolean().nullable(),
  error: z.string().nullable(),
})
export type TransferRecord = z.infer<typeof TransferRecordSchema>

/**
 * `GET /api/transfers` — deliberately NOT `pageSchema`'s keyset envelope
 * (plan 30). That convention is for unbounded history; this list is bounded
 * by construction to "currently running, plus whatever finished in the last
 * `RETENTION_MS`" — a couple dozen entries at the farm's adb concurrency
 * ceiling, never a growing table to page through.
 */
export const TransfersResponseSchema = z.object({ transfers: z.array(TransferRecordSchema) })
