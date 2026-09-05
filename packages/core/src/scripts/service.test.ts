import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { jobRuns, jobs, plugins, scripts } from '../db/schema'
import { isUnownedScriptRow, listActiveScripts } from './service'

/**
 * Plan 210 (MVP 03 §2): the only writer of a `scripts` row is
 * `plugins/runtime.ts`'s `writeScriptRows` — this file no longer tests a
 * publish path (there is none to test here any more; see
 * `plugins/runtime.test.ts` for the writer, `scripts/routes.test.ts` for the
 * active-only list). What is left is the rule a farm's already-existing rows
 * still have to obey: a row with no owning plugin is unowned and ignored.
 */

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

describe('isUnownedScriptRow (plan 210 §4.5)', () => {
  test('a row with no pluginId is unowned', () => {
    expect(isUnownedScriptRow({ pluginId: null })).toBe(true)
  })

  test('a row with a pluginId is owned', () => {
    expect(isUnownedScriptRow({ pluginId: 'p1' })).toBe(false)
  })
})

describe('rows a pre-existing farm already has, with no owning plugin, are ignored', () => {
  function insertUnowned(db: Db, name: string, version: string): string {
    const id = `${name}-${version}`
    db.insert(scripts).values({ id, name, version, bundle: 'export {}', enabled: true, createdAt: new Date() }).run()
    return id
  }

  test('an unowned row is still on disk — ignored, not deleted', () => {
    const db = setUp()
    insertUnowned(db, 'debug-node', '1.0.0')
    expect(db.select().from(scripts).where(eq(scripts.name, 'debug-node')).all()).toHaveLength(1)
    const row = db.select().from(scripts).where(eq(scripts.name, 'debug-node')).get()
    expect(row && isUnownedScriptRow(row)).toBe(true)
  })
})

/**
 * `listActiveScripts` against a REAL migrated database.
 *
 * This exists because the query it runs is a raw SQL string, and plan 211
 * §3.2 decision 9 moved `status` and `finished_at` off `jobs` and onto
 * `job_runs`. Every TypeScript call site was updated; this string was not,
 * and `GET /api/scripts` threw `no such column: j.status` on any farm that
 * had ever run a script — the Scripts page and the Run script dialog's list
 * both dead behind a 500 (field report, 2026-09-04). Nothing caught it:
 * typecheck cannot read inside a SQL string, and no test called this
 * function at all.
 *
 * The shape of the assertion matters more than its values: it must exercise
 * the JOIN against a migrated schema, so a future column move fails here
 * instead of in a browser.
 */
describe('listActiveScripts reads lastRun through job_runs (plan 211 §3.2 decision 9)', () => {
  function seed(db: Db): void {
    db.insert(plugins)
      .values({ id: 'p1', name: 'tiktok', version: '1.0.0', bundle: 'export {}', bundleHash: 'h', status: 'active', createdAt: new Date(1_700_000_000_000) })
      .run()
    db.insert(scripts)
      .values({ id: 's1', pluginId: 'p1', exportId: 'warmup', name: 'tiktok/warmup', version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date(1_700_000_000_000) })
      .run()
  }

  test('a script with no job at all lists with lastRun null — and does not throw', () => {
    const db = setUp()
    seed(db)
    const items = listActiveScripts(db)
    expect(items).toHaveLength(1)
    expect(items[0]?.lastRun).toBeNull()
  })

  test("a script whose job has a run reports that RUN's status and finishedAt, not the job's", () => {
    const db = setUp()
    seed(db)
    db.insert(jobs)
      .values({ id: 'j1', kind: 'script', scriptId: 's1', deviceId: 'd1', scriptName: 'tiktok/warmup', createdAt: new Date(1_700_000_100_000), latestRunId: 'r1' })
      .run()
    db.insert(jobRuns)
      .values({
        id: 'r1',
        jobId: 'j1',
        seq: 1,
        trigger: 'manual',
        status: 'success',
        deviceId: 'd1',
        scriptName: 'tiktok/warmup',
        createdAt: new Date(1_700_000_100_000),
        finishedAt: new Date(1_700_000_200_000),
      })
      .run()

    const items = listActiveScripts(db)
    expect(items[0]?.lastRun).toMatchObject({ jobId: 'j1', status: 'success', finishedAt: 1_700_000_200 })
  })
})

/**
 * Plan 310 §3.3, §4.1 — `title`/`description`/`icon` live in the ACTIVE
 * plugin's manifest (the `scripts` table has no columns for them, unlike
 * `paramsSchema`), so `listActiveScripts` must read them off `plugins.manifest`
 * and match by `exportId`, not by the row's own columns.
 */
describe('listActiveScripts reads title/description/icon off the manifest (plan 310 §3.3, §4.1)', () => {
  function seedWithManifest(db: Db): void {
    db.insert(plugins)
      .values({
        id: 'p1',
        name: 'tiktok',
        version: '1.0.0',
        bundle: 'export {}',
        bundleHash: 'h',
        status: 'active',
        createdAt: new Date(1_700_000_000_000),
        manifest: { scripts: [{ id: 'warmup', title: 'Warm up', description: 'Scrolls a bit.', icon: 'play' }] },
      })
      .run()
    db.insert(scripts)
      .values({ id: 's1', pluginId: 'p1', exportId: 'warmup', name: 'tiktok/warmup', version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date(1_700_000_000_000) })
      .run()
  }

  test('a member the manifest names comes back with its title, description and icon', () => {
    const db = setUp()
    seedWithManifest(db)
    const items = listActiveScripts(db)
    expect(items[0]).toMatchObject({ title: 'Warm up', description: 'Scrolls a bit.', icon: 'play' })
  })

  test('a member the manifest does not mention (or no manifest at all) comes back null on all three, never a throw', () => {
    const db = setUp()
    db.insert(plugins)
      .values({ id: 'p1', name: 'tiktok', version: '1.0.0', bundle: 'export {}', bundleHash: 'h', status: 'active', createdAt: new Date(1_700_000_000_000) })
      .run()
    db.insert(scripts)
      .values({ id: 's1', pluginId: 'p1', exportId: 'warmup', name: 'tiktok/warmup', version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date(1_700_000_000_000) })
      .run()
    const items = listActiveScripts(db)
    expect(items[0]).toMatchObject({ title: null, description: null, icon: null })
  })

  test('an icon outside `ICON_NAMES` in a stored manifest degrades to null rather than throwing', () => {
    const db = setUp()
    db.insert(plugins)
      .values({
        id: 'p1',
        name: 'tiktok',
        version: '1.0.0',
        bundle: 'export {}',
        bundleHash: 'h',
        status: 'active',
        createdAt: new Date(1_700_000_000_000),
        manifest: { scripts: [{ id: 'warmup', title: 'Warm up', icon: 'not-a-real-icon' }] },
      })
      .run()
    db.insert(scripts)
      .values({ id: 's1', pluginId: 'p1', exportId: 'warmup', name: 'tiktok/warmup', version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date(1_700_000_000_000) })
      .run()
    const items = listActiveScripts(db)
    expect(items[0]).toMatchObject({ title: 'Warm up', icon: null })
  })
})
