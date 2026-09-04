import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { createWorkspaceStore, type WorkspaceQuotas } from '../workspace/store'
import type { CapabilityContext } from './context'
import { fsWrite } from './fs'
import { invoke } from './invoke'
import { skillsList, skillsRead } from './skills'

/**
 * `skills.list` / `skills.read` (plan 77 §3.4, §4.4, criterion 10) — a `/skills/<name>/SKILL.md`
 * dropped into the workspace through the ordinary `fs.write` capability is discovered and readable
 * with NO code change; nothing here special-cases a skill name.
 */

const QUOTAS: WorkspaceQuotas = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 }

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function fakeCtx(db: Db, currentRunId: string | null = 'run-1'): CapabilityContext {
  return {
    actor: { id: 'agent-1', role: 'operator' },
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
    plugins: () => null,
    resolveScriptRef: () => ({ id: 'script-1' }),
    workspace: createWorkspaceStore(db, () => QUOTAS),
    workspaceScope: () => ({ read: ['/'], write: ['/'] }),
  }
}

const SKILL_MD = `---
name: checkout
description: Runs the checkout flow on a device.
---

## Steps
1. Open the app.
2. Tap checkout.
`

describe('skills.list / skills.read (plan 77 §3.4, §4.4, criterion 10)', () => {
  test('a dropped-in SKILL.md is discovered by skills.list with no code change', async () => {
    const db = setUp()
    const human = fakeCtx(db, null) // a human writes it, via the ordinary fs.write path
    await invoke(fsWrite, human, { path: '/skills/checkout/SKILL.md', content: SKILL_MD })

    const agent = fakeCtx(db)
    const result = await invoke(skillsList, agent, {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      const output = result.output as { result: string }
      expect(output.result).toContain('checkout')
      expect(output.result).toContain('Runs the checkout flow on a device.')
    }
  })

  test('skills.list with nothing written says so, not an empty string', async () => {
    const agent = fakeCtx(setUp())
    const result = await invoke(skillsList, agent, {})
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.output as { result: string }).result).toBe('No skills available.')
  })

  test('skills.read returns the skill\'s content, addressed relative to the skills root', async () => {
    const db = setUp()
    const human = fakeCtx(db, null)
    await invoke(fsWrite, human, { path: '/skills/checkout/SKILL.md', content: SKILL_MD })

    const agent = fakeCtx(db)
    const result = await invoke(skillsRead, agent, { path: 'checkout/SKILL.md' })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.output as { result: string }).result).toContain('Tap checkout.')
  })

  test('skills.read on an unknown path names the file rather than throwing', async () => {
    const agent = fakeCtx(setUp())
    const result = await invoke(skillsRead, agent, { path: 'nope/SKILL.md' })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.output as { result: string }).result).toContain("not found")
  })

  test('a SKILL.md with no (or malformed) frontmatter degrades gracefully rather than failing the boot', async () => {
    const db = setUp()
    const human = fakeCtx(db, null)
    await invoke(fsWrite, human, { path: '/skills/broken/SKILL.md', content: 'no frontmatter here, just prose' })

    const agent = fakeCtx(db)
    const result = await invoke(skillsList, agent, {})
    expect(result.ok).toBe(true) // never throws — malformed frontmatter just falls back to defaults
    if (result.ok) expect((result.output as { result: string }).result.length).toBeGreaterThan(0)
  })
})
