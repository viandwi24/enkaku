import { z } from 'zod'

/**
 * File transfer and APK install (plan 39 §4.4). Progress and completion are
 * WS broadcasts, fanned out to every viewer of the device (`shellTargets`-
 * style scoping lives in the core's WS handler, not here) — REST does the
 * CRUD (start a push/pull/install, and see its final result), WS carries the
 * live parts REST cannot: progress while it runs, and a client's request to
 * cancel it.
 */

export const TransferKindSchema = z.enum(['push', 'pull', 'install'])
export type TransferKind = z.infer<typeof TransferKindSchema>

export const TransferProgressMessage = z.object({
  type: z.literal('transfer.progress'),
  payload: z.object({
    deviceId: z.string(),
    transferId: z.string(),
    kind: TransferKindSchema,
    sent: z.number(),
    /** Total bytes when known (a push/install knows the local file size up front; a pull only after `stat`). */
    total: z.number().nullable(),
  }),
})

export const TransferDoneMessage = z.object({
  type: z.literal('transfer.done'),
  payload: z.object({
    deviceId: z.string(),
    transferId: z.string(),
    kind: TransferKindSchema,
    ok: z.boolean(),
    error: z.string().optional(),
    result: z.unknown().optional(),
  }),
})

/** Client → server: stop a transfer in progress (plan 39 acceptance #9). */
export const TransferCancelMessage = z.object({
  type: z.literal('transfer.cancel'),
  id: z.string().optional(),
  payload: z.object({ transferId: z.string() }),
})

/** `POST /api/devices/:id/install` and the `internal:install` batch executor share this shape (plan 39 §4.4, §4.5). */
export const InstallJobParamsSchema = z.object({
  artifactId: z.string().min(1),
  reinstall: z.boolean().optional(),
  grantPermissions: z.boolean().optional(),
  allowDowngrade: z.boolean().optional(),
})
export type InstallJobParams = z.infer<typeof InstallJobParamsSchema>

/** `pm install`'s outcome (plan 39 §4.2) — `package` is populated only when `pm install` itself reports it, never guessed. */
export const InstallResultSchema = z.object({
  package: z.string().nullable(),
  durationMs: z.number(),
  output: z.string(),
})
export type InstallResult = z.infer<typeof InstallResultSchema>
