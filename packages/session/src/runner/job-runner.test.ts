import { describe, expect, test } from 'bun:test'
import type { JobSettings } from '@enkaku/protocol'
import type { Subprocess } from 'bun'
import { createJobRunner, type ClassifiedFailure, type JobSpec } from './job-runner'
import { DEFAULT_TIMING } from '../device-executor'
import type { IsolationProvider } from './isolation'
import type { ChildToParent, ParentToChild } from './ipc'
import type { DeviceSession } from '../session'
import type { SessionManager } from '../manager'
import type { Logger } from '../logger'
import type { ResetOutcome, ResetPlan } from '../reset'

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

/**
 * Job-runner tests (plan 35 §7): the pre-job reset ordered between the
 * child's `ready` and the parent's `init`, the `reset` phase, `resetStrict`,
 * and — the case the plan calls out explicitly (§4.3, §8 risks table) — a
 * finish-only attempt must skip the reset entirely.
 *
 * No real subprocess is spawned: a fake `IsolationProvider` stands in for
 * child-entry.ts, scripted per test to mirror what the real child does
 * (self-import → `ready`, hold for `init`, then run).
 */

const DEVICE_ID = 'dev-1'
const JOB: JobSpec = { id: 'job-1', deviceId: DEVICE_ID, bundlePath: '/does/not/matter.mjs', params: {} }

function fakeSession(execImpl: (cmd: string) => Promise<string>): DeviceSession {
  return {
    deviceId: DEVICE_ID,
    inspector: null,
    inspectorPollIntervalMs: 500,
    transport: { exec: execImpl, execOut: async () => new Uint8Array() },
    whenInspectorReady: async () => {},
  } as unknown as DeviceSession
}

function fakeSessions(session: DeviceSession): SessionManager {
  return {
    acquire: async () => session,
    release: () => {},
    get: () => session,
    closeDevice: async () => {},
    closeIfIdle: async () => {},
    idleSessions: () => [],
    closeAll: async () => {},
  }
}

interface ChildBehavior {
  /** Sent unprompted right after spawn — the child self-imports and reports `ready` (plan 35 §4.3). */
  ready: Extract<ChildToParent, { t: 'ready' }>
  /**
   * Called once the parent sends `init`. `emit` pushes a message back as if
   * the child sent it; `exit` simulates the OS process exiting on its own
   * (a crash) — independent of the parent ever calling `kill()`.
   */
  onInit?: (init: Extract<ParentToChild, { t: 'init' }>, emit: (m: ChildToParent) => void, exit: (code: number) => void) => void
  /** Called when the parent sends `{ t: 'abort' }` (a cancel or timeout mid-run). */
  onAbort?: (
    reason: 'timeout' | 'cancelled' | 'hung' | 'crashed' | 'startup-timeout',
    emit: (m: ChildToParent) => void,
    exit: (code: number) => void,
  ) => void
  /**
   * Plan 74 §3.2, §4.2 — the child that `startupTimeoutMs` exists to catch:
   * it never sends `ready` at all. `ready` above still has to be a valid
   * `ChildToParent` literal (the type requires it), it is simply never sent.
   */
  neverReady?: boolean
}

/** One scripted fake child per array entry — spawn N gets behavior[N]. */
function fakeIsolation(behaviors: ChildBehavior[]): { isolation: IsolationProvider; sentPerSpawn: ParentToChild[][] } {
  let spawnIndex = 0
  const sentPerSpawn: ParentToChild[][] = []
  const isolation: IsolationProvider = {
    mode: 'child-process',
    available: true,
    spawn(_req, ipc) {
      const behavior = behaviors[spawnIndex++]
      if (!behavior) throw new Error('fakeIsolation: no behavior configured for this spawn')
      const sent: ParentToChild[] = []
      sentPerSpawn.push(sent)
      let resolveExited: (code: number) => void = () => {}
      const exited = new Promise<number>((resolve) => {
        resolveExited = resolve
      })
      const child = {
        send: (msg: unknown) => {
          const m = msg as ParentToChild
          sent.push(m)
          if (m.t === 'init') queueMicrotask(() => behavior.onInit?.(m, ipc, resolveExited))
          if (m.t === 'abort') queueMicrotask(() => behavior.onAbort?.(m.reason, ipc, resolveExited))
        },
        kill: () => resolveExited(0),
        exited,
        stdout: undefined,
        stderr: undefined,
      }
      if (!behavior.neverReady) queueMicrotask(() => ipc(behavior.ready))
      return child as unknown as Subprocess<'ignore', 'pipe', 'pipe'>
    },
  }
  return { isolation, sentPerSpawn }
}

const DEFAULT_RETRY = { maxInfraAttempts: 2, backoffBaseMs: 2_000, backoffMaxMs: 30_000, timeoutIsInfra: false, rebindOnInfra: true }
const HOME_SETTINGS: JobSettings = {
  resetPolicy: 'home',
  resetTimeoutMs: 15_000,
  resetStrict: false,
  retry: DEFAULT_RETRY,
  crashPolicy: 'declared',
  quietPeriodSec: 10,
  maxWaitSec: 120,
  defaultTimeoutMs: 3_600_000,
  startupTimeoutMs: 60_000,
  maxTimeoutMs: null,
  trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
}

function successBehavior(reset?: { packages: string[]; clearData?: boolean }): ChildBehavior {
  return {
    ready: { t: 'ready', scriptId: 'test-script', version: '1.0.0', ...(reset ? { reset } : {}) },
    onInit: (_init, emit) => {
      emit({ t: 'phase', phase: 'run' })
      emit({ t: 'result', ok: true, value: 'done', finishRan: true })
    },
  }
}

describe('createJobRunner — the ready → reset → init ordering (plan 35 §4.3)', () => {
  test('the pre-job reset runs, and completes, before init is ever sent', async () => {
    const execCalls: string[] = []
    const timeline: string[] = []
    const session = fakeSession(async (cmd) => {
      execCalls.push(cmd)
      timeline.push(`exec:${cmd}`)
      return ''
    })
    const { isolation, sentPerSpawn } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0', reset: { packages: ['com.example.app'] } },
        onInit: (_init, emit) => {
          timeline.push('child:init-received')
          emit({ t: 'result', ok: true, value: null, finishRan: true })
        },
      },
    ])

    const resetCalls: Array<{ deviceId: string; outcome: ResetOutcome; plan: ResetPlan }> = []
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: (_jobId, _attempt, phase) => timeline.push(`phase:${phase}`),
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
      onReset: (_jobId, deviceId, outcome, plan) => {
        timeline.push('onReset')
        resetCalls.push({ deviceId, outcome, plan })
      },
    })

    const result = await runner.execute(JOB)

    expect(result.ok).toBe(true)
    // The reset ran (home commands), it was reported, and only THEN did the
    // child receive `init` — never before.
    expect(execCalls).toContain('input keyevent KEYCODE_BACK')
    expect(resetCalls).toHaveLength(1)
    expect(resetCalls[0]?.deviceId).toBe(DEVICE_ID)
    expect(resetCalls[0]?.plan).toEqual({ policy: 'home', packages: ['com.example.app'] })
    const resetIdx = timeline.indexOf('onReset')
    const initIdx = timeline.indexOf('child:init-received')
    expect(resetIdx).toBeGreaterThanOrEqual(0)
    expect(initIdx).toBeGreaterThan(resetIdx)
    // The exec calls (the reset itself) all happened before onReset fired.
    for (const c of execCalls) {
      expect(timeline.indexOf(`exec:${c}`)).toBeLessThan(resetIdx)
    }
    // `reset` is reported as its own phase, ahead of `run`/`finish`.
    expect(timeline.indexOf('phase:reset')).toBeGreaterThanOrEqual(0)
    expect(timeline.indexOf('phase:reset')).toBeLessThan(initIdx)
    expect(sentPerSpawn[0]?.some((m) => m.t === 'init')).toBe(true)
  })

  test('policy "none" sends init immediately, with no exec call and no reset phase (acceptance #4)', async () => {
    const execCalls: string[] = []
    const session = fakeSession(async (cmd) => {
      execCalls.push(cmd)
      return ''
    })
    const phases: string[] = []
    const { isolation } = fakeIsolation([successBehavior()])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: (_jobId, _attempt, phase) => phases.push(phase),
      heartbeat: () => {},
      resetPolicy: () => ({
        resetPolicy: 'none',
        resetTimeoutMs: 15_000,
        resetStrict: false,
        retry: DEFAULT_RETRY,
        crashPolicy: 'declared',
        quietPeriodSec: 10,
        maxWaitSec: 120,
        defaultTimeoutMs: 3_600_000,
        startupTimeoutMs: 60_000,
        maxTimeoutMs: null,
        trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
      }),
      onReset: () => phases.push('onReset-should-not-fire'),
    })

    const result = await runner.execute(JOB)
    expect(result.ok).toBe(true)
    expect(execCalls).toEqual([])
    expect(phases).not.toContain('reset')
    expect(phases).not.toContain('onReset-should-not-fire')
  })
})

describe('createJobRunner — resetStrict (plan 35 §4.1, acceptance #5)', () => {
  test('a failing reset step, under resetStrict, fails the job with a coded error and the script never runs', async () => {
    const session = fakeSession(async () => {
      throw new Error('device unreachable')
    })
    let initSent = false
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: () => {
          initSent = true
        },
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({
        resetPolicy: 'home',
        resetTimeoutMs: 15_000,
        resetStrict: true,
        retry: DEFAULT_RETRY,
        crashPolicy: 'declared',
        quietPeriodSec: 10,
        maxWaitSec: 120,
        defaultTimeoutMs: 3_600_000,
        startupTimeoutMs: 60_000,
        maxTimeoutMs: null,
        trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
      }),
    })

    const result = await runner.execute(JOB)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('RESET_FAILED')
    expect(initSent).toBe(false)
  })

  test('a failing reset step WITHOUT resetStrict only warns — the job still runs', async () => {
    const session = fakeSession(async (cmd) => {
      if (cmd === 'input keyevent KEYCODE_BACK') throw new Error('flaky adb')
      return ''
    })
    const { isolation } = fakeIsolation([successBehavior()])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({
        resetPolicy: 'home',
        resetTimeoutMs: 15_000,
        resetStrict: false,
        retry: DEFAULT_RETRY,
        crashPolicy: 'declared',
        quietPeriodSec: 10,
        maxWaitSec: 120,
        defaultTimeoutMs: 3_600_000,
        startupTimeoutMs: 60_000,
        maxTimeoutMs: null,
        trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
      }),
    })

    const result = await runner.execute(JOB)
    expect(result.ok).toBe(true)
  })
})

describe('createJobRunner — a finish-only attempt skips the reset entirely (plan 35 §4.3, §8 risks)', () => {
  test('the second (finish-only) attempt sends init immediately, with no additional reset', async () => {
    const execCalls: string[] = []
    const session = fakeSession(async (cmd) => {
      execCalls.push(cmd)
      return ''
    })
    // Spawn 1 (full): after init, the child dies without ever sending
    // `result` — the classic "crashed before finish ran" case that forces a
    // finish-only retry (job-runner.ts's own `!outcome.finishRan` branch).
    const { isolation, sentPerSpawn } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: (_init, _emit, exit) => {
          // No `result` is ever sent — the process just dies, exactly like a
          // real crash. `child.exited` settles this attempt via job-runner's
          // own `CHILD_CRASHED` / `finishRan: false` path.
          exit(1)
        },
      },
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: (init, emit) => {
          expect(init.mode).toBe('finish-only')
          emit({ t: 'phase', phase: 'finish' })
          emit({ t: 'result', ok: false, error: { code: 'CHILD_CRASHED', message: 'x', phase: 'run' }, finishRan: true })
        },
      },
    ])

    const resetCalls: Array<{ plan: ResetPlan }> = []
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
      onReset: (_jobId, _deviceId, _outcome, plan) => resetCalls.push({ plan }),
    })

    const outcome = await runner.execute(JOB)

    // Exactly one reset ran — for the full attempt. The finish-only retry
    // must not run a second one (it would wipe the state `finish` needs).
    expect(resetCalls).toHaveLength(1)
    expect(sentPerSpawn).toHaveLength(2)
    expect(sentPerSpawn[1]?.some((m) => m.t === 'init')).toBe(true)
    expect(outcome.ok).toBe(false)
  })
})

describe('createJobRunner — the contamination regression (plan 35 §5.5)', () => {
  test('a second job on the same device still gets its own reset, even after the first was aborted mid-run', async () => {
    const JOB1: JobSpec = { id: 'job-1', deviceId: DEVICE_ID, bundlePath: '/does/not/matter.mjs', params: {} }
    const JOB2: JobSpec = { id: 'job-2', deviceId: DEVICE_ID, bundlePath: '/does/not/matter.mjs', params: {} }

    const execCalls: string[] = []
    // Both jobs run on the SAME session — exactly the back-to-back-on-one-
    // device scenario the plan opens with (§3.1).
    const session = fakeSession(async (cmd) => {
      execCalls.push(cmd)
      return ''
    })

    // Holder for the runner, so job 1's fake child can call `runner.abort`
    // strictly AFTER `init` — a genuine mid-run abort, not a race with reset.
    let runnerHandle: ReturnType<typeof createJobRunner> | undefined

    const { isolation, sentPerSpawn } = fakeIsolation([
      // Spawn 1 — job 1's full attempt: once it is actually running, the
      // test cancels it. The child "dies" in response, without finishing.
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: () => {
          runnerHandle?.abort(JOB1.id, 'cancelled')
        },
        onAbort: (_reason, _emit, exit) => exit(137),
      },
      // Spawn 2 — job 1's forced finish-only retry (finishRan was false).
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: (init, emit) => {
          expect(init.mode).toBe('finish-only')
          emit({ t: 'phase', phase: 'finish' })
          emit({ t: 'result', ok: false, error: { code: 'CANCELLED', message: 'aborted', phase: 'timeout' }, finishRan: true })
        },
      },
      // Spawn 3 — job 2, a completely ordinary full attempt.
      successBehavior(),
    ])

    const resetCalls: Array<{ jobId: string }> = []
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
      onReset: (jobId) => resetCalls.push({ jobId }),
    })
    runnerHandle = runner

    const outcome1 = await runner.execute(JOB1)
    expect(outcome1.ok).toBe(false)
    expect(outcome1.error?.code).toBe('CANCELLED')

    const outcome2 = await runner.execute(JOB2)
    expect(outcome2.ok).toBe(true)

    // One reset for job 1 (its full attempt), none for its finish-only
    // retry, and — the point of this test — one MORE for job 2, proving the
    // second job does not inherit whatever state the aborted first job left.
    expect(resetCalls.map((r) => r.jobId)).toEqual([JOB1.id, JOB2.id])
    expect(sentPerSpawn).toHaveLength(3)
    // The "home" sequence's HOME intent runs once per reset — twice total
    // (once for job 1, once for job 2), never for the finish-only retry.
    expect(execCalls.filter((c) => c === 'am start -a android.intent.action.MAIN -c android.intent.category.HOME')).toHaveLength(2)
  })
})

describe('createJobRunner — the "crashed" abort reason (plan 37 §3.5, §4.4)', () => {
  test('runner.abort(id, "crashed", detail) settles APP_CRASHED with that detail as the message, and finish() still runs', async () => {
    let runnerHandle: ReturnType<typeof createJobRunner> | undefined
    const finishRan: string[] = []

    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: () => {
          runnerHandle?.abort(JOB.id, 'crashed', 'com.example.app crashed: java.lang.NullPointerException')
        },
        onAbort: (_reason, emit) => {
          // The child still runs finish() before reporting its result — the
          // same shape a real crash-during-run would produce (spec §11.3).
          emit({ t: 'phase', phase: 'finish' })
          emit({ t: 'result', ok: false, error: { code: 'TIMEOUT', message: 'ignored — the parent decides the reason', phase: 'timeout' }, finishRan: true })
        },
      },
    ])

    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: (_jobId, _attempt, phase) => finishRan.push(phase),
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    runnerHandle = runner

    const outcome = await runner.execute(JOB)

    // The PARENT's own reason wins over whatever the child happened to send
    // (mirrors the existing 'cancelled'/'timeout' behaviour, plan 37 §4.4).
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('APP_CRASHED')
    expect(outcome.error?.message).toBe('com.example.app crashed: java.lang.NullPointerException')
    expect(finishRan).toContain('finish')
  })

  test('with no detail, the message falls back to a generic abort description', async () => {
    let runnerHandle: ReturnType<typeof createJobRunner> | undefined
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: () => {
          runnerHandle?.abort(JOB.id, 'crashed')
        },
        onAbort: (_reason, emit) => {
          emit({ t: 'result', ok: false, error: { code: 'TIMEOUT', message: 'x', phase: 'timeout' }, finishRan: true })
        },
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    runnerHandle = runner

    const outcome = await runner.execute(JOB)
    expect(outcome.error?.code).toBe('APP_CRASHED')
    expect(outcome.error?.message).toBe('attempt di-abort (crashed)')
  })
})

/**
 * Plan 36 §7 — the retry classification and backoff tests. `resetPolicy`
 * is always 'none' below so the reset phase (already covered above) does not
 * add noise to attempt counting.
 */
function settingsWithRetry(retry: Partial<JobSettings['retry']>): JobSettings {
  return {
    resetPolicy: 'none',
    resetTimeoutMs: 15_000,
    resetStrict: false,
    retry: { ...DEFAULT_RETRY, ...retry },
    crashPolicy: 'declared',
    quietPeriodSec: 10,
    maxWaitSec: 120,
    defaultTimeoutMs: 3_600_000,
    startupTimeoutMs: 60_000,
    maxTimeoutMs: null,
    trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
  }
}

/** A minimal stand-in for `packages/core/src/jobs/failure-class.ts`'s table — just enough to drive the tests. */
function fakeClassify(err: unknown): ClassifiedFailure {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'UNKNOWN'
  // Mirrors the real table's plan 74 §3.2 addition: a child that never
  // started is unconditionally infra — never depends on `timeoutIsInfra`.
  if (code === 'E_ADB_TIMEOUT' || code === 'DEVICE_DISCONNECTED' || code === 'STARTUP_TIMEOUT') {
    return { class: 'infra', code, message: 'x', blameDevice: true }
  }
  if (code === 'E_ADB_BUSY') return { class: 'load', code, message: 'x', blameDevice: false }
  return { class: 'script', code, message: 'x', blameDevice: false }
}

function failResult(code: string): Extract<ChildToParent, { t: 'result' }> {
  return { t: 'result', ok: false, error: { code, message: `failed: ${code}`, phase: 'run' }, finishRan: true }
}

/** `retries` mirrors `ScriptDefinition.retries` — sent in every `ready` (as the real child does), so the script budget in job-runner.ts is non-zero. */
function attemptBehavior(result: 'success' | { failCode: string }, retries = 2): ChildBehavior {
  return {
    ready: { t: 'ready', scriptId: 's', version: '1.0.0', retries },
    onInit: (_init, emit) => {
      emit({ t: 'phase', phase: 'run' })
      emit(result === 'success' ? { t: 'result', ok: true, value: 'done', finishRan: true } : failResult(result.failCode))
    },
  }
}

/** Records acquire/release ordering so backoff-vs-lease timing is observable (acceptance #4). */
function trackingSessions(session: DeviceSession, sequence: string[]): SessionManager {
  let n = 0
  return {
    acquire: async () => {
      sequence.push(`acquire:${++n}`)
      return session
    },
    release: () => sequence.push(`release:${n}`),
    get: () => session,
    closeDevice: async () => {},
    closeIfIdle: async () => {},
    idleSessions: () => [],
    closeAll: async () => {},
  }
}

describe('createJobRunner — two separate retry budgets (plan 36 §3.4, acceptance #1, #2)', () => {
  test('infra retries do not spend the script budget: WAITFOR_TIMEOUT only consumes retries, not maxInfraAttempts', async () => {
    const session = fakeSession(async () => '')
    const { isolation } = fakeIsolation([
      attemptBehavior({ failCode: 'E_ADB_TIMEOUT' }), // infra, infraAttempts 0→1
      attemptBehavior({ failCode: 'E_ADB_TIMEOUT' }), // infra, infraAttempts 1→2 (budget now exhausted)
      attemptBehavior({ failCode: 'waitfor_timeout' }), // script, scriptAttempts 0→1 (retries budget still full)
      attemptBehavior('success'),
    ])
    const retryEvents: Array<{ attempt: number; class: string; code: string; delayMs: number }> = []
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => settingsWithRetry({ maxInfraAttempts: 2, backoffBaseMs: 1, backoffMaxMs: 2 }),
      classify: fakeClassify,
      onRetry: (_jobId, info) => retryEvents.push(info),
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(retryEvents.map((e) => e.class)).toEqual(['infra', 'infra', 'script'])
    // The script-class retry never carries a backoff delay (§3.2: "no backoff change").
    expect(retryEvents[2]?.delayMs).toBe(0)
  })

  test('total attempts never exceed retries + maxInfraAttempts + 1 (acceptance #2)', async () => {
    // retries=1, maxInfraAttempts=1 → cap is 3 attempts total. Exactly 3
    // behaviors are configured; a 4th spawn attempt would throw inside
    // fakeIsolation, which would surface as a test failure below.
    const session = fakeSession(async () => '')
    const { isolation, sentPerSpawn } = fakeIsolation([
      attemptBehavior({ failCode: 'E_ADB_TIMEOUT' }, 1), // infra, uses the only infra attempt
      attemptBehavior({ failCode: 'SCRIPT_ERROR' }, 1), // script, uses the only script retry
      attemptBehavior({ failCode: 'SCRIPT_ERROR' }, 1), // script again — budget now exhausted, must stop here
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => settingsWithRetry({ maxInfraAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 2 }),
      classify: fakeClassify,
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('SCRIPT_ERROR')
    expect(sentPerSpawn).toHaveLength(3)
  })

  test('an unrecognised code (no classify wired) behaves exactly like the pre-plan-36 default: it spends the script budget, no backoff', async () => {
    const session = fakeSession(async () => '')
    const { isolation, sentPerSpawn } = fakeIsolation([attemptBehavior({ failCode: 'TOTALLY_UNKNOWN' }), attemptBehavior('success')])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => settingsWithRetry({ maxInfraAttempts: 2 }),
      // No `classify` — exercises JobRunnerDeps's built-in default.
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(sentPerSpawn).toHaveLength(2)
  })
})

describe('createJobRunner — the device session is not held during a backoff delay (plan 36 §3.5, acceptance #4)', () => {
  test('release happens before the backoff wait, and the next attempt re-acquires only after it', async () => {
    const session = fakeSession(async () => '')
    const { isolation } = fakeIsolation([attemptBehavior({ failCode: 'E_ADB_TIMEOUT' }), attemptBehavior('success')])
    const sequence: string[] = []
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: trackingSessions(session, sequence),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => settingsWithRetry({ maxInfraAttempts: 2, backoffBaseMs: 5, backoffMaxMs: 5 }),
      classify: fakeClassify,
      onRetry: () => sequence.push('onRetry'),
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    // acquire(1) → fail → release(1) BEFORE the retry decision/backoff, THEN
    // only after the wait does the loop acquire again for attempt 2.
    expect(sequence).toEqual(['acquire:1', 'release:1', 'onRetry', 'acquire:2', 'release:2'])
  })
})

describe('createJobRunner — E_ADB_BUSY is load, not infra (plan 22.1/23 split, acceptance #5)', () => {
  test('a load-classified failure still retries with backoff, reported as class "load"', async () => {
    const session = fakeSession(async () => '')
    const { isolation } = fakeIsolation([attemptBehavior({ failCode: 'E_ADB_BUSY' }), attemptBehavior('success')])
    const retryEvents: Array<{ class: string; code: string }> = []
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => settingsWithRetry({ maxInfraAttempts: 2, backoffBaseMs: 1, backoffMaxMs: 2 }),
      classify: fakeClassify,
      onRetry: (_jobId, info) => retryEvents.push({ class: info.class, code: info.code }),
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(retryEvents).toEqual([{ class: 'load', code: 'E_ADB_BUSY' }])
  })
})

describe('createJobRunner — target-package tracking for the crash policy (plan 37 §3.4, §4.4)', () => {
  test('a declared reset.packages set is reported as soon as ready arrives', async () => {
    const targetEvents: Array<{ jobId: string; packages: string[] }> = []
    const { isolation } = fakeIsolation([successBehavior({ packages: ['com.example.app'] })])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
      onTargetPackages: (jobId, packages) => targetEvents.push({ jobId, packages }),
    })

    await runner.execute(JOB)
    expect(targetEvents.at(-1)).toEqual({ jobId: JOB.id, packages: ['com.example.app'] })
  })

  test('with no declared packages, a launched app becomes the fallback target', async () => {
    const targetEvents: Array<{ jobId: string; packages: string[] }> = []
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: (_init, emit) => {
          emit({
            t: 'device.call',
            callId: 'c1',
            method: 'app.launch',
            args: { pkg: 'com.example.launched' },
          } as never)
          // Gives the parent's async `execDevice(...).then(...)` (which is
          // what actually calls `onAppLaunch`) a turn to run before the
          // attempt settles — a real child would likewise wait for the
          // `device.result` reply before moving on.
          setTimeout(() => emit({ t: 'result', ok: true, value: null, finishRan: true }), 10)
        },
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
      onTargetPackages: (jobId, packages) => targetEvents.push({ jobId, packages }),
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(targetEvents).toEqual([
      { jobId: JOB.id, packages: [] }, // reported once `ready` arrives with no declared packages
      { jobId: JOB.id, packages: ['com.example.launched'] }, // then updated on app.launch
    ])
  })
})

/**
 * Timing settings reach the executor (plan 34 §3.3, §4.2): before this plan,
 * `job-runner.ts:93` built the executor with NO `timing` argument at all, so
 * `createDeviceExecutor` always fell back to `DEFAULT_TIMING` regardless of
 * what a `JobRunnerDeps.timing` getter — which did not exist — might have
 * said. These tests drive a real `tap` through the full parent↔child IPC
 * path (the same pattern §37 above uses for `app.launch`) and inspect the
 * ACTUAL point handed to `session.input.tap`, so a regression back to
 * "the getter exists but nothing reads it" would fail loudly here.
 */
describe('createJobRunner — Timing settings reach the executor (plan 34 §3.3, §4.2)', () => {
  function fakeSessionWithInput(tapCalls: Array<{ x: number; y: number }>): DeviceSession {
    return {
      deviceId: DEVICE_ID,
      inspector: null,
      inspectorPollIntervalMs: 500,
      transport: { exec: async () => '', execOut: async () => new Uint8Array() },
      whenInspectorReady: async () => {},
      input: {
        tap: async (p: { x: number; y: number }) => {
          tapCalls.push(p)
        },
        swipe: async () => {},
        text: async () => {},
        key: async () => {},
      },
    } as unknown as DeviceSession
  }

  /** One `device.call: tap` at a fixed point, then the final `result` once the parent has had a turn to run it. */
  function tapBehavior(): ChildBehavior {
    return {
      ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
      onInit: (_init, emit) => {
        emit({
          t: 'device.call',
          callId: 'c1',
          method: 'tap',
          args: { target: { point: { x: 10, y: 20 } } },
        } as never)
        // betweenActionMs is [0, 0] in every test below, so the pause
        // resolves virtually instantly — 50ms is generous headroom, not a
        // dependency on the jitter settings under test.
        setTimeout(() => emit({ t: 'result', ok: true, value: null, finishRan: true }), 50)
      },
    }
  }

  test('a configured timing getter reaches the executor: a large coordJitterPx measurably moves the tapped point', async () => {
    const tapCalls: Array<{ x: number; y: number }> = []
    const { isolation } = fakeIsolation([tapBehavior()])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSessionWithInput(tapCalls)),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
      // Huge on purpose: DEFAULT_TIMING's coordJitterPx is 2 — if the getter
      // were silently ignored (the pre-plan-34 bug), the tapped point would
      // land within a couple of pixels of (10, 20), never hundreds away.
      timing: () => ({ ...DEFAULT_TIMING, tapJitterMs: [0, 0], betweenActionMs: [0, 0], coordJitterPx: 1_000_000 }),
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(tapCalls).toHaveLength(1)
    const point = tapCalls[0]
    expect(point).toBeDefined()
    expect(Math.abs((point?.x ?? 10) - 10) + Math.abs((point?.y ?? 20) - 20)).toBeGreaterThan(1000)
  })

  test('changing timing between two jobs changes the second job\'s behaviour with no restart', async () => {
    let current = {
      ...DEFAULT_TIMING,
      tapJitterMs: [0, 0] as [number, number],
      betweenActionMs: [0, 0] as [number, number],
      coordJitterPx: 0, // job 1: no jitter — the exact target point
    }
    const tapCallsJob1: Array<{ x: number; y: number }> = []
    const tapCallsJob2: Array<{ x: number; y: number }> = []
    const { isolation } = fakeIsolation([tapBehavior(), tapBehavior()])
    const makeRunner = (tapCalls: Array<{ x: number; y: number }>) =>
      createJobRunner({
        isolation,
        logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
        sessions: fakeSessions(fakeSessionWithInput(tapCalls)),
        artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
        log: silentLog(),
        onLog: () => {},
        onArtifact: () => {},
        onPhase: () => {},
        heartbeat: () => {},
        resetPolicy: () => HOME_SETTINGS,
        // Read fresh every call — the SAME closure over `current`, exactly
        // like `daemon.ts` reading `settingsStore.get().defaults.timing`
        // fresh per attempt rather than once at startup.
        timing: () => current,
      })

    const outcome1 = await makeRunner(tapCallsJob1).execute({ ...JOB, id: 'job-a' })
    expect(outcome1.ok).toBe(true)
    expect(tapCallsJob1).toEqual([{ x: 10, y: 20 }])

    // The setting changes here — no restart, no new runner, no new process.
    current = { ...DEFAULT_TIMING, tapJitterMs: [0, 0], betweenActionMs: [0, 0], coordJitterPx: 1_000_000 }

    const outcome2 = await makeRunner(tapCallsJob2).execute({ ...JOB, id: 'job-b' })
    expect(outcome2.ok).toBe(true)
    const point2 = tapCallsJob2[0]
    expect(point2).toBeDefined()
    expect(Math.abs((point2?.x ?? 10) - 10) + Math.abs((point2?.y ?? 20) - 20)).toBeGreaterThan(1000)
  })

  test('with no timing getter configured, behaviour is unchanged from before plan 34 (DEFAULT_TIMING applies, no crash)', async () => {
    const tapCalls: Array<{ x: number; y: number }> = []
    // DEFAULT_TIMING's betweenActionMs is [300, 900] — the child's own
    // `result` message must not race ahead of that pause the way the other
    // tests' 50ms delay (paired with an explicit [0, 0] override) does.
    const behavior: ChildBehavior = {
      ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
      onInit: (_init, emit) => {
        emit({
          t: 'device.call',
          callId: 'c1',
          method: 'tap',
          args: { target: { point: { x: 10, y: 20 } } },
        } as never)
        setTimeout(() => emit({ t: 'result', ok: true, value: null, finishRan: true }), 1_000)
      },
    }
    const { isolation } = fakeIsolation([behavior])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSessionWithInput(tapCalls)),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
      // `timing` deliberately omitted.
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(tapCalls).toHaveLength(1)
    // DEFAULT_TIMING's coordJitterPx is 2 — nowhere near the 1_000_000 case above.
    const point = tapCalls[0]
    expect(point).toBeDefined()
    expect(Math.abs((point?.x ?? 10) - 10)).toBeLessThanOrEqual(2)
    expect(Math.abs((point?.y ?? 20) - 20)).toBeLessThanOrEqual(2)
  }, 10_000)
})

/**
 * Plan 74 §3.2, §4.2 — `startupTimeoutMs`, criteria 3, 4, 5: `DEFAULT_TIMEOUT_MS`
 * is gone, the farm default (`defaultTimeoutMs`) came from `settingsWithRetry`/
 * `HOME_SETTINGS` throughout this file already (every prior test above this
 * point depends on that, not a hard-coded constant), and a child that never
 * reports `ready` is bounded by the SHORT startup timer, classified infra.
 */
describe('createJobRunner — startupTimeoutMs (plan 74 §3.2, §4.2, criteria 3, 4, 5)', () => {
  test('a child that never sends ready fails after startupTimeoutMs — not the (much longer) run timeout', async () => {
    const { isolation } = fakeIsolation([
      { ready: { t: 'ready', scriptId: 's', version: '1.0.0' }, neverReady: true, onAbort: (_reason, _emit, exit) => exit(1) },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      // defaultTimeoutMs stays at HOME_SETTINGS' 3_600_000 — if the code
      // still raced the RUN timer instead of a dedicated startup timer, this
      // test would hang for an hour rather than settle in milliseconds.
      resetPolicy: () => ({ ...settingsWithRetry({ maxInfraAttempts: 0 }), startupTimeoutMs: 20 }),
      classify: fakeClassify,
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(false)
    // Distinct from a run 'TIMEOUT' (criterion 4) — this is what lets
    // failure-class.ts classify it unconditionally as infra (criterion 5),
    // never spending the script's own retry budget.
    expect(outcome.error?.code).toBe('STARTUP_TIMEOUT')
  })

  test('classified infra — an infra-only retry budget still recovers it, proving it never spent the script budget (criterion 5)', async () => {
    const { isolation } = fakeIsolation([
      { ready: { t: 'ready', scriptId: 's', version: '1.0.0' }, neverReady: true, onAbort: (_reason, _emit, exit) => exit(1) },
      // The runner ALWAYS forces a finish-only attempt first when an attempt
      // ends with `finishRan: false` (plan 05 §4.7, unrelated to this plan)
      // — this behavior is consumed by that, not by the real retry below.
      attemptBehavior('success', 0),
      // retries: 0 — if STARTUP_TIMEOUT were misclassified as 'script', this
      // real retry attempt would never be spent (the script budget is zero)
      // and the job would fail outright instead of recovering.
      attemptBehavior('success', 0),
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({ ...settingsWithRetry({ maxInfraAttempts: 1, backoffBaseMs: 1, backoffMaxMs: 2 }), startupTimeoutMs: 20 }),
      classify: fakeClassify,
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
  })

  test('ready arriving before the startup timer fires clears it — a slow-but-alive child is not touched by it', async () => {
    // successBehavior() reports `ready` immediately (the fake's normal
    // path) and then completes — if the startup timer were left armed after
    // `ready`, it would still be a no-op here since the job finishes long
    // before 20ms, but this test exists to document the clearing explicitly
    // rather than relying on that race.
    const { isolation } = fakeIsolation([successBehavior()])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({ ...HOME_SETTINGS, startupTimeoutMs: 20 }),
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
  })
})

/**
 * Plan 74 §3.3, §4.2 — `maxTimeoutMs`, criteria 6, 7: `null` (the default)
 * means no ceiling at all; when it IS set, a script's request above it is
 * clamped and the clamp is logged NAMING the script and both numbers.
 */
describe('createJobRunner — maxTimeoutMs (plan 74 §3.3, §4.2, criteria 6, 7)', () => {
  test('null (the default): a script requesting a timeout well above any sane ceiling is honoured, with no clamp log', async () => {
    const logLines: string[] = []
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0', timeoutMs: 150 },
        onInit: () => {
          // never resolves — the run timer (re-armed to the script's own
          // 150ms, unclamped) is what ends this attempt.
        },
        onAbort: (_reason, _emit, exit) => exit(1),
      },
    ])
    const started = Date.now()
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (entry) => logLines.push(entry.msg),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({ ...HOME_SETTINGS, maxTimeoutMs: null }),
    })

    const outcome = await runner.execute(JOB)
    const elapsed = Date.now() - started
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('TIMEOUT')
    // Honoured close to the requested 150ms, not clamped down to something
    // much smaller.
    expect(elapsed).toBeGreaterThanOrEqual(120)
    expect(logLines.some((l) => l.includes('timeout clamp'))).toBe(false)
  })

  test('set: a script requesting more than the ceiling is clamped to it, and the clamp is logged naming the script and both numbers', async () => {
    const logLines: string[] = []
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'checkout', version: '2.0.0', timeoutMs: 10_000 },
        onInit: () => {
          // never resolves — the CLAMPED timer (not the requested 10_000ms)
          // is what ends this attempt.
        },
        onAbort: (_reason, _emit, exit) => exit(1),
      },
    ])
    const started = Date.now()
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (entry) => logLines.push(entry.msg),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({ ...HOME_SETTINGS, maxTimeoutMs: 30 }),
    })

    const outcome = await runner.execute(JOB)
    const elapsed = Date.now() - started
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('TIMEOUT')
    // Clamped to ~30ms, nowhere near the requested 10_000ms.
    expect(elapsed).toBeLessThan(2_000)
    const clampLine = logLines.find((l) => l.includes('timeout clamp'))
    expect(clampLine).toBeDefined()
    expect(clampLine).toContain('checkout@2.0.0')
    expect(clampLine).toContain('10000')
    expect(clampLine).toContain('30')
  })
})
