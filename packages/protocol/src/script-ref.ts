import { z } from 'zod'

/**
 * `name@version`, where version is a semver or the literal `latest` (plan 62
 * §4.1). Declared here, not in core, so core, the SDK, Studio, and (from plan
 * 63) the capability registry all trust the same shape — the same reasoning
 * that put `TagSchema` in this package rather than duplicated per consumer.
 *
 * `name` may carry ONE `/` (plan 82 §4.2) — a plugin member's name is
 * `<plugin>/<script>` (`tiktok/login`), written that way in the `scripts`
 * table so this schema, `parseScriptRef`, and `resolveScriptRef` all work on
 * a plugin's scripts completely unmodified: there is exactly one name shape.
 * The slash is optional only because a workflow's name carries none (plan 110
 * §3.3), as do rows published before a script had to belong to a plugin.
 */
export const ScriptRefSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?@(?:latest|\d+\.\d+\.\d+(?:[-+].+)?)$/)
export type ScriptRef = z.infer<typeof ScriptRefSchema>

/** Split an already-validated reference into its name and version parts. */
export function parseScriptRef(ref: ScriptRef): { name: string; version: string | 'latest' } {
  const at = ref.indexOf('@')
  return { name: ref.slice(0, at), version: ref.slice(at + 1) }
}

interface ParsedSemver {
  major: number
  minor: number
  patch: number
  /** Dot-separated identifiers after the `-`; empty means no prerelease. Build metadata (`+...`) is discarded before this point. */
  prerelease: string[]
}

/**
 * Parses the shapes `routes.ts`'s regex already admits: `X.Y.Z`,
 * `X.Y.Z-pre.release`, `X.Y.Z+build`, `X.Y.Z-pre.release+build`. Build
 * metadata is dropped immediately — it plays no part in ordering (semver.org
 * §10), which is why `+build1` and `+build2` of the same version compare equal.
 */
function parseSemver(version: string): ParsedSemver {
  const withoutBuild = version.split('+')[0] ?? version
  const dashIdx = withoutBuild.indexOf('-')
  const core = dashIdx === -1 ? withoutBuild : withoutBuild.slice(0, dashIdx)
  const preStr = dashIdx === -1 ? '' : withoutBuild.slice(dashIdx + 1)
  const [majorStr, minorStr, patchStr] = core.split('.')
  return {
    major: Number(majorStr),
    minor: Number(minorStr),
    patch: Number(patchStr),
    prerelease: preStr === '' ? [] : preStr.split('.'),
  }
}

/** True when `version` carries a prerelease identifier (`1.0.0-beta.1`), false for a plain release. */
export function isPrereleaseVersion(version: string): boolean {
  return parseSemver(version).prerelease.length > 0
}

/**
 * Semver precedence for one dot-separated prerelease identifier (semver.org
 * §11.4.4): numeric identifiers compare numerically and always sort below
 * alphanumeric ones; alphanumeric identifiers compare as ASCII strings.
 */
function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Numeric semver comparison, written by hand rather than pulled in as a
 * dependency (plan 62 §4.2) — negative when `a < b`, positive when `a > b`,
 * zero when equal in precedence. Guards the two traps a naive implementation
 * hits:
 *
 * - `1.0.10` vs `1.0.9`: each component compares as a number, never as a
 *   string, so `10 > 9` the way it should — a string sort would put `1.0.10`
 *   before `1.0.9`.
 * - `1.0.0` vs `1.0.0-beta`: a version WITHOUT a prerelease outranks one
 *   WITH — a prerelease is always lower precedence than its own release
 *   (semver.org §11.3).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch

  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1 // a is a plain release, b is a prerelease of it
  if (pb.prerelease.length === 0) return -1

  const len = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < len; i++) {
    const ai = pa.prerelease[i]
    const bi = pb.prerelease[i]
    // A set of prerelease fields runs out first has lower precedence, once
    // every preceding identifier tied (semver.org §11.4.4 final clause).
    if (ai === undefined) return -1
    if (bi === undefined) return 1
    const c = comparePrereleaseIdentifier(ai, bi)
    if (c !== 0) return c
  }
  return 0
}
