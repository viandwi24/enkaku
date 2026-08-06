import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { AuditLogger } from '../auth/audit'
import { EnkakuError } from '../util/errors'
import type { CapabilityContext } from './context'
import { invoke } from './invoke'
import type { AnyCoreCapability } from './types'

function fakeCtx(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
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
    scripts: {} as CapabilityContext['scripts'],
    resolveScriptRef: () => ({ id: 'script-1' }),
    workspace: {} as CapabilityContext['workspace'],
    workspaceScope: () => ({ read: ['/'], write: ['/'] }),
    ...overrides,
  }
}

function fakeCap(overrides: Partial<AnyCoreCapability> = {}): AnyCoreCapability {
  return {
    id: 'test.op',
    input: z.object({ deviceId: z.string().optional() }),
    output: z.object({ ok: z.literal(true) }),
    permission: 'device.control',
    lease: 'none',
    deadline: 1_000,
    effect: 'read',
    description: 'a test capability',
    handler: async () => ({ ok: true }),
    ...overrides,
  }
}

describe('invoke (plan 63 §3.4, acceptance #4-7, #12)', () => {
  test('1. bad input -> E_BAD_INPUT, refused before permission is checked', async () => {
    let permissionChecked = false
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }) })
    const ctx = fakeCtx({ hasPermission: () => ((permissionChecked = true), true) })
    const result = await invoke(cap, ctx, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_BAD_INPUT')
    expect(permissionChecked).toBe(false)
  })

  test('2. missing permission -> E_FORBIDDEN', async () => {
    const cap = fakeCap()
    const ctx = fakeCtx({ hasPermission: () => false })
    const result = await invoke(cap, ctx, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_FORBIDDEN')
  })

  test('3. no device grant -> E_NO_GRANT', async () => {
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }) })
    const ctx = fakeCtx({ canReachDevice: () => false })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_NO_GRANT')
  })

  test('4. lease:control without the lease -> E_NEEDS_LEASE, names the holder (acceptance #5)', async () => {
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), lease: 'control' })
    const ctx = fakeCtx({ controlLeaseBlockedBy: () => 'alice' })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('E_NEEDS_LEASE')
      expect(result.error.message).toContain('alice')
    }
  })

  test('lease:control never acquires the lease implicitly — controlLeaseBlockedBy is consulted, never mutated', async () => {
    let acquireCalls = 0
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), lease: 'control' })
    const ctx = fakeCtx({
      controlLeaseBlockedBy: () => {
        acquireCalls++
        return null
      },
    })
    await invoke(cap, ctx, { deviceId: 'd1' })
    expect(acquireCalls).toBe(1)
  })

  test('5. offline device with lease != none -> E_DEVICE_OFFLINE', async () => {
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), lease: 'device' })
    const ctx = fakeCtx({ isDeviceOnline: () => false })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_DEVICE_OFFLINE')
  })

  test('lease:none never checks device online, even with a deviceId present', async () => {
    let onlineChecked = false
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), lease: 'none' })
    const ctx = fakeCtx({ isDeviceOnline: () => ((onlineChecked = true), false) })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(true)
    expect(onlineChecked).toBe(false)
  })

  test('6. exceeding the deadline -> E_DEADLINE', async () => {
    const cap = fakeCap({
      deadline: 20,
      handler: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 500)),
    })
    const result = await invoke(cap, fakeCtx(), {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_DEADLINE')
  })

  test('success returns the typed output, never a bare string (acceptance #12)', async () => {
    const cap = fakeCap({ handler: async () => ({ ok: true as const }) })
    const result = await invoke(cap, fakeCtx(), {})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.output).toEqual({ ok: true })
  })

  test('a handler-thrown EnkakuError passes through with its own code (not collapsed to E_INTERNAL)', async () => {
    const cap = fakeCap({
      handler: async () => {
        throw new EnkakuError('job_not_found', 'no such job: j1')
      },
    })
    const result = await invoke(cap, fakeCtx(), {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('job_not_found')
      expect(result.error.message).toBe('no such job: j1')
    }
  })

  test('a plain unexpected throw -> E_INTERNAL', async () => {
    const cap = fakeCap({
      handler: async () => {
        throw new Error('boom')
      },
    })
    const result = await invoke(cap, fakeCtx(), {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_INTERNAL')
  })

  test('7. every path audits, including refusals', async () => {
    const records: { action: string; target?: string | undefined; meta: unknown }[] = []
    const audit: AuditLogger = {
      record: (e) => {
        records.push({ action: e.action, target: e.target, meta: e.meta })
      },
      list: () => [],
    }
    const cap = fakeCap()
    const ctx = fakeCtx({ hasPermission: () => false })
    await invoke(cap, ctx, {}, { audit })
    expect(records).toHaveLength(1)
    expect(records[0]?.action).toBe('capability.invoke')
    expect(records[0]?.target).toBe('test.op')
    expect((records[0]?.meta as { outcome: string }).outcome).toBe('refused')

    records.length = 0
    await invoke(cap, fakeCtx(), {}, { audit })
    expect(records).toHaveLength(1)
    expect((records[0]?.meta as { outcome: string }).outcome).toBe('ok')
  })

  test('invoke refuses in the fixed §3.4 order — permission before device grant before lease', async () => {
    const calls: string[] = []
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), lease: 'control' })
    const ctx = fakeCtx({
      hasPermission: () => {
        calls.push('permission')
        return false
      },
      canReachDevice: () => {
        calls.push('grant')
        return true
      },
      controlLeaseBlockedBy: () => {
        calls.push('lease')
        return null
      },
    })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(false)
    expect(calls).toEqual(['permission'])
  })
})
