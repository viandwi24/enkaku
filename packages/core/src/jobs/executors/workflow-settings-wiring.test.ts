import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobRunner, SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../../db'
import { scripts, type JobRow } from '../../db/schema'
import { createDevSlotStore } from '../../plugins/dev-slots'
import { createJobNodeTracker } from '../../runner/artifact-store'
import { createScriptRegistry } from '../../scripts/registry'
import { createFarmSettingsStore } from '../../settings/farm-settings'
import type { Logger } from '../../util/logger'
import type { ExecutorContext } from '../executor'
import { createWorkflowExecutor } from './workflow'

/**
 * REGRESSION GUARD — this test used to PIN THE GAP (failed by name until the
 * fix landed), the same pattern `daemon.ts`'s own `daemon-wiring.test.ts`
 * already established for this problem shape (a wiring fact that lives only
 * inside `daemon.ts`, which "opens real adb, real sockets, real timers" and
 * has no exported entry point a unit test can drive directly — so the test
 * reads the real source text instead of importing and calling anything).
 *
 * Plan 99 §5 items 1-2 gave `workflow.maxTotalMs` a real, Studio-editable
 * farm setting (`packages/protocol/src/settings.ts`, registered on the Jobs
 * tab — `packages/studio/src/components/settings/farmSections.ts`) and
 * `checkWorkflow`'s publish-time arithmetic (`packages/protocol/src/workflow-check.ts`,
 * `E_WORKFLOW_BUDGET_IMPOSSIBLE`, §4.3 check 7) reads it through
 * `packages/core/src/api/workflows.ts`'s own optional `deps.settings`
 * (falling back to the schema default when `daemon.ts` does not pass one —
 * see that file's own `budgetFor` doc comment).
 *
 * `daemon.ts` was NOT in step 99.7's file list (a concurrent worker held it
 * at the time), so the WORKFLOW EXECUTOR's own runtime clock,
 * `E_WORKFLOW_BUDGET_EXCEEDED` (`packages/core/src/jobs/executors/workflow.ts`),
 * kept reading the literal closure `settings: () => ({ maxTotalMs:
 * DEFAULT_WORKFLOW_MAX_TOTAL_MS })` step 99.7 wired in — the publish-time
 * check honoured an operator's customised value while the runtime clock
 * silently kept enforcing the schema default, which made the inconsistency
 * WORSE than not having the setting at all. That has now been fixed:
 * `daemon.ts`'s `createWorkflowExecutor({...})` call reads
 * `settings: () => settingsStore.get().workflow` instead (the
 * `WorkflowExecutorDeps.settings: () => WorkflowSettings` seam was already
 * exactly this shape), and the now-unused `DEFAULT_WORKFLOW_MAX_TOTAL_MS`
 * import was dropped from `daemon.ts` (it stays exported from `workflow.ts`
 * — several *.test.ts files in this directory still build a
 * `WorkflowExecutorDeps` directly and use it as their own literal default).
 *
 * This test now pins the OPPOSITE fact — the live read is there — and must
 * still fail if a future edit quietly drops it back to a captured literal.
 */

const daemonSource = readFileSync(join(import.meta.dir, '..', '..', 'daemon.ts'), 'utf8')

/** Extracts the balanced-brace call `name({ ... })` starting at `name({` — mirrors `daemon-wiring.test.ts`'s own helper (duplicated rather than imported: two small, single-purpose test-only helpers are cheaper than a cross-test-file dependency for one function). */
function extractCall(source: string, marker: string): string {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`daemon.ts no longer calls ${marker} — this test needs updating alongside that change`)
  const openBrace = start + marker.length - 1
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

describe('daemon.ts wiring — workflow.maxTotalMs (plan 99 §3.11, §5 items 1-2)', () => {
  test('createWorkflowExecutor(...) reads the LIVE farm setting, not the DEFAULT_WORKFLOW_MAX_TOTAL_MS constant', () => {
    const call = extractCall(daemonSource, 'createWorkflowExecutor({')
    expect(call).toContain('settingsStore.get().workflow')
    // The specific regression this guards: a captured literal (equal in
    // VALUE to the farm default, so easy to miss in a diff) silently
    // replacing the live read again.
    expect(call).not.toContain('DEFAULT_WORKFLOW_MAX_TOTAL_MS')
  })
})

/**
 * The text-pinning test above only proves `daemon.ts`'s SOURCE contains the
 * right expression — `workflow.test.ts` already proves the executor's own
 * mechanism honours whatever `deps.settings()` returns (`{ maxTotalMs: 5 }`,
 * handed to it directly). Neither would have caught the actual regression:
 * `daemon.ts` handing the executor a value it captured once, wired through
 * an accessor that LOOKS live but never changes. The gap in this repo's
 * history was never "does the executor re-read `deps.settings()`" — it
 * already did — it was "does daemon.ts's closure actually reach the
 * settings STORE an operator's PATCH goes through, the same way every other
 * farm-wide knob in that file does."
 *
 * This proves that, end to end: a REAL `FarmSettingsStore`
 * (`createFarmSettingsStore`, unmodified — the exact constructor `daemon.ts`
 * calls once at boot), a `WorkflowExecutorDeps.settings` closure with the
 * IDENTICAL shape `daemon.ts` now uses (`() => settingsStore.get().workflow`,
 * not a captured object), and `settingsStore.update(...)` — the same public
 * method the Farm Settings PATCH route calls when an operator edits the
 * Jobs tab in Studio. `Date.now` is frozen and hand-advanced (the same
 * `withFakeClock` shape `api/guest-agent.test.ts` already uses for a
 * seconds-resolution timing assertion) so the real `min(60_000)` floor
 * `settings.ts` enforces does not force this test to actually sleep a
 * minute.
 */
describe('a changed farm setting reaches the workflow executor\'s clock, in a manager built the way daemon.ts builds it', () => {
  function setUpDb(): Db {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    return opened.db
  }

  const silentLog = (): Logger => {
    const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
    return l as unknown as Logger
  }

  function publishScript(db: Db, name: string, version: string) {
    const id = `${name}-${version}`
    db.insert(scripts)
      .values({ id, name, version, kind: 'script', bundle: 'export default { run: async () => null }', enabled: true, paramsSchema: null, createdAt: new Date() })
      .run()
    return id
  }

  function publishWorkflow(db: Db, name: string, version: string, doc: unknown) {
    const id = `${name}-${version}`
    db.insert(scripts)
      .values({ id, name, version, kind: 'workflow', bundle: JSON.stringify(doc), source: JSON.stringify(doc, null, 2), enabled: true, paramsSchema: null, createdAt: new Date() })
      .run()
    return id
  }

  function makeJobRow(): JobRow {
    return {
      id: 'job-1',
      scriptId: 'pipeline-1.0.0',
      deviceId: 'd1',
      params: null,
      priority: 0,
      status: 'running',
      leaseExpiresAt: null,
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
      batchId: null,
      batchSeq: null,
      expiresAt: null,
      failureClass: null,
      errorPhase: null,
      infraAttempts: 0,
      scriptName: null,
      scriptVersion: null,
      triggeredByJobId: null,
      rootJobId: null,
      depth: 0,
      triggerKey: null,
      peakRssBytes: null,
      assistCount: 0,
      maxConcurrent: null,
      // Plan 98 §3.8, §4.4, step 98.7 — null here: a bare fixture row, no
      // per-job override exercised by this file's own test.
      runtimeOverride: null,
      // Plan 94 §3.8, §4.8, step 94.6 — null here: a bare fixture row, no
      // pacer exercised by this file's own test.
      notBefore: null,
      batchRepeat: null,
      pacedDelayMs: null,
      // Plan 97 §3.3, §4.4 — null here: a bare fixture row, no result path
      // exercised by this file's own test.
      resultStatus: null,
      resultBytes: null,
      resultSummary: null,
      resultIssues: null,
    }
  }

  function fakeSessions(): SessionManager {
    return {
      acquire: async (deviceId) => ({ deviceId, inspector: null, whenInspectorReady: async () => {} }) as never,
      release: () => {},
      get: () => null as never,
      closeDevice: async () => {},
      closeIfIdle: async () => {},
      idleSessions: () => [],
      closeAll: async () => 0,
    }
  }

  /** Freezes `Date.now()`, restoring the real clock afterward even if `fn` throws — same shape `api/guest-agent.test.ts`'s `withFakeClock` already uses. */
  async function withFakeClock<T>(startMs: number, fn: (advance: (deltaMs: number) => void) => Promise<T>): Promise<T> {
    const realNow = Date.now
    let current = startMs
    Date.now = () => current
    try {
      return await fn((deltaMs) => {
        current += deltaMs
      })
    } finally {
      Date.now = realNow
    }
  }

  function makeCtx(): ExecutorContext {
    return { signal: new AbortController().signal, heartbeat: () => {}, log: silentLog() }
  }

  test('lowering workflow.maxTotalMs through the real store trips the SAME budget check daemon.ts wires the executor to, and raising it again lifts the trip', async () => {
    const db = setUpDb()
    // The exact constructor `daemon.ts` calls once at boot (`const
    // settingsStore = createFarmSettingsStore(db, { authMode })`).
    const settingsStore = createFarmSettingsStore(db)

    publishScript(db, 'node-a', '1.0.0')
    publishScript(db, 'node-b', '1.0.0')
    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
      maxSteps: 50,
    }
    publishWorkflow(db, 'pipeline', '1.0.0', doc)

    const deps = {
      db,
      registry: createScriptRegistry({ db, dataDir: `/tmp/enkaku-workflow-settings-wiring-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() }),
      sessions: fakeSessions(),
      nodeTracker: createJobNodeTracker(),
      // The IDENTICAL accessor shape now in daemon.ts — a live read of the
      // real store, never a captured `WorkflowSettings` object.
      settings: () => settingsStore.get().workflow,
      log: silentLog(),
      onNode: () => {},
    }

    await withFakeClock(1_000_000, async (advance) => {
      // The Farm Settings PATCH route's own call shape (`update()`, not
      // reaching into `cached` directly) — the schema's real `min(60_000)`
      // floor, no bypass.
      settingsStore.update({ workflow: { maxTotalMs: 60_000 } })
      expect(settingsStore.get().workflow.maxTotalMs).toBe(60_000)

      const runner: JobRunner = {
        execute: async (job) => {
          if (job.nodeId === 'a') advance(70_000) // simulates 70s of real wall-clock work without an actual sleep
          return { ok: true, value: null }
        },
        abort: () => true,
        notifyAssist: () => false,
      }
      const executor = createWorkflowExecutor({ ...deps, runner })

      let caught: unknown
      try {
        await executor.run(makeJobRow(), makeCtx())
      } catch (err) {
        caught = err
      }
      expect((caught as { code?: string } | undefined)?.code).toBe('E_WORKFLOW_BUDGET_EXCEEDED')
      expect((caught as { message?: string } | undefined)?.message).toContain('60000ms')

      // The operator raises the setting from Studio. Nothing about the
      // executor was rebuilt — a FRESH run just reads the store again, the
      // same way a fresh job would in a real boot.
      settingsStore.update({ workflow: { maxTotalMs: 604_800_000 } }) // 7 days, the schema max
      expect(settingsStore.get().workflow.maxTotalMs).toBe(604_800_000)
    })

    // A second run, same elapsed 70s (fresh fake-clock window), now under
    // the raised budget: no E_WORKFLOW_BUDGET_EXCEEDED.
    await withFakeClock(2_000_000, async (advance) => {
      const runner: JobRunner = {
        execute: async (job) => {
          if (job.nodeId === 'a') advance(70_000)
          return { ok: true, value: null }
        },
        abort: () => true,
        notifyAssist: () => false,
      }
      const executor = createWorkflowExecutor({ ...deps, runner })
      const result = await executor.run({ ...makeJobRow(), id: 'job-2' }, makeCtx())
      expect(Array.isArray(result)).toBe(true)
    })
  })
})
