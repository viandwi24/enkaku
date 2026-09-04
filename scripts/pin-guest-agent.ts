/**
 * Pins a freshly built guest-agent release into the toolchain manifest (plan 221 §4.12, closing
 * plan 43 §5.11 and MVP 09 §4's first bullet).
 *
 * The release workflow already knows every value this needs — the sha256 and versionCode of the
 * APK it just built and signed — so this is the "write the pin" half MVP 09 §4 left open, not a
 * build step. It rewrites EXACTLY five fields on `tools[].id === 'guest-agent'`'s `versions[0]`:
 * `version`, `platforms['*'].url`, `platforms['*'].sha256`, `platforms['*'].sizeBytes`, and
 * `deviceArtifact.versionCode`. It also replaces a literal `"compatibleCoreRange": "TODO-M55"`
 * sentinel with `">=<version>"` — but never touches `deviceArtifact.signatureSha256` (§9 Q1 owns
 * that field; only the owner knows which keystore actually signed a given release).
 *
 * Usage:
 *   bun run scripts/pin-guest-agent.ts --version <x.y.z> --version-code <int> --sha256 <hex> --size <bytes> --url <url>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MANIFEST_PATH = join(import.meta.dir, '..', 'packages', 'toolchain', 'manifest', 'enkaku-tools.json')

export interface PinGuestAgentArgs {
  version: string
  versionCode: number
  sha256: string
  sizeBytes: number
  url: string
}

export class PinGuestAgentError extends Error {}

function parseArgs(argv: string[]): PinGuestAgentArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }
  const version = get('--version')
  const versionCodeRaw = get('--version-code')
  const sha256 = get('--sha256')
  const sizeBytesRaw = get('--size')
  const url = get('--url')
  if (!version || !versionCodeRaw || !sha256 || !sizeBytesRaw || !url) {
    throw new PinGuestAgentError(
      'usage: bun run scripts/pin-guest-agent.ts --version <x.y.z> --version-code <int> --sha256 <hex> --size <bytes> --url <url>',
    )
  }
  const versionCode = Number.parseInt(versionCodeRaw, 10)
  const sizeBytes = Number.parseInt(sizeBytesRaw, 10)
  return { version, versionCode, sha256, sizeBytes, url }
}

interface ManifestTool {
  id: string
  versions: Array<{
    version: string
    compatibleCoreRange?: string
    deviceArtifact?: { versionCode?: number; signatureSha256?: string; [k: string]: unknown }
    platforms: { [platform: string]: { url: string; sha256: string; sizeBytes: number } }
    [k: string]: unknown
  }>
  [k: string]: unknown
}

interface Manifest {
  tools: ManifestTool[]
  [k: string]: unknown
}

/**
 * Rewrites the manifest object in place and returns it — pure enough to unit test without
 * touching disk, per plan 200 §8.3 (the toolchain-verification critical list).
 */
export function pinGuestAgent(manifest: Manifest, args: PinGuestAgentArgs): Manifest {
  if (!/^[0-9a-f]{64}$/i.test(args.sha256)) {
    throw new PinGuestAgentError(`--sha256 must be 64 hex characters, got ${JSON.stringify(args.sha256)}`)
  }
  if (!Number.isInteger(args.versionCode) || args.versionCode <= 0) {
    throw new PinGuestAgentError(`--version-code must be a positive integer, got ${JSON.stringify(args.versionCode)}`)
  }
  const tool = manifest.tools.find((t) => t.id === 'guest-agent')
  if (!tool) throw new PinGuestAgentError("no tool with id 'guest-agent' in the manifest")
  const entry = tool.versions[0]
  if (!entry) throw new PinGuestAgentError("tool 'guest-agent' has no versions[0] entry")
  const platform = entry.platforms['*']
  if (!platform) throw new PinGuestAgentError("tool 'guest-agent' versions[0] has no platforms['*'] entry")

  entry.version = args.version
  platform.url = args.url
  platform.sha256 = args.sha256
  platform.sizeBytes = args.sizeBytes
  if (entry.deviceArtifact) entry.deviceArtifact.versionCode = args.versionCode
  if (entry.compatibleCoreRange === 'TODO-M55') entry.compatibleCoreRange = `>=${args.version}`

  return manifest
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const raw = readFileSync(MANIFEST_PATH, 'utf8')
  const manifest = JSON.parse(raw) as Manifest
  pinGuestAgent(manifest, args)
  // Two-space indent, trailing newline — the diff this produces is the five lines it changed and
  // nothing more, not a whole-file reformat.
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`pinned guest-agent ${args.version} (versionCode ${args.versionCode}, sha256 ${args.sha256})`)
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
