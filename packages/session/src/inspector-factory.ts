import {
  UiautomatorDumpInspector,
  UiServerInspector,
  createUiServerLauncher,
  type UiServerArtifactMismatch,
  type UiServerStatus,
} from '@enkaku/drivers'
import type { AdbStreamHandle, AdbStreamOptions } from '@enkaku/adb'
import type { Inspector, Transport } from '@enkaku/protocol'
import type { ToolchainManager } from '@enkaku/toolchain'
import type { Logger } from './logger'
import type { PortAllocator } from './port-allocator'
import { parseWmSize } from './probe'

export interface InspectorHandle {
  inspector: Inspector
  engineId: string
  /** The waitFor polling interval that suits this engine. */
  pollIntervalMs: number
  release(): Promise<void>
}

export interface InspectorFactoryDeps {
  toolchain: ToolchainManager
  ports: PortAllocator
  log: Logger
  /** adb CLI-level (install) — bukan shell device. */
  hostAdb: (args: string[]) => Promise<string>
  /**
   * `AdbClient.forward`/`listForward`/`killForward` (plan 119 §4.1, §4.2),
   * bound to the host's own client (`daemon.ts`/`hosts.ts`) — the
   * smartsocket-level trio that replaces the `hostAdb(['forward', ...])`
   * CLI-spawn calls the ui-server launcher used before plan 119, for JUST
   * the forward lifecycle. `hostAdb` above still owns install/uninstall,
   * which has no `host:`-protocol equivalent (plan 119 §2).
   */
  forward: (serial: string, local: string, remote: string) => Promise<void>
  listForward: () => Promise<{ serial: string; local: string; remote: string }[]>
  killForward: (serial: string, local: string) => Promise<void>
  /**
   * The Plan 24 streaming lane (plan 34 §4.1) — bound to `AdbClient.execStream`
   * by the host (`daemon.ts`). Used ONLY for the ui-server instrumentation,
   * which must never park a `PerDeviceQueue` slot for as long as the session
   * lives.
   */
  execStream: (serial: string, cmd: string, opts: AdbStreamOptions) => Promise<AdbStreamHandle>
  onStatus?: (deviceId: string, status: UiServerStatus) => void
  onFallback?: (deviceId: string, from: string, to: string, reason: string) => void
  /** A repair attempt still left the on-device artifact mismatched (plan 41 §3.3) — the host records `device.artifact.mismatch`. */
  onArtifactMismatch?: (deviceId: string, info: UiServerArtifactMismatch) => void
}

const DUMP_POLL_MS = 500

/**
 * Picks the inspector engine for one session (plan 06 §3.5).
 * `ui-server` is the default; if it fails to start the session is STILL
 * created with `uiautomator-dump` (a per-session fallback that leaves the DB
 * column untouched).
 */
export async function createInspectorForSession(
  deps: InspectorFactoryDeps,
  opts: { deviceId: string; transport: Transport; requested: string | null },
): Promise<InspectorHandle> {
  const requested = opts.requested ?? 'ui-server'
  const dumpHandle = (): InspectorHandle => ({
    inspector: new UiautomatorDumpInspector(opts.transport, (level, msg) => deps.log[level](msg)),
    engineId: 'uiautomator-dump',
    pollIntervalMs: DUMP_POLL_MS,
    release: async () => {},
  })

  if (requested === 'uiautomator-dump') return dumpHandle()

  let port: number | null = null
  try {
    const apkPaths = async () => ({
      app: await deps.toolchain.resolveToolPath('ui-server'),
      test: await deps.toolchain.resolveToolPath('ui-server-test'),
    })
    // The manifest's on-device expectation for the currently active
    // ui-server build (plan 41 §3.2, §4.1) — `null` (unknown tool, nothing
    // provisioned, or an older manifest with no `deviceArtifact`) is a
    // legitimate "skip the version/signature check" outcome, not an error.
    const expected = await deps.toolchain.deviceArtifactExpectation('ui-server').catch(() => null)
    port = await deps.ports.claim(opts.deviceId)
    const launcher = createUiServerLauncher({
      serial: opts.transport.serial,
      exec: (cmd, execOpts) => opts.transport.exec(cmd, execOpts ?? { profile: 'appLifecycle' }).then((r) => r.stdout),
      hostAdb: deps.hostAdb,
      forward: deps.forward,
      listForward: deps.listForward,
      killForward: deps.killForward,
      apkPaths,
      ...(expected ? { expectedArtifact: { versionCode: expected.versionCode, signatureSha256: expected.signatureSha256 } } : {}),
      onMismatch: (info) => deps.onArtifactMismatch?.(opts.deviceId, info),
      // Both stream clocks OFF (plan 34 §3.2, §4.1, §8 risk row 2): the
      // instrumentation is silent once healthy and must live as long as the
      // session, not the lane's default idle/absolute budgets. Bounded
      // anyway — the handle is stopped in `release()` below, and Plan 24's
      // `stopForDevice` already fires when a device goes away.
      //
      // `onData` is forwarded, not discarded (plan 208 §3.3): the bytes are
      // the `am instrument -w -r` status stream, which `lifecycle.ts`'s line
      // parser reads for the fail-fast verdict. `pinned: true` (plan 208
      // §3.6): this stream now lives for the whole session, so it must not
      // compete with a bursty user for the counted per-device cap of 4.
      execStream: (cmd, streamOpts) =>
        deps.execStream(opts.transport.serial, cmd, {
          onData: streamOpts.onData,
          onEnd: (reason, err) => streamOpts.onEnd(reason, err),
          idleTimeoutMs: 0,
          absoluteTimeoutMs: 0,
          pinned: true,
        }),
      onLog: (level, msg) => deps.log[level](msg),
    })
    const inspector = new UiServerInspector({
      serial: opts.transport.serial,
      localPort: port,
      launcher,
      // The find guard's viewport (plan 60 §3.1, §4.1). Read from the device
      // rather than from `devices.screen_w` so it cannot be stale, and asked
      // for at most once per inspector — `UiServerInspector` caches it, so
      // this is one `wm size` for the life of the session, not one per find.
      // The device's own pixels, not the scrcpy frame size: node bounds are
      // in device pixels, and a downscaled video would tilt every ratio.
      screenSize: async () => {
        const { stdout } = await opts.transport.exec('wm size', { profile: 'probe' })
        const size = parseWmSize(stdout)
        return size ? { width: size.w, height: size.h } : null
      },
      ...(deps.onStatus ? { onStatus: (s) => deps.onStatus?.(opts.deviceId, s) } : {}),
      onLog: (level, msg) => deps.log[level](msg),
    })
    await inspector.start()
    if (inspector.isDead()) throw new Error('the watchdog gave up during start')
    deps.log.debug(`ui-server ready on ${opts.deviceId} in ${inspector.startedInMs()} ms`)

    const claimedPort = port
    return {
      inspector,
      engineId: 'ui-server',
      pollIntervalMs: inspector.recommendedPollIntervalMs,
      release: async () => {
        await inspector.stop().catch(() => undefined)
        deps.ports.release(claimedPort)
      },
    }
  } catch (err) {
    if (port !== null) deps.ports.release(port)
    const reason = err instanceof Error ? err.message : String(err)
    deps.log.warn(`ui-server cannot be used on ${opts.deviceId} (${reason}) — falling back to uiautomator-dump`)
    deps.onFallback?.(opts.deviceId, 'ui-server', 'uiautomator-dump', reason)
    return dumpHandle()
  }
}
