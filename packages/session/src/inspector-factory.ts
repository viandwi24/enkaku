import {
  UiautomatorDumpInspector,
  UiServerInspector,
  UiTreeInspector,
  createUiServerLauncher,
  type GuestAgentClient,
  type UiServerArtifactMismatch,
  type UiServerStatus,
} from '@enkaku/drivers'
import type { AdbStreamHandle, AdbStreamOptions } from '@enkaku/adb'
import type { Inspector, Transport, UiChangedEvent } from '@enkaku/protocol'
import type { ToolchainManager } from '@enkaku/toolchain'
import type { Logger } from './logger'
import type { PortAllocator } from './port-allocator'
import { parseWmSize } from './probe'

/**
 * A live `ui.watch` subscription (plan 222 §4.2, §4.6) — the same shape
 * `packages/core/src/api/guest-agent.ts`'s `GuestAgentUiWatch` returns.
 */
export interface UiTreeWatchHooks {
  onEvent: (event: UiChangedEvent) => void
  onGap: (expected: number, received: number) => void
  onClose: (reason: string) => void
}
export interface UiTreeWatchHandle {
  close(): Promise<void>
}

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
  /**
   * The `ui-tree` rung (plan 222 §3.8). Absent means the rung is skipped
   * entirely and the ladder starts at ui-server — which is exactly what the
   * cloud node does (`packages/node/src/hosts.ts` has no guest-agent session
   * of its own), and what any host without a provisioner does.
   */
  uiTree?: {
    /** The provisioner's PERSISTED row: no adb call (`AgentProvisioner.status`'s own contract). */
    agentStatus: (deviceId: string) => Promise<{ state: string; capabilities: readonly string[] }>
    withClient: <T>(deviceId: string, fn: (client: GuestAgentClient) => Promise<T>) => Promise<T>
    openWatch: (deviceId: string, hooks: UiTreeWatchHooks) => Promise<UiTreeWatchHandle>
  }
}

const DUMP_POLL_MS = 500
/** The `waitFor` interval used ONLY when the ui-tree engine could not open its watch channel (plan 222 §3.5). */
const UI_TREE_POLL_MS = 200
/**
 * How long the ui-tree rung may spend proving itself before the ladder moves
 * on. One persisted read plus one `ui.status()` round trip; a phone whose
 * agent is wedged must not delay the session's inspector by more than this
 * before ui-server is started instead.
 */
export const UI_TREE_PROBE_BUDGET_MS = 3_000

/**
 * `null` when the ui-tree rung can be used on this device; otherwise the
 * operator-facing reason it cannot, verbatim enough to act on. A RESULT, not
 * an exception, for the same reason `GuestAgentVpnConsent` is one: "this phone
 * has not had its accessibility service enabled" is a different event from
 * "this device is broken", and collapsing them would cost the device an engine
 * it could have had.
 */
export async function uiTreeUnavailableReason(deps: InspectorFactoryDeps, deviceId: string): Promise<string | null> {
  if (!deps.uiTree) return 'this host has no guest-agent session (the cloud node path)'
  const uiTree = deps.uiTree
  try {
    const probe = async (): Promise<string | null> => {
      const agent = await uiTree.agentStatus(deviceId)
      if (agent.state !== 'ready') return `the guest agent is ${agent.state} on this device`
      if (!agent.capabilities.includes('ui-tree')) {
        return 'the installed guest agent build does not advertise the ui-tree capability (it predates plan 221)'
      }
      const status = await uiTree.withClient(deviceId, (c) => c.uiStatus())
      if (!status.enabled) {
        return (
          'the guest agent is installed and answering, but its accessibility service is not enabled on this phone. ' +
          'Provisioning writes `enabled_accessibility_services` from adb; when a build refuses that write, open the ' +
          'agent on the phone and press "Open accessibility settings" (plan 221 §4.10)'
        )
      }
      if (!status.connected) return 'the accessibility service is enabled but not bound yet (it usually binds within seconds of a reboot)'
      return null
    }
    return await withTimeout(probe(), UI_TREE_PROBE_BUDGET_MS, `the ui-tree probe did not answer within ${UI_TREE_PROBE_BUDGET_MS}ms`)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Picks the inspector engine for one session (plan 222 §3.8): `ui-tree`, then
 * `ui-server`, then `uiautomator-dump`, evaluated once per session, in that
 * order, and never more than one rung at a time — the ladder itself is what
 * keeps a live `UiAutomation` (a running ui-server, or a `uiautomator dump`)
 * from ever suppressing a connected `UiTreeService`.
 */
/**
 * Devices whose `ui-server` failed to start during this core's lifetime.
 *
 * Every session builds its own inspector, and a phone typically has two open
 * at once — the wall and Device Control. Without this, EVERY new session paid
 * `ui-server`'s crash again: opening Device Control, closing it and opening it
 * once more meant a fresh instrumentation start, a fresh crash, and a fresh
 * fallback, which is exactly the "sometimes it works, sometimes it does not"
 * the owner kept hitting (2026-09-05). The first press of a new window landed
 * on the corpse; the second, after the demote, worked.
 *
 * In memory on purpose, not persisted: a phone that could not run the server
 * five minutes ago may run it after a reboot or an update, and a restart of
 * the core is the cheapest way to say "try again".
 */
const uiServerRefused = new Set<string>()

/** Test seam: module state outlives a test file, and every test here uses the same device id. */
export function forgetUiServerRefusals(): void {
  uiServerRefused.clear()
}

export async function createInspectorForSession(
  deps: InspectorFactoryDeps,
  opts: { deviceId: string; transport: Transport; requested: string | null },
): Promise<InspectorHandle> {
  const requested = opts.requested ?? 'ui-tree'
  const dumpHandle = (): InspectorHandle => ({
    inspector: new UiautomatorDumpInspector(opts.transport, (level, msg) => deps.log[level](msg)),
    engineId: 'uiautomator-dump',
    pollIntervalMs: DUMP_POLL_MS,
    release: async () => {},
  })

  if (requested === 'uiautomator-dump') return dumpHandle()

  // ---- rung 1: ui-tree (plan 222 §3.8) ----
  if (requested === 'ui-tree') {
    const skip = await uiTreeUnavailableReason(deps, opts.deviceId)
    if (skip === null) {
      const uiTree = deps.uiTree!
      const inspector = new UiTreeInspector({
        deviceId: opts.deviceId,
        transport: opts.transport,
        withClient: (fn) => uiTree.withClient(opts.deviceId, fn),
        openWatch: (hooks) => uiTree.openWatch(opts.deviceId, hooks),
        screenSize: async () => {
          const { stdout } = await opts.transport.exec('wm size', { profile: 'probe' })
          const size = parseWmSize(stdout)
          return size ? { width: size.w, height: size.h } : null
        },
        onLog: (level, msg) => deps.log[level](msg),
      })
      return {
        inspector,
        engineId: 'ui-tree',
        pollIntervalMs: UI_TREE_POLL_MS,
        // Nothing to release: no process was started, no port was claimed, no
        // lock was taken. The agent's own session and forwarded port are owned
        // by the guest-agent subsystem and outlive this handle.
        release: async () => {},
      }
    }
    deps.log.warn(`the ui-tree inspector cannot be used on ${opts.deviceId} (${skip}) — falling back to ui-server`)
    deps.onFallback?.(opts.deviceId, 'ui-tree', 'ui-server', skip)
  }

  // ---- rung 2: ui-server ----
  if (uiServerRefused.has(opts.deviceId)) {
    deps.log.info(`ui-server already failed on ${opts.deviceId} this run — going straight to uiautomator-dump`)
    return dumpHandle()
  }
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
    uiServerRefused.add(opts.deviceId)
    return dumpHandle()
  }
}
