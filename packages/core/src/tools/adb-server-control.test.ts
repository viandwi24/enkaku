import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { AdbClient, TrackedDevice } from '@enkaku/adb'
import type { AdbServerPhase } from '@enkaku/protocol'
import { createAdbServerControl, type AdbServerControlDeps, type DrainResult, type ReattachResult } from './adb-server-control'

/**
 * `cycle()` (plan 88 §3.10, §4.8) — the shared drain/kill/start/rollback
 * path behind both the Toolchain Manager's adb version swap and the
 * operator's Restart adb server button. Every edge here is a fake: the
 * plan's own rule (already followed by `registry/reconnect.test.ts` and
 * `device/adb-health.test.ts`) is to prove behaviour against a controllable
 * fake, never a real socket or a real spawned process.
 */

function fakeLogger() {
  const self = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => self }
  return self
}

interface FakeClientState {
  list: TrackedDevice[]
  paused: boolean
  resumed: boolean
  idleResult: boolean
  adbPath: string | null
  versionCalls: number
}

function fakeClient(state: FakeClientState): AdbClient {
  return {
    listDevices: async () => state.list,
    pauseQueue: () => {
      state.paused = true
    },
    resumeQueue: () => {
      state.resumed = true
    },
    waitQueueIdle: async () => state.idleResult,
    setAdbPath: (p: string) => {
      state.adbPath = p
    },
    version: async () => {
      state.versionCalls += 1
      return 'deadbeef'
    },
  } as unknown as AdbClient
}

interface Harness {
  deps: AdbServerControlDeps
  calls: string[]
  spawnCalls: Array<{ binaryPath: string; args: string[] }>
  phases: Array<{ phase: AdbServerPhase; reason: 'swap' | 'restart'; detail: string }>
  clientState: FakeClientState
}

function setUp(
  overrides: {
    client?: AdbClient | null
    spawnExit?: Map<string, number>
    idleResult?: boolean
    drainSessions?: AdbServerControlDeps['drainSessions']
    reattachEndpoints?: AdbServerControlDeps['reattachEndpoints']
    reconcileOnce?: AdbServerControlDeps['reconcileOnce']
  } = {},
): Harness {
  const calls: string[] = []
  const spawnCalls: Array<{ binaryPath: string; args: string[] }> = []
  const phases: Array<{ phase: AdbServerPhase; reason: 'swap' | 'restart'; detail: string }> = []
  const clientState: FakeClientState = {
    list: [{ serial: 'ZY1', state: 'device' }] as TrackedDevice[],
    paused: false,
    resumed: false,
    idleResult: overrides.idleResult ?? true,
    adbPath: null,
    versionCalls: 0,
  }
  const client = overrides.client === null ? null : (overrides.client ?? fakeClient(clientState))
  const spawnExit = overrides.spawnExit ?? new Map<string, number>()

  const deps: AdbServerControlDeps = {
    getClient: () => client,
    stopTracker: async () => {
      calls.push('stopTracker')
    },
    startTracker: async () => {
      calls.push('startTracker')
    },
    drainSessions:
      overrides.drainSessions ??
      (async () => {
        calls.push('drainSessions')
        return { sessionsClosed: 2, controlsEnded: 1, jobsFailed: [] } satisfies DrainResult
      }),
    reattachEndpoints:
      overrides.reattachEndpoints ??
      (async () => {
        calls.push('reattachEndpoints')
        return { attempted: 3, succeeded: 3, failed: [] } satisfies ReattachResult
      }),
    reconcileOnce:
      overrides.reconcileOnce ??
      (async () => {
        calls.push('reconcileOnce')
      }),
    onPhase: (phase, reason, detail) => phases.push({ phase, reason, detail }),
    log: fakeLogger(),
    drainTimeoutMs: () => 1_000,
    spawnAdb: async (binaryPath, args) => {
      spawnCalls.push({ binaryPath, args })
      calls.push(`spawn:${args[0]}:${binaryPath}`)
      const key = `${binaryPath}:${args.join(' ')}`
      return { exitCode: spawnExit.get(key) ?? 0 }
    },
  }

  return { deps, calls, spawnCalls, phases, clientState }
}

describe('createAdbServerControl — cycle() (plan 88 §3.10, §4.8)', () => {
  test('a restart: drain -> stop -> start -> resume -> reattach -> reconcile, in that order, with no commit', async () => {
    const h = setUp()
    const control = createAdbServerControl(h.deps)
    const report = await control.cycle({ reason: 'restart', oldBinaryPath: '/bin/adb', newBinaryPath: '/bin/adb' })

    expect(h.calls).toEqual([
      'drainSessions',
      'stopTracker',
      'spawn:kill-server:/bin/adb',
      'spawn:start-server:/bin/adb',
      'startTracker',
      'reattachEndpoints',
      'reconcileOnce',
    ])
    expect(report.reason).toBe('restart')
    expect(report.sessionsClosed).toBe(2)
    expect(report.controlsEnded).toBe(1)
    expect(report.reattachAttempted).toBe(3)
    expect(report.reattachSucceeded).toBe(3)
    expect(report.reattachFailed).toEqual([])
    expect(report.devicesBefore).toBe(1)
    expect(report.devicesAfter).toBe(1)
    expect(report.serverVersion).toBe('deadbeef')
    expect(h.clientState.paused).toBe(true)
    expect(h.clientState.resumed).toBe(true)
    expect(h.clientState.adbPath).toBe('/bin/adb')

    const phaseNames = h.phases.map((p) => p.phase)
    expect(phaseNames).toEqual(['draining', 'stopping', 'starting', 'reattaching', 'reconciling', 'done'])
    for (const p of h.phases) expect(p.reason).toBe('restart')
  })

  test('a swap: commit runs between stop and start, and the client is repointed at the new binary', async () => {
    const h = setUp()
    const commitCalls: string[] = []
    const control = createAdbServerControl(h.deps)
    await control.cycle({
      reason: 'swap',
      oldBinaryPath: '/bin/adb-old',
      newBinaryPath: '/bin/adb-new',
      commit: async () => {
        commitCalls.push('committed')
      },
    })

    expect(h.calls).toEqual([
      'drainSessions',
      'stopTracker',
      'spawn:kill-server:/bin/adb-old',
      'spawn:start-server:/bin/adb-new',
      'startTracker',
      'reattachEndpoints',
      'reconcileOnce',
    ])
    expect(commitCalls).toEqual(['committed'])
    expect(h.clientState.adbPath).toBe('/bin/adb-new')
    const phaseNames = h.phases.map((p) => p.phase)
    expect(phaseNames).toEqual(['draining', 'stopping', 'swapping', 'starting', 'reattaching', 'reconciling', 'done'])
  })

  test('a drain that never settles refuses with E_TOOL_IN_USE, resumes the queue, and never touches the server binary', async () => {
    const h = setUp({ idleResult: false })
    const control = createAdbServerControl(h.deps)

    await expect(control.cycle({ reason: 'restart', oldBinaryPath: '/bin/adb', newBinaryPath: '/bin/adb' })).rejects.toMatchObject({
      code: 'E_TOOL_IN_USE',
    })
    expect(h.clientState.resumed).toBe(true)
    expect(h.spawnCalls).toEqual([])
    expect(h.calls).not.toContain('drainSessions')
    expect(h.calls).not.toContain('stopTracker')
    expect(h.phases.map((p) => p.phase)).toEqual(['draining', 'failed'])
  })

  test('a failed start-server on the new binary brings the OLD binary back up and still rethrows (F18 rollback, preserved)', async () => {
    const spawnExit = new Map<string, number>([['/bin/adb-new:start-server', 1]])
    const h = setUp({ spawnExit })
    const control = createAdbServerControl(h.deps)

    await expect(
      control.cycle({ reason: 'swap', oldBinaryPath: '/bin/adb-old', newBinaryPath: '/bin/adb-new', commit: async () => {} }),
    ).rejects.toMatchObject({ code: 'E_HEALTH_CHECK_FAILED' })

    // The rollback: bring the OLD binary's start-server back up.
    expect(h.spawnCalls).toEqual([
      { binaryPath: '/bin/adb-old', args: ['kill-server'] },
      { binaryPath: '/bin/adb-new', args: ['start-server'] },
      { binaryPath: '/bin/adb-old', args: ['start-server'] },
    ])
    // The system still comes back up: the tracker restarts and the queue resumes despite the failure.
    expect(h.calls).toContain('startTracker')
    expect(h.clientState.resumed).toBe(true)
    // A failed cycle never reattaches or reconciles — there is nothing to reattach TO.
    expect(h.calls).not.toContain('reattachEndpoints')
    expect(h.calls).not.toContain('reconcileOnce')
  })

  test('force is threaded to drainSessions, never inspected by cycle() itself', async () => {
    const seen: boolean[] = []
    const h = setUp({
      drainSessions: async (opts) => {
        seen.push(opts.force)
        return { sessionsClosed: 0, controlsEnded: 0, jobsFailed: opts.force ? ['job-1'] : [] }
      },
    })
    const control = createAdbServerControl(h.deps)
    const report = await control.cycle({ reason: 'restart', oldBinaryPath: '/bin/adb', newBinaryPath: '/bin/adb', force: true })
    expect(seen).toEqual([true])
    expect(report.jobsFailed).toEqual(['job-1'])
  })

  test('busy() is true only while a cycle is in flight, and a second cycle refuses to interleave', async () => {
    // The deferred is constructed BEFORE `cycle()` ever runs, so `releaseDrain`
    // is valid from the start regardless of how many microtask hops
    // `cycleImpl` needs to actually reach the `drainSessions()` call —
    // resolving a not-yet-awaited promise is safe, it just resolves once
    // something starts awaiting it.
    const drain: { release: (() => void) | null } = { release: null }
    const drainPromise = new Promise<{ sessionsClosed: number; controlsEnded: number; jobsFailed: string[] }>((resolve) => {
      drain.release = () => resolve({ sessionsClosed: 0, controlsEnded: 0, jobsFailed: [] })
    })
    const h = setUp({ drainSessions: () => drainPromise })
    const control = createAdbServerControl(h.deps)
    expect(control.busy()).toBe(false)

    const first = control.cycle({ reason: 'restart', oldBinaryPath: '/bin/adb', newBinaryPath: '/bin/adb' })
    expect(control.busy()).toBe(true)

    await expect(control.cycle({ reason: 'restart', oldBinaryPath: '/bin/adb', newBinaryPath: '/bin/adb' })).rejects.toMatchObject({
      code: 'E_TOOL_IN_USE',
    })

    drain.release?.()
    await first
    expect(control.busy()).toBe(false)
  })

  test('no live client: the drain and tracker steps are skipped, but the binary is still cycled (a version swap must work even before the client object exists)', async () => {
    const h = setUp({ client: null })
    const control = createAdbServerControl(h.deps)
    const report = await control.cycle({ reason: 'swap', oldBinaryPath: '/bin/adb-old', newBinaryPath: '/bin/adb-new', commit: async () => {} })

    expect(h.calls).not.toContain('drainSessions')
    expect(h.calls).not.toContain('stopTracker')
    expect(h.calls).not.toContain('startTracker')
    expect(h.calls).not.toContain('reattachEndpoints')
    expect(h.calls).not.toContain('reconcileOnce')
    expect(h.spawnCalls).toEqual([
      { binaryPath: '/bin/adb-old', args: ['kill-server'] },
      { binaryPath: '/bin/adb-new', args: ['start-server'] },
    ])
    expect(report.devicesBefore).toBe(0)
    expect(report.devicesAfter).toBe(0)
    expect(report.serverVersion).toBeNull()
  })
})

/**
 * The workspace-wide guard plan 01 §398/§494 specified and never built (F20;
 * plan 88 §3.10, §5 step 88.9). The doctor package has had its OWN narrower
 * guard since plan 41 (`doctor/render.test.ts`) — reading a fixed, hand-
 * maintained list of files under `doctor/` and asserting none of them
 * contains the literal string. That guard was always scoped to one package;
 * it could never have caught a second call site anywhere else in the
 * workspace. This one can, because it does not enumerate files by name — it
 * walks every package's `src/` itself, so a new file automatically falls
 * under it the moment it exists.
 */
describe('workspace-wide guard — adb kill-server has exactly one implementation call site (plan 01 §398/§494, plan 88 §3.10/§4.8/§5 step 88.9)', () => {
  /** Every non-test `.ts` file under `packages/*\/src`, recursively. `.test.ts` is excluded deliberately — a test file's job is to talk ABOUT the forbidden string (assertions, fixture arrays), which necessarily spells it out; what must never contain it outside a comment is implementation. */
  function listImplementationFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        out.push(...listImplementationFiles(full))
        continue
      }
      if (!entry.endsWith('.ts')) continue
      if (entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue
      out.push(full)
    }
    return out
  }

  /**
   * Strips `//` line comments and `/* *\/` block comments so a rule
   * explanation ("NEVER calls kill-server", "the single kill-server call
   * site") does not itself trip the guard — plan 01 §494's own qualifier was
   * "di luar komentar" (outside comments). String and template literals are
   * tracked and copied through untouched, so a real usage like
   * `spawnAdb(bin, ['kill-server'])` still counts. This is a guard's comment
   * stripper, not a TS parser — good enough for a literal-string search, not
   * a claim of full language correctness.
   */
  function stripComments(source: string): string {
    let out = ''
    let i = 0
    const n = source.length
    while (i < n) {
      const ch = source[i]
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch
        out += ch
        i++
        while (i < n && source[i] !== quote) {
          if (source[i] === '\\') {
            out += source[i] + (source[i + 1] ?? '')
            i += 2
            continue
          }
          out += source[i]
          i++
        }
        if (i < n) {
          out += source[i]
          i++
        }
        continue
      }
      if (ch === '/' && source[i + 1] === '/') {
        while (i < n && source[i] !== '\n') i++
        continue
      }
      if (ch === '/' && source[i + 1] === '*') {
        i += 2
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
        i += 2
        continue
      }
      out += ch
      i++
    }
    return out
  }

  test('the literal "kill-server", outside comments, appears in exactly one non-test .ts file across every package', () => {
    // `import.meta.dir` is packages/core/src/tools — four levels up is the repo root.
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
    const packagesDir = join(repoRoot, 'packages')
    const offenders: string[] = []
    for (const pkg of readdirSync(packagesDir)) {
      const srcDir = join(packagesDir, pkg, 'src')
      try {
        if (!statSync(srcDir).isDirectory()) continue
      } catch {
        continue // a package with no src/ (none today, but this must not throw if one appears)
      }
      for (const file of listImplementationFiles(srcDir)) {
        const code = stripComments(readFileSync(file, 'utf8'))
        if (code.toLowerCase().includes('kill' + '-server')) {
          offenders.push(relative(repoRoot, file))
        }
      }
    }
    expect(offenders, `expected exactly one file to run adb kill-server; found: ${offenders.join(', ') || '(none — the one permitted call site went missing)'}`).toEqual([
      'packages/core/src/tools/adb-server-control.ts',
    ])
  })
})
