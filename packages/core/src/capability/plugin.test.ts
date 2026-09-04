import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { createWorkspaceStore, type WorkspaceQuotas, type WorkspaceStore } from '../workspace/store'
import type { PluginStagePort } from './context'
import type { CapabilityContext } from './context'
import { pluginStage } from './plugin'
import { invoke } from './invoke'

/**
 * `plugin.stage` (plan 210 §4.8) through the SAME `invoke()` every other
 * capability goes through — the only way code reaches the farm.
 */

const QUOTAS: WorkspaceQuotas = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 }
const enc = (s: string) => new TextEncoder().encode(s)

function setUp(): { db: Db; workspace: WorkspaceStore } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return { db: opened.db, workspace: createWorkspaceStore(opened.db, () => QUOTAS) }
}

interface FakePort extends PluginStagePort {
  calls: { stage: unknown[]; verify: unknown[]; get: unknown[] }
}

function wireRow(name: string, version: string, status: 'staged' | 'active') {
  return {
    id: 'p1',
    name,
    version,
    title: null,
    description: null,
    status,
    verifiedAt: status === 'active' ? new Date() : null,
    verifyError: null,
    verifyErrorCode: null,
    createdBy: null,
    createdAt: new Date(),
    manifest: {},
    scriptCount: 1,
  }
}

function fakePort(): FakePort {
  const calls: FakePort['calls'] = { stage: [], verify: [], get: [] }
  const port: FakePort = {
    calls,
    stage: async (input) => {
      calls.stage.push(input)
      return wireRow(input.name, input.version, 'staged')
    },
    verify: async (id) => {
      calls.verify.push(id)
      return { ok: true, pluginId: 'p1', version: '1.0.0', scripts: [], resetPackages: [] }
    },
    get: (name, version) => {
      calls.get.push({ name, version })
      return wireRow(name, version, 'active')
    },
  }
  return port
}

function fakeCtx(workspace: WorkspaceStore, port: PluginStagePort | null): CapabilityContext {
  return {
    actor: { id: 'u1', role: 'operator' },
    currentRunId: null,
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
    plugins: () => port,
    resolveScriptRef: () => ({ id: 'script-1' }),
    workspace,
    workspaceScope: () => ({ read: ['/'], write: ['/'] }),
  }
}

describe('plugin.stage (plan 210 §4.8)', () => {
  test('the { bundle } form stages then verifies', async () => {
    const { workspace } = setUp()
    const port = fakePort()
    const ctx = fakeCtx(workspace, port)
    const result = await invoke(pluginStage, ctx, { name: 'demo', version: '1.0.0', bundle: 'export default {}' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(port.calls.stage).toHaveLength(1)
    expect(port.calls.verify).toHaveLength(1)
    expect(port.calls.get).toHaveLength(1)
    expect(result.output).toMatchObject({ id: 'p1', name: 'demo', version: '1.0.0', status: 'active' })
  })

  test('stageOnly: true stages only, never verifies', async () => {
    const { workspace } = setUp()
    const port = fakePort()
    const ctx = fakeCtx(workspace, port)
    const result = await invoke(pluginStage, ctx, { name: 'demo', version: '1.0.0', bundle: 'export default {}', stageOnly: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(port.calls.stage).toHaveLength(1)
    expect(port.calls.verify).toHaveLength(0)
    expect(result.output).toMatchObject({ id: 'p1', name: 'demo', version: '1.0.0', status: 'staged' })
  })

  test('the { path } form bundles through buildScriptFromWorkspace and refuses a node:fs import', async () => {
    const { workspace } = setUp()
    workspace.write('/scripts/hello.ts', { content: enc(`import fs from 'node:fs'\nexport default fs`), actor: null })
    const port = fakePort()
    const ctx = fakeCtx(workspace, port)
    const result = await invoke(pluginStage, ctx, { name: 'demo', version: '1.0.0', path: '/scripts/hello.ts' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('node:fs')
    expect(port.calls.stage).toHaveLength(0)
  })

  test('a host with plugins: () => null refuses E_NOT_SUPPORTED', async () => {
    const { workspace } = setUp()
    const ctx = fakeCtx(workspace, null)
    const result = await invoke(pluginStage, ctx, { name: 'demo', version: '1.0.0', bundle: 'export default {}' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('E_NOT_SUPPORTED')
  })
})
