import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { openDb, runMigrations, runMigrationsUpTo, type Db } from '../index'
import { listLabels, labelsForDevice } from '../../registry/device-labels'
import { LABEL_COLORS } from '@enkaku/protocol'

/**
 * Migration `0080` retires free-form device tags for labels (plan 225 §3.1).
 * It is data-bearing, not just structural: every distinct tag becomes ONE
 * label of the same name and every membership is rewritten, so nothing an
 * operator typed is lost. Nothing else in the workspace can check that —
 * `device_tags` no longer has a schema object to read it back with — so this
 * test drives the raw table by hand at the version where it still existed.
 */
function migratedFarmWithTags(rows: Array<{ deviceId: string; tag: string; at: number }>): Db {
  const { db } = openDb(':memory:')
  runMigrationsUpTo(db, '0080_unusual_shadowcat')
  for (const r of rows) {
    db.run(sql`INSERT INTO device_tags (device_id, tag, at) VALUES (${r.deviceId}, ${r.tag}, ${r.at})`)
  }
  runMigrations(db)
  return db
}

describe('0080 — tags become labels', () => {
  test('every distinct tag becomes one label of the same name', () => {
    const db = migratedFarmWithTags([
      { deviceId: 'd1', tag: 'pool:smoke', at: 1_700_000_000 },
      { deviceId: 'd2', tag: 'pool:smoke', at: 1_700_000_100 },
      { deviceId: 'd1', tag: 'android:15', at: 1_700_000_200 },
    ])
    expect(listLabels(db).map((l) => l.name)).toEqual(['android:15', 'pool:smoke'])
  })

  test('memberships are rewritten, so a device keeps exactly the tags it carried', () => {
    const db = migratedFarmWithTags([
      { deviceId: 'd1', tag: 'pool:smoke', at: 1_700_000_000 },
      { deviceId: 'd1', tag: 'android:15', at: 1_700_000_100 },
      { deviceId: 'd2', tag: 'pool:smoke', at: 1_700_000_200 },
    ])
    expect(labelsForDevice(db, 'd1').map((l) => l.name)).toEqual(['android:15', 'pool:smoke'])
    expect(labelsForDevice(db, 'd2').map((l) => l.name)).toEqual(['pool:smoke'])
  })

  test('a migrated label carries a colour from the palette, not a blank column', () => {
    const db = migratedFarmWithTags([
      { deviceId: 'd1', tag: 'a', at: 1_700_000_000 },
      { deviceId: 'd1', tag: 'b', at: 1_700_000_000 },
      { deviceId: 'd1', tag: 'c', at: 1_700_000_000 },
    ])
    for (const label of listLabels(db)) expect(LABEL_COLORS).toContain(label.color)
  })

  test('the label is dated from the first time the tag was used, not from the migration', () => {
    const db = migratedFarmWithTags([
      { deviceId: 'd2', tag: 'pool:smoke', at: 1_700_000_500 },
      { deviceId: 'd1', tag: 'pool:smoke', at: 1_700_000_000 },
    ])
    expect(listLabels(db)[0]?.createdAt).toBe(1_700_000_000)
  })

  test('a farm that never used a tag migrates to no labels at all, not to an empty placeholder', () => {
    const db = migratedFarmWithTags([])
    expect(listLabels(db)).toEqual([])
  })

  test('the old table is gone once the migration has run', () => {
    const db = migratedFarmWithTags([{ deviceId: 'd1', tag: 'pool:smoke', at: 1_700_000_000 }])
    expect(() => db.run(sql`SELECT 1 FROM device_tags`)).toThrow()
  })
})
