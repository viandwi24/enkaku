import { describe, expect, test } from 'bun:test'
import type { NotifySendInput, NotifySendOutput } from '@enkaku/protocol'
import { notifySend } from './notify'
import type { CapabilityContext } from './context'
import type { NotifyService } from '../notify/service'

/**
 * `notify.send` (plan 68 §4.3) — a one-line delegation to `ctx.notify`, like
 * every other capability handler (plan 63 §4.3). What this file actually
 * verifies is the derivation the handler itself does: `source`/`context`
 * from WHO is calling (an agent run vs. a human/system caller), and the
 * refusal when `ctx.notify` is unavailable. `notify/service.test.ts`
 * exhaustively covers the service the handler delegates to.
 */

function fakeContext(overrides: { notify?: NotifyService; currentRunId?: string | null; actor?: { id: string; role: 'admin' | 'operator' } | null }): CapabilityContext {
  return {
    actor: overrides.actor ?? null,
    hasPermission: () => true,
    canReachDevice: () => true,
    evaluateActivity: () => ({ decision: 'allow' as const, message: '' }),
    touchActivity: () => {},
    isDeviceOnline: () => true,
    ensureAwake: async () => {},
    deviceCall: async () => {
      throw new Error('not used by notify.send')
    },
    readiness: null,
    listDevices: () => [],
    getDevice: () => null,
    jobService: {} as never,
    scripts: {} as never,
    resolveScriptRef: () => {
      throw new Error('not used by notify.send')
    },
    workspace: {} as never,
    workspaceScope: () => ({ read: [], write: [] }),
    currentRunId: overrides.currentRunId ?? null,
    agentTree: null,
    ...(overrides.notify ? { notify: overrides.notify } : {}),
  } as unknown as CapabilityContext
}

function spyNotify(): { notify: NotifyService; calls: Array<{ input: NotifySendInput; opts: Parameters<NotifyService['send']>[1] }> } {
  const calls: Array<{ input: NotifySendInput; opts: Parameters<NotifyService['send']>[1] }> = []
  const notify: NotifyService = {
    send: async (input, opts) => {
      calls.push({ input, opts })
      const out: NotifySendOutput = { notificationId: 'n1', delivered: [], failed: [] }
      return out
    },
  }
  return { notify, calls }
}

describe('notifySend handler — deriving source/context from the caller (plan 68 §4.3)', () => {
  test('an agent run (currentRunId set) is source "agent:<id>" with {runId} as context (criterion 14)', async () => {
    const { notify, calls } = spyNotify()
    const ctx = fakeContext({ notify, currentRunId: 'run-1', actor: { id: 'agent-1', role: 'operator' } })
    await notifySend.handler(ctx, { level: 'warn', title: 'found something' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.opts.source).toBe('agent:agent-1')
    expect(calls[0]?.opts.context).toEqual({ runId: 'run-1' })
    expect(calls[0]?.opts.agentId).toBe('agent-1')
    expect(calls[0]?.opts.runId).toBe('run-1')
  })

  test('a human caller (no currentRunId) is source "user:<id>" with no context and no rate limiting', async () => {
    const { notify, calls } = spyNotify()
    const ctx = fakeContext({ notify, currentRunId: null, actor: { id: 'u1', role: 'admin' } })
    await notifySend.handler(ctx, { level: 'info', title: 'manual note' })
    expect(calls[0]?.opts.source).toBe('user:u1')
    expect(calls[0]?.opts.context).toBeNull()
    expect(calls[0]?.opts.agentId).toBeNull()
    expect(calls[0]?.opts.runId).toBeNull()
  })

  test('no actor and no run at all is source "system"', async () => {
    const { notify, calls } = spyNotify()
    const ctx = fakeContext({ notify, currentRunId: null, actor: null })
    await notifySend.handler(ctx, { level: 'info', title: 'system note' })
    expect(calls[0]?.opts.source).toBe('system')
  })

  test('refuses cleanly with a coded error when notify is unavailable on this host', () => {
    const ctx = fakeContext({ currentRunId: null, actor: null })
    // The handler throws SYNCHRONOUSLY on this path (before any await), so this must be a plain
    // thrown-function assertion — wrapping the call in `expect(promise).rejects` would let the
    // synchronous throw escape before `.rejects` ever gets a promise to attach to.
    expect(() => notifySend.handler(ctx, { level: 'info', title: 'x' })).toThrow('notifications are not available')
  })

  test('the input schema requires a title and a valid level', () => {
    expect(notifySend.input.safeParse({ level: 'info', title: 'ok' }).success).toBe(true)
    expect(notifySend.input.safeParse({ level: 'info' }).success).toBe(false)
    expect(notifySend.input.safeParse({ level: 'critical', title: 'ok' }).success).toBe(false)
  })

  test('declares the registry metadata plan 68 §4.3 specifies', () => {
    expect(notifySend.id).toBe('notify.send')
    expect(notifySend.permission).toBe('notify.send')
    expect(notifySend.activity).toBeUndefined()
    expect(notifySend.effect).toBe('write')
    expect(notifySend.deadline).toBe(10_000)
  })
})
