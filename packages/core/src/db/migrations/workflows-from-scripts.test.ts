import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo } from '../index'
import { jobs, schedules, scripts, workflows } from '../schema'
import { createLogger, type Logger } from '../../util/logger'
import { migrateWorkflowsFromScripts, WORKFLOWS_TABLE_TAG } from './workflows-from-scripts'

/**
 * Seeds a `scripts` row at the shape it had strictly before
 * `WORKFLOWS_TABLE_TAG` — `kind` still exists as a real column then, and the
 * live `scripts` Drizzle object (from the CURRENT `schema.ts`) no longer
 * declares it, so this goes in via raw SQL, exactly like
 * `backfill-schedule-refs.test.ts`'s own precedent for the identical
 * "column existed then, does not exist in the live builder now" situation.
 */
function seedPreMigrationScript(
  db: ReturnType<typeof openDb>['db'],
  opts: { id: string; name: string; version: string; kind: 'script' | 'workflow'; bundle: string; pluginId?: string; exportId?: string; createdBy?: string },
) {
  db.run(
    sql`INSERT INTO scripts (id, name, version, kind, bundle, enabled, created_at, plugin_id, export_id, created_by)
        VALUES (${opts.id}, ${opts.name}, ${opts.version}, ${opts.kind}, ${opts.bundle}, 1, 1700000000, ${opts.pluginId ?? null}, ${opts.exportId ?? null}, ${opts.createdBy ?? null})`,
  )
}

function workflowDocJson(name: string, version: string): string {
  return JSON.stringify({
    schema: 1,
    name,
    version,
    title: '',
    description: '',
    params: [],
    maxSteps: 50,
    nodes: [{ kind: 'script', id: 'n0', title: '', script: 'tiktok/login@1.0.0', params: {}, onFailure: { go: 'fail' } }],
  })
}

function collectLogs(): { log: Logger; infos: string[]; warns: string[] } {
  const infos: string[] = []
  const warns: string[] = []
  const log: Logger = { debug: () => {}, info: (m) => infos.push(m), warn: (m) => warns.push(m), error: () => {}, child: () => log }
  return { log, infos, warns }
}

describe('migrateWorkflowsFromScripts (plan 210 §4.6, §5 step 210.9)', () => {
  test('newest version wins, older versions are dropped, an owned member and an unowned ESM row are untouched, and jobs/schedules pinned to the dropped rows are named', () => {
    const opened = openDb(':memory:')
    runMigrationsUpTo(opened.db, WORKFLOWS_TABLE_TAG)
    const db = opened.db

    seedPreMigrationScript(db, { id: 'wf-checkout-100', name: 'checkout', version: '1.0.0', kind: 'workflow', bundle: workflowDocJson('checkout', '1.0.0') })
    seedPreMigrationScript(db, { id: 'wf-checkout-110', name: 'checkout', version: '1.1.0', kind: 'workflow', bundle: workflowDocJson('checkout', '1.1.0') })
    seedPreMigrationScript(db, { id: 's-tiktok-login', name: 'tiktok/login', version: '1.0.0', kind: 'script', bundle: 'export {}', pluginId: 'p1', exportId: 'login' })
    seedPreMigrationScript(db, { id: 's-old-unowned', name: 'old', version: '1.0.0', kind: 'script', bundle: 'export {}' })

    // A job pinned to the OLDER (dropped) workflow row, and a schedule naming
    // `checkout@latest` — both named by the migration's own report/log.
    db.run(
      sql`INSERT INTO jobs (id, script_id, device_id, status, created_at) VALUES ('job-1', 'wf-checkout-100', 'd1', 'queued', 1700000000)`,
    )
    db.run(
      sql`INSERT INTO schedules (id, name, enabled, cron, timezone, script_ref, created_at)
          VALUES ('sched-1', 'nightly-checkout', 1, '0 * * * *', 'UTC', 'checkout@latest', 1700000000)`,
    )

    runMigrations(db, opened.sqlite)

    const { log, infos, warns } = collectLogs()
    const report = migrateWorkflowsFromScripts(db, { log })
    expect(report).not.toBeNull()
    expect(report?.migrated).toEqual(['checkout'])
    expect(report?.droppedVersions).toEqual(['checkout@1.0.0'])
    expect(report?.jobsPinnedToDropped).toBe(1)
    expect(report?.schedulesNamingWorkflow).toEqual(['nightly-checkout'])

    // Exactly one `workflows` row, holding the NEWEST document, with no `version` key.
    const rows = db.select().from(workflows).where(eq(workflows.name, 'checkout')).all()
    expect(rows).toHaveLength(1)
    const doc = rows[0]!.doc as { name: string; nodes: { script: string }[]; version?: string }
    expect(doc.nodes[0]?.script).toBe('tiktok/login@1.0.0')
    expect('version' in doc).toBe(false)

    // Zero `scripts` rows named `checkout` — both versions are gone.
    expect(db.select().from(scripts).where(eq(scripts.name, 'checkout')).all()).toHaveLength(0)

    // The owned member and the unowned ESM row are untouched.
    expect(db.select().from(scripts).where(eq(scripts.id, 's-tiktok-login')).all()).toHaveLength(1)
    expect(db.select().from(scripts).where(eq(scripts.id, 's-old-unowned')).all()).toHaveLength(1)

    expect(infos.some((m) => m.includes('checkout@1.0.0'))).toBe(true)
    expect(warns.some((m) => m.includes('job(s)'))).toBe(true)
    expect(warns.some((m) => m.includes('nightly-checkout'))).toBe(true)

    // A second run is a no-op (the marker guards it).
    expect(migrateWorkflowsFromScripts(db, { log })).toBeNull()
  })
})
