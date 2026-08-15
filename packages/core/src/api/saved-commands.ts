import { Hono } from 'hono'
import { z } from 'zod'
import {
  CommandTargetSchema,
  SavedCommandDeleteResponseSchema,
  SavedCommandListResponseSchema,
  SavedCommandResponseSchema,
  type FarmSettings,
} from '@enkaku/protocol'
import { canUseShell } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Role } from '../auth/service'
import { createSavedCommand, deleteSavedCommand, getSavedCommand, listSavedCommands, updateSavedCommand } from '../command-console/saved'
import type { Db } from '../db'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

/**
 * `GET/POST/PATCH/DELETE /api/saved-commands[/:id]` (plan 93 §3.10, §4.4,
 * step 93.6) — a farm-scoped, team-owned saved command.
 *
 * **Gates, per §4.4's own table:**
 * - `GET` needs `device.view` — the static `requirePermission` middleware,
 *   the same read-only gate every other list in this package uses.
 * - `POST`/`PATCH`/`DELETE` all need `canUseShell(role, shell.mode)`,
 *   evaluated HERE rather than via `requirePermission` because it depends
 *   on the farm's LIVE `shell.mode` setting, not the static ACL matrix
 *   alone — the identical reasoning `api/command-runs.ts`'s own gate
 *   already documents. §3.10, verbatim: "you may not save a command you
 *   could not run."
 * - `PATCH`/`DELETE` ALSO require the saved command's own creator or an
 *   admin, exactly as `api/command-runs.ts`'s cancel/continue/delete routes
 *   already require for a command RUN.
 *
 * **Not yet mounted.** `packages/core/src/server/http.ts` — held by a
 * concurrent worker (plan 94 step 94.5) at the time this step landed — does
 * not yet declare `HttpDeps.savedCommandRoutes` or route it under
 * `/api/saved-commands`, so `createSavedCommandRoutes` below is exercised
 * directly by `saved-commands.test.ts` and is not yet reachable over HTTP
 * in a real boot. `saved-commands-mount.test.ts` (this step, self-detecting
 * per the brief) names the exact two edits `http.ts` still needs and fails
 * — by design — until they land.
 */

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  cmd: z.string().min(1).max(4096),
  defaultTarget: CommandTargetSchema.nullable().optional(),
})

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  cmd: z.string().min(1).max(4096).optional(),
  defaultTarget: CommandTargetSchema.nullable().optional(),
})

const ERROR_STATUS: Record<string, number> = {
  'auth.forbidden': 403,
  saved_command_not_found: 404,
  saved_command_name_exists: 409,
  E_SAVED_COMMAND_LIMIT: 409,
  E_BAD_REQUEST: 400,
  E_DB: 500,
}

export interface SavedCommandRoutesDeps {
  db: Db
  settings: () => FarmSettings['shell']
  roleOf: (userId: string | null) => Role
  audit?: AuditLogger
}

interface Actor {
  userId: string | null
  role: Role
}

export function createSavedCommandRoutes(deps: SavedCommandRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  const actorOf = (userId: string | null): Actor => ({ userId, role: deps.roleOf(userId) })

  const requireCanUseShell = (actor: Actor): void => {
    if (!canUseShell(actor.role, deps.settings().mode)) {
      throw new EnkakuError('auth.forbidden', 'shell access is turned off for this farm')
    }
  }

  const isOwnerOrAdmin = (actor: Actor, createdBy: string | null): boolean =>
    actor.role === 'admin' || (createdBy !== null && createdBy === actor.userId)

  const mustGet = (id: string) => {
    const saved = getSavedCommand(deps.db, id)
    if (!saved) throw new EnkakuError('saved_command_not_found', 'no such saved command')
    return saved
  }

  app.get('/', requirePermission('device.view'), (c) => {
    const items = listSavedCommands(deps.db)
    return typedJson(c, SavedCommandListResponseSchema, { items })
  })

  app.post('/', async (c) => {
    const actor = actorOf(c.get('user')?.id ?? null)
    requireCanUseShell(actor)
    const body = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const savedCommand = createSavedCommand(
      deps.db,
      {
        name: body.data.name,
        description: body.data.description ?? null,
        cmd: body.data.cmd,
        defaultTarget: body.data.defaultTarget ?? null,
        createdBy: actor.userId,
      },
      deps.settings().savedCommandLimit,
    )
    deps.audit?.record({ userId: actor.userId, action: 'command.saved.create', target: savedCommand.id, meta: { name: savedCommand.name } })
    return typedJson(c, SavedCommandResponseSchema, { savedCommand }, 201)
  })

  app.patch('/:id', async (c) => {
    const actor = actorOf(c.get('user')?.id ?? null)
    requireCanUseShell(actor)
    const id = c.req.param('id')
    const existing = mustGet(id)
    if (!isOwnerOrAdmin(actor, existing.createdBy)) {
      throw new EnkakuError('auth.forbidden', "only this saved command's own creator or an admin may edit it")
    }
    const body = UpdateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const savedCommand = updateSavedCommand(deps.db, id, {
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.description !== undefined ? { description: body.data.description } : {}),
      ...(body.data.cmd !== undefined ? { cmd: body.data.cmd } : {}),
      ...(body.data.defaultTarget !== undefined ? { defaultTarget: body.data.defaultTarget } : {}),
    })
    deps.audit?.record({ userId: actor.userId, action: 'command.saved.update', target: savedCommand.id, meta: { name: savedCommand.name } })
    return typedJson(c, SavedCommandResponseSchema, { savedCommand })
  })

  app.delete('/:id', (c) => {
    const actor = actorOf(c.get('user')?.id ?? null)
    requireCanUseShell(actor)
    const id = c.req.param('id')
    const existing = mustGet(id)
    if (!isOwnerOrAdmin(actor, existing.createdBy)) {
      throw new EnkakuError('auth.forbidden', "only this saved command's own creator or an admin may delete it")
    }
    const deleted = deleteSavedCommand(deps.db, id)
    deps.audit?.record({ userId: actor.userId, action: 'command.saved.delete', target: id, meta: { name: deleted.name } })
    return typedJson(c, SavedCommandDeleteResponseSchema, { deleted: true })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
