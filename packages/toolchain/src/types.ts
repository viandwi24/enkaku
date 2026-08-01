import { z } from 'zod'

/** Schema manifest tool — persis spec §7.3 + field operasional `format`. */

export const PlatformKeySchema = z.enum([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
  '*', // platform-independent (jar/apk)
])
export type PlatformKey = z.infer<typeof PlatformKeySchema>

export const ToolArtifactSchema = z.object({
  url: z.string(),
  // Literal 'TODO-verify' diterima saat parse supaya manifest bundled lolos,
  // tapi manager.install() menolak non-hex (E_CHECKSUM_MISSING).
  sha256: z.string().regex(/^([0-9a-f]{64}|TODO-verify)$/),
  sizeBytes: z.number().int().nonnegative(),
})
export type ToolArtifact = z.infer<typeof ToolArtifactSchema>

export const ToolVersionSchema = z.object({
  version: z.string(),
  releasedAt: z.string(),
  /** Semver range core yang cocok (tool coupled, spec §7.6). */
  compatibleCoreRange: z.string().optional(),
  platforms: z.partialRecord(PlatformKeySchema, ToolArtifactSchema),
  knownGood: z.boolean().optional(),
})
export type ToolVersion = z.infer<typeof ToolVersionSchema>

export const ToolManifestEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  /** false → user tak bisa pilih versi via API publik (spec §7.6). */
  swappable: z.boolean(),
  format: z.enum(['zip', 'raw']),
  versions: z.array(ToolVersionSchema),
})
export type ToolManifestEntry = z.infer<typeof ToolManifestEntrySchema>

export const ToolsManifestSchema = z.object({
  manifestVersion: z.literal(1),
  updatedAt: z.string(),
  tools: z.array(ToolManifestEntrySchema),
})
export type ToolsManifest = z.infer<typeof ToolsManifestSchema>

/** Isi tools/<toolId>/active.json. */
export const ActivePointerSchema = z.object({
  version: z.string(),
  sha256: z.string(),
  /** Unix epoch detik. */
  activatedAt: z.number().int(),
})
export type ActivePointer = z.infer<typeof ActivePointerSchema>

export const isRealSha256 = (s: string): boolean => /^[0-9a-f]{64}$/.test(s)

export interface HealthResult {
  ok: boolean
  checkedAt: number
  detail: string
}
