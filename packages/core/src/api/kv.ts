import { Hono } from 'hono'
import { z } from 'zod'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { KvEntry, KvScope, KvStore } from '../kv/store'
import { EnkakuError } from '../util/errors'

/**
 * `GET/PUT/DELETE /api/kv` (plan 79 §4.3, step 4) — admin-scoped
 * (`kv.manage`, not in the operator set: `auth/acl.ts`), since a value
 * stored here can be a secret readable in plaintext through this exact
 * surface (the `GET /entry` path, when the entry is NOT secret — a secret
 * entry is always redacted to its hint, criterion 4). Nothing here ever
 * hands `ctx.kv`'s decrypted secret value back over HTTP: `redactEntry`
 * below is applied to every response this file returns, without exception.
 */

const ScopeKindSchema = z.enum(['global', 'device'])

function parseScope(scope: unknown, stableId: unknown): KvScope {
  const kind = ScopeKindSchema.safeParse(scope)
  if (!kind.success) throw new EnkakuError('E_BAD_REQUEST', 'scope must be "global" or "device"')
  if (kind.data === 'global') return { kind: 'global' }
  if (typeof stableId !== 'string' || stableId.length === 0) {
    throw new EnkakuError('E_BAD_REQUEST', 'stableId is required when scope is "device"')
  }
  return { kind: 'device', stableId }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new EnkakuError('E_BAD_REQUEST', `${name} is required`)
  return value
}

/** Applied to EVERY entry this route returns — and to every entry `api/plugins.ts`'s
 * `/:name/data/*` routes return too (plan 108 §4.5, which imports this exact function rather
 * than writing a second one: one redaction boundary, no second copy to drift). A secret's
 * plaintext is never sent, only its hint
 * (criterion 4, criterion 10 for `list`). `store.get()`/`.set()`/`.setIfVersion()` all decrypt a
 * secret internally (that is what makes `ctx.kv` usable from a job); this is the boundary that
 * makes sure the HTTP response never carries that decrypted value onward. */
export function redactEntry(entry: KvEntry): Omit<KvEntry, 'value'> & { value: unknown } {
  return { ...entry, value: entry.secret ? null : entry.value }
}

const WriteBody = z.object({
  scope: ScopeKindSchema,
  stableId: z.string().optional(),
  namespace: z.string().min(1),
  key: z.string().min(1),
  value: z.unknown(),
  secret: z.boolean().optional(),
  ttlSec: z.number().int().positive().optional(),
  ifVersion: z.number().int().optional(),
})

export function createKvRoutes(deps: { store: KvStore; audit: AuditLogger }): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()
  const { store, audit } = deps

  app.get('/', requirePermission('kv.manage'), (c) => {
    const q = c.req.query()
    const scope = parseScope(q.scope, q.stableId)
    const namespace = requireString(q.namespace, 'namespace')
    const limitParam = q.limit ? Number.parseInt(q.limit, 10) : 50
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50
    const page = store.list(scope, namespace, { prefix: q.prefix, limit, cursor: q.cursor ?? null })
    return c.json({ items: page.items.map(redactEntry), nextCursor: page.nextCursor })
  })

  app.get('/entry', requirePermission('kv.manage'), (c) => {
    const q = c.req.query()
    const scope = parseScope(q.scope, q.stableId)
    const namespace = requireString(q.namespace, 'namespace')
    const key = requireString(q.key, 'key')
    const entry = store.get(scope, namespace, key)
    if (!entry) throw new EnkakuError('E_NOT_FOUND', `no such kv entry: ${key}`)
    return c.json(redactEntry(entry))
  })

  app.put('/entry', requirePermission('kv.manage'), async (c) => {
    const parsed = WriteBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const body = parsed.data
    const scope = parseScope(body.scope, body.stableId)
    const opts = { secret: body.secret, ttlSec: body.ttlSec }

    let entry: KvEntry | null
    if (body.ifVersion !== undefined) {
      entry = store.setIfVersion(scope, body.namespace, body.key, body.value, body.ifVersion, opts)
      if (!entry) throw new EnkakuError('E_STALE', `"${body.key}" changed since the given version (${body.ifVersion})`)
    } else {
      entry = store.set(scope, body.namespace, body.key, body.value, opts)
    }

    audit.record({
      userId: c.get('user')?.id ?? null,
      action: 'kv.set',
      target: body.key,
      // Never the value — even for a non-secret entry, this is an admin write surface and the
      // audit log is not the place to duplicate arbitrary script state.
      meta: { scope: body.scope, stableId: body.stableId ?? null, namespace: body.namespace, secret: !!body.secret },
    })
    return c.json(redactEntry(entry), 200)
  })

  app.delete('/entry', requirePermission('kv.manage'), (c) => {
    const q = c.req.query()
    const scope = parseScope(q.scope, q.stableId)
    const namespace = requireString(q.namespace, 'namespace')
    const key = requireString(q.key, 'key')
    const ifVersion = q.ifVersion ? Number.parseInt(q.ifVersion, 10) : undefined
    const deleted = store.delete(scope, namespace, key, { ifVersion })
    audit.record({
      userId: c.get('user')?.id ?? null,
      action: 'kv.delete',
      target: key,
      meta: { scope: q.scope, stableId: q.stableId ?? null, namespace, deleted },
    })
    return c.json({ ok: deleted })
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      const status = err.code === 'E_NOT_FOUND' ? 404 : err.code === 'E_STALE' ? 409 : err.code === 'E_BAD_REQUEST' ? 400 : err.code.startsWith('E_KV_') ? 400 : 500
      return c.json(err.toJSON(), status as never)
    }
    throw err
  })

  return app
}
