import { Hono } from 'hono'
import { z } from 'zod'
import { AdbShortcutResponseSchema, AdbShortcutsResponseSchema, type ShellMode } from '@enkaku/protocol'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { canUseShell } from '../auth/acl'
import type { Db } from '../db'
import { createAdbShortcut, deleteAdbShortcut, listAdbShortcuts, updateAdbShortcut } from '../registry/adb-shortcuts'
import { EnkakuError } from '../util/errors'
import { typedJson } from './typed-json'

const CreateBody = z.object({ name: z.string().min(1), cmd: z.string().min(1).max(4096) })
const PatchBody = z.object({ name: z.string().min(1).optional(), cmd: z.string().min(1).max(4096).optional() })

const ERROR_STATUS: Record<string, number> = {
  'auth.forbidden': 403,
  shortcut_not_found: 404,
  shortcut_exists: 409,
  E_LIMIT: 409,
  E_BAD_REQUEST: 400,
}

/**
 * The farm's saved adb commands (`GET/POST/PATCH/DELETE /api/adb/shortcuts`).
 *
 * ## Who may read, and who may write
 *
 * Reading is open to anyone the auth middleware admitted. A shortcut's name
 * and command are not a secret — they are the farm's vocabulary, and every
 * device menu draws them — and gating the read would put an operator in front
 * of a submenu they cannot see the contents of.
 *
 * Writing is gated on `canUseShell`, the SAME door the `adb` action verb goes
 * through (`actions/verbs.ts`), rather than on an ACL permission of its own.
 * That is the whole reason this store exists: shortcuts lived in
 * `localStorage` because the only server store the core had was `/api/kv`,
 * gated on the admin-only `kv.manage`, so the operator who runs adb commands
 * all day could not have saved one. Anyone who may RUN a command may save it
 * under a name; anyone who may not is refused here, in the same words and by
 * the same rule.
 *
 * Saving a shortcut never runs anything, so there is no device, no activity
 * policy and no target in any of these routes — running one is the `adb` verb,
 * unchanged, with the shortcut's `cmd` as its parameter.
 */
export function createAdbShortcutRoutes(deps: {
  db: Db
  audit: AuditLogger
  shellSettings: () => { mode: ShellMode }
}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { db } = deps

  /** Throws unless the caller may run adb commands on this farm at all. */
  function requireShell(c: { get: (k: 'user') => { id: string; role: 'admin' | 'operator' } | undefined }): string | null {
    const user = c.get('user')
    if (!user || !canUseShell(user.role, deps.shellSettings().mode)) {
      throw new EnkakuError('auth.forbidden', 'saving an adb shortcut needs the same permission as running an adb command')
    }
    return user.id
  }

  app.get('/', (c) => typedJson(c, AdbShortcutsResponseSchema, { shortcuts: listAdbShortcuts(db) }))

  app.post('/', async (c) => {
    const userId = requireShell(c)
    const body = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a body of { name, cmd } is required')
    const shortcut = createAdbShortcut(db, { ...body.data, userId })
    deps.audit.record({ userId, action: 'adb.shortcut', target: shortcut.id, meta: { op: 'save', name: shortcut.name, cmd: shortcut.cmd } })
    return typedJson(c, AdbShortcutResponseSchema, { shortcut }, 201)
  })

  app.patch('/:id', async (c) => {
    const userId = requireShell(c)
    const id = c.req.param('id')
    const body = PatchBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'invalid body')
    const shortcut = updateAdbShortcut(db, id, body.data)
    deps.audit.record({ userId, action: 'adb.shortcut', target: id, meta: { op: 'update', patch: Object.keys(body.data) } })
    return typedJson(c, AdbShortcutResponseSchema, { shortcut })
  })

  app.delete('/:id', (c) => {
    const userId = requireShell(c)
    const shortcut = deleteAdbShortcut(db, c.req.param('id'))
    deps.audit.record({ userId, action: 'adb.shortcut', target: shortcut.id, meta: { op: 'delete', name: shortcut.name } })
    return c.body(null, 204)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    }
    if (err instanceof z.ZodError) {
      return c.json(new EnkakuError('E_BAD_REQUEST', err.issues.map((i) => i.message).join('; ')).toJSON(), 400)
    }
    throw err
  })

  return app
}
