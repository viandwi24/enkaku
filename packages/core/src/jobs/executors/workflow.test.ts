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
  return { kind: 'script', id: 'n0', title: '', script: 'demo/step@1.0.0', params: {}, onFailure: { go: 'fail' }, ...overrides }
}

function threeStepDoc(): WorkflowDoc {
  return WorkflowDocSchema.parse({
    schema: 1,
    name: 'three-steps',
    title: 'Three steps',
    description: '',
    params: [],
    nodes: [
      scriptNode({ id: 's1', title: 'Step 1', script: 'demo/s1@1.0.0' }),
      scriptNode({ id: 's2', title: 'Step 2', script: 'demo/s2@1.0.0' }),
      scriptNode({ id: 's3', title: 'Step 3', script: 'demo/s3@1.0.0' }),
    ],
  })
}

function gateDoc(): WorkflowDoc {
  return WorkflowDocSchema.parse({
    schema: 1,
    name: 'gate-doc',
    title: 'Gate doc',
    description: '',
    params: [],
    nodes: [
      scriptNode({ id: 's1', title: 'Step 1', script: 'demo/s1@1.0.0' }),
      {
        kind: 'gate',
        id: 'g1',
        title: 'Gate',
        when: { left: { from: 's1', path: 'matches' }, op: 'notEmpty' },
        then: { go: 'stop' },
        else: { go: 'goto', node: 's1' },
      },
    ],
  })
}

function failingDoc(): WorkflowDoc {
  return WorkflowDocSchema.parse({
    schema: 1,
    name: 'failing-doc',
    title: 'Failing doc',
    description: '',
    params: [],
    nodes: [
      scriptNode({ id: 's1', title: 'Step 1', script: 'demo/s1@1.0.0' }),
      scriptNode({ id: 's2', title: 'Step 2 (fails)', script: 'demo/s2@1.0.0' }),
      scriptNode({ id: 's3', title: 'Step 3 (never reached)', script: 'demo/s3@1.0.0' }),
    ],
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

function workflowJobFor(runs: ReturnType<typeof createRunStore>, doc: WorkflowDoc) {
  const job = runs.createJob({ kind: 'workflow', workflowName: doc.name, workflowDoc: doc, deviceId: 'dev-1', params: {}, scriptName: doc.name, scriptVersion: null })
  const run = runs.addRun(job.id, { trigger: 'manual' })
  return { job, run }
}

describe('createWorkflowOrchestrator (plan 211 §4.5)', () => {
  test('three script steps become three child script jobs, in order', async () => {
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

  test('a gate step records its verdict and branches', async () => {
    const { runs, deps } = setUp(new Map([['script-demo/s1', { status: 'success', result: { matches: ['x'] } }]]))
    const orchestrator = createWorkflowOrchestrator(deps)
    const { job, run } = workflowJobFor(runs, gateDoc())
    const controller = new AbortController()

    await orchestrator.run(job, { runId: run.id, run, signal: controller.signal, heartbeat: () => {}, log: deps.log })

    const stepRows = deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id)).all().sort((a, b) => a.seq - b.seq)
    const gateRow = stepRows.find((s) => s.stepId === 'g1')
    expect(gateRow?.jobId).toBeNull()
    expect(gateRow?.verdict).not.toBeNull()
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
})
