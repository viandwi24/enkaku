import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { EnkakuError } from '../util/errors'
import { createWorkspaceStore, type WorkspaceStore } from '../workspace/store'
import { buildScriptFromWorkspace, withTimeout } from './build'

/**
 * Server-side bundling (plan 64 §4.4, step 64.5, acceptance #7-#10). The
 * negative cases here (§7's "this test plan's most important table is over
 * long, not representative" spirit extends to this file too) are the point
 * of the plan: import allowlist, no filesystem resolution, never executed,
 * bounded time and size.
 */

const QUOTAS = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 }

function setUp(): { db: Db; workspace: WorkspaceStore } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return { db: opened.db, workspace: createWorkspaceStore(opened.db, () => QUOTAS) }
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('buildScriptFromWorkspace (plan 64 §4.4)', () => {
  test('a relative import resolves within the workspace and bundles', async () => {
    const { workspace } = setUp()
    workspace.write('/scripts/lib.ts', { content: enc(`export function greet(n: string) { return 'hi ' + n }`), actor: null })
    workspace.write('/scripts/hello.ts', {
      content: enc(`import { greet } from './lib.ts'\nexport default greet('world')`),
      actor: null,
    })
    const result = await buildScriptFromWorkspace(workspace, '/scripts/hello.ts')
    expect(result.bundle).toContain('function greet')
    expect(result.bundle).toContain('hi ')
    expect(result.source).toContain(`from './lib.ts'`)
  })

  test('an allowlisted bare import (zod) resolves from real disk and bundles', async () => {
    const { workspace } = setUp()
    workspace.write('/scripts/hello.ts', {
      content: enc(`import { z } from 'zod'\nexport default z.string().safeParse('x').success`),
      actor: null,
    })
    const result = await buildScriptFromWorkspace(workspace, '/scripts/hello.ts')
    expect(result.bundle.length).toBeGreaterThan(100) // zod itself is bundled in
  })

  test('acceptance #8: importing node:fs fails naming the specifier, before Bun.build ever runs', async () => {
    const { workspace } = setUp()
    workspace.write('/scripts/hello.ts', { content: enc(`import fs from 'node:fs'\nexport default fs`), actor: null })
    let caught: unknown
    try {
      await buildScriptFromWorkspace(workspace, '/scripts/hello.ts')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect((caught as EnkakuError).code).toBe('E_BUILD_FAILED')
    expect((caught as EnkakuError).message).toContain('node:fs')
  })

  test('acceptance #8: a bare specifier outside the allowlist fails naming it', async () => {
    const { workspace } = setUp()
    workspace.write('/scripts/hello.ts', { content: enc(`import leftPad from 'left-pad'\nexport default leftPad`), actor: null })
    let caught: unknown
    try {
      await buildScriptFromWorkspace(workspace, '/scripts/hello.ts')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect((caught as EnkakuError).code).toBe('E_BUILD_FAILED')
    expect((caught as EnkakuError).message).toContain('left-pad')
  })

  test('a require() call is checked exactly like an import statement', async () => {
    const { workspace } = setUp()
    workspace.write('/scripts/hello.ts', { content: enc(`const cp = require('node:child_process')\nexport default cp`), actor: null })
    let caught: unknown
    try {
      await buildScriptFromWorkspace(workspace, '/scripts/hello.ts')
    } catch (err) {
      caught = err
    }
    expect((caught as EnkakuError).code).toBe('E_BUILD_FAILED')
    expect((caught as EnkakuError).message).toContain('node:child_process')
  })

  test('an import escaping the workspace fails — it never reaches real disk, it just is not found', async () => {
    const { workspace } = setUp()
    workspace.write('/scripts/hello.ts', {
      content: enc(`import x from '../../../../../etc/passwd'\nexport default x`),
      actor: null,
    })
    let caught: unknown
    try {
      await buildScriptFromWorkspace(workspace, '/scripts/hello.ts')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect((caught as EnkakuError).code).toBe('E_BUILD_FAILED')
  })

  test('acceptance #9: bundling never executes the source — a top-level side effect never happens', async () => {
    const { workspace } = setUp()
    const marker = '__ENKAKU_BUILD_TEST_SIDE_EFFECT__'
    ;(globalThis as Record<string, unknown>)[marker] = false
    workspace.write('/scripts/hello.ts', {
      content: enc(`;(globalThis as any).${marker} = true\nexport default 1`),
      actor: null,
    })
    const result = await buildScriptFromWorkspace(workspace, '/scripts/hello.ts')
    expect((globalThis as Record<string, unknown>)[marker]).toBe(false)
    // The statement really is in the bundle text — it just never ran.
    expect(result.bundle).toContain(marker)
    delete (globalThis as Record<string, unknown>)[marker]
  })

  test('acceptance #10: exceeding the output size cap fails rather than publishing an oversized bundle', async () => {
    const { workspace } = setUp()
    workspace.write('/scripts/hello.ts', { content: enc(`export default 'x'.repeat(1000)`), actor: null })
    let caught: unknown
    try {
      await buildScriptFromWorkspace(workspace, '/scripts/hello.ts', { maxOutputBytes: 10 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect((caught as EnkakuError).code).toBe('E_BUILD_FAILED')
  })

  test('a missing entry fails naming it, before any build is attempted', async () => {
    const { workspace } = setUp()
    let caught: unknown
    try {
      await buildScriptFromWorkspace(workspace, '/scripts/nope.ts')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect((caught as EnkakuError).code).toBe('E_NOT_FOUND')
  })

  test('a graph deeper than maxFiles fails rather than walking forever', async () => {
    const { workspace } = setUp()
    // Ten files chained by relative imports; maxFiles: 3 must trip before the chain completes.
    for (let i = 0; i < 10; i++) {
      const next = i < 9 ? `import './f${i + 1}.ts'\n` : ''
      workspace.write(`/scripts/f${i}.ts`, { content: enc(`${next}export const v${i} = ${i}`), actor: null })
    }
    let caught: unknown
    try {
      await buildScriptFromWorkspace(workspace, '/scripts/f0.ts', { maxFiles: 3 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect((caught as EnkakuError).code).toBe('E_BUILD_FAILED')
  })
})

describe('acceptance #10: the timeout budget (plan 64 §4.4)', () => {
  test('withTimeout rejects E_BUILD_TIMEOUT once the budget elapses, even though the slow work is still running', async () => {
    let resolvedLate = false
    const slow = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolvedLate = true
          resolve('too late')
        }, 150)
      })
    const startedAt = Date.now()
    let caught: unknown
    try {
      await withTimeout(slow, 20)
    } catch (err) {
      caught = err
    }
    const elapsed = Date.now() - startedAt
    expect(caught).toBeInstanceOf(EnkakuError)
    expect((caught as EnkakuError).code).toBe('E_BUILD_TIMEOUT')
    expect(elapsed).toBeLessThan(100)
    expect(resolvedLate).toBe(false)
    await new Promise((r) => setTimeout(r, 200))
    expect(resolvedLate).toBe(true) // the underlying work is not abandoned — it settles on its own
  })

  test('withTimeout resolves normally when the work finishes first', async () => {
    const fast = () => Promise.resolve('done')
    await expect(withTimeout(fast, 1_000)).resolves.toBe('done')
  })
})
