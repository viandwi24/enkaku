import type { DeviceCallMethod, JobTraceEvent, UiNode } from '@enkaku/protocol'
import type { DeviceCall } from './ipc'

/**
 * The job-trace tee (plan 128 §3.1, step 128.3) — the SAME tee
 * `packages/core/src/recording/session.ts` (plan 94) already runs for the
 * *manual* input path, moved one boundary over: from `ws-handlers.ts`'s
 * `input.*` branch to `job-runner.ts`'s `device.call` branch.
 *
 * **The tee must observe, never alter** (plan 94's property 1, inherited here
 * without amendment): `begin()` is synchronous and returns a token, `end()`
 * is synchronous and returns `void`, and NEITHER ever throws. Every genuinely
 * async consequence — a screenshot, a UI-tree snapshot, the host's own write
 * — is started inside `end()` and is never on the critical path the real
 * device call sits on.
 *
 * **This module does no I/O.** It owns three things and nothing else:
 *
 * 1. argument redaction (§4.4),
 * 2. capture-policy resolution from the inspector engine id (§3.4), and
 * 3. the single-in-flight capture gate (§3.4).
 *
 * Everything that touches a device, a disk, or a database arrives injected:
 * `emit(event)`, `capture(request)` and the `engineId()` accessor.
 *
 * **The tee does NOT assign `seq`, and does not assign `id`.** Both belong to
 * the host's recorder (`packages/core/src/jobs/trace/recorder.ts`, step
 * 128.5), which is the single `seq` authority and seeds its per-job counter
 * from the highest `seq` already stored. That split is load-bearing, not
 * tidiness: `job_events` carries `uniqueIndex(jobId, seq)` (§4.1), and a job
 * that infra-retries would otherwise have two independent counters both
 * starting at 1 for one job id, colliding on every event of the second
 * attempt. The tee's contract is ORDER (it calls `emit` in the order things
 * happened); NUMBERING is the recorder's.
 *
 * **An action event is emitted when its capture settles, not when the call
 * does** — but its `atMs` is stamped at `begin()`, so it lands on the time
 * axis at the instant the action really started, however long its screenshot
 * took to come back afterwards. Log lines are never held behind a capture;
 * they emit synchronously, which is exactly why an action whose frame took
 * 200 ms can reach the recorder after a log line that happened during it.
 * `atMs` is the axis; `seq` is the tiebreaker and the keyset cursor.
 */

/** Milliseconds — the tee's own clock, injectable for tests. */
type Now = () => number

/**
 * One event as the tee hands it over: everything `JobTraceEvent` has except
 * `id` and `seq`, which the host's recorder assigns (see this module's doc).
 * Written as an `Omit` of the protocol type on purpose — the two sides cannot
 * drift, and a field added to `JobTraceEventSchema` is a compile error here
 * until the tee decides what to put in it.
 *
 * Structurally assignable to `@enkaku/core`'s own `TraceRecordInput`, which
 * is the shape `recorder.record()` accepts.
 */
export type TraceEventInput = Omit<JobTraceEvent, 'id' | 'seq'>

/** How a capture may be satisfied. `'reuse'` means the call ALREADY produced it (§3.2, §3.4) — the host must not go back to the device for it. */
export type TraceCaptureMode = 'capture' | 'reuse' | 'none'

/**
 * What the tee asks the host to store for one event. The host resolves the
 * hashes (the frame store lives in `@enkaku/core`, plan 128 §3.5, step
 * 128.5); the tee never sees a byte of it beyond passing `frameValue` /
 * `treeValue` straight back out again.
 */
export interface TraceCaptureRequest {
  /** The `DeviceCall` method, or `'artifact'` for the `artifact.save` screenshot path (§3.2). */
  method: string
  /** Why this capture is happening — the per-action policy, or the failing-action rule (§3.4). */
  reason: 'action' | 'failure'
  frame: TraceCaptureMode
  uiTree: TraceCaptureMode
  /** Present only when `frame: 'reuse'` — the bytes the call itself produced (a base64 PNG from `screenshot`, raw bytes from an artifact). */
  frameValue?: unknown
  /** Present only when `uiTree: 'reuse'` — the value the call returned (a `UiNode` for `dump`/`waitFor`, a `FindOutcome` for `find`). */
  treeValue?: unknown
}

export interface TraceCaptureResult {
  frameHash?: string | null
  uiHash?: string | null
}

/** `ui-server` is the only engine that can afford a frame per action (§0.3, §3.4). */
export type FramePolicy = 'per-action' | 'on-failure' | 'none'

/** How one method's `args` reach `meta.args` (§4.4). */
export type ArgRedaction = 'plain' | 'length'

/**
 * The redaction decision for EVERY device method (§4.4, §8 R6). Typed as a
 * total `Record<DeviceCallMethod, …>` so adding a verb to `DEVICE_CALL_ARGS`
 * without deciding what happens to its arguments is a compile error here
 * before it is ever a leaked password on a timeline; `trace.test.ts`
 * enumerates the same table at runtime for the same reason.
 *
 * `'length'` replaces the arguments WHOLESALE with `{ length: n }` — not
 * "the same object with `text` blanked". A script types passwords, and the
 * only redaction that cannot be defeated by a future field being added
 * beside `text` is one that starts from nothing.
 */
export const ARG_REDACTION: Record<DeviceCallMethod, ArgRedaction> = {
  tap: 'plain',
  swipe: 'plain',
  scroll: 'plain',
  fling: 'plain',
  // A script types passwords (§4.4).
  type: 'length',
  key: 'plain',
  find: 'plain',
  dump: 'plain',
  waitFor: 'plain',
  screenshot: 'plain',
  'app.launch': 'plain',
  'app.forceStop': 'plain',
  'clipboard.get': 'plain',
  // The other half of the same rule — a clipboard write is how a script that
  // knows better than to `type` a secret pastes one instead.
  'clipboard.set': 'length',
  install: 'plain',
  push: 'plain',
  pull: 'plain',
  gesture: 'plain',
  longPress: 'plain',
  tapNorm: 'plain',
  swipeNorm: 'plain',
}

/** §4.4 — any single arg value whose JSON is larger than this is replaced by an explicit truncation marker. */
export const MAX_ARG_BYTES = 512

/**
 * The methods whose own return value already IS a UI tree (§3.4) — storing
 * it costs nothing, because the script has already paid for the round trip.
 */
const TREE_METHODS = new Set<string>(['dump', 'find', 'waitFor'])

/**
 * §3.2 — the script is already taking a picture; the trace records the event
 * and reuses the script's own bytes rather than taking a second one. This is
 * a recursion guard, not a cost saving, which is why it is not conditioned on
 * the frame policy: no device work happens either way.
 */
const SELF_FRAMING_METHODS = new Set<string>(['screenshot'])

export type TracePhase = NonNullable<JobTraceEvent['phase']>

export type TraceOutcome = { ok: true; value: unknown } | { ok: false; code: string; message: string }

/** Opaque to the caller: the clock reading, the phase, and the capture verdict fixed at `begin()`. */
export interface TraceToken {
  readonly method: string
  readonly startedAtMs: number
  readonly phase: TracePhase | null
  readonly attempt: number
  /**
   * The call's arguments, ALREADY redacted (§4.4) — redaction happens at
   * `begin()`, the one place a `DeviceCall` is ever seen, so a raw password
   * never lives on anything the tee holds past that instant.
   */
  readonly args: Record<string, unknown>
  /** True when a capture was already in flight the instant this action started (§3.4 — `skipped-busy`). */
  readonly busyAtBegin: boolean
  /** Guards a double `end()`; an action is recorded exactly once. */
  done: boolean
}

export interface TraceTee {
  /** Called with the parsed call the instant before it is executed. Returns the token to close with. */
  begin(call: DeviceCall): TraceToken
  /** Called when the call settles. NEVER throws, NEVER returns a promise the caller awaits. */
  end(token: TraceToken, outcome: TraceOutcome): void
  /**
   * A phase boundary. Closes the previous phase with an `end` event and opens
   * this one with a `start` event carrying `meta: { inspectorEngineId,
   * framePolicy }` — resolved AT THIS MOMENT, per phase and not per job,
   * because the `ui-server` watchdog can declare the engine dead mid-run and
   * the session falls back to `uiautomator-dump` (§3.4). The timeline shows
   * where the policy changed instead of averaging it into one wrong label.
   */
  phase(phase: TracePhase): void
  /** Closes whatever phase is open, if any — called once per attempt when it settles. */
  closePhase(): void
  /** One job-log line. Already secret-redacted by `job-logger.ts` before it reaches here (plan 79 §4.7). */
  log(entry: { ts: number; level: string; source: string; msg: string; fields?: Record<string, unknown> }): void
  /** One artifact. `frameBytes` is the artifact's own bytes for a screenshot (§3.2) — never a second capture. */
  artifact(a: { kind: string; label: string; sizeBytes: number; frameBytes?: unknown }): void
  progress(value: unknown): void
}

export interface TraceTeeDeps {
  /** The RUN this trace belongs to (renamed from `jobId`, plan 211). */
  runId: string
  /** The LIVE attempt number — an accessor, because one tee spans every attempt of a job (see this module's doc). */
  attempt: () => number
  /**
   * The session's effective inspector engine, read FRESH per event and never
   * captured: `session.inspectorEngineId` really can change mid-run after a
   * watchdog fallback (§3.4). `null` when the session has no inspector at all.
   */
  engineId: () => string | null
  /**
   * Where a finished event goes, WITHOUT `id`/`seq` — the recorder assigns
   * those (see this module's doc). Contractually non-blocking: the host's
   * recorder buffers (§3.6), and this is called on the runner's own turn.
   */
  emit: (event: TraceEventInput) => void
  /**
   * Resolves one capture to its stored hashes. Undefined when the host wired
   * no trace store at all, which forces the policy to `'none'` — the engine
   * id is still reported honestly on every phase event, so the timeline can
   * say "ui-server, frames off" rather than pretending there was no engine.
   */
  capture?: (req: TraceCaptureRequest) => Promise<TraceCaptureResult>
  now?: Now
}

/**
 * §3.4's table. Only `ui-server` is off the per-device adb queue
 * (`drivers/src/inspector/ui-server/index.ts` talks JSON-RPC over an `adb
 * forward` socket), so only `ui-server` can afford a frame beside every
 * action without stealing a slot from the running script.
 *
 * Every OTHER named engine falls to `'on-failure'` rather than to `'none'`:
 * an engine nobody has measured is assumed to contend (that is the safe
 * assumption for the script, and §0.3's whole point), but a job that has
 * already failed has nothing left to slow down, so its failing action still
 * gets its picture. `null` — no inspector at all — can capture nothing.
 */
export function resolveFramePolicy(engineId: string | null): FramePolicy {
  if (engineId === null) return 'none'
  if (engineId === 'ui-server') return 'per-action'
  return 'on-failure'
}

/**
 * Plan 208 §3.7, §4.9 — the failing-action trace capture's "cheap cache"
 * window. The script has usually just paid for a dump (`find`/`waitFor`/
 * `dump` are the actions that fail on an absent element); reusing it avoids
 * a second round trip on the channel the script's own calls share. Short on
 * purpose: a tree from thirty seconds ago is not the picture a debugger came
 * for.
 */
export const TRACE_TREE_REUSE_MS = 2_000

/**
 * `cached` is an engine's `lastDump()` (optional on `Inspector` — an engine
 * that does not track one, or has never dumped, answers `null`/`undefined`
 * here too). Returns the cached root when it is at most `TRACE_TREE_REUSE_MS`
 * old, `null` otherwise — the caller dumps fresh in that case.
 */
export function reusableTree(cached: { root: UiNode; at: number } | null | undefined, now: number): UiNode | null {
  if (!cached) return null
  return now - cached.at <= TRACE_TREE_REUSE_MS ? cached.root : null
}

/** §4.4 — one arg value, truncated to a marker when its JSON exceeds `MAX_ARG_BYTES`. */
function redactValue(value: unknown): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    return { truncated: true, bytes: 0 }
  }
  if (json === undefined) return value
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes <= MAX_ARG_BYTES) return value
  return { truncated: true, bytes }
}

/**
 * §4.4 — the arguments as they reach `meta.args`. `'length'` methods are
 * replaced wholesale; every other method keeps its arguments with each
 * oversized VALUE (never the whole object) swapped for a truncation marker,
 * so a `find` keeps the selector that makes it worth reading.
 */
export function redactArgs(method: string, args: unknown): Record<string, unknown> {
  const decision = ARG_REDACTION[method as DeviceCallMethod]
  if (decision === 'length') {
    const text = args && typeof args === 'object' && 'text' in args ? (args as { text: unknown }).text : undefined
    return { length: typeof text === 'string' ? text.length : 0 }
  }
  if (!args || typeof args !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    out[key] = redactValue(value)
  }
  return out
}

/**
 * A tee that does nothing at all, for a host that wired no `onTraceEvent`
 * (plan 128 §5, step 128.4: "a host that does not wire it loses tracing and
 * nothing else"). Every call site in `job-runner.ts` is therefore
 * unconditional — there is no `if (tracing)` anywhere on the hot path.
 */
export function createNoopTraceTee(): TraceTee {
  const token: TraceToken = { method: '', startedAtMs: 0, phase: null, attempt: 0, args: {}, busyAtBegin: false, done: true }
  return {
    begin: () => token,
    end: () => {},
    phase: () => {},
    closePhase: () => {},
    log: () => {},
    artifact: () => {},
    progress: () => {},
  }
}

/**
 * How many device-touching captures may be outstanding for one job at once
 * (plan 128 §3.4, revised on the owner's correction — see `capturesInFlight`).
 *
 * Four, not one and not unbounded. One meant most actions of a normal script
 * got no frame at all, because a script is quicker than a screenshot.
 * Unbounded would let captures pile up on the on-device ui-server RPC channel
 * that the script's own `find`/`click` share, putting the script behind its
 * own debugging — the exact interference this whole design exists to avoid.
 *
 * NOT measured on hardware (§9b item 1 — no device was ever attached). It is
 * a starting point chosen to be small enough that the channel keeps serving
 * the script promptly, and it is the first number to revisit once the smoke
 * test in §7 has actually been run.
 */
const MAX_CONCURRENT_CAPTURES = 4

export function createTraceTee(deps: TraceTeeDeps): TraceTee {
  const now = deps.now ?? (() => Date.now())
  /**
   * Outstanding device-touching captures for this job (§3.4).
   *
   * This used to be a single boolean slot, and the owner's own correction is
   * why it is not: *"satu action satu screenshot… screenshotnya di async, ada
   * kemungkinan screenshot baru selesai pas ui berubah yah gapapa itu udah
   * resiko."* One slot meant that on any script quicker than a screenshot —
   * which is most of them — the majority of actions got `skipped-busy` and no
   * frame at all. A late, slightly stale frame is what was asked for; no frame
   * is not.
   *
   * It is a bounded counter rather than "fire everything" for one specific
   * reason, and it is not host CPU: on the `ui-server` engine a screenshot
   * travels the SAME on-device RPC channel as the script's own `find` and
   * `click`, and uiautomator serves that channel one call at a time. Captures
   * allowed to pile up there would put the script's own calls behind them —
   * which is the one outcome the whole design exists to avoid. So: enough
   * concurrency that a normal script gets a frame per action, a ceiling so a
   * pathological one cannot bury the channel, and a drop (never a queue) when
   * that ceiling is reached — the owner's "fail-drop".
   */
  let capturesInFlight = 0
  let currentPhase: TracePhase | null = null
  let phaseStartedAtMs = 0

  const policy = (): FramePolicy => (deps.capture ? resolveFramePolicy(deps.engineId()) : 'none')

  /** The host's callback is never allowed to break the thing it is observing. */
  function safeEmit(event: TraceEventInput): void {
    try {
      deps.emit(event)
    } catch {
      // a trace consumer that throws must not take the job with it
    }
  }

  function build(part: {
    atMs: number
    attempt: number
    phase: TracePhase | null
    kind: JobTraceEvent['kind']
    name: string
    durationMs?: number | null
    ok?: boolean | null
    errorCode?: string | null
    meta?: Record<string, unknown> | null
    frameHash?: string | null
    frameStatus?: JobTraceEvent['frameStatus']
    uiHash?: string | null
  }): TraceEventInput {
    return {
      runId: deps.runId,
      atMs: part.atMs,
      attempt: part.attempt,
      phase: part.phase,
      kind: part.kind,
      name: part.name,
      durationMs: part.durationMs ?? null,
      ok: part.ok ?? null,
      errorCode: part.errorCode ?? null,
      meta: part.meta ?? null,
      frameHash: part.frameHash ?? null,
      frameStatus: part.frameStatus ?? null,
      uiHash: part.uiHash ?? null,
    }
  }

  /** Every instantaneous event (log, artifact, progress, phase) goes through here. */
  function emitInstant(kind: JobTraceEvent['kind'], name: string, opts: { atMs?: number; meta?: Record<string, unknown> | null; durationMs?: number | null } = {}): void {
    safeEmit(
      build({
        atMs: opts.atMs ?? now(),
        attempt: deps.attempt(),
        phase: currentPhase,
        kind,
        name,
        ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
        ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      }),
    )
  }

  /** Runs a capture and emits the event once it settles — the ONE async path in this module (§3.1). */
  function captureThenEmit(
    req: TraceCaptureRequest,
    event: Omit<Parameters<typeof build>[0], 'frameHash' | 'frameStatus' | 'uiHash'>,
    holdsSlot: boolean,
    /**
     * What `frameStatus` to report when this capture asked for no frame at
     * all. Defaults to `'skipped-policy'` — the policy genuinely wanted none.
     * The saturated-ceiling path passes `'skipped-busy'` instead: it is storing
     * the free tree while dropping the frame, and reporting that as a POLICY
     * decision would tell a debugger the engine was never going to take a
     * picture, when in truth it was busy taking four others.
     */
    frameNoneStatus: JobTraceEvent['frameStatus'] = 'skipped-policy',
  ): void {
    const capture = deps.capture
    if (!capture) {
      safeEmit(build({ ...event, frameStatus: 'skipped-policy' }))
      return
    }
    if (holdsSlot) capturesInFlight += 1
    let result: Promise<TraceCaptureResult>
    try {
      result = capture(req)
    } catch (err) {
      if (holdsSlot) capturesInFlight -= 1
      safeEmit(build({ ...event, frameStatus: 'failed', meta: { ...(event.meta ?? {}), captureError: messageOf(err) } }))
      return
    }
    void result
      .then((res) => {
        if (holdsSlot) capturesInFlight -= 1
        safeEmit(
          build({
            ...event,
            frameStatus: res.frameHash ? 'ok' : req.frame === 'none' ? frameNoneStatus : 'failed',
            ...(res.frameHash !== undefined ? { frameHash: res.frameHash } : {}),
            ...(res.uiHash !== undefined ? { uiHash: res.uiHash } : {}),
          }),
        )
      })
      .catch((err: unknown) => {
        if (holdsSlot) capturesInFlight -= 1
        // §3.4: "Neither can fail the job" — the capture promise is caught at
        // its origin and its only consequence is a `frameStatus` on a trace row.
        safeEmit(build({ ...event, frameStatus: 'failed', meta: { ...(event.meta ?? {}), captureError: messageOf(err) } }))
      })
      .finally(() => {
        if (holdsSlot) capturesInFlight -= 1
      })
  }

  return {
    begin(call) {
      return {
        method: call.method,
        startedAtMs: now(),
        phase: currentPhase,
        attempt: deps.attempt(),
        args: redactArgs(call.method, call.args),
        busyAtBegin: capturesInFlight >= MAX_CONCURRENT_CAPTURES,
        done: false,
      }
    },

    end(token, outcome) {
      // Nothing in here may throw: `end()` sits between a device call
      // settling and the child being told about it (§3.1, §8 R3).
      try {
        if (token.done) return
        token.done = true
        const settledAtMs = now()
        const base = {
          atMs: token.startedAtMs,
          attempt: token.attempt,
          phase: token.phase,
          kind: 'action' as const,
          name: token.method,
          durationMs: settledAtMs - token.startedAtMs,
          ok: outcome.ok,
          errorCode: outcome.ok ? null : outcome.code,
          meta: {
            args: token.args,
            ...(outcome.ok ? {} : { message: outcome.message }),
          } as Record<string, unknown>,
        }

        const resolved = policy()
        const failing = !outcome.ok
        // §3.2 — a `screenshot` never triggers a second picture, and never
        // needs the policy's permission for the one it already has: reusing
        // bytes the script already paid for costs the device nothing, which
        // is the only thing the policy exists to protect (§0.3).
        const reuseFrame = SELF_FRAMING_METHODS.has(token.method) && outcome.ok
        const wantsFrame = reuseFrame || resolved === 'per-action' || (resolved === 'on-failure' && failing)
        // §3.4 — free for `dump`/`find`/`waitFor`, because the call already
        // produced the tree.
        //
        // It used to require `per-action`, which meant it required
        // `ui-server`. Under `ui-tree` — the preferred engine since plan 221,
        // and the one every guest-agent farm runs — a successful `dump`
        // therefore stored NOTHING, and the Timeline read `ui nodes: not
        // captured` for a run with twenty of them and no failures at all
        // (owner, 2026-09-05). The policy exists to stop the trace taking
        // EXTRA work from the device (§0.3); a tree the action already
        // returned is not extra work, it is bytes in hand, and the comment
        // twenty lines below already says throwing it away "is the one thing
        // this design should never do". The gate above it disagreed.
        //
        // `none` still stores nothing: that is either no inspector or no
        // trace store, and there is nowhere to put it.
        const reusesTree = resolved !== 'none' && outcome.ok && TREE_METHODS.has(token.method)
        // §3.4 — the failing action gets a tree on EVERY engine, even one
        // that stores none for a successful action: the job has already
        // failed, and that tree is the picture a debugger came for.
        const capturesTree = resolved !== 'none' && failing

        if (!wantsFrame && !reusesTree && !capturesTree) {
          safeEmit(build({ ...base, frameStatus: 'skipped-policy' }))
          return
        }

        const needsDevice = (wantsFrame && !reuseFrame) || capturesTree
        const saturated = token.busyAtBegin || capturesInFlight >= MAX_CONCURRENT_CAPTURES

        if (needsDevice && saturated) {
          // Saturated — drop the FRAME, never the tree. `reusesTree` costs the
          // device nothing: the tree is the value `dump`/`find`/`waitFor` just
          // returned and it is already in hand (the owner's own point — *"pas
          // snapshot ui nodes itu kan udah sekalian ngambil data ui, nah itu
          // kan bisa sekalian datanya dari situ"*). Returning early here threw
          // that free tree away because a SCREENSHOT slot was busy, which is
          // the one thing this design should never do.
          if (reusesTree) {
            captureThenEmit(
              { method: token.method, reason: failing ? 'failure' : 'action', frame: 'none', uiTree: 'reuse', ...(outcome.ok ? { treeValue: outcome.value } : {}) },
              { ...base, meta: { ...(base.meta ?? {}), frameDropped: 'busy' } },
              false,
              'skipped-busy',
            )
            return
          }
          safeEmit(build({ ...base, frameStatus: 'skipped-busy' }))
          return
        }

        const req: TraceCaptureRequest = {
          method: token.method,
          reason: failing ? 'failure' : 'action',
          frame: wantsFrame ? (reuseFrame ? 'reuse' : 'capture') : 'none',
          uiTree: reusesTree ? 'reuse' : capturesTree ? 'capture' : 'none',
          ...(reuseFrame && outcome.ok ? { frameValue: outcome.value } : {}),
          ...(reusesTree && outcome.ok ? { treeValue: outcome.value } : {}),
        }
        captureThenEmit(req, base, needsDevice)
      } catch {
        // observe, never alter
      }
    },

    phase(phase) {
      try {
        const at = now()
        if (currentPhase !== null) {
          emitInstant('phase', 'end', { atMs: at, durationMs: at - phaseStartedAtMs, meta: { phase: currentPhase } })
        }
        currentPhase = phase
        phaseStartedAtMs = at
        const engine = deps.engineId()
        // §3.4 — the ONE place the Timeline tab's policy line gets its data.
        // Not derived from the events' `frameStatus`: a job that failed in
        // `prepare` has zero action events, and that is exactly the timeline
        // that most needs explaining.
        emitInstant('phase', 'start', { atMs: at, meta: { inspectorEngineId: engine, framePolicy: policy() } })
      } catch {
        // observe, never alter
      }
    },

    closePhase() {
      try {
        if (currentPhase === null) return
        const at = now()
        emitInstant('phase', 'end', { atMs: at, durationMs: at - phaseStartedAtMs, meta: { phase: currentPhase } })
        currentPhase = null
      } catch {
        // observe, never alter
      }
    },

    log(entry) {
      try {
        emitInstant('log', entry.level, {
          atMs: entry.ts,
          meta: { source: entry.source, msg: entry.msg, ...(entry.fields ? { fields: redactValue(entry.fields) } : {}) },
        })
      } catch {
        // observe, never alter
      }
    },

    artifact(a) {
      try {
        const base = {
          atMs: now(),
          attempt: deps.attempt(),
          phase: currentPhase,
          kind: 'artifact' as const,
          name: a.label,
          meta: { artifactKind: a.kind, sizeBytes: a.sizeBytes } as Record<string, unknown>,
        }
        // §3.2 — the `artifact.save` screenshot path reuses the artifact's own
        // bytes; it never triggers a second capture either.
        if (a.kind === 'screenshot' && a.frameBytes !== undefined && deps.capture) {
          captureThenEmit(
            { method: 'artifact', reason: 'action', frame: 'reuse', uiTree: 'none', frameValue: a.frameBytes },
            base,
            false,
          )
          return
        }
        safeEmit(build(base))
      } catch {
        // observe, never alter
      }
    },

    progress(value) {
      try {
        emitInstant('progress', 'progress', { meta: { value: redactValue(value) } })
      } catch {
        // observe, never alter
      }
    },

  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
