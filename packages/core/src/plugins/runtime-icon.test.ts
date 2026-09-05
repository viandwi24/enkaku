import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { createKvStore } from '../kv/store'
import { createScriptRegistry } from '../scripts/registry'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime, type PluginRuntime } from './runtime'
import type { VerifyReport } from './verify-child'

/**
 * Plan 310 §3.3, §4.1 — the PLUGIN's own icon (`plugins.icon`, alongside the
 * pre-existing `title`/`description` columns) survives a real stage →
 * verify → activate round trip, and is what `runtime.list()` hands `GET
 * /api/plugins` (`PluginListItem.icon`). A real `Db` and a real
 * `PluginRuntime`, on the same reasoning `workflows/registry.test.ts` and
 * `surface-registry.test.ts` give: this is a claim about what survives the
 * `plugins` table round trip, not observable against a stub.
 */

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'enkaku-runtime-icon-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function setUp(): { runtime: PluginRuntime; setIcon(icon: string | undefined): void } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const devSlots = createDevSlotStore()
  const registry = createScriptRegistry({ db, dataDir, devSlots })
  let icon: string | undefined
  const verify = async (_bundlePath: string, opts?: { expectedVersion?: string }): Promise<VerifyReport> => ({
    ok: true,
    version: opts?.expectedVersion ?? '1.0.0',
    ...(icon !== undefined ? { icon: icon as VerifyReport['icon'] } : {}),
    scripts: [],
    resetPackages: [],
  })
  const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots, verify })
  return {
    runtime,
    setIcon(next) {
      icon = next
    },
  }
}

async function publishAndActivate(runtime: PluginRuntime, name: string, version: string): Promise<void> {
  const staged = await runtime.stage({ name, version, bundle: 'export {}' })
  await runtime.verify(staged.id)
  runtime.activate(staged.id)
}

describe('a plugin icon survives stage → verify → activate → list (plan 310 §3.3, §4.1)', () => {
  test('a plugin declaring an icon lists with it', async () => {
    const h = setUp()
    h.setIcon('puzzle')
    await publishAndActivate(h.runtime, 'tiktok', '1.0.0')
    const row = h.runtime.list({ name: 'tiktok' }).find((r) => r.version === '1.0.0')
    expect(row?.icon).toBe('puzzle')
  })

  test('a plugin declaring none lists `null`, not `undefined` or a throw', async () => {
    const h = setUp()
    await publishAndActivate(h.runtime, 'tiktok', '1.0.0')
    const row = h.runtime.list({ name: 'tiktok' }).find((r) => r.version === '1.0.0')
    expect(row?.icon).toBeNull()
  })

  test('re-verifying the SAME staged row with no icon KEEPS the icon an earlier verify reported — the same "sticky" rule `title`/`description` already follow', async () => {
    const h = setUp()
    h.setIcon('puzzle')
    const staged = await h.runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: 'export {}' })
    await h.runtime.verify(staged.id)

    h.setIcon(undefined)
    await h.runtime.verify(staged.id)
    h.runtime.activate(staged.id)

    const row = h.runtime.list({ name: 'tiktok' }).find((r) => r.version === '1.0.0')
    expect(row?.icon).toBe('puzzle')
  })

  test('a NEW version starts from its own report, never inheriting a prior version\'s icon', async () => {
    const h = setUp()
    h.setIcon('puzzle')
    await publishAndActivate(h.runtime, 'tiktok', '1.0.0')

    h.setIcon(undefined)
    await publishAndActivate(h.runtime, 'tiktok', '2.0.0')

    const row = h.runtime.list({ name: 'tiktok' }).find((r) => r.version === '2.0.0')
    expect(row?.icon).toBeNull()
  })
})
