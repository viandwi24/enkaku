import { z } from 'zod'

/**
 * Browsing and managing files ON THE PHONE (plan 800 D1) — the half `push`
 * and `pull` never had. Those two move bytes between the farm and a device;
 * nothing could list a directory, rename a file, or delete one.
 *
 * Built on the shell (`ls`, `stat`, `mv`, `rm`, `mkdir`) for the same reason
 * `mediaScan` and `device.media.list` are: the shell user is not subject to
 * scoped storage, so no APK and no guest-agent capability is needed (plan 90
 * §3.1's rule, same conclusion).
 *
 * Deliberately a SEPARATE family from the workspace's `fs.*` capabilities. A
 * file in the farm's workspace and a file on a phone are different objects
 * with different lifetimes, and a surface that blurred them would eventually
 * get one deleted in the belief it was the other.
 */

/**
 * `other` is a real answer, not a fallback for a parse failure: a symlink, a
 * socket, a device node and a fifo all genuinely live under `/sdcard` on some
 * builds, and calling one a file would make a client offer to download it.
 */
export const DeviceFsKindSchema = z.enum(['file', 'dir', 'other'])
export type DeviceFsKind = z.infer<typeof DeviceFsKindSchema>

export const DeviceFsEntrySchema = z.object({
  /** The final path segment, as the device reports it — may contain spaces, parentheses, and anything else a filesystem allows. */
  name: z.string(),
  /** The absolute path, so a client never has to join and re-escape one itself. */
  path: z.string(),
  kind: DeviceFsKindSchema,
  /** Null when `stat` could not report one — never a fabricated 0, which would read as an empty file. */
  sizeBytes: z.number().int().nonnegative().nullable(),
  /** Unix **seconds**, the repo-wide convention. Null when unknown. */
  modifiedAt: z.number().int().nonnegative().nullable(),
})
export type DeviceFsEntry = z.infer<typeof DeviceFsEntrySchema>

export const DeviceFsListArgsSchema = z.object({
  /** Absolute directory path. Listing is allowed anywhere the shell can read; only WRITES are confined (see `DEVICE_FS_WRITABLE_ROOTS` in the core). */
  path: z.string().min(1),
  /** Bounded so one call can never exhaust the adb output budget on a directory holding thousands of files. */
  limit: z.number().int().min(1).max(1_000).default(500),
})
export type DeviceFsListArgs = z.infer<typeof DeviceFsListArgsSchema>

export const DeviceFsListResultSchema = z.object({
  /** Directories first, then files, each alphabetical — a file manager's ordering, decided once on the server so every client agrees. */
  entries: z.array(DeviceFsEntrySchema),
  /** True when the directory held more than `limit`. A client showing a count must say so rather than implying the list is complete. */
  truncated: z.boolean(),
})
export type DeviceFsListResult = z.infer<typeof DeviceFsListResultSchema>

export const DeviceFsStatArgsSchema = z.object({ path: z.string().min(1) })
export type DeviceFsStatArgs = z.infer<typeof DeviceFsStatArgsSchema>

/** `entry` is null when nothing exists at the path — "not there" is an answer, not an error. */
export const DeviceFsStatResultSchema = z.object({ entry: DeviceFsEntrySchema.nullable() })
export type DeviceFsStatResult = z.infer<typeof DeviceFsStatResultSchema>

export const DeviceFsMoveArgsSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /**
   * Refuse rather than clobber, by default. A move that silently destroyed the
   * file already at the destination is the kind of data loss a file manager
   * must make someone ask for.
   */
  overwrite: z.boolean().default(false),
})
export type DeviceFsMoveArgs = z.infer<typeof DeviceFsMoveArgsSchema>

export const DeviceFsDeleteArgsSchema = z.object({
  path: z.string().min(1),
  /**
   * Required to delete a directory that is not empty. Never inferred from the
   * path: `rm -r` on the wrong directory is unrecoverable, and the caller
   * saying "yes, recursively" is the only signal worth trusting for it.
   */
  recursive: z.boolean().default(false),
})
export type DeviceFsDeleteArgs = z.infer<typeof DeviceFsDeleteArgsSchema>

export const DeviceFsMkdirArgsSchema = z.object({
  path: z.string().min(1),
  /** `mkdir -p`: create missing parents, and succeed if it already exists. */
  parents: z.boolean().default(true),
})
export type DeviceFsMkdirArgs = z.infer<typeof DeviceFsMkdirArgsSchema>

/** Every mutating op answers the same way — what it did, to what. */
export const DeviceFsOkResultSchema = z.object({ ok: z.literal(true), path: z.string() })
export type DeviceFsOkResult = z.infer<typeof DeviceFsOkResultSchema>
