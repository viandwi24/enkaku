import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { reconcileParams, summarizeApply, type JsonSchemaNode } from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { createScheduleRoutes } from '../api/schedules'
import { openDb, runMigrations, type Db } from '../db'
import { devices, schedules, scripts } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import { createParamSet, updateParamSet } from './param-sets'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function publish(db: Db, name: string, version: string, paramsSchema: unknown): string {
  const id = `${name}-${version}`
  db.insert(scripts)
    .values({ id, name, version, bundle: 'export {}', enabled: true, paramsSchema, createdAt: new Date() })
    .run()
  return id
}

/**
 * These two describe blocks pin the plan's own "verifiable result" for step
 * 95.8, each read straight off `docs/plans/95-m60-script-parameter-schema-and-forms.md`
 * §5 step 95.8: "a set saved against `1.0.0` applies cleanly to `1.1.0`,
 * reporting exactly what changed" and "a schedule built from a set keeps
 * running its own copy after the set is edited."
 */
describe('a named parameter set survives its script being republished (plan 95 §4.4, §4.7, §5 step 95.8)', () => {
  test("saved against 1.0.0, applied against 1.1.0: kept fields kept, a tightened bound resets to its new default, a removed field drops — and the report names EXACTLY that", () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0', {
      type: 'object',
      properties: {
        videos: { type: 'integer' },
        chance: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        legacyFlag: { type: 'boolean' },
      },
    })

    // Saved while 1.0.0 was current — every value is valid against 1.0.0's own schema.
    const preset = createParamSet(db, {
      scriptName: 'checkout',
      name: 'Aggressive',
      params: { videos: 500, chance: 0.9, legacyFlag: true },
      createdBy: 'u1',
    })

    // 1.1.0 tightens `chance`'s own domain and drops `legacyFlag` outright — the two
    // ways H3 (plan 95 §0.3) says a schema most often evolves.
    publish(db, 'checkout', '1.1.0', {
      type: 'object',
      properties: {
        videos: { type: 'integer' },
        chance: { type: 'number', minimum: 0, maximum: 0.5, default: 0.5 },
      },
    })
    const v110 = db.select().from(scripts).where(eq(scripts.name, 'checkout')).all().find((r) => r.version === '1.1.0')!

    const result = reconcileParams(v110.paramsSchema as JsonSchemaNode | null, preset.params)
    expect(result.blocking).toBe(false)
    expect(result.value).toEqual({ videos: 500, chance: 0.5 })
    expect(result.findings).toEqual([
      { path: 'chance', kind: 'reset', detail: 'no longer satisfies the current schema — reset to its default' },
      { path: 'legacyFlag', kind: 'removed', detail: 'the current schema no longer declares this parameter' },
    ])

    // The plan's own worked example, verbatim (§5 step 95.8's checklist item).
    expect(summarizeApply(preset.name, result.findings)).toBe("Applied 'Aggressive' — 1 setting reset to its new default, 1 no longer exists.")
  })

  test('a set that still matches every field of a new version applies with the "nothing needed to change" report, not silence', () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0', { type: 'object', properties: { videos: { type: 'integer' } } })
    const preset = createParamSet(db, { scriptName: 'checkout', name: 'Steady', params: { videos: 20 }, createdBy: null })

    // 1.1.0 changes nothing about `videos` — a same-shape republish (a bundle fix, say).
    publish(db, 'checkout', '1.1.0', { type: 'object', properties: { videos: { type: 'integer' } } })
    const v110 = db.select().from(scripts).where(eq(scripts.name, 'checkout')).all().find((r) => r.version === '1.1.0')!

    const result = reconcileParams(v110.paramsSchema as JsonSchemaNode | null, preset.params)
    expect(result.findings).toEqual([])
    expect(summarizeApply(preset.name, result.findings)).toBe("Applied 'Steady' — every setting still matches this version.")
  })
})

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

describe('a schedule built from a preset keeps running its own copy after the preset is edited (plan 95 §5 step 95.8 — the test that would fail if a REFERENCE were stored instead)', () => {
  test("create the schedule with the preset's params copied in, then edit the preset: the schedule's stored params are untouched", async () => {
    const db = setUp()
    publish(db, 'checkout', '1.0.0', { type: 'object', properties: { videos: { type: 'integer' } } })
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'idle' }).run()

    const preset = createParamSet(db, { scriptName: 'checkout', name: 'Aggressive', params: { videos: 500 }, createdBy: 'u1' })

    const audit = createAuditLogger(db)
    const registry = new ExecutorRegistry()
    registry.setFallback({ validateParams: (p) => p, run: async () => undefined })
    const app = withUser(
      'operator',
      createScheduleRoutes({
        db,
        jobStore: {} as never,
        scheduler: { kick: () => {}, start: () => {}, stop: () => {} },
        audit,
        log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as never,
        runner: { start: () => {}, stop: () => {}, reload: () => {}, nextFires: () => new Map() },
        registry,
        findScript: () => ({ enabled: true }),
        scriptNames: () => new Map(),
        onJobStatus: () => {},
        broadcastBatchStatus: () => {},
        broadcastFired: () => {},
      }),
    )

    // Exactly what `ScheduleEditorDialog` does: `ParamSetPicker.apply()` hands
    // back the RECONCILED value, which becomes `params` on the create body —
    // a plain copy, never `{ paramSetId: preset.id }`.
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Nightly',
        cron: '0 2 * * *',
        timezone: 'UTC',
        scriptRef: 'checkout@1.0.0',
        params: preset.params,
        target: { deviceIds: ['d1'] },
      }),
    })
    expect(createRes.status).toBe(201)
    const { schedule } = (await createRes.json()) as { schedule: { id: string } }

    // Someone edits the preset afterwards.
    updateParamSet(db, 'checkout', preset.id, { params: { videos: 999 } })

    // The schedule row itself — read straight from the table, not through any
    // route that could recompute it — must still hold the ORIGINAL value.
    // If a `paramSetId` reference had been stored instead of a copy, this is
    // exactly the assertion that would now fail.
    const row = db.select().from(schedules).where(eq(schedules.id, schedule.id)).get()
    expect(row?.params).toEqual({ videos: 500 })
  })
})
