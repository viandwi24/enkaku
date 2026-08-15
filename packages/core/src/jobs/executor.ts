import type { ResultOutcome } from '@enkaku/protocol'
import type { JobRow, ScriptKind } from '../db/schema'
import type { Logger } from '../util/logger'

export interface ExecutorContext {
  /** Aborted on cancel or force-release. */
  signal: AbortSignal
  /** Extend the job lease (called by the host on every heartbeat). */
  heartbeat(): void
  log: Logger
  /**
   * Registers a callback for a crash-based abort (plan 37 §4.4) — kept
   * SEPARATE from `signal`, which is reserved for user-initiated
   * cancel/force-release (`ExecutorHost.abort`) and always means "abandon
   * the job", never "the target app crashed, fail on that specific basis".
   * Optional: only the script executor wires this today (the sleep and
   * remote-bridge executors have no crash-attributable subprocess to abort).
   */
  onCrash?: (cb: (e: { package: string; exception: string; message: string }) => void) => void
  /**
   * Reports this job's peak RSS (plan 98 §4.8, H1) — called at most once,
   * right before `run()` settles either way (success or a thrown error), by
   * whichever executor actually spawned a subprocess that measured itself.
   * Optional: only the script executor (`executors/script.ts`) wires this
   * today, the same as `onCrash` above — the sleep and remote-bridge
   * executors have no subprocess to measure.
   */
  onPeakRss?: (bytes: number) => void
  /**
   * Registers a callback for a co-control assist action (plan 91 §3.6, §4.8)
   * — the second unsolicited "the core tells a running job something
   * happened" mechanism, after `onCrash` above. NOT an abort: the job keeps
   * running exactly as before. Optional, the same reasoning `onCrash`/
   * `onPeakRss` already give: only the script executor wires this today (the
   * sleep and remote-bridge executors have no child process to notify).
   */
  onAssist?: (cb: (e: { at: number; actor: string | null }) => void) => void
  /**
   * Reports the child's own verdict on `run()`'s return value (plan 97 §3.3,
   * §3.4, §3.8, §4.5) — called at most once, right before `run()` resolves
   * with a value, by whichever executor actually got one from a script (only
   * `executors/script.ts` and the remote bridge wire this today, mirroring
   * `onPeakRss`'s own "only the executor with a subprocess/tunnel to ask"
   * shape exactly, deliberately NOT by widening `JobExecutor.run()`'s return
   * type itself: that type is shared by every executor — `sleep`, `install`,
   * `workflow`, every test's own hand-built mock — none of which produce a
   * `ResultOutcome` at all, and turning `run()`'s return from a bare value
   * into `{value, outcome?}` would be a breaking, all-of-them change for a
   * concept only the script path has. Optional: an executor with nothing to
   * report just never calls it, and the settle path then records
   * `resultStatus: undeclared`-or-nothing exactly as it does today.
   */
  onResultOutcome?: (outcome: ResultOutcome) => void
}

export interface JobExecutor {
  /**
   * Validate params before enqueueing (a per-executor schema). `scriptId` is
   * the CONCRETE id being enqueued (plan 95 §5 step 95.6) — a single-schema
   * executor (sleep, install) ignores it; the shared script executor
   * (`executors/script.ts`) is the SAME instance for every non-built-in
   * scriptId (`ExecutorRegistry`'s fallback), so it needs this to look up
   * which script's `paramsSchema` applies. Throws `EnkakuError` on an
   * invalid value — `validateScriptForRun` never catches it, so a bad
   * params object fails BEFORE a job row exists and BEFORE any device is
   * leased, whether the caller is a single job or a batch.
   */
  validateParams(params: unknown, scriptId: string): unknown
  /** Run to completion; resolve means success, reject means failure. */
  run(job: JobRow, ctx: ExecutorContext): Promise<unknown>
  /**
   * Declares what this executor needs beyond `job.run` (plan 93 §3.12, §4.6,
   * step 93.8) — checked by `jobs/validate-script.ts`'s `validateScriptForRun`,
   * the ONE function every dispatch path (a standalone job, a batch, a
   * schedule) already funnels through, before a job row exists. Undefined
   * means "no extra gate" — the shape every executor before this plan has,
   * including `internal:sleep` and every ordinary script.
   *
   * This is a DECLARATION, not a second authorisation system: `gate` names
   * which existing role check applies (`canUseFiles`/`canUseShell` from
   * `auth/acl.ts`, evaluated against the farm's live `shell.mode`, exactly
   * as the REST file-transfer routes already do — `api/transfer.ts`'s own
   * `authorize`), and `setting` names an existing farm switch that must be
   * on. Nothing here invents a new permission or a new gate function.
   */
  requires?: {
    /** Evaluated with the farm's `shell.mode`, exactly as the HTTP sibling does. */
    gate?: 'files' | 'shell'
    /** A farm switch that must be on. */
    setting?: 'transfer.enabled'
  }
}

/**
 * Registry executor: id built-in (mis. 'internal:sleep') di-map eksplisit;
 * scriptId lain (row tabel `scripts`) jatuh ke fallback = script executor
 * built on child processes (M4).
 *
 * Plan 99 §3.1, §4.5 — the fallback is now keyed by `ScriptKind`, not
 * singular: a workflow row (`kind: 'workflow'`) must fall through to a
 * DIFFERENT executor than a script row does, once one is registered for it
 * (99.7). `kind` defaults to `'script'` on both `get` and `setFallback`, so
 * every pre-plan-99 call site — `get(scriptId)` and `setFallback(executor)`,
 * both single-argument, both still called that way throughout the tree —
 * keeps exactly its old behaviour: `get(id, 'script')` returns exactly what
 * `get(id)` returned before this step. No caller needs to change here; the
 * concurrent `ExecutorHost` work is what will start passing a real `kind`
 * read from the row (99.7's job, not this one).
 */
export class ExecutorRegistry {
  private map = new Map<string, JobExecutor>()
  private fallbackByKind = new Map<ScriptKind, JobExecutor>()

  register(scriptId: string, executor: JobExecutor): void {
    this.map.set(scriptId, executor)
  }

  /** The executor for every scriptId of this KIND that is not built in. */
  setFallback(executor: JobExecutor, kind: ScriptKind = 'script'): void {
    this.fallbackByKind.set(kind, executor)
  }

  get(scriptId: string, kind: ScriptKind = 'script'): JobExecutor | null {
    return this.map.get(scriptId) ?? this.fallbackByKind.get(kind) ?? null
  }

  isBuiltIn(scriptId: string): boolean {
    return this.map.has(scriptId)
  }
}
