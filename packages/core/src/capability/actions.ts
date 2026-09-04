import { ActionCapabilityInputSchema, ActionRequestSchema, ActionResponseSchema } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

/**
 * `actions.run` (plan 207 §4.10) — the one door a plugin or an agent reaches
 * every MVP 07 verb through, a target and all: `{ deviceIds } | { groupId } | { tags }`.
 * No `activity`: the capability touches no device itself — each device is
 * evaluated inside `runAction` (plan 205 §4.4; `activity` absent means
 * device-less, the same convention every other farm-wide capability uses).
 */
export const actionsRun = defineCapability({
  id: 'actions.run',
  input: ActionCapabilityInputSchema,
  output: ActionResponseSchema,
  permission: 'device.view',
  deadline: 60_000,
  effect: 'write',
  description: 'Run one action (MVP 07 verbs) on a target: { deviceIds } | { groupId } | { tags }. Answers per device; a warned device is not started until force is true.',
  handler: (ctx, input) => {
    if (!ctx.actor) throw new EnkakuError('auth.forbidden', 'actions.run needs an actor')
    if (!ctx.actions) throw new EnkakuError('E_NOT_SUPPORTED', 'actions.run is not available on this host')
    const request = ActionRequestSchema.parse({ verb: input.verb, target: input.target, force: input.force, ...input.params })
    return ctx.actions.run(request, ctx.actor)
  },
})

export const ACTIONS_CAPABILITIES = [actionsRun]
