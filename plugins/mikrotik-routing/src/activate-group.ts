import type { PluginMemberScript } from '@enkaku/sdk'
import { z } from 'zod'
import { activateGroup } from './service/groups-service'

/**
 * `activate-group` — plan 122 §4.8, step 122.10. A thin wrapper over
 * `groups-service.ts`'s own `activateGroup` (§4.6 steps 1-7, built in
 * 122.8), so a rotation between named groups is an ordinary scheduled job:
 * `02:00 → jadwal-1`, `14:00 → jadwal-2`, both `force: true` (a scheduled
 * switch between groups covering the same devices is by definition a
 * conflicting activation — §4.6's own reasoning for why `force` exists).
 *
 * **Thin is the requirement, not a style choice.** §4.8 says member scripts
 * "never talk to the router directly — they go through the service, keeping
 * one enforcement point and one audit trail." This script does exactly one
 * thing: build a `GroupsHost` from `ctx` (the ambient `storage`/`farm`/`log`
 * every `ScriptContext` already carries, structurally identical to what
 * `apply-routes.ts`/`groups-routes.ts` hand `activateGroup` from a service
 * route) and call `activateGroup(ctx, group, force)`. Every enforcement point
 * stays inside that one function: the §4.6 conflict check
 * (`decideActivation`), the §3.2 local-exception gate (checked BEFORE any
 * mutation, and again by `applyNow` itself), and the duplicate-device guard
 * (criterion 12) are none of them reimplemented, re-checked, or bypassed
 * here — this script could not skip them even if it tried, since it never
 * touches a router rule or a group's own KV row directly.
 *
 * Every fire is recorded via the declared `result` schema (job history), so
 * a rotation's history — including its refusals and no-ops — is never a
 * blank gap, exactly as §4.8 asks.
 */

const params = z.object({
  group: z.string().min(1).describe('The group id (§4.9 group:<id>) to activate.'),
  force: z
    .boolean()
    .default(false)
    .describe(
      'Deactivate any conflicting active group first, in the same operation (§4.6). Set this when a scheduled rotation switches between groups covering the same devices — that is by definition a conflicting activation.',
    ),
})

const result = z.object({
  ok: z.boolean(),
  code: z.string().nullable().describe('Set when ok is false — the exact same coded refusal groups-service.ts’s activateGroup itself returns (e.g. E_GROUP_CONFLICT, E_LOCAL_EXCEPTION_NOT_OK).'),
  message: z.string().nullable(),
})

const activateGroupScript: PluginMemberScript<typeof params, typeof result> = {
  id: 'activate-group',
  title: 'Activate a routing group',
  description:
    'A thin wrapper over the service’s own activation transaction (§4.6) — so a scheduled rotation between named groups is an ordinary job (§4.8). Every enforcement (the conflict check, the local-exception gate, the duplicate-device guard) stays inside groups-service.ts’s activateGroup; this script reimplements none of it and never talks to the router directly.',
  params,
  result,
  timeout: 60_000,

  async run(ctx) {
    const outcome = await activateGroup(ctx, ctx.params.group, ctx.params.force)

    if (!outcome.ok) {
      ctx.log.warn('mikrotik-routing: activate-group refused', { group: ctx.params.group, force: ctx.params.force, code: outcome.code, message: outcome.message })
      return { ok: false, code: outcome.code, message: outcome.message }
    }

    ctx.log.info('mikrotik-routing: activate-group succeeded', { group: ctx.params.group, force: ctx.params.force })
    return { ok: true, code: null, message: null }
  },
}

export default activateGroupScript
