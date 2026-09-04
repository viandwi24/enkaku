import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { WorkflowDocSchema, type WorkflowDoc } from '@enkaku/protocol'
import { openDb, runMigrations } from '../../db'
import { jobRuns, jobs, workflowSteps } from '../../db/schema'
import { createRunStore } from '../runs/store'
import { createRunWatcher } from '../runs/watcher'
import { createWorkflowOrchestrator, type WorkflowOrchestratorDeps } from './workflow'
import type { ScriptEntry, ScriptRegistry } from '../../scripts/registry'
import type { Logger } from '../../util/logger'

function scriptNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'script', id: 'n0', title: '', ui: { x: 0, y: 0 }, script: 'demo/step@1.0.0', params: {}, ...overrides }
}

function startNode(overrides: Record<string, unknown> = {}) {
  return { kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 }, ...overrides }
}

function threeStepDoc(): WorkflowDoc {
  return WorkflowDocSchema.parse({
    schema: 2,
    name: 'three-steps',
    title: 'Three steps',
    description: '',
    params: [],
    entry: 'start',
    nodes: [
      startNode({ next: 's1' }),
      scriptNode({ id: 's1', title: 'Step 1', script: 'demo/s1@1.0.0', next: 's2' }),
      scriptNode({ id: 's2', title: 'Step 2', script: 'demo/s2@1.0.0', next: 's3' }),
      scriptNode({ id: 's3', title: 'Step 3', script: 'demo/s3@1.0.0' }),
    ],
  })
}

/** The SAME three steps, with `nodes[]` in a different array order — proves array order carries no control meaning (G2). */
function threeStepDocShuffled(): WorkflowDoc {
  const doc = threeStepDoc()
  return WorkflowDocSchema.parse({ ...doc, nodes: [...doc.nodes].reverse() })
}

function gateDoc(): WorkflowDoc {
  return WorkflowDocSchema.parse({
    schema: 2,
    name: 'gate-doc',
    title: 'Gate doc',
    description: '',
    params: [],
    entry: 'start',
    nodes: [
      startNode({ next: 's1' }),
      scriptNode({ id: 's1', title: 'Step 1', script: 'demo/s1@1.0.0', next: 'g1' }),
      {
        kind: 'gate',
        id: 'g1',
        title: 'Gate',
        ui: { x: 0, y: 0 },
        when: { left: { from: 's1', path: 'matches' }, op: 'notEmpty' },
        then: 'finish',
        else: 's1',
      },
      { kind: 'finish', id: 'finish', title: '', ui: { x: 0, y: 0 }, status: 'succeed', message: '' },
    ],
  })
}

function failingDoc(): WorkflowDoc {
  return WorkflowDocSchema.parse({
    schema: 2,
    name: 'failing-doc',
    title: 'Failing doc',
    description: '',
    params: [],
    entry: 'start',
    nodes: [
      startNode({ next: 's1' }),
      scriptNode({ id: 's1', title: 'Step 1', script: 'demo/s1@1.0.0', next: 's2' }),
      scriptNode({ id: 's2', title: 'Step 2 (fails)', script: 'demo/s2@1.0.0', next: 's3' }),
      scriptNode({ id: 's3', title: 'Step 3 (never reached)', script: 'demo/s3@1.0.0' }),
    ],
  })
}

/** A dangling `next` (no finish node) — the run ends succeeded once it falls off the end. */
function danglingNextDoc(): WorkflowDoc {
  return WorkflowDocSchema.parse({
    schema: 2,
    name: 'dangling-next',
    title: '',
    description: '',
    params: [],
    entry: 'start',
    nodes: [startNode({ next: 's1' }), scriptNode({ id: 's1', script: 'demo/s1@1.0.0' })],
  })
}

/** A dangling `onFailure` — the run ends failed once the step fails with nowhere to go. */
function danglingOnFailureDoc(): WorkflowDoc {
  return WorkflowDocSchema.parse({
    schema: 2,
    name: 'dangling-onfailure',
    title: '',
    description: '',
    params: [],
    entry: 'start',
    nodes: [startNode({ next: 's1' }), scriptNode({ id: 's1', script: 'demo/s1@1.0.0' })],
  })
}

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function fakeRegistry(): ScriptRegistry {
  return {
    list: () => ({ items: [], nextCursor: null, total: 0 }),
    get: () => null,
    resolve: (ref) => {
      const [name, version] = String(ref).split('@')
      return { id: `script-${name}`, name: name ?? 'demo', version: version ?? '1.0.0', origin: 'plugin', pluginName: 'demo', exportId: null, enabled: true, paramsSchema: null, runtime: null } as ScriptEntry
    },
    bundlePath: async () => '/dev/null',
    invalidate: () => {},
  }
}

/**
 * Builds an orchestrator whose `enqueueStep` immediately settles the step's
 * run (through the SAME `RunStore` production code uses) according to
 * `plan`, keyed by scriptId — this is what lets `waitForTerminal` resolve
 * synchronously (already-terminal branch) without a real executor host.
 */
function setUp(plan: Map<string, { status: 'success' | 'failed' | 'cancelled'; result?: unknown; error?: string }>) {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  const db = opened.db
  const runs = createRunStore(db)
  const watcher = createRunWatcher({ getRun: (id) => runs.getRun(id) })
  const cancelledRunIds: string[] = []

  const deps: WorkflowOrchestratorDeps = {
    db,
    runs,
    watcher,
    registry: fakeRegistry(),
    enqueueStep(input) {
      const job = runs.createJob({
        kind: 'script',
        scriptId: input.scriptId,
        deviceId: input.deviceId,
        params: input.params,
        scriptName: input.scriptName,
        scriptVersion: input.scriptVersion,
        parentWorkflowJobId: input.parentWorkflowJobId,
        stepSeq: input.stepSeq,
      })
      const run = runs.addRun(job.id, { trigger: 'workflow-step', priority: input.priority })
      db.update(jobRuns).set({ status: 'running' }).where(eq(jobRuns.id, run.id)).run()
      const outcome = plan.get(input.scriptId) ?? { status: 'success', result: null }
      const settled = runs.settle(run.id, { status: outcome.status, result: outcome.result, error: outcome.error })
      return { job, run: settled ?? run }
    },
    cancelRun(runId) {
      cancelledRunIds.push(runId)
    },
    settings: () => ({ maxTotalMs: 3_600_000 }),
    log: silentLog(),
  }
  return { db, runs, deps, cancelledRunIds }
}

function workflowJobFor(runs: ReturnType<typeof createRunStore>, doc: WorkflowDoc | Record<string, unknown>) {
  const job = runs.createJob({ kind: 'workflow', workflowName: doc.name as string, workflowDoc: doc, deviceId: 'dev-1', params: {}, scriptName: doc.name as string, scriptVersion: null })
  const run = runs.addRun(job.id, { trigger: 'manual' })
  return { job, run }
}

describe('createWorkflowOrchestrator (plan 211 §4.5, doc v2 by plan 301)', () => {
  test('three script steps become three child script jobs, in order — start/finish never logged', async () => {
    const { runs, deps } = setUp(new Map())
    const orchestrator = createWorkflowOrchestrator(deps)
    const { job, run } = workflowJobFor(runs, threeStepDoc())
    const controller = new AbortController()

    const summary = await orchestrator.run(job, { runId: run.id, run, signal: controller.signal, heartbeat: () => {}, log: deps.log })
    expect(Array.isArray(summary)).toBe(true)

    const stepRows = deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id)).all().sort((a, b) => a.seq - b.seq)
    expect(stepRows).toHaveLength(3)
    expect(stepRows.map((s) => s.stepId)).toEqual(['s1', 's2', 's3'])
    for (const s of stepRows) {
      expect(s.status).toBe('success')
      expect(s.jobId).not.toBeNull()
    }
    const stepJobs = deps.db.select().from(jobs).where(eq(jobs.parentWorkflowJobId, job.id)).all()
    expect(stepJobs).toHaveLength(3)
    expect(stepJobs.map((j) => j.stepSeq).sort()).toEqual([0, 1, 2])
  })

  test('order-independence (G2): a shuffled nodes[] array produces the identical step sequence', async () => {
    const { runs: runsA, deps: depsA } = setUp(new Map())
    const orchestratorA = createWorkflowOrchestrator(depsA)
    const { job: jobA, run: runA } = workflowJobFor(runsA, threeStepDoc())
    await orchestratorA.run(jobA, { runId: runA.id, run: runA, signal: new AbortController().signal, heartbeat: () => {}, log: depsA.log })
    const stepsA = depsA.db.select().from(workflowSteps).where(eq(workflowSteps.runId, runA.id)).all().sort((a, b) => a.seq - b.seq).map((s) => s.stepId)

    const { runs: runsB, deps: depsB } = setUp(new Map())
    const orchestratorB = createWorkflowOrchestrator(depsB)
    const { job: jobB, run: runB } = workflowJobFor(runsB, threeStepDocShuffled())
    await orchestratorB.run(jobB, { runId: runB.id, run: runB, signal: new AbortController().signal, heartbeat: () => {}, log: depsB.log })
    const stepsB = depsB.db.select().from(workflowSteps).where(eq(workflowSteps.runId, runB.id)).all().sort((a, b) => a.seq - b.seq).map((s) => s.stepId)

    expect(stepsA).toEqual(['s1', 's2', 's3'])
    expect(stepsB).toEqual(stepsA)
  })

  test('a gate step records its verdict and branches, ending at a finish node', async () => {
    const { runs, deps } = setUp(new Map([['script-demo/s1', { status: 'success', result: { matches: ['x'] } }]]))
    const orchestrator = createWorkflowOrchestrator(deps)
    const { job, run } = workflowJobFor(runs, gateDoc())
    const controller = new AbortController()

    await orchestrator.run(job, { runId: run.id, run, signal: controller.signal, heartbeat: () => {}, log: deps.log })

    const stepRows = deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id)).all().sort((a, b) => a.seq - b.seq)
    const gateRow = stepRows.find((s) => s.stepId === 'g1')
    expect(gateRow?.jobId).toBeNull()
    expect(gateRow?.verdict).not.toBeNull()
    // The `finish` node itself is never logged as a workflow_steps row (plan 301 §3.2, §4).
    expect(stepRows.some((s) => s.stepId === 'finish')).toBe(false)
  })

  test('a failing step ends the workflow run at that step', async () => {
    const { runs, deps } = setUp(new Map([['script-demo/s2', { status: 'failed', error: 'boom' }]]))
    const orchestrator = createWorkflowOrchestrator(deps)
    const { job, run } = workflowJobFor(runs, failingDoc())
    const controller = new AbortController()

    await expect(orchestrator.run(job, { runId: run.id, run, signal: controller.signal, heartbeat: () => {}, log: deps.log })).rejects.toThrow()

    const stepRows = deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id)).all().sort((a, b) => a.seq - b.seq)
    expect(stepRows.map((s) => s.stepId)).toEqual(['s1', 's2', 's3'])
    expect(stepRows[1]?.status).toBe('failed')
    expect(stepRows[2]?.status).toBe('skipped')
  })

  test('a dangling `next` ends the run succeeded', async () => {
    const { runs, deps } = setUp(new Map())
    const orchestrator = createWorkflowOrchestrator(deps)
    const { job, run } = workflowJobFor(runs, danglingNextDoc())
    const summary = await orchestrator.run(job, { runId: run.id, run, signal: new AbortController().signal, heartbeat: () => {}, log: deps.log })
    expect(Array.isArray(summary)).toBe(true) // resolved, not thrown — the run succeeded
  })

  test('a dangling `onFailure` ends the run failed', async () => {
    const { runs, deps } = setUp(new Map([['script-demo/s1', { status: 'failed', error: 'boom' }]]))
    const orchestrator = createWorkflowOrchestrator(deps)
    const { job, run } = workflowJobFor(runs, danglingOnFailureDoc())
    await expect(orchestrator.run(job, { runId: run.id, run, signal: new AbortController().signal, heartbeat: () => {}, log: deps.log })).rejects.toThrow()
  })

  test('resume adds a run that carries over the successful steps and restarts at step N', async () => {
    const { runs, deps } = setUp(new Map())
    const orchestrator = createWorkflowOrchestrator(deps)
    const { job, run: firstRun } = workflowJobFor(runs, threeStepDoc())
    const controller = new AbortController()
    await orchestrator.run(job, { runId: firstRun.id, run: firstRun, signal: controller.signal, heartbeat: () => {}, log: deps.log })

    const resumeRun = runs.addRun(job.id, { trigger: 'resume', resumedFromRunId: firstRun.id, resumedFromStep: 1 })
    const controller2 = new AbortController()
    await orchestrator.run(job, { runId: resumeRun.id, run: resumeRun, signal: controller2.signal, heartbeat: () => {}, log: deps.log })

    const resumeSteps = deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, resumeRun.id)).all().sort((a, b) => a.seq - b.seq)
    expect(resumeSteps[0]?.status).toBe('carried-over')
    expect(resumeSteps[0]?.stepId).toBe('s1')
  })

  test('v1 snapshot still runs (G8): a job.workflow_doc holding a v1 document is upgraded IN MEMORY and runs unmodified in the database', async () => {
    const { runs, deps } = setUp(new Map())
    const orchestrator = createWorkflowOrchestrator(deps)
    const v1Doc = {
      schema: 1,
      name: 'v1-snapshot',
      title: '',
      description: '',
      params: [],
      maxSteps: 50,
      nodes: [
        { kind: 'script', id: 's1', title: '', script: 'demo/s1@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 's2', title: '', script: 'demo/s2@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
    }
    const { job, run } = workflowJobFor(runs, v1Doc)
    const rawBefore = deps.db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.workflowDoc

    const summary = await orchestrator.run(job, { runId: run.id, run, signal: new AbortController().signal, heartbeat: () => {}, log: deps.log })
    expect(Array.isArray(summary)).toBe(true)

    const stepRows = deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id)).all().sort((a, b) => a.seq - b.seq)
    expect(stepRows.map((s) => s.stepId)).toEqual(['s1', 's2'])

    // The snapshot in the database is UNTOUCHED — still schema 1.
    const rawAfter = deps.db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.workflowDoc
    expect(rawAfter).toEqual(rawBefore)
    expect((rawAfter as { schema: number }).schema).toBe(1)
  })

  test('a parameter bound through an { expr } is resolved and passed to the step (plan 302 §4.7/§4.8)', async () => {
    const doc = WorkflowDocSchema.parse({
      schema: 2,
      name: 'expr-doc',
      title: '',
      description: '',
      params: [{ name: 'threshold', type: 'number', required: true, title: 'Threshold' }],
      entry: 'start',
      nodes: [
        startNode({ next: 's1' }),
        scriptNode({ id: 's1', title: 'Step 1', script: 'demo/s1@1.0.0', next: 's2' }),
        scriptNode({
          id: 's2',
          title: 'Step 2',
          script: 'demo/s2@1.0.0',
          params: { verdict: { expr: '$nodes.s1.count > $params.threshold' }, echoedNow: { expr: '$now > 0' } },
        }),
      ],
    })
    const { runs, deps } = setUp(new Map([['script-demo/s1', { status: 'success', result: { count: 12 } }]]))
    const orchestrator = createWorkflowOrchestrator(deps)
    const job = runs.createJob({ kind: 'workflow', workflowName: doc.name, workflowDoc: doc, deviceId: 'dev-1', params: { threshold: 3 }, scriptName: doc.name, scriptVersion: null })
    const run = runs.addRun(job.id, { trigger: 'manual' })

    const summary = await orchestrator.run(job, { runId: run.id, run, signal: new AbortController().signal, heartbeat: () => {}, log: deps.log })
    expect(Array.isArray(summary)).toBe(true)

    const s2Job = deps.db.select().from(jobs).where(eq(jobs.parentWorkflowJobId, job.id)).all().find((j) => j.stepSeq === 1)
    expect(s2Job).toBeDefined()
    expect(s2Job?.params).toEqual({ verdict: true, echoedNow: true })
  })
})
