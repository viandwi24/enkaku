import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { createWorkspaceStore, type WorkspaceQuotas } from '../workspace/store'
import type { CapabilityContext } from './context'
import { fsDelete, fsGrep, fsList, fsMove, fsRead, fsWrite, type FsFileMeta } from './fs'
import { invoke } from './invoke'

// `invoke()` returns `CapabilityResult` with `output: unknown` — it takes an
// `AnyCoreCapability` with its I/O generics erased, so nothing here can
// narrow it automatically. These casts are the one place that trusts the
// capability's own declared output shape, purely for readable assertions.
type ReadOutput = FsFileMeta & { content: string }
interface ListOutput {
  entries: { path: string; kind: 'file' | 'dir'; size: number | null; hash: string | null; updatedAt: number | null }[]
}

/**
 * `fs.*` (plan 64 §4.2, §4.4, acceptance #1-#6, #12) through the SAME
 * `invoke()` every other capability goes through — no second path to a file
 * (00-overview's "invoke is the only door").
 */

const QUOTAS: WorkspaceQuotas = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 }

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function fakeCtx(db: Db, scope: { read: string[]; write: string[] } = { read: ['/'], write: ['/'] }, currentRunId: string | null = null): CapabilityContext {
  return {
    actor: { id: 'u1', role: 'operator' },
    currentRunId,
    agentTree: null,
    hasPermission: () => true,
    canReachDevice: () => true,
    evaluateActivity: () => ({ decision: 'allow' as const, message: '' }),
    touchActivity: () => {},
    isDeviceOnline: () => true,
    ensureAwake: async () => {},
    deviceCall: async () => undefined,
    readiness: null,
    listDevices: () => [],
    getDevice: () => null,
    jobService: {} as CapabilityContext['jobService'],
    scripts: {} as CapabilityContext['scripts'],
    resolveScriptRef: () => ({ id: 'script-1' }),
    workspace: createWorkspaceStore(db, () => QUOTAS),
    workspaceScope: () => scope,
  }
}

describe('fs.write / fs.read (plan 64 §4.2)', () => {
  test('create then read round-trips text content and never returns a bare string (acceptance #12)', async () => {
    const ctx = fakeCtx(setUp())
    const written = await invoke(fsWrite, ctx, { path: '/scripts/hello.ts', content: 'export default 1' })
    expect(written.ok).toBe(true)
    if (!written.ok) return
    const writtenMeta = written.output as FsFileMeta
    expect(typeof written.output).toBe('object')
    expect(writtenMeta.hash).toBeTruthy()

    const read = await invoke(fsRead, ctx, { path: '/scripts/hello.ts' })
    expect(read.ok).toBe(true)
    if (read.ok) {
      const readOutput = read.output as ReadOutput
      expect(readOutput.content).toBe('export default 1')
      expect(readOutput.hash).toBe(writtenMeta.hash)
    }
  })

  test('binary content round-trips through base64', async () => {
    const ctx = fakeCtx(setUp())
    const bytes = new Uint8Array([0, 1, 2, 255, 254])
    const b64 = Buffer.from(bytes).toString('base64')
    const written = await invoke(fsWrite, ctx, { path: '/shared/x.bin', content: b64, contentType: 'application/octet-stream' })
    expect(written.ok).toBe(true)
    const read = await invoke(fsRead, ctx, { path: '/shared/x.bin' })
    expect(read.ok).toBe(true)
    if (read.ok) {
      const readOutput = read.output as ReadOutput
      expect(readOutput.content).toBe(b64)
      expect(Array.from(Buffer.from(readOutput.content, 'base64'))).toEqual(Array.from(bytes))
    }
  })

  test('acceptance #3: overwrite without ifMatch fails E_EXISTS through invoke', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(fsWrite, ctx, { path: '/a.ts', content: 'v1' })
    const result = await invoke(fsWrite, ctx, { path: '/a.ts', content: 'v2' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_EXISTS')
  })

  test('acceptance #3: a stale ifMatch fails E_STALE through invoke', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(fsWrite, ctx, { path: '/a.ts', content: 'v1' })
    const result = await invoke(fsWrite, ctx, { path: '/a.ts', content: 'v2', ifMatch: 'not-real' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_STALE')
  })

  test('acceptance #1: a traversal path passes fs.write\'s own Zod input schema (a plain string) but is refused by the store with E_BAD_PATH', async () => {
    const ctx = fakeCtx(setUp())
    // The capability's own input schema is `z.string()`, so structurally any
    // string parses (this does NOT hit `invoke`'s own E_BAD_INPUT step) —
    // the traversal rejection itself is `normaliseWorkspacePath`'s job,
    // exercised exhaustively at workspace/path.test.ts. This confirms the
    // path DOES reach the store and gets refused there, never silently
    // written or resolved.
    const result = await invoke(fsWrite, ctx, { path: '/a/../b.ts', content: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_BAD_PATH')
  })
})

describe('fs.delete (plan 64 §4.2)', () => {
  test('deletes an existing file', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(fsWrite, ctx, { path: '/a.ts', content: 'v1' })
    const del = await invoke(fsDelete, ctx, { path: '/a.ts' })
    expect(del.ok).toBe(true)
    const read = await invoke(fsRead, ctx, { path: '/a.ts' })
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error.code).toBe('E_NOT_FOUND')
  })
})

describe('fs.move (plan 64 §4.2)', () => {
  test('renames a file and refuses onto an existing destination', async () => {
    const ctx = fakeCtx(setUp())
    const a = await invoke(fsWrite, ctx, { path: '/a.ts', content: 'a' })
    await invoke(fsWrite, ctx, { path: '/b.ts', content: 'b' })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const aMeta = a.output as FsFileMeta
    const collide = await invoke(fsMove, ctx, { from: '/a.ts', to: '/b.ts', ifMatch: aMeta.hash })
    expect(collide.ok).toBe(false)
    if (!collide.ok) expect(collide.error.code).toBe('E_EXISTS')

    const moved = await invoke(fsMove, ctx, { from: '/a.ts', to: '/c.ts', ifMatch: aMeta.hash })
    expect(moved.ok).toBe(true)
  })
})

describe('fs.list (plan 64 §4.2)', () => {
  test('lists immediate children only, never content', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(fsWrite, ctx, { path: '/scripts/hello.ts', content: 'a' })
    await invoke(fsWrite, ctx, { path: '/scripts/lib/util.ts', content: 'b' })
    const result = await invoke(fsList, ctx, { prefix: '/scripts' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const listOutput = result.output as ListOutput
      const paths = listOutput.entries.map((e) => e.path).sort()
      expect(paths).toEqual(['/scripts/hello.ts', '/scripts/lib/'])
      for (const entry of listOutput.entries) {
        expect(entry).not.toHaveProperty('content')
      }
    }
  })
})

describe('acceptance #6: scope — a caller scoped to /agents/x/ cannot reach /agents/y/', () => {
  test('fs.write to a foreign agent home fails E_OUT_OF_SCOPE, never E_NOT_FOUND', async () => {
    const scope = { read: ['/agents/x/'], write: ['/agents/x/'] }
    const ctx = fakeCtx(setUp(), scope)
    const result = await invoke(fsWrite, ctx, { path: '/agents/y/secret.ts', content: 'oops' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_OUT_OF_SCOPE')
  })

  test('fs.write inside the caller\'s own scope succeeds', async () => {
    const scope = { read: ['/agents/x/'], write: ['/agents/x/'] }
    const ctx = fakeCtx(setUp(), scope)
    const result = await invoke(fsWrite, ctx, { path: '/agents/x/main.ts', content: 'ok' })
    expect(result.ok).toBe(true)
  })

  test('fs.read outside the read scope fails E_OUT_OF_SCOPE even though the file exists', async () => {
    const db = setUp()
    const admin = fakeCtx(db) // full scope, to seed the file
    await invoke(fsWrite, admin, { path: '/agents/y/secret.ts', content: 'shh' })

    const scoped = fakeCtx(db, { read: ['/agents/x/'], write: ['/agents/x/'] })
    const result = await invoke(fsRead, scoped, { path: '/agents/y/secret.ts' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_OUT_OF_SCOPE')
  })

  test('a read-only scope can fs.read but not fs.write', async () => {
    const db = setUp()
    const admin = fakeCtx(db)
    await invoke(fsWrite, admin, { path: '/shared/notes.md', content: 'hi' })

    const readOnly = fakeCtx(db, { read: ['/'], write: ['/agents/x/'] })
    const read = await invoke(fsRead, readOnly, { path: '/shared/notes.md' })
    expect(read.ok).toBe(true)

    const write = await invoke(fsWrite, readOnly, { path: '/shared/notes.md', content: 'edited', ifMatch: read.ok ? (read.output as ReadOutput).hash : undefined })
    expect(write.ok).toBe(false)
    if (!write.ok) expect(write.error.code).toBe('E_OUT_OF_SCOPE')
  })

  test('fs.list of an out-of-scope prefix fails E_OUT_OF_SCOPE', async () => {
    const scoped = fakeCtx(setUp(), { read: ['/agents/x/'], write: ['/agents/x/'] })
    const result = await invoke(fsList, scoped, { prefix: '/agents/y' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_OUT_OF_SCOPE')
  })

  test('fs.move checks scope on BOTH source and destination', async () => {
    const db = setUp()
    const admin = fakeCtx(db)
    const written = await invoke(fsWrite, admin, { path: '/agents/x/a.ts', content: 'a' })
    expect(written.ok).toBe(true)
    if (!written.ok) return

    const scoped = fakeCtx(db, { read: ['/agents/x/'], write: ['/agents/x/'] })
    const writtenMeta = written.output as FsFileMeta
    const result = await invoke(fsMove, scoped, { from: '/agents/x/a.ts', to: '/agents/y/a.ts', ifMatch: writtenMeta.hash })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_OUT_OF_SCOPE')
  })
})

interface GrepOutput {
  hits: { path: string; line: number; text: string }[]
  truncated: boolean
}

describe('fs.grep (plan 77 §3.2, §4.2)', () => {
  test('finds a match under the given prefix', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(fsWrite, ctx, { path: '/scripts/a.ts', content: 'const needle = 1' })
    const result = await invoke(fsGrep, ctx, { prefix: '/scripts', pattern: 'needle' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const output = result.output as GrepOutput
      expect(output.hits).toEqual([{ path: '/scripts/a.ts', line: 1, text: 'const needle = 1' }])
      expect(output.truncated).toBe(false)
    }
  })

  test('a prefix outside the caller\'s READ scope fails E_OUT_OF_SCOPE and finds nothing (criterion 4)', async () => {
    const db = setUp()
    const admin = fakeCtx(db)
    await invoke(fsWrite, admin, { path: '/agents/y/secret.ts', content: 'const needle = 1' })

    const scoped = fakeCtx(db, { read: ['/agents/x/'], write: ['/agents/x/'] })
    const result = await invoke(fsGrep, scoped, { prefix: '/agents/y', pattern: 'needle' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_OUT_OF_SCOPE')
  })
})

describe('/skills/ is read-only to a running agent (plan 77 §3.4, §4.4, criterion 11)', () => {
  test('fs.write to /skills/ from within an agent run is refused with E_OUT_OF_SCOPE', async () => {
    const ctx = fakeCtx(setUp(), { read: ['/'], write: ['/'] }, 'run-1')
    const result = await invoke(fsWrite, ctx, { path: '/skills/checkout/SKILL.md', content: '# hi' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_OUT_OF_SCOPE')
  })

  test('fs.delete and fs.move to/from /skills/ are refused the same way, from within a run', async () => {
    const db = setUp()
    const human = fakeCtx(db) // currentRunId: null — a human via Studio may write skills
    const written = await invoke(fsWrite, human, { path: '/skills/checkout/SKILL.md', content: '# hi' })
    expect(written.ok).toBe(true)
    if (!written.ok) return
    const meta = written.output as FsFileMeta

    const agent = fakeCtx(db, { read: ['/'], write: ['/'] }, 'run-1')
    const del = await invoke(fsDelete, agent, { path: '/skills/checkout/SKILL.md' })
    expect(del.ok).toBe(false)
    if (!del.ok) expect(del.error.code).toBe('E_OUT_OF_SCOPE')

    const move = await invoke(fsMove, agent, { from: '/skills/checkout/SKILL.md', to: '/skills/checkout/renamed.md', ifMatch: meta.hash })
    expect(move.ok).toBe(false)
    if (!move.ok) expect(move.error.code).toBe('E_OUT_OF_SCOPE')
  })

  test('a HUMAN (no current run) may still write to /skills/ — Studio\'s own editing path', async () => {
    const ctx = fakeCtx(setUp()) // currentRunId: null
    const result = await invoke(fsWrite, ctx, { path: '/skills/checkout/SKILL.md', content: '# hi' })
    expect(result.ok).toBe(true)
  })

  test('an agent may still READ /skills/ — only fs.write is excluded', async () => {
    const db = setUp()
    const human = fakeCtx(db)
    await invoke(fsWrite, human, { path: '/skills/checkout/SKILL.md', content: '# hi' })

    const agent = fakeCtx(db, { read: ['/'], write: ['/'] }, 'run-1')
    const read = await invoke(fsRead, agent, { path: '/skills/checkout/SKILL.md' })
    expect(read.ok).toBe(true)
  })
})
