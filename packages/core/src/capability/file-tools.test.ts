import { newSession } from '@enkaku/harness'
import { describe, expect, test } from 'bun:test'
import type { AuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { createWorkspaceStore, type WorkspaceQuotas } from '../workspace/store'
import type { CapabilityContext } from './context'
import { filesDelete, filesEdit, filesGrep, filesList, filesRead, filesTodoWrite, filesWrite } from './file-tools'
import { invoke } from './invoke'

/**
 * The ported harness file tools (plan 77 §3.3, §4.2, criteria 5 and 6) — through the SAME
 * `invoke()` every other capability goes through, with `smart-replace.ts`'s cascade intact.
 */

const QUOTAS: WorkspaceQuotas = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 }

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function fakeCtx(db: Db, scope: { read: string[]; write: string[] } = { read: ['/'], write: ['/'] }): CapabilityContext {
  return {
    actor: { id: 'agent-1', role: 'operator' },
    currentRunId: 'run-1',
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
    plugins: () => null,
    resolveScriptRef: () => ({ id: 'script-1' }),
    workspace: createWorkspaceStore(db, () => QUOTAS),
    workspaceScope: () => scope,
    fileToolsSession: newSession(), // one shared session for the whole test — same object every call, like one real run
  }
}

function textOf(result: Awaited<ReturnType<typeof invoke>>): string {
  expect(result.ok).toBe(true)
  return result.ok ? (result.output as { result: string }).result : ''
}

describe('files.write / files.read (plan 77 §3.3)', () => {
  test('write then read round-trips content', async () => {
    const ctx = fakeCtx(setUp())
    const written = await invoke(filesWrite, ctx, { path: '/scripts/a.ts', content: 'hello' })
    expect(textOf(written)).toContain('OK')
    const read = await invoke(filesRead, ctx, { path: '/scripts/a.ts' })
    expect(textOf(read)).toBe('hello')
  })

  test('reading a missing file says so rather than throwing', async () => {
    const ctx = fakeCtx(setUp())
    const read = await invoke(filesRead, ctx, { path: '/nope.ts' })
    expect(textOf(read)).toContain('does not exist')
  })

  test('files.list reports written files', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(filesWrite, ctx, { path: '/scripts/a.ts', content: 'x' })
    const list = await invoke(filesList, ctx, {})
    expect(textOf(list)).toContain('/scripts/a.ts')
  })

  test('files.list on an empty workspace says so', async () => {
    const ctx = fakeCtx(setUp())
    const list = await invoke(filesList, ctx, {})
    expect(textOf(list)).toBe('Workspace is empty.')
  })
})

describe('files.edit — the smart-replace cascade, in order (plan 77 §3.3, criterion 5)', () => {
  test('edit requires a prior files.read in the SAME session (read-before-edit)', async () => {
    const db = setUp()
    // Written through a DIFFERENT context/session — `files.write` marks its OWN session as having
    // "read" the path it just wrote, so the file must come from elsewhere to test this guard.
    await invoke(filesWrite, fakeCtx(db), { path: '/a.ts', content: 'const x = 1' })
    const ctx = fakeCtx(db)
    const edit = await invoke(filesEdit, ctx, { path: '/a.ts', old_string: 'x = 1', new_string: 'x = 2' })
    expect(textOf(edit)).toContain('Read')
    expect(textOf(edit)).toContain('first')
  })

  test('level 1 — an EXACT match is replaced', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(filesWrite, ctx, { path: '/a.ts', content: 'const x = 1' })
    await invoke(filesRead, ctx, { path: '/a.ts' })
    const edit = await invoke(filesEdit, ctx, { path: '/a.ts', old_string: 'x = 1', new_string: 'x = 2' })
    expect(textOf(edit)).toContain('OK')
    const read = await invoke(filesRead, ctx, { path: '/a.ts' })
    expect(textOf(read)).toBe('const x = 2')
  })

  test('level 2 — LINE-TRIMMED match (old_string differs only by leading/trailing whitespace per line)', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(filesWrite, ctx, { path: '/a.ts', content: 'function f() {\n    return 1\n}' })
    await invoke(filesRead, ctx, { path: '/a.ts' })
    // No leading indentation in old_string — an exact match fails, a line-trimmed one succeeds.
    const edit = await invoke(filesEdit, ctx, { path: '/a.ts', old_string: 'return 1', new_string: 'return 2' })
    expect(textOf(edit)).toContain('OK')
    const read = await invoke(filesRead, ctx, { path: '/a.ts' })
    expect(textOf(read)).toContain('return 2')
  })

  test('level 3 — WHITESPACE-NORMALISED match (internal run of spaces differs)', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(filesWrite, ctx, { path: '/a.ts', content: 'const   x    =   1' })
    await invoke(filesRead, ctx, { path: '/a.ts' })
    const edit = await invoke(filesEdit, ctx, { path: '/a.ts', old_string: 'const x = 1', new_string: 'const x = 2' })
    expect(textOf(edit)).toContain('OK')
    const read = await invoke(filesRead, ctx, { path: '/a.ts' })
    expect(textOf(read)).toContain('const x = 2')
  })

  test('no match at any cascade level is refused, not a wrong-location edit', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(filesWrite, ctx, { path: '/a.ts', content: 'const x = 1' })
    await invoke(filesRead, ctx, { path: '/a.ts' })
    const edit = await invoke(filesEdit, ctx, { path: '/a.ts', old_string: 'totally absent', new_string: 'anything' })
    expect(textOf(edit)).toContain('not found')
    const read = await invoke(filesRead, ctx, { path: '/a.ts' })
    expect(textOf(read)).toBe('const x = 1') // untouched
  })

  test('an ambiguous (non-unique) old_string is refused rather than guessing', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(filesWrite, ctx, { path: '/a.ts', content: 'x = 1\nx = 1\n' })
    await invoke(filesRead, ctx, { path: '/a.ts' })
    const edit = await invoke(filesEdit, ctx, { path: '/a.ts', old_string: 'x = 1', new_string: 'x = 2' })
    expect(textOf(edit)).toContain('NOT UNIQUE')
  })

  test('editing after the file changed underneath reports STALE with the fresh content, and does not write', async () => {
    const db = setUp()
    const ctx = fakeCtx(db)
    await invoke(filesWrite, ctx, { path: '/a.ts', content: 'v1' })
    await invoke(filesRead, ctx, { path: '/a.ts' })
    // A second, independent writer changes the file after our read.
    await invoke(filesWrite, fakeCtx(db), { path: '/a.ts', content: 'v2-from-elsewhere' })
    const edit = await invoke(filesEdit, ctx, { path: '/a.ts', old_string: 'v1', new_string: 'v3' })
    expect(textOf(edit)).toContain('STALE')
    expect(textOf(edit)).toContain('v2-from-elsewhere')
    const read = await invoke(filesRead, fakeCtx(db), { path: '/a.ts' })
    expect(textOf(read)).toBe('v2-from-elsewhere')
  })
})

describe('files.delete / files.grep / files.todo', () => {
  test('delete removes the file', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(filesWrite, ctx, { path: '/a.ts', content: 'x' })
    const del = await invoke(filesDelete, ctx, { path: '/a.ts' })
    expect(textOf(del)).toContain('Deleted')
    const read = await invoke(filesRead, ctx, { path: '/a.ts' })
    expect(textOf(read)).toContain('does not exist')
  })

  test('grep finds a match by pattern', async () => {
    const ctx = fakeCtx(setUp())
    await invoke(filesWrite, ctx, { path: '/a.ts', content: 'needle here' })
    const grep = await invoke(filesGrep, ctx, { pattern: 'needle' })
    expect(textOf(grep)).toContain('/a.ts:1:')
  })

  test('todo_write formats a checklist and never touches the workspace', async () => {
    const ctx = fakeCtx(setUp())
    const todo = await invoke(filesTodoWrite, ctx, { todos: [{ content: 'step one', status: 'completed' }, { content: 'step two', status: 'pending' }] })
    expect(textOf(todo)).toContain('1/2')
    const list = await invoke(filesList, ctx, {})
    expect(textOf(list)).toBe('Workspace is empty.')
  })
})

describe('files.* through invoke() — permission, audit, scope (plan 77 §3.3, criterion 6)', () => {
  test('missing permission is refused with E_FORBIDDEN before the handler runs', async () => {
    const ctx = { ...fakeCtx(setUp()), hasPermission: () => false }
    const result = await invoke(filesWrite, ctx, { path: '/a.ts', content: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_FORBIDDEN')
  })

  test('every call is audited, success and refusal alike', async () => {
    const records: { action: string; target?: string; outcome: string }[] = []
    const audit: AuditLogger = { record: (e) => records.push({ action: e.action, target: e.target, outcome: (e.meta as { outcome: string }).outcome }), list: () => [] }
    const ctx = fakeCtx(setUp())
    await invoke(filesWrite, ctx, { path: '/a.ts', content: 'x' }, { audit })
    expect(records).toEqual([{ action: 'capability.invoke', target: 'files.write', outcome: 'ok' }])
  })

  test('a write outside the caller\'s workspace scope is refused E_OUT_OF_SCOPE, not silently allowed', async () => {
    const ctx = fakeCtx(setUp(), { read: ['/agents/x/'], write: ['/agents/x/'] })
    const result = await invoke(filesWrite, ctx, { path: '/shared/a.ts', content: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_OUT_OF_SCOPE')
  })

  test('a read outside the caller\'s workspace scope is refused too', async () => {
    const db = setUp()
    await invoke(filesWrite, fakeCtx(db), { path: '/agents/y/secret.ts', content: 'top secret' })
    const scoped = fakeCtx(db, { read: ['/agents/x/'], write: ['/agents/x/'] })
    const result = await invoke(filesRead, scoped, { path: '/agents/y/secret.ts' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_OUT_OF_SCOPE')
  })

  test('/skills/ is refused through files.write too, not only fs.write (plan 77 §3.4, §4.4, criterion 11)', async () => {
    const ctx = fakeCtx(setUp()) // currentRunId: 'run-1' — an agent context
    const result = await invoke(filesWrite, ctx, { path: '/skills/checkout/SKILL.md', content: '# hi' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_OUT_OF_SCOPE')
  })

  test('/skills/ refusal applies even when the agent\'s own write scope was configured to include it', async () => {
    // A broad write scope (as if an operator widened it to '/') still does not let an agent rewrite
    // its own skills — the exclusion is unconditional for a running agent, not merely the default.
    const db = setUp()
    const human = { ...fakeCtx(db, { read: ['/'], write: ['/'] }), currentRunId: null }
    await invoke(filesWrite, human, { path: '/skills/checkout/SKILL.md', content: 'x' })
    await invoke(filesRead, human, { path: '/skills/checkout/SKILL.md' }) // a session that HAS read it

    const agent = fakeCtx(db, { read: ['/'], write: ['/'] })
    await invoke(filesRead, agent, { path: '/skills/checkout/SKILL.md' }) // satisfy this session's read-before-edit too
    const result = await invoke(filesEdit, agent, { path: '/skills/checkout/SKILL.md', old_string: 'x', new_string: 'y' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_OUT_OF_SCOPE')
  })

  test('a human (no current run) may still use files.write on /skills/', async () => {
    const ctx = { ...fakeCtx(setUp()), currentRunId: null }
    const result = await invoke(filesWrite, ctx, { path: '/skills/checkout/SKILL.md', content: '# hi' })
    expect(result.ok).toBe(true)
  })

  test('without a shared session (a fresh context per call), read-before-edit continuity is lost', async () => {
    const db = setUp()
    await invoke(filesWrite, fakeCtx(db), { path: '/a.ts', content: 'v1' })
    await invoke(filesRead, fakeCtx(db), { path: '/a.ts' }) // a DIFFERENT context/session reads it
    const edit = await invoke(filesEdit, fakeCtx(db), { path: '/a.ts', old_string: 'v1', new_string: 'v2' }) // a third, fresh session
    expect(textOf(edit)).toContain('first') // "Read '...' first" — this session never saw a read
  })
})
