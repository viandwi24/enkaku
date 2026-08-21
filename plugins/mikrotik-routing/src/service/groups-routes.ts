import type { PluginRequest, PluginResponse } from '@enkaku/sdk'
import { z } from 'zod'
import { GROUP_FAILOVER_POLICIES, GROUP_ON_DEACTIVATE, writeGroup, type GroupEntry } from './groups'
import { activateGroup, deactivateGroup, deleteGroup, listAllGroups, previewActivateGroup, saveGroup, type GroupsHost } from './groups-service'
import type { ApplyDeps } from './apply'

/**
 * The six group routes — plan 122 §5 step 122.8's own "the tab itself" plus
 * its CRUD/activation, plus `group-activate-preview` (the gap fix, 2026-08-21
 * — see `groups-service.ts`'s own header). Mirrors `apply-routes.ts`'s own
 * shape (one `onRequest` id per verb, never one shared handler, every
 * refusal answered `200`-shaped `{ ok: false, code, message }` rather than
 * thrown).
 *
 * | method + path | handler id | permission |
 * |---|---|---|
 * | `GET  …/http/groups` | `groups` | `script.view` |
 * | `PUT  …/http/group-save` | `group-save` | `plugin.data` |
 * | `DELETE …/http/group-delete` | `group-delete` | `plugin.data` |
 * | `POST …/http/group-activate-preview` | `group-activate-preview` | `script.view` |
 * | `POST …/http/group-activate` | `group-activate` | `plugin.runtime` |
 * | `POST …/http/group-deactivate` | `group-deactivate` | `plugin.runtime` |
 *
 * `groups` is `script.view`, the same permission every read-only route in
 * this plugin already uses. `group-save`/`group-delete` are `plugin.data` —
 * `apply-routes.ts`'s own header draws the contrast this plugin follows
 * throughout: `plugin.data` is for editing one of THIS plugin's own records
 * (a group, like `config`/`router`/`assignment`), never for an action that
 * changes what the router is doing. `group-activate`/`group-deactivate` ARE
 * exactly that action — `plugin.runtime`, `apply`'s own precedent — because
 * unlike `config`/`router`/`assignment` (written straight from the browser
 * through the core's generic `.../data/entry` route, since none of those
 * carry an invariant a plugin has to enforce), a GROUP save has one (no
 * duplicate device — acceptance criterion 12), which the generic route has
 * no hook to check. That is the whole reason groups get their own routes
 * where single assignments do not. `group-activate-preview` is `script.view`,
 * not `plugin.runtime` — `apply-routes.ts`'s own `plan` route is the direct
 * precedent (a `POST` that computes and returns a diff, never writes, gated
 * on the same permission that already opened this screen).
 */

const GroupEntryInputSchema = z.object({ deviceId: z.string().min(1), lanIp: z.string(), pathId: z.string().min(1) })

const SaveGroupBodySchema = z.object({
  id: z.string().default(''),
  name: z.string(),
  note: z.string().default(''),
  entries: z.array(GroupEntryInputSchema).default([]),
  onDeactivate: z.enum(GROUP_ON_DEACTIVATE).default('remove-rules'),
  failoverPolicy: z.enum(GROUP_FAILOVER_POLICIES).default('none'),
})

const ActivateBodySchema = z.object({ id: z.string().min(1), force: z.boolean().default(false) })
const IdBodySchema = z.object({ id: z.string().min(1) })

function badBody(message: string): PluginResponse {
  return { body: { ok: false, code: 'E_BAD_REQUEST', message } }
}

export interface GroupsRoutesHost extends GroupsHost {
  onRequest(
    id: string,
    handler: (request: PluginRequest, signal: AbortSignal) => PluginResponse | void | Promise<PluginResponse | void>,
    opts?: { permission?: string; methods?: readonly ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[]; timeoutMs?: number; description?: string },
  ): void
}

export const GROUP_ROUTES = { list: 'groups', save: 'group-save', delete: 'group-delete', activatePreview: 'group-activate-preview', activate: 'group-activate', deactivate: 'group-deactivate' } as const

export const GROUP_ROUTE_PERMISSIONS: Record<keyof typeof GROUP_ROUTES, string> = {
  list: 'script.view',
  save: 'plugin.data',
  delete: 'plugin.data',
  activatePreview: 'script.view',
  activate: 'plugin.runtime',
  deactivate: 'plugin.runtime',
}

export function registerGroupRoutes(host: GroupsRoutesHost, deps: ApplyDeps = {}): void {
  host.onRequest(
    GROUP_ROUTES.list,
    async () => {
      const groups = await listAllGroups(host)
      // `writeGroup` already carries `id` (§4.9: never re-derived — it always
      // comes from the KV key, per `groups.ts`'s own `readGroup`).
      return { body: { ok: true, items: groups.map(writeGroup) } }
    },
    { methods: ['GET'], permission: GROUP_ROUTE_PERMISSIONS.list, description: 'Every saved group (§4.9) — name, entries, active state, onDeactivate/failoverPolicy.' },
  )

  host.onRequest(
    GROUP_ROUTES.save,
    async (request) => {
      const parsed = SaveGroupBodySchema.safeParse(request.body)
      if (!parsed.success) return badBody(z.prettifyError(parsed.error))
      const entries: GroupEntry[] = parsed.data.entries
      const result = await saveGroup(host, { ...parsed.data, entries })
      return { body: result }
    },
    { methods: ['PUT'], permission: GROUP_ROUTE_PERMISSIONS.save, description: 'Create or update a group — refuses a duplicate device inside its own entries at save time (acceptance criterion 12).' },
  )

  host.onRequest(
    GROUP_ROUTES.delete,
    async (request) => {
      const parsed = IdBodySchema.safeParse({ id: request.query.id })
      if (!parsed.success) return badBody(z.prettifyError(parsed.error))
      const result = await deleteGroup(host, parsed.data.id)
      return { body: result }
    },
    { methods: ['DELETE'], permission: GROUP_ROUTE_PERMISSIONS.delete, description: 'Delete a group — refused while it is active (deactivate it first).' },
  )

  host.onRequest(
    GROUP_ROUTES.activatePreview,
    async (request) => {
      const parsed = ActivateBodySchema.safeParse(request.body)
      if (!parsed.success) return badBody(z.prettifyError(parsed.error))
      const result = await previewActivateGroup(host, parsed.data.id, parsed.data.force, deps)
      return { body: result }
    },
    {
      methods: ['POST'],
      permission: GROUP_ROUTE_PERMISSIONS.activatePreview,
      description: 'A non-mutating preview of what group-activate would do — the §4.4 plan, the decideActivation outcome, and the §3.2 local-exception state. Never writes.',
    },
  )

  host.onRequest(
    GROUP_ROUTES.activate,
    async (request) => {
      const parsed = ActivateBodySchema.safeParse(request.body)
      if (!parsed.success) return badBody(z.prettifyError(parsed.error))
      const result = await activateGroup(host, parsed.data.id, parsed.data.force, deps)
      return { body: result }
    },
    { methods: ['POST'], permission: GROUP_ROUTE_PERMISSIONS.activate, description: 'The §4.6 activation transaction — refuses on an unresolved conflict unless force is true, in which case the conflicting groups are deactivated first, in the same operation.' },
  )

  host.onRequest(
    GROUP_ROUTES.deactivate,
    async (request) => {
      const parsed = IdBodySchema.safeParse(request.body)
      if (!parsed.success) return badBody(z.prettifyError(parsed.error))
      const result = await deactivateGroup(host, parsed.data.id, deps)
      return { body: result }
    },
    { methods: ['POST'], permission: GROUP_ROUTE_PERMISSIONS.deactivate, description: 'Removes or disables (per onDeactivate) exactly this group’s own managed rules and clears its per-device assignment notes.' },
  )
}
