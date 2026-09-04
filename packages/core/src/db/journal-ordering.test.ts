import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The Drizzle journal's own invariants.
 *
 * Drizzle does NOT decide what is still pending by file order. It reads the
 * highest `created_at` already in `__drizzle_migrations` ONCE, then applies
 * every journal entry whose `when` is greater. So a journal whose `when`
 * values go DOWN anywhere hides every entry below that dip from any database
 * that already sits at the peak — silently, with no error and no log line.
 * A fresh install is unaffected (its watermark is empty), which is exactly
 * what makes the defect invisible until an upgrade in the field.
 *
 * This is not hypothetical: renumbering `0066_groups_rename` to `0067` at the
 * wave-3 gate (two plans generated the same index) moved a migration written
 * 18 minutes EARLIER to a later slot, and any database already carrying
 * `0066_desired_awake` would have skipped the `clusters` -> `groups` rename
 * for good, then failed with "no such table: groups".
 *
 * If you renumber a migration, move its `when` too.
 */
const DRIZZLE = join(import.meta.dir, '..', '..', 'drizzle')

type Entry = { idx: number; when: number; tag: string }

function journal(): Entry[] {
  return (JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: Entry[] }).entries
}

describe('the Drizzle journal', () => {
  test('`when` increases strictly, entry by entry — a dip hides every later migration from an upgrade', () => {
    const entries = journal()
    expect(entries.length).toBeGreaterThan(50)
    const dips = entries
      .map((e, i) => (i > 0 && e.when <= (entries[i - 1] as Entry).when ? `${(entries[i - 1] as Entry).tag} -> ${e.tag}` : null))
      .filter((x): x is string => x !== null)
    expect(dips).toEqual([])
  })

  test('`idx` matches the entry order, and every tag has its .sql file on disk', () => {
    const entries = journal()
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i))
    expect(entries.filter((e) => !existsSync(join(DRIZZLE, `${e.tag}.sql`))).map((e) => e.tag)).toEqual([])
  })
})
