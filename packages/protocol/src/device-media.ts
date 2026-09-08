import { z } from 'zod'

/**
 * What MediaStore holds, as a script and an operator see it.
 *
 * This is the READ counterpart to `mediaScan` (`./messages/transfer.ts`).
 * `mediaScan` tells MediaStore a pushed file exists; nothing until now could
 * ask MediaStore what it actually knows — so a script that pushed a video and
 * then drove an app's gallery picker had to assume the newest cell was its
 * own. `plugins/tiktok-automation-pack/src/post-video.ts` says so in its own
 * words: it verifies the picker is sorted newest-first and taps cell zero,
 * because "no capability measures the pushed file's own duration". A camera
 * capture, a download, or a second concurrent job landing between the push and
 * the tap posts the WRONG video, and nothing in the run would say so.
 *
 * Read over `content query` on the shell, exactly like `mediaScan`'s
 * `content call` — the shell is not subject to scoped storage, so no APK and
 * no guest-agent capability is needed (plan 90 §3.1's rule, same conclusion).
 */

/**
 * The three MediaStore volumes worth reading. Each maps to one
 * `content://media/external/<x>/media` URI — never a free-form URI from a
 * caller, which is why this is a closed enum rather than a string.
 */
export const DeviceMediaKindSchema = z.enum(['image', 'video', 'audio'])
export type DeviceMediaKind = z.infer<typeof DeviceMediaKindSchema>

export const DeviceMediaItemSchema = z.object({
  /** MediaStore's `_id`. A STRING even though the column is an integer: it is an opaque handle to pass back, never a number to do arithmetic on. */
  id: z.string(),
  kind: DeviceMediaKindSchema,
  /** `_display_name` — the filename the gallery shows. */
  displayName: z.string(),
  /** `_data` — the absolute on-device path. Null on an OEM build that withholds the column. */
  path: z.string().nullable(),
  /** `date_added`, unix **seconds** — MediaStore's own unit, and the repo-wide convention. */
  addedAt: z.number().int().nonnegative(),
  /** `_size`. Null when MediaStore has not stat'd the row yet. */
  sizeBytes: z.number().int().nonnegative().nullable(),
  /** `duration`, **milliseconds** — MediaStore's unit. Always null for an image. */
  durationMs: z.number().int().nonnegative().nullable(),
  mimeType: z.string().nullable(),
})
export type DeviceMediaItem = z.infer<typeof DeviceMediaItemSchema>

export const DeviceMediaListArgsSchema = z.object({
  kind: DeviceMediaKindSchema.default('video'),
  /**
   * Newest first, capped. 200 is well inside the adb output budget
   * (`DEFAULT_MAX_OUTPUT_BYTES`, 256 KB, at roughly 150 bytes a row) — this
   * answers "what is on the phone right now", never "enumerate the gallery".
   */
  limit: z.number().int().min(1).max(200).default(50),
  /** Keep only rows whose `_data` sits at or under this absolute path — filtered HOST-side, so an OEM build that withholds `_data` simply returns nothing rather than a wrong answer. */
  underPath: z.string().optional(),
})
export type DeviceMediaListArgs = z.infer<typeof DeviceMediaListArgsSchema>

export const DeviceMediaListResultSchema = z.object({
  /** Newest first, by `date_added`. */
  items: z.array(DeviceMediaItemSchema),
  /** True when the device had more rows than `limit` — the list is a window, and a caller reasoning about "the newest" must know it is not the whole truth. */
  truncated: z.boolean(),
})
export type DeviceMediaListResult = z.infer<typeof DeviceMediaListResultSchema>
