import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { getScriptDetail, listScriptGroups, publishScript } from '../scripts/service'
import { EnkakuError } from '../util/errors'
import { createWorkspaceStore, type WorkspaceStore } from '../workspace/store'
import type { CapabilityContext } from './context'
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
    scripts: {
      listGroups: () => listScriptGroups(db),
      get: (id) => getScriptDetail(db, id),
      publish: (input) => publishScript(db, input),
    },
    resolveScriptRef: () => ({ id: 'unused' }),
    workspace,
    workspaceScope: () => ({ read: ['/'], write: ['/'] }),
  }
}

const enc = (s: string) => new TextEncoder().encode(s)

const HELLO_SOURCE = `
import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

export default defineScript({
  id: 'hello-workspace',
  version: '1.0.0',
  params: z.object({ message: z.string().default('hi') }),
  async run(ctx) {
    ctx.log.info('ran: ' + ctx.params.message)
    return { echoed: ctx.params.message }
  },
})
`

describe('script.publish { bundle } form (baseline)', () => {
  test('publishes via ctx.scripts.publish exactly as before plan 64', async () => {
    const { db, workspace } = setUp()
    const ctx = fakeCtx(db, workspace)
    const result = await invoke(scriptPublish, ctx, { name: 'a', version: '1.0.0', bundle: 'export default 1', source: 'export default 1' })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.output as PublishOutput).name).toBe('a')
  })
})

describe('script.publish { path } form (plan 64 §3.5, §4.4, acceptance #7)', () => {
  test('acceptance #7: produces a script identical in shape to a { bundle } publish — same service function, a real runnable bundle', async () => {
    const { db, workspace } = setUp()
    workspace.write('/scripts/hello.ts', { content: enc(HELLO_SOURCE), contentType: 'text/typescript', actor: 'user:u1' })
    const ctx = fakeCtx(db, workspace)

    const result = await invoke(scriptPublish, ctx, { name: 'hello-workspace', version: '1.0.0', path: '/scripts/hello.ts' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.output as PublishOutput
    expect(output.name).toBe('hello-workspace')
    expect(output.version).toBe('1.0.0')

    const row = db.select().from(scripts).where(eq(scripts.id, output.id)).get()
    expect(row).toBeTruthy()
    expect(row?.source).toContain('defineScript')
    expect(row?.bundle.length ?? 0).toBeGreaterThan(0)

    // The published bundle is genuinely runnable — the same shape
    // `enkaku publish` produces and the runner already knows how to load
    // (`scripts/bundle-cache.ts` materialises `row.bundle` to a temp file
    // and `import()`s it exactly like this).
    const dir = mkdtempSync(join(tmpdir(), 'enkaku-script-publish-test-'))
    try {
      const outfile = join(dir, 'bundle.mjs')
      await Bun.write(outfile, row?.bundle ?? '')
      const mod = (await import(outfile)) as { default?: { id: string; version: string; run: (ctx: unknown) => unknown } }
      expect(mod.default?.id).toBe('hello-workspace')
      expect(mod.default?.version).toBe('1.0.0')
      expect(typeof mod.default?.run).toBe('function')
      const logs: string[] = []
      const output = await mod.default?.run({ params: { message: 'world' }, log: { info: (m: string) => logs.push(m) } })
      expect(output).toEqual({ echoed: 'world' })
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
    const result = await invoke(scriptPublish, ctx, { name: 'evil', version: '1.0.0', path: '/scripts/evil.ts' })
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
    const result = await invoke(scriptPublish, ctx, { name: 'nope', version: '1.0.0', path: '/scripts/nope.ts' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_NOT_FOUND')
    expect(db.select().from(scripts).all().length).toBe(0)
  })
})
