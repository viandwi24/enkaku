import { NotifySendInputSchema, NotifySendOutputSchema } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

/**
 * `notify.send` (plan 68 §4.3) — a capability like everything else the
 * registry declares, so it is in the agent tool list, allowlistable per
 * agent, permission-checked, and audited through `invoke()`: an agent that
 * should observe but never page anyone simply does not have `notify.send`
 * in its `tools`.
 *
 * The handler is the usual one-line delegation (plan 63 §4.3) to
 * `ctx.notify` — everything that matters (writing the in-app row first,
 * signing, retries, rate limiting) lives in `notify/service.ts`. `source`
 * and `context` are derived here from WHO is calling: an agent run
 * (`ctx.currentRunId` set, plan 67 §4.2's convention) is `'agent:<id>'`
 * with `{runId}` so the notification links back to the run that produced
 * it (criterion 14); anything else (a human via REST/MCP) is `'user:<id>'`
 * or `'system'` with no run to link and no per-agent rate limit applied.
 */
export const notifySend = defineCapability({
  id: 'notify.send',
  input: NotifySendInputSchema,
  output: NotifySendOutputSchema,
  permission: 'notify.send',
  lease: 'none',
  deadline: 10_000,
  effect: 'write',
  description:
    'Send a notification: an in-app row (always) and, optionally, one or more configured webhook ' +
    'endpoints by name. The in-app notification is written even if every webhook fails. The result ' +
    'names exactly which channels delivered and which did not — check it before reporting that a page ' +
    'went out. Rate-limited per run and per hour; exceeding the limit is refused as an error, not a ' +
    'failed run.',
  handler: (ctx, input) => {
    if (!ctx.notify) throw new EnkakuError('E_INTERNAL', 'notifications are not available on this host')
    const runId = ctx.currentRunId
    const agentId = runId ? (ctx.actor?.id ?? null) : null
    const source = runId ? `agent:${agentId ?? 'unknown'}` : ctx.actor ? `user:${ctx.actor.id}` : 'system'
    return ctx.notify.send(input, { source, context: runId ? { runId } : null, agentId, runId })
  },
})

export const NOTIFY_CAPABILITIES = [notifySend]
