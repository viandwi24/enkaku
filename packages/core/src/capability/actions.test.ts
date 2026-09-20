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
      verb: 'set-labels',
      target: { deviceIds: ['d1', 'd2'] },
      params: { op: 'add', labelIds: ['l1', 'l2'] },
      force: true,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.actor).toEqual(actor)
    expect(calls[0]?.request).toMatchObject({ verb: 'set-labels', target: { deviceIds: ['d1', 'd2'] }, force: true, op: 'add', labelIds: ['l1', 'l2'] })
    expect(response.operationId).toBe('op-1')
  })

  /*
    Direct-run workflow (plan 907) needs no capability of its own: `params` is a
    free record here and is validated by the full `ActionRequestSchema` on the
    way through, so a plugin hands the DOCUMENT in `params` and reaches the same
    targeting, pacing, batching and audit every other workflow run uses.
  */
  test('a plugin can hand the workflow document itself, through the door that already exists', async () => {
    const actor: CapabilityActor = { id: 'u1', role: 'admin' }
    const { actions, calls } = spyActions()
    const doc = {
      schema: 2 as const,
      name: 'warmup-sequence',
      title: 'Warm-up sequence',
      entry: 'start',
      nodes: [
        { id: 'start', title: 'Start', ui: { x: 0, y: 0 }, enabled: true, kind: 'start' as const, next: 'done' },
        { id: 'done', title: 'Done', ui: { x: 0, y: 120 }, enabled: true, kind: 'finish' as const, status: 'succeed' as const, message: '' },
      ],
    }
    const ctx = fakeContext({ actions, actor })
    await actionsRun.handler(ctx, { verb: 'run-workflow', target: { deviceIds: ['d1'] }, params: { workflowName: 'warmup-sequence', workflowDoc: doc, concurrency: 1 }, force: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.request).toMatchObject({ verb: 'run-workflow', workflowName: 'warmup-sequence' })
    expect((calls[0]?.request as { workflowDoc?: { nodes: unknown[] } }).workflowDoc?.nodes).toHaveLength(2)
  })

  /* The same door, the same validation: a bad document is refused here, not on a phone. */
  test('a malformed workflow document never reaches ctx.actions.run', () => {
    const actor: CapabilityActor = { id: 'u1', role: 'admin' }
    const { actions, calls } = spyActions()
    const ctx = fakeContext({ actions, actor })
    expect(() => actionsRun.handler(ctx, { verb: 'run-workflow', target: { deviceIds: ['d1'] }, params: { workflowName: 'x', workflowDoc: { schema: 2, name: 'x', nodes: [] } }, force: false })).toThrow()
    expect(calls).toHaveLength(0)
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
