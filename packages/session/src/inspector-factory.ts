import {
  UiautomatorDumpInspector,
  UiServerInspector,
  createUiServerLauncher,
  type UiServerStatus,
} from '@enkaku/drivers'
import type { Inspector, Transport } from '@enkaku/protocol'
import type { ToolchainManager } from '@enkaku/toolchain'
import type { Logger } from './logger'
import type { PortAllocator } from './port-allocator'

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
  /** adb CLI-level (install/forward) — bukan shell device. */
  hostAdb: (args: string[]) => Promise<string>
  onStatus?: (deviceId: string, status: UiServerStatus) => void
  onFallback?: (deviceId: string, from: string, to: string, reason: string) => void
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
    port = await deps.ports.claim(opts.deviceId)
    const launcher = createUiServerLauncher({
      serial: opts.transport.serial,
      exec: (cmd) => opts.transport.exec(cmd, { profile: 'appLifecycle' }),
      hostAdb: deps.hostAdb,
      apkPaths,
      onLog: (level, msg) => deps.log[level](msg),
    })
    const inspector = new UiServerInspector({
      serial: opts.transport.serial,
      localPort: port,
      launcher,
      ...(deps.onStatus ? { onStatus: (s) => deps.onStatus?.(opts.deviceId, s) } : {}),
      onLog: (level, msg) => deps.log[level](msg),
    })
    await inspector.start()
    if (inspector.isDead()) throw new Error('the watchdog gave up during start')

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
