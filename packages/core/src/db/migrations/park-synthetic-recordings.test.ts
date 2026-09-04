import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations } from '../index'
import { plugins, scripts } from '../schema'
import { createDevSlotStore } from '../../plugins/dev-slots'
import { createScriptRegistry } from '../../scripts/registry'
import { createLogger, type Logger } from '../../util/logger'
import { parkSyntheticRecordingsOwner } from './park-synthetic-recordings'

function collectLogs(): { log: Logger; infos: string[]; warns: string[] } {
  const infos: string[] = []
  const warns: string[] = []
  const log: Logger = { debug: () => {}, info: (m) => infos.push(m), warn: (m) => warns.push(m), error: () => {}, child: () => log }
  return { log, infos, warns }
}

/** The exact shape `plugins/owner.ts`'s old `resolveRecordingsOwner` wrote. */
function seedSyntheticOwner(db: ReturnType<typeof openDb>['db']) {
  db.insert(plugins)
    .values({
      id: 'p-recordings',
      name: 'recordings',
      version: '0.0.0',
      title: 'Recordings',
      description: 'Every recording published from the recorder. Created by the farm; not an installable plugin.',
      bundle: 'export default { id: "recordings", version: "0.0.0", scripts: [] }',
      source: null,
      bundleHash: 'deadbeef',
      status: 'active',
      verifiedAt: null,
      verifyError: null,
      verifyErrorCode: null,
      manifest: null,
      resetPackages: null,
      createdBy: null,
      createdAt: new Date(),
    })
    .run()
}

function seedMember(db: ReturnType<typeof openDb>['db'], opts: { id: string; name: string; version: string; pluginId: string; exportId: string }) {
  db.insert(scripts)
    .values({ id: opts.id, name: opts.name, version: opts.version, bundle: 'export {}', enabled: true, createdAt: new Date(), pluginId: opts.pluginId, exportId: opts.exportId })
    .run()
}

describe('parkSyntheticRecordingsOwner (plan 210 §4.6, §5 step 210.9)', () => {
  test('deletes the synthetic owner, unowns its members, leaves an unrelated plugin untouched, and warns naming both recordings', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db

    seedSyntheticOwner(db)
    seedMember(db, { id: 's-rec-1', name: 'recordings/checkout-flow', version: '1.0.0', pluginId: 'p-recordings', exportId: 'checkout-flow' })
    seedMember(db, { id: 's-rec-2', name: 'recordings/login-flow', version: '2.0.0', pluginId: 'p-recordings', exportId: 'login-flow' })

    db.insert(plugins)
      .values({
        id: 'p-real',
        name: 'demo',
        version: '1.0.0',
        title: null,
        description: null,
        bundle: 'export {}',
        source: null,
        bundleHash: 'h',
        status: 'active',
        verifiedAt: new Date(),
        verifyError: null,
        verifyErrorCode: null,
        manifest: { scripts: [{ id: 'checkout' }] },
        resetPackages: null,
        createdBy: null,
        createdAt: new Date(),
      })
      .run()
    seedMember(db, { id: 's-real', name: 'demo/checkout', version: '1.0.0', pluginId: 'p-real', exportId: 'checkout' })

    const { log } = collectLogs()
    const report = parkSyntheticRecordingsOwner(db, { log })
    expect(report).toEqual({ ranAt: expect.any(String), ownerFound: true, rowsUnowned: 2 })

    expect(db.select().from(plugins).where(eq(plugins.name, 'recordings')).all()).toHaveLength(0)

    const rec1 = db.select().from(scripts).where(eq(scripts.id, 's-rec-1')).get()
    const rec2 = db.select().from(scripts).where(eq(scripts.id, 's-rec-2')).get()
    expect(rec1?.pluginId).toBeNull()
    expect(rec1?.exportId).toBeNull()
    expect(rec2?.pluginId).toBeNull()
    expect(rec2?.exportId).toBeNull()

    const real = db.select().from(scripts).where(eq(scripts.id, 's-real')).get()
    expect(real?.pluginId).toBe('p-real')

    // A second run is a no-op (marker-guarded).
    expect(parkSyntheticRecordingsOwner(db, { log })).toBeNull()

    // The registry's own unowned-row warning names both parked rows.
    const warnings: string[] = []
    const warnLog: Logger = { debug: () => {}, info: () => {}, warn: (m) => warnings.push(m), error: () => {}, child: () => warnLog }
    createScriptRegistry({ db, dataDir: '/tmp', devSlots: createDevSlotStore(), log: warnLog })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('recordings/checkout-flow@1.0.0')
    expect(warnings[0]).toContain('recordings/login-flow@2.0.0')
  })

  test('no owner present logs nothing and returns ownerFound: false', () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const db = opened.db
    const { log, infos, warns } = collectLogs()
    const report = parkSyntheticRecordingsOwner(db, { log })
    expect(report).toEqual({ ranAt: expect.any(String), ownerFound: false, rowsUnowned: 0 })
    expect(infos).toHaveLength(0)
    expect(warns).toHaveLength(0)
    // The marker is still recorded, so a second run is still a no-op.
    expect(parkSyntheticRecordingsOwner(db, { log })).toBeNull()
  })
})
