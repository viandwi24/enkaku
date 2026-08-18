import { z } from 'zod'

/**
 * `/api/kv` (plan 79 §4.3). A secret entry's `value` is redacted to `null` by
 * the core (`redactEntry`, `packages/core/src/api/kv.ts`) on every route in
 * that file **except** `POST /api/kv/entry/reveal`, whose entire purpose is to
 * hand one named secret's plaintext back to an admin and write an audit row
 * saying so (`KvRevealResponseSchema`, at the bottom of this file). So
 * `KvEntrySchema.value` below still reflects a wire shape that never carries a
 * secret's plaintext — the reveal has its OWN response schema rather than
 * reusing this one, which is what keeps "a `KvEntry` never holds a secret's
 * plaintext" a property a renderer can rely on. Studio renders `hint` plus a
 * `secret: true` marker for a secret row, never `value` (plan 79 §3.4).
 */
export const KvEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  secret: z.boolean(),
  /**
   * `null` for a plain row — and ALSO for a secret row whose write asked for no hint
   * (`KvSetOptions.hint: false`, plan 112 step 112.2: the hint is `${first 7}…${last 4}` of the
   * plaintext, which is a disclosure when the secret is a credential rather than a prefixed API
   * key). So `secret: true` with `hint: null` is a normal, expected row — a renderer must show the
   * secret marker with no hint beside it, never treat the null as missing data. It is now the
   * COMMON case for a row written through Studio's KV panel, which sends `hint: false` for a
   * secret unless the operator asks for one.
   */
  hint: z.string().nullable(),
  version: z.number(),
  expiresAt: z.number().nullable(),
  updatedAt: z.number(),
})
export type KvEntry = z.infer<typeof KvEntrySchema>

/** `GET /api/kv?scope=&namespace=&...`. */
export const KvListResponseSchema = z.object({
  items: z.array(KvEntrySchema),
  nextCursor: z.string().nullable(),
})

/** `GET/PUT /api/kv/entry`. */
export const KvEntryResponseSchema = KvEntrySchema

/** `DELETE /api/kv/entry`. */
export const KvDeleteResponseSchema = z.object({ ok: z.boolean() })

/**
 * One row of `GET /api/kv/namespaces` — a namespace that actually has live entries in the queried
 * scope, plus its counts.
 *
 * **Metadata only, by construction.** There is no key, no value, and no `hint` in this shape and
 * none may be added: the index exists so a browsing surface can offer a picker instead of a text
 * box, and widening it into a preview would make an enumeration route into a disclosure route.
 * `secrets` is a COUNT, never a list — `KvEntrySchema.secret` above is already how a secret row is
 * identified once someone actually browses the namespace.
 */
export const KvNamespaceSchema = z.object({
  namespace: z.string(),
  /** Live (non-expired) entries under this namespace in the queried scope. */
  entries: z.number(),
  /** How many of `entries` are secret. Never greater than `entries`; `0` is the common case. */
  secrets: z.number(),
})
export type KvNamespace = z.infer<typeof KvNamespaceSchema>

/**
 * `GET /api/kv/namespaces?scope=global` / `?scope=device&stableId=…`.
 *
 * An EMPTY `items` is a real, meaningful answer — "nothing is stored in this scope" — and is not
 * the same fact as "no namespace has been chosen to browse yet". A surface that renders both the
 * same way is the defect this route was added to fix, not a cosmetic one.
 */
export const KvNamespacesResponseSchema = z.object({ items: z.array(KvNamespaceSchema) })

/**
 * `POST /api/kv/entry/reveal` — the ONE response in the KV surface that carries
 * a stored secret's plaintext, and the second in this package overall (the
 * other is `DeviceNetworkCredentialRevealResponseSchema`, which this shape is
 * deliberately modelled on rather than invented beside).
 *
 * **Why a separate schema, and a separate route.** Not a `?reveal=1` flag on
 * `GET /api/kv/entry` and not a widened `KvEntrySchema`: a flag is something a
 * future caller sets by accident, and a shared shape makes "did this response
 * carry a plaintext?" a question about a query parameter rather than about
 * which endpoint was called. The audit row would inherit the same ambiguity.
 * With this shape, a response holding a plaintext is a response from exactly
 * one route.
 *
 * **What it costs to be here.** The value is AES-256-GCM at rest, not a hash,
 * and `secrets.key` sits in the data directory beside `enkaku.db` — anyone
 * holding `kv.manage` can already open every secret in the farm with
 * `sqlite3`. A UI that refuses to show them protects nothing against that
 * person; it only pushes them onto a path that leaves no trace. So the door is
 * open, admin-only (`kv.manage`), single-purpose, and audited: the core writes
 * a `kv.reveal` row — actor, scope, namespace, key, outcome, never the value —
 * before this body is serialised, on refusals too.
 *
 * That reasoning reaches `kv.manage` and stops there. It is not an argument for
 * relaxing anything on `/api/plugins/:name/data*`, which is operator-level and
 * serves plugin UIs, not admins.
 *
 * `list()` is untouched and stays untouched: no listing anywhere decrypts.
 */
export const KvRevealResponseSchema = z.object({
  /** Echoed back so a client can be certain which row answered — the caller named it, but a UI holding several open should not have to trust its own bookkeeping. */
  namespace: z.string(),
  key: z.string(),
  /** The decrypted value, exactly as a job's `ctx.kv.get()` would see it — a string for a credential, but any JSON a script stored. Never logged, never cached, never persisted by a client. */
  value: z.unknown(),
  /** The row's version at the moment it was read, so a caller that goes on to rewrite the value can pass it as `ifVersion`. */
  version: z.number().int(),
  /** Unix seconds the reveal was recorded at — the same instant the audit row carries, so an operator can find their own row. */
  revealedAt: z.number().int(),
})
export type KvRevealResponse = z.infer<typeof KvRevealResponseSchema>
