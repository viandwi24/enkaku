import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { resolveAndroidSdk, type AndroidSdk } from './sdk'

/**
 * Installing Android SDK packages from Studio, without Enkaku becoming the
 * thing that downloads them.
 *
 * `sdk.ts` states the rule this module works within: "Enkaku never downloads
 * it (a system image is 1.5-3 GB and is covered by the Android SDK Terms)".
 * That is plan 400/401's decision and it still holds here. What runs is the
 * operator's OWN `sdkmanager`, already on their host, with packages they
 * chose and licences they accepted in the interface — Enkaku supplies the
 * button and the progress, never the bytes and never the consent.
 *
 * Two consequences fall out of that, and both are deliberate:
 *
 *  - There is no bootstrap. A host with no `cmdline-tools` cannot install
 *    `cmdline-tools` from here, because doing so would mean Enkaku fetching
 *    an archive from Google — the exact thing the rule forbids. The status
 *    endpoint says so in words, with the one command that fixes it.
 *  - Licences are ACCEPTED BY THE CALLER, per request, never remembered.
 *    `sdkmanager` will otherwise sit forever on a prompt no one can see.
 */

/** What an operator may ask to install. A closed list: this is not a shell. */
export const INSTALLABLE_PACKAGES = ['emulator', 'platform-tools'] as const

/** `system-images;android-<api>;<variant>;<abi>` — assembled here, never accepted as free text. */
export interface SystemImageRequest {
  apiLevel: number
  variant: 'google_apis' | 'google_apis_playstore' | 'default' | 'aosp_atd'
  abi: 'arm64-v8a' | 'x86_64'
}

export interface SdkInstallRequest {
  /**
   * Where the packages land. TWO destinations, never a caller-supplied path.
   *
   * A free-text directory would be an authenticated operator telling the core
   * to write gigabytes anywhere it has permission — in server mode, over the
   * network. There is no third case worth that: `detected` is the SDK the
   * host already has, `managed` is the directory this farm already owns.
   */
  target: 'detected' | 'managed'
  packages: Array<(typeof INSTALLABLE_PACKAGES)[number]>
  systemImage?: SystemImageRequest
  /**
   * The operator's own acceptance of the Android SDK Terms, for THIS request.
   * Never stored, never defaulted: accepting a licence on someone's behalf is
   * a legal act, not a convenience.
   */
  acceptLicenses: boolean
}

export interface SdkInstallDeps {
  dataDir: string
  log: Logger
  /**
   * The `sdkmanager` the Toolchain Manager installed, if any.
   *
   * `cmdline-tools` is a toolchain entry now (sha256-pinned, from Google's
   * own repository, exactly as adb is), so it lands under `<dataDir>/tools/`
   * — NOT inside the operator's SDK, where `resolveAndroidSdk` looks. A
   * resolver that knew only one of the two places would tell an operator who
   * had just installed the tools that they were still missing.
   *
   * Resolves to `null` when the tool is not installed; never throws.
   */
  toolchainSdkmanager?: () => Promise<string | null>
  /** Injected for tests; defaults to a real `Bun.spawn`. */
  spawn?: (cmd: string[], opts: { onLine: (line: string) => void }) => Promise<{ exitCode: number }>
}

/**
 * The `sdkmanager` to run: the SDK's own first, the Toolchain Manager's
 * second.
 *
 * The SDK's own wins because an operator who installed the tools themselves
 * expects those to be the ones used — and because a `sdkmanager` sitting
 * inside the SDK it manages needs no `--sdk_root` argument to be sensible.
 * Ours is the fallback that makes a bare host workable at all.
 */
export async function resolveSdkmanager(sdk: AndroidSdk, fromToolchain?: () => Promise<string | null>): Promise<string | null> {
  const beside = sdk.avdmanager.replace(/avdmanager(\.bat)?$/, (m) => (m.endsWith('.bat') ? 'sdkmanager.bat' : 'sdkmanager'))
  if (await Bun.file(beside).exists().catch(() => false)) return beside
  const managed = await fromToolchain?.().catch(() => null)
  if (managed && (await Bun.file(managed).exists().catch(() => false))) return managed
  return null
}

/** `<dataDir>/android-sdk` — the directory this farm owns, beside `tools/`. */
export function managedSdkRoot(dataDir: string): string {
  return join(dataDir, 'android-sdk')
}

/** The package coordinates a request resolves to, in the order `sdkmanager` will be given them. */
export function packagesFor(req: SdkInstallRequest): string[] {
  const out: string[] = [...req.packages]
  if (req.systemImage) {
    const { apiLevel, variant, abi } = req.systemImage
    out.push(`system-images;android-${apiLevel};${variant};${abi}`)
    // The platform the image belongs to. `avdmanager` refuses an AVD whose
    // platform is absent, and an operator who asked for an image plainly
    // wants to be able to create one.
    out.push(`platforms;android-${apiLevel}`)
  }
  return out
}

async function defaultSpawn(cmd: string[], opts: { onLine: (line: string) => void }): Promise<{ exitCode: number }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' })
  // `sdkmanager` asks "Accept? (y/N)" on stdin for every unaccepted licence.
  // The caller has already said yes in the interface; this is where that
  // answer is delivered, and it is the only thing ever written here.
  proc.stdin.write('y\n'.repeat(64))
  proc.stdin.end()
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) opts.onLine(l.trim())
    }
    if (buf.trim()) opts.onLine(buf.trim())
  }
  await Promise.all([pump(proc.stdout), pump(proc.stderr)])
  return { exitCode: await proc.exited }
}

/**
 * Run the host's own `sdkmanager`. Resolves when it exits; the caller reports
 * progress through `onLine`.
 *
 * Refuses before spawning anything when the licences were not accepted or
 * when there is no `sdkmanager` to run — a refusal that names the missing
 * piece is worth more than a process that hangs on a prompt nobody sees.
 */
export async function installSdkPackages(
  req: SdkInstallRequest,
  deps: SdkInstallDeps,
  onLine: (line: string) => void,
): Promise<{ root: string; packages: string[] }> {
  if (!req.acceptLicenses) {
    throw new EnkakuError('E_SDK_LICENSE_REQUIRED', 'the Android SDK Terms must be accepted before packages can be installed')
  }
  const packages = packagesFor(req)
  if (packages.length === 0) throw new EnkakuError('E_BAD_REQUEST', 'no packages were requested')

  // `sdkmanager` itself is never installed from here — see this module's own
  // doc comment. Resolving the SDK is how we find one.
  let sdk: AndroidSdk
  try {
    sdk = await resolveAndroidSdk()
  } catch (err) {
    throw new EnkakuError(
      'E_SDK_MANAGER_MISSING',
      `no Android SDK command-line tools were found, and Enkaku does not download them (Android SDK Terms). Install them once — Android Studio's SDK Manager, or the cmdline-tools archive — then this button can do the rest. ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  // `avdmanager` and `sdkmanager` are siblings in the same bin directory.
  const sdkmanager = await resolveSdkmanager(sdk, deps.toolchainSdkmanager)
  if (!sdkmanager) {
    throw new EnkakuError(
      'E_SDK_MANAGER_MISSING',
      'no sdkmanager was found — neither inside the SDK nor installed by the Toolchain Manager. Install the command-line tools first (Settings → Virtual devices).',
    )
  }

  const root = req.target === 'managed' ? managedSdkRoot(deps.dataDir) : sdk.root
  const cmd = [sdkmanager, `--sdk_root=${root}`, ...packages]
  deps.log.info(`android-sdk: installing ${packages.join(', ')} into ${root}`)
  onLine(`$ sdkmanager --sdk_root=${root} ${packages.join(' ')}`)

  const spawn = deps.spawn ?? defaultSpawn
  const { exitCode } = await spawn(cmd, { onLine })
  if (exitCode !== 0) {
    throw new EnkakuError('E_SDK_INSTALL_FAILED', `sdkmanager exited with ${exitCode} — see the log above for what it refused`)
  }
  return { root, packages }
}


export interface SdkInventory {
  root: string | null
  source: 'override' | 'env' | 'default' | 'missing'
  emulator: boolean
  sdkmanager: boolean
  avdmanager: boolean
  platforms: string[]
  systemImages: string[]
  remedy: string | null
  managedRoot: string
}

async function listDir(path: string): Promise<string[]> {
  return await readdir(path).catch(() => [])
}

/**
 * What the host actually has — read from disk, never inferred.
 *
 * Studio needs this to say "you are missing the emulator" instead of letting
 * an operator find out from a create that fails two minutes in. Every field
 * is a fact about a file or a directory; nothing here runs a process, so it
 * is cheap enough to poll a settings screen with.
 */
export async function readSdkInventory(dataDir: string, toolchainSdkmanager?: () => Promise<string | null>): Promise<SdkInventory> {
  const managedRoot = managedSdkRoot(dataDir)
  let sdk: AndroidSdk | null = null
  try {
    sdk = await resolveAndroidSdk()
  } catch {
    sdk = null
  }
  if (!sdk) {
    return {
      root: null,
      source: 'missing',
      emulator: false,
      sdkmanager: false,
      avdmanager: false,
      platforms: [],
      systemImages: [],
      remedy:
        'No Android SDK was found. Enkaku does not download it — a system image is 1.5-3 GB and is covered by the Android SDK Terms. Install the command-line tools once (Android Studio’s SDK Manager, or the cmdline-tools archive) and set ANDROID_SDK_ROOT, then everything else can be installed from here.',
      managedRoot,
    }
  }

  const [emulator, sdkmanagerPath, avdmanager] = await Promise.all([
    Bun.file(sdk.emulator).exists().catch(() => false),
    resolveSdkmanager(sdk, toolchainSdkmanager),
    Bun.file(sdk.avdmanager).exists().catch(() => false),
  ])
  const sdkmanager = sdkmanagerPath !== null

  const platforms = (await listDir(join(sdk.root, 'platforms'))).filter((d) => d.startsWith('android-')).sort()
  const images: string[] = []
  for (const api of await listDir(join(sdk.root, 'system-images'))) {
    for (const variant of await listDir(join(sdk.root, 'system-images', api))) {
      for (const abi of await listDir(join(sdk.root, 'system-images', api, variant))) {
        images.push(`system-images;${api};${variant};${abi}`)
      }
    }
  }

  // One remedy, the most blocking first — a screen listing four problems at
  // once teaches nobody what to do next.
  const remedy = !sdkmanager
    ? 'The SDK is here but its command-line tools are not, so nothing can be installed from this screen. Add "Android SDK Command-line Tools" in Android Studio’s SDK Manager.'
    : !emulator
      ? 'The emulator package is missing — install it below.'
      : images.length === 0
        ? 'No system image is installed, so there is nothing for a virtual device to boot. Install one below.'
        : null

  return { root: sdk.root, source: sdk.source, emulator, sdkmanager, avdmanager, platforms, systemImages: images.sort(), remedy, managedRoot }
}
