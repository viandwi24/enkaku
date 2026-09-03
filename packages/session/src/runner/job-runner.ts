import { join } from 'node:path'
import { UiautomatorDumpInspector } from '@enkaku/drivers'
import {
  defaultFarmSettings,
  FindOutcomeSchema,
  resolveRuntime,
  RESULT_LIMITS,
  type JobSettings,
  type ResultOutcome,
  type RuntimeEnvelope,
} from '@enkaku/protocol'
import type { Subprocess } from 'bun'
import { backoffDelayMs } from './backoff'
import { createDeviceExecutor, type TimingSettings } from '../device-executor'
import { SessionError } from '../errors'
import type { InputSource } from '../input-arbiter'
import type { Logger } from '../logger'
import type { SessionManager } from '../manager'
import { resetDevice, type ResetOutcome, type ResetPlan } from '../reset'
import type { DeviceSession } from '../session'
import type { ArtifactSink, TransferPort } from '../types'
import {
  ChildToParentSchema,
  DeviceCallSchema,
  FarmCallSchema,
  JobsCallSchema,
  KvCallSchema,
  type ChildToParent,
  type FarmCall,
  type JobsCall,
  type KvCall,
  type ParentToChild,
} from './ipc'
import { createJobLogger, type JobLogEntry } from './job-logger'
import { resolveIsolation, type IsolationProvider } from './isolation'
import {
  createNoopTraceTee,
  createTraceTee,
  type TraceCaptureRequest,
  type TraceCaptureResult,
  type TraceEventInput,
  type TraceTee,
} from './trace'

/**
 * Plan 36 §3.2, §4.1 — kept local because `@enkaku/session` cannot depend on
 * `@enkaku/core` (the dependency runs the other way: core already depends on
 * session). The canonical table lives in `packages/core/src/jobs/failure-class.ts`
 * and is structurally identical to this shape; the host injects its
 * `classifyFailure` as `JobRunnerDeps.classify` rather than the runner
 * importing it directly.
 */
export type FailureClass = 'infra' | 'script' | 'load'

export interface ClassifiedFailure {
  class: FailureClass
  code: string
  message: string
  /** True when this device should be blamed (feeds plan 23's health tracker). */
  blameDevice: boolean
}

const FINISH_GRACE_MS = 30_000
const FINISH_ONLY_TIMEOUT_MS = 30_000
const SIGKILL_DELAY_MS = 5_000
/** The child counts as hung after this long with no message at all. */
const SILENCE_LIMIT_MS = 30_000
/**
 * Plan 98 §4.7 — the cadence the parent asks the child to self-report RSS on
 * WHEN NO MEMORY LIMIT IS CONFIGURED (`resolved.maxRssBytes === null`).
 * Cheap, coarse, peak-recording-only cadence — matches 98.2 exactly. Once a
 * limit IS configured (step 98.3), the cadence tightens to
 * `job.memory.sampleIntervalMs` for that attempt (`memoryLimitConfigured`
 * below), independent of `enforce` — sampling faster costs nothing and keeps
 * the recorded peak accurate even under `enforce: 'off'`.
 */
const RSS_SAMPLE_MS = 10_000
/** A breach is reported once, at 80% of the limit — see `checkMemoryBreach` (plan 98 §3.6). */
const MEMORY_WARN_FRACTION = 0.8

export interface ScriptFailure {
  code: string
  message: string
  phase: string
}

export interface AttemptOutcome {
  ok: boolean
  value?: unknown
  error?: ScriptFailure
  finishRan: boolean
  /** Plan 98 §4.8, H1 — the highest `rss` sample seen this attempt. Undefined when the child never reported one (e.g. it died before `init`, or before its own first sample). */
  peakRssBytes?: number
  /**
   * Plan 97 §3.3, §3.4, §3.8, §4.3 — the child's own verdict on `value`,
   * carried straight from the `result` IPC message's own `outcome` (see
   * `ipc.ts`'s doc comment on it). Undefined whenever the child sent none:
   * a pre-plan-97 bundle, a `finish-only`/abort settle, or any attempt that
   * never reached the success branch that builds one.
   */
  outcome?: ResultOutcome
}

/**
 * A job ready to run — the host has already materialised the bundle.
 * The runner knows nothing about the database or the `scripts` table.
 */
export interface JobSpec {
  id: string
  deviceId: string
  /** Path to the ESM bundle file the child will import. */
  bundlePath: string
  params: unknown
  /**
   * Which member of a plugin bundle to run (plan 82 §3.2, §4.2) — the
   * registry entry's own `exportId`. Threaded into the spawned child's env
   * as `ENKAKU_SCRIPT_EXPORT_ID`, read by `child-entry.ts`'s loader.
   * Undefined for a standalone bundle, which selects its single default
   * export exactly as before this field existed.
   */
  scriptExportId?: string
  /**
   * Plan 99 §3.3, §4.8. `'farm'` (the default, and today's behaviour
   * exactly) runs the pre-job reset per `job.resetPolicy`; `'none'` skips it,
   * the same way a `finish-only` attempt already does and for a related
   * reason — a workflow node after the first needs the state a reset would
   * wipe. Undefined for every job outside a workflow.
   */
  reset?: 'farm' | 'none'
  /**
   * Plan 99 §3.2, §4.8. The workflow node this execution belongs to.
   * Threaded into the child's `init` and into `ctx.jobs.trigger()`'s default
   * idempotency key, because several nodes share one `jobId` and one
   * `attempt` counter and would otherwise derive colliding keys (plan 99
   * F20). Undefined for a standalone job, which keeps deriving the exact key
   * shape it always has.
   */
  nodeId?: string
  /**
   * Plan 99 §3.5, §4.8 — overrides `ScriptDefinition.retries` for this
   * execution (a workflow's per-node override). Undefined defers entirely to
   * the script's own declared `retries`, exactly as before this field
   * existed.
   */
  retries?: number
  /**
   * Plan 98 §3.1, §4.4, §5 step 98.4 — the script's own declared execution
   * envelope, pinned at the moment the host resolved this job's script
   * (spec §11.6: a job pins the code it was pinned to, and the envelope
   * pins the same way — read once, from the row this job was enqueued
   * against, never re-read from a since-republished row). This runner
   * "knows nothing about the database or the `scripts` table" (this
   * interface's own doc comment above), so this field is how the host
   * hands over what it already knows: `null` means "the host looked and
   * this script declared nothing" (a pre-plan-98 script, or a dev slot with
   * no declaration); `undefined` means "the host has not been updated to
   * supply this at all" (only true of a caller — chiefly a test — that
   * predates this field).
   *
   * This is the ONE layer `resolveRuntime`'s `script` argument was always
   * going to receive once persistence landed (see 98.3's own comment at its
   * call site, `execute()` below) — no other line changes for that.
   *
   * It is also the DB side of the `ready`-message reconciliation check
   * (plan 98 §3.1): the child's own `ready.runtime` is compared against
   * THIS value, never the other way around, and a disagreement is logged
   * once as a warning naming both — the DB value here is what actually
   * gets used; the bundle's own report is a diagnostic only.
   */
  runtime?: RuntimeEnvelope | null
  /**
   * Plan 98 §3.8, §4.4, §5 step 98.7 — the operator's own per-job layer,
   * pinned onto `jobs.runtime_override` at enqueue and already validated and
   * ceiling-checked there (`services/job-service.ts`'s `E_RUNTIME_OVER_CEILING`
   * refusal) — this runner never re-validates it, only resolves precedence
   * with it. This is the `override` argument `resolveRuntime` has taken
   * since step 98.3 first called it and has been passing `null` for ever
   * since (that step's own comment named this exact field as the one still
   * to come): `resolveRuntime({ farm, script: job.runtime ?? null, override:
   * job.runtimeOverride ?? null })` is now the WHOLE change this step makes
   * to `execute()` below — no other line at that call site moves. `null`
   * means "no override for this job" (the overwhelming common case, and
   * every job before this field existed); `undefined` means "the host has
   * not been updated to supply this at all" (only true of a caller — a
   * test — that predates this field), matching `runtime` just above's own
   * two-value convention exactly.
   */
  runtimeOverride?: RuntimeEnvelope | null
}

/**
 * `ctx.kv`'s parent-side port (plan 79 §4.4, §4.7) — kept local, like
 * `ClassifiedFailure` above, because `@enkaku/session` cannot depend on
 * `@enkaku/core` (the kv store itself lives in `packages/core/src/kv/`).
 * `KvCall` is the wire shape (`./ipc.ts`); `namespace` is the script's own
 * id (`ready`'s `scriptId`) — the runtime injects it, a script never types
 * it (plan 79 §3.2).
 */
export interface KvRunnerDeps {
  call(ctx: { jobId: string; deviceId: string; namespace: string }, call: KvCall): Promise<unknown>
  /** Best-effort secret redaction for one job-log line (plan 79 §4.7) — returns `text` unchanged
   * when nothing readable by `namespace`/`deviceId` is currently a secret, or `namespace` is not
   * known yet (before the child's `ready` message has arrived). */
  redact(ctx: { deviceId: string; namespace: string | undefined }, text: string): string
}

/**
 * `ctx.jobs`'s parent-side port (plan 80 §4.2) — kept local, like
 * `KvRunnerDeps` above, because `@enkaku/session` cannot depend on
 * `@enkaku/core` (the queue/`JobStore` itself lives in `packages/core/src/queue/`).
 * `JobsCall` is the wire shape (`./ipc.ts`); the caller's own `{ jobId,
 * deviceId }` is enough for the core side to look up its full `JobRow` and
 * scope every read to it — the runner never resolves scope itself.
 */
export interface JobsRunnerDeps {
  call(ctx: { jobId: string; deviceId: string }, call: JobsCall): Promise<unknown>
}

/**
 * `ctx.farm`'s parent-side port (plan 109 §3.1, §4.3, step 109.1) — kept
 * local, like `KvRunnerDeps` and `JobsRunnerDeps` above, because
 * `@enkaku/session` cannot depend on `@enkaku/core` (the capability registry
 * and `invoke()` live in `packages/core/src/capability/`).
 *
 * `pluginId` is the owning plugin's id, from the `ready` message — because the
 * broker's two checks are both keyed on the plugin: the manifest's declared
 * permissions, and the `plugin:<name>` principal every call is audited under.
 *
 * **It is `pluginId`, not `namespace`, and the difference is load-bearing**
 * (step 109.3). `kv.call` resolves its namespace as `pluginId ?? scriptId ??
 * jobId`, because a standalone script legitimately owns a KV namespace of its
 * own. A standalone script owns no MANIFEST, so that fallback has nothing to
 * check a farm call against — and by the time the fallback has been applied,
 * "plugin `foo`" and "standalone script `foo`" are the same string and the
 * core side can no longer tell them apart. Step 109.1's comment here said the
 * core would refuse those; it structurally could not. So the refusal happens
 * at the call site below, where `meta.pluginId` is still distinguishable from
 * absent, and this field can only ever be a real plugin id.
 */
export interface FarmRunnerDeps {
  call(ctx: { jobId: string; deviceId: string; pluginId: string }, call: FarmCall): Promise<unknown>
}

export interface JobRunnerDeps {
  /** Execution isolation — a child process (local) or a container (cloud). */
  isolation?: IsolationProvider
  /** Root for job log files (the host decides where). */
  logDir: string
  sessions: SessionManager
  /** Created per job — artifact numbering is per-job. */
  artifacts: (jobId: string) => ArtifactSink
  log: Logger
  onLog: (entry: JobLogEntry) => void
  onArtifact: (jobId: string, artifact: { kind: string; label: string; path: string; sizeBytes: number }) => void
  /** `reset` (plan 35 §3.5, §4.4) always precedes `prepare`, for a 'full' attempt only. */
  onPhase: (jobId: string, attempt: number, phase: 'reset' | 'prepare' | 'run' | 'finish') => void
  /** Extend the job heartbeat (child heartbeat or device activity). */
  heartbeat: (jobId: string) => void
  /**
   * Read fresh per attempt, not captured at daemon start (plan 35 §4.4) — the
   * same pattern Plan 23 established with `adb.maxConcurrent` — so a settings
   * change applies to the next job with no restart. Defaults to the farm
   * schema's own defaults (policy `'home'`) when the host does not supply one,
   * which is what lets the cloud node (no FarmSettings store of its own)
   * share this exact code path (plan 35 §2).
   */
  resetPolicy?: () => JobSettings
  /** One `job.reset` device event per pre-job reset (plan 35 §3.5, §4.4). */
  onReset?: (jobId: string, deviceId: string, outcome: ResetOutcome, plan: ResetPlan) => void
  /**
   * Classifies why an attempt failed — infra vs script vs load (plan 36 §3.2,
   * §4.1). Injected because the canonical table lives in `@enkaku/core`.
   * Defaults to treating every failure as `script` with no device blame,
   * which reproduces the pre-plan-36 behaviour (retry immediately up to
   * `ScriptDefinition.retries`, no backoff, no device blame) for a caller
   * that has not wired classification yet.
   */
  classify?: (err: unknown) => ClassifiedFailure
  /**
   * One call per retry decision (plan 36 §4.3, §4.4) — the host turns this
   * into the `job.retry` main-stream device event. `delayMs` is 0 for a
   * script-class retry (no backoff change, §3.2).
   */
  onRetry?: (jobId: string, info: { attempt: number; class: FailureClass; code: string; delayMs: number }) => void
  /**
   * The crash policy's `declared` target (plan 37 §3.4, §4.4): whichever is
   * non-empty of the script's own `reset.packages` (from the `ready`
   * message, plan 35 §4.3) or the packages it has launched via
   * `ctx.device.app.launch` so far this attempt. Called once the declared
   * set is known (even if empty) and again every time a new package is
   * launched, so the host's registry always reflects "what would `declared`
   * match right now" — a crash watcher does not wait for the job to finish
   * to learn this.
   */
  onTargetPackages?: (jobId: string, packages: string[]) => void
  /** `ctx.device.install`/`push`/`pull` (plan 39 §4.6) — undefined when the host has not wired file transfer (`createDeviceExecutor` then refuses those three calls with `E_TRANSFER_UNAVAILABLE`, exactly like manual control). */
  transfer?: TransferPort
  /**
   * Timing realism (spec §9.3, plan 34 §3.3, §4.2) — a GETTER, not a value,
   * read once per attempt rather than captured at daemon start, the same
   * freshness pattern Plan 23 established for `adb.maxConcurrent`: a Settings
   * change applies to the very next job, no restart. Undefined means "the
   * host has no timing settings of its own" (`createDeviceExecutor` then
   * falls back to `DEFAULT_TIMING`, matching pre-plan-34 behaviour exactly).
   */
  timing?: () => TimingSettings
  /** `ctx.kv` (plan 79 §4.4) — undefined when the host has not wired a kv store (`kv.call` then
   * refuses cleanly with `E_KV_UNAVAILABLE`, the same pattern `transfer` above already uses). */
  kv?: KvRunnerDeps
  /** `ctx.jobs` (plan 80 §4.2) — undefined when the host has not wired one (`jobs.call` then
   * refuses cleanly with `E_JOBS_UNAVAILABLE`, the same pattern `kv`/`transfer` above already use). */
  jobs?: JobsRunnerDeps
  /**
   * `ctx.farm` (plan 109 §4.3) — undefined when the host has not wired the
   * capability broker (`farm.call` then refuses cleanly with
   * `E_FARM_UNAVAILABLE`, the same pattern `kv`/`jobs`/`transfer` above
   * already use). Wired by the core as of step 109.3
   * (`plugins/farm-broker.ts`'s `createFarmRunnerPort`); a host that has not
   * wired one gets one coded refusal per call, never a silent success.
   */
  farm?: FarmRunnerDeps
  /**
   * `ctx.progress()` (plan 97 §3.7, §4.3) — one call per coalesced `progress`
   * message the child sends, forwarded VERBATIM: this runner does not
   * measure, drop, or rate-limit anything itself (the child's own timer
   * already coalesced it to at most one per `progressIntervalMs`) — sizing
   * and the one-warn-per-job rule live one hop further out
   * (`executor-host.ts`, §5 step 97.7), the same "the runner reports, the
   * host decides" split `onReset`/`onRetry` above already use. Optional: a
   * host that has not wired this simply never learns a script called
   * `ctx.progress()`, which is exactly today's (pre-97.7) behaviour.
   */
  onProgress?: (jobId: string, value: unknown) => void
  /**
   * The job trace (plan 128 §3.1, §4.2, step 128.4) — one event per device
   * action, log line, phase boundary, artifact and progress push, on one
   * millisecond-resolution axis.
   *
   * Optional, exactly like `transfer`/`timing`/`kv`/`jobs` above: **a host
   * that does not wire it loses tracing and nothing else.** The tee it feeds
   * is a no-op object in that case (`createNoopTraceTee`), so the call sites
   * below stay unconditional and cost nothing.
   *
   * Contractually NON-BLOCKING — the host's recorder buffers in memory and
   * flushes on its own timer (§3.6, mirroring `events/recorder.ts`'s
   * "`record()` never awaits the database"). This is called on the runner's
   * own turn, between a device call settling and the child being told about
   * it, and a host that blocks here would be slowing the very script the tee
   * exists to leave alone (§0.2).
   *
   * The event arrives WITHOUT `id`/`seq`: the host's recorder is the single
   * `seq` authority and seeds its per-job counter from the highest `seq`
   * already stored (`packages/core/src/jobs/trace/recorder.ts`). A tee that
   * numbered its own events would restart at 1 on a rebound job and collide
   * with attempt 1 on `uniqueIndex(jobId, seq)`. Order is the tee's contract;
   * numbering is the recorder's.
   */
  onTraceEvent?: (jobId: string, event: TraceEventInput) => void
  /**
   * Where trace frames and UI-tree snapshots are stored (plan 128 §3.5, step
   * 128.5) — `<dataDir>/traces/<jobId>/<sha256>.png` and `.json.gz`, one
   * directory per job, one lifetime. Kept out of this package for the same
   * reason `kv`/`jobs`/`transfer` are: the store itself lives in
   * `@enkaku/core`, which depends on this package and never the reverse.
   *
   * Undefined means the frame lane is empty for every job on this host — the
   * capture policy resolves to `'none'` — while the engine id is still
   * reported honestly on every `phase` event, so the timeline can say "no
   * frames" rather than "no inspector".
   */
  traceStore?: TraceStoreDeps
}

/**
 * The trace frame/UI-tree sink (plan 128 §3.5). Both return the SHA-256 hex
 * the event's `frameHash`/`uiHash` will carry; both are content-addressed, so
 * two actions on an unchanged screen write one file and produce two events
 * naming one hash (criterion 6).
 */
export interface TraceStoreDeps {
  putFrame(jobId: string, bytes: Uint8Array): Promise<string>
  putUiTree(jobId: string, tree: unknown): Promise<string>
}

/**
 * `'crashed'` (plan 37 §3.5, §4.4): the target application crashed mid-run.
 * Carried alongside the existing three reasons rather than as a parallel
 * mechanism, so it gets the same "abort the phase, still run finish()"
 * handling `timeout`/`hung` already have (spec §11.3).
 *
 * `'startup-timeout'` (plan 74 §3.2, §4.2): the child never sent `ready` —
 * fires from a SEPARATE, shorter timer than the run timeout (§4.2), so
 * raising the run timeout's default from 5 minutes to 60 does not also make
 * a child that never starts twelve times slower to notice.
 *
 * `'memory'` (plan 98 §3.6, §4.8): the child self-reported an RSS sample at
 * or above the resolved `maxRssBytes` ceiling while `job.memory.enforce`
 * is `'kill'`. Deliberately NOT handled like the other four reasons —
 * `doAbort` below skips the `abort` message and the grace period entirely
 * for this one reason, because a process already over its declared ceiling
 * cannot be trusted to unwind politely (§3.6). `finish()` still runs: this
 * attempt's `finishRan` stays false (the child never got to send its own
 * `result`), so `execute()`'s existing finish-only re-run (spec §11.2)
 * fires in a fresh process exactly as it does for any other attempt that
 * dies before reporting one.
 */
export type AbortReason = 'timeout' | 'cancelled' | 'hung' | 'crashed' | 'startup-timeout' | 'memory'

export interface RunningJob {
  /** `detail` is a human-readable cause, used only for `reason: 'crashed'` (plan 37 §4.4) — e.g. "com.example.app crashed: java.lang.NullPointerException". */
  abort(reason: AbortReason, detail?: string): void
}

export interface JobRunner {
  execute(job: JobSpec): Promise<{ ok: boolean; value?: unknown; error?: ScriptFailure; peakRssBytes?: number; outcome?: ResultOutcome }>
  abort(jobId: string, reason: AbortReason, detail?: string): boolean
}

const childEntryPath = join(import.meta.dir, 'child-entry.ts')
const defaultIsolation = resolveIsolation()
/** Plan 97 §3.7, §4.9 — mirrors `job.progressIntervalMs`'s own zod default (`packages/protocol/src/settings.ts`). */
const DEFAULT_PROGRESS_INTERVAL_MS = 1_000

/** The `ScriptFailure.code` an abort reason settles as (plan 37 §4.4, plan 74 §4.2). */
function abortErrorCode(reason: AbortReason): string {
  if (reason === 'cancelled') return 'CANCELLED'
  if (reason === 'crashed') return 'APP_CRASHED'
  // A distinct code from 'TIMEOUT' (plan 74 §3.2, criterion 5) — a child
  // that never started is the farm's problem, not the script's, and this is
  // what lets `failure-class.ts` classify it as infrastructure unconditionally
  // rather than depending on the operator's `timeoutIsInfra` flag.
  if (reason === 'startup-timeout') return 'STARTUP_TIMEOUT'
  // Plan 98 §3.6, §4.8 — a distinct code from 'TIMEOUT' so `failure-class.ts`
  // can assert it script-class explicitly (SCRIPT_CODES) rather than falling
  // through the default, exactly like 'APP_CRASHED' above it.
  if (reason === 'memory') return 'MEMORY_LIMIT'
  return 'TIMEOUT'
}

/**
 * Clamps a requested job timeout against the farm's optional ceiling (plan
 * 74 §3.3, §4.2). `maxTimeoutMs: null` means no ceiling — the script's
 * request is honoured however long, because the user's instruction is that
 * a script has priority. When a ceiling IS set and a request exceeds it, the
 * clamp is logged NAMING the script and both numbers — never silent, because
 * a job that dies early for an unexplained reason is worse than one that
 * runs long (§3.3).
 */
function clampTimeoutMs(requested: number, maxTimeoutMs: number | null, scriptLabel: string, log: (line: string) => void): number {
  if (maxTimeoutMs === null || requested <= maxTimeoutMs) return requested
  log(`timeout clamp: ${scriptLabel} requested ${requested}ms, but maxTimeoutMs is ${maxTimeoutMs}ms — using ${maxTimeoutMs}ms`)
  return maxTimeoutMs
}

/**
 * Plan 98 §3.1, §5 step 98.4 — field-by-field, never a JSON-string
 * comparison: `a` (a DB column, parsed by `RuntimeEnvelopeSchema`) and `b`
 * (a folded SDK object that crossed an IPC boundary) are built by two
 * completely independent code paths with no reason to enumerate their keys
 * in the same order, so a naive `JSON.stringify(a) !== JSON.stringify(b)`
 * would false-positive on nothing more than key order. `null`/`undefined`
 * both mean "declared nothing" here (matching `resolveRuntime`'s own
 * treatment of the same two shapes, plan 98 §3.8) — comparing either against
 * an empty object rather than against each other's exact JS type.
 */
function runtimeEnvelopesDiffer(a: RuntimeEnvelope | null | undefined, b: RuntimeEnvelope | null | undefined): boolean {
  const left = (a ?? {}) as Record<string, unknown>
  const right = (b ?? {}) as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (left[key] !== right[key]) return true
  }
  return false
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const active = new Map<string, RunningJob>()
  const getResetSettings = deps.resetPolicy ?? (() => defaultFarmSettings().job)

  async function runAttempt(opts: {
    job: JobSpec
    attempt: number
    bundlePath: string
    session: DeviceSession
    timeoutMs: number
    /** Plan 74 §3.2, §4.2 — the pre-`ready` backstop; `undefined` for a finish-only attempt (its own short `timeoutMs` already covers it). */
    startupTimeoutMs?: number
    /** Plan 74 §3.3, §4.2 — `null` means no ceiling. Applied to the script's own re-armed timeout at `ready`, not to the initial farm-default arm. */
    maxTimeoutMs?: number | null
    mode: 'full' | 'finish-only'
    priorError?: ScriptFailure
    logger: ReturnType<typeof createJobLogger>
    artifacts: ArtifactSink
    aborter: { current: ((reason: AbortReason, detail?: string) => void) | null }
    /** Filled from the `ready` message — timeout and retries belong to ScriptDefinition. */
    meta?: { timeoutMs?: number; retries?: number; scriptId?: string; version?: string; pluginId?: string }
    /**
     * Plan 97 §3.4, §4.9 — `job.maxResultBytes`, resolved by the CALLER
     * (which holds the live settings store) and handed to the child via
     * `init` (`sendInit` below). Undefined for a finish-only attempt (its
     * own result path is 97.4's, not this one's) — `sendInit` falls back to
     * `RESULT_LIMITS.defaultMaxResultBytes` for any caller that omits this,
     * the same "read fresh, default sanely" shape `resetPolicy` already has.
     */
    maxResultBytes?: number
    /**
     * Plan 97 §3.7, §4.9 — `job.progressIntervalMs`, resolved by the CALLER
     * the same way `maxResultBytes` above is, and handed to the child via
     * `init`. Undefined for a finish-only attempt (§9's own "no live
     * audience for that short window" reasoning) — `sendInit` falls back to
     * a sane default for any caller that omits this.
     */
    progressIntervalMs?: number
    /**
     * Plan 98 §3.5, §3.6, §4.7, §4.8 — the resolved memory ceiling for this
     * attempt. Undefined for a finish-only attempt (§9 Q7 — `finish()` gets
     * no memory budget of its own, deliberately) and for a farm/script that
     * declared no ceiling at all. `maxRssBytes: null` inside a defined object
     * never happens in practice (the caller only builds this when a ceiling
     * resolved to a real number) but stays nullable here, matching
     * `ResolvedRuntime.maxRssBytes`'s own shape rather than inventing a second one.
     */
    memory?: { maxRssBytes: number | null; enforce: 'kill' | 'warn' | 'off'; sampleIntervalMs: number }
    /**
     * Plan 128 §3.1, step 128.4 — the job trace tee. Built once per JOB by
     * `execute()` (never per attempt: `seq` is per job, see `trace.ts`), and
     * a no-op object when the host wired no `onTraceEvent`, so every call
     * site below is unconditional.
     */
    tee: TraceTee
  }): Promise<AttemptOutcome> {
    const { job, attempt, bundlePath, session, timeoutMs, mode, logger, artifacts, tee } = opts
    // Plan 98 §4.7 — "a limit is in effect" (tighter rss cadence, tighter
    // silence watchdog) is decided purely by whether a CEILING NUMBER
    // resolved, never by `enforce`: even `enforce: 'off'` benefits from a
    // more accurate recorded peak, and sampling faster costs nothing extra
    // (an `rss` message never triggers a heartbeat-renewal write — see below).
    const memory = opts.memory
    const memoryLimitConfigured = memory !== undefined && memory.maxRssBytes !== null
    const effectiveRssSampleMs = memory !== undefined && memory.maxRssBytes !== null ? memory.sampleIntervalMs : RSS_SAMPLE_MS
    // Plan 98 §3.6 — "when a memory limit is in effect the silence limit
    // tightens to min(SILENCE_LIMIT_MS, 3 × sampleIntervalMs)": narrows the
    // one honest gap this design has (H2) — a script that blocks its own
    // event loop while allocating cannot report an `rss` sample at all, so
    // the sampler cannot see it; the tightened silence watchdog is what
    // still catches that shape, just slower than the sampler catches the
    // await-point shape.
    const effectiveSilenceLimitMs = memoryLimitConfigured ? Math.min(SILENCE_LIMIT_MS, 3 * effectiveRssSampleMs) : SILENCE_LIMIT_MS

    // Target-package tracking (plan 37 §3.4, §4.4): `declaredPackages` comes
    // from the `ready` message's `reset.packages` once it arrives;
    // `launchedPackages` accumulates every package `app.launch` has hit so
    // far this attempt. `declared` wins when it is non-empty (a script that
    // bothered to declare its own reset packages is being explicit about its
    // target), otherwise the launched set is the fallback.
    let declaredPackages: string[] = []
    const launchedPackages = new Set<string>()
    const reportTargetPackages = (): void => {
      deps.onTargetPackages?.(job.id, declaredPackages.length > 0 ? declaredPackages : [...launchedPackages])
    }
    // Plan 91 §3.3, §4.1 — this attempt's identity for the input arbiter's
    // priority lane. `id: job.id` (not `attempt`): a retry belongs to the
    // SAME job, and the arbiter's `job`/`agent` priority tier does not
    // distinguish attempts.
    const source: InputSource = { kind: 'job', id: job.id, userId: null }
    const execDevice = createDeviceExecutor({
      session,
      source,
      onAppLaunch: (pkg) => {
        if (launchedPackages.has(pkg)) return
        launchedPackages.add(pkg)
        reportTargetPackages()
      },
      ...(deps.transfer ? { transfer: deps.transfer } : {}),
      // Plan 94 §4.5, F10, step 94.2: the accessor ITSELF, not the value it
      // returns right now — `createDeviceExecutor` re-resolves it on every
      // device call, not once here. Before this change, `deps.timing()` was
      // called exactly once, at attempt construction: a real improvement
      // over "captured at daemon start" (still the comment's own point), but
      // a setting change made while THIS attempt's script was still running
      // never reached it — the same shape of bug this repo has shipped
      // before (an input-arbiter queue budget read once and never again).
      ...(deps.timing ? { timing: deps.timing } : {}),
    })

    return new Promise<AttemptOutcome>((resolve) => {
      let settled = false
      let finishRan = false
      let killTimer: ReturnType<typeof setTimeout> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null
      // Plan 74 §3.2, §4.2 — the short pre-`ready` backstop; cleared the
      // moment `ready` arrives, below.
      let startupTimer: ReturnType<typeof setTimeout> | null = null
      let graceTimer: ReturnType<typeof setTimeout> | null = null
      let silenceTimer: ReturnType<typeof setTimeout> | null = null
      let abortReason: AbortReason | null = null
      let abortDetail: string | undefined
      // Plan 98 §4.7, §4.8, H1 — the peak of every `rss` sample this attempt
      // has reported. `null` until the first sample arrives (never 0 — a real
      // RSS reading of exactly zero bytes cannot happen, so this stays a
      // clean "no sample yet" rather than a plausible-looking measurement).
      let peakRssBytes: number | null = null
      // Plan 98 §3.6 — set the moment EITHER warning fires (the 80% pre-kill
      // warning under `enforce: 'kill'`, or the single breach warning under
      // `enforce: 'warn'`), so a long-running job never gets a second one:
      // "exactly one warning" is the acceptance bar, not "one warning per
      // threshold crossing".
      let memoryWarningLogged = false

      const isolation = deps.isolation ?? defaultIsolation
      const child: Subprocess<'ignore', 'pipe', 'pipe'> = isolation.spawn(
        {
          entryPath: childEntryPath,
          bundlePath,
          jobId: job.id,
          env: {
            ENKAKU_JOB_ID: job.id,
            ...(job.scriptExportId ? { ENKAKU_SCRIPT_EXPORT_ID: job.scriptExportId } : {}),
          },
        },
        handleChildMessage,
      )

      const send = (msg: ParentToChild) => {
        try {
          child.send(msg)
        } catch {
          // the child is already gone — handled by the exit path
        }
      }

      const finish = (outcome: AttemptOutcome) => {
        if (settled) return
        settled = true
        // Plan 128 §4.1 — close whatever phase this attempt was in, so the
        // phase lane has an end for every start rather than one open band
        // running to the right edge of the timeline.
        tee.closePhase()
        for (const t of [killTimer, timeoutTimer, startupTimer, graceTimer, silenceTimer]) if (t) clearTimeout(t)
        opts.aborter.current = null
        try {
          child.kill()
        } catch {
          // already gone
        }
        resolve(outcome)
      }

      const resetSilenceTimer = () => {
        if (silenceTimer) clearTimeout(silenceTimer)
        silenceTimer = setTimeout(() => {
          logger.append('error', 'runner', `child diam > ${effectiveSilenceLimitMs}ms — dianggap hang`)
          doAbort('hung')
        }, effectiveSilenceLimitMs)
      }

      const doAbort = (reason: AbortReason, detail?: string) => {
        if (settled || abortReason) return
        abortReason = reason
        abortDetail = detail
        logger.append('warn', 'runner', `abort attempt ${attempt}: ${reason}${detail ? ` (${detail})` : ''}`)
        if (reason === 'memory') {
          // Plan 98 §3.6 — deliberately harsher than every other abort
          // reason: NO `abort` IPC message, NO grace period. A process
          // already at (or past) its declared memory ceiling cannot be
          // trusted to unwind politely — asking it to allocate further for a
          // clean shutdown, or even to receive and parse one more IPC
          // message, is asking it to fail worse against a host that is
          // already unhappy. SIGKILL immediately.
          //
          // This does NOT skip `finish()` — it relocates it. This attempt's
          // `finishRan` stays false (the child never gets to send a `result`
          // with `finishRan: true`), so `execute()`'s existing finish-only
          // re-run (spec §11.2, F15) fires unconditionally in a FRESH
          // process, with clean memory and `ctx.error.code === 'MEMORY_LIMIT'`
          // populated. That re-run is unaffected by anything that happens to
          // this doomed process from here on.
          try {
            child.kill('SIGKILL')
          } catch {
            // already gone
          }
          return
        }
        send({ t: 'abort', reason })
        // Give `finish` a chance to run; past the grace period → SIGTERM then SIGKILL.
        graceTimer = setTimeout(() => {
          try {
            child.kill('SIGTERM')
          } catch {
            /* already gone */
          }
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              /* already gone */
            }
          }, SIGKILL_DELAY_MS)
        }, FINISH_GRACE_MS)
      }
      /**
       * Plan 98 §3.5, §3.6, §4.8 — the three `job.memory.enforce` modes,
       * evaluated on every self-reported `rss` sample. `off` and "no ceiling
       * configured" both no-op immediately: peak recording (above, in
       * `handleChildMessage`) is unconditional and already covers "record
       * the peak either way" on its own.
       *
       * `'kill'`: one `warn` at `MEMORY_WARN_FRACTION` (80%) of the limit,
       * once per attempt — "a kill with no warning is a mystery; a kill with
       * a warning 40s earlier is a diagnosis" (§3.6) — then `doAbort('memory', …)`
       * the moment a sample reaches the limit itself. No repeated warnings:
       * once `abortReason` is set, `doAbort` is a no-op on every later call
       * (its own top-of-function guard), so a burst of samples all above the
       * limit before the child actually dies can never double-kill.
       *
       * `'warn'`: the job is never touched — exactly ONE `warn` the first
       * time a sample reaches the limit, then silence for the rest of the
       * attempt even if it stays over the limit for its whole remaining run.
       * This is deliberately a DIFFERENT warning than the 80% one above: the
       * 80% warning exists to precede a kill that is coming; under `'warn'`
       * no kill is coming, so there is nothing to precede — the breach
       * itself is the whole story, and printing both would double the log
       * line for the exact one-warning bar this mode is measured against.
       */
      const checkMemoryBreach = (bytes: number): void => {
        // `memory` closes over the SAME `const` `runAttempt` computed
        // `memoryLimitConfigured`/`effectiveRssSampleMs` from, above.
        if (!memory || memory.maxRssBytes === null || memory.enforce === 'off') return
        const limit = memory.maxRssBytes
        if (memory.enforce === 'kill') {
          if (bytes >= limit) {
            doAbort('memory', `rss ${bytes} bytes >= limit ${limit} bytes`)
            return
          }
          if (!memoryWarningLogged && bytes >= limit * MEMORY_WARN_FRACTION) {
            memoryWarningLogged = true
            logger.append(
              'warn',
              'runner',
              `memory approaching limit: rss ${bytes} bytes is ${Math.round((bytes / limit) * 100)}% of the ${limit} byte limit`,
            )
          }
          return
        }
        // memory.enforce === 'warn'
        if (!memoryWarningLogged && bytes >= limit) {
          memoryWarningLogged = true
          logger.append(
            'warn',
            'runner',
            `memory limit exceeded: rss ${bytes} bytes >= the ${limit} byte limit (enforce=warn — the job continues)`,
          )
        }
      }

      opts.aborter.current = doAbort

      const sendInit = () => {
        if (settled) return
        send({
          t: 'init',
          mode,
          // `nodeId` (plan 99 §3.2, §4.8) is the workflow node this
          // execution belongs to — undefined for every job outside a
          // workflow, which keeps this shape exactly what it was before.
          job: { id: job.id, attempt, deviceId: job.deviceId, ...(job.nodeId !== undefined ? { nodeId: job.nodeId } : {}) },
          params: job.params ?? {},
          ...(opts.priorError ? { priorError: opts.priorError } : {}),
          // Plan 98 §4.7 — `job.memory.sampleIntervalMs` once a ceiling is
          // configured for this attempt, the coarse default otherwise.
          rssSampleMs: effectiveRssSampleMs,
          // Plan 97 §3.4, §4.9 — the farm's own setting when the caller
          // resolved one, `RESULT_LIMITS.defaultMaxResultBytes` otherwise
          // (a finish-only attempt, or a caller — chiefly a test — that
          // predates this field).
          maxResultBytes: opts.maxResultBytes ?? RESULT_LIMITS.defaultMaxResultBytes,
          // Plan 97 §3.7, §4.9 — `DEFAULT_PROGRESS_INTERVAL_MS` mirrors
          // `job.progressIntervalMs`'s own zod default (`settings.ts`) the
          // same way `RESULT_LIMITS.defaultMaxResultBytes` mirrors
          // `maxResultBytes`'s: one hardcoded number per file, not a shared
          // import, because a caller — chiefly a test — that predates this
          // field should not need to reach into `@enkaku/protocol` just to
          // get a runner working.
          progressIntervalMs: opts.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
        })
      }

      /**
       * The `ready` → reset → `init` ordering (plan 35 §4.3): the child holds
       * until `init` arrives (the existing handshake — nothing new), so the
       * parent gets to run the pre-job reset first, using the `reset`
       * declaration `ready` just carried, and only then lets the script
       * begin. A finish-only attempt exists to run `finish()` after a
       * failure, and `finish` needs the state a reset would wipe — so it
       * skips the reset entirely and sends `init` immediately.
       */
      const afterReady = async (msg: Extract<ChildToParent, { t: 'ready' }>): Promise<void> => {
        if (mode === 'finish-only') {
          sendInit()
          return
        }
        // Plan 99 §3.3, §3.4, §4.8: a workflow node declares `reset: 'none'`
        // when it needs the state the PREVIOUS node left the device in — the
        // same reason the finish-only branch above skips the reset ("finish
        // needs the state a reset would wipe"), applied to a whole node
        // rather than just its finish(). `job.reset` is undefined for every
        // job outside a workflow, which takes the farm's normal
        // `resetPolicy` below exactly as before this field existed.
        if (job.reset === 'none') {
          sendInit()
          return
        }
        const settings = getResetSettings()
        // `none` reproduces today's behaviour exactly (acceptance #4): no
        // reset phase, no device event, no delay before `init`.
        if (settings.resetPolicy === 'none') {
          sendInit()
          return
        }
        const plan: ResetPlan = {
          policy: settings.resetPolicy,
          packages: msg.reset?.packages ?? [],
          ...(msg.reset?.clearData !== undefined ? { clearData: msg.reset.clearData } : {}),
        }
        logger.append('info', 'runner', `reset: policy=${plan.policy}`)
        tee.phase('reset')
        deps.onPhase(job.id, attempt, 'reset')
        // The child is idle while this runs — deliberately, it is waiting
        // for `init` — so the "no message in 30s = hung" watchdog is paused
        // for the duration rather than misreading a quiet reset as a dead
        // child (resetTimeoutMs can run up to 60s).
        if (silenceTimer) {
          clearTimeout(silenceTimer)
          silenceTimer = null
        }
        const resetStart = Date.now()
        const outcome = await resetDevice(session, plan, { timeoutMs: settings.resetTimeoutMs }).catch(
          (err): ResetOutcome => ({
            applied: [],
            warnings: [`reset failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`],
            durationMs: Date.now() - resetStart,
          }),
        )
        logger.append(
          outcome.warnings.length > 0 ? 'warn' : 'info',
          'runner',
          `reset done: applied=${outcome.applied.length} warnings=${outcome.warnings.length} durationMs=${outcome.durationMs}`,
          { applied: outcome.applied, warnings: outcome.warnings },
        )
        deps.onReset?.(job.id, job.deviceId, outcome, plan)
        if (settled) return
        // The reset is over — resume watching for child activity.
        resetSilenceTimer()
        if (outcome.warnings.length > 0 && settings.resetStrict) {
          finish({
            ok: false,
            error: { code: 'RESET_FAILED', message: `pre-job reset failed: ${outcome.warnings.join('; ')}`, phase: 'reset' },
            finishRan: false,
            ...(peakRssBytes !== null ? { peakRssBytes } : {}),
          })
          return
        }
        sendInit()
      }

      function handleChildMessage(raw: unknown): void {
        const parsed = ChildToParentSchema.safeParse(raw)
        if (!parsed.success) return
        const msg = parsed.data as ChildToParent
        resetSilenceTimer()
        // Plan 98 §4.7 — an `rss` sample is proof of life (the silence timer
        // above still resets) but NOT heartbeat-renewal activity: at a fast
        // sample cadence, treating every sample as a heartbeat would multiply
        // heartbeat-renewal writes for no benefit.
        if (msg.t !== 'rss') deps.heartbeat(job.id)

        if (msg.t === 'rss') {
          if (peakRssBytes === null || msg.bytes > peakRssBytes) peakRssBytes = msg.bytes
          // Plan 98 §3.6, §4.8 — checked on EVERY sample, peak recording or
          // not: a limit is enforced by sampling, so the sample that reports
          // the breach is also the sample that decides it.
          checkMemoryBreach(msg.bytes)
        } else if (msg.t === 'ready') {
          logger.append('debug', 'runner', `child ready: ${msg.scriptId}@${msg.version}`)
          // The startup backstop's job is done the moment the child has
          // spoken at all (plan 74 §3.2) — a slow-but-alive child is not
          // what it exists to catch.
          if (startupTimer) {
            clearTimeout(startupTimer)
            startupTimer = null
          }
          // Plan 98 §3.1, §5 step 98.4 — the reconciliation check. Once a
          // script is persisted, `ready.runtime` (the bundle's own report)
          // stops being a source of truth and becomes a CHECK against the
          // row this job was pinned to (`job.runtime`, handed over by the
          // host — see `JobSpec.runtime`'s doc comment). `job.runtime ===
          // undefined` means the host never wired this at all (a caller
          // that predates this field) — skip the check rather than warn
          // about something nobody can act on. Exactly ONE warning per
          // attempt, naming BOTH values, no matter how many fields differ —
          // never a warning per field. The DB value (`job.runtime`) is what
          // actually governs this attempt (see the `resolveRuntime` call in
          // `execute()` below); this comparison changes nothing about that
          // — it only makes a stale or hand-doctored bundle visible instead
          // of silently authoritative.
          if (job.runtime !== undefined && runtimeEnvelopesDiffer(job.runtime, msg.runtime)) {
            logger.append(
              'warn',
              'runner',
              `runtime envelope mismatch for ${msg.scriptId}@${msg.version}: the published row declares ${JSON.stringify(job.runtime ?? null)}, the running bundle reports ${JSON.stringify(msg.runtime ?? null)} — the published row is used`,
            )
          }
          if (opts.meta) {
            if (msg.timeoutMs !== undefined) opts.meta.timeoutMs = msg.timeoutMs
            if (msg.retries !== undefined) opts.meta.retries = msg.retries
            opts.meta.scriptId = msg.scriptId
            opts.meta.version = msg.version
            opts.meta.pluginId = msg.pluginId
          }
          // Effective timeout is def.timeout when the script sets one,
          // clamped against the farm's optional ceiling (plan 74 §3.3, §4.2)
          // — logged by name whenever the clamp actually changes the value.
          if (mode === 'full' && msg.timeoutMs !== undefined) {
            const effective = clampTimeoutMs(
              msg.timeoutMs,
              opts.maxTimeoutMs ?? null,
              `${msg.scriptId}@${msg.version}`,
              (line) => logger.append('warn', 'runner', line),
            )
            if (effective !== timeoutMs) {
              if (timeoutTimer) clearTimeout(timeoutTimer)
              timeoutTimer = setTimeout(() => doAbort('timeout'), effective)
            }
          }
          // The declared crash-policy target (plan 37 §3.4) — known as soon
          // as `ready` arrives, before `init` is even sent.
          declaredPackages = msg.reset?.packages ?? []
          reportTargetPackages()
          void afterReady(msg)
        } else if (msg.t === 'phase') {
          logger.append('info', 'runner', `phase ${msg.phase} (attempt ${attempt})`)
          // Plan 128 §3.4 — every `phase` start carries `{ inspectorEngineId,
          // framePolicy }` resolved AT THAT MOMENT. This is where the Timeline
          // tab's policy line comes from, and why it is per phase rather than
          // per job: the ui-server watchdog can declare the engine dead
          // mid-run and the session falls back, so a job really can change
          // capture policy while it is running.
          tee.phase(msg.phase)
          deps.onPhase(job.id, attempt, msg.phase)
          if (msg.phase === 'finish') finishRan = true
        } else if (msg.t === 'log') {
          logger.append(msg.level, 'script', msg.msg, msg.fields)
        } else if (msg.t === 'progress') {
          // Plan 97 §3.7, §4.3 — forwarded verbatim; already coalesced by the
          // child's own timer. No DB write, no size check, no rate limit
          // here — those live one hop further out (`executor-host.ts`).
          tee.progress(msg.value)
          deps.onProgress?.(job.id, msg.value)
        } else if (msg.t === 'heartbeat') {
          // already handled by resetSilenceTimer and the job heartbeat
        } else if (msg.t === 'device.call') {
          const call = DeviceCallSchema.safeParse(msg)
          if (!call.success) {
            send({ t: 'device.result', callId: msg.callId, ok: false, error: { code: 'BAD_CALL', message: 'invalid call' } })
            return
          }
          // Plan 128 §3.1 — the single boundary every device action a script
          // takes is visible at, in order, with its arguments already
          // Zod-parsed. `begin` is synchronous and returns a token; nothing
          // about `execDevice` moves.
          const traceToken = tee.begin(call.data)
          void execDevice(call.data)
            .then((value) => {
              // Plan 74 §3.5, §4.3, criterion 12 — a `find` refusal is
              // diagnosable from the job log even for a script that only
              // ever called plain `find()` and never saw the reason itself:
              // the IPC value is the SAME `FindOutcome` regardless of which
              // SDK call the script made.
              if (call.data.method === 'find') {
                const outcome = FindOutcomeSchema.safeParse(value)
                if (outcome.success && !outcome.data.ok) {
                  logger.append(
                    'warn',
                    'runner',
                    `find refused: ${outcome.data.reason} (sel=${JSON.stringify(call.data.args.sel)}, matches=${outcome.data.matches})`,
                  )
                }
              }
              tee.end(traceToken, { ok: true, value })
              send({ t: 'device.result', callId: msg.callId, ok: true, value })
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              // Plan 36 §3.2's classifier needs the REAL code (an AdbError's
              // E_ADB_TIMEOUT and friends, not just a SessionError) to reach
              // the job's failure — collapsing every non-SessionError into a
              // generic DEVICE_CALL_FAILED would make infra classification
              // unreachable for the most common infra codes there are.
              const code =
                err instanceof SessionError
                  ? err.code
                  : err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
                    ? (err as { code: string }).code
                    : 'DEVICE_CALL_FAILED'
              tee.end(traceToken, { ok: false, code, message })
              send({ t: 'device.result', callId: msg.callId, ok: false, error: { code, message } })
            })
        } else if (msg.t === 'kv.call') {
          const call = KvCallSchema.safeParse(msg)
          if (!call.success) {
            send({ t: 'kv.result', callId: msg.callId, ok: false, error: { code: 'BAD_CALL', message: 'invalid call' } })
            return
          }
          if (!deps.kv) {
            send({ t: 'kv.result', callId: msg.callId, ok: false, error: { code: 'E_KV_UNAVAILABLE', message: 'the kv store is not available on this host' } })
            return
          }
          // The namespace is the owning plugin's id when this is a plugin member
          // (`pluginId`, plan 82 §3.10), or the script's own id for a standalone
          // script (plan 79 §3.2) — both known from its `ready` message, always
          // populated by the time a script can be running `prepare`/`run`/`finish`,
          // since `ready` is handled before `init` (and therefore before the
          // script can issue any call) is ever sent.
          const namespace = opts.meta?.pluginId ?? opts.meta?.scriptId ?? job.id
          void deps
            .kv
            .call({ jobId: job.id, deviceId: job.deviceId, namespace }, call.data)
            .then((value) => send({ t: 'kv.result', callId: msg.callId, ok: true, value }))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              const code =
                err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
                  ? (err as { code: string }).code
                  : 'KV_CALL_FAILED'
              send({ t: 'kv.result', callId: msg.callId, ok: false, error: { code, message } })
            })
        } else if (msg.t === 'jobs.call') {
          const call = JobsCallSchema.safeParse(msg)
          if (!call.success) {
            send({ t: 'jobs.result', callId: msg.callId, ok: false, error: { code: 'BAD_CALL', message: 'invalid call' } })
            return
          }
          if (!deps.jobs) {
            send({
              t: 'jobs.result',
              callId: msg.callId,
              ok: false,
              error: { code: 'E_JOBS_UNAVAILABLE', message: 'job listing is not available on this host' },
            })
            return
          }
          void deps.jobs
            .call({ jobId: job.id, deviceId: job.deviceId }, call.data)
            .then((value) => send({ t: 'jobs.result', callId: msg.callId, ok: true, value }))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              const code =
                err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
                  ? (err as { code: string }).code
                  : 'JOBS_CALL_FAILED'
              send({ t: 'jobs.result', callId: msg.callId, ok: false, error: { code, message } })
            })
        } else if (msg.t === 'farm.call') {
          // Plan 109 §4.3, step 109.1 — `ctx.farm`'s parent side, the same
          // shape `kv.call`/`jobs.call` above already use.
          const call = FarmCallSchema.safeParse(msg)
          if (!call.success) {
            send({ t: 'farm.result', callId: msg.callId, ok: false, error: { code: 'BAD_CALL', message: 'invalid call' } })
            return
          }
          if (!deps.farm) {
            send({
              t: 'farm.result',
              callId: msg.callId,
              ok: false,
              error: { code: 'E_FARM_UNAVAILABLE', message: 'the farm capability broker is not available on this host' },
            })
            return
          }
          // A standalone script has no plugin, therefore no manifest, therefore
          // nothing for the broker's declared-permission check to read and no
          // `plugin:<name>` principal to audit under. It is refused HERE rather
          // than passed on under `kv.call`'s `scriptId ?? jobId` fallback: once
          // that fallback has been applied the core cannot tell "plugin foo"
          // from "standalone script foo", and would check one against the
          // other's manifest.
          const pluginId = opts.meta?.pluginId
          if (pluginId === undefined) {
            send({
              t: 'farm.result',
              callId: msg.callId,
              ok: false,
              error: {
                code: 'E_FARM_NO_PLUGIN',
                message:
                  'ctx.farm is only available to a plugin member: a standalone script has no manifest to declare capabilities in. Publish this script inside a plugin and declare what it needs in defineService({ permissions }).',
              },
            })
            return
          }
          void deps.farm
            .call({ jobId: job.id, deviceId: job.deviceId, pluginId }, call.data)
            .then((value) => send({ t: 'farm.result', callId: msg.callId, ok: true, value }))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              const code =
                err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
                  ? (err as { code: string }).code
                  : 'FARM_CALL_FAILED'
              send({ t: 'farm.result', callId: msg.callId, ok: false, error: { code, message } })
            })
        } else if (msg.t === 'artifact.save') {
          void (async () => {
            try {
              const data =
                msg.kind === 'screenshot'
                  ? // The screenshot is taken IN THE CORE → its ordering follows the per-device queue.
                    await (session.inspector ?? new UiautomatorDumpInspector(session.transport)).screenshot()
                  : Uint8Array.from(Buffer.from(msg.dataBase64 ?? '', 'base64'))
              const saved = await artifacts.save({
                kind: msg.kind,
                label: msg.label,
                data,
                ...(msg.ext ? { ext: msg.ext } : {}),
              })
              // Plan 128 §3.2 — the second exclusion: an artifact screenshot
              // is recorded as an `artifact` event whose frame hash is the
              // artifact's OWN bytes. No second capture, for the same
              // recursion reason `method: 'screenshot'` gets.
              tee.artifact({ kind: msg.kind, label: msg.label, sizeBytes: saved.sizeBytes, ...(msg.kind === 'screenshot' ? { frameBytes: data } : {}) })
              deps.onArtifact(job.id, { kind: msg.kind, label: msg.label, ...saved })
              // Plan 115 §3.6 — the bridge: `saved.id` is what
              // `ctx.artifact.file()` hands back to the script, so it can
              // pass it straight to `ctx.device.push({ artifactId })`.
              send({ t: 'artifact.result', callId: msg.callId, ok: true, artifactId: saved.id })
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              const code = err instanceof SessionError ? err.code : 'ARTIFACT_FAILED'
              logger.append('error', 'runner', `artifact "${msg.label}" failed: ${message}`)
              send({ t: 'artifact.result', callId: msg.callId, ok: false, error: { code, message } })
            }
          })()
        } else if (msg.t === 'result') {
          if (abortReason) {
            // The parent decides to abort → the parent also decides
            // the reason; whatever the child reports, success or failure, is ignored.
            finish({
              ok: false,
              error: {
                code: abortErrorCode(abortReason),
                message: abortDetail ?? `attempt di-abort (${abortReason})`,
                phase: 'timeout',
              },
              finishRan: msg.finishRan || finishRan,
              ...(peakRssBytes !== null ? { peakRssBytes } : {}),
            })
            return
          }
          finish({
            ok: msg.ok,
            ...(msg.value !== undefined ? { value: msg.value } : {}),
            ...(msg.error ? { error: { code: msg.error.code, message: msg.error.message, phase: msg.error.phase } } : {}),
            finishRan: msg.finishRan || finishRan,
            ...(peakRssBytes !== null ? { peakRssBytes } : {}),
            // Plan 97 §3.3, §4.3 — carried straight through; `undefined` for
            // every message a pre-plan-97 bundle sends (`outcome` is optional
            // on the wire precisely so that still parses).
            ...(msg.outcome !== undefined ? { outcome: msg.outcome } : {}),
          })
        }
      }

      // The child's stdout/stderr goes to the job log (scripts may console.log).
      void pipeLines(child.stdout, (line) => logger.append('info', 'stdout', line))
      void pipeLines(child.stderr, (line) => logger.append('warn', 'stderr', line))

      void child.exited.then((code) => {
        if (settled) return
        finish({
          ok: false,
          error: abortReason
            ? { code: abortErrorCode(abortReason), message: abortDetail ?? `child di-abort (${abortReason})`, phase: 'timeout' }
            : { code: 'CHILD_CRASHED', message: `child exited ${code} without sending a result`, phase: 'run' },
          finishRan,
          ...(peakRssBytes !== null ? { peakRssBytes } : {}),
        })
      })

      resetSilenceTimer()
      timeoutTimer = setTimeout(() => doAbort('timeout'), timeoutMs)
      // Plan 74 §3.2, §4.2 — armed alongside the run timer, cleared the
      // moment `ready` arrives (above). This is the SHORT backstop for a
      // child that never starts at all; the run timer above is the real
      // budget once it has. `undefined` (a finish-only attempt) arms nothing
      // extra — `FINISH_ONLY_TIMEOUT_MS` is already short enough.
      if (opts.startupTimeoutMs !== undefined) {
        startupTimer = setTimeout(() => doAbort('startup-timeout'), opts.startupTimeoutMs)
      }

      // `init` is no longer sent here — the child holds until its `ready`
      // message has been read and (for a 'full' attempt) the pre-job reset
      // has run; see `afterReady` above (plan 35 §4.3).
    })
  }

  return {
    abort(jobId, reason, detail) {
      const running = active.get(jobId)
      if (!running) return false
      running.abort(reason, detail)
      return true
    },

    async execute(job) {
      // timeout, retries, and the kv namespace (plan 79 §3.2) are only known
      // once the child has imported the bundle; it sends them in the `ready`
      // message. Declared BEFORE the logger, so `redact` below can close over
      // `meta.scriptId` and see it update once `ready` arrives — a job-log
      // line from before that point has nothing to redact against anyway.
      const meta: { timeoutMs?: number; retries?: number; scriptId?: string; version?: string; pluginId?: string } = {}
      // Declared here, above the tee, because the tee's `engineId` accessor
      // and its capture thunk both read the LIVE session: it is acquired and
      // released once per attempt, and the ui-server watchdog can swap the
      // inspector engine underneath a running one (plan 128 §3.4).
      let session: DeviceSession | null = null
      let traceAttempt = 1

      /**
       * Plan 128 §3.4, step 128.4 — the capture thunk. This is the ONLY place
       * in the tee's path that touches a device, and it is reached only after
       * `end()` has already returned: nothing here is on the critical path
       * the script's own call sits on.
       *
       * `'reuse'` never goes back to the device — the bytes or the tree are
       * the ones the call already produced (§3.2, §3.4). A frame failure
       * rejects (the event records `frameStatus: 'failed'`); a UI-tree
       * failure does NOT, because losing the tree is no reason to also throw
       * away a frame that was captured successfully.
       */
      const captureForTrace = async (req: TraceCaptureRequest): Promise<TraceCaptureResult> => {
        const store = deps.traceStore
        if (!store) return { frameHash: null, uiHash: null }
        const inspector = session?.inspector ?? null
        let frameHash: string | null = null
        if (req.frame === 'reuse') {
          const bytes = toFrameBytes(req.frameValue)
          if (bytes) frameHash = await store.putFrame(job.id, bytes)
        } else if (req.frame === 'capture' && inspector) {
          frameHash = await store.putFrame(job.id, await inspector.screenshot())
        }
        let uiHash: string | null = null
        try {
          if (req.uiTree === 'reuse') {
            const tree = toTraceUiTree(req.method, req.treeValue)
            if (tree !== null) uiHash = await store.putUiTree(job.id, tree)
          } else if (req.uiTree === 'capture' && inspector) {
            uiHash = await store.putUiTree(job.id, await inspector.dump())
          }
        } catch {
          uiHash = null
        }
        return { frameHash, uiHash }
      }

      const tee: TraceTee = deps.onTraceEvent
        ? createTraceTee({
            jobId: job.id,
            ...(job.nodeId !== undefined ? { nodeId: job.nodeId } : {}),
            attempt: () => traceAttempt,
            // Read fresh, never captured: `inspectorEngineId` is `'starting'`
            // until an engine actually resolves, and changes again after a
            // watchdog fallback (§3.4).
            engineId: () => (session?.inspector ? session.inspectorEngineId : null),
            emit: (event) => deps.onTraceEvent!(job.id, event),
            // No store wired ⇒ no `capture` ⇒ the policy resolves to `'none'`
            // while the engine id is still reported honestly on every phase
            // event, so the timeline says "no frames", not "no inspector".
            ...(deps.traceStore ? { capture: captureForTrace } : {}),
          })
        : createNoopTraceTee()

      const logger = createJobLogger({
        dataDir: deps.logDir,
        jobId: job.id,
        // Plan 128 §3.8 — the trace TEES the logger, it does not replace it:
        // `deps.onLog` still fires first and unchanged, and `job.log`/`GET
        // /api/jobs/:id/logs` keep their exact shapes. Teeing at `onEntry`
        // rather than at each `logger.append` call site is deliberate: every
        // line is already secret-redacted by this point (plan 79 §4.7), and
        // stdout/stderr from the child come through here too.
        onEntry: (entry) => {
          deps.onLog(entry)
          tee.log(entry)
        },
        redact: deps.kv ? (text) => deps.kv!.redact({ deviceId: job.deviceId, namespace: meta.pluginId ?? meta.scriptId }, text) : undefined,
      })
      const artifacts = deps.artifacts(job.id)
      const aborter: { current: ((reason: AbortReason, detail?: string) => void) | null } = { current: null }
      active.set(job.id, {
        abort: (reason, detail) => aborter.current?.(reason, detail),
      })

      let outcome: AttemptOutcome = { ok: false, finishRan: false, error: { code: 'NOT_RUN', message: 'not run yet', phase: 'run' } }
      const noopFrame = () => {}
      const classify = deps.classify ?? ((err: unknown) => ({ class: 'script' as const, ...toCodeAndMessage(err), blameDevice: false }))

      // Two SEPARATE budgets (plan 36 §3.4): `scriptAttempts` is spent only on
      // the author's own `ScriptDefinition.retries`; `infraAttempts` is spent
      // only on the farm-level `job.retry.maxInfraAttempts`. Total attempts is
      // therefore bounded by `1 + retries + maxInfraAttempts` (acceptance #2)
      // without needing a separate combined check.
      let scriptAttempts = 0
      let infraAttempts = 0
      // Plan 98 §4.8, H1 — the job's own peak, the MAX across every attempt
      // (retries and the finish-only re-run alike), not just the last one:
      // a job that fails on attempt 1 with a high watermark and succeeds on
      // attempt 2 at a lower one should still report the high number — it
      // really did use that much memory at some point during this job.
      let jobPeakRssBytes: number | null = null
      const noteAttemptPeak = (o: AttemptOutcome | undefined) => {
        if (o?.peakRssBytes !== undefined && (jobPeakRssBytes === null || o.peakRssBytes > jobPeakRssBytes)) {
          jobPeakRssBytes = o.peakRssBytes
        }
      }

      try {
        const bundlePath = job.bundlePath
        let attempt = 0
        for (;;) {
          attempt += 1
          traceAttempt = attempt

          // The device session (display/input/inspector engines) is acquired
          // PER ATTEMPT and released again below, before any backoff wait —
          // a job waiting to retry must not hold the device it is about to
          // leave, or the one it is about to retry on (plan 36 §3.5,
          // acceptance #4).
          let acquireFailure: ScriptFailure | null = null
          try {
            session = await deps.sessions.acquire(job.deviceId, noopFrame)
            // Manual control does not wait for the inspector, but a script
            // does: its very first waitFor should use the real engine rather
            // than the slower ad-hoc dump fallback.
            await session.whenInspectorReady()
          } catch (err) {
            session = null
            const { code, message } = toCodeAndMessage(err)
            acquireFailure = { code: code === 'UNKNOWN' ? 'SESSION_ACQUIRE_FAILED' : code, message, phase: 'acquire' }
          }

          if (acquireFailure) {
            outcome = { ok: false, finishRan: false, error: acquireFailure }
          } else {
            // Fresh per attempt, not captured at daemon start (plan 74 §4.2)
            // — the same pattern `resetPolicy`/`timing` already use, so a
            // Settings change applies to the very next job with no restart.
            const settings = getResetSettings()
            // `DEFAULT_TIMEOUT_MS` no longer exists (criterion 3): the farm
            // default IS the settings value. The clamp (§3.3) applies only to
            // a SCRIPT's own request — `meta.timeoutMs`, known from a prior
            // attempt's `ready` — never to the farm default itself: the
            // default is the operator's own setting, not something to warn
            // the operator about relative to their OTHER setting.
            const timeoutMs =
              meta.timeoutMs !== undefined
                ? clampTimeoutMs(meta.timeoutMs, settings.maxTimeoutMs, `${meta.scriptId}@${meta.version}`, (line) =>
                    logger.append('warn', 'runner', line),
                  )
                : settings.defaultTimeoutMs
            // Plan 98 §3.5, §3.6, §3.8, §4.8, step 98.7 — the memory ceiling
            // for this attempt. `script` is the job's own pinned declaration
            // (step 98.4 — `job.runtime`, read by the host straight off the
            // `scripts` row this job was enqueued against, per spec §11.6);
            // `override` is the operator's own per-job layer (step 98.7 —
            // `job.runtimeOverride`, pinned onto `jobs.runtime_override` at
            // enqueue and already ceiling-checked there — this is the exact
            // one-line change step 98.3's own comment at this call site
            // predicted, and no other line here moved). `resolveRuntime`
            // already treats "layer declared nothing" (`null`) identically
            // to "no such layer exists" (§3.8), so a pre-plan-98 script
            // (`job.runtime` undefined or null) with no override resolves to
            // exactly what it did before this plan existed: the farm's own
            // `job.memory.defaultMaxRssBytes`, clamped against its own
            // `job.memory.maxRssBytes` ceiling.
            const { resolved: resolvedMemory, clamps: memClamps } = resolveRuntime({
              farm: settings,
              script: job.runtime ?? null,
              override: job.runtimeOverride ?? null,
            })
            // Plan 98 §3.8, §4.8, step 98.7 — "the origin (script / farm /
            // override / clamped) recorded in the job log", so a job's OWN
            // log answers "why did this run get the number it got" even
            // after farm settings change later, not just Studio's live
            // Runtime card (§3.9 item 3). A CLAMP always wins the naming —
            // it is the one case that changed what was actually asked for —
            // and covers a plain SCRIPT declaration over the ceiling too
            // (§3.8's own asymmetry: clamped and logged, never refused),
            // extending `clampTimeoutMs`'s existing "never silent" precedent
            // to `maxRssBytes`, which `resolveRuntime` has always computed a
            // clamp for but nothing here consumed until this step. Otherwise,
            // an override actually in effect (not clamped) gets exactly one
            // line naming it — the new thing this step introduces; a plain
            // script-or-farm resolution (unchanged since before this step)
            // stays silent, matching `clampTimeoutMs`'s own "only log what
            // changed" philosophy.
            const memClamp = memClamps.find((c) => c.field === 'maxRssBytes')
            if (memClamp) {
              logger.append(
                'warn',
                'runner',
                `memory ceiling clamp: ${meta.scriptId ?? job.id} requested ${memClamp.requested} bytes (from ${memClamp.from}) — clamped to the farm ceiling of ${memClamp.ceiling} bytes`,
              )
            } else if (job.runtimeOverride?.maxRssBytes !== undefined) {
              logger.append('info', 'runner', `attempt ${attempt} memory ceiling ${resolvedMemory.maxRssBytes} bytes (origin: override)`)
            }
            logger.append('info', 'runner', `attempt ${attempt} starting`)
            outcome = await runAttempt({
              job,
              attempt,
              bundlePath,
              session: session as DeviceSession,
              timeoutMs,
              startupTimeoutMs: settings.startupTimeoutMs,
              maxTimeoutMs: settings.maxTimeoutMs,
              mode: 'full',
              // Plan 97 §3.4, §4.9 — same "read fresh per attempt" settings
              // read every other farm-level field on this call already uses.
              maxResultBytes: settings.maxResultBytes,
              // Plan 97 §3.7, §4.9 — same freshness convention, one line below.
              progressIntervalMs: settings.progressIntervalMs,
              memory: {
                maxRssBytes: resolvedMemory.maxRssBytes,
                enforce: settings.memory.enforce,
                sampleIntervalMs: settings.memory.sampleIntervalMs,
              },
              logger,
              artifacts,
              aborter,
              meta,
              tee,
            })
            noteAttemptPeak(outcome)
          }
          if (outcome.ok) {
            if (session) deps.sessions.release(job.deviceId, noopFrame)
            session = null
            break
          }

          // `finish` MUST run (spec §11.2): if the child died before it, run a
          // finish-only attempt in a fresh process (with ctx.error populated).
          // Only meaningful when a session actually exists — an acquire
          // failure never spawned a child in the first place.
          if (session && !outcome.finishRan) {
            logger.append('warn', 'runner', 'finish has not run — starting a finish-only attempt')
            const finishOutcome = await runAttempt({
              job,
              attempt,
              bundlePath,
              session,
              timeoutMs: FINISH_ONLY_TIMEOUT_MS,
              mode: 'finish-only',
              ...(outcome.error ? { priorError: outcome.error } : {}),
              logger,
              artifacts,
              aborter,
              // `finish()` may call ctx.kv too — carry the namespace already learned from this job's
              // earlier `ready` message (plan 79 §3.2) rather than leaving a finish-only attempt with
              // no namespace at all.
              meta,
              tee,
            }).catch(() => undefined)
            // A finish-only re-run gets a fresh process (spec §11.2) that can
            // allocate its own memory — its peak counts toward the job's
            // overall peak exactly like any other attempt's (plan 98 §4.8).
            noteAttemptPeak(finishOutcome)
            // Plan 97 §3.5, §4.2, step 97.4 — the finish-only re-attempt is
            // the ONLY carrier for a `finish()` salvage once THIS attempt
            // reaches here: whenever `!outcome.finishRan` is true, `outcome`
            // itself has no value/outcome of its own to lose (an abort
            // branch in `handleChildMessage` above deliberately drops
            // whatever the original child reported, and a child that never
            // sent a `result` at all obviously has none either) — so merging
            // is always safe, never an overwrite of a real run() value.
            // `outcome.error`/`.code`/`.finishRan` stay THIS attempt's own —
            // the retry classifier just below reads `outcome.error`, and a
            // finish-only run has no error of its own to classify.
            if (finishOutcome?.value !== undefined) {
              outcome = { ...outcome, value: finishOutcome.value, ...(finishOutcome.outcome !== undefined ? { outcome: finishOutcome.outcome } : {}) }
            }
          }

          // Release now — BEFORE deciding whether/how long to back off.
          if (session) {
            deps.sessions.release(job.deviceId, noopFrame)
            session = null
          }

          // A cancel is NEVER retried (plan 05 §4.7).
          if (outcome.error?.code === 'CANCELLED') break

          const classified = classify(outcome.error)
          const retrySettings = getResetSettings().retry

          if (classified.class === 'infra' || classified.class === 'load') {
            if (infraAttempts >= retrySettings.maxInfraAttempts) break
            infraAttempts += 1
            const delayMs = backoffDelayMs(infraAttempts, retrySettings)
            logger.append(
              'warn',
              'runner',
              `attempt ${attempt} failed (${classified.class}:${classified.code}) — retrying after ${delayMs}ms backoff`,
            )
            deps.onRetry?.(job.id, { attempt, class: classified.class, code: classified.code, delayMs })
            if (delayMs > 0) await Bun.sleep(delayMs)
          } else {
            // Plan 99 §3.5, §4.8: `job.retries` (a workflow's per-node
            // override) wins over the script's own declared `meta.retries`
            // when set; undefined defers to it exactly as before this field
            // existed.
            if (scriptAttempts >= (job.retries ?? meta.retries ?? 0)) break
            scriptAttempts += 1
            logger.append('warn', 'runner', `attempt ${attempt} failed (${classified.class}:${classified.code}) — retrying`)
            deps.onRetry?.(job.id, { attempt, class: classified.class, code: classified.code, delayMs: 0 })
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.append('error', 'runner', `runner failed: ${message}`)
        outcome = { ok: false, finishRan: false, error: { code: 'RUNNER_FAILED', message, phase: 'run' } }
      } finally {
        active.delete(job.id)
        if (session) deps.sessions.release(job.deviceId, noopFrame)
        const { bytes } = await logger.close()
        await artifacts
          .save({ kind: 'log', label: 'job', data: bytes, ext: 'log' })
          .then((saved) => deps.onArtifact(job.id, { kind: 'log', label: 'job', ...saved }))
          .catch(() => undefined)
      }

      return {
        ok: outcome.ok,
        ...(outcome.value !== undefined ? { value: outcome.value } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(jobPeakRssBytes !== null ? { peakRssBytes: jobPeakRssBytes } : {}),
        // Plan 97 §3.3, §4.3 — the LAST attempt's own verdict (retries do not
        // accumulate a result the way `jobPeakRssBytes` accumulates a peak;
        // only the attempt that actually settled the job has one that matters).
        ...(outcome.outcome !== undefined ? { outcome: outcome.outcome } : {}),
      }
    },
  }
}

/**
 * Plan 128 §3.2 — the bytes a call has ALREADY produced, in whichever shape
 * that call produces them: `device.screenshot` hands the child a base64 PNG
 * string (`device-executor.ts`), while `artifact.save` already holds raw
 * bytes. Anything else is not a frame and is ignored rather than guessed at.
 */
function toFrameBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string' && value.length > 0) {
    try {
      return Uint8Array.from(Buffer.from(value, 'base64'))
    } catch {
      return null
    }
  }
  return null
}

/**
 * Plan 128 §3.4 — the UI tree a call already returned, so the trace never
 * pays for a second dump. `dump`/`waitFor` return the node itself; `find`
 * returns a `FindOutcome`, whose node exists only when it actually matched
 * (a refusal carries no tree at all, and inventing one would be worse than
 * an empty `uiHash`).
 */
function toTraceUiTree(method: string, value: unknown): unknown {
  if (method === 'find') {
    const outcome = FindOutcomeSchema.safeParse(value)
    return outcome.success && outcome.data.ok ? outcome.data.node : null
  }
  return value && typeof value === 'object' ? value : null
}

/** Extracts `{code, message}` from anything a device call, adb client, or session layer can throw. */
function toCodeAndMessage(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  const code = err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string' ? (err as { code: string }).code : 'UNKNOWN'
  return { code, message }
}

async function pipeLines(stream: ReadableStream<Uint8Array> | undefined, onLine: (line: string) => void): Promise<void> {
  if (!stream) return
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trimEnd()
        buffer = buffer.slice(idx + 1)
        if (line.length > 0) onLine(line)
      }
    }
    if (buffer.trim().length > 0) onLine(buffer.trim())
  } catch {
    // the stream closes when the child dies — expected
  }
}
