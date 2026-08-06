import { z } from 'zod'
import { AgentRunStatusSchema, AgentStopReasonSchema } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

/**
 * `agent.spawn`, `.send`, `.reply`, `.status`, `.cancel` (plan 67 §4.2) — the
 * run tree's tool surface. Every handler is a one-line delegation to
 * `ctx.agentTree` (plan 63 §4.3's own rule, unchanged by this plan):
 * `agent/runner.ts` is the only thing with the machinery to launch, wait
 * for, message, and cascade-cancel a run, so this file enforces NOTHING
 * itself beyond "there is a current run to act from" — depth/run-count caps
 * (§3.6), the authority intersection (§3.4), the descendant/parent edge
 * checks (§4.2), and the tree lease rule (§3.7) all live in `ctx.agentTree`'s
 * implementation.
 *
 * All five share the `agent.run` permission — operating an agent (including
 * one it spawns) is the same permission Plan 66 already uses for chatting
 * with one, deliberately distinct from `agent.manage` (editing a record).
 */

function requireTree(ctx: { agentTree: unknown; currentRunId: string | null }): asserts ctx is { agentTree: NonNullable<typeof ctx.agentTree>; currentRunId: string } {
  if (!ctx.agentTree || !ctx.currentRunId) {
    throw new EnkakuError('E_NOT_IN_RUN', 'this capability is only usable from within a running agent\'s own tool-calling')
  }
}

const SpawnOutput = z.discriminatedUnion('waited', [
  z.object({ waited: z.literal(true), runId: z.string(), status: AgentRunStatusSchema, stopReason: AgentStopReasonSchema.nullable(), output: z.string().nullable() }),
  z.object({ waited: z.literal(false), runId: z.string() }),
])

export const agentSpawn = defineCapability({
  id: 'agent.spawn',
  input: z.object({
    /** The child agent's slug or id — must be named in the caller's `canSpawn` list (plan 67 §3.4). */
    agent: z.string().min(1),
    prompt: z.string().min(1),
    /** Default true (plan 67 §3.2): the call does not return until the child finishes; the parent
     * consumes wall-clock but no steps while parked. */
    waitFor: z.boolean().optional(),
    /** Narrows the child's device grants below the authority intersection — never widens it. */
    deviceIds: z.array(z.string()).optional(),
  }),
  output: SpawnOutput,
  permission: 'agent.run',
  lease: 'none',
  // Generous on purpose: a `waitFor: true` call can legitimately block for as long as the PARENT's
  // own `maxRunSeconds` allows (plan 67 §3.2) — `invoke`'s deadline (plan 63 §3.4 step 6) must never
  // fire before that budget does, so this is set far above any realistic `maxRunSeconds`, not tuned
  // like a normal device-operation deadline.
  deadline: 86_400_000,
  effect: 'write',
  description:
    'Spawn another agent as a child of this run. Its effective authority is the INTERSECTION of its ' +
    'own configuration and this run\'s — it can never be more privileged than you are, and you can ' +
    'only spawn agents your own agent record explicitly allows. waitFor defaults to true: the call ' +
    'blocks until the child finishes and returns its final output as the result, consuming no steps ' +
    'of your own while it waits. Pass waitFor: false to get a runId back immediately and receive the ' +
    'child\'s result later as an injected message. deviceIds narrows the child to a subset of the ' +
    'devices you can already reach — pass one device per child to fan work out across a fleet.',
  handler: async (ctx, input) => {
    requireTree(ctx)
    const result = await ctx.agentTree.spawn({ agent: input.agent, prompt: input.prompt, waitFor: input.waitFor ?? true, ...(input.deviceIds ? { deviceIds: input.deviceIds } : {}) })
    return result
  },
})

export const agentSend = defineCapability({
  id: 'agent.send',
  input: z.object({ runId: z.string(), message: z.string().min(1) }),
  output: z.object({ queued: z.literal(true), inboxId: z.string() }),
  permission: 'agent.run',
  lease: 'none',
  deadline: 5_000,
  effect: 'write',
  description:
    'Send a message to a DESCENDANT run of this one (any depth) that is still working. Delivered at ' +
    'its next turn boundary, never mid tool-call — it will not interrupt a gesture or a file push in ' +
    'progress. Refused if runId is not one of your own descendants.',
  handler: (ctx, { runId, message }) => {
    requireTree(ctx)
    return Promise.resolve(ctx.agentTree.send(runId, message))
  },
})

export const agentReply = defineCapability({
  id: 'agent.reply',
  input: z.object({ message: z.string().min(1) }),
  output: z.object({ queued: z.literal(true), inboxId: z.string() }),
  permission: 'agent.run',
  lease: 'none',
  deadline: 5_000,
  effect: 'write',
  description:
    'Send a message to the run that spawned this one, while you are still working. There is no ' +
    'target parameter — this can only ever reach your own parent, never any other run in the farm. ' +
    'Refused if this run has no parent (it is a root).',
  handler: (ctx, { message }) => {
    requireTree(ctx)
    return Promise.resolve(ctx.agentTree.reply(message))
  },
})

export const agentStatus = defineCapability({
  id: 'agent.status',
  input: z.object({ runId: z.string() }),
  output: z.object({
    runId: z.string(),
    status: AgentRunStatusSchema,
    stopReason: AgentStopReasonSchema.nullable(),
    steps: z.number().int(),
    lastMessage: z.string().nullable(),
  }),
  permission: 'agent.run',
  lease: 'none',
  deadline: 5_000,
  effect: 'read',
  description: 'Check a DESCENDANT run\'s status, step count, and last message (any depth). Refused if runId is not one of your own descendants.',
  handler: (ctx, { runId }) => {
    requireTree(ctx)
    return Promise.resolve(ctx.agentTree.status(runId))
  },
})

export const agentCancel = defineCapability({
  id: 'agent.cancel',
  input: z.object({ runId: z.string() }),
  output: z.object({ ok: z.literal(true), cancelledCount: z.number().int() }),
  permission: 'agent.run',
  lease: 'none',
  deadline: 30_000,
  effect: 'destructive',
  description:
    'Cancel a DESCENDANT run and its own subtree, depth-first — every device it (and its ' +
    'descendants) held is released. Destructive: this pauses for an operator\'s approval unless the ' +
    'agent\'s owner has allowlisted it. Refused if runId is not one of your own descendants.',
  handler: (ctx, { runId }) => {
    requireTree(ctx)
    return Promise.resolve(ctx.agentTree.cancel(runId))
  },
})

export const AGENT_TREE_CAPABILITIES = [agentSpawn, agentSend, agentReply, agentStatus, agentCancel]
