import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUDIT_RETENTION_DAYS } from '../config/constants'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts, auditLog, deviceEvents, jobRuns } from '../db/schema'
import { createRunRetentionSweeper } from '../jobs/runs/sweeper'
import { createRunStore } from '../jobs/runs/store'
import { createFarmSettingsStore } from '../settings/farm-settings'
import { createLogger } from '../util/logger'
import { createRetentionSweeper } from './sweeper'

const tmpDirs: string[] = []
function tmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-retention-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  const dataDir = tmpDataDir()
  const runs = createRunStore(opened.db)
  const settings = createFarmSettingsStore(opened.db)
  const log = createLogger('test').child('retention')
  const sweeper = createRetentionSweeper({
    db: opened.db,
    dataDir,
    settings,
    runs,
    createRunRetentionSweeper,
    log,
    intervalMinutes: 60,
  })
  return { db: opened.db, dataDir, runs, settings, sweeper }
}

function ageRun(db: Db, runId: string, daysAgo: number, status: 'success' | 'failed' = 'success') {
  db.update(jobRuns).set({ status, finishedAt: new Date(Date.now() - daysAgo * 86_400_000) }).where(eq(jobRuns.id, runId)).run()
}

function seedArtifact(db: Db, opts: { id: string; daysAgo: number; sizeBytes: number; runId?: string | null; deviceId?: string | null }) {
  db.insert(artifacts)
    .values({
      id: opts.id,
      runId: opts.runId ?? null,
      deviceId: opts.deviceId ?? null,
      kind: 'screenshot',
      label: null,
      path: `${opts.id}.png`,
      sizeBytes: opts.sizeBytes,
      createdAt: new Date(Date.now() - opts.daysAgo * 86_400_000),
    })
    .run()
}

function seedAudit(db: Db, id: string, daysAgo: number) {
  db.insert(auditLog)
    .values({ id, userId: null, action: 'device.enroll', target: null, meta: null, at: new Date(Date.now() - daysAgo * 86_400_000) })
    .run()
}

describe('sweepOnce deletes exactly what dryRun reported (G2)', () => {
  test('a seeded database with 5 expired runs, 2 fresh runs, 1 orphan job, 3 stale artifacts, 1 schedule-owned job', () => {
    const { db, runs, sweeper } = harness()

    // jobA: 2 old non-latest runs (candidates) + 1 fresh latest run.
    const jobA = runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1' })
    const a1 = runs.addRun(jobA.id, { trigger: 'manual' })
    ageRun(db, a1.id, 40)
    const a2 = runs.addRun(jobA.id, { trigger: 'manual' })
    ageRun(db, a2.id, 40)
    const a3 = runs.addRun(jobA.id, { trigger: 'manual' })
    ageRun(db, a3.id, 1)

    // jobB: 2 old non-latest runs (candidates) + 1 old LATEST run (protected despite its age).
    const jobB = runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1' })
    const b1 = runs.addRun(jobB.id, { trigger: 'manual' })
    ageRun(db, b1.id, 40)
    const b2 = runs.addRun(jobB.id, { trigger: 'manual' })
    ageRun(db, b2.id, 40)
    const b3 = runs.addRun(jobB.id, { trigger: 'manual' })
    ageRun(db, b3.id, 40)

    // jobC: 1 old non-latest run (candidate) + 1 old latest run (protected).
    const jobC = runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1' })
    const c1 = runs.addRun(jobC.id, { trigger: 'manual' })
    ageRun(db, c1.id, 40)
    const c2 = runs.addRun(jobC.id, { trigger: 'manual' })
    ageRun(db, c2.id, 40)

    // jobD: a single fresh run — the second of "2 fresh runs".
    const jobD = runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1' })
    const d1 = runs.addRun(jobD.id, { trigger: 'manual' })
    ageRun(db, d1.id, 1)

    // jobE: an orphan — zero runs, ever.
    runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1' })

    // jobF: schedule-owned, its only run is 40 days old — must survive.
    const jobF = runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1', scheduleId: 'sched-1' })
    const f1 = runs.addRun(jobF.id, { trigger: 'schedule' })
    ageRun(db, f1.id, 40)

    seedArtifact(db, { id: 'art-1', daysAgo: 40, sizeBytes: 1000 })
    seedArtifact(db, { id: 'art-2', daysAgo: 40, sizeBytes: 1000 })
    seedArtifact(db, { id: 'art-3', daysAgo: 40, sizeBytes: 1000 })

    const dry = sweeper.dryRun()
    expect(dry.runsDeleted).toBe(5)
    expect(dry.jobsDeleted).toBe(1)
    expect(dry.artifactsDeleted).toBe(3)

    const real = sweeper.sweepOnce()
    expect(real).toEqual(dry)

    for (const id of [a1.id, a2.id, b1.id, b2.id, c1.id]) expect(runs.getRun(id)).toBeNull()
    expect(runs.getRun(a3.id)).not.toBeNull()
    expect(runs.getRun(b3.id)).not.toBeNull()
    expect(runs.getRun(c2.id)).not.toBeNull()
    expect(runs.getRun(d1.id)).not.toBeNull()
    expect(runs.getRun(f1.id)).not.toBeNull()
    expect(runs.getJob(jobF.id)).not.toBeNull()
  })
})

describe('an orphan job with zero runs is swept (G3)', () => {
  test('a job created with no run at all is deleted by the sweep', () => {
    const { runs, sweeper } = harness()
    const orphan = runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1' })
    const result = sweeper.sweepOnce()
    expect(result.jobsDeleted).toBe(1)
    expect(runs.getJob(orphan.id)).toBeNull()
  })
})

describe("a schedule-owned job never loses its last run (G3)", () => {
  test('the extra older runs go; the last one, 200 days old, survives', () => {
    const { db, runs, sweeper } = harness()
    const job = runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1', scheduleId: 'sched-1' })
    const old = runs.addRun(job.id, { trigger: 'schedule' })
    ageRun(db, old.id, 40)
    const latest = runs.addRun(job.id, { trigger: 'schedule' })
    ageRun(db, latest.id, 200)

    const result = sweeper.sweepOnce()
    expect(result.runsDeleted).toBe(1)
    expect(result.jobsDeleted).toBe(0)
    expect(runs.getRun(old.id)).toBeNull()
    expect(runs.getRun(latest.id)).not.toBeNull()
    expect(runs.getJob(job.id)).not.toBeNull()
  })
})

describe('the most recent run of each WORKFLOW survives retention, even across two different jobs (plan 304 §4.4, G8)', () => {
  test('keeps last workflow run', () => {
    const { db, runs, sweeper } = harness()

    // jobA: three runs. r0 (60d, terminal) and r1 (40d, terminal) are both
    // NOT jobA's own latest run (r2, still queued, is) — both would be
    // ordinary candidates under the EXISTING "job's own latest" rule alone.
    // r1 is the WORKFLOW's own most recent completed run, though, so ONLY r0
    // should actually go.
    const jobA = runs.createJob({ kind: 'workflow', workflowName: 'wf-1', workflowDoc: { schema: 2 }, deviceId: 'd1', params: {}, scriptName: 'wf-1', scriptVersion: null })
    const r0 = runs.addRun(jobA.id, { trigger: 'manual' })
    ageRun(db, r0.id, 60, 'failed')
    const r1 = runs.addRun(jobA.id, { trigger: 'manual' })
    ageRun(db, r1.id, 40, 'success')
    const r2 = runs.addRun(jobA.id, { trigger: 'manual' }) // left 'queued' — not terminal, not a candidate at all.

    // jobB: a DIFFERENT job of the SAME workflow, one older completed run —
    // already protected by the EXISTING "job's own latest" rule; present
    // here only to prove a second job of the same workflow does not confuse
    // "the workflow's own most recent run" (still r1, at 40 days, not this
    // one at 90).
    const jobB = runs.createJob({ kind: 'workflow', workflowName: 'wf-1', workflowDoc: { schema: 2 }, deviceId: 'd1', params: {}, scriptName: 'wf-1', scriptVersion: null })
    const rB = runs.addRun(jobB.id, { trigger: 'manual' })
    ageRun(db, rB.id, 90, 'success')

    const result = sweeper.sweepOnce()
    expect(runs.getRun(r0.id)).toBeNull() // old, non-latest-for-its-job, AND not the workflow's own latest — genuinely swept.
    expect(runs.getRun(r1.id)).not.toBeNull() // non-latest-for-its-job, but IS the workflow's own most recent run — kept.
    expect(runs.getRun(r2.id)).not.toBeNull() // never a candidate (not terminal).
    expect(runs.getRun(rB.id)).not.toBeNull() // jobB's own latest run — kept regardless.
    expect(result.runsDeleted).toBe(1)

    // A DIFFERENT workflow's own latest run is unaffected by wf-1's.
    const jobC = runs.createJob({ kind: 'workflow', workflowName: 'wf-2', workflowDoc: { schema: 2 }, deviceId: 'd1', params: {}, scriptName: 'wf-2', scriptVersion: null })
    const oldC = runs.addRun(jobC.id, { trigger: 'manual' })
    ageRun(db, oldC.id, 400)
    sweeper.sweepOnce()
    expect(runs.getRun(oldC.id)).not.toBeNull() // wf-2's own only run — kept as ITS latest, independent of wf-1.
  })
})

describe('device events respect storage.historyDays for main and the fixed constant for input', () => {
  test('main and input streams age out independently', () => {
    const { db, sweeper } = harness()
    db.insert(deviceEvents).values({ id: 'ev-main-old', deviceId: 'd1', stream: 'main', kind: 'device.online', actor: null, meta: null, at: new Date(Date.now() - 40 * 86_400_000) }).run()
    db.insert(deviceEvents).values({ id: 'ev-main-fresh', deviceId: 'd1', stream: 'main', kind: 'device.online', actor: null, meta: null, at: new Date(Date.now() - 1 * 86_400_000) }).run()
    // The input stream retention constant (INPUT_EVENT_RETENTION_DAYS) is much shorter than storage.historyDays.
    db.insert(deviceEvents).values({ id: 'ev-input-old', deviceId: 'd1', stream: 'input', kind: 'input.tap', actor: null, meta: null, at: new Date(Date.now() - 10 * 86_400_000) }).run()
    db.insert(deviceEvents).values({ id: 'ev-input-fresh', deviceId: 'd1', stream: 'input', kind: 'input.tap', actor: null, meta: null, at: new Date() }).run()

    const result = sweeper.sweepOnce()
    expect(result.eventsDeleted).toBe(2) // ev-main-old (>30d) + ev-input-old (>3d, INPUT_EVENT_RETENTION_DAYS default)
    const remaining = db.select({ id: deviceEvents.id }).from(deviceEvents).all().map((r: { id: string }) => r.id)
    expect(remaining.sort()).toEqual(['ev-input-fresh', 'ev-main-fresh'])
  })
})

describe('artifacts sweep is not gated by an enabled flag', () => {
  test('an old artifact is removed even though no farm settings row ever carried an `enabled` field', () => {
    const { db, sweeper } = harness()
    seedArtifact(db, { id: 'art-old', daysAgo: 40, sizeBytes: 500 })
    const result = sweeper.sweepOnce()
    expect(result.artifactsDeleted).toBe(1)
    expect(db.select().from(artifacts).where(eq(artifacts.id, 'art-old')).get()).toBeUndefined()
  })
})

describe('artifact quota deletes oldest-first once the total exceeds maxTotalGb', () => {
  test('the oldest artifacts go first until the total fits', () => {
    const { db, settings, sweeper } = harness()
    settings.update({ storage: { artifacts: { maxAgeDays: 3_650, maxTotalGb: 0.1 } } }) // ~107.37 MB
    seedArtifact(db, { id: 'art-oldest', daysAgo: 5, sizeBytes: 50_000_000 })
    seedArtifact(db, { id: 'art-middle', daysAgo: 3, sizeBytes: 50_000_000 })
    seedArtifact(db, { id: 'art-newest', daysAgo: 1, sizeBytes: 50_000_000 })

    const result = sweeper.sweepOnce()
    expect(result.artifactsDeleted).toBe(1)
    const remainingIds = db.select({ id: artifacts.id }).from(artifacts).all().map((r) => r.id)
    expect(remainingIds.sort()).toEqual(['art-middle', 'art-newest'])
  })
})

describe('audit rows older than AUDIT_RETENTION_DAYS are deleted', () => {
  test('an old audit row is swept; a fresh one is not', () => {
    const { db, sweeper } = harness()
    seedAudit(db, 'audit-old', AUDIT_RETENTION_DAYS + 10)
    seedAudit(db, 'audit-fresh', 1)
    const result = sweeper.sweepOnce()
    expect(result.auditDeleted).toBe(1)
    const remaining = db.select({ id: auditLog.id }).from(auditLog).all().map((r) => r.id)
    expect(remaining).toEqual(['audit-fresh'])
  })
})

describe('a trace directory is removed only for a run that was actually swept', () => {
  test('the swept run loses its directory; the surviving run keeps it', () => {
    const { db, dataDir, runs, sweeper } = harness()
    const job = runs.createJob({ kind: 'script', scriptId: 's1', deviceId: 'd1', params: {}, scriptName: 's1', scriptVersion: '1' })
    const oldRun = runs.addRun(job.id, { trigger: 'manual' })
    ageRun(db, oldRun.id, 40)
    const latestRun = runs.addRun(job.id, { trigger: 'manual' })
    ageRun(db, latestRun.id, 1)

    const oldDir = join(dataDir, 'traces', oldRun.id)
    const latestDir = join(dataDir, 'traces', latestRun.id)
    mkdirSync(oldDir, { recursive: true })
    mkdirSync(latestDir, { recursive: true })

    const result = sweeper.sweepOnce()
    expect(result.tracesDeleted).toBe(1)
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(latestDir)).toBe(true)
  })
})
