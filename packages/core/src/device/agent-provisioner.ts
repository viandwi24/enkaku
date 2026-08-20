import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { AdbClient } from '@enkaku/adb'
import {
  DEFAULT_AGENT_STATUS,
  DevicePreparationSchema,
  type AgentState,
  type AgentStatus,
  type DevicePreparation,
  type GuestAgentCapability,
  type HelloResult,
} from '@enkaku/protocol'
import {
  GuestAgentClientError,
  GUEST_AGENT_PACKAGE,
  GUEST_AGENT_REPAIRABLE_ERROR_CODES,
  createGuestAgentLauncher,
  type GuestAgentArtifactMismatch,
  type GuestAgentLauncher,
} from '@enkaku/drivers'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import type { EventRecorder } from '../events/recorder'
import type { Logger } from '../util/logger'
import { EnkakuError } from '../util/errors'
import { hasExhaustedRetryBudget, isWithinBackoffWindow, nextBoundedRetry } from './bounded-retry'
import { GUEST_AGENT_COMPONENT_ID, deriveGuestAgentIdentity, deriveGuestAgentPreparation } from './preparation/guest-agent-status'

/**
 * Provisioning: one agent on every phone (plan 90 §3.8, §4.3, fixes F7, F9,
 * F10). Owns `devices.agent` — the persisted answer to "does this device
 * have a working, current guest agent" — independent of whether a session is
 * open or a network route exists (§3.8's decision: the agent is a DEVICE
 * property, not a session step, because a route must work with no session at
 * all, spec §7.9 rule 1).
 *
 * `ensureInstalled()`'s `verify → install → repair once → degrade` algorithm
 * lives in `packages/drivers/src/network/guest-agent/launcher.ts` (F8's
 * pattern, copied from `ui-server/launcher.ts`); this module is the thing
 * that DECIDES when to call it, bounds the retries across separate calls,
 * confirms real liveness with a `hello()` handshake, and persists the
 * result — plan 41's on-device verification pattern applied to the second
 * artifact this codebase provisions unattended.
 */

/**
 * Android 10 (API 29) — the floor the agent design leans on (VpnService
 * behaviour is only proven from here, plan 44 §4.1, docs/research/android-guest-agent.md).
 * Single source of truth: `packages/core/src/api/guest-agent.ts` imports
 * this rather than keeping its own copy (00-overview §4.3, "replace, never
 * version" — this module is the newer, more general home for "is this
 * device eligible for the guest agent").
 */
export const MIN_SUPPORTED_SDK = 29

/** Mirrors network-route recovery's own shape (plan 90 §3.7) — three bounded attempts, same schedule. */
const DEFAULT_RETRY_BACKOFF_S = [5, 20, 60]

export interface AgentProvisionerDeps {
  db: Db
  /** Per-device shell exec, through the adb queue — the same shape `guestAgentExec` in `daemon.ts` already builds for `createGuestAgentRoutes`. */
  exec: (serial: string, cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>
  /**
   * CLI-level adb (install/uninstall/forward) — the SAME bounded helper
   * `daemon.ts` builds once (`hostAdbHandle.run`, plan 85 §3.4, §4.5), so
   * installs ride `adb.maxInstallConcurrent` and per-device serialisation
   * (F12), never a second concurrency mechanism.
   */
  hostAdb: (args: string[], opts?: { lane?: 'default' | 'install'; serial?: string }) => Promise<string>
  /**
   * The direct-socket forward/list-forward/killForward trio (plan 119 §4.1, §4.2) — threaded
   * straight through to `createGuestAgentLauncher`'s own `adb` dep, replacing the `hostAdb`-spawned
   * `adb.exe` calls `forward()`/`removeForward()` used to make on every `hello()` reconnect. See
   * `GuestAgentLauncherDeps['adb']`'s doc comment for the inference caveat on two of the three wire
   * shapes.
   */
  adb: Pick<AdbClient, 'forward' | 'listForward' | 'killForward'>
  apkPath: () => Promise<string>
  /**
   * The manifest's on-device expectation for the CURRENT pinned build (plan
   * 90 §3.8, F6's fix — the manifest previously had no `guest-agent` entry
   * at all). `null` when the manifest carries none (an unresolved tier-3
   * pin, or an old manifest) — `ensureInstalled()` then verifies presence
   * only, never blocking on missing metadata of our own.
   */
  expectedArtifact: () => Promise<{ versionCode?: number; signatureSha256?: string } | null>
  /**
   * A live `hello()` handshake, run through the SAME per-device session a
   * network route already owns when one exists (plan 44 §8b's "Bug 1" fix)
   * — `daemon.ts` wires this to `guestAgent.withGuestAgentClient`, never a
   * second, independent bootstrap that would rotate the route's live token
   * out from under it.
   */
  hello: (deviceId: string) => Promise<HelloResult>
  /** `guestAgent.provision` (plan 90 §3.8, §4.4), read fresh on every call — the same "read settings live" discipline every settings-derived accessor in this codebase already follows. */
  provision: () => 'auto' | 'manual' | 'off'
  /** Main-stream device events: `device.agent` (plan 90 §4.3). */
  record?: EventRecorder['record']
  log: Logger
  /** Test seam — defaults to the real `createGuestAgentLauncher`. */
  makeLauncher?: (
    row: DeviceRow,
    opts: { expectedArtifact?: { versionCode?: number; signatureSha256?: string }; onMismatch: (info: GuestAgentArtifactMismatch) => void },
  ) => GuestAgentLauncher
  /** Bounded-retry backoff on `failed` (plan 90 §3.8), matching route recovery's own `[5, 20, 60]` shape. Test seam so a "gives up after N attempts" test does not sit out real wall-clock time. */
  retryBackoffS?: number[]
  /** Test seam — replaces `Date.now()`. */
  now?: () => number
}

export interface AgentProvisionReport {
  total: number
  results: Array<{ deviceId: string; state: AgentState; reason: string | null }>
}

export interface AgentProvisioner {
  /** Verify → install → repair once → degrade (F8). Idempotent; safe to call on every hook. Never throws for a device that exists — every failure is captured as `state: 'failed'`. */
  ensure(deviceId: string, opts?: { force?: boolean }): Promise<AgentStatus>
  /** The persisted row, Zod-validated — never issues an adb call of its own. */
  status(deviceId: string): Promise<AgentStatus>
  /** Every device currently online (offline devices are unreachable by construction — nothing to verify), bounded by the install lane. Returns a per-device report. */
  ensureAll(opts?: { force?: boolean }): Promise<AgentProvisionReport>
  /** Uninstall + clear the row. Route/label teardown happens first, by the existing paths (the caller's responsibility — mirrors `DELETE /:id/guest-agent`'s own ordering). */
  remove(deviceId: string, actor: string | null): Promise<AgentStatus>
  /**
   * Plan 106 §5 step 106.7 — mirrors `preparation/runner.ts`'s own
   * `runningSince`: unix seconds since `runOnePass` started for this
   * device, or `null` when no pass is currently executing. In-memory only,
   * never persisted and never routed through `maybeRecordTransition` — the
   * same reasoning `runner.ts`'s doc comment gives (reverting a persisted
   * intermediate state on an `E_ADB_UNAVAILABLE` defer, or on a core crash
   * mid-install, is exactly the hazard this stays out of by never writing
   * one in the first place).
   */
  runningSince(deviceId: string): number | null
}

function nowSeconds(now: () => number): number {
  return Math.floor(now() / 1000)
}

/**
 * Reads the guest agent's status, recombined from its two authoritative
 * sources (plan 106 §5 step 106.5): `devices.preparation['guest-agent']`
 * for `state`/`reason`/`checkedAt`/`attempts`/`nextAttemptAt`, and
 * `devices.agent` (narrowed) for `appVersion`/`versionCode`/`androidSdkInt`/
 * `capabilities`. Zod-validated on both sides (CLAUDE.md: never trust a
 * JSON DB column) via `guest-agent-status.ts`'s own derive functions, which
 * this module shares with `registry/device-registry.ts`'s `deriveAgentState`
 * — one place decides how to read these two columns, not two.
 */
function readCached(row: DeviceRow, log: Logger): AgentStatus {
  const prep = deriveGuestAgentPreparation(row, log)
  const identity = deriveGuestAgentIdentity(row, log)
  return {
    state: prep.state,
    appVersion: identity.appVersion,
    versionCode: identity.versionCode,
    androidSdkInt: identity.androidSdkInt,
    capabilities: identity.capabilities,
    reason: prep.reason,
    checkedAt: prep.checkedAt,
    attempts: prep.attempts,
    nextAttemptAt: prep.nextAttemptAt,
  }
}

export function createAgentProvisioner(deps: AgentProvisionerDeps): AgentProvisioner {
  const { db } = deps
  const now = deps.now ?? (() => Date.now())
  const retryBackoffS = deps.retryBackoffS ?? DEFAULT_RETRY_BACKOFF_S
  const makeLauncher =
    deps.makeLauncher ??
    ((row: DeviceRow, opts: { expectedArtifact?: { versionCode?: number; signatureSha256?: string }; onMismatch: (info: GuestAgentArtifactMismatch) => void }): GuestAgentLauncher =>
      createGuestAgentLauncher({
        serial: row.serial,
        exec: (cmd) => deps.exec(row.serial, cmd),
        hostAdb: deps.hostAdb,
        adb: deps.adb,
        apkPath: deps.apkPath,
        expectedArtifact: opts.expectedArtifact,
        onMismatch: opts.onMismatch,
        onLog: (level, msg) => deps.log[level](msg),
      }))

  /** Plan 106 §5 step 106.7 — see `AgentProvisioner.runningSince`'s own doc comment. Keyed by deviceId; one entry, since a device has exactly one guest agent. */
  const runningSinceMap = new Map<string, number>()

  const mustGet = (id: string): DeviceRow => {
    const row = db.select().from(devices).where(eq(devices.id, id)).get()
    if (!row) throw new EnkakuError('device_not_found', `no such device: ${id}`)
    return row
  }

  /**
   * Writes both halves of a settled `AgentStatus` in ONE atomic update (plan
   * 106 §5 step 106.5): `devices.preparation['guest-agent']` gets the
   * state-machine facts (authoritative — the same shape every other
   * registered component uses), and `devices.agent` gets narrowed down to
   * the identity facts alone (`GuestAgentIdentitySchema`, `@enkaku/protocol`
   * — no `state` field to disagree with the preparation record's). Both
   * come from this SAME `status` value, computed once by `ensureImpl`, so
   * they cannot diverge — there is exactly one writer for either column's
   * guest-agent-related content, this function. The row is re-read fresh
   * (mirrors `preparation/runner.ts`'s own `writeComponent`) so this write
   * never clobbers a `preparation` key some OTHER registered component
   * wrote for the same device between this pass starting and finishing.
   */
  function writeCached(deviceId: string, status: AgentStatus): void {
    const row = mustGet(deviceId)
    const currentPrep = DevicePreparationSchema.safeParse(row.preparation ?? {}).data ?? {}
    const nextPrep: DevicePreparation = {
      ...currentPrep,
      [GUEST_AGENT_COMPONENT_ID]: {
        state: status.state,
        version: status.appVersion,
        reason: status.reason,
        checkedAt: status.checkedAt,
        attempts: status.attempts,
        nextAttemptAt: status.nextAttemptAt,
      },
    }
    db.update(devices)
      .set({
        agent: { appVersion: status.appVersion, versionCode: status.versionCode, androidSdkInt: status.androidSdkInt, capabilities: status.capabilities },
        preparation: nextPrep,
      })
      .where(eq(devices.id, deviceId))
      .run()
  }

  /** Records `device.agent` only on an actual transition (§4.3: "one event per state change") — a clean reconnect that changes nothing must emit no event (acceptance criterion 5). */
  function maybeRecordTransition(row: DeviceRow, prior: AgentStatus, next: AgentStatus): void {
    if (prior.state === next.state && prior.reason === next.reason) return
    deps.record?.({
      deviceId: row.id,
      stream: 'main',
      kind: 'device.agent',
      meta: { state: next.state, reason: next.reason, from: prior.state },
    })
  }

  /**
   * One full pass: verify/install/repair via the launcher, then confirm real
   * liveness with `hello()`. Returns the settled facts (state/version/
   * capabilities/reason) — bounded-retry bookkeeping (`attempts`/
   * `nextAttemptAt`) is the caller's job, not this function's, so R1's one
   * internal forced-repair recursion below counts as ONE outer attempt, not
   * two.
   */
  async function runOnePass(
    row: DeviceRow,
    priorAppVersion: string | null,
    forceReinstall: boolean,
  ): Promise<{ state: AgentState; appVersion: string | null; versionCode: number | null; androidSdkInt: number | null; capabilities: GuestAgentCapability[]; reason: string | null }> {
    // A mutable holder, not a bare `let` (TS's control-flow narrowing treats
    // a `let` written only from inside a callback as staying at its
    // initial `null` type across the `await` below, which then narrows the
    // `if (mismatch.current && ...)` check to `never` — a property on an
    // object is not narrowed the same way).
    const mismatch: { current: GuestAgentArtifactMismatch | null } = { current: null }
    let expectedArtifact: { versionCode?: number; signatureSha256?: string } | undefined
    try {
      expectedArtifact = (await deps.expectedArtifact()) ?? undefined
    } catch (err) {
      // Reading the manifest expectation itself failed (should not happen —
      // `deviceArtifactExpectation` is documented never to throw — but this
      // pass must degrade honestly rather than crash if it ever does).
      return { state: 'failed', appVersion: priorAppVersion, versionCode: null, androidSdkInt: row.apiLevel, capabilities: [], reason: err instanceof Error ? err.message : String(err) }
    }
    const launcher = makeLauncher(row, { expectedArtifact, onMismatch: (info) => { mismatch.current = info } })

    // Plan 106 §5 step 106.8 (§9 Q5): `ui-server-component.ts`'s install was
    // routed through the transfer machinery (`TransferService.installFromLocalApk`,
    // real byte progress, a tray entry) — this launcher's OWN install, right
    // below, is deliberately NOT. `createGuestAgentLauncher`'s `ensureInstalled()`
    // has an `opts.force` fast-repair path R1 (plan 90 §3.9 rule 1) relies on
    // — a forced uninstall+reinstall+reverify triggered by a live `hello()`
    // protocol mismatch, recursed into from THIS function (`runOnePass`,
    // below, `return runOnePass(row, priorAppVersion, true)`) as one outer
    // attempt. `runTransfer` has no equivalent of that recursive, mid-pass,
    // protocol-driven re-trigger; forcing it through would mean rebuilding
    // R1's own repair cycle on a different primitive, not merely swapping
    // how ONE install call reports progress — real scope §96.25 already
    // spent effort getting right once. Left as future work if the owner
    // wants it (plan 106 §9 Q5's own closing paragraph has the full
    // reasoning and the tradeoff, stated for the owner to weigh).
    let versionCode: number | null = null
    try {
      const result = await launcher.ensureInstalled(forceReinstall ? { force: true } : undefined)
      versionCode = result.versionCode
    } catch (err) {
      // 96.25 fix 2 (docs/plans/96-m61-hotfixes.md §96.25): `E_ADB_UNAVAILABLE`
      // says something about US (the adb subsystem is not up yet), not about
      // the phone — rethrown so `ensureImpl` can defer the pass entirely
      // rather than let it fall through to the ordinary `failed` path below,
      // which would consume a slot of the device's own bounded retry budget
      // for a failure that was never the device's to answer for.
      if (err instanceof EnkakuError && err.code === 'E_ADB_UNAVAILABLE') throw err
      const reason = err instanceof Error ? err.message : String(err)
      const seen = mismatch.current
      if (seen && (seen.reason === 'version_mismatch' || seen.reason === 'signature_mismatch')) {
        // Installed, but still the wrong build after one repair (F8) — a
        // named, actionable state ("Update agent"), never a crash.
        return { state: 'outdated', appVersion: priorAppVersion, versionCode: seen.observed?.versionCode ?? null, androidSdkInt: row.apiLevel, capabilities: [], reason }
      }
      // Anything else — `not_installed` that failed to install (e.g. a
      // missing/corrupt APK, `E_CHECKSUM_MISSING` from an unresolved
      // toolchain pin), a `hostAdb` failure, or `not_installed` repaired
      // into a STILL-`not_installed` reverify — is a named, non-fatal
      // `failed` reason. Never quarantines, blocks, or changes scheduling
      // (plan 90 §3.8's load-bearing decision).
      return { state: 'failed', appVersion: priorAppVersion, versionCode: null, androidSdkInt: row.apiLevel, capabilities: [], reason }
    }

    // The artifact matches (or verification was skipped as unreadable —
    // F8's rule: unreadable never counts as a mismatch). Confirm the agent
    // is actually reachable and current, and pick up its real
    // appVersion/capabilities (criterion 4).
    try {
      const hello = await deps.hello(row.id)
      // The agent is installed, current, and answering — everything the
      // `ready` state has ever meant. One thing is still worth separating
      // out before claiming it: Android VPN consent. On a build that refuses
      // `appops set` from the shell (measured on two OPPO/ColorOS phones),
      // the agent does text input, screen labels, mock location and egress
      // probes perfectly and cannot route a single packet. `ready` would
      // overstate that, and `failed` — what this used to report, because
      // `ensurePreGranted()` threw before `hello()` was ever reached —
      // understates it by four working facets. `consent-required` is the
      // honest third answer; see `AgentStateSchema`'s own doc comment.
      //
      // Read-only (`vpnConsent`, not `ensurePreGranted`): the session that
      // just answered `hello` already made this pass's one `appops set`
      // attempt during its bootstrap, and a second write here would be a
      // duplicate with no new information.
      const consent = await launcher.vpnConsent().catch((consentErr: unknown) => {
        // An unreadable answer is not a verdict (the same rule the artifact
        // check follows for unreadable `dumpsys` output) — the agent is
        // demonstrably reachable, so this stays `ready` rather than
        // inventing a consent problem nobody observed.
        deps.log.warn(`agent-provisioner: could not read VPN consent on device ${row.id}, reporting the agent as ready on the hello() evidence alone: ${String(consentErr)}`)
        return { state: 'granted' as const, reason: null }
      })
      if (consent.state === 'pending') {
        return {
          state: 'consent-required',
          appVersion: hello.appVersion,
          versionCode,
          androidSdkInt: hello.androidSdkInt,
          capabilities: hello.capabilities,
          reason: consent.reason,
        }
      }
      return { state: 'ready', appVersion: hello.appVersion, versionCode, androidSdkInt: hello.androidSdkInt, capabilities: hello.capabilities, reason: null }
    } catch (err) {
      // Same reasoning as the `ensureInstalled` catch above: a core-side
      // "adb isn't ready" here means this pass never got a real answer from
      // the device at all, so it must not be scored as a device failure.
      if (err instanceof EnkakuError && err.code === 'E_ADB_UNAVAILABLE') throw err
      if (!forceReinstall && err instanceof GuestAgentClientError && GUEST_AGENT_REPAIRABLE_ERROR_CODES.has(err.code)) {
        // R1 (plan 90 §3.9 rule 1): a protocol mismatch `hello()` itself
        // caught, that the on-device artifact check alone cannot see —
        // exactly one forced repair, then re-`hello()`, never a loop.
        deps.log.warn(`guest agent on device ${row.id} answered ${err.code} on hello() — forcing one reinstall + re-hello (plan 90 §3.9 rule 1)`)
        return runOnePass(row, priorAppVersion, true)
      }
      const reason = err instanceof Error ? err.message : String(err)
      // Installed (verify says so) but not answering `hello()` — a genuine
      // reachability failure. `failed`, not `outdated`: the artifact itself
      // is not known to be wrong.
      return { state: 'failed', appVersion: priorAppVersion, versionCode, androidSdkInt: row.apiLevel, capabilities: [], reason }
    }
  }

  const inFlight = new Map<string, Promise<AgentStatus>>()

  async function ensureImpl(deviceId: string, opts?: { force?: boolean }): Promise<AgentStatus> {
    const row = mustGet(deviceId)
    const prior = readCached(row, deps.log)
    const checkedAt = nowSeconds(now)

    // The API-level floor (plan 90 §3.8) — terminal by design, not a
    // failure to retry. No adb call needed: `apiLevel` is already on the
    // row from the ordinary device probe.
    if (row.apiLevel !== null && row.apiLevel < MIN_SUPPORTED_SDK) {
      const next: AgentStatus = {
        state: 'unsupported',
        appVersion: null,
        versionCode: null,
        androidSdkInt: row.apiLevel,
        capabilities: [],
        reason: `Android API ${row.apiLevel} is below ${MIN_SUPPORTED_SDK} (Android 10) — the guest agent needs VpnService behaviour only proven from API ${MIN_SUPPORTED_SDK} onward`,
        checkedAt,
        attempts: 0,
        nextAttemptAt: null,
      }
      writeCached(row.id, next)
      maybeRecordTransition(row, prior, next)
      return next
    }

    // `guestAgent.provision` (plan 90 §3.8, acceptance criterion 8): `off`
    // reproduces pre-plan-90 behaviour exactly — install happens only via
    // the route path or an explicit (`force: true`) request. `manual` is
    // the same for AUTOMATIC hooks — an operator still reaches for the
    // fleet-wide "Provision all" action or the per-device retry, both of
    // which pass `force: true`.
    if (!opts?.force && deps.provision() !== 'auto') {
      deps.log.debug(`agent-provisioner: skipping device ${row.id} (guestAgent.provision is '${deps.provision()}', not forced)`)
      return prior
    }

    // Bounded retries on a standing `failed` state (plan 90 §3.8): a farm
    // of twenty phones with a bad APK path must produce a bounded number of
    // log lines, not an install storm on every hook that happens to fire.
    // A forced call (an explicit retry, or the fleet-wide action) always
    // bypasses this — that IS the "explicit retry" the bound exists to wait
    // for.
    if (!opts?.force && prior.state === 'failed') {
      if (hasExhaustedRetryBudget(prior, retryBackoffS)) {
        deps.log.debug(`agent-provisioner: device ${row.id} has exhausted its ${retryBackoffS.length} automatic attempts — waiting for an explicit retry`)
        return prior
      }
      if (isWithinBackoffWindow(prior, checkedAt)) {
        return prior
      }
    }

    let result: Awaited<ReturnType<typeof runOnePass>>
    // Plan 106 §5 step 106.7: the whole `runOnePass` duration counts as
    // "in flight", including R1's own internal forced-repair-then-re-hello
    // recursion (invisible to this wrapper — it is still one outer await).
    // `finally` clears the marker on every exit path: success, a translated
    // `failed`/`outdated` result, or the `E_ADB_UNAVAILABLE` defer's early
    // `return prior` below.
    runningSinceMap.set(row.id, checkedAt)
    try {
      result = await runOnePass(row, prior.appVersion, false)
    } catch (err) {
      // 96.25 fix 2: a core-side `E_ADB_UNAVAILABLE` (rethrown by
      // `runOnePass` above) means this pass never reached the device at
      // all — defer exactly like the "not forced, provisioning off" and
      // "budget exhausted" branches above: no write, no attempt consumed,
      // no transition event, `prior` unchanged. The next hook (device-online,
      // a boot sweep run at the right time, or an explicit retry) gets a
      // real attempt instead of one already spent on our own unreadiness.
      if (err instanceof EnkakuError && err.code === 'E_ADB_UNAVAILABLE') {
        deps.log.debug(`agent-provisioner: deferring device ${row.id} — adb subsystem was not ready for this pass (not counted against its retry budget)`)
        return prior
      }
      throw err
    } finally {
      runningSinceMap.delete(row.id)
    }

    // An explicit retry is the honest version of "try again from scratch"
    // (plan 90 §3.7 rule 4's `POST .../network/retry` does the identical
    // thing for route recovery) — it must not inherit an already-exhausted
    // budget, or `force: true` would be indistinguishable from doing
    // nothing at attempt 3. `nextBoundedRetry` (`bounded-retry.ts`, plan 106
    // §3.3) carries this exact arithmetic now — 'outdated' resets the same
    // as 'ready' there too, for the same reason the old inline comment gave:
    // it is not the bounded-retry ladder's concern (that ladder is about
    // transient install failures, not "this build is genuinely the wrong
    // one"). It stays visible and actionable ("Update agent") until the
    // manifest's pin changes or an operator forces a fresh pass.
    const { attempts, nextAttemptAt } = nextBoundedRetry({
      result: result.state,
      priorAttempts: prior.attempts,
      checkedAt,
      retryBackoffS,
      forced: !!opts?.force,
    })

    const next: AgentStatus = { ...result, checkedAt, attempts, nextAttemptAt }
    writeCached(row.id, next)
    maybeRecordTransition(row, prior, next)
    return next
  }

  return {
    async ensure(deviceId, opts) {
      const key = opts?.force ? `${deviceId}:force` : deviceId
      const existing = inFlight.get(key)
      if (existing) return existing
      const p = ensureImpl(deviceId, opts).finally(() => {
        inFlight.delete(key)
      })
      inFlight.set(key, p)
      return p
    },

    async status(deviceId) {
      const row = mustGet(deviceId)
      return readCached(row, deps.log)
    },

    runningSince(deviceId) {
      return runningSinceMap.get(deviceId) ?? null
    },

    async ensureAll(opts) {
      const rows = db.select().from(devices).all()
      const results: AgentProvisionReport['results'] = []
      // Every device is independent — the shared `hostAdb` install lane
      // (F12, `adb.maxInstallConcurrent`) is what actually bounds fleet-wide
      // concurrency, not a second semaphore here (plan 90 §3.8's own rule:
      // "do not build a second concurrency mechanism").
      await Promise.all(
        rows.map(async (row) => {
          if (row.status === 'offline') return // unreachable by construction — nothing to verify
          try {
            const status = await this.ensure(row.id, opts)
            results.push({ deviceId: row.id, state: status.state, reason: status.reason })
          } catch (err) {
            // `ensure()` only throws for a missing row, which cannot happen
            // here (the row is the one we just selected) — caught anyway so
            // one device's surprise can never abort the whole fleet pass.
            deps.log.warn(`agent-provisioner: ensureAll skipped device ${row.id} after an unexpected error: ${String(err)}`)
            results.push({ deviceId: row.id, state: 'failed', reason: err instanceof Error ? err.message : String(err) })
          }
        }),
      )
      return { total: results.length, results }
    },

    async remove(deviceId, actor) {
      const row = mustGet(deviceId)
      const prior = readCached(row, deps.log)
      const launcher = makeLauncher(row, { onMismatch: () => undefined })
      await launcher.stop().catch(() => undefined)
      await deps.hostAdb(['-s', row.serial, 'uninstall', GUEST_AGENT_PACKAGE]).catch(() => undefined)
      const next: AgentStatus = { ...DEFAULT_AGENT_STATUS, checkedAt: nowSeconds(now) }
      writeCached(row.id, next)
      deps.record?.({ deviceId: row.id, stream: 'main', kind: 'device.agent', actor, meta: { state: next.state, reason: null, from: prior.state } })
      return next
    },
  }
}

/**
 * `POST /api/guest-agent/provision` and `GET /api/guest-agent/summary` (plan
 * 90 §4.7) — the fleet-wide half of "on demand": the button a human reaches
 * for when the per-device retry is not enough. A separate Hono app, mounted
 * at `/api/guest-agent` (NOT `/api/devices`, unlike every other guest-agent
 * route) — `packages/core/src/server/http.ts` is the one place that prefix
 * is chosen.
 */
export function createAgentProvisionerRoutes(deps: { provisioner: AgentProvisioner; db: Db }): { routes: Hono<AuthEnv> } {
  const app = new Hono<AuthEnv>()

  // The plan's own §4.7 table names `device.admin` as the permission; that
  // permission does not exist in this codebase's ACL
  // (`packages/core/src/auth/acl.ts`) — `api/devices.ts`'s `/rescan` route
  // hit the identical gap and resolved it the same way: `device.settings`
  // is the closest existing admin-style device-mutation permission every
  // other bulk operator action in this router family already uses, rather
  // than inventing one nothing else recognises.
  app.post('/provision', requirePermission('device.settings'), async (c) => {
    const report = await deps.provisioner.ensureAll({ force: true })
    return c.json(report)
  })

  app.get('/summary', requirePermission('device.view'), (c) => {
    const rows = deps.db.select().from(devices).all()
    const byState: Record<string, number> = {}
    const byVersion: Record<string, number> = {}
    for (const row of rows) {
      // Plan 106 §5 step 106.5: state comes from `devices.preparation['guest-agent']`
      // (with the legacy-row fallback `deriveGuestAgentPreparation` documents),
      // never `devices.agent` directly — the same recombination `readCached` uses.
      const state = deriveGuestAgentPreparation(row).state
      byState[state] = (byState[state] ?? 0) + 1
      const versionKey = deriveGuestAgentIdentity(row).appVersion ?? 'unknown'
      byVersion[versionKey] = (byVersion[versionKey] ?? 0) + 1
    }
    return c.json({ total: rows.length, byState, byVersion })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      const status = err.code === 'device_not_found' ? 404 : 500
      return c.json(err.toJSON(), status as 404)
    }
    throw err
  })

  return { routes: app }
}
