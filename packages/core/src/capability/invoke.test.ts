import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { PolicyDecision } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import { EnkakuError } from '../util/errors'
import type { CapabilityContext } from './context'
import { invoke } from './invoke'
import type { AnyCoreCapability } from './types'

const ALLOW: PolicyDecision = { decision: 'allow', message: '' }

function fakeCtx(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    actor: { id: 'u1', role: 'operator' },
    currentRunId: null,
    agentTree: null,
    hasPermission: () => true,
    canReachDevice: () => true,
    evaluateActivity: () => ALLOW,
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
    deadline: 1_000,
    effect: 'read',
    description: 'a test capability',
    handler: async () => ({ ok: true }),
    ...overrides,
  }
}

describe('invoke (plan 63 §3.4, plan 205 §4.4, acceptance #4-7, #12)', () => {
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

  test('4. activity forbid -> E_DEVICE_CONFLICT, naming the conflicting activity (acceptance #5)', async () => {
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), activity: { kind: 'control' } })
    const ctx = fakeCtx({ evaluateActivity: () => ({ decision: 'forbid', message: 'Running tiktok/login (job #482); control cannot start until it ends' }) })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('E_DEVICE_CONFLICT')
      expect(result.error.message).toContain('job #482')
    }
  })

  test('a warn decision still succeeds, carrying the sentence as the result warning', async () => {
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), activity: { kind: 'control' } })
    const ctx = fakeCtx({ evaluateActivity: () => ({ decision: 'warn', message: 'Rani is controlling this device; your taps will interfere' }) })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warning).toBe('Rani is controlling this device; your taps will interfere')
  })

  test('activity policy is never consulted implicitly — evaluateActivity is called, never mutated, and only once', async () => {
    let calls = 0
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), activity: { kind: 'control' } })
    const ctx = fakeCtx({
      evaluateActivity: () => {
        calls++
        return ALLOW
      },
    })
    await invoke(cap, ctx, { deviceId: 'd1' })
    expect(calls).toBe(1)
  })

  test("5. offline device with a declared activity -> E_DEVICE_OFFLINE", async () => {
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), activity: { kind: 'read' } })
    const ctx = fakeCtx({ isDeviceOnline: () => false })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('E_DEVICE_OFFLINE')
  })

  test('no declared activity never checks device online, even with a deviceId present', async () => {
    let onlineChecked = false
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }) })
    const ctx = fakeCtx({ isDeviceOnline: () => ((onlineChecked = true), false) })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(true)
    expect(onlineChecked).toBe(false)
  })

  test("'read' skips the policy entirely — no conflict, however busy the device, and no online check either", async () => {
    let evaluated = false
    let onlineChecked = false
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), activity: { kind: 'read' } })
    const ctx = fakeCtx({
      evaluateActivity: () => {
        evaluated = true
        return { decision: 'forbid', message: 'would refuse if ever consulted' }
      },
      isDeviceOnline: () => ((onlineChecked = true), true),
    })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(true)
    expect(evaluated).toBe(false)
    // `'read'` still requires the device online (plan 205 §4.4: "the device must be online, nothing
    // is started and the policy is not consulted") — only the POLICY check is skipped.
    expect(onlineChecked).toBe(true)
  })

  test('control touches the marker after the handler succeeds, never before', async () => {
    const order: string[] = []
    const cap = fakeCap({
      input: z.object({ deviceId: z.string() }),
      activity: { kind: 'control' },
      handler: async () => {
        order.push('handler')
        return { ok: true as const }
      },
    })
    const ctx = fakeCtx({ touchActivity: () => order.push('touch') })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(true)
    expect(order).toEqual(['handler', 'touch'])
  })

  test('control never touches the marker when the handler throws', async () => {
    let touched = false
    const cap = fakeCap({
      input: z.object({ deviceId: z.string() }),
      activity: { kind: 'control' },
      handler: async () => {
        throw new Error('boom')
      },
    })
    const ctx = fakeCtx({ touchActivity: () => { touched = true } })
    await invoke(cap, ctx, { deviceId: 'd1' })
    expect(touched).toBe(false)
  })

  test('a non-control activity kind never touches the marker, even on success', async () => {
    let touched = false
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), activity: { kind: 'command' } })
    const ctx = fakeCtx({ touchActivity: () => { touched = true } })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(true)
    expect(touched).toBe(false)
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

  test('invoke refuses in the fixed §3.4 order — permission before device grant before the activity policy', async () => {
    const calls: string[] = []
    const cap = fakeCap({ input: z.object({ deviceId: z.string() }), activity: { kind: 'control' } })
    const ctx = fakeCtx({
      hasPermission: () => {
        calls.push('permission')
        return false
      },
      canReachDevice: () => {
        calls.push('grant')
        return true
      },
      evaluateActivity: () => {
        calls.push('activity')
        return ALLOW
      },
    })
    const result = await invoke(cap, ctx, { deviceId: 'd1' })
    expect(result.ok).toBe(false)
    expect(calls).toEqual(['permission'])
  })
})
