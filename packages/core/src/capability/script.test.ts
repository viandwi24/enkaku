import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { plugins, scripts } from '../db/schema'
import { createWorkspaceStore, type WorkspaceStore } from '../workspace/store'
import { buildScriptService, type CapabilityContext } from './context'
import { invoke } from './invoke'
import { scriptPublish } from './script'

// `invoke()` returns `output: unknown` (it takes an `AnyCoreCapability` with
// its I/O generics erased) — this is the one place that trusts
// `script.publish`'s own declared output shape.
interface PublishOutput {
  id: string
  name: string
  version: string
}

/**
 * `script.publish`'s `{ path }` form (plan 64 §3.5, §4.4, §4.7, acceptance
 * #7, #8) — publishing from a workspace path must go through the SAME
 * `scripts/service.ts` function as a `{ bundle }` publish, so the two
 * cannot disagree about what "publishing" means.
 */

const QUOTAS = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 }

function setUp(): { db: Db; workspace: WorkspaceStore } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return { db: opened.db, workspace: createWorkspaceStore(opened.db, () => QUOTAS) }
}

function fakeCtx(db: Db, workspace: WorkspaceStore): CapabilityContext {
  return {
    actor: { id: 'u1', role: 'operator' },
    currentRunId: null,
    agentTree: null,
    hasPermission: () => true,
    canReachDevice: () => true,
    controlLeaseBlockedBy: () => null,
    isDeviceOnline: () => true,
    ensureAwake: async () => {},
    deviceCall: async () => undefined,
    readiness: null,
    listDevices: () => [],
    getDevice: () => null,
    jobService: {} as CapabilityContext['jobService'],
    // The REAL service (plan 110 §5 step 110.3) — a fixture that re-implemented
    // `publish` would not be publishing what the daemon publishes.
    scripts: buildScriptService(db),
    resolveScriptRef: () => ({ id: 'unused' }),
    workspace,
    workspaceScope: () => ({ read: ['/'], write: ['/'] }),
  }
}

const enc = (s: string) => new TextEncoder().encode(s)

// Plan 110 §4.2 — an entry is a plugin; there is no `defineScript` to author
// a plugin-less one with. Published below as `demo/hello-workspace`, so the
// name on the row and the member id inside the bundle agree.
const HELLO_SOURCE = `
import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

export default definePlugin({
  id: 'demo',
  version: '1.0.0',
  scripts: [
    {
      id: 'hello-workspace',
      params: z.object({ message: z.string().default('hi') }),
      async run(ctx) {
        ctx.log.info('ran: ' + ctx.params.message)
        return { echoed: ctx.params.message }
      },
    },
  ],
})
`

describe('script.publish { bundle } form (baseline)', () => {
  test('publishes via ctx.scripts.publish exactly as before plan 64', async () => {
    const { db, workspace } = setUp()
    const ctx = fakeCtx(db, workspace)
    const result = await invoke(scriptPublish, ctx, { name: 'demo/a', version: '1.0.0', bundle: 'export default 1', source: 'export default 1' })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.output as PublishOutput).name).toBe('demo/a')
  })
})

/**
 * Plan 110 §3.2, §5 step 110.3 — `script.publish` is what the AI agent and MCP
 * call, so the owning-plugin rule has to be visible in its INPUT SCHEMA (a
 * model reads that before it writes anything) as well as enforced by the
 * writer underneath it.
 */
describe('script.publish publishes a plugin (plan 110 §3.2, step 110.3)', () => {
  test('a bare, plugin-less name is refused by the input schema, naming the rule and the wrapper', async () => {
    const { db, workspace } = setUp()
    const ctx = fakeCtx(db, workspace)
    const result = await invoke(scriptPublish, ctx, { name: 'no-plugin', version: '1.0.0', bundle: 'export default 1' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toContain('a script cannot exist outside a plugin')
      expect(result.error.message).toContain('definePlugin')
    }
    expect(db.select().from(scripts).all()).toHaveLength(0)
    expect(db.select().from(plugins).all()).toHaveLength(0)
  })

  test('the published row is a MEMBER: it names its owning plugin row and its export id', async () => {
    const { db, workspace } = setUp()
    const ctx = fakeCtx(db, workspace)
    const result = await invoke(scriptPublish, ctx, { name: 'demo/checkout', version: '1.2.0', bundle: 'export default 1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = db.select().from(scripts).where(eq(scripts.id, (result.output as PublishOutput).id)).get()
    const owner = db.select().from(plugins).where(eq(plugins.name, 'demo')).get()
    expect(owner?.version).toBe('1.2.0')
    expect(owner?.status).toBe('active')
    expect(row?.pluginId).toBe(owner?.id as string)
    expect(row?.exportId).toBe('checkout')
  })

  test('a second member of the same plugin version joins the SAME owner row', async () => {
    const { db, workspace } = setUp()
    const ctx = fakeCtx(db, workspace)
    await invoke(scriptPublish, ctx, { name: 'demo/one', version: '1.0.0', bundle: 'export default 1' })
    await invoke(scriptPublish, ctx, { name: 'demo/two', version: '1.0.0', bundle: 'export default 1' })
    expect(db.select().from(plugins).where(eq(plugins.name, 'demo')).all()).toHaveLength(1)
  })

  test('a new version supersedes the previous owner row, so <plugin>/<script>@latest keeps meaning the active one', async () => {
    const { db, workspace } = setUp()
    const ctx = fakeCtx(db, workspace)
    await invoke(scriptPublish, ctx, { name: 'demo/one', version: '1.0.0', bundle: 'export default 1' })
    await invoke(scriptPublish, ctx, { name: 'demo/one', version: '1.1.0', bundle: 'export default 1' })
    const rows = db.select().from(plugins).where(eq(plugins.name, 'demo')).all()
    expect(rows.map((r) => `${r.version}:${r.status}`).sort()).toEqual(['1.0.0:superseded', '1.1.0:active'])
  })

  test('the reserved `recordings` owner cannot be published into from here', async () => {
    const { db, workspace } = setUp()
    const ctx = fakeCtx(db, workspace)
    const result = await invoke(scriptPublish, ctx, { name: 'recordings/sneaky', version: '1.0.0', bundle: 'export default 1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_PLUGIN_RESERVED_NAME')
    expect(db.select().from(scripts).all()).toHaveLength(0)
  })

  test('a plugin published as a VERIFIED package refuses a member bolted on from here', async () => {
    const { db, workspace } = setUp()
    db.insert(plugins)
      .values({
        id: 'p-real',
        name: 'tiktok',
        version: '1.0.0',
        bundle: 'export default {}',
        bundleHash: 'h',
        status: 'active',
        verifiedAt: new Date(),
        manifest: { scripts: [] },
        createdAt: new Date(),
      })
      .run()
    const ctx = fakeCtx(db, workspace)
    const result = await invoke(scriptPublish, ctx, { name: 'tiktok/hijack', version: '2.0.0', bundle: 'export default 1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_PLUGIN_VERIFIED_OWNER')
    // The verified plugin is untouched — no superseding, no new version row.
    expect(db.select().from(plugins).where(eq(plugins.name, 'tiktok')).all()).toHaveLength(1)
    expect(db.select().from(scripts).all()).toHaveLength(0)
  })
})

describe('script.publish { path } form (plan 64 §3.5, §4.4, acceptance #7)', () => {
  test('acceptance #7: produces a script identical in shape to a { bundle } publish — same service function, a real runnable bundle', async () => {
    const { db, workspace } = setUp()
    workspace.write('/scripts/hello.ts', { content: enc(HELLO_SOURCE), contentType: 'text/typescript', actor: 'user:u1' })
    const ctx = fakeCtx(db, workspace)

    const result = await invoke(scriptPublish, ctx, { name: 'demo/hello-workspace', version: '1.0.0', path: '/scripts/hello.ts' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.output as PublishOutput
    expect(output.name).toBe('demo/hello-workspace')
    expect(output.version).toBe('1.0.0')

    const row = db.select().from(scripts).where(eq(scripts.id, output.id)).get()
    expect(row).toBeTruthy()
    expect(row?.source).toContain('definePlugin')
    expect(row?.bundle.length ?? 0).toBeGreaterThan(0)
    expect(row?.exportId).toBe('hello-workspace')

    // The published bundle is genuinely runnable — the same shape
    // `enkaku publish` produces and the runner already knows how to load
    // (`scripts/bundle-cache.ts` materialises `row.bundle` to a temp file
    // and `import()`s it exactly like this), and the member `export_id`
    // names is the one inside it (plan 110 §3.2).
    const dir = mkdtempSync(join(tmpdir(), 'enkaku-script-publish-test-'))
    try {
      const outfile = join(dir, 'bundle.mjs')
      await Bun.write(outfile, row?.bundle ?? '')
      const mod = (await import(outfile)) as { default?: { id: string; version: string; scripts: { id: string; version: string; run: (ctx: unknown) => unknown }[] } }
      expect(mod.default?.id).toBe('demo')
      expect(mod.default?.version).toBe('1.0.0')
      const member = mod.default?.scripts.find((s) => s.id === row?.exportId)
      expect(typeof member?.run).toBe('function')
      const logs: string[] = []
      const ran = await member?.run({ params: { message: 'world' }, log: { info: (m: string) => logs.push(m) } })
      expect(ran).toEqual({ echoed: 'world' })
      expect(logs).toEqual(['ran: world'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('acceptance #8: a disallowed import fails the build naming it, and publishes no script row', async () => {
    const { db, workspace } = setUp()
    workspace.write('/scripts/evil.ts', { content: enc(`import fs from 'node:fs'\nexport default fs.readFileSync`), actor: null })
    const ctx = fakeCtx(db, workspace)

    const before = db.select().from(scripts).all().length
    const result = await invoke(scriptPublish, ctx, { name: 'demo/evil', version: '1.0.0', path: '/scripts/evil.ts' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('E_BUILD_FAILED')
      expect(result.error.message).toContain('node:fs')
    }
    const after = db.select().from(scripts).all().length
    expect(after).toBe(before)
  })

  test('a missing workspace path fails E_NOT_FOUND and publishes nothing', async () => {
    const { db, workspace } = setUp()
    const ctx = fakeCtx(db, workspace)
    const result = await invoke(scriptPublish, ctx, { name: 'demo/nope', version: '1.0.0', path: '/scripts/nope.ts' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_NOT_FOUND')
    expect(db.select().from(scripts).all().length).toBe(0)
  })
})
