import { z } from 'zod'

/** The tool manifest schema — exactly spec §7.3 plus an operational `format` field. */

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
  // The literal 'TODO-verify' parses so the bundled manifest validates, but
  // manager.install() rejects anything non-hex (E_CHECKSUM_MISSING).
  sha256: z.string().regex(/^([0-9a-f]{64}|TODO-verify)$/),
  sizeBytes: z.number().int().nonnegative(),
})
export type ToolArtifact = z.infer<typeof ToolArtifactSchema>

/**
 * What plan 41 (§3.2, §4.1) expects to find installed ON THE DEVICE for a
 * device-side artifact (currently only the ui-server APK) — as opposed to
 * `ToolArtifact.sha256` above, which verifies the download. Optional so an
 * older manifest (or a tool with nothing device-side) still loads; where it
 * is absent, the on-device verifier skips the version/signature comparison
 * rather than failing (a missing expectation must never block the inspector).
 */
export const DeviceArtifactSchema = z.object({
  packageName: z.string(),
  versionCode: z.number().int().nonnegative(),
  /** Hex SHA-256 of the signing certificate, uppercase, colon-free. Optional — reading it reliably varies across Android versions (plan 41 §8). */
  signatureSha256: z
    .string()
    .regex(/^[0-9A-F]{64}$/)
    .optional(),
})
export type DeviceArtifact = z.infer<typeof DeviceArtifactSchema>

export const ToolVersionSchema = z.object({
  version: z.string(),
  releasedAt: z.string(),
  /** The core semver range this matches (coupled tools, spec §7.6). */
  compatibleCoreRange: z.string().optional(),
  platforms: z.partialRecord(PlatformKeySchema, ToolArtifactSchema),
  knownGood: z.boolean().optional(),
  deviceArtifact: DeviceArtifactSchema.optional(),
})
export type ToolVersion = z.infer<typeof ToolVersionSchema>

export const ToolManifestEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  /** false → users cannot pick a version through the public API (spec §7.6). */
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

/** The contents of tools/<toolId>/active.json. */
export const ActivePointerSchema = z.object({
  version: z.string(),
  sha256: z.string(),
  /** Unix epoch seconds. */
  activatedAt: z.number().int(),
})
export type ActivePointer = z.infer<typeof ActivePointerSchema>

export const isRealSha256 = (s: string): boolean => /^[0-9a-f]{64}$/.test(s)

export interface HealthResult {
  ok: boolean
  checkedAt: number
  detail: string
}
