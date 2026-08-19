import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { downloadVerified, extractZip, moveFile } from '@enkaku/toolchain'
import { ProxyError } from './errors'

/**
 * The one workaround this file exists for: `net.connect({ localAddress })`
 * (and `tls.connect`, and `Bun.connect`) silently ignores the option on
 * Windows under Bun. Measured on the owner's own farm host, 2026-08-19: a
 * record's `bindAddress` was correct, the router's own routing rule was correct, a raw
 * `curl.exe --interface` and a raw `.NET Socket.Bind` both egressed through
 * the intended link — only the Bun-built bridge kept leaving through the
 * default one. This is a tracked, currently-unresolved
 * upstream limitation (oven-sh/bun#6888, #11570, #23486; a fix landed as
 * oven-sh/bun#23464 on 2025-10-12 and was reverted three days later), not a
 * bug in this pack's own `dial-direct.ts` — that file's logic is correct and
 * is exactly what runs, unchanged, on macOS and Linux, where the option is
 * honoured.
 *
 * `gost` (https://github.com/go-gost/gost, MIT, written in Go) does not carry
 * this limitation — Go's own `net.Dialer.LocalAddr` performs a real `bind()`
 * on Windows, which is what a raw `.NET Socket.Bind` already proved works on
 * this exact host. So on Windows only, a `direct` record with a non-empty
 * `bindAddress` is served by a small local `gost` instance instead of Bun's
 * own socket call: `gost-runtime.ts` spawns it, and `upstream.ts` talks to it
 * over loopback (127.0.0.1, unaffected by the bug — it is only ever asked to
 * bind to a NON-default address) using the same `dial-http.ts` this pack
 * already uses for a vendor HTTP upstream.
 *
 * ## Why this file owns the download, and Core's own Toolchain Manager does not
 *
 * The owner's own words: gost is *"yang manage… plugin proxy manager ini
 * sendiri"* — deliberately, not `packages/core/src/tools/`'s central
 * registry. gost exists to work around a bug in THIS pack's own feature, on
 * ONE platform; it is not a farm-wide tool every install needs the way `adb`
 * is. Wiring it into Core's manifest (`packages/toolchain/src/manifest/
 * enkaku-tools.json`) would make Core's own release surface carry a
 * plugin-specific implementation detail, and every user of this farm would
 * see it on the Tools page whether or not they use `direct` records on
 * Windows at all.
 *
 * What IS reused is `@enkaku/toolchain`'s three *primitives* —
 * `downloadVerified`, `extractZip`, `moveFile` — because they are already
 * correct for exactly this job (streamed sha256-as-you-download, a zip
 * extractor that rejects path traversal, and a move that survives a Windows
 * antivirus holding a lock on the file this pack just wrote) and rewriting
 * them here would be the weaker parallel path 00-overview §4.3 forbids. What
 * is NOT reused is `ManifestStore`/`ToolchainManager` — those own the
 * *central* registry (what tools exist, which version is active, the Tools
 * page), and none of that is this pack's to extend.
 */

/** Pinned deliberately, not "latest" — the sha256 below is only true for this exact build. Bump both together, by hand, after a fresh download+extract+run rehearsal. */
const GOST_VERSION = '3.2.6'

/**
 * The one artifact this file ever fetches. Windows is the only platform this
 * workaround exists for (§ above) — macOS and Linux never reach this module.
 *
 * `sha256` and `sizeBytes` were read off the real release asset on
 * 2026-08-19, not copied from `checksums.txt` blind: this exact file was
 * downloaded, its sha256 computed locally, and the two compared equal, then
 * the archive was extracted and `gost.exe` was run to confirm it is what it
 * claims to be.
 */
const GOST_WINDOWS_ARTIFACT = {
  url: `https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/gost_${GOST_VERSION}_windows_amd64.zip`,
  sha256: '32f4edf3d94b622e67f1979f6f5de82dac62abc0977772cf96215dd199ef7e7b',
  sizeBytes: 9280802,
}

/**
 * `<app-data>/plugins/proxy-manager/gost/` — a subdirectory of the SAME root
 * Core computes (`packages/core/src/util/paths.ts`'s `resolveDataDir`),
 * duplicated here rather than imported: a plugin cannot reach into Core's
 * `src/`, and this function is small, pure, and has no dependency of its own
 * worth a cross-package import for. `ENKAKU_DATA_DIR` is honoured for the
 * same reason it is in Core — a dev/test run must not touch a real machine's
 * app-data folder.
 */
function pluginDataDir(): string {
  const override = process.env.ENKAKU_DATA_DIR
  let root: string
  if (override && override.length > 0) {
    root = override
  } else if (process.platform === 'win32') {
    root = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Enkaku')
  } else {
    // Unreachable in practice — this module is only ever called on win32 —
    // kept correct anyway rather than throwing, so a stray call from a test
    // or a future refactor fails on a real path, not a thrown assumption.
    root = join(homedir(), '.local', 'share', 'enkaku')
  }
  const dir = join(root, 'plugins', 'proxy-manager', 'gost')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Where a provisioned `gost.exe` ends up, and the one path every other file in this pack that needs the binary should ask for. */
export function gostBinaryPath(): string {
  return join(pluginDataDir(), `gost-${GOST_VERSION}.exe`)
}

/**
 * Idempotent: a binary already at the pinned path is trusted without being
 * re-verified on every call (re-hashing a 9 MB file on every record start
 * would be real, pointless work) — it was verified once, on the way in, and
 * the path is versioned (`gost-3.2.6.exe`) so a version bump can never be
 * mistaken for the file this pack already checked.
 *
 * Download → verify → extract happen in a per-call temp subdirectory under
 * the same plugin data root, so a crash mid-provision never leaves a
 * half-written file at the canonical path for the next call to trust.
 */
export async function ensureGostBinary(log: { info(msg: string, fields?: Record<string, unknown>): void }): Promise<string> {
  const dest = gostBinaryPath()
  if (existsSync(dest)) return dest

  if (process.platform !== 'win32') {
    // Belt to the braces already in `upstream.ts`'s dispatch (§ above): this
    // function is never called on a platform where the bug this file exists
    // for does not apply. A stray call fails loudly rather than downloading
    // a Windows .exe nothing on this host can run.
    throw new ProxyError('E_PROXY_GOST_UNSUPPORTED_PLATFORM', `gost provisioning was reached on ${process.platform} — this workaround exists for Windows only`)
  }

  const dataDir = pluginDataDir()
  const staging = join(dataDir, `.staging-${Date.now()}`)
  mkdirSync(staging, { recursive: true })
  const zipPath = join(staging, 'gost.zip')

  log.info('provisioning gost — downloading', { subject: 'gost', version: GOST_VERSION, url: GOST_WINDOWS_ARTIFACT.url })
  await downloadVerified({ artifact: GOST_WINDOWS_ARTIFACT, dest: zipPath, toolId: 'gost', version: GOST_VERSION })

  log.info('provisioning gost — extracting', { subject: 'gost', version: GOST_VERSION })
  await extractZip(zipPath, staging)

  const extracted = join(staging, 'gost.exe')
  if (!existsSync(extracted)) {
    throw new ProxyError('E_PROXY_GOST_ARCHIVE_UNEXPECTED', `gost_${GOST_VERSION}_windows_amd64.zip did not contain gost.exe at its root — the release layout may have changed`)
  }
  await moveFile(extracted, dest)
  log.info('provisioning gost — ready', { subject: 'gost', version: GOST_VERSION, path: dest })
  return dest
}
