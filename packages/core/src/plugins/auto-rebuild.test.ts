import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { createKvStore } from '../kv/store'
import { createScriptRegistry } from '../scripts/registry'
import { createWorkspaceStore } from '../workspace/store'
import type { Logger } from '../util/logger'
import type { VerifyReport } from './verify-child'
import { createDevSlotStore } from './dev-slots'
import { createPluginRuntime } from './runtime'
import { withAutoRebuild } from './auto-rebuild'

/**
 * Plan 82 §3.5's own "no file watcher" design: a workspace WRITE is what
 * signals a dev plugin to rebuild, not polling. `PluginRuntime.putDevSlot`
 * already did the building-on-demand half (tested in `runtime.test.ts`
 * against a real `WorkspaceStore`); this file is the missing automatic
 * re-trigger the plan's own status header recorded as not wired.
 */

const QUOTAS = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 }
const enc = (s: string) => new TextEncoder().encode(s)

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function healthyReport(overrides: Partial<VerifyReport> = {}): VerifyReport {
  return { ok: true, pluginId: 'tiktok', version: '1.0.0', scripts: [{ id: 'login', paramsSchema: { type: 'object' } }], resetPackages: [], ...overrides }
}

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db: Db = opened.db
  const dataDir = `/tmp/enkaku-auto-rebuild-test-${crypto.randomUUID()}`
  const workspace = createWorkspaceStore(db, () => QUOTAS)
  const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65536, maxKeyLength: 256, maxEntriesPerNamespace: 1000, maxEntriesPerDevice: 5000 }))
  const devSlots = createDevSlotStore()
  const registry = createScriptRegistry({ db, dataDir, devSlots })
  const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots, verify: async () => healthyReport() })
  return { db, workspace, devSlots, runtime }
}

describe('withAutoRebuild — a workspace write under a dev slot\'s own directory rebuilds it automatically', () => {
  test('editing a shared helper (not the entry itself) triggers a rebuild, with no explicit /api/plugins/dev call', async () => {
    const { workspace, devSlots, runtime } = setUp()
    workspace.write('/scripts/tiktok/lib/helper.ts', { content: enc(`export const greet = (n: string) => 'hi ' + n`), actor: null })
    workspace.write('/scripts/tiktok/index.ts', {
      content: enc(`import { greet } from './lib/helper.ts'\nexport default { id: 'tiktok', version: '1.0.0', scripts: [] }`),
      actor: null,
    })

    // Front-end A's initial build-on-demand (already tested elsewhere) — establishes the slot.
    const first = await runtime.putDevSlot({
      name: 'tiktok',
      owner: { kind: 'workspace', label: '/scripts/tiktok/index.ts' },
      source: { kind: 'workspace', entryPath: '/scripts/tiktok/index.ts', workspace },
    })
    expect(first.ok).toBe(true)
    const beforeBuildN = devSlots.get('tiktok')?.buildN
    expect(beforeBuildN).toBe(1)

    const wrapped = withAutoRebuild(workspace, { devSlots, runtime, log: silentLog() })

    // Edit the SHARED HELPER, not the entry file itself, through the WRAPPED
    // store — no second call to `putDevSlot`/`POST /api/plugins/dev` anywhere here.
    wrapped.write('/scripts/tiktok/lib/helper.ts', { content: enc(`export const greet = (n: string) => 'hello ' + n`), ifMatch: workspace.read('/scripts/tiktok/lib/helper.ts').hash, actor: null })

    // The rebuild is fired asynchronously (best-effort) — wait for it to land.
    await Bun.sleep(50)
    const after = devSlots.get('tiktok')
    expect(after?.buildN).toBe((beforeBuildN ?? 0) + 1)
    expect(after?.lastBuildOk).toBe(true)
  })

  test('a write OUTSIDE the dev slot\'s own directory does not trigger a rebuild', async () => {
    const { workspace, devSlots, runtime } = setUp()
    workspace.write('/scripts/tiktok/index.ts', { content: enc(`export default { id: 'tiktok', version: '1.0.0', scripts: [] }`), actor: null })
    await runtime.putDevSlot({
      name: 'tiktok',
      owner: { kind: 'workspace', label: '/scripts/tiktok/index.ts' },
      source: { kind: 'workspace', entryPath: '/scripts/tiktok/index.ts', workspace },
    })
    const beforeBuildN = devSlots.get('tiktok')?.buildN

    const wrapped = withAutoRebuild(workspace, { devSlots, runtime, log: silentLog() })
    wrapped.write('/scripts/unrelated/other.ts', { content: enc(`export default 1`), actor: null })

    await Bun.sleep(50)
    expect(devSlots.get('tiktok')?.buildN).toBe(beforeBuildN)
  })

  test('no dev slot at all — a workspace write is a plain no-op as far as rebuilding goes', () => {
    const { workspace, devSlots, runtime } = setUp()
    const wrapped = withAutoRebuild(workspace, { devSlots, runtime, log: silentLog() })
    expect(() => wrapped.write('/scripts/anything.ts', { content: enc('export default 1'), actor: null })).not.toThrow()
    expect(devSlots.list()).toEqual([])
  })
})
