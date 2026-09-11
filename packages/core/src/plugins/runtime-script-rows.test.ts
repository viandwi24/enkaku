import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { createKvStore } from '../kv/store'
import { createScriptRegistry } from '../scripts/registry'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime } from './runtime'
import type { VerifyReport } from './verify-child'

/**
 * Re-verifying a version must refresh what the verify child DERIVES.
 *
 * `writeScriptRows` used to `continue` past a row that already existed, so a
 * re-verify rewrote the plugin's manifest and left every script row holding the
 * schema from its first install. That made a core fix unreachable by any
 * installed plugin: when params began being emitted as the INPUT schema (a
 * defaulted param is not required), re-verifying `tiktok@1.27.0` produced the
 * corrected schema and the row kept refusing the Social Media Manager's router
 * with "pick: required…" regardless.
 */

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-script-rows-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function setUp(): { db: Db; runtime: ReturnType<typeof createPluginRuntime>; setRequired(required: string[]): void } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const devSlots = createDevSlotStore()
  const registry = createScriptRegistry({ db, dataDir, devSlots })
  let required = ['videoArtifactId', 'pick']
  const verify = async (_bundlePath: string, opts?: { expectedVersion?: string }): Promise<VerifyReport> => ({
    ok: true,
    version: opts?.expectedVersion ?? '1.0.0',
    scripts: [{ id: 'post', paramsSchema: { type: 'object', required, properties: {} }, runtime: null }],
    resetPackages: [],
  })
  const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots, verify })
  return {
    db,
    runtime,
    setRequired(next) {
      required = next
    },
  }
}

function requiredOf(db: Db): unknown {
  const row = db.select().from(scripts).where(eq(scripts.name, 'tiktok/post')).get()
  return (row?.paramsSchema as { required?: unknown } | undefined)?.required
}

describe('re-verify then re-activate refreshes the derived script fields', () => {
  test('the stored params schema follows the latest verify, not the first install', async () => {
    const h = setUp()
    const staged = await h.runtime.stage({ name: 'tiktok', version: '1.27.0', bundle: 'export {}' })
    await h.runtime.verify(staged.id)
    h.runtime.activate(staged.id)
    expect(requiredOf(h.db)).toEqual(['videoArtifactId', 'pick'])

    // The core now emits params as the input schema: the defaulted `pick` is
    // no longer required. Same version, same bundle — only the derivation moved.
    h.setRequired(['videoArtifactId'])
    await h.runtime.verify(staged.id)
    h.runtime.activate(staged.id)
    expect(requiredOf(h.db)).toEqual(['videoArtifactId'])
  })

  test('re-activating still writes exactly one row per script', async () => {
    const h = setUp()
    const staged = await h.runtime.stage({ name: 'tiktok', version: '1.27.0', bundle: 'export {}' })
    await h.runtime.verify(staged.id)
    h.runtime.activate(staged.id)
    await h.runtime.verify(staged.id)
    h.runtime.activate(staged.id)
    expect(h.db.select().from(scripts).where(eq(scripts.name, 'tiktok/post')).all()).toHaveLength(1)
  })
})
