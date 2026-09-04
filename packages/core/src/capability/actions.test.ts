import { describe, expect, test } from 'bun:test'
import type { ActionRequest, ActionResponse } from '@enkaku/protocol'
import { actionsRun } from './actions'
import type { CapabilityActor, CapabilityContext } from './context'

/**
 * `actions.run` (plan 207 §4.10) — a one-line delegation to `ctx.actions.run`,
 * like every other capability handler (plan 63 §4.3). What this file
 * verifies is the handler's own three refusals/derivations: no actor, no
 * `ctx.actions` wired (orchestrator mode / a pre-plan-207 host), and that
 * `params` is flattened onto the request beside `target`/`force` exactly the
 * way the REST layer's own body is (`api/actions.ts` parses the same
 * `ActionRequestSchema`). `actions/run.test.ts` (if any) and
 * `api/actions.test.ts` cover `runAction` itself; this file only covers the
 * one door into it.
 */

function fakeContext(overrides: {
  actor?: CapabilityActor | null
  actions?: { run: (request: ActionRequest, actor: CapabilityActor) => Promise<ActionResponse> }
}): CapabilityContext {
  return {
    actor: overrides.actor ?? null,
    hasPermission: () => true,
    canReachDevice: () => true,
    evaluateActivity: () => ({ decision: 'allow' as const, message: '' }),
    touchActivity: () => {},
    isDeviceOnline: () => true,
    ensureAwake: async () => {},
    deviceCall: async () => {
      throw new Error('not used by actions.run')
    },
    readiness: null,
    listDevices: () => [],
    getDevice: () => null,
    jobService: {} as never,
    scripts: {} as never,
    resolveScriptRef: () => {
      throw new Error('not used by actions.run')
    },
    workspace: {} as never,
    workspaceScope: () => ({ read: [], write: [] }),
    currentRunId: null,
    agentTree: null,
    ...(overrides.actions ? { actions: overrides.actions } : {}),
  } as unknown as CapabilityContext
}

function spyActions(): { actions: { run: (request: ActionRequest, actor: CapabilityActor) => Promise<ActionResponse> }; calls: Array<{ request: ActionRequest; actor: CapabilityActor }> } {
  const calls: Array<{ request: ActionRequest; actor: CapabilityActor }> = []
  return {
    calls,
    actions: {
      run: async (request, actor) => {
        calls.push({ request, actor })
        return { operationId: 'op-1', verb: request.verb, results: [{ deviceId: 'd1', status: 'done' }] } as ActionResponse
      },
    },
  }
}

describe('actionsRun handler (plan 207 §4.10)', () => {
  test('refuses with auth.forbidden when there is no actor', () => {
    const { actions } = spyActions()
    const ctx = fakeContext({ actions, actor: null })
    // The handler is synchronous up to its own guard clauses (it returns
    // `ctx.actions.run(...)`'s promise only once past them) — both refusals
    // throw before any promise exists, so they are asserted as a plain sync
    // throw, not `rejects`.
    expect(() => actionsRun.handler(ctx, { verb: 'wake', target: { deviceIds: ['d1'] }, params: {}, force: false })).toThrow(
      'actions.run needs an actor',
    )
  })

  test('refuses with E_NOT_SUPPORTED when ctx.actions is not wired (orchestrator mode)', () => {
    const ctx = fakeContext({ actor: { id: 'u1', role: 'admin' } })
    expect(() => actionsRun.handler(ctx, { verb: 'wake', target: { deviceIds: ['d1'] }, params: {}, force: false })).toThrow(
      'actions.run is not available on this host',
    )
  })

  test('flattens params onto the request beside target/force, and forwards the caller as actor', async () => {
    const { actions, calls } = spyActions()
    const actor: CapabilityActor = { id: 'agent-1', role: 'operator' }
    const ctx = fakeContext({ actions, actor })
    const response = await actionsRun.handler(ctx, {
      verb: 'set-tags',
      target: { deviceIds: ['d1', 'd2'] },
      params: { tags: ['a', 'b'] },
      force: true,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.actor).toEqual(actor)
    expect(calls[0]?.request).toMatchObject({ verb: 'set-tags', target: { deviceIds: ['d1', 'd2'] }, force: true, tags: ['a', 'b'] })
    expect(response.operationId).toBe('op-1')
  })

  test('a request that fails ActionRequestSchema validation (e.g. a verb/params mismatch) throws before reaching ctx.actions.run', () => {
    const { actions, calls } = spyActions()
    const ctx = fakeContext({ actions, actor: { id: 'u1', role: 'admin' } })
    // `install` requires `artifactId` — omitted here, so `ActionRequestSchema.parse` throws
    // synchronously, before the handler ever calls `ctx.actions.run`.
    expect(() => actionsRun.handler(ctx, { verb: 'install', target: { deviceIds: ['d1'] }, params: {}, force: false })).toThrow()
    expect(calls).toHaveLength(0)
  })
})
