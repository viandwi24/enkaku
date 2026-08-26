import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { AdbClient } from '@enkaku/adb'
import type { DisplaySource, InputSink, RecordingSettings, ServerMessage, Transport } from '@enkaku/protocol'
import { createInputArbiter, createSessionManager, type DeviceSession, type DeviceSnapshot, type DeviceSnapshotSource, type Logger, type SessionManager } from '@enkaku/session'
import { createBlobStore } from './agent/blob/store'
import { createBatchDispatchDeps, type BatchDispatchHostDeps } from './api/batches'
import { createPluginRoutes } from './api/plugins'
import type { AuditLogger } from './auth/audit'
import { createAdbServerVersionAccessor } from './daemon'
import { openDb, runMigrations, type Db } from './db'
import { devices } from './db/schema'
import { createDeviceStateMachine } from './device/state-machine'
import { ExecutorRegistry } from './jobs/executor'
import type { KvStore } from './kv/store'
import type { PluginRuntime } from './plugins/runtime'
import type { ScriptRegistry } from './scripts/registry'
import type { JobService } from './services/job-service'
import type { WorkspaceStore } from './workspace/store'
import { createJobStore } from './queue/job-store'
import { createLeaseManager } from './lease/lease-manager'
import { createLogger } from './util/logger'
import { createRecordingService } from './recording/service'
import { createWsMessageHandler, type WsHandlerDeps } from './server/ws-handlers'

/**
 * `daemon.ts` is the core's boot function — a few thousand lines of
 * imperative wiring with no exported entry point a unit test can drive in
 * isolation (it opens real adb, real sockets, real timers). The defects this
 * file guards against are not "the mechanism is wrong" — each one is already
 * proven correct, deeply, in its own module's tests
 * (`registry/device-registry.test.ts`'s "DeviceRegistry — networks" block,
 * `api/clusters.test.ts`'s "connection.medium" block, `api/guest-agent.test.ts`'s
 * `guestAgentSettings` seam, and `session/session.test.ts`'s "createSession —
 * text-input keyboard" block, which proves `createSession` reaches rung 1
 * whenever it IS handed a `withGuestAgentClient`) — they are "the one
 * production call site never passed the accessor", exactly the class of bug
 * `docs/plans/96-m61-hotfixes.md` §96.5 records and plan 90's brief names as
 * "the exact defect class this repo has hit five times" (this file's own
 * `createSessionManager` case, below, made it six: `SessionManagerDeps`
 * declared `withGuestAgentClient?` and `manager.ts` forwarded it correctly
 * whenever present, but `daemon.ts` — the ONE caller that builds a real
 * `SessionManager` — never passed it, so `agentCapabilities` read `null` on
 * every session in every wired build and rung 1 of the text ladder was
 * unreachable regardless of how correct `resolveTextRoute` itself was).
 *
 * This is the same style `tools/adb-server-control.test.ts` already uses for
 * an identical problem (a rule about ONE production file's actual text, not
 * about a mechanism): read the real file, assert the real wiring is there.
 * A future edit that moves or renames these calls should update this test,
 * not silently pass one with the accessor quietly dropped again.
 */

const daemonSource = readFileSync(join(import.meta.dir, 'daemon.ts'), 'utf8')

/**
 * Extracts a balanced-brace region starting at `marker`, where `marker`
 * itself ends in the region's own opening `{` — most often `name({ ... })`,
 * the object literal passed to one specific `createXxx(...)` call, but
 * equally an arrow function's body (`(...) => { ... }`) when the marker is
 * the function's own declaration line ending in `=> {`: the brace-counting
 * loop below does not care which shape produced the opening brace, only
 * that `{`/`}` are balanced from there on. Used this second way by the
 * `attachWsRouter` tests below (plan 93 step 93.6 Task B) so they no longer
 * guess a fixed character window for "how far into the function is far
 * enough" — a guess that four separate workers had to widen in a single day
 * (6900→7300, 7200→7500) every time an unrelated edit landed ahead of the
 * line they were checking for.
 */
function extractCall(source: string, marker: string): string {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`daemon.ts no longer contains ${JSON.stringify(marker)} — this test needs updating alongside that change`)
  const openBrace = start + marker.length - 1 // marker ends in the region's own opening '{'
  expect(source[openBrace]).toBe('{')
  let depth = 0
  let i = openBrace
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return source.slice(openBrace, i + 1)
}

describe('daemon.ts wiring (plan 90 §5 Task B, docs/plans/96-m61-hotfixes.md §96.5)', () => {
  test('createDeviceRegistry(...) passes a live `networks` accessor — without it, device.added badges every device TCP', () => {
    const call = extractCall(daemonSource, 'createDeviceRegistry({')
    expect(call).toContain('networks:')
    expect(call).toContain('settingsStore.get().discovery.networks')
  })

  test('createClusterRoutes(...) passes `networks` AND `declaredMedia` — without them, a cluster device list can disagree with GET /api/devices on the same row', () => {
    const call = extractCall(daemonSource, 'createClusterRoutes({')
    expect(call).toContain('networks:')
    expect(call).toContain('declaredMedia:')
    expect(call).toContain('settingsStore.get().discovery.networks')
    expect(call).toContain('loadDeclaredMedia(endpoints)')
  })

  test('createGuestAgentRoutes(...) passes a live `guestAgentSettings` accessor — without it, maxRecoveryCyclesPerHour/recoveryRearmSec are correct but unconfigurable from Studio', () => {
    const call = extractCall(daemonSource, 'createGuestAgentRoutes({')
    expect(call).toContain('guestAgentSettings:')
    expect(call).toContain('settingsStore.get().guestAgent')
  })

  test('createGuestAgentRoutes(...)\'s agentProvisioner dep passes live `status` and `remove` accessors — without them, GET stays on the pre-plan-90 live probe and DELETE never clears the persisted row (docs/plans/96-m61-hotfixes.md Gap 2 fix)', () => {
    const call = extractCall(daemonSource, 'createGuestAgentRoutes({')
    expect(call).toContain('status: (deviceId) => agentProvisionerRef?.status(deviceId)')
    expect(call).toContain('remove: (deviceId, actor) => agentProvisionerRef?.remove(deviceId, actor)')
  })

  test('the agent provisioner is built and swept at boot, beside guestAgent.reconcileNetworkRoutes()', () => {
    expect(daemonSource).toContain('createAgentProvisioner(')
    expect(daemonSource).toContain('.ensureAll()')
    expect(daemonSource).toContain('agentProvisionerRef = agentProvisioner')
  })

  test('the agent provisioner is wired into onDeviceReady — the reconnect/admission hook restoreNetworkRoute already uses', () => {
    const onReadyBlock = extractCall(daemonSource, 'onDeviceReady: (deviceId) => {')
    expect(onReadyBlock).toContain('agentProvisionerRef?.ensure(deviceId)')
  })

  test('the labelling service is built with a live withGuestAgentClient accessor and wired into onDeviceReady (plan 89 §3.7, §4.6, step 89.6) — without either, a labelled fleet never reconciles on reconnect', () => {
    const call = extractCall(daemonSource, 'createLabellingService({')
    expect(call).toContain('withGuestAgentClient: guestAgent.withGuestAgentClient')
    expect(call).toContain('maxConcurrent:')
    expect(daemonSource).toContain('labellingRef = labelling')

    const onReadyBlock = extractCall(daemonSource, 'onDeviceReady: (deviceId) => {')
    expect(onReadyBlock).toContain('labellingRef?.reconcile(deviceId)')
  })

  test('createDeviceRoutes(...) is wired to the live labelling service — without it, the five HTTP label endpoints refuse E_NOT_SUPPORTED forever, even on a farm that fully wired step 89.6 (plan 89 §4.3, §5 step 89.4\'s own noted gap)', () => {
    const call = extractCall(daemonSource, 'deviceRoutes: createDeviceRoutes({')
    expect(call).toContain('labelling,')
  })

  test('createDeviceLifecycle(...) is wired to clear a device\'s physical label before removal, the SAME forward-ref pattern revertNetwork already uses (plan 89 §3.7 point 4, §5 step 89.9) — without it, Forget/Block never clear a labelled phone\'s wallpaper', () => {
    const call = extractCall(daemonSource, 'const deviceLifecycle = createDeviceLifecycle({')
    expect(call).toContain('clearLabel:')
    expect(call).toContain('labellingRef?.clear(deviceId')
  })

  test('device preparation: the runner is built and swept at boot, beside agentProvisioner (plan 106 §3.5, §96.25 fix 1)', () => {
    expect(daemonSource).toContain('createPreparationRunner(')
    expect(daemonSource).toContain('preparationRunnerRef = preparationRunner')
    // The boot sweep call itself, and that it happens strictly AFTER the
    // adb-ready log line — §96.25's own boot-ordering rule, carried over
    // identically for this second runner. Anchored on the actual log call
    // and the sweep's own unique catch message, not the bare string
    // `adbState = 'ready'` — that also appears verbatim inside two EARLIER
    // comments explaining why this ordering matters, which would otherwise
    // make this assertion pass for the wrong reason.
    const readyAt = daemonSource.indexOf('adb subsystem ready (devices registered:')
    const sweepAt = daemonSource.indexOf('preparation-runner boot sweep failed')
    expect(readyAt).toBeGreaterThan(-1)
    expect(sweepAt).toBeGreaterThan(readyAt)
  })

  test('device preparation: the runner is wired into onDeviceReady — the SAME admission/reconnect hook agentProvisionerRef/labellingRef already use (plan 106 §3.5)', () => {
    const onReadyBlock = extractCall(daemonSource, 'onDeviceReady: (deviceId) => {')
    expect(onReadyBlock).toContain('preparationRunnerRef?.ensure(deviceId)')
  })

  test('device preparation: createDevicePreparationRoutes(...) is wired to the live runner and mounted into createApp (plan 106 §4)', () => {
    expect(daemonSource).toContain('devicePreparationRoutes: createDevicePreparationRoutes({ db, runner: preparationRunner, agentProvisioner }).routes')
  })

  test('device preparation: createDevicePreparationRoutes(...) is also wired to the live agentProvisioner — without it, guest agent has no working Retry button on the unified popup (plan 106 §5 step 106.5)', () => {
    const call = extractCall(daemonSource, 'devicePreparationRoutes: createDevicePreparationRoutes({')
    expect(call).toContain('agentProvisioner')
  })

  test('device preparation: ui-server installs are routed through the transfer machinery, not left as a declared-but-unreachable call site (plan 106 §5 step 106.8)', () => {
    // `preparationInstallApk` itself calls `runTransfer` with the SAME
    // `transferService`/`transferBroadcast`/`readinessHoldForTransfer`
    // instances the script API and `internal:install` already share — no
    // second transfer path — and marks the result `origin: 'preparation'`
    // (plan 107 §3.5) so the tray can label it distinctly from an
    // operator-initiated install.
    const call = extractCall(
      daemonSource,
      "const preparationInstallApk = (deviceId: string, localPath: string, label: 'app' | 'test', packageName: string): Promise<void> => {",
    )
    expect(call).toContain('transfer: transferService,')
    expect(call).toContain('broadcast: transferBroadcast,')
    expect(call).toContain("kind: 'install',")
    expect(call).toContain("origin: 'preparation',")
    expect(call).toContain('holdFor: readinessHoldForTransfer,')
    expect(call).toContain('transferService.installFromLocalApk(deviceId, localPath,')
    // The package name travels with the path: without it, a device that
    // refuses the `-g` install flag (a Xiaomi HyperOS build does) can install
    // the APK but has nothing to aim `pm grant` at, and the ui-server would
    // land with its runtime permissions ungranted.
    expect(call).toContain('packageName')

    // And that this function is actually handed to the registry, not just
    // declared and left uncalled — this repo's own repeated defect class.
    const registryCall = extractCall(daemonSource, 'registry: createPreparationRegistry({')
    expect(registryCall).toContain('installApk: preparationInstallApk')
  })

  test('device preparation: ui-server installs are bounded by adb.maxInstallConcurrent, the SAME setting hostAdb\'s own install lane already reads — without it, the move off hostAdb (plan 106 §5 step 106.8) would silently drop the pre-existing "no install storm" guarantee on an unattended boot-sweep code path (H2 re-examined)', () => {
    // Matches the ONE binding this test is about (`new Semaphore(...)` below)
    // rather than the whole import line. Spelling out every binding made this
    // assertion fail the moment an unrelated type was added to that import —
    // a test that breaks on changes it does not care about teaches people to
    // edit tests to make them pass, which is the opposite of what it is for.
    expect(daemonSource).toMatch(/import \{[^}]*\bSemaphore\b[^}]*\} from '@enkaku\/adb'/)
    expect(daemonSource).toContain('const preparationInstallSem = new Semaphore(Math.max(1, settingsStore.get().adb.maxInstallConcurrent))')
    const call = extractCall(
      daemonSource,
      "const preparationInstallApk = (deviceId: string, localPath: string, label: 'app' | 'test', packageName: string): Promise<void> => {",
    )
    expect(call).toContain('settingsStore.get().adb.maxInstallConcurrent')
    expect(call).toContain('preparationInstallSem.resize(wanted)')
    expect(call).toContain('preparationInstallSem.acquire()')
    expect(call).toContain('.finally(release)')
  })

  test('the `video:` adb-stats accessor resolves WallTransport and passes a transport-aware bandwidth bound — without this, a loopback/LAN farm stays bandwidth-bound at the pre-plan-100 20 Mbit/s constant forever (plan 100 §3.1, §4.1, step 100.3)', () => {
    const call = extractCall(daemonSource, 'video: () => {')
    expect(call).toContain("resolveWallTransport(process.env.ENKAKU_MODE === 'orchestrator', wallSettings.transportOverride)")
    expect(call).toContain('resolveWallBandwidthBps(transport, wallSettings.bandwidthBps)')
    // The resolved classification is also reported back on the response,
    // not just used internally — the settings projection needs it (§4.1).
    expect(call).toContain('transport,')
  })

  test('createSessionManager(...) passes a live `withGuestAgentClient` accessor — without it, rung 1 of the text ladder (agent-ime) is unreachable in every build (plan 90 §3.3, §4.5)', () => {
    // A bare `'createSessionManager({'` marker would match a COMMENT above the real call first
    // (`// \`sessions = createSessionManager({ onEvent, ... })\` below, well`, :538) — `indexOf`
    // finds whichever comes first in the file, and that comment's own braces happen to balance on
    // their own line, so `extractCall` would silently hand back the comment's fake object literal
    // instead of throwing. The leading newline + real indentation is what disambiguates: the
    // comment is indented 6 spaces and starts with `// `, the real assignment is indented 8.
    const call = extractCall(daemonSource, '\n        sessions = createSessionManager({')
    expect(call).toContain('withGuestAgentClient:')
    // The adapter must route through the SAME per-device session `guestAgent` already owns
    // (plan 44 §8b's "Bug 1": a second, independent bootstrap mints a second token and
    // invalidates the first) — not a fresh client, not a stub, and not a different accessor
    // entirely (e.g. `deviceIdentity.withGuestAgentClient`, a different object).
    expect(call).toContain('guestAgent.withGuestAgentClient(deviceId, fn)')
  })

  test('a boot-time scrcpy sweep runs BEFORE `sessions = createSessionManager(...)`, with an empty known-scid set (docs/plans/96-m61-hotfixes.md §96.23, plan 100 §3.5, step 100.1) — without this, a crash or ungraceful shutdown leaves every device-side scrcpy process from the previous run alive forever', () => {
    const sweepIdx = daemonSource.indexOf('sweepStrayScrcpyServers(')
    expect(sweepIdx).toBeGreaterThan(-1)
    // Same disambiguation the test above needs: a comment earlier in this
    // file (`// \`sessions = createSessionManager({ onEvent, ... })\` below,
    // well`) matches a bare marker first; the leading newline + real
    // indentation picks the actual assignment instead.
    const sessionsIdx = daemonSource.indexOf('\n        sessions = createSessionManager({')
    expect(sessionsIdx).toBeGreaterThan(-1)
    expect(sweepIdx).toBeLessThan(sessionsIdx)

    // Scoped to the same serial the sweep is iterating, through the real
    // `AdbClient.exec`, not `adb.hostAdb`/`spawnLongLived` (those two are
    // reserved for the jar push and the long-lived server child — see
    // `packages/scrcpy/src/session.ts`'s own comment on why a long-running
    // command must never go through the per-device queue `exec` uses).
    const sweepCallStart = sweepIdx
    const sweepCallRegion = daemonSource.slice(sweepCallStart, sweepCallStart + 400)
    expect(sweepCallRegion).toContain('adbClient.exec(tracked.serial, cmd')
    // An empty known-scid set: nothing in THIS process has opened a session
    // yet at the point this runs, so every scrcpy process a `ps` still finds
    // on an attached phone is, by definition, an orphan from a prior crash
    // or ungraceful shutdown — never a session this boot itself just opened.
    expect(sweepCallRegion).toContain('new Set()')

    // Only devices adb currently reports as `'device'` (online) are swept —
    // an `offline`/`unauthorized` entry cannot answer `ps` and must not be
    // treated as a boot failure.
    expect(daemonSource).toContain("tracked.state !== 'device'")

    // Best-effort at the per-device level: one phone's sweep failing must
    // never abort boot for every other device (or for the daemon at all).
    const forLoopStart = daemonSource.indexOf('for (const tracked of await adbClient.listDevices()')
    expect(forLoopStart).toBeGreaterThan(-1)
    expect(forLoopStart).toBeLessThan(sweepCallStart)
    expect(daemonSource.slice(forLoopStart, sweepCallStart + 600)).toContain('} catch (err) {')
  })

  describe('co-control (plan 91 §4.2, §5 step 91.2): the grant store, its reaper, and its subordination wiring', () => {
    test('createCoControlManager(...) is actually constructed, reading `leases` and the live coControl settings — not just declared and left uncalled', () => {
      // `'createCoControlManager({'` is unambiguous in this file: the import
      // line reads `import { createCoControlManager, type CoControlManager }
      // from './lease/co-control'` — no `(` immediately follows the name
      // there, so `indexOf` cannot land on the import and silently hand back
      // an empty/wrong slice the way a comment containing the call-shaped
      // string could (this file's own header comment explains that failure
      // mode for a different marker).
      const call = extractCall(daemonSource, 'createCoControlManager({')
      expect(call).toContain('leases,')
      expect(call).toContain('grantTtlSec: () => settingsStore.get().coControl.grantTtlSec')
      expect(call).toContain('maxConcurrentPerDevice: () => settingsStore.get().coControl.maxConcurrentPerDevice')
      expect(call).toContain('mode: () => settingsStore.get().coControl.mode')
    })

    test('the co-control reaper is started at boot and stopped in stop() — a leaked interval is a real defect (00-overview.md §7 item 7), not a nit', () => {
      expect(daemonSource).toContain('coControl.startReaper()')
      expect(daemonSource).toContain('stopCoControlReaper = () => coControl.stopReaper()')
      // Inside the `async stop()` method, not merely declared somewhere else in the file.
      const stopStart = daemonSource.indexOf('async stop() {')
      expect(stopStart).toBeGreaterThan(-1)
      // 500, not 400: plan 92 §5 step 92.2 added a `reprofileDebounceTimer`
      // clear right after `heartbeatInterval`'s, near the top of this same
      // method, pushing every fixed-offset check below it further out.
      const stopBlock = daemonSource.slice(stopStart, stopStart + 500)
      expect(stopBlock).toContain('stopCoControlReaper?.()')
    })

    test('lease-manager.ts\'s onPrimaryEnded hook is wired to the co-control manager — the safety property ("a grant can never outlive the hold it was subordinate to") is dead code otherwise', () => {
      const call = extractCall(daemonSource, 'createLeaseManager({')
      // Fires unconditionally from `release()`/`clearJobLease()` (voluntary
      // release included, not just the automatic `onManualRevoked` paths).
      expect(call).toContain('onPrimaryEnded: (deviceId) => coControlRef?.onPrimaryEnded(deviceId)')
      // A takeover never calls `release()` (it is an atomic revoke-then-acquire),
      // so `onPrimaryEnded` above never fires for it — the displaced holder's
      // grants would silently survive the takeover without this second call
      // inside `onManualTakenOver`.
      expect(call).toContain('onManualTakenOver:')
      const takenOverStart = call.indexOf('onManualTakenOver:')
      // 2900, not 2500: plan 94 step 94.3's daemon.ts wiring (this file's own
      // "the action recorder" describe block below) added a
      // `stopRecordingForLeaseLost?.(deviceId)` call plus its doc comment
      // inside this SAME `onManualTakenOver` block, ahead of
      // `coControlRef?.onPrimaryEnded(deviceId)`, pushing it further out.
      const takenOverBlock = call.slice(takenOverStart, takenOverStart + 2900)
      expect(takenOverBlock).toContain('coControlRef?.onPrimaryEnded(deviceId)')
    })

    test('coControl IS threaded into createWsMessageHandler(...) (plan 91 §5 step 91.4) — the 91.2 marker comment pinning the gap is gone, replaced by the real wiring', () => {
      // Step 91.2 left a "NOT WIRED YET ... step 91.4" comment directly above
      // `attachWsRouter` and a test here pinning that the comment existed, so
      // a future edit could not silently drop the gap. Step 91.4 closes the
      // gap for real: this test now pins the OPPOSITE fact — the marker text
      // is gone, and `createWsMessageHandler(...)`'s own call literally
      // contains `coControl` and a live `coControlMode` accessor.
      const attachStart = daemonSource.indexOf('const attachWsRouter = (localSessions: SessionManager | null) => {')
      expect(attachStart).toBeGreaterThan(-1)
      const precedingComment = daemonSource.slice(Math.max(0, attachStart - 900), attachStart)
      expect(precedingComment).not.toContain('NOT WIRED YET')
      const call = extractCall(daemonSource, 'createWsMessageHandler({')
      expect(call).toContain('coControl,')
      expect(call).toContain('coControlMode: () => settingsStore.get().coControl.mode')
    })

    test('the co-control manager broadcasts assist.changed on every grant/release (plan 91 §3.4 item 4, §5 step 91.4) — not only from the explicit assist.start/assist.stop WS messages, so TTL expiry, a WS disconnect, and the primary hold ending all reach every viewer too', () => {
      const call = extractCall(daemonSource, 'createCoControlManager({')
      expect(call).toContain('onGranted:')
      expect(call).toContain('onReleased:')
      const onGrantedStart = call.indexOf('onGranted:')
      const onGrantedBlock = call.slice(onGrantedStart, onGrantedStart + 300)
      expect(onGrantedBlock).toContain("hub.broadcast({ type: 'assist.changed'")
      const onReleasedStart = call.indexOf('onReleased:')
      const onReleasedBlock = call.slice(onReleasedStart, onReleasedStart + 300)
      expect(onReleasedBlock).toContain("hub.broadcast({ type: 'assist.changed'")
    })
  })

  describe('mirror groups (plan 91 §3.9, §4.7, §5 step 91.7): the WS-router construction and the F27 re-admit wiring', () => {
    test('createWsMessageHandler(...) passes a live `states` accessor and a live `mirrorSettings` accessor — without them, MirrorManager is never constructed (`mirror.start`/`input.mirror` refuse E_NOT_SUPPORTED) and mirror.maxDevices/requireSameOrientation/aspectTolerance/dropAfterConsecutiveFailures are unconfigurable from Studio', () => {
      const call = extractCall(daemonSource, 'createWsMessageHandler({')
      expect(call).toContain('states,')
      expect(call).toContain('mirrorSettings: () => settingsStore.get().mirror')
    })

    test('a `reconcileMirrorForDevice` forward-ref is declared and assigned inside attachWsRouter, the same pattern every other WS-router hook in this file already uses', () => {
      expect(daemonSource).toContain('let reconcileMirrorForDevice: ((deviceId: string) => void) | null = null')
      // Anchored extraction (plan 93 step 93.6 Task B), not a fixed-length
      // slice. This test used to read `daemonSource.slice(attachStart,
      // attachStart + 7500)` — a magic-number window that four separate
      // workers had to widen in one day (6900→7300, 7200→7500) every time an
      // edit landed ahead of the assignment inside `attachWsRouter`'s body.
      // `extractCall` already brace-balances an object-literal call
      // (`name({ ... })`) by counting `{`/`}` from its opening brace to the
      // matching close; the SAME algorithm works unchanged here because this
      // marker also ends in its own opening `{` (the arrow function's
      // `(...) => {`), so it hands back the FULL `attachWsRouter` body no
      // matter how it grows — no window to widen, ever again.
      const attachBody = extractCall(daemonSource, 'const attachWsRouter = (localSessions: SessionManager | null) => {')
      expect(attachBody).toContain('reconcileMirrorForDevice = handler.reconcileMirror')
    })

    test("host's onJobFinished calls reconcileMirrorForDevice — without this, an internal:install-skipped mirror member never rejoins its group when the install ends (F27)", () => {
      // `extractCall`, not a fixed character window: this hook's body is the
      // one every plan adds a settle-time line to, and the 1600-char window
      // that used to be here broke the moment plan 128 inserted
      // `traceRecorder?.flush(jobId)` (with its comment) two lines above the
      // call being asserted — the same "widen the guess again" failure this
      // file's own `extractCall` doc records.
      const onFinishedBlock = extractCall(daemonSource, 'onJobFinished: (deviceId, jobId, status, durationMs) => {')
      expect(onFinishedBlock).toContain('reconcileMirrorForDevice?.(deviceId)')
    })
  })

  describe('attribution (plan 91 §3.6, §4.8, §5 step 91.5/91.10): the last line of the assist→child notification chain', () => {
    /**
     * `WsHandlerDeps.onAssist` was added by step 91.5 (`ws-handlers.ts`),
     * called from the `input.*` branch on every accepted assist action so a
     * running script's `ctx.onAssist` can ever fire at all. Step 91.5 could
     * not wire the daemon.ts side itself (a concurrent worker owned this
     * file at the time) — this test used to PIN THE GAP, failing on purpose
     * until the line landed. Step 91.10 added the line (beside its own
     * pre-existing `onJobCrash` neighbour) and flips this test to assert the
     * real wiring, the same way the co-control/mirror blocks above do: it
     * must still fail if a future edit drops the line again, exactly per
     * `00-overview.md`'s "a failing test that fails while it is missing,
     * naming the exact line" convention for a contested file — the failure
     * mode just moved from "always fails until wired" to "fails only on a
     * regression".
     *
     * Without this line, `ExecutorHost.notifyAssist`/`ctx.onAssist` are
     * fully built and unit-tested in isolation (`executor-host.test.ts`,
     * `job-runner.test.ts`) but structurally unreachable in a real boot — a
     * running script's `ctx.onAssist` callback would never fire, silently,
     * no error anywhere.
     */
    test('createWsMessageHandler(...) passes a live `onAssist` accessor reaching ExecutorHost.notifyAssist', () => {
      const call = extractCall(daemonSource, 'createWsMessageHandler({')
      expect(call).toContain('onAssist: (jobId, e) => host.notifyAssist(jobId, e)')
      // Beside `onJobCrash`, not merely somewhere in the call — same
      // neighbour-anchoring style `onManualTakenOver`'s block above uses.
      const onJobCrashStart = call.indexOf('onJobCrash:')
      expect(onJobCrashStart).toBeGreaterThan(-1)
      const neighbourhood = call.slice(onJobCrashStart, onJobCrashStart + 900)
      expect(neighbourhood).toContain('onAssist: (jobId, e) => host.notifyAssist(jobId, e)')
    })
  })

  describe('workflow executor (plan 99 §3.1, §4.7, step 99.7): constructed and registered as the kind: \'workflow\' fallback', () => {
    test('createWorkflowExecutor(...) is actually constructed and registered via executors.setFallback(workflowExecutor, \'workflow\') — not just imported and left uncalled', () => {
      // `DEFAULT_WORKFLOW_MAX_TOTAL_MS` was dropped from this import once
      // `workflow-settings-wiring.test.ts` closed (the executor now reads
      // `settingsStore.get().workflow` instead of that literal constant) —
      // nothing else in daemon.ts still referenced it.
      expect(daemonSource).toContain("import { createWorkflowExecutor } from './jobs/executors/workflow'")
      const call = extractCall(daemonSource, 'createWorkflowExecutor({')
      // Reuses the SAME runner/sessions/registry every standalone job already
      // shares (plan 99 §3.4: "a node is a script child, not a job") — a
      // second, independent JobRunner or SessionManager here would be a
      // silent second runtime, exactly what §3.1 rejects.
      expect(call).toContain('registry: scriptRegistry')
      expect(call).toContain('runner,')
      expect(call).toContain('sessions,')
      expect(call).toContain('nodeTracker: jobNodeTracker')
      // The literal `setFallback(workflowExecutor, 'workflow')` call — the
      // ONE line that actually wires the executor into the registry.
      // Without it, `createWorkflowExecutor` would be dead code: built,
      // never reachable through `ExecutorRegistry.get(id, 'workflow')`.
      expect(daemonSource).toContain("executors.setFallback(workflowExecutor, 'workflow')")
    })

    test('the artifacts factory feeding createJobRunner(...) is node-aware — without it, no artifact a workflow node saves is ever attributed to that node', () => {
      const call = extractCall(daemonSource, 'createJobRunner({')
      expect(call).toContain('nodeId: () => jobNodeTracker.current(jobId)')
    })

    test("createJobRunner(...)'s onPhase hook feeds jobNodeTracker.noteAttempt — without it, job_nodes.attempts has no honest source", () => {
      const call = extractCall(daemonSource, 'createJobRunner({')
      const onPhaseStart = call.indexOf('onPhase: (jobId, attempt, phase) => {')
      expect(onPhaseStart).toBeGreaterThan(-1)
      const onPhaseBlock = call.slice(onPhaseStart, onPhaseStart + 900)
      expect(onPhaseBlock).toContain('jobNodeTracker.noteAttempt(jobId, attempt)')
    })

    test('createJobNodeTracker() is constructed once, before createJobRunner(...) — the tracker must exist for the artifacts factory closure to close over', () => {
      expect(daemonSource).toContain("import { saveForDevice, createJobNodeTracker } from './runner/artifact-store'")
      expect(daemonSource).toContain('const jobNodeTracker = createJobNodeTracker()')
      const trackerAt = daemonSource.indexOf('const jobNodeTracker = createJobNodeTracker()')
      const runnerAt = daemonSource.indexOf('const runner = createJobRunner({')
      expect(trackerAt).toBeGreaterThan(-1)
      expect(runnerAt).toBeGreaterThan(-1)
      expect(trackerAt).toBeLessThan(runnerAt)
    })
  })

  /**
   * Plan 128 (M93 — the job trace timeline) §3.1, §3.5, §3.6, §10, step
   * 128.5. Exactly this file's defect class again, with one twist that makes
   * it worse than usual: `JobRunnerDeps` declares `onTraceEvent?` and
   * `traceStore?` as two SEPARATE optional deps, and wiring only the first
   * produces a build that looks entirely healthy — every job gets a complete
   * event lane with durations, outcomes and phases — while every frame lane
   * on the farm is empty, because `traceStore` is the only route a
   * screenshot's bytes have out of `@enkaku/session` (`captureForTrace`
   * returns `{ frameHash: null, uiHash: null }` the instant it is absent, and
   * the tee's capture policy then resolves to `'none'`). Nothing fails; the
   * feature is just half there, on every run, forever. Step 128.4's worker
   * flagged it before either side shipped, which is why both halves are
   * asserted here rather than one.
   */
  /**
   * Plan 130 §3.5, §10 item 8 — the FOURTH time in four plans that the gap
   * between "built and tested" and "reachable on a farm" was the last thing
   * standing. 130.4's worker was told `daemon.ts` was off limits and to name
   * the wiring instead of assuming someone would notice; it did, and this
   * pins the result. A token service that is never threaded into the
   * middleware refuses every API token while every one of its own 52 tests
   * passes, because those tests call `validate` directly.
   *
   * BOTH middleware call sites are asserted. `/mcp` is not an afterthought:
   * an external MCP client is the caller this credential exists for, and
   * wiring only `/api/*` would leave exactly that caller still borrowing a
   * human's session.
   */
  describe('durable API tokens (plan 130 §3.5, step 130.4)', () => {
    const httpSource = readFileSync(new URL('./server/http.ts', import.meta.url), 'utf8')

    test('the token service is constructed and handed to the http layer', () => {
      expect(daemonSource).toContain('const apiTokens = createApiTokenService(db)')
      expect(daemonSource).toContain('tokenRoutes: createTokenRoutes({ apiTokens })')
    })

    test('BOTH authMiddleware call sites receive it — /api/* and /mcp', () => {
      const wired = httpSource.match(/authMiddleware\(\{[^}]*apiTokens: deps\.apiTokens[^}]*\}\)/g) ?? []
      expect(wired).toHaveLength(2)
    })

    test('the routes are actually mounted', () => {
      expect(httpSource).toContain("app.route('/api/tokens', deps.tokenRoutes)")
    })
  })

  describe('job trace (plan 128 §3.1, §3.5, §3.6, step 128.5): the recorder, the frame store, and BOTH runner deps', () => {
    test('createJobRunner(...) is passed BOTH onTraceEvent and traceStore — onTraceEvent alone leaves the frame lane empty on every job', () => {
      const call = extractCall(daemonSource, 'createJobRunner({')
      expect(call).toContain('onTraceEvent:')
      expect(call).toContain('traceRecorder?.record(event)')
      // The other half. This is the assertion the plan exists for.
      expect(call).toContain('traceStore: traceFrameStore')
    })

    /**
     * Plan 130 §10 item 1 — the same failure one surface over, found by 130.1's
     * worker after the capabilities were written, tested and registered.
     * `job.trace.frame` and `job.trace.ui` read through `ctx.jobTrace`, which
     * `createCapabilityContext` builds only when `traceStore` is among its
     * deps. Unwired, both capabilities refuse with `E_NOT_SUPPORTED` on a real
     * farm while looking entirely healthy everywhere it is cheap to look: they
     * are registered, they are listed to the agent, and they appear over MCP.
     * Every unit test passes, because every unit test builds its own context.
     */
    test('the capability context is given the SAME trace store — otherwise job.trace.frame/ui refuse on a real farm while every test passes', () => {
      const call = extractCall(daemonSource, 'const capContextDeps: CapabilityContextDeps = {')
      expect(call).toContain('traceStore: traceFrameStore')
    })

    test('the trace recorder and frame store are actually constructed, from the daemon\'s own db/dataDir', () => {
      expect(daemonSource).toContain("import { createTraceRecorder, type TraceRecorder } from './jobs/trace/recorder'")
      expect(daemonSource).toContain("import { createTraceFrameStore } from './jobs/trace/frame-store'")
      const recorderCall = extractCall(daemonSource, 'traceRecorder = createTraceRecorder({')
      expect(recorderCall).toContain('db,')
      expect(daemonSource).toContain('const traceFrameStore = createTraceFrameStore({ dataDir: cfg.dataDir })')
    })

    test("the recorder's publish fans the STORED event out as job.trace — the tee's own event carries no id/seq", () => {
      const recorderCall = extractCall(daemonSource, 'traceRecorder = createTraceRecorder({')
      // `record()` calls `publish` synchronously with the event it just
      // assigned `id`/`seq` to, before the row is written (§3.6). The
      // `onTraceEvent` hook therefore broadcasts nothing itself — a second
      // broadcast there would send every event twice, and the object it was
      // handed is precisely the unnumbered one.
      expect(recorderCall).toContain("hub.broadcast({ type: 'job.trace', payload: { jobId, event } })")
      const runnerCall = extractCall(daemonSource, 'createJobRunner({')
      const hookStart = runnerCall.indexOf('onTraceEvent:')
      expect(hookStart).toBeGreaterThan(-1)
      expect(runnerCall.slice(hookStart, hookStart + 200)).not.toContain('hub.broadcast')
    })

    test('a settled job flushes its trace where the log buffer is released — the timeline must be complete the instant the status changes', () => {
      const onFinished = extractCall(daemonSource, 'onJobFinished: (deviceId, jobId, status, durationMs) => {')
      expect(onFinished).toContain('jobLogBuffer.release(jobId)')
      expect(onFinished).toContain('traceRecorder?.flush(jobId)')
    })

    test('the recorder is stopped on shutdown, beside the device-event recorder', () => {
      expect(daemonSource).toContain('await traceRecorder?.stop()')
      const eventStopAt = daemonSource.indexOf('await recorder?.stop()')
      const traceStopAt = daemonSource.indexOf('await traceRecorder?.stop()')
      expect(eventStopAt).toBeGreaterThan(-1)
      expect(traceStopAt).toBeGreaterThan(eventStopAt)
    })

    test('createJobRoutes(...) reads back through the SAME frame store the runner writes to', () => {
      const call = extractCall(daemonSource, 'jobRoutes: createJobRoutes(jobService, {')
      expect(call).toContain('traceStore: traceFrameStore')
      expect(call).toContain('dataDir: cfg.dataDir')
      expect(call).toContain('db,')
    })
  })

  describe('workflow routes (plan 99 §3.11, §4.5, §4.9, §5 step 99.6; docs/settings-audit.md #3, docs/plans/96-m61-hotfixes.md): createWorkflowRoutes(...) reads the LIVE farm setting, matching the workflow executor above', () => {
    /**
     * The matching guard to `jobs/executors/workflow-settings-wiring.test.ts`'s
     * own describe block, for the OTHER of workflow.maxTotalMs's two
     * consumers. Until this landed, `checkWorkflow`'s publish-time
     * `E_WORKFLOW_BUDGET_IMPOSSIBLE` check (`packages/protocol/src/workflow-check.ts`)
     * always fell back to the hardcoded schema default via `api/workflows.ts`'s
     * `budgetFor` — `daemon.ts`'s `createWorkflowRoutes({ db, registry:
     * scriptRegistry, audit })` call never passed a `settings` accessor at
     * all, even though `HttpDeps`/`createWorkflowRoutes`'s own `deps.settings?`
     * seam already existed for exactly this. The runtime executor's clock
     * (guarded above by `createWorkflowExecutor(...)`'s own describe block)
     * was fixed first and got its own regression test; this route was the
     * one nothing guarded — exactly how it drifted, and exactly the shape
     * `settings.ts`'s and `workflow.ts`'s own doc comments used to describe
     * BACKWARDS before this fix (claiming the executor was still hardcoded
     * and the route was already live).
     */
    test('createWorkflowRoutes(...) passes a live `settings` accessor reading settingsStore.get().workflow — without it, the publish-time budget check silently disagrees with the runtime executor\'s live clock', () => {
      const call = extractCall(daemonSource, 'workflowRoutes: createWorkflowRoutes({')
      expect(call).toContain('settings:')
      expect(call).toContain('settingsStore.get().workflow')
    })
  })

  describe('assistedBy (plan 91 §3.4 item 4, §4.4, §5 step 91.4; residual closed per docs/plans/96-m61-hotfixes.md §96.10): three more surfaces that read `[]` on a genuinely-assisted device until daemon.ts passed the accessor', () => {
    test('createClusterRoutes(...) passes a live `assistedByOf` accessor — without it, GET /api/clusters/:id/devices reports assistedBy: [] on an assisted device', () => {
      const call = extractCall(daemonSource, 'createClusterRoutes({')
      expect(call).toContain('assistedByOf:')
      expect(call).toContain('coControl.assistedBy(deviceId)')
    })

    test('createTopologyRoutes(...) passes a live `assistedByOf` accessor — without it, GET /api/topology reports assistedBy: [] on an assisted device', () => {
      const call = extractCall(daemonSource, 'createTopologyRoutes({')
      expect(call).toContain('assistedByOf:')
      expect(call).toContain('coControl.assistedBy(deviceId)')
    })

    test('capContextDeps carries a live `assistedByOf` accessor — without it, ctx.listDevices()/ctx.getDevice() report assistedBy: [] on an assisted device', () => {
      // Not a call-shaped marker (`capContextDeps` is a plain object literal, `const x: T = {`,
      // not `name({`) — `extractCall`'s brace-balancer works identically once the marker itself
      // ends in the opening `{`, which this one does.
      const call = extractCall(daemonSource, 'const capContextDeps: CapabilityContextDeps = {')
      expect(call).toContain('assistedByOf:')
      expect(call).toContain('coControl.assistedBy(deviceId)')
    })
  })

  describe('input arbiter settings (plan 91 §4.1, §4.5, §5 step 91.10; docs/plans/96-m61-hotfixes.md §96.13): coControl.queueWaitMs/maxQueueDepth reaching a real session', () => {
    test('createSessionManager(...) passes live `arbiterQueueWaitMs`/`arbiterMaxQueueDepth` accessors — without them every session ran the plan\'s own hardcoded stand-in defaults (5000ms / 32) regardless of farm configuration', () => {
      // Same disambiguation `withGuestAgentClient`'s own test above needed: a
      // bare `'createSessionManager({'` marker matches the COMMENT above the
      // real call first (`daemon.ts:544`, `// \`sessions = createSessionManager({
      // onEvent, ... })\` below, well` — its own braces balance on one line).
      const call = extractCall(daemonSource, '\n        sessions = createSessionManager({')
      expect(call).toContain('arbiterQueueWaitMs: () => settingsStore.get().coControl.queueWaitMs')
      expect(call).toContain('arbiterMaxQueueDepth: () => settingsStore.get().coControl.maxQueueDepth')
    })

    /**
     * The static assertion above only proves `daemon.ts`'s TEXT contains the
     * right accessor expressions — it would pass equally well if `manager.ts`
     * quietly resolved the accessor to a plain number once at session-build
     * time instead of forwarding the live function through to
     * `createInputArbiter`, which would break the one property
     * `input-arbiter.ts`'s own header comment promises: "read fresh on every
     * submission", not "read once when the session opens". A helper-level
     * test that the arbiter honours a `queueWaitMs`/`maxQueueDepth` it was
     * directly handed already exists (`input-arbiter.test.ts`) and already
     * passed throughout this defect's entire lifetime — it could never have
     * caught "the one production call site never passed the accessor",
     * because it never goes near `SessionManagerDeps` at all.
     *
     * This test proves the actual MECHANISM end to end instead: a real
     * `SessionManager` (`packages/session/src/manager.ts`, unmodified — the
     * exact module `daemon.ts` calls above), wired with the identical
     * accessor SHAPE `daemon.ts` uses (a closure reading a mutable
     * settings-like object, never a captured number), acquires a real
     * session, and a setting mutated AFTER that session already exists
     * changes the arbiter's observable behaviour on the SAME already-open
     * session — never merely on a fresh one built after the change. That is
     * the assertion that would have caught this gap.
     */
    test('a farm setting changed after a session is already open changes that SAME session\'s arbiter behaviour immediately', async () => {
      const DEVICE_ID = 'dev-arbiter-wiring-1'
      const snapshot: DeviceSnapshot = {
        id: DEVICE_ID,
        stableId: 'STABLE-ARBITER-1',
        serial: 'SERIAL-ARBITER-1',
        label: 'arbiter wiring test phone',
        status: 'idle',
        androidVersion: '15',
        apiLevel: 35,
        screenW: 720,
        screenH: 1640,
        transport: 'adb-usb',
        display: 'screencap-loop',
        input: 'adb-input',
        inspection: 'uiautomator-dump',
        preferredInputMode: 'uhid',
        keepAwake: 'off',
        standbyScreenOff: false,
      }
      const devices: DeviceSnapshotSource = { get: (id) => (id === DEVICE_ID ? snapshot : null) }
      const silentLog = (): Logger => {
        const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
        return l as unknown as Logger
      }
      /** Every shell command succeeds instantly; nothing touches a real device — the same `fakeClient` shape `manager.test.ts`/`session.test.ts` already use. */
      const client = {
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        execOut: async () => new Uint8Array(),
      } as unknown as AdbClient

      // Mutable, exactly the way `settingsStore.get()` is: a live read, not a
      // value captured once. `daemon.ts`'s own accessors above have this SAME
      // shape — `() => settingsStore.get().coControl.queueWaitMs` — closing
      // over a store rather than a resolved number.
      const farmSettings = { coControl: { queueWaitMs: 5_000, maxQueueDepth: 0 } }
      const manager = createSessionManager({
        client,
        devices,
        log: silentLog(),
        arbiterQueueWaitMs: () => farmSettings.coControl.queueWaitMs,
        arbiterMaxQueueDepth: () => farmSettings.coControl.maxQueueDepth,
      })

      const session = await manager.acquire(DEVICE_ID, () => {})
      const opA = session.arbiter.for({ kind: 'job', id: 'job-1', userId: null })
      const opB = session.arbiter.for({ kind: 'assist', id: 'op-1', userId: 'user-1' })

      // maxQueueDepth: 0 right now (the current farm setting) — a second
      // pointer-lane action arriving while one is already running must be
      // refused immediately, never queued.
      const blockerA = opA.tap({ x: 1, y: 1 }) // claims the pointer lane synchronously
      await expect(opB.tap({ x: 2, y: 2 })).rejects.toMatchObject({ code: 'E_INPUT_BUSY' })
      await blockerA

      // The operator raises the setting from Studio. Nothing about this
      // SESSION or its arbiter was rebuilt — only what the accessor above
      // now returns.
      farmSettings.coControl.maxQueueDepth = 5

      // The identical call shape that was refused a moment ago now queues
      // instead of being refused, on the SAME session object acquired above.
      const blockerB = opA.tap({ x: 1, y: 1 })
      await expect(opB.tap({ x: 2, y: 2 })).resolves.toBeUndefined()
      await blockerB

      await manager.closeAll()
    })

    test('arbiterQueueWaitMs is also read fresh on every submission — lowering it refuses a newly-queued action sooner, without rebuilding the session', async () => {
      const DEVICE_ID = 'dev-arbiter-wiring-2'
      const snapshot: DeviceSnapshot = {
        id: DEVICE_ID,
        stableId: 'STABLE-ARBITER-2',
        serial: 'SERIAL-ARBITER-2',
        label: 'arbiter wiring test phone 2',
        status: 'idle',
        androidVersion: '15',
        apiLevel: 35,
        screenW: 720,
        screenH: 1640,
        transport: 'adb-usb',
        display: 'screencap-loop',
        input: 'adb-input',
        inspection: 'uiautomator-dump',
        preferredInputMode: 'uhid',
        keepAwake: 'off',
        standbyScreenOff: false,
      }
      const devices: DeviceSnapshotSource = { get: (id) => (id === DEVICE_ID ? snapshot : null) }
      const silentLog = (): Logger => {
        const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
        return l as unknown as Logger
      }
      let tapCalls = 0
      const client = {
        exec: async (_serial: string, cmd: string) => {
          if (cmd.startsWith('input tap')) {
            tapCalls++
            // The FIRST tap (the blocker) holds the pointer lane for ~150ms — long
            // enough to comfortably observe the SECOND action's refusal land well
            // before it, proving the short budget (not the original 10s one) was
            // actually used.
            if (tapCalls === 1) await Bun.sleep(150)
          }
          return { stdout: '', stderr: '', exitCode: 0 }
        },
        execOut: async () => new Uint8Array(),
      } as unknown as AdbClient

      const farmSettings = { coControl: { queueWaitMs: 10_000, maxQueueDepth: 32 } }
      const manager = createSessionManager({
        client,
        devices,
        log: silentLog(),
        arbiterQueueWaitMs: () => farmSettings.coControl.queueWaitMs,
        arbiterMaxQueueDepth: () => farmSettings.coControl.maxQueueDepth,
      })

      const session = await manager.acquire(DEVICE_ID, () => {})
      const op = session.arbiter.for({ kind: 'job', id: 'job-1', userId: null })

      const blocker = op.tap({ x: 1, y: 1 }) // holds the pointer lane for ~150ms

      // The operator lowers the wait budget from Studio WHILE this second
      // action is about to be submitted — `submit()` reads `queueWaitMs()`
      // at the moment it queues a NEW action, so this must take effect for
      // it even though the session (and the blocker already running) predate
      // the change.
      farmSettings.coControl.queueWaitMs = 20

      const startedAt = Date.now()
      await expect(op.tap({ x: 2, y: 2 })).rejects.toMatchObject({ code: 'E_INPUT_BUSY' })
      const elapsedMs = Date.now() - startedAt
      // Refused close to the LOWERED 20ms budget, well before the blocker's
      // own ~150ms completion — proof the arbiter used the NEW value, not
      // the original 10-second one (which would never have refused here at
      // all: the queued action would simply have run once the blocker
      // finished).
      expect(elapsedMs).toBeLessThan(150)

      await blocker
      await manager.closeAll()
    })
  })

  describe('live video re-profile (plan 92 §3.8, §4.4, §5 step 92.2): the debounced settingsStore.onChange path and the manual /api/video/reprofile route', () => {
    test('settingsStore.onChange schedules a DEBOUNCED reprofile, not an immediate one — restarting a farm\'s video on every keystroke is worse than not honouring the setting at all (§3.8 rule 2)', () => {
      // Both `recomputeAdbConcurrency` (F23's own precedent, immediate — no
      // debounce, because it only ever touches a semaphore ceiling, never
      // tears down a live encoder) and `scheduleReprofile` (this step, always
      // debounced 500ms, because a restart DOES interrupt a live picture)
      // register on the SAME `settingsStore.onChange` — this test pins that
      // the second listener actually exists and drives `scheduleReprofile`,
      // not a second `recomputeAdbConcurrency()` call.
      expect(daemonSource).toContain("settingsStore.onChange(() => scheduleReprofile('farm video settings changed'))")
      expect(daemonSource).toContain('const VIDEO_REPROFILE_DEBOUNCE_MS = 500')
      // The debounce mechanism itself: a NEW timer replaces any pending one
      // rather than stacking (`clearTimeout` before `setTimeout`) — the
      // literal shape a coalescing debounce must have, and the one shape a
      // naive "just add a delay" edit would be missing.
      const scheduleStart = daemonSource.indexOf('const scheduleReprofile = (reason: string) => {')
      expect(scheduleStart).toBeGreaterThan(-1)
      const scheduleBlock = daemonSource.slice(scheduleStart, scheduleStart + 900)
      expect(scheduleBlock).toContain('if (reprofileDebounceTimer) clearTimeout(reprofileDebounceTimer)')
      expect(scheduleBlock).toContain('reprofileDebounceTimer = setTimeout(')
      expect(scheduleBlock).toContain('sessions?.reprofile?.(reason)')
      expect(scheduleBlock).toContain('VIDEO_REPROFILE_DEBOUNCE_MS')
    })

    test('reprofileDebounceTimer is cleared in stop() — a settings save made just before shutdown must never fire a restart against a torn-down sessions manager (00-overview.md §7)', () => {
      const stopStart = daemonSource.indexOf('async stop() {')
      expect(stopStart).toBeGreaterThan(-1)
      const stopBody = daemonSource.slice(stopStart, stopStart + 600)
      expect(stopBody).toContain('if (reprofileDebounceTimer) clearTimeout(reprofileDebounceTimer)')
      expect(stopBody).toContain('reprofileDebounceTimer = null')
    })

    test('createApp(...) passes a real videoRoutes built from createVideoRoutes({ sessions: () => sessions }) — without it, POST /api/video/reprofile 404s through the catch-all instead of restarting anything', () => {
      const call = extractCall(daemonSource, 'const app = createApp({')
      expect(call).toContain('videoRoutes: createVideoRoutes({ sessions: () => sessions })')
    })
  })

  describe('the wake skip (plan 125 §3.7, step 125.7): the ~1.6 s that only disappears if daemon.ts actually wires deviceIsAwake', () => {
    /**
     * The same defect class this whole file exists for, and 125.7 is a
     * textbook instance: `SessionManagerDeps.deviceIsAwake` is OPTIONAL, so
     * every test in `packages/session` passes with it supplied and production
     * passes with it absent — silently paying the wake twice, which is the
     * ~3.2 s plan 125 §0.7 measured and the exact thing step 125.7 removed.
     * Nothing else fails when this line is dropped in a refactor.
     *
     * The long-form ternary is asserted, not just the key, because the
     * shorthand is a real and tempting bug: `readiness?.actual(id) !==
     * 'asleep'` evaluates `undefined !== 'asleep'` — `true` — while readiness
     * is still unset during early boot, so it would skip the wake on exactly
     * the builds that most need one. A missing readiness manager has to mean
     * "wake it", never "assume it is awake".
     */
    test('createSessionManager is handed deviceIsAwake, and it fails CLOSED when readiness is unset', () => {
      // The LEADING newline-plus-indent is load-bearing, and `extractCall`
      // requires the marker to END in the region's own '{'. A comment forty
      // lines earlier writes `sessions = createSessionManager({ onEvent, ... })`
      // in prose, and `extractCall` takes the FIRST match — so the bare name
      // would extract that sentence instead of the call.
      const call = extractCall(daemonSource, '\n        sessions = createSessionManager({')
      expect(call).toContain('deviceIsAwake:')
      expect(call).toContain("readiness ? readiness.actual(deviceId) !== 'asleep' : false")
      // Comment lines are stripped before the negative check, because the
      // comment at the call site QUOTES the shorthand in order to explain why
      // it is wrong — the same reason `readiness.test.ts`'s no-timer assertion
      // strips them. Without this the guard fails on its own documentation.
      const code = call
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
      expect(code).not.toContain("readiness?.actual(deviceId) !== 'asleep'")
    })
  })

  describe('the video path on the protocol client (plan 125 §3.9, §4.5, step 125.9): the four adb.exe spawns per session that only disappear if daemon.ts actually passes it', () => {
    /**
     * This is that defect class again, and plan 119 is the one that left it:
     * it built `forward`/`listForward`/`killForward` on `AdbClient`, wired
     * them into the guest-agent and ui-server launchers, and left `makeScrcpy`
     * on `hostAdb.run` — so the VIDEO path, the hottest one in the product,
     * kept spawning `adb.exe` four times per session while the plan read as
     * shipped. `@enkaku/scrcpy` chooses the protocol path purely by which
     * fields it was handed (its own test file counts the spawns for both
     * shapes), which makes this call site the whole difference.
     */
    test('makeScrcpy hands startScrcpySession the push and the forward trio, not just hostAdb', () => {
      const call = extractCall(daemonSource, 'makeScrcpy: async (deviceId, transport, profile) => {')
      expect(call).toContain("adbClient.openRaw(transport.serial, 'sync:')")
      expect(call).toContain('pushFileOverSync(stream, { localPath, remotePath })')
      expect(call).toContain('forward: (serial, local, remote) => adbClient.forward(serial, local, remote)')
      expect(call).toContain('listForward: () => adbClient.listForward()')
      expect(call).toContain('killForward: (serial, local) => adbClient.killForward(serial, local)')
      // The fifth spawn stays: `app_process` is a process, and this is the
      // long-lived `adb shell` holding it (plan 85 §3.4, §4.5).
      expect(call).toContain('spawnLongLived: hostAdbHandle.spawnLongLived')
    })

    test('the `sync:` stream is closed on both routes, the error one included — a leaked stream holds an adb connection open for a session that never started', () => {
      const call = extractCall(daemonSource, 'push: async (localPath, remotePath) => {')
      expect(call).toContain('stream.close()')
      expect(call).toContain('stream.close(true)')
      // `transfer.ts`'s `performInstall` has pushed APKs this exact way since
      // plan 39; the jar is the same mechanism on a much smaller file.
      expect(call).toContain('throw err')
    })
  })

  describe('the command console runner (plan 93 §4.5, §5 step 93.3)', () => {
    test('createCommandRunner(...) is actually constructed, wired to the SAME `leases` this file builds, a real shellPortFor, and the live shell settings — not just declared and left uncalled', () => {
      const call = extractCall(daemonSource, 'createCommandRunner({')
      expect(call).toContain('store: commandRunStore')
      expect(call).toContain('leases,')
      expect(call).toContain('shellPortFor: commandShellPortFor')
      expect(call).toContain('resolve: (target) => resolveCommandTarget(db, target)')
      expect(call).toContain('settings: () => settingsStore.get().shell')
      expect(call).toContain('audit,')
      expect(call).toContain('getDevice: getDeviceOwner')
    })

    test('the runner is swept at boot — a command run left running/awaiting-continue by a crashed previous process must not sit there forever', () => {
      expect(daemonSource).toContain('commandRunner = createCommandRunner({')
      expect(daemonSource).toContain('commandRunner.sweepOrphans()')
    })

    test('commandRunner.stop() is called from daemon.stop(), before `recorder` is torn down — every pending fan-out member must be dead on stop (00-overview.md §7), and its own `record` dep must still be alive while it cancels', () => {
      const stopStart = daemonSource.indexOf('async stop() {')
      expect(stopStart).toBeGreaterThan(-1)
      const stopBody = daemonSource.slice(stopStart, stopStart + 2500)
      expect(stopBody).toContain('commandRunner?.stop()')
      expect(stopBody).toContain('commandRunner = null')
      expect(stopBody.indexOf('commandRunner?.stop()')).toBeLessThan(stopBody.indexOf('recorder?.stop()'))
    })
  })

  describe('the command console REST/WS surface (plan 93 §3.17, §4.4, §4.5, §5 step 93.4)', () => {
    test('createCommandRunRoutes(...) is actually constructed, wired to the SAME `commandRunStore`/`commandRunner` this file builds, and mounted at /api/command-runs — not just declared and left uncalled', () => {
      const call = extractCall(daemonSource, 'commandRunRoutes: createCommandRunRoutes({')
      expect(call).toContain('store: commandRunStore')
      expect(call).toContain('runner: commandRunner!')
      expect(call).toContain('settings: () => settingsStore.get().shell')
      expect(call).toContain('roleOf:')
      expect(call).toContain('getDeviceOwner')
      expect(daemonSource).toContain('commandRunRoutes: createCommandRunRoutes({')
    })

    test('the runner\'s `broadcast` dep is a forward-ref into the WS router, not `hub.broadcast` — a fleet command must stay subscriber-scoped, never farm-wide (F27)', () => {
      const call = extractCall(daemonSource, 'commandRunner = createCommandRunner({')
      expect(call).toContain('broadcastCommandEvent?.(runId, msg)')
      expect(call).not.toContain('hub.broadcast(')
    })

    test('a `broadcastCommandEvent` forward-ref is declared and assigned inside attachWsRouter, the same pattern transportStats/inputStats already use', () => {
      expect(daemonSource).toContain('let broadcastCommandEvent: ((runId: string, msg: CommandRunnerEvent) => void) | null = null')
      expect(daemonSource).toContain('broadcastCommandEvent = handler.broadcastCommand')
    })
  })

  describe('bulk push and pull (plan 93 §4.6, §5 step 93.9)', () => {
    test('internal:push and internal:pull are registered beside internal:install, not just imported and left uncalled', () => {
      expect(daemonSource).toContain("import { createPushExecutor } from './jobs/executors/push'")
      expect(daemonSource).toContain("import { createPullExecutor } from './jobs/executors/pull'")
      expect(daemonSource).toContain("executors.register('internal:push', createPushExecutor({ transfer: transferService, broadcast: transferBroadcast }))")
      expect(daemonSource).toContain("executors.register('internal:pull', createPullExecutor({ transfer: transferService, broadcast: transferBroadcast }))")
    })

    test('transferBroadcast is a forward-ref into the WS router, not `hub.broadcast` — a 100-device bulk pull must stay subscriber-scoped, never farm-wide (F27)', () => {
      const call = extractCall(daemonSource, 'const transferBroadcast: TransferBroadcast = {')
      expect(call).toContain('broadcastTransferEvent?.(deviceId,')
      expect(call).not.toContain('hub.broadcast(')
    })

    test('a `broadcastTransferEvent` forward-ref is declared and assigned inside attachWsRouter, the same pattern broadcastCommandEvent already uses', () => {
      expect(daemonSource).toContain('let broadcastTransferEvent: ((deviceId: string, msg: ServerMessage) => void) | null = null')
      const attachBody = extractCall(daemonSource, 'const attachWsRouter = (localSessions: SessionManager | null) => {')
      expect(attachBody).toContain('broadcastTransferEvent = handler.broadcastTransfer')
    })
  })

  describe('the transfer registry and GET /api/transfers (plan 107 §3.1, §3.4, §4, step 107.2)', () => {
    test('transferRegistry is constructed unconditionally, beside transferService/transferBroadcast — not just imported and left uncalled', () => {
      expect(daemonSource).toContain("import { createTransferRegistry } from './device/transfer-registry'")
      expect(daemonSource).toContain('const transferRegistry = createTransferRegistry()')
    })

    test('transferBroadcast.progress AND .done both feed transferRegistry — the ONE seam that reaches every one of runTransfer\'s nine call sites without threading a new dependency through any of them (see transfer-registry.ts\'s own doc comment)', () => {
      const call = extractCall(daemonSource, 'const transferBroadcast: TransferBroadcast = {')
      const progressStart = call.indexOf('progress:')
      const doneStart = call.indexOf('done:')
      expect(progressStart).toBeGreaterThan(-1)
      expect(doneStart).toBeGreaterThan(progressStart)
      const progressBlock = call.slice(progressStart, doneStart)
      const doneBlock = call.slice(doneStart)
      expect(progressBlock).toContain('transferRegistry.progress(deviceId, transferId, kind, sent, total, origin)')
      expect(doneBlock).toContain('transferRegistry.done(deviceId, transferId, kind, ok, error, origin)')
    })

    test("createApp({...}) passes a real transferRegistryRoutes built from the SAME transferRegistry — without it, GET /api/transfers 404s through the catch-all even though the registry itself is being kept up to date", () => {
      expect(daemonSource).toContain("import { createTransferRegistryRoutes } from './api/transfers'")
      const call = extractCall(daemonSource, 'const app = createApp({')
      expect(call).toContain('transferRegistryRoutes: createTransferRegistryRoutes({ registry: transferRegistry })')
    })
  })

  describe('script results (plan 97 §3.4, §4.5, step 97.4): ExecutorHostDeps.maxResultBytes/resultSummaryFields actually wired — the sixteenth instance of this repo\'s "correct code, unreachable production call site" defect class', () => {
    test('createExecutorHost(...) passes a live maxResultBytes accessor — without it, every settle silently used the schema default (65_536) with no way to tune it from Studio', () => {
      const call = extractCall(daemonSource, 'const host = createExecutorHost({')
      expect(call).toContain('maxResultBytes: () => settingsStore.get().job.maxResultBytes')
    })

    test('createExecutorHost(...) also passes a resultSummaryFields accessor — declared but left absent is exactly the defect class this test guards against, even though it has no real producer yet (scripts.result_schema is plan 97 step 97.2\'s own remaining item)', () => {
      const call = extractCall(daemonSource, 'const host = createExecutorHost({')
      expect(call).toContain('resultSummaryFields:')
    })
  })

  describe('the action recorder (plan 94 §4.6, §5 step 94.3; docs/plans/96-m61-hotfixes.md continuing entry): fully built and tested in isolation, but `daemon.ts` never constructed it — the fifteenth instance of this repo\'s "correct code, unreachable production call site" defect class', () => {
    test('createRecordingService(...) is actually constructed from the SAME agentBlobStore/settingsStore this file already builds — not just imported and left uncalled', () => {
      expect(daemonSource).toContain("import { createRecordingService } from './recording/service'")
      const call = extractCall(daemonSource, 'const recordingService = createRecordingService({')
      expect(call).toContain('settings: () => settingsStore.get().recording')
      expect(call).toContain('blobs: agentBlobStore')
      expect(call).toContain("log: log.child('recording')")
    })

    test('createWsMessageHandler(...) passes recordingService as `recording` — without it, every recording.* WS message refuses E_NOT_SUPPORTED and the input.* tee is a permanent no-op in every real boot', () => {
      const call = extractCall(daemonSource, 'createWsMessageHandler({')
      expect(call).toContain('recording: recordingService')
    })

    test('a `stopRecordingForLeaseLost` forward-ref is declared and assigned inside attachWsRouter, the same pattern releaseLeaseHold/releaseShellSession already use', () => {
      expect(daemonSource).toContain('let stopRecordingForLeaseLost: ((deviceId: string) => void) | null = null')
      // Anchored extraction (plan 93 step 93.6 Task B) — see the identical
      // comment on the `reconcileMirrorForDevice` test above for why this is
      // `extractCall` against attachWsRouter's own opening brace, not a
      // fixed-length slice (this one used to be `attachStart + 7300`).
      const attachBody = extractCall(daemonSource, 'const attachWsRouter = (localSessions: SessionManager | null) => {')
      expect(attachBody).toContain('stopRecordingForLeaseLost = handler.stopRecordingForLeaseLost')
    })

    test('onManualRevoked (idle timeout, quarantine, forced disconnect) calls stopRecordingForLeaseLost — without it, a recording started under a revoked lease keeps capturing whatever the NEXT holder does, with no record of where the handover happened', () => {
      const call = extractCall(daemonSource, 'createLeaseManager({')
      const revokedStart = call.indexOf('onManualRevoked: (deviceId, reason, holderUserId) => {')
      expect(revokedStart).toBeGreaterThan(-1)
      const takenOverStart = call.indexOf('onManualTakenOver:')
      expect(takenOverStart).toBeGreaterThan(revokedStart)
      const revokedBlock = call.slice(revokedStart, takenOverStart)
      expect(revokedBlock).toContain('stopRecordingForLeaseLost?.(deviceId)')
    })

    test('onManualTakenOver ALSO calls stopRecordingForLeaseLost — a takeover revokes and acquires atomically without ever calling release(), so onManualRevoked never fires for it (the same reason this hook separately re-runs releaseShellSession/releaseLeaseReadinessHold/coControlRef.onPrimaryEnded above it)', () => {
      const call = extractCall(daemonSource, 'createLeaseManager({')
      const takenOverStart = call.indexOf('onManualTakenOver:')
      expect(takenOverStart).toBeGreaterThan(-1)
      const takenOverBlock = call.slice(takenOverStart, takenOverStart + 2000)
      expect(takenOverBlock).toContain('stopRecordingForLeaseLost?.(deviceId)')
    })

    /**
     * The four static pins above only prove `daemon.ts`'s TEXT contains the
     * right wiring — this test proves the actual MECHANISM, the same
     * "surface, not the helper" standard `withGuestAgentClient`'s own
     * end-to-end test above holds itself to: a real `LeaseManager`, wired
     * with the identical forward-ref SHAPE `daemon.ts` uses (`onManualRevoked`
     * calling a closure that is only assigned once the real `RecordingService`-
     * backed WS router exists), starts a recording over the real WS surface
     * and then loses its lease through `leases.releaseDevice(...)` — the
     * operator-forced-disconnect/quarantine/idle-timeout path, deliberately
     * NEVER `lease.release`, which already worked before this task (that path
     * calls `deps.recording?.stopForLeaseLost` inline in `ws-handlers.ts` and
     * proves nothing about the gap this task closes).
     */
    test('a lease revoked through leases.releaseDevice (never lease.release) ends an open recording, wired the exact way daemon.ts wires it', async () => {
      const opened = openDb(':memory:')
      runMigrations(opened.db)
      const db: Db = opened.db
      db.insert(devices).values({ id: 'dev-1', stableId: 'stable-dev-1', serial: 'serial-dev-1', label: 'recorder wiring phone', status: 'idle' }).run()

      const log = createLogger('test')
      const states = createDeviceStateMachine({ db, log })
      const jobStore = createJobStore(db)

      // The SAME forward-ref pattern `daemon.ts` uses for
      // `releaseShellSession`/`releaseLeaseHold`/`stopRecordingForLeaseLost`:
      // declared before the lease manager (which closes over it inside
      // `onManualRevoked`) and assigned only once the WS router — which owns
      // the real `RecordingService` handle — exists below.
      let stopRecordingForLeaseLost: ((deviceId: string) => void) | null = null

      const leases = createLeaseManager({
        states,
        jobStore,
        config: { jobTtlSec: 60, manualIdleTimeoutSec: 300, reaperIntervalMs: 5000 },
        log,
        onJobLeaseExpired: () => {},
        // Mirrors daemon.ts's real `onManualRevoked` for the ONE line this
        // task adds — the other side effects it also performs (shell
        // session, readiness hold, audit trail) are unrelated to this gap
        // and are already covered by their own pre-existing tests.
        onManualRevoked: (deviceId) => {
          stopRecordingForLeaseLost?.(deviceId)
        },
      })

      const recordingSettings: RecordingSettings = {
        anchorQuietMs: 400,
        anchorMinIntervalMs: 1_500,
        longPressMs: 400,
        maxSteps: 500,
        maxDurationSec: 900,
        captureScreenshots: false,
      }
      const recordingService = createRecordingService({
        settings: () => recordingSettings,
        blobs: createBlobStore(db),
        log,
      })

      const sink: InputSink = {
        id: 'fake-input',
        mode: 'uhid',
        tap: async () => {},
        swipe: async () => {},
        key: async () => {},
        text: async () => {},
        gesture: async () => {},
      }
      const session: DeviceSession = {
        deviceId: 'dev-1',
        transport: {} as unknown as Transport,
        display: {} as unknown as DisplaySource,
        input: sink,
        arbiter: createInputArbiter(sink, { queueWaitMs: () => 5_000, maxQueueDepth: () => 10, log }),
        displayEngineId: 'scrcpy',
        quality: 'control',
        inputEngineId: 'scrcpy-uhid',
        videoConfig: () => null,
        videoKeyframe: () => null,
        inspector: null,
        whenInspectorReady: async () => {},
        releaseInspector: async () => {},
        inspectorEngineId: 'ui-server',
        inspectorPollIntervalMs: 200,
        frameSize: { width: 1080, height: 2400 },
        clipboard: null,
        textInput: {
          mode: 'device',
          agentCapabilities: null,
          imeCurrent: false,
          commitViaAgent: async () => {
            throw new Error('not used')
          },
        },
        close: async () => {},
      } as unknown as DeviceSession
      const sessionManager: SessionManager = {
        async acquire() {
          return session
        },
        release() {},
        get: () => session,
        async closeDevice() {},
        async closeIfIdle() {},
        idleSessions: () => [],
        async closeAll() {
          return 0
        },
      }

      const deps: WsHandlerDeps = {
        sessions: sessionManager,
        pairing: {
          request: async () => {
            throw new Error('not used')
          },
          submitCode: async () => {
            throw new Error('not used')
          },
        },
        leases,
        jobs: {
          enqueue: () => {
            throw new Error('not used')
          },
          cancel: () => {
            throw new Error('not used')
          },
          get: () => null,
          list: () => ({ jobs: [], nextCursor: null, total: 0 }),
          assists: () => [],
          nodes: () => ({ items: [], finalized: false }),
          resume: () => {
            throw new Error('not used')
          },
        },
        broadcast: () => {},
        recorder: { record: () => {}, stop: async () => {} },
        audit: { record: () => {}, list: () => [] },
        isLogInputTextEnabled: () => false,
        roleOf: () => 'admin',
        shellSettings: () => ({ mode: 'admin', execTimeoutMs: 15_000, maxOutputBytes: 262_144 }),
        adbEndpoint: { open: async () => ({ host: '127.0.0.1', port: 0, expiresAt: 0 }), close: () => {}, get: () => null, closeAllForClient: () => {} },
        adb: () => null as unknown as AdbClient,
        crashPolicy: () => 'declared',
        targetPackagesForJob: () => [],
        saveCrashTrace: async () => ({ id: 'a', jobId: null, deviceId: null, kind: 'log', label: 'x', path: 'x', sizeBytes: 0, createdAt: 0 }),
        db,
        log,
        recording: recordingService,
      }
      const handler = createWsMessageHandler(deps)
      // The exact assignment `daemon.ts`'s own `attachWsRouter` makes once the handler exists.
      stopRecordingForLeaseLost = handler.stopRecordingForLeaseLost

      const sent: ServerMessage[] = []
      const ws = {
        readyState: 1,
        data: { userId: null },
        send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
        getBufferedAmount: () => 0,
      } as unknown as ServerWebSocket<unknown>
      handler.handleOpen(ws)
      await handler.handleMessage(ws, JSON.stringify({ type: 'lease.acquire', id: 'l1', payload: { deviceId: 'dev-1' } }))

      await handler.handleMessage(ws, JSON.stringify({ type: 'recording.start', id: 'r1', payload: { deviceId: 'dev-1' } }))
      const startReply = sent.find((m) => m.type === 'recording.state' && m.id === 'r1')
      expect(startReply?.type === 'recording.state' ? startReply.payload : undefined).toMatchObject({ active: true, stepCount: 0 })
      expect(recordingService.get('dev-1')).not.toBeNull()

      // NOT `lease.release` — the automatic-revocation path (idle timeout,
      // quarantine, an operator's forced Disconnect), which real
      // `LeaseManager` internals and `AdbCycleReport`'s drain both reach
      // through `releaseDevice`/`release(..., reason)`, never through the WS
      // `lease.release` message this gap's OWN feature already handled
      // before this task.
      const released = leases.releaseDevice?.('dev-1', 'quarantined')
      expect(released).toBe(true)

      // The session is dropped from the registry SYNCHRONOUSLY inside
      // `stopForLeaseLost` (`recording/service.ts`'s `finishAndReport`), but
      // building the finished `RecordingDoc` (`finishAndBuild()`) is async —
      // give its promise chain a few microtask turns to settle, the same
      // pattern `ws-handlers-recording.test.ts`'s own maxSteps-bound test uses.
      expect(recordingService.get('dev-1')).toBeNull()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      const doc = recordingService.lastFinished('dev-1')
      expect(doc).not.toBeNull()
    })
  })

  describe('saved commands (plan 93 §3.10, §4.4, step 93.6): the /api/saved-commands mount that was blocked on server/http.ts being held', () => {
    test("daemon.ts's createApp({...}) call constructs and passes a real savedCommandRoutes — without it, HttpDeps.savedCommandRoutes is always absent and /api/saved-commands 404s through the catch-all forever", () => {
      expect(daemonSource).toContain("import { createSavedCommandRoutes } from './api/saved-commands'")
      const call = extractCall(daemonSource, 'const app = createApp({')
      expect(call).toContain('savedCommandRoutes: createSavedCommandRoutes(')
    })

    test('createSavedCommandRoutes(...) passes the SAME role-resolution expression commandRunRoutes above uses — an operator\'s owner-or-admin edit/delete gate must agree with the fleet command console\'s own permission model', () => {
      const call = extractCall(daemonSource, 'createSavedCommandRoutes({')
      expect(call).toContain('db,')
      expect(call).toContain('settings: () => settingsStore.get().shell')
      expect(call).toContain("authMode === 'local'")
      expect(call).toContain('audit,')
    })
  })

  describe('the sidebar\'s farm-health badge (plan 126 §3.5, step 126.5): HttpDeps.failedPluginCount is optional, so nothing but this test notices if it is never wired', () => {
    /**
     * `failedPlugins` on `GET /api/health` exists so Studio's `AppShell`
     * can stop fetching `GET /api/plugins` on every page to derive one
     * integer — at the time, every plugin's full built bundle, ~1 MB per
     * version row, downloaded and discarded (plan 126 §0.4). The shell no
     * longer has that fetch to fall back on, so an unwired accessor here
     * means the badge is silently absent forever: the field is simply
     * omitted, the sidebar renders no warning, and every plugin could be
     * `failed` without a single visible sign.
     */
    test("daemon.ts's createApp({...}) passes a live failedPluginCount accessor", () => {
      const call = extractCall(daemonSource, 'const app = createApp({')
      expect(call).toContain('failedPluginCount: () =>')
    })

    /**
     * The COUNT(*), pinned as source rather than behaviour because the
     * cheap version and the ruinous one return the identical number. Plan
     * 126 §0.5 found `db.select().from(scripts)...all().length` on the
     * plugin-counting path and step 126.1 fixed it; health is POLLED, and
     * every materialised `plugins` row carries the full bundle
     * (`db/schema.ts:1865`), so re-introducing the pattern here would be
     * strictly worse than the bug this plan opened on.
     */
    test('it counts in SQL — `count(*)` with the status filter, never a materialised list whose rows each carry a ~1 MB bundle', () => {
      // Sliced by hand rather than through `extractCall`: this accessor is an
      // arrow expression, not a `name({` region, so there is no brace pair to
      // balance. The upper bound is the next key in the same object literal.
      const call = extractCall(daemonSource, 'const app = createApp({')
      const from = call.indexOf('failedPluginCount: () =>')
      expect(from).toBeGreaterThan(-1)
      const accessor = call.slice(from, call.indexOf("log: log.child('http')", from))
      expect(accessor).toContain('count(*)')
      expect(accessor).toContain("eq(plugins.status, 'failed')")
      expect(accessor).not.toContain('.all()')
    })
  })

  describe("a batch's runtimeOverride ceiling check (docs/plans/96-m61-hotfixes.md §96.18): BatchRoutesDeps.farmJobSettings existed and was documented but nothing constructed it", () => {
    test('createBatchRoutes(...) passes a live `farmJobSettings` accessor — without it, E_RUNTIME_OVER_CEILING can never fire for a batch override, no matter how large', () => {
      const call = extractCall(daemonSource, 'createBatchRoutes({')
      expect(call).toContain('farmJobSettings: () => settingsStore.get().job')
    })

    /**
     * Found while wiring the above: `services/job-service.ts`'s own
     * `createJobService(...)` — the SINGLE-job enqueue path, not the batch
     * one — has the identical optional `farmJobSettings?: () => JobSettings`
     * on `JobServiceDeps` (steps 98.5/98.7), and `daemon.ts`'s one real call
     * site did not pass it either, for the exact same reason: an unwired
     * getter resolves to `DEFAULT_FARM_JOB_SETTINGS`, so a single job's own
     * `runtimeOverride` ceiling check ran but could never actually refuse
     * anything on a real farm. `api/batches.ts`'s own doc comment on
     * `farmJobSettings` claimed this call site "already builds" the
     * accessor — it did not; this test pins the real fix alongside it so
     * the same claim cannot go stale silently a second time.
     */
    test('createJobService(...) ALSO passes a live `farmJobSettings` accessor — the single-job enqueue path has the identical dormant-ceiling gap batches had', () => {
      const call = extractCall(daemonSource, 'createJobService({')
      expect(call).toContain('farmJobSettings: () => settingsStore.get().job')
    })
  })

  describe('JobExecutor.requires — the dispatch gate (plan 93 §3.12, §4.6, step 93.8, closing F10): four production call sites, each pinned separately per the brief\'s own "21 times in three days" warning', () => {
    test('createJobService(...) passes live shellMode/transferEnabled — without them, POST /api/jobs {scriptId:\'internal:install\'} checks no permission at all', () => {
      const call = extractCall(daemonSource, 'createJobService({')
      expect(call).toContain('shellMode: () => settingsStore.get().shell.mode')
      expect(call).toContain('transferEnabled: () => settingsStore.get().transfer.enabled')
    })

    test("createBatchRoutes(...) passes live shellMode/transferEnabled — without them, POST /api/batches {scriptId:'internal:install'} checks no permission at all", () => {
      const call = extractCall(daemonSource, 'batchRoutes: createBatchRoutes({')
      expect(call).toContain('shellMode: () => settingsStore.get().shell.mode')
      expect(call).toContain('transferEnabled: () => settingsStore.get().transfer.enabled')
    })

    test('createScheduleRoutes(...) passes live shellMode/transferEnabled — the interactive POST/PATCH schedule-write gate', () => {
      const call = extractCall(daemonSource, 'scheduleRoutes: createScheduleRoutes({')
      expect(call).toContain('shellMode: () => settingsStore.get().shell.mode')
      expect(call).toContain('transferEnabled: () => settingsStore.get().transfer.enabled')
    })

    /**
     * The FOURTH call site — the real cron-fired dispatcher, not
     * `api/schedules.ts`'s own `runnerDeps` (that file's `fireOnce` closure
     * only serves `run-now`; the schedule that actually wakes on its own
     * timer is the `scheduleRunner` built here). Without this one wired, a
     * schedule targeting `internal:install` would dispatch ungated on every
     * real cron firing even though the interactive create/edit routes above
     * refuse it — the exact "correct code, one production call site never
     * passed it" shape this file exists to catch.
     */
    test('scheduleRunner = createScheduleRunner(...)\'s validateScript closure reads live shellMode/transferEnabled too — the cron-fired path, not just run-now', () => {
      const call = extractCall(daemonSource, 'scheduleRunner = createScheduleRunner({')
      expect(call).toContain('validateScriptForRun(')
      expect(call).toContain('shellMode: () => settingsStore.get().shell.mode')
      expect(call).toContain('transferEnabled: () => settingsStore.get().transfer.enabled')
    })
  })

  describe('the bulk-pull archive route (plan 93 §3.13, §4.4, §4.7, step 93.10): GET /api/batches/:id/artifacts.zip needs a real app-data root and a live archive-size cap, or it silently falls back to empty entries and the protocol default', () => {
    test('createBatchRoutes(...) passes a real `dataDir` — without it, every collected-file entry in the zip resolves to an empty placeholder instead of the actual file', () => {
      const call = extractCall(daemonSource, 'batchRoutes: createBatchRoutes({')
      expect(call).toContain('dataDir: cfg.dataDir')
    })

    test('createBatchRoutes(...) passes a live `archiveSettings` accessor — without it, `transfer.maxArchiveBytes` can be changed in Settings and the archive route never notices', () => {
      const call = extractCall(daemonSource, 'batchRoutes: createBatchRoutes({')
      expect(call).toContain('archiveSettings: () => settingsStore.get().transfer')
    })
  })

  /**
   * Plan 108 §4.5, §5 steps 108.4/108.5 — `PluginRoutesDeps.data` and
   * `PluginRoutesDeps.actions` are OPTIONAL by construction: when either is
   * absent its routes are not registered at all (`api/plugins.ts`'s own `if
   * (deps.data)` / `if (deps.actions)` blocks), rather than registered and
   * failing at request time. Both steps were written while `daemon.ts` was
   * held by a concurrent builder, so both shipped fully implemented and
   * fully tested — and structurally unreachable in a real boot, the exact
   * shape of defect this whole file exists to catch. These tests pin the
   * closing wiring: the two bags on the real call, the shared batch-dispatch
   * factory behind `actions.batch`, and the fact that the routes genuinely
   * appear only when the bags are passed.
   */
  describe("the plugin data and action routes (plan 108 §4.5, steps 108.4/108.5): two dependency bags that were declared, implemented, tested — and never passed", () => {
    test('createPluginRoutes(...) passes `data: { db, kv: kvStore }` — without it, all five /:name/data/* routes are absent from a real boot', () => {
      const call = extractCall(daemonSource, 'pluginRoutes: createPluginRoutes({')
      expect(call).toContain('data: { db, kv: kvStore }')
    })

    test('createPluginRoutes(...) passes an `actions` bag reaching the real script registry, kv store, jobService and batch factory — without it, POST /:name/action/:actionId is absent and every plugin screen button 404s', () => {
      const call = extractCall(daemonSource, 'pluginRoutes: createPluginRoutes({')
      const actionsAt = call.indexOf('actions: {')
      expect(actionsAt).toBeGreaterThan(-1)
      const actions = call.slice(actionsAt)
      expect(actions).toContain('registry: scriptRegistry')
      expect(actions).toContain('kv: kvStore')
      expect(actions).toContain('jobService,')
      expect(actions).toContain('batch: (actor) =>')
      expect(actions).toContain('createBatchDispatchDeps(')
      expect(actions).toContain('getDeviceOwner')
      expect(daemonSource).toContain("import { createBatchRoutes, createBatchDispatchDeps } from './api/batches'")
    })

    /**
     * The point of the extraction: `actions.batch` must not be a second,
     * hand-rolled `BatchDispatchDeps` literal. It calls the SAME exported
     * factory `POST /api/batches` itself calls, over the SAME live
     * accessors, so a batch dispatched from a plugin screen and one
     * dispatched from the Batches page are provably gated identically.
     */
    test("the `batch` host bag is the SAME set of live accessors createBatchRoutes gets — two copies of that literal are how the two dispatch paths would come to disagree", () => {
      const pluginCall = extractCall(daemonSource, 'pluginRoutes: createPluginRoutes({')
      const batchCall = extractCall(daemonSource, 'batchRoutes: createBatchRoutes({')
      for (const accessor of [
        'registry: executors',
        'findScript,',
        'scriptRegistry,',
        'farmJobSettings: () => settingsStore.get().job',
        'pacer,',
        'shellMode: () => settingsStore.get().shell.mode',
        'transferEnabled: () => settingsStore.get().transfer.enabled',
      ]) {
        expect(batchCall).toContain(accessor)
        expect(pluginCall).toContain(accessor)
      }
    })

    /**
     * The static pins above only prove `daemon.ts`'s TEXT calls the factory —
     * this proves what the factory actually hands back, against a real `Db`
     * and a real `ExecutorRegistry`: both gates present, both live, and both
     * reading the ACTOR rather than being baked in at construction time
     * (which is the whole reason `PluginActionDeps.batch` is a per-actor
     * factory and not a fixed bag).
     */
    test('createBatchDispatchDeps(...) produces deps carrying a REAL role-aware validateScript and a REAL identity-aware assertDeviceAllowed', () => {
      const opened = openDb(':memory:')
      runMigrations(opened.db)
      const db: Db = opened.db
      db.insert(devices).values({ id: 'dev-owned', stableId: 'stable-owned', serial: 'serial-owned', label: 'another operator phone', status: 'idle', ownerId: 'user-other' }).run()
      db.insert(devices).values({ id: 'dev-free', stableId: 'stable-free', serial: 'serial-free', label: 'unowned phone', status: 'idle' }).run()

      const registry = new ExecutorRegistry()
      registry.register('internal:install', { validateParams: (p) => p, run: async () => undefined, requires: { gate: 'files' } })

      const host: BatchDispatchHostDeps = {
        db,
        scheduler: {} as BatchDispatchHostDeps['scheduler'],
        audit: { record: () => {}, list: () => [] } as unknown as AuditLogger,
        registry,
        findScript: () => null,
        shellMode: () => 'admin',
        transferEnabled: () => true,
      }

      // The role half (plan 93 §3.12's `JobExecutor.requires` gate): under
      // `shell.mode: admin`, an operator may not run a `files` script — the
      // same refusal `POST /api/batches` gives them.
      const operator = createBatchDispatchDeps(host, { id: 'user-1', role: 'operator' })
      expect(() => operator.validateScript?.('internal:install', {})).toThrow('device.files')
      const admin = createBatchDispatchDeps(host, { id: 'user-2', role: 'admin' })
      expect(admin.validateScript?.('internal:install', {})).toEqual({})

      // The identity half (`canUseDevice`, plan 34 §3.5): a device owned by
      // someone else refuses the WHOLE batch before a row is written.
      expect(() => operator.assertDeviceAllowed?.('dev-owned')).toThrow('belongs to another user')
      expect(() => operator.assertDeviceAllowed?.('dev-free')).not.toThrow()
      expect(() => admin.assertDeviceAllowed?.('dev-owned')).not.toThrow()

      // No interactive caller at all (`PluginActionActor` is `null` for a
      // non-interactive dispatch, the same convention the cron-fired path
      // in `schedules/runner.ts` has): neither gate applies.
      const cron = createBatchDispatchDeps(host, null)
      expect(() => cron.assertDeviceAllowed?.('dev-owned')).not.toThrow()
      expect(cron.validateScript?.('internal:install', {})).toEqual({})
    })

    /**
     * And the consequence of the two bags, on the real router: the six
     * routes are registered when they are passed and genuinely missing when
     * they are not — so the static pins above are pinning something that
     * matters, not a decorative key.
     */
    test('the five /:name/data/* routes and POST /:name/action/:actionId are registered by createPluginRoutes ONLY when `data`/`actions` are passed', () => {
      // Construction-time stubs: `createPluginRoutes` only stores these on
      // closures (the surface registry and the action executor are both
      // lazy), and this test never sends a request — it inspects Hono's own
      // route table. The real behaviour of each route is covered by
      // `api/plugins-data.test.ts` and `plugins/action-executor.test.ts`.
      const base = {
        runtime: {} as unknown as PluginRuntime,
        audit: { record: () => {}, list: () => [] } as unknown as AuditLogger,
        workspace: {} as unknown as WorkspaceStore,
      }
      const bags = {
        data: { db: {} as unknown as Db, kv: {} as unknown as KvStore },
        actions: {
          registry: {} as unknown as ScriptRegistry,
          kv: {} as unknown as KvStore,
          jobService: { enqueue: () => { throw new Error('not used') } } as unknown as Pick<JobService, 'enqueue'>,
          batch: () => createBatchDispatchDeps({ db: {} as unknown as Db, scheduler: {} as BatchDispatchHostDeps['scheduler'], audit: base.audit, registry: new ExecutorRegistry(), findScript: () => null }, null),
        },
      }
      const pathsOf = (app: ReturnType<typeof createPluginRoutes>): Set<string> => new Set(app.routes.map((r) => `${r.method} ${r.path}`))

      const without = pathsOf(createPluginRoutes(base))
      const with_ = pathsOf(createPluginRoutes({ ...base, ...bags }))

      for (const route of [
        'GET /:name/data',
        'PUT /:name/data/entry',
        'DELETE /:name/data/entry',
        'GET /:name/data/count',
        'GET /:name/data/scan',
        'POST /:name/action/:actionId',
      ]) {
        expect(without.has(route)).toBe(false)
        expect(with_.has(route)).toBe(true)
      }
    })
  })
})

/**
 * The bounded subnet sweep (plan 88 §3.5, §4.5, §5 step 88.3): `createSweeper`
 * was fully built and unit-tested (`registry/sweep.test.ts`) but never
 * constructed or wired into `daemon.ts` — the seventeenth-ish instance of
 * this file's own dominant "correct code, unreachable production call site"
 * defect class (see the file-level comment above). Two independent surfaces
 * were broken by the SAME missing wiring: `POST /api/devices/scan` always
 * threw `E_NOT_SUPPORTED` (`deps.sweeper` was never passed to
 * `createDeviceRoutes`), and the reconnect ladder's step 4 (`allowSweep`)
 * was permanently unreachable (`createDeviceReconnector`'s own optional
 * `sweeper` dep was never passed either) — an exhausted ladder always
 * reported `not-found` regardless of what a caller passed for `allowSweep`.
 * `docs/plans/96-m61-hotfixes.md` records the fix.
 */
describe("the bounded subnet sweep (plan 88 §3.5, §4.5, §5 step 88.3): createSweeper actually constructed and threaded into BOTH POST /api/devices/scan and the reconnect ladder's allowSweep step", () => {
  test('a single Sweeper is constructed via createSweeper(...), reading the live discovery settings, BEFORE the reconnect ladder — the ladder needs this SAME instance, not a second one', () => {
    const call = extractCall(daemonSource, 'const sweeper = createSweeper({')
    expect(call).toContain('client: adb')
    expect(call).toContain('db,')
    expect(call).toContain('endpoints,')
    expect(call).toContain('registry,')
    expect(call).toContain('settings: () => settingsStore.get().discovery')
    expect(call).toContain("hub: { broadcast: (msg) => hub.broadcast(msg) }")
    expect(call).toContain("log: log.child('sweep')")
    expect(daemonSource).toContain('sweeperRef = sweeper')

    // Construction order matters: the ladder's own `sweeper` dep (asserted
    // below) can only be the real instance if it is built first.
    const sweeperAt = daemonSource.indexOf('const sweeper = createSweeper({')
    const reconnectorAt = daemonSource.indexOf('reconnector = createDeviceReconnector({')
    expect(sweeperAt).toBeGreaterThan(-1)
    expect(reconnectorAt).toBeGreaterThan(-1)
    expect(sweeperAt).toBeLessThan(reconnectorAt)
  })

  test('createDeviceReconnector(...) is given the real sweeper — without it, opts.allowSweep is permanently a no-op and an exhausted ladder can never fall through to a scan', () => {
    const call = extractCall(daemonSource, 'reconnector = createDeviceReconnector({')
    expect(call).toContain('sweeper,')
    // The stale gap comment ("no sweep branch yet") must not survive this fix
    // silently claiming a gap that is now closed — doc drift of exactly the
    // kind this session has been correcting elsewhere.
    expect(daemonSource).not.toContain('no sweep branch yet')
  })

  test("deviceRoutes: createDeviceRoutes({...}) passes a `sweeper` that forwards to the live sweeperRef — without it, POST /api/devices/scan always threw E_NOT_SUPPORTED on a real boot no matter how correctly Studio's 'Scan network' button called it", () => {
    const call = extractCall(daemonSource, 'deviceRoutes: createDeviceRoutes({')
    expect(call).toContain('sweeper: {')
    expect(call).toContain('sweeperRef?.sweep(opts)')
    // Orchestrator mode / "adb subsystem not ready yet" must still refuse
    // E_NOT_SUPPORTED, not crash on a null sweeper — the wrapper rejects
    // with the exact coded error the route used to throw for a missing dep.
    expect(call).toContain('E_NOT_SUPPORTED')
    expect(call).toContain('network scanning is not available')
  })

  test('sweeperRef is cleared in stop() — a request racing shutdown must fail closed, not reach a torn-down adb/db', () => {
    const stopIdx = daemonSource.indexOf('reconnector = null')
    expect(stopIdx).toBeGreaterThan(-1)
    const tail = daemonSource.slice(stopIdx, stopIdx + 600)
    expect(tail).toContain('sweeperRef = null')
  })
})

/**
 * Plan 109 (M74 — the plugin runtime) §4.2, step 109.2. The host loads a
 * plugin's own code into THIS process, so where its two calls sit in `start()`
 * is not a detail — it is the difference between "a broken plugin is a failed
 * row on a page that works" and "the core never answers `/api/health` at all".
 * Asserted against the file's own text, the same way every other rule about
 * one production call site in this file is.
 */
describe('daemon.ts — the plugin runtime host (plan 109 §4.2, step 109.2)', () => {
  test('createPluginRuntime(...) passes `onLifecycle`, so activating a plugin loads its service and disabling one unloads it', () => {
    const call = extractCall(daemonSource, 'createPluginRuntime({')
    expect(call).toContain('onLifecycle:')
    expect(call).toContain('pluginHost?.handleLifecycle(event)')
  })

  test('createRuntimeHost(...) is given the plugin registry, the KV store and a stableId resolver — never a Db', () => {
    const call = extractCall(daemonSource, 'pluginHost = createRuntimeHost({')
    expect(call).toContain('plugins: pluginRuntime')
    expect(call).toContain('store: kvStore')
    expect(call).toContain('resolveStableId:')
    // `plugin-context.ts`'s criterion-11 claim is "true by construction": the
    // host never holds a database handle to leak into a plugin's context.
    expect(call).not.toContain('db,')
  })

  test('loadActive() runs AFTER Bun.serve — a plugin whose setup hangs must not be able to stop the core from listening', () => {
    const listen = daemonSource.indexOf('server = Bun.serve({')
    const load = daemonSource.indexOf('pluginHost?.loadActive()')
    expect(listen).toBeGreaterThan(-1)
    expect(load).toBeGreaterThan(listen)
    // And not awaited: `start()` returning must not wait on plugin code.
    expect(daemonSource).toContain('void pluginHost?.loadActive()')
  })

  test('stop() unloads every service — running each plugin`s onStop disposers BEFORE the database they may write through is closed', () => {
    const unload = daemonSource.indexOf("await pluginHost?.unloadAll('the core is shutting down')")
    const closeDb = daemonSource.indexOf('opened?.sqlite.close()')
    expect(unload).toBeGreaterThan(-1)
    expect(closeDb).toBeGreaterThan(unload)
    // And the process-level unhandledRejection handler the host installs is
    // removed, so a stopped core leaves the runtime exactly as it found it.
    expect(daemonSource).toContain('pluginHost?.dispose()')
  })
})

/**
 * Plan 109 §4.3, step 109.3 — the capability broker. The defect this guards
 * against is the one this whole file exists for: `ctx.farm` is an OPTIONAL
 * port on both hosts (`RuntimeHostDeps.farm`, `JobRunnerDeps.farm`), and each
 * one fails closed with `E_FARM_UNAVAILABLE` when it is absent. So a build
 * that simply never passed the broker would not crash, would not fail a unit
 * test, and would refuse every plugin's every capability call forever, with a
 * message that reads like a design decision.
 */
describe('daemon.ts — the capability broker (plan 109 §4.3, step 109.3)', () => {
  test('createRuntimeHost(...) is given the broker, so a plugin SERVICE`s ctx.farm reaches it', () => {
    const call = extractCall(daemonSource, 'pluginHost = createRuntimeHost({')
    expect(call).toContain('farm:')
    expect(call).toContain('farmBroker')
  })

  test('createJobRunner(...) is given the same broker, so a plugin MEMBER SCRIPT`s ctx.farm reaches it too', () => {
    const call = extractCall(daemonSource, 'const runner = createJobRunner({')
    expect(call).toContain('farm: farmRunnerPort')
  })

  test('the broker is built once, from the real registry, the real capability context deps, and the audit logger', () => {
    const call = extractCall(daemonSource, 'farmBroker = createFarmBroker({')
    expect(call).toContain('registry: capabilityRegistry')
    expect(call).toContain('contextDeps: capContextDeps')
    expect(call).toContain('plugins: pluginRuntime')
    expect(call).toContain('audit,')
    // The plugin principal's role follows its publisher, resolved live — a
    // hardcoded role here would be an authority decision made in the wiring
    // rather than by the ACL.
    expect(call).toContain('roleOf:')
  })

  test('the broker is assigned before Bun.serve — plugin code only runs after listening, so the forward-ref refusal is unreachable in a booted farm', () => {
    const assigned = daemonSource.indexOf('farmBroker = createFarmBroker({')
    const listen = daemonSource.indexOf('server = Bun.serve({')
    expect(assigned).toBeGreaterThan(-1)
    expect(listen).toBeGreaterThan(assigned)
  })
})

/**
 * Plan 118 §4.1, step 118.1, acceptance criterion 1 (§6) — `GET /api/health`
 * used to call `adb.version()` on every single request, an uncached TCP
 * round-trip that measured 3300ms in production logs on a contended Windows
 * adb port (plan 118 §0.2 item 2). `createAdbServerVersionAccessor` is a
 * genuine, exported unit — unlike the rest of this file's assertions, which
 * read `daemon.ts`'s own text because `createDaemon`'s boot sequence has no
 * seam a test can drive (this file's header comment), this one small piece
 * was pulled out specifically so a test could drive it directly, with a fake
 * `adb`, and actually count calls rather than merely assert the wiring text
 * looks right.
 */
describe('daemon.ts — the /api/health adb-version cache (plan 118 §4.1, step 118.1)', () => {
  test('10 calls within 5 seconds trigger exactly one underlying adb.version() call', async () => {
    let calls = 0
    const fakeAdb = { version: async () => { calls++; return '36.0.0' } }
    const accessor = createAdbServerVersionAccessor(() => fakeAdb, 5_000)

    for (let i = 0; i < 10; i++) {
      expect(await accessor()).toBe('36.0.0')
    }
    expect(calls).toBe(1)
  })
})
