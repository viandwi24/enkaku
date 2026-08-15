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

/**
 * `push`'s `mediaScan` request field (plan 90 §3.4, §4.6). `auto` — the
 * default — scans only when the resolved remote path sits under a known
 * media root; `always`/`never` override that detection. There is no gallery
 * facet (plan 90 §3.4): telling MediaStore about a pushed file is the one
 * genuinely missing step, and it is a host-side shell command, not an APK.
 */
export const MediaScanModeSchema = z.enum(['auto', 'always', 'never'])
export type MediaScanMode = z.infer<typeof MediaScanModeSchema>

/** `internal:push` (plan 93 §4.6, step 93.9) — a near-copy of `InstallJobParamsSchema` for `TransferService.push`. */
export const PushJobParamsSchema = z.object({
  artifactId: z.string().min(1),
  remotePath: z.string().min(1),
  mediaScan: MediaScanModeSchema.optional(),
})
export type PushJobParams = z.infer<typeof PushJobParamsSchema>

/** `internal:pull` (plan 93 §4.6, §4.7, step 93.9) — the executor forwards `job.id` into `registerDeviceArtifact` so a bulk pull's artifacts carry the pulling job's id (F12). */
export const PullJobParamsSchema = z.object({
  remotePath: z.string().min(1),
})
export type PullJobParams = z.infer<typeof PullJobParamsSchema>

/**
 * `push`'s extended result (plan 90 §4.6, H3). `method` names which of
 * `content call --method scan_file` / `scan_volume` actually answered —
 * this is how H3 ("does `scan_file` work as the shell user on Android 10+")
 * gets settled in the field instead of assumed. A failed scan is reported
 * here and NEVER fails the push: the bytes already landed either way.
 */
export const MediaScanResultSchema = z.object({
  ran: z.boolean(),
  method: z.enum(['scan_file', 'scan_volume']).nullable(),
  ms: z.number(),
  error: z.string().optional(),
})
export type MediaScanResult = z.infer<typeof MediaScanResultSchema>

export const PushResultSchema = z.object({ mediaScan: MediaScanResultSchema })
export type PushResult = z.infer<typeof PushResultSchema>
