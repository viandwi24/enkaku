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
export const INSTALLABLE_PACKAGES = ['emulator', 'platform-tools', 'cmdline-tools'] as const

/**
 * The sdkmanager coordinate each of those maps to.
 *
 * `cmdline-tools` is the one that is not its own name, and it is the one
 * that matters most. `avdmanager` derives the SDK it manages from where the
 * script itself sits — so the Toolchain Manager's copy, living under
 * `<dataDir>/tools/`, runs perfectly and then reports "Package path is not
 * valid. Valid system image paths are: null", because it is looking at a
 * directory with no system images in it (verified on the owner's host,
 * 2026-09-06). Installing `cmdline-tools;latest` INTO the SDK root puts
 * `avdmanager` where it can see the images, and creating a virtual device
 * starts working. Ours stays the bootstrap that makes this install possible
 * on a host that has no sdkmanager at all.
 */
const PACKAGE_COORDINATE: Record<(typeof INSTALLABLE_PACKAGES)[number], string> = {
  emulator: 'emulator',
  'platform-tools': 'platform-tools',
  'cmdline-tools': 'cmdline-tools;latest',
}

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
  spawn?: (cmd: string[], opts: { onLine: (line: string) => void; javaHome?: string | null }) => Promise<{ exitCode: number }>
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

/**
 * A Java runtime for `sdkmanager`, which is a Java program and says so only
 * after you have already pressed the button.
 *
 * `JAVA_HOME` first, then the places a JDK actually sits on a developer's
 * machine when it is NOT on `PATH` — which is the common case on macOS, where
 * `/usr/bin/java` is a stub that exists solely to tell you there is no Java.
 * The owner's own machine had OpenJDK 17 installed by Homebrew and unlinked,
 * so `command -v java` succeeded, `java -version` failed, and the install got
 * as far as spawning before anything noticed (2026-09-06).
 *
 * Finding it is worth more than reporting it: a button that works beats a
 * button that explains why it cannot.
 */
export async function resolveJavaHome(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const candidates: string[] = []
  const fromEnv = env.JAVA_HOME?.trim()
  if (fromEnv) candidates.push(fromEnv)

  if (process.platform === 'darwin') {
    // The system helper answers with the JDK macOS itself would pick — and
    // exits non-zero, loudly, when there is none.
    const helper = Bun.spawnSync(['/usr/libexec/java_home'], { stdout: 'pipe', stderr: 'pipe' })
    const out = helper.stdout.toString().trim()
    if (helper.exitCode === 0 && out) candidates.push(out)
    for (const brew of ['/opt/homebrew/opt/openjdk@17', '/opt/homebrew/opt/openjdk@21', '/opt/homebrew/opt/openjdk', '/usr/local/opt/openjdk@17', '/usr/local/opt/openjdk']) {
      candidates.push(join(brew, 'libexec/openjdk.jdk/Contents/Home'), brew)
    }
  }
  for (const dir of ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines']) {
    for (const entry of await listDir(dir)) {
      candidates.push(join(dir, entry, 'Contents', 'Home'), join(dir, entry))
    }
  }

  for (const home of candidates) {
    if (await Bun.file(join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')).exists().catch(() => false)) return home
  }
  return null
}

/** `<dataDir>/android-sdk` — the directory this farm owns, beside `tools/`. */
export function managedSdkRoot(dataDir: string): string {
  return join(dataDir, 'android-sdk')
}

/** The package coordinates a request resolves to, in the order `sdkmanager` will be given them. */
export function packagesFor(req: SdkInstallRequest): string[] {
  const out: string[] = req.packages.map((p) => PACKAGE_COORDINATE[p])
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

/**
 * Append a line to an install log, collapsing the progress bar in place.
 *
 * With CR splitting on, `sdkmanager` emits a redraw several times a second —
 * thousands of `[====   ] 41% Downloading ...` lines for one package. Kept as
 * history that is not progress, it is a flood that pushes every real line out
 * of the buffer. Kept as the LAST line, rewritten, it is exactly the progress
 * bar the operator would have seen in a terminal.
 */
const PROGRESS_BAR = /^\[[=\s]*\]\s*\d+%/

export function appendInstallLine(lines: string[], line: string): void {
  const isProgress = PROGRESS_BAR.test(line)
  const lastIsProgress = lines.length > 0 && PROGRESS_BAR.test(lines[lines.length - 1] ?? '')
  if (isProgress && lastIsProgress) lines[lines.length - 1] = line
  else lines.push(line)
}

async function defaultSpawn(cmd: string[], opts: { onLine: (line: string) => void; javaHome?: string | null }): Promise<{ exitCode: number }> {
  // `JAVA_HOME` is passed rather than relied on: the JDK is frequently
  // installed and not on `PATH` (Homebrew leaves it unlinked by default), and
  // the core's own environment is whatever started it — often a launchd
  // session with a minimal PATH that has never seen a shell profile.
  const env = opts.javaHome
    ? { ...process.env, JAVA_HOME: opts.javaHome, PATH: `${join(opts.javaHome, 'bin')}:${process.env.PATH ?? ''}` }
    : process.env
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe', env })
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
      // Split on CR as well as LF. `sdkmanager` draws its progress bar by
      // rewriting one line with a carriage return and never emits a newline
      // until the package is finished — so a pump that splits on `\n` alone
      // reports the two-line deprecation warning and then goes utterly
      // silent for the twenty minutes a 2 GB system image takes. Verified on
      // the owner's host, 2026-09-06: 45 carriage returns in the first 4 KB
      // and not one newline among them.
      const lines = buf.split(/\r\n|\r|\n/)
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
    sdk = await resolveAndroidSdk({ ...(deps.toolchainSdkmanager ? { toolchainSdkmanager: deps.toolchainSdkmanager } : {}), managedRoot: managedSdkRoot(deps.dataDir) })
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

  const javaHome = await resolveJavaHome()
  if (!javaHome) {
    throw new EnkakuError(
      'E_JAVA_MISSING',
      'sdkmanager is a Java program and no Java runtime was found. Install a JDK (17 or newer) on the machine running the core — on macOS, `brew install openjdk@17`.',
    )
  }
  onLine(`java: ${javaHome}`)
  const spawn = deps.spawn ?? defaultSpawn
  const { exitCode } = await spawn(cmd, { onLine, javaHome })
  if (exitCode !== 0) {
    throw new EnkakuError('E_SDK_INSTALL_FAILED', `sdkmanager exited with ${exitCode} — see the log above for what it refused`)
  }
  return { root, packages }
}


export interface SdkInventory {
  root: string | null
  /** The JDK `sdkmanager` will be run with, or null when the host has none. */
  javaHome: string | null
  source: 'override' | 'env' | 'default' | 'managed' | 'missing'
  emulator: boolean
  sdkmanager: boolean
  avdmanager: boolean
  platforms: string[]
  systemImages: string[]
  remedy: string | null
  managedRoot: string
  /**
   * Whether `managedRoot` actually holds packages.
   *
   * Studio offers this directory as an install destination, and the status
   * block above it reports the RESOLVED root, which is usually a different
   * one. An operator who picked "managed", waited out two gigabytes and then
   * watched every line of the status stay exactly the same was not looking
   * at a bug in the install — they were looking at the wrong directory, with
   * nothing on screen to tell them so (owner, 2026-09-06).
   */
  managedRootInstalled: boolean
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
    // The same two extras every other resolver in this file already had:
    // `avdmanager` may be the Toolchain Manager's, and the managed root is a
    // real place packages land.
    sdk = await resolveAndroidSdk({ ...(toolchainSdkmanager ? { toolchainSdkmanager } : {}), managedRoot })
  } catch {
    sdk = null
  }
  if (!sdk) {
    return {
      root: null,
      javaHome: await resolveJavaHome(),
      source: 'missing',
      emulator: false,
      sdkmanager: false,
      avdmanager: false,
      platforms: [],
      systemImages: [],
      remedy:
        'No Android SDK was found. Enkaku does not download it — a system image is 1.5-3 GB and is covered by the Android SDK Terms. Install the command-line tools once (Android Studio’s SDK Manager, or the cmdline-tools archive) and set ANDROID_SDK_ROOT, then everything else can be installed from here.',
      managedRoot,
      managedRootInstalled: (await listDir(managedRoot)).length > 0,
    }
  }

  const [emulator, sdkmanagerPath, avdmanagerExists] = await Promise.all([
    Bun.file(sdk.emulator).exists().catch(() => false),
    resolveSdkmanager(sdk, toolchainSdkmanager),
    Bun.file(sdk.avdmanager).exists().catch(() => false),
  ])
  const sdkmanager = sdkmanagerPath !== null
  /*
    `avdmanager` reports whether a device can actually be CREATED, which is
    not the same as whether the binary exists.

    It derives the SDK it manages from its own location, so the Toolchain
    Manager's copy under `<dataDir>/tools/` runs and then finds no system
    images at all — "Package path is not valid. Valid system image paths are:
    null". Reporting that as installed would put a green line on the screen
    above a create that cannot work. Only a copy inside the SDK root counts;
    the remedy below says how to get one, and the Install button can do it.
  */
  const avdmanager = avdmanagerExists && sdk.avdmanager.startsWith(sdk.root)

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
  const javaHome = await resolveJavaHome()
  const remedy = !sdkmanager
    ? 'The SDK is here but its command-line tools are not — install them below; Enkaku fetches that one package itself, verified against a pinned checksum.'
    : !avdmanager
      ? 'The SDK has no avdmanager of its own, and a copy from anywhere else cannot see this SDK’s system images. Install the command-line tools into it below — one package, about 150 MB.'
    : !javaHome
      ? 'No Java runtime was found, and sdkmanager is a Java program. Install a JDK (17 or newer) — on macOS, `brew install openjdk@17`.'
    : !emulator
      ? 'The emulator package is missing — install it below.'
      : images.length === 0
        ? 'No system image is installed, so there is nothing for a virtual device to boot. Install one below.'
        : null

  const managedRootInstalled = sdk.root !== managedRoot && (await listDir(managedRoot)).length > 0
  return { root: sdk.root, javaHome, source: sdk.source, emulator, sdkmanager, avdmanager, platforms, systemImages: images.sort(), remedy, managedRoot, managedRootInstalled }
}
