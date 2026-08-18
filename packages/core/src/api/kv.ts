import { Hono } from 'hono'
import { z } from 'zod'
import { can } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { KvEntry, KvScope, KvStore } from '../kv/store'
import { EnkakuError } from '../util/errors'

/**
 * `GET/PUT/DELETE /api/kv` (plan 79 §4.3, step 4), plus `GET /api/kv/namespaces`
 * (the index, added after the store shipped without one) and
 * `POST /api/kv/entry/reveal` (the audited door onto one secret's plaintext) —
 * admin-scoped throughout (`kv.manage`, not in the operator set:
 * `auth/acl.ts`).
 *
 * **`redactEntry` still applies to every response in this file but one.** The
 * exception is `POST /entry/reveal`, and it is an exception on purpose rather
 * than a leak: see that handler for the argument. Every other route here —
 * the listing, the index, `GET /entry`, the `PUT` echo — redacts a secret's
 * `value` to `null`, and `list()` never decrypts at any layer for any caller.
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

/** Applied to every entry this route returns EXCEPT `POST /entry/reveal`'s own body — and to every
 * entry `api/plugins.ts`'s `/:name/data/*` routes return too (plan 108 §4.5, which imports this
 * exact function rather than writing a second one: one redaction boundary, no second copy to
 * drift). A secret's plaintext is never sent by a listing, an index, a `GET`, or a write echo,
 * only its hint (criterion 4, criterion 10 for `list`). `store.get()`/`.set()`/`.setIfVersion()`
 * all decrypt a secret internally (that is what makes `ctx.kv` usable from a job); this is the
 * boundary that makes sure an ordinary HTTP response never carries that decrypted value onward.
 *
 * The reveal route does not call this, and must not be made to: a redaction boundary with a
 * conditional in it is a boundary that can be argued with. It is bypassed by one named handler,
 * visibly, rather than weakened for all of them. */
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
  /**
   * Whether a `secret` write also stores its display hint (hotfix 96.38, closing the gap plan 112
   * step 112.2 left on this one route). Absent means `true` — `kv/store.ts`'s `KvSetOptions.hint`
   * default — so a body written before this field existed produces a byte-identical row.
   *
   * Why it had to exist here and not only on `PUT /api/plugins/:name/data/entry`: the flag is per
   * WRITE, not per key. A credential a plugin stored correctly with `hint: false` holds
   * `hint: null` until somebody edits that same key from the admin KV surface — at which point
   * `${first 7}…${last 4}` of the plaintext came back on the row, in the clear, readable by every
   * unaudited listing, with nothing said. Adding an audited reveal route below while leaving that
   * in place would have been a careful door onto a value that was already leaking eleven of its
   * characters through the wall.
   *
   * Ignored when `secret` is false — a non-secret row has never had a hint.
   */
  hint: z.boolean().optional(),
  ttlSec: z.number().int().positive().optional(),
  ifVersion: z.number().int().optional(),
})

/** `POST /entry/reveal`. The same four fields that address a row anywhere else in this file, and
 * nothing else — there is no option, no format, and no flag to get wrong. */
const RevealBody = z.object({
  scope: ScopeKindSchema,
  stableId: z.string().optional(),
  namespace: z.string().min(1),
  key: z.string().min(1),
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

  /**
   * `GET /namespaces?scope=global` / `?scope=device&stableId=…` — the index this surface went
   * without for two plans. Without it `GET /` is a lookup with no directory: the caller has to
   * already know the namespace, an operator has no runtime injecting one for them, and a farm with
   * five populated namespaces reads as an empty store (the exact report this route answers).
   *
   * Same `kv.manage` gate as every other route in this file, and deliberately NOT weaker: the
   * shape below is metadata only — a namespace name and two counts, never a key, never a value,
   * and never a `hint` — but the set of plugin ids that have written data, per device, is still
   * farm state, and splitting one surface across two permissions to save an admin one click is not
   * a trade worth making.
   *
   * Nothing here needs `redactEntry`, because nothing here carries an entry.
   */
  app.get('/namespaces', requirePermission('kv.manage'), (c) => {
    const q = c.req.query()
    const scope = parseScope(q.scope, q.stableId)
    return c.json({ items: store.namespaces(scope) })
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

  /**
   * `POST /api/kv/entry/reveal` — reads ONE named secret back in plaintext, on
   * request, and writes down that it happened.
   *
   * **This reverses a stated posture, and the reversal is the point.** The
   * panel used to say a secret is "never shown again", and a farm owner who had
   * stored a SOAX proxy URL, username and password through it had no way to
   * read back which session a phone was on, hand it to a colleague, or rotate
   * it. The farm had swallowed it.
   *
   * **The value was never actually withheld from this caller.** `secret: true`
   * is AES-256-GCM at rest, not a hash, and `secrets.key` sits in the data
   * directory **beside `enkaku.db`** (`secrets/store.ts`'s own header;
   * `docs/feat/kv-storage.md` §4). Anyone holding `kv.manage` can already open
   * every secret in the farm with `sqlite3` and a five-line script. A UI that
   * refuses to show them protects nothing against that person — it only pushes
   * them onto a path that leaves no trace, no row, no name, no timestamp. The
   * right move is not to keep the door shut; it is to make the door explicit,
   * single-purpose, and audited.
   *
   * **That argument reaches `kv.manage` and stops there.** It justifies this
   * route for an admin who can already read the database file. It is NOT an
   * argument for relaxing anything on `api/plugins.ts`'s operator-level
   * `plugin.data` routes, which serve plugin UIs rather than administrators and
   * whose holders have no such standing access.
   *
   * **Why POST, and why a route of its own rather than `?reveal=1` on `GET
   * /entry`.** A flag is set by accident — by a future caller copying a URL, by
   * a client that forwards its query string, by a well-meant "just add the
   * parameter" — and every one of those produces an audit row that is
   * indistinguishable from a deliberate reveal. A separate path cannot be
   * arrived at by accident, and its audit row means exactly one thing. POST
   * rather than GET for the usual reasons a body beats a URL for this: a GET's
   * URL lands in access logs, proxy logs, browser history and `Referer`
   * headers, is prefetchable and revalidatable, and reads as safe to repeat.
   * The side effect here is the audit row, and a side effect belongs on a POST.
   *
   * **`list()` is not touched and must never be.** No listing anywhere
   * decrypts, for any caller, on any flag — that is one of the three properties
   * `docs/feat/kv-storage.md` §4 states hold regardless, and this route was
   * built so it stays true. Reveal answers one named key at a time; there is no
   * bulk form and no plural shape to add one to.
   *
   * **It refuses a non-secret row by name.** A plain row's value is already in
   * the listing and in `GET /entry`, so answering it here would buy the caller
   * nothing and cost the audit log everything: callers would route ordinary
   * reads through reveal, and `kv.reveal` would stop meaning "somebody read a
   * secret".
   *
   * **The gate is checked inside the handler, not by `requirePermission`
   * middleware** — the same shape `POST /api/devices/:id/network/credential/reveal`
   * uses, and for the same reason: middleware answers 403 before any handler
   * body runs, and a refusal that leaves no trace is the half of the log that
   * matters most. Every request that reaches this handler writes exactly one
   * row.
   *
   * **The plaintext exists in this response body and nowhere else.** Not in a
   * log line (at any level, on any path), not in an error message, not in the
   * audit row, and not in a cache — `Cache-Control: no-store` says so to every
   * hop in between. `buildSecretRedactor` does not help here: it redacts job
   * LOG lines by value-match and has no view of an HTTP response.
   */
  app.post('/entry/reveal', async (c) => {
    const user = c.get('user')
    const actor = user?.id ?? null
    const revealedAt = Math.floor(Date.now() / 1000)

    /**
     * One row per request, whatever happened. `meta` names the outcome and the
     * coordinates of the row — scope, stableId, namespace — and `target` is the
     * key. Never the value, and nothing derived from it: not a hint, not a
     * length, not a prefix. An audit row is read by more people, in more
     * places, than the response body ever is.
     */
    const recordAttempt = (outcome: string, at: { namespace?: string; key?: string; scope?: unknown; stableId?: string | null } = {}, extra: Record<string, unknown> = {}): void => {
      audit.record({
        userId: actor,
        action: 'kv.reveal',
        ...(at.key !== undefined ? { target: at.key } : {}),
        meta: {
          outcome,
          role: user?.role ?? null,
          scope: at.scope ?? null,
          stableId: at.stableId ?? null,
          namespace: at.namespace ?? null,
          ...extra,
        },
      })
    }

    if (!user || !can(user.role, 'kv.manage')) {
      recordAttempt('forbidden')
      return c.json(
        {
          error: {
            code: 'auth.forbidden',
            message:
              'reading a stored secret back in plaintext requires the kv.manage permission, which is admin-only. Ask an admin — the reveal is recorded under their name.',
          },
        },
        403,
      )
    }

    const parsed = RevealBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      recordAttempt('bad-request')
      throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    }
    const body = parsed.data
    const at = { namespace: body.namespace, key: body.key, scope: body.scope, stableId: body.stableId ?? null }
    let scope: KvScope
    try {
      // `scope: 'device'` with no `stableId` passes `RevealBody` (the field is legitimately absent
      // at global scope) and fails here. Recorded rather than thrown straight through, so the
      // "exactly one row per request that reaches this handler" property holds on this path too.
      scope = parseScope(body.scope, body.stableId)
    } catch (err) {
      recordAttempt('bad-request', at)
      throw err
    }

    let entry: KvEntry | null
    try {
      entry = store.get(scope, body.namespace, body.key)
    } catch (err) {
      // Only the CODE crosses over — a corrupt box, a key file written by another farm, a row that
      // predates the current key. Nothing from the crypto layer is re-thrown or serialised: an
      // error object from anywhere near a plaintext is treated as if it carried one (plan 112 §0's
      // measured hazard, where the `socks` library hangs a password off `err.options`).
      const code = err instanceof EnkakuError ? err.code : 'E_SECRET_UNREADABLE'
      recordAttempt('unreadable', at, { code })
      throw new EnkakuError(
        code,
        `"${body.key}" is stored encrypted but could not be decrypted with this farm's key — the value is unreadable, not merely hidden. Write it again to replace it.`,
      )
    }

    if (!entry) {
      recordAttempt('not-found', at)
      throw new EnkakuError('E_NOT_FOUND', `no such kv entry: ${body.key}`)
    }
    if (!entry.secret) {
      recordAttempt('not-secret', at)
      throw new EnkakuError(
        'E_BAD_REQUEST',
        `"${body.key}" is not a secret — its value is already returned in full by GET /api/kv and GET /api/kv/entry. Reveal answers only for secret rows, so that a kv.reveal audit row always means somebody read a secret.`,
      )
    }

    // Recorded BEFORE the body is serialised, and deliberately not in a `finally`: if the audit
    // insert throws, this request fails and the plaintext is never returned. An unaudited reveal is
    // not a degraded success — it is the one outcome this route must not have, since being recorded
    // is the whole justification for the route existing.
    recordAttempt('revealed', at)

    // `no-store`, not `no-cache`: the difference is that `no-cache` permits storing the body and
    // revalidating it, which for this body means writing a secret to a disk cache.
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    return c.json({ namespace: body.namespace, key: entry.key, value: entry.value, version: entry.version, revealedAt })
  })

  app.put('/entry', requirePermission('kv.manage'), async (c) => {
    const parsed = WriteBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new EnkakuError('E_BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '))
    const body = parsed.data
    const scope = parseScope(body.scope, body.stableId)
    const opts = { secret: body.secret, hint: body.hint, ttlSec: body.ttlSec }

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
      // audit log is not the place to duplicate arbitrary script state. `hint` is a boolean about
      // whether a fragment was stored, never the fragment.
      meta: {
        scope: body.scope,
        stableId: body.stableId ?? null,
        namespace: body.namespace,
        secret: !!body.secret,
        ...(body.secret ? { hint: body.hint ?? true } : {}),
      },
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
