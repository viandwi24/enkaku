import { describe, expect, test } from 'bun:test'
import type { InputSink, JobSettings } from '@enkaku/protocol'
import type { Subprocess } from 'bun'
import { createJobRunner, type ClassifiedFailure, type JobSpec } from './job-runner'
import { DEFAULT_TIMING } from '../device-executor'
import { createInputArbiter } from '../input-arbiter'
import type { IsolationProvider } from './isolation'
import type { JobLogEntry } from './job-logger'
import type { ChildToParent, ParentToChild } from './ipc'
import type { DeviceSession } from '../session'
import type { SessionManager } from '../manager'
import type { Logger } from '../logger'
import type { ResetOutcome, ResetPlan } from '../reset'
import type { TraceEventInput } from './trace'

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
 * child-entry.ts, scripted per test to match what the real child does
 * (self-import → `ready`, hold for `init`, then run).
 */

const DEVICE_ID = 'dev-1'
const JOB: JobSpec = { id: 'job-1', runId: 'run-1', deviceId: DEVICE_ID, bundlePath: '/does/not/matter.mjs', params: {} }

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
    attachViewer: async () => ({ session, quality: 'wall' }),
    detachViewer: () => {},
    build: async () => {},
    whenReady: async () => session,
    state: () => 'ready',
    get: () => session,
    getByQuality: () => session,
    closeDevice: async () => {},
    closeAll: async () => 0,
    encoders: () => [],
    forwards: () => [],
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
  defaultTimeoutMs: 3_600_000,
  startupTimeoutMs: 60_000,
  maxTimeoutMs: null,
  // Plan 98 §3.5 — landed concurrently with this step; a value here is
  // otherwise unexercised by these tests (plan 99 does not touch memory).
  memory: { defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 },
  trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
  // Plan 97 §3.4, §3.7, §4.9 — landed concurrently with plan 99's own tests here.
  maxResultBytes: 65_536,
  progressIntervalMs: 1_000,
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

/** `successBehavior`, but the `ready` message carries a `runtime` envelope (plan 98 §3.1, §4.7, §5 step 98.4). */
function successBehaviorWithRuntime(runtime: { maxRssBytes?: number; timeoutMs?: number }): ChildBehavior {
  return {
    ready: { t: 'ready', scriptId: 'test-script', version: '1.0.0', runtime },
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
        defaultTimeoutMs: 3_600_000,
        startupTimeoutMs: 60_000,
        maxTimeoutMs: null,
        memory: { defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 },
        trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
  // Plan 97 §3.4, §3.7, §4.9 — landed concurrently with plan 99's own tests here.
  maxResultBytes: 65_536,
  progressIntervalMs: 1_000,
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

describe('createJobRunner — job.reset "none" (plan 99 §3.3, §4.8)', () => {
  test('a job spec with reset: "none" skips the reset even though the farm policy is "home" — no exec call, no reset phase, no device event', async () => {
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: (_jobId, _attempt, phase) => phases.push(phase),
      heartbeat: () => {},
      // The FARM policy is 'home' — if `job.reset` were ignored, this attempt
      // would press HOME. It must not: the workflow node declared 'none'
      // because it needs the state the previous node left the device in
      // (§3.3, F14's precedent applied one level up).
      resetPolicy: () => HOME_SETTINGS,
      onReset: () => phases.push('onReset-should-not-fire'),
    })

    const result = await runner.execute({ ...JOB, reset: 'none' })
    expect(result.ok).toBe(true)
    expect(execCalls).toEqual([])
    expect(phases).not.toContain('reset')
    expect(phases).not.toContain('onReset-should-not-fire')
  })

  test('the SAME spec without `reset` set behaves exactly as before — the farm policy still runs', async () => {
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: (_jobId, _attempt, phase) => phases.push(phase),
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
      onReset: () => phases.push('onReset'),
    })

    // `JOB` (the shared fixture) carries no `reset` field at all.
    const result = await runner.execute(JOB)
    expect(result.ok).toBe(true)
    expect(execCalls).toContain('input keyevent KEYCODE_BACK')
    expect(phases).toContain('reset')
    expect(phases).toContain('onReset')
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
        defaultTimeoutMs: 3_600_000,
        startupTimeoutMs: 60_000,
        maxTimeoutMs: null,
        memory: { defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 },
        trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
  // Plan 97 §3.4, §3.7, §4.9 — landed concurrently with plan 99's own tests here.
  maxResultBytes: 65_536,
  progressIntervalMs: 1_000,
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
        defaultTimeoutMs: 3_600_000,
        startupTimeoutMs: 60_000,
        maxTimeoutMs: null,
        memory: { defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 },
        trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
  // Plan 97 §3.4, §3.7, §4.9 — landed concurrently with plan 99's own tests here.
  maxResultBytes: 65_536,
  progressIntervalMs: 1_000,
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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

/**
 * Plan 97 §3.5, §4.2, step 97.4 — "the finish-only re-attempt path carries
 * it too". The ORIGINAL (crashed) attempt's own value/outcome are always
 * empty here (it died before sending a `result` at all) — the finish-only
 * re-attempt (a fresh process, spec §11.2) is the ONLY place a salvage can
 * come from, and `execute()`'s final return must not lose it.
 */
describe('createJobRunner — a finish() salvage survives the finish-only re-attempt (plan 97 §3.5, §4.2, step 97.4)', () => {
  test("the finish-only attempt's value/outcome are merged onto execute()'s final return", async () => {
    const session = fakeSession(async () => '')
    const { isolation, sentPerSpawn } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: (_init, _emit, exit) => {
          // Crashes without ever sending `result` — forces the finish-only re-attempt.
          exit(1)
        },
      },
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: (init, emit) => {
          expect(init.mode).toBe('finish-only')
          emit({ t: 'phase', phase: 'finish' })
          emit({
            t: 'result',
            ok: false,
            error: init.priorError as never,
            finishRan: true,
            value: { videosBeforeFailure: 280 },
            outcome: { status: 'partial', bytes: 30 },
          })
        },
      },
    ])

    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })

    const outcome = await runner.execute(JOB)

    expect(sentPerSpawn).toHaveLength(2)
    expect(outcome.ok).toBe(false)
    expect(outcome.value).toEqual({ videosBeforeFailure: 280 })
    expect(outcome.outcome).toMatchObject({ status: 'partial', bytes: 30 })
  })

  test('a finish-only re-attempt with no salvage leaves execute()\'s return unchanged — no value key, no outcome key', async () => {
    const session = fakeSession(async () => '')
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: (_init, _emit, exit) => exit(1),
      },
      {
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: (init, emit) => {
          emit({ t: 'result', ok: false, error: init.priorError as never, finishRan: true })
        },
      },
    ])

    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(false)
    expect('value' in outcome).toBe(false)
    expect('outcome' in outcome).toBe(false)
  })
})

describe('createJobRunner — the contamination regression (plan 35 §5.5)', () => {
  test('a second job on the same device still gets its own reset, even after the first was aborted mid-run', async () => {
    const JOB1: JobSpec = { id: 'job-1', runId: 'run-1', deviceId: DEVICE_ID, bundlePath: '/does/not/matter.mjs', params: {} }
    const JOB2: JobSpec = { id: 'job-2', runId: 'run-2', deviceId: DEVICE_ID, bundlePath: '/does/not/matter.mjs', params: {} }

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
          runnerHandle?.abort(JOB1.runId, 'cancelled')
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
    expect(resetCalls.map((r) => r.jobId)).toEqual([JOB1.runId, JOB2.runId])
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
          runnerHandle?.abort(JOB.runId, 'crashed', 'com.example.app crashed: java.lang.NullPointerException')
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
          runnerHandle?.abort(JOB.runId, 'crashed')
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
    defaultTimeoutMs: 3_600_000,
    startupTimeoutMs: 60_000,
    maxTimeoutMs: null,
    memory: { defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 },
    trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
  // Plan 97 §3.4, §3.7, §4.9 — landed concurrently with plan 99's own tests here.
  maxResultBytes: 65_536,
  progressIntervalMs: 1_000,
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

/** Records acquire/release ordering so backoff-vs-session timing is observable (acceptance #4). */
function trackingSessions(session: DeviceSession, sequence: string[]): SessionManager {
  let n = 0
  return {
    acquire: async () => {
      sequence.push(`acquire:${++n}`)
      return session
    },
    release: () => sequence.push(`release:${n}`),
    attachViewer: async () => ({ session, quality: 'wall' }),
    detachViewer: () => {},
    build: async () => {},
    whenReady: async () => session,
    state: () => 'ready',
    get: () => session,
    getByQuality: () => session,
    closeDevice: async () => {},
    closeAll: async () => 0,
    encoders: () => [],
    forwards: () => [],
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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

describe('createJobRunner — job.retries overrides the script\'s own declared retries (plan 99 §3.5, §4.8)', () => {
  test('job.retries wins when the script declares fewer retries than the override', async () => {
    // The script's `ready` declares retries: 0 (no retries at all); the job
    // spec overrides it to 2. If the override were ignored, this would stop
    // after the first failure — only 1 spawn.
    const session = fakeSession(async () => '')
    const { isolation, sentPerSpawn } = fakeIsolation([
      attemptBehavior({ failCode: 'SCRIPT_ERROR' }, 0),
      attemptBehavior({ failCode: 'SCRIPT_ERROR' }, 0),
      attemptBehavior('success', 0),
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => settingsWithRetry({ maxInfraAttempts: 0 }),
      classify: fakeClassify,
    })

    const outcome = await runner.execute({ ...JOB, retries: 2 })
    expect(outcome.ok).toBe(true)
    expect(sentPerSpawn).toHaveLength(3)
  })

  test('with no job.retries override, the script\'s own declared retries still govern (unchanged behaviour)', async () => {
    const session = fakeSession(async () => '')
    const { isolation, sentPerSpawn } = fakeIsolation([
      attemptBehavior({ failCode: 'SCRIPT_ERROR' }, 0), // declares retries: 0 — must stop right here
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(session),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => settingsWithRetry({ maxInfraAttempts: 0 }),
      classify: fakeClassify,
    })

    const outcome = await runner.execute(JOB) // no `retries` field at all
    expect(outcome.ok).toBe(false)
    expect(sentPerSpawn).toHaveLength(1)
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
      onTargetPackages: (jobId, packages) => targetEvents.push({ jobId, packages }),
    })

    await runner.execute(JOB)
    expect(targetEvents.at(-1)).toEqual({ jobId: JOB.runId, packages: ['com.example.app'] })
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
      { jobId: JOB.runId, packages: [] }, // reported once `ready` arrives with no declared packages
      { jobId: JOB.runId, packages: ['com.example.launched'] }, // then updated on app.launch
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
  function fakeSessionWithInput(
    tapCalls: Array<{ x: number; y: number; holdMs?: [number, number] }>,
  ): DeviceSession {
    const input = {
      tap: async (p: { x: number; y: number }, opts?: { holdMs?: [number, number] }) => {
        tapCalls.push({ ...p, holdMs: opts?.holdMs })
      },
      swipe: async () => {},
      text: async () => {},
      key: async () => {},
    }
    // Plan 91 §3.1, §3.3, §4.1 — `device-executor.ts` now calls `deps.session.arbiter.for(source)`
    // rather than `deps.session.input` directly (fixes F6/H1). Wrapping the SAME `input` object
    // here keeps `tapCalls` recording exactly what it did before this plan, while proving the
    // arbiter is actually on the call path this describe block is testing (Timing → the driver).
    const arbiter = createInputArbiter(input as unknown as InputSink, {
      queueWaitMs: () => 5_000,
      maxQueueDepth: () => 32,
      log: silentLog(),
    })
    return {
      deviceId: DEVICE_ID,
      inspector: null,
      inspectorPollIntervalMs: 500,
      transport: { exec: async () => '', execOut: async () => new Uint8Array() },
      whenInspectorReady: async () => {},
      input,
      arbiter,
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
    const tapCallsJob1: Array<{ x: number; y: number; holdMs?: [number, number] }> = []
    const tapCallsJob2: Array<{ x: number; y: number; holdMs?: [number, number] }> = []
    const { isolation } = fakeIsolation([tapBehavior(), tapBehavior()])
    const makeRunner = (tapCalls: Array<{ x: number; y: number }>) =>
      createJobRunner({
        isolation,
        logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
        sessions: fakeSessions(fakeSessionWithInput(tapCalls)),
        artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
    // holdMs is [0, 0] here too — this test's own `current.tapJitterMs`, now that it reaches the driver.
    expect(tapCallsJob1).toEqual([{ x: 10, y: 20, holdMs: [0, 0] }])

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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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

  /**
   * The regression test for the original defect (plan 84's audit): `tapJitterMs`
   * was declared in `TimingSettingsSchema` and rendered in Studio's Settings
   * panel, but before this fix no production code read it at all — the real
   * tap hold was a hardcoded literal inside the scrcpy input drivers. This
   * drives a real `tap` through the full parent↔child IPC path, exactly like
   * the `coordJitterPx` test above, and inspects the actual `holdMs` handed
   * to `session.input.tap` — a regression back to "the getter exists but
   * nothing downstream reads it" fails loudly here, not just in a schema test.
   */
  test('a configured timing getter reaches the executor: tapJitterMs reaches session.input.tap as opts.holdMs', async () => {
    const tapCalls: Array<{ x: number; y: number; holdMs?: [number, number] }> = []
    const { isolation } = fakeIsolation([tapBehavior()])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSessionWithInput(tapCalls)),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
      timing: () => ({ ...DEFAULT_TIMING, tapJitterMs: [777, 888], betweenActionMs: [0, 0], coordJitterPx: 0 }),
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(tapCalls).toHaveLength(1)
    expect(tapCalls[0]?.holdMs).toEqual([777, 888])
  })
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
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

/**
 * Plan 98 §3.5, §4.7, §4.8, H1 — step 98.2, "measure before limiting": the
 * `rss` IPC message and the parent-side peak accumulator. Deliberately no
 * limit, no kill, no warning anywhere in these tests — that is step 98.3.
 */
describe('createJobRunner — peak RSS accumulation (plan 98 §4.7, §4.8, H1)', () => {
  test('init carries a fixed rssSampleMs (no limit exists yet to make it adaptive)', async () => {
    const { isolation, sentPerSpawn } = fakeIsolation([successBehavior()])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    await runner.execute(JOB)
    const init = sentPerSpawn[0]?.find((m) => m.t === 'init')
    expect(init && init.t === 'init' ? init.rssSampleMs : undefined).toBe(10_000)
  })

  test('the outcome reports the MAX of every rss sample the child sent, not the last one', async () => {
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'test-script', version: '1.0.0' },
        onInit: (_init, emit) => {
          emit({ t: 'rss', bytes: 50_000_000 })
          emit({ t: 'rss', bytes: 120_000_000 })
          emit({ t: 'rss', bytes: 90_000_000 }) // dips after the peak — the peak must still win
          emit({ t: 'result', ok: true, value: 'done', finishRan: true })
        },
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(outcome.peakRssBytes).toBe(120_000_000)
  })

  test('a job that never reports an rss sample gets no peakRssBytes at all (never a bare 0)', async () => {
    const { isolation } = fakeIsolation([successBehavior()])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(outcome.peakRssBytes).toBeUndefined()
  })

  test('an rss sample resets the silence timer (proof of life) but does NOT call deps.heartbeat', async () => {
    const heartbeatCalls: string[] = []
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'test-script', version: '1.0.0' },
        onInit: (_init, emit) => {
          emit({ t: 'rss', bytes: 10_000_000 })
          emit({ t: 'phase', phase: 'run' })
          emit({ t: 'result', ok: true, value: 'done', finishRan: true })
        },
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: (jobId) => heartbeatCalls.push(jobId),
      resetPolicy: () => HOME_SETTINGS,
    })
    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    // ready + phase + result = 3 heartbeat-triggering messages; the rss
    // sample must not add a 4th (plan 98 §4.7: a fast sample cadence must
    // not multiply heartbeat-renewal writes).
    expect(heartbeatCalls).toHaveLength(3)
  })

  test('a finish-only re-run\'s own rss samples count toward the job\'s overall peak', async () => {
    const { isolation } = fakeIsolation([
      {
        // Full attempt: reports a modest peak, then dies before `result` —
        // forces the finish-only retry (job-runner's own `!outcome.finishRan` branch).
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: (_init, emit, exit) => {
          emit({ t: 'rss', bytes: 40_000_000 })
          exit(1)
        },
      },
      {
        // Finish-only attempt: a FRESH process (spec §11.2) that happens to
        // peak HIGHER than the original attempt did.
        ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
        onInit: (init, emit) => {
          expect(init.mode).toBe('finish-only')
          emit({ t: 'rss', bytes: 200_000_000 })
          emit({ t: 'result', ok: false, error: { code: 'CHILD_CRASHED', message: 'x', phase: 'run' }, finishRan: true })
        },
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(false)
    expect(outcome.peakRssBytes).toBe(200_000_000)
  })
})

/**
 * Plan 98 §3.5, §3.6, §4.8 — step 98.3, "the memory limit": the three
 * `job.memory.enforce` modes, the immediate-SIGKILL kill path (no `abort`
 * message, no grace period — deliberately harsher than every other abort
 * reason), the 80%-of-limit warning, and the tightened silence watchdog.
 *
 * No real child process here (see the file header) — a fake `ChildBehavior`
 * emits `rss` samples on cue, exactly like the peak-accumulation tests above.
 * The REAL, real-child-process proof that `finish()` genuinely re-runs in a
 * fresh OS process (not just "this test's own mock believes it did") lives in
 * `packages/core/src/jobs/memory-limit.integration.test.ts`, which asserts a
 * side effect (a marker file, tagged with `process.pid`) written by a truly
 * separate `bun child-entry.ts` invocation. These tests are the fast,
 * deterministic proof of the ORCHESTRATION: what gets sent, what does not,
 * and how many times a warning fires.
 */
describe('createJobRunner — the memory limit (plan 98 §3.5, §3.6, §4.8)', () => {
  const LIMIT = 268_435_456 // 256 MiB — the same number the plan's own fixture uses.

  function memorySettings(enforce: 'kill' | 'warn' | 'off', sampleIntervalMs = 2_000): typeof HOME_SETTINGS {
    return { ...HOME_SETTINGS, memory: { defaultMaxRssBytes: LIMIT, maxRssBytes: null, enforce, sampleIntervalMs } }
  }

  test('enforce: "kill" — a breach is SIGKILLed immediately: no `abort` message, no grace period, and finish() re-runs in a fresh-process attempt', async () => {
    const { isolation, sentPerSpawn } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'memory-hog', version: '1.0.0' },
        onInit: (_init, emit) => {
          emit({ t: 'rss', bytes: 50_000_000 })
          emit({ t: 'rss', bytes: LIMIT + 1_000_000 }) // the breach sample
          // Deliberately never sends `result` — a REAL over-ceiling child
          // would not get the chance either; the parent's SIGKILL is what
          // ends this attempt, not anything the child reports.
        },
      },
      {
        // The finish-only re-run — a FRESH spawn (spec §11.2), proving
        // `finish()` was not simply skipped because the kill was immediate.
        ready: { t: 'ready', scriptId: 'memory-hog', version: '1.0.0' },
        onInit: (init, emit) => {
          expect(init.mode).toBe('finish-only')
          expect(init.priorError?.code).toBe('MEMORY_LIMIT')
          emit({ t: 'result', ok: false, error: init.priorError as never, finishRan: true })
        },
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => memorySettings('kill'),
    })

    const started = Date.now()
    const outcome = await runner.execute(JOB)
    const elapsed = Date.now() - started

    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('MEMORY_LIMIT')
    // §3.6 — the phase stays 'timeout' so an existing finish() that branches
    // on ctx.error.phase === 'timeout' keeps matching a memory kill too.
    expect(outcome.error?.phase).toBe('timeout')
    expect(outcome.peakRssBytes).toBeGreaterThan(LIMIT)
    // No grace period spent: FINISH_GRACE_MS (30s) + SIGKILL_DELAY_MS (5s)
    // never enter the picture for this reason — the whole attempt resolves
    // near-instantly.
    expect(elapsed).toBeLessThan(2_000)
    // The killed attempt's OWN spawn never received an `abort` IPC message.
    expect(sentPerSpawn[0]?.some((m) => m.t === 'abort')).toBe(false)
    // A SECOND spawn happened — the finish-only re-run.
    expect(sentPerSpawn.length).toBe(2)
    expect(sentPerSpawn[1]?.some((m) => m.t === 'init' && m.mode === 'finish-only')).toBe(true)
  })

  test('enforce: "kill" — exactly one 80%-of-limit warning precedes the kill, even across several samples already above 80%', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'memory-hog', version: '1.0.0' },
        onInit: (_init, emit) => {
          emit({ t: 'rss', bytes: Math.round(LIMIT * 0.5) })
          emit({ t: 'rss', bytes: Math.round(LIMIT * 0.85) }) // crosses 80% — the ONE warning
          emit({ t: 'rss', bytes: Math.round(LIMIT * 0.9) }) // still above 80% — must NOT warn again
          emit({ t: 'rss', bytes: Math.round(LIMIT * 0.95) }) // still above 80% — must NOT warn again
          emit({ t: 'rss', bytes: LIMIT + 1 }) // the breach — triggers the kill
        },
      },
      {
        ready: { t: 'ready', scriptId: 'memory-hog', version: '1.0.0' },
        onInit: (init, emit) => emit({ t: 'result', ok: false, error: init.priorError as never, finishRan: true }),
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => memorySettings('kill'),
    })
    await runner.execute(JOB)

    const warnings = logEntries.filter((e) => e.msg.includes('approaching limit'))
    expect(warnings).toHaveLength(1)
    const killLine = logEntries.findIndex((e) => e.msg.includes('abort attempt') && e.msg.includes('memory'))
    expect(killLine).toBeGreaterThan(logEntries.indexOf(warnings[0] as JobLogEntry))
  })

  test('enforce: "warn" — the job completes, the peak is still recorded, and the log carries exactly one warning', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'memory-hog', version: '1.0.0' },
        onInit: (_init, emit) => {
          emit({ t: 'rss', bytes: Math.round(LIMIT * 0.5) })
          emit({ t: 'rss', bytes: LIMIT + 1_000_000 }) // over the limit — 'warn' never kills
          emit({ t: 'rss', bytes: LIMIT + 2_000_000 }) // stays over — must NOT warn a second time
          emit({ t: 'result', ok: true, value: 'done', finishRan: true })
        },
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => memorySettings('warn'),
    })
    const outcome = await runner.execute(JOB)

    expect(outcome.ok).toBe(true)
    expect(outcome.value).toBe('done')
    expect(outcome.peakRssBytes).toBeGreaterThan(LIMIT)
    const warnLines = logEntries.filter((e) => e.level === 'warn')
    expect(warnLines).toHaveLength(1)
    expect(warnLines[0]?.msg).toContain('memory limit exceeded')
  })

  test('enforce: "off" — a breach produces no warning at all, and the peak is still recorded', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'memory-hog', version: '1.0.0' },
        onInit: (_init, emit) => {
          emit({ t: 'rss', bytes: LIMIT + 5_000_000 })
          emit({ t: 'result', ok: true, value: 'done', finishRan: true })
        },
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => memorySettings('off'),
    })
    const outcome = await runner.execute(JOB)

    expect(outcome.ok).toBe(true)
    expect(outcome.peakRssBytes).toBe(LIMIT + 5_000_000)
    expect(logEntries.filter((e) => e.level === 'warn')).toHaveLength(0)
  })

  test('the silence limit tightens to 3× sampleIntervalMs once a memory limit is configured (§3.6)', async () => {
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'memory-hog', version: '1.0.0' },
        onInit: () => {
          // Deliberately silent forever after `init` — simulating the shape
          // the tightened silence watchdog exists to catch faster (H2's
          // honest gap: a script that blocks its own event loop while
          // allocating cannot report an `rss` sample at all).
        },
        onAbort: (_reason, _emit, exit) => exit(1),
      },
      {
        ready: { t: 'ready', scriptId: 'memory-hog', version: '1.0.0' },
        onInit: (init, emit) => emit({ t: 'result', ok: false, error: init.priorError as never, finishRan: true }),
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => memorySettings('kill', 250),
    })

    const started = Date.now()
    const outcome = await runner.execute(JOB)
    const elapsed = Date.now() - started

    expect(outcome.ok).toBe(false)
    // 'hung' is not one of the abort reasons with its own code — it falls to
    // abortErrorCode's default, same as an ordinary run timeout.
    expect(outcome.error?.code).toBe('TIMEOUT')
    // Tightened to min(30_000, 3×250) = 750ms — nowhere near the untightened
    // 30s `SILENCE_LIMIT_MS` a job with no memory limit configured would wait.
    expect(elapsed).toBeLessThan(5_000)
  }, 10_000)
})

/**
 * Plan 98 §3.1, §4.4, §5 step 98.4 — "the envelope persists": `JobSpec.runtime`
 * is the DB row's own declaration, handed over by the host and fed into
 * `resolveRuntime`'s `script` argument (the line 98.3 left pointed at
 * `null`). The child's `ready.runtime` stops being authoritative and
 * becomes a CHECK against it — a disagreement produces exactly one `warn`
 * naming both values, and the row is what actually governs the attempt,
 * proven in BOTH directions: a bundle claiming a LOOSER ceiling than the row
 * cannot loosen it, and a bundle claiming a TIGHTER one cannot tighten it
 * either — the row is the agreed contract either way.
 */
describe('createJobRunner — the runtime envelope reconciliation (plan 98 §3.1, §5 step 98.4)', () => {
  const DB_MAX_RSS = 100_000_000
  const BUNDLE_CLAIMS_MORE = 900_000_000
  const DB_MAX_RSS_LOOSE = 500_000_000
  const BUNDLE_CLAIMS_LESS = 70_000_000

  function mismatchWarnings(entries: JobLogEntry[]): JobLogEntry[] {
    return entries.filter((e) => e.level === 'warn' && e.msg.includes('runtime envelope mismatch'))
  }

  test('a disagreement produces exactly one warning naming both values (a single attempt, no kill in the way)', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([successBehaviorWithRuntime({ maxRssBytes: BUNDLE_CLAIMS_MORE })])
    const job: JobSpec = { ...JOB, runtime: { maxRssBytes: DB_MAX_RSS } }
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      // `enforce: 'off'` — this test is about the WARNING, not the kill path
      // (that is the next two tests, each of which spends its own attempt
      // budget on a finish-only re-run and is asserted separately).
      resetPolicy: () => ({ ...HOME_SETTINGS, memory: { ...HOME_SETTINGS.memory, enforce: 'off' } }),
    })
    const outcome = await runner.execute(job)
    expect(outcome.ok).toBe(true)

    const warnings = mismatchWarnings(logEntries)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.msg).toContain(String(DB_MAX_RSS))
    expect(warnings[0]?.msg).toContain(String(BUNDLE_CLAIMS_MORE))
  })

  test('bundle asks for MORE than the row: the row still governs — the job is killed at the row\'s lower ceiling', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'memory-hog', version: '1.0.0', runtime: { maxRssBytes: BUNDLE_CLAIMS_MORE } },
        onInit: (_init, emit) => {
          // Between the row's real ceiling (100 MB) and the bundle's
          // FICTITIOUS, larger claim (900 MB) — a bundle that could raise
          // its own ceiling by lying at `ready` would survive this sample.
          emit({ t: 'rss', bytes: 150_000_000 })
        },
      },
      {
        // The finish-only re-run — a fresh spawn (spec §11.2). It never sends
        // a `runtime` in its own `ready` at all here, so this attempt's own
        // reconciliation check is skipped (`msg.runtime === undefined`
        // compares equal to "declared nothing", same as `job.runtime`
        // absent) — this test's OWN concern is the enforcement outcome, not
        // the warning count, which the dedicated test above already pins.
        ready: { t: 'ready', scriptId: 'memory-hog', version: '1.0.0' },
        onInit: (init, emit) => emit({ t: 'result', ok: false, error: init.priorError as never, finishRan: true }),
      },
    ])
    const job: JobSpec = { ...JOB, runtime: { maxRssBytes: DB_MAX_RSS } }
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    const outcome = await runner.execute(job)

    // The row's 100 MB ceiling killed it — the bundle's claimed 900 MB never
    // had a say.
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('MEMORY_LIMIT')
  })

  test('bundle asks for LESS than the row: the row still governs — the job survives past the bundle\'s lower claim', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'memory-hog', version: '1.0.0', runtime: { maxRssBytes: BUNDLE_CLAIMS_LESS } },
        onInit: (_init, emit) => {
          // Over the bundle's claimed 70 MB ceiling, but well under the
          // row's REAL 500 MB one — a bundle that could shrink its own
          // ceiling by claiming less at `ready` would still be running fine
          // here, which is exactly the point: the operator's row is the
          // agreed contract, not whatever the process on disk asserts about
          // itself right now.
          emit({ t: 'rss', bytes: 100_000_000 })
          emit({ t: 'result', ok: true, value: 'done', finishRan: true })
        },
      },
    ])
    const job: JobSpec = { ...JOB, runtime: { maxRssBytes: DB_MAX_RSS_LOOSE } }
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    const outcome = await runner.execute(job)

    // Never killed — the sample never reached the row's real 500 MB ceiling,
    // regardless of what the bundle itself claimed its own limit was.
    expect(outcome.ok).toBe(true)
    expect(outcome.value).toBe('done')

    const warnings = mismatchWarnings(logEntries)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.msg).toContain(String(DB_MAX_RSS_LOOSE))
    expect(warnings[0]?.msg).toContain(String(BUNDLE_CLAIMS_LESS))
  })

  test('no warning when the bundle and the row agree', async () => {
    const logEntries: JobLogEntry[] = []
    const agreed = { maxRssBytes: 200_000_000 }
    const { isolation } = fakeIsolation([successBehaviorWithRuntime(agreed)])
    const job: JobSpec = { ...JOB, runtime: agreed }
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    const outcome = await runner.execute(job)
    expect(outcome.ok).toBe(true)
    expect(mismatchWarnings(logEntries)).toHaveLength(0)
  })

  test('no comparison at all when the host never wired JobSpec.runtime (undefined, not null) — a caller that predates this field', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([successBehaviorWithRuntime({ maxRssBytes: 200_000_000 })])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    // `JOB` itself has no `runtime` field at all.
    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(mismatchWarnings(logEntries)).toHaveLength(0)
  })

  test('GET-style readback shape: a `null` row (a pre-plan-98 script) against a bundle reporting nothing either — no warning, farm defaults apply', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([successBehavior()])
    const job: JobSpec = { ...JOB, runtime: null }
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    const outcome = await runner.execute(job)
    expect(outcome.ok).toBe(true)
    expect(mismatchWarnings(logEntries)).toHaveLength(0)
  })
})

/**
 * Plan 98 §3.8, §4.4, §4.8, §5 step 98.7 — `JobSpec.runtimeOverride` is the
 * `override` argument `resolveRuntime` has taken since step 98.3 first
 * called it and has passed `null` for ever since (that step's own comment,
 * `execute()` above, named this exact field as the one line still to
 * change). These tests prove three things step 98.4's own reconciliation
 * tests already proved for `job.runtime` (the SCRIPT layer), now for
 * `job.runtimeOverride` (the OPERATOR layer): it genuinely reaches
 * `resolveRuntime`, it wins precedence over a script's own declaration, and
 * — the property this brief calls out explicitly — the farm ceiling STILL
 * wins over it, exactly like it wins over a script's own declaration.
 */
describe('createJobRunner — the per-job override (plan 98 §3.8, §4.4, §5 step 98.7)', () => {
  test('an override wins precedence over the script\'s own (looser) declaration — the FIRST attempt, no ready needed', async () => {
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'test-script', version: '1.0.0' },
        onInit: (_init, emit) => {
          // Between the override's real ceiling (100 MB) and the script's
          // own looser declaration (500 MB) — proves the OVERRIDE, not the
          // script, is what `resolveRuntime` actually resolved against, on
          // the very first attempt (no `ready` round trip needed to learn
          // it, unlike `meta.timeoutMs`'s own F5-shaped gap).
          emit({ t: 'rss', bytes: 150_000_000 })
        },
      },
      {
        ready: { t: 'ready', scriptId: 'test-script', version: '1.0.0' },
        onInit: (init, emit) => emit({ t: 'result', ok: false, error: init.priorError as never, finishRan: true }),
      },
    ])
    const job: JobSpec = { ...JOB, runtime: { maxRssBytes: 500_000_000 }, runtimeOverride: { maxRssBytes: 100_000_000 } }
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    const outcome = await runner.execute(job)
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('MEMORY_LIMIT')
  })

  test('the farm ceiling still wins over the override — clamped, logged, and the job is killed at the CEILING, not the override\'s own (higher) number', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'test-script', version: '1.0.0' },
        onInit: (_init, emit) => {
          // Over the farm's 200 MB ceiling, but well under the override's
          // own (fictitious, too-large) 900 MB ask — if the ceiling did not
          // win, this sample would run straight through.
          emit({ t: 'rss', bytes: 250_000_000 })
        },
      },
      {
        ready: { t: 'ready', scriptId: 'test-script', version: '1.0.0' },
        onInit: (init, emit) => emit({ t: 'result', ok: false, error: init.priorError as never, finishRan: true }),
      },
    ])
    const job: JobSpec = { ...JOB, runtimeOverride: { maxRssBytes: 900_000_000 } }
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({ ...HOME_SETTINGS, memory: { ...HOME_SETTINGS.memory, maxRssBytes: 200_000_000, enforce: 'kill' } }),
    })
    const outcome = await runner.execute(job)

    // Killed at the CEILING (200 MB), not the override's own 900 MB ask.
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('MEMORY_LIMIT')
    const clampLine = logEntries.find((e) => e.msg.includes('memory ceiling clamp'))
    expect(clampLine).toBeDefined()
    expect(clampLine?.msg).toContain('900000000')
    expect(clampLine?.msg).toContain('200000000')
    expect(clampLine?.msg).toContain('override')
  })

  test('an override under the ceiling (no clamp) logs exactly one "(origin: override)" line naming the resolved value', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([successBehavior()])
    const job: JobSpec = { ...JOB, runtimeOverride: { maxRssBytes: 123_000_000 } }
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    const outcome = await runner.execute(job)
    expect(outcome.ok).toBe(true)

    const originLines = logEntries.filter((e) => e.msg.includes('origin: override'))
    expect(originLines).toHaveLength(1)
    expect(originLines[0]?.msg).toContain('123000000')
    // No clamp — this attempt's own ceiling was under the (unset) farm one.
    expect(logEntries.some((e) => e.msg.includes('memory ceiling clamp'))).toBe(false)
  })

  test('no override at all (undefined) is silent — no origin line, unchanged from before this step', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([successBehavior()])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
    })
    // `JOB` itself carries no `runtimeOverride` field at all.
    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(logEntries.some((e) => e.msg.includes('origin: override'))).toBe(false)
    expect(logEntries.some((e) => e.msg.includes('memory ceiling clamp'))).toBe(false)
  })

  test('a SCRIPT declaration over the ceiling is clamped and logged too (extends the existing clamp precedent to maxRssBytes) — "from script", not "from override"', async () => {
    const logEntries: JobLogEntry[] = []
    const { isolation } = fakeIsolation([successBehavior()])
    const job: JobSpec = { ...JOB, runtime: { maxRssBytes: 900_000_000 } }
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: (e) => logEntries.push(e),
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({ ...HOME_SETTINGS, memory: { ...HOME_SETTINGS.memory, maxRssBytes: 200_000_000 } }),
    })
    const outcome = await runner.execute(job)
    expect(outcome.ok).toBe(true) // never breached — the script's peak stays under the clamped 200 MB ceiling

    const clampLine = logEntries.find((e) => e.msg.includes('memory ceiling clamp'))
    expect(clampLine).toBeDefined()
    expect(clampLine?.msg).toContain('900000000')
    expect(clampLine?.msg).toContain('200000000')
    expect(clampLine?.msg).toContain('from script')
  })
})

describe('createJobRunner — ctx.progress() forwarding (plan 97 §3.7, §4.3, §4.9, §5 step 97.7)', () => {
  test('a `progress` message from the child reaches `deps.onProgress(jobId, value)` VERBATIM, and does not trip the job heartbeat callback the way every other message does', async () => {
    const heartbeats: string[] = []
    const progressCalls: Array<{ jobId: string; value: unknown }> = []
    let finishChild: (() => void) | undefined
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'test-script', version: '1.0.0' },
        onInit: (_init, emit) => {
          emit({ t: 'progress', value: { videos: 3, watchSeconds: 90 } })
          finishChild = () => emit({ t: 'result', ok: true, value: 'done', finishRan: true })
        },
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: (jobId) => heartbeats.push(jobId),
      resetPolicy: () => HOME_SETTINGS,
      onProgress: (jobId, value) => progressCalls.push({ jobId, value }),
    })

    const resultPromise = runner.execute(JOB)
    await Bun.sleep(5)

    expect(progressCalls).toEqual([{ jobId: JOB.runId, value: { videos: 3, watchSeconds: 90 } }])

    finishChild?.()
    const result = await resultPromise
    expect(result.ok).toBe(true)
  })

  test('a caller that never wires `onProgress` is unaffected — a `progress` message is simply dropped, not an error', async () => {
    let finishChild: (() => void) | undefined
    const { isolation } = fakeIsolation([
      {
        ready: { t: 'ready', scriptId: 'test-script', version: '1.0.0' },
        onInit: (_init, emit) => {
          emit({ t: 'progress', value: 42 })
          finishChild = () => emit({ t: 'result', ok: true, value: 'done', finishRan: true })
        },
      },
    ])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => HOME_SETTINGS,
      // No `onProgress` — must not throw.
    })
    const resultPromise = runner.execute(JOB)
    await Bun.sleep(5)
    finishChild?.()
    const result = await resultPromise
    expect(result.ok).toBe(true)
  })

  test('a full attempt\'s `init` carries `job.progressIntervalMs`, resolved fresh from the settings getter — the same freshness convention `maxResultBytes` already uses', async () => {
    const { isolation, sentPerSpawn } = fakeIsolation([successBehavior()])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSession(async () => '')),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({ ...HOME_SETTINGS, progressIntervalMs: 2_500 }),
    })
    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    const init = sentPerSpawn[0]?.find((m) => m.t === 'init')
    expect(init && 'progressIntervalMs' in init ? init.progressIntervalMs : undefined).toBe(2_500)
  })
})

/**
 * The job trace tee (plan 128 §3.1, §3.2, §3.4, step 128.4). `trace.test.ts`
 * covers the tee's own logic in isolation; these tests drive a REAL child ⇄
 * parent IPC round trip through `createJobRunner` and assert the three things
 * only this level can prove:
 *
 * 1. the tee actually sits on the `device.call` boundary, in order, measured,
 * 2. a host that wired no `onTraceEvent` loses tracing and nothing else, and
 * 3. **acceptance criterion 4** — the `device.result` payloads the script
 *    sees are byte-identical with the tee and without it.
 */
describe('createJobRunner — the job trace tee (plan 128 §3.1, §3.4, step 128.4)', () => {
  function fakeSessionWithInspector(opts: { engineId?: string; screenshot?: () => Promise<Uint8Array> } = {}): DeviceSession {
    const input = { tap: async () => {}, swipe: async () => {}, text: async () => {}, key: async () => {} }
    const arbiter = createInputArbiter(input as unknown as InputSink, {
      queueWaitMs: () => 5_000,
      maxQueueDepth: () => 32,
      log: silentLog(),
    })
    return {
      deviceId: DEVICE_ID,
      inspector: {
        id: opts.engineId ?? 'ui-server',
        dump: async () => ({ cls: 'android.widget.FrameLayout', children: [] }),
        find: async () => null,
        screenshot: opts.screenshot ?? (async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      },
      inspectorEngineId: opts.engineId ?? 'ui-server',
      inspectorPollIntervalMs: 80,
      transport: { exec: async () => '', execOut: async () => new Uint8Array() },
      whenInspectorReady: async () => {},
      input,
      arbiter,
    } as unknown as DeviceSession
  }

  /** `tap` → `dump` → `result`, each waiting a turn for the parent's reply, as a real child would. */
  function twoCallBehavior(): ChildBehavior {
    return {
      ready: { t: 'ready', scriptId: 's', version: '1.0.0' },
      onInit: (_init, emit) => {
        emit({ t: 'phase', phase: 'run' })
        emit({ t: 'device.call', callId: 'c1', method: 'tap', args: { target: { point: { x: 10, y: 20 } } } } as never)
        setTimeout(() => emit({ t: 'device.call', callId: 'c2', method: 'dump', args: {} } as never), 30)
        setTimeout(() => emit({ t: 'result', ok: true, value: 'done', finishRan: true }), 120)
      },
    }
  }

  const NO_TIMING = { ...DEFAULT_TIMING, tapJitterMs: [0, 0] as [number, number], betweenActionMs: [0, 0] as [number, number], coordJitterPx: 0 }

  function traceStore(): { store: { putFrame: (jobId: string, bytes: Uint8Array) => Promise<string>; putUiTree: (jobId: string, tree: unknown) => Promise<string> }; frames: number; trees: number } {
    const counts = { frames: 0, trees: 0 }
    return {
      get frames() {
        return counts.frames
      },
      get trees() {
        return counts.trees
      },
      store: {
        putFrame: async () => {
          counts.frames += 1
          return 'frame-hash'
        },
        putUiTree: async () => {
          counts.trees += 1
          return 'tree-hash'
        },
      },
    }
  }

  test('a traced run emits the action events in order, each with a duration and a frame', async () => {
    const events: TraceEventInput[] = []
    const { isolation } = fakeIsolation([twoCallBehavior()])
    const store = traceStore()
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSessionWithInspector()),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({ ...HOME_SETTINGS, resetPolicy: 'none' }),
      timing: () => NO_TIMING,
      onTraceEvent: (runId, event) => {
        expect(runId).toBe(JOB.runId)
        events.push(event)
      },
      traceStore: store.store,
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    // The last capture can still be in flight the instant the job settles —
    // the tee is fire-and-forget by design (§3.1), so give it a turn.
    await Bun.sleep(20)

    const actions = events.filter((e) => e.kind === 'action')
    expect(actions.map((e) => e.name)).toEqual(['tap', 'dump'])
    for (const a of actions) {
      expect(a.ok).toBe(true)
      expect(a.durationMs).not.toBeNull()
      expect(a.durationMs ?? -1).toBeGreaterThanOrEqual(0)
      expect(a.attempt).toBe(1)
      expect(a.phase).toBe('run')
    }
    // ui-server ⇒ a frame per action (§3.4), and the `dump`'s tree comes free.
    expect(actions.every((a) => a.frameStatus === 'ok' || a.frameStatus === 'skipped-busy')).toBe(true)
    expect(store.trees).toBeGreaterThanOrEqual(1)

    // The other lanes are wired too: a phase boundary carrying the resolved
    // policy (§3.4), and the job log teed rather than replaced (§3.8).
    const phaseStart = events.find((e) => e.kind === 'phase' && e.name === 'start')
    expect(phaseStart?.meta).toEqual({ inspectorEngineId: 'ui-server', framePolicy: 'per-action' })
    expect(events.some((e) => e.kind === 'log')).toBe(true)
    // Numbering belongs to the recorder, never to the tee (uniqueIndex(jobId, seq)).
    for (const e of events) expect('seq' in e).toBe(false)
  })

  test('on uiautomator-dump the action lane is complete and the frame lane is off by policy', async () => {
    const events: TraceEventInput[] = []
    const { isolation } = fakeIsolation([twoCallBehavior()])
    const store = traceStore()
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(fakeSessionWithInspector({ engineId: 'uiautomator-dump' })),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({ ...HOME_SETTINGS, resetPolicy: 'none' }),
      timing: () => NO_TIMING,
      onTraceEvent: (_jobId, event) => events.push(event),
      traceStore: store.store,
    })

    expect((await runner.execute(JOB)).ok).toBe(true)
    await Bun.sleep(20)

    const actions = events.filter((e) => e.kind === 'action')
    expect(actions.map((e) => e.name)).toEqual(['tap', 'dump'])
    for (const a of actions) expect(a.frameStatus).toBe('skipped-policy')
    // Not one screenshot was taken off the running script's adb queue (§0.3).
    expect(store.frames).toBe(0)
    const phaseStart = events.find((e) => e.kind === 'phase' && e.name === 'start')
    expect(phaseStart?.meta).toEqual({ inspectorEngineId: 'uiautomator-dump', framePolicy: 'on-failure' })
  })

  test('a capture that rejects does not fail the job — it becomes a frameStatus and nothing more', async () => {
    const events: TraceEventInput[] = []
    const { isolation } = fakeIsolation([twoCallBehavior()])
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(
        fakeSessionWithInspector({
          screenshot: async () => {
            throw new Error('ui-server watchdog: dead')
          },
        }),
      ),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({ ...HOME_SETTINGS, resetPolicy: 'none' }),
      timing: () => NO_TIMING,
      onTraceEvent: (_jobId, event) => events.push(event),
      traceStore: {
        putFrame: async () => 'never-reached',
        putUiTree: async () => 'tree-hash',
      },
    })

    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(true)
    expect(outcome.value).toBe('done')
    await Bun.sleep(20)

    const actions = events.filter((e) => e.kind === 'action')
    expect(actions).toHaveLength(2)
    expect(actions.every((a) => a.frameStatus === 'failed')).toBe(true)
    expect(actions[0]?.meta?.captureError).toBe('ui-server watchdog: dead')
  })

  test('with onTraceEvent undefined the run behaves exactly as it did before this plan', async () => {
    const { isolation } = fakeIsolation([twoCallBehavior()])
    let screenshots = 0
    const runner = createJobRunner({
      isolation,
      logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
      sessions: fakeSessions(
        fakeSessionWithInspector({
          screenshot: async () => {
            screenshots += 1
            return new Uint8Array([1])
          },
        }),
      ),
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog(),
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
      resetPolicy: () => ({ ...HOME_SETTINGS, resetPolicy: 'none' }),
      timing: () => NO_TIMING,
      // `onTraceEvent` and `traceStore` deliberately omitted.
    })

    const outcome = await runner.execute(JOB)
    await Bun.sleep(20)
    expect(outcome.ok).toBe(true)
    expect(outcome.value).toBe('done')
    // Nothing was captured, because nothing was wired — the no-op tee costs
    // the device exactly zero calls.
    expect(screenshots).toBe(0)
  })

  /**
   * Plan 128 acceptance criterion 4: "the script-facing API is byte-identical".
   * Not a code review — an assertion. The SAME script does the SAME calls
   * against the SAME fake device twice, once traced and once not, and every
   * message the child receives is compared as text.
   */
  test('the device.result payloads the child receives are byte-identical with and without the tee', async () => {
    const run = async (traced: boolean): Promise<string[]> => {
      const { isolation, sentPerSpawn } = fakeIsolation([twoCallBehavior()])
      const runner = createJobRunner({
        isolation,
        logDir: `/tmp/enkaku-test-${crypto.randomUUID()}`,
        sessions: fakeSessions(fakeSessionWithInspector()),
        artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
        log: silentLog(),
        onLog: () => {},
        onArtifact: () => {},
        onPhase: () => {},
        heartbeat: () => {},
        resetPolicy: () => ({ ...HOME_SETTINGS, resetPolicy: 'none' }),
        timing: () => NO_TIMING,
        ...(traced
          ? {
              onTraceEvent: () => {},
              traceStore: { putFrame: async () => 'frame-hash', putUiTree: async () => 'tree-hash' },
            }
          : {}),
      })
      const outcome = await runner.execute(JOB)
      expect(outcome.ok).toBe(true)
      await Bun.sleep(20)
      return (sentPerSpawn[0] ?? []).filter((m) => m.t === 'device.result').map((m) => JSON.stringify(m))
    }

    const untraced = await run(false)
    const traced = await run(true)
    expect(untraced).toHaveLength(2)
    expect(traced).toEqual(untraced)
  })
})
