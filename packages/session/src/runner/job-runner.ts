import { join } from 'node:path'
import { UiautomatorDumpInspector } from '@enkaku/drivers'
import { defaultFarmSettings, FindOutcomeSchema, type JobSettings } from '@enkaku/protocol'
import type { Subprocess } from 'bun'
import { backoffDelayMs } from './backoff'
import { createDeviceExecutor, type TimingSettings } from '../device-executor'
import { SessionError } from '../errors'
import type { Logger } from '../logger'
import type { SessionManager } from '../manager'
import { resetDevice, type ResetOutcome, type ResetPlan } from '../reset'
import type { DeviceSession } from '../session'
import type { ArtifactSink, TransferPort } from '../types'
import { ChildToParentSchema, DeviceCallSchema, type ChildToParent, type ParentToChild } from './ipc'
import { createJobLogger, type JobLogEntry } from './job-logger'
import { resolveIsolation, type IsolationProvider } from './isolation'

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
  /** Extend the job lease (child heartbeat or device activity). */
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
 */
export type AbortReason = 'timeout' | 'cancelled' | 'hung' | 'crashed' | 'startup-timeout'

export interface RunningJob {
  /** `detail` is a human-readable cause, used only for `reason: 'crashed'` (plan 37 §4.4) — e.g. "com.example.app crashed: java.lang.NullPointerException". */
  abort(reason: AbortReason, detail?: string): void
}

export interface JobRunner {
  execute(job: JobSpec): Promise<{ ok: boolean; value?: unknown; error?: ScriptFailure }>
  abort(jobId: string, reason: AbortReason, detail?: string): boolean
}

const childEntryPath = join(import.meta.dir, 'child-entry.ts')
const defaultIsolation = resolveIsolation()

/** The `ScriptFailure.code` an abort reason settles as (plan 37 §4.4, plan 74 §4.2). */
function abortErrorCode(reason: AbortReason): string {
  if (reason === 'cancelled') return 'CANCELLED'
  if (reason === 'crashed') return 'APP_CRASHED'
  // A distinct code from 'TIMEOUT' (plan 74 §3.2, criterion 5) — a child
  // that never started is the farm's problem, not the script's, and this is
  // what lets `failure-class.ts` classify it as infrastructure unconditionally
  // rather than depending on the operator's `timeoutIsInfra` flag.
  if (reason === 'startup-timeout') return 'STARTUP_TIMEOUT'
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
    meta?: { timeoutMs?: number; retries?: number; scriptId?: string; version?: string }
  }): Promise<AttemptOutcome> {
    const { job, attempt, bundlePath, session, timeoutMs, mode, logger, artifacts } = opts

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
    const execDevice = createDeviceExecutor({
      session,
      onAppLaunch: (pkg) => {
        if (launchedPackages.has(pkg)) return
        launchedPackages.add(pkg)
        reportTargetPackages()
      },
      ...(deps.transfer ? { transfer: deps.transfer } : {}),
      // Read fresh per attempt, not captured at daemon start (plan 34 §3.3,
      // §4.2) — so a Timing settings change reaches the very next job.
      ...(deps.timing ? { timing: deps.timing() } : {}),
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

      const isolation = deps.isolation ?? defaultIsolation
      const child: Subprocess<'ignore', 'pipe', 'pipe'> = isolation.spawn(
        { entryPath: childEntryPath, bundlePath, jobId: job.id, env: { ENKAKU_JOB_ID: job.id } },
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
          logger.append('error', 'runner', `child diam > ${SILENCE_LIMIT_MS}ms — dianggap hang`)
          doAbort('hung')
        }, SILENCE_LIMIT_MS)
      }

      const doAbort = (reason: AbortReason, detail?: string) => {
        if (settled || abortReason) return
        abortReason = reason
        abortDetail = detail
        logger.append('warn', 'runner', `abort attempt ${attempt}: ${reason}${detail ? ` (${detail})` : ''}`)
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
      opts.aborter.current = doAbort

      const sendInit = () => {
        if (settled) return
        send({
          t: 'init',
          mode,
          job: { id: job.id, attempt, deviceId: job.deviceId },
          params: job.params ?? {},
          ...(opts.priorError ? { priorError: opts.priorError } : {}),
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
        deps.heartbeat(job.id)

        if (msg.t === 'ready') {
          logger.append('debug', 'runner', `child ready: ${msg.scriptId}@${msg.version}`)
          // The startup backstop's job is done the moment the child has
          // spoken at all (plan 74 §3.2) — a slow-but-alive child is not
          // what it exists to catch.
          if (startupTimer) {
            clearTimeout(startupTimer)
            startupTimer = null
          }
          if (opts.meta) {
            if (msg.timeoutMs !== undefined) opts.meta.timeoutMs = msg.timeoutMs
            if (msg.retries !== undefined) opts.meta.retries = msg.retries
            opts.meta.scriptId = msg.scriptId
            opts.meta.version = msg.version
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
          deps.onPhase(job.id, attempt, msg.phase)
          if (msg.phase === 'finish') finishRan = true
        } else if (msg.t === 'log') {
          logger.append(msg.level, 'script', msg.msg, msg.fields)
        } else if (msg.t === 'heartbeat') {
          // already handled by resetSilenceTimer and the lease heartbeat
        } else if (msg.t === 'device.call') {
          const call = DeviceCallSchema.safeParse(msg)
          if (!call.success) {
            send({ t: 'device.result', callId: msg.callId, ok: false, error: { code: 'BAD_CALL', message: 'invalid call' } })
            return
          }
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
              send({ t: 'device.result', callId: msg.callId, ok: false, error: { code, message } })
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
              deps.onArtifact(job.id, { kind: msg.kind, label: msg.label, ...saved })
              send({ t: 'artifact.result', callId: msg.callId, ok: true })
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
            })
            return
          }
          finish({
            ok: msg.ok,
            ...(msg.value !== undefined ? { value: msg.value } : {}),
            ...(msg.error ? { error: { code: msg.error.code, message: msg.error.message, phase: msg.error.phase } } : {}),
            finishRan: msg.finishRan || finishRan,
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
      const logger = createJobLogger({ dataDir: deps.logDir, jobId: job.id, onEntry: deps.onLog })
      const artifacts = deps.artifacts(job.id)
      const aborter: { current: ((reason: AbortReason, detail?: string) => void) | null } = { current: null }
      active.set(job.id, { abort: (reason, detail) => aborter.current?.(reason, detail) })

      let outcome: AttemptOutcome = { ok: false, finishRan: false, error: { code: 'NOT_RUN', message: 'not run yet', phase: 'run' } }
      let session: DeviceSession | null = null
      const noopFrame = () => {}
      const classify = deps.classify ?? ((err: unknown) => ({ class: 'script' as const, ...toCodeAndMessage(err), blameDevice: false }))

      // Two SEPARATE budgets (plan 36 §3.4): `scriptAttempts` is spent only on
      // the author's own `ScriptDefinition.retries`; `infraAttempts` is spent
      // only on the farm-level `job.retry.maxInfraAttempts`. Total attempts is
      // therefore bounded by `1 + retries + maxInfraAttempts` (acceptance #2)
      // without needing a separate combined check.
      let scriptAttempts = 0
      let infraAttempts = 0

      try {
        const bundlePath = job.bundlePath

        // timeout and retries are only known once the child has imported the
        // bundle; it sends them in the `ready` message, and they are used for
        // the next attempt.
        const meta: { timeoutMs?: number; retries?: number; scriptId?: string; version?: string } = {}
        let attempt = 0
        for (;;) {
          attempt += 1

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
              logger,
              artifacts,
              aborter,
              meta,
            })
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
            await runAttempt({
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
            }).catch(() => undefined)
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
            if (scriptAttempts >= (meta.retries ?? 0)) break
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
      }
    },
  }
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
