import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { pluginWebhookPath, type PluginWebhookInfo } from '@enkaku/protocol'
import type { Db } from '../db'
import { pluginWebhooks, type PluginWebhookRow } from '../db/schema'
import { decryptNamespacedSecret, encryptNamespacedSecret } from '../secrets/store'
import { EnkakuError } from '../util/errors'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.7 — **where an inbound
 * webhook's secret lives, and what rotating one means.**
 *
 * ## The secret is the authorisation, so it is farm-held
 *
 * An inbound webhook is unauthenticated by construction: the caller is a third
 * party with no farm session, no cookie, and no role. There is no operator to
 * check a permission against, and inventing one would be a lie in the audit
 * log. So the signature IS the authorisation (plan 109 §3.7), which makes the
 * secret the only thing standing between a stranger and a plugin's handler —
 * and that puts three obligations on this module rather than on the plugin:
 *
 * 1. **The farm generates it.** 32 bytes from `randomBytes`, base64url. Never
 *    an operator-chosen string, because a webhook secret is not a password
 *    anyone has to remember.
 * 2. **It is write-only.** It is returned in full exactly once — by the call
 *    that generated it (`ensure`, `rotate`) or by an explicitly audited
 *    `reveal` — and by nothing else. `info()`/`list()` report that it exists
 *    and never what it is. **There is no hint**, and its absence is a decision:
 *    `secretHint` would put `${first 7}…${last 4}` on the row in clear, which
 *    is right for an API key with a public prefix an operator pasted in and is
 *    eleven characters of 32 random bytes here (plan 112 §0.1 F12; step 112.2
 *    adds `hint: false` for the other case, where a PLUGIN stores a credential
 *    of its own in KV). This module needs no such flag — the column does not
 *    exist.
 * 3. **It outlives the service.** It has to keep verifying while the plugin is
 *    stopped, reloading or `failed`, and it has to be rotatable then too, or
 *    criterion 13's "without reinstalling the plugin" is only true on a good
 *    day. Hence a table keyed on `plugins.name`, not a registration.
 *
 * ## Rotation keeps the old secret alive, on purpose
 *
 * This is the clause with teeth, so the reasoning is here rather than implied.
 *
 * The other end of a webhook is a system the farm cannot restart. Between
 * pressing Rotate and pasting the new value into GitHub there is a human, and
 * an instant cutover makes that gap a guaranteed outage of unknown length. The
 * predictable result is not careful rotation; it is that nobody rotates. So
 * the previous secret keeps verifying for `graceSec` — 24 hours by default —
 * and every accepted delivery records WHICH secret it used, so an operator can
 * see that the sender has not been updated yet instead of finding out when the
 * window closes.
 *
 * Three things keep that from becoming "old secrets work forever":
 *
 * - the window is stored (`previousExpiresAt`) and checked on every request,
 *   so it expires whether or not anything else happens;
 * - **at most one** previous secret is ever live — rotating twice inside the
 *   window drops the older immediately, so the live set is 1 or 2 and never
 *   grows;
 * - `graceSec: 0` revokes at once, which is the correct answer for a
 *   *compromised* secret and is the case where an overlap is exactly wrong.
 *   One parameter serves both, and the caller is told which happened
 *   (`previousValidUntil`).
 */

/** 32 bytes, base64url — 256 bits of HMAC key, in a form that survives a copy-paste into someone else's config box. */
export const WEBHOOK_SECRET_BYTES = 32
/** The default overlap after a rotation. A working day plus a night, so a rotation started on a Friday afternoon is not an incident on Saturday morning. */
export const WEBHOOK_ROTATION_GRACE_SEC = 86_400
/** The longest overlap this farm will hold, whatever a caller asks for. A window nobody remembers is a second live secret nobody remembers. */
export const WEBHOOK_ROTATION_MAX_GRACE_SEC = 604_800

function generateSecret(): string {
  return randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url')
}

function seconds(d: Date | null | undefined): number | null {
  return d ? Math.floor(d.getTime() / 1000) : null
}

/**
 * What a DECLARED webhook that has never had a secret generated looks like.
 *
 * A declaration and a row are two different facts and this is where they meet:
 * the manifest says the address exists, and until someone asks for the secret
 * nothing has been minted for it. Reporting the entry with `configured: false`
 * is the honest answer — omitting it would tell an author their own declared
 * webhook does not exist, and minting one as a side effect of *listing* would
 * make a read a write.
 */
export function unconfiguredWebhookInfo(plugin: string, webhookId: string): PluginWebhookInfo {
  return {
    id: webhookId,
    path: pluginWebhookPath(plugin, webhookId),
    configured: false,
    createdAt: 0,
    rotatedAt: null,
    previousValidUntil: null,
    deliveries: 0,
    refusals: 0,
    lastDeliveryAt: null,
    lastAcceptedKey: null,
  }
}

/** One secret a delivery may be signed with, and the name the audit row and the counters use for it. */
export interface AcceptableSecret {
  key: 'current' | 'previous'
  secret: string
}

export interface PluginWebhookStore {
  /**
   * The row for `(plugin, webhookId)`, creating it — and its first secret — if
   * there is none. Idempotent: a webhook is never in a half-configured state
   * where the URL exists and the secret does not.
   */
  ensure(plugin: string, webhookId: string): PluginWebhookInfo
  /** Metadata for one webhook, or `null` when nothing has been created for it yet. Never a secret. */
  info(plugin: string, webhookId: string): PluginWebhookInfo | null
  /** Metadata for every webhook of one plugin, oldest first. */
  list(plugin: string): PluginWebhookInfo[]
  /**
   * The secrets a delivery may be signed with, right now: the current one, and
   * the previous one while its window is open. Empty when the webhook has
   * never been created — which is what makes an unknown webhook and a known
   * one indistinguishable to a stranger (see `webhook-routes.ts`).
   *
   * An expired previous secret is dropped from the row here, not merely
   * filtered out of the answer: the window closing is a state change, and a
   * ciphertext nobody will ever accept again should not sit on the row.
   */
  acceptable(plugin: string, webhookId: string, now?: number): AcceptableSecret[]
  /** The plaintext current secret, generating one if the webhook is new. The caller is responsible for auditing the reveal. */
  reveal(plugin: string, webhookId: string): string
  /** Mint a new secret, keeping the old one acceptable for `graceSec`. Returns the new plaintext ONCE. */
  rotate(plugin: string, webhookId: string, opts?: { graceSec?: number }): { secret: string; previousValidUntil: number | null }
  /** A delivery verified. Records which secret did it, so `previous` is visible before the window closes. */
  recordDelivery(plugin: string, webhookId: string, key: 'current' | 'previous'): void
  /** A request was refused, for any reason. Counted, never audited per-request beyond what the route already writes. */
  recordRefusal(plugin: string, webhookId: string): void
  /**
   * Drop every webhook secret belonging to one plugin. Called when the plugin
   * itself is removed with its data — a secret with no plugin behind it is a
   * live credential for a URL that answers 404, which is worse than useless.
   */
  forget(plugin: string): number
}

export interface PluginWebhookStoreDeps {
  db: Db
  dataDir: string
}

export function createPluginWebhookStore(deps: PluginWebhookStoreDeps): PluginWebhookStore {
  const { db, dataDir } = deps

  function rowOf(plugin: string, webhookId: string): PluginWebhookRow | null {
    return db
      .select()
      .from(pluginWebhooks)
      .where(and(eq(pluginWebhooks.plugin, plugin), eq(pluginWebhooks.webhookId, webhookId)))
      .get() ?? null
  }

  function toInfo(row: PluginWebhookRow): PluginWebhookInfo {
    const previousValidUntil = row.previousSecretRef ? seconds(row.previousExpiresAt) : null
    return {
      id: row.webhookId,
      path: pluginWebhookPath(row.plugin, row.webhookId),
      configured: true,
      createdAt: seconds(row.createdAt) ?? 0,
      rotatedAt: seconds(row.rotatedAt),
      previousValidUntil,
      deliveries: row.deliveries,
      refusals: row.refusals,
      lastDeliveryAt: seconds(row.lastDeliveryAt),
      lastAcceptedKey: row.lastAcceptedKey === 'current' || row.lastAcceptedKey === 'previous' ? row.lastAcceptedKey : null,
    }
  }

  function create(plugin: string, webhookId: string): PluginWebhookRow {
    const row: PluginWebhookRow = {
      id: crypto.randomUUID(),
      plugin,
      webhookId,
      secretRef: encryptNamespacedSecret(dataDir, 'webhook', generateSecret()),
      previousSecretRef: null,
      previousExpiresAt: null,
      deliveries: 0,
      refusals: 0,
      lastDeliveryAt: null,
      lastAcceptedKey: null,
      rotatedAt: null,
      createdAt: new Date(),
    }
    db.insert(pluginWebhooks).values(row).run()
    return row
  }

  function ensureRow(plugin: string, webhookId: string): PluginWebhookRow {
    return rowOf(plugin, webhookId) ?? create(plugin, webhookId)
  }

  return {
    ensure(plugin, webhookId) {
      return toInfo(ensureRow(plugin, webhookId))
    },

    info(plugin, webhookId) {
      const row = rowOf(plugin, webhookId)
      return row ? toInfo(row) : null
    },

    list(plugin) {
      return db.select().from(pluginWebhooks).where(eq(pluginWebhooks.plugin, plugin)).all().map(toInfo)
    },

    acceptable(plugin, webhookId, now = Math.floor(Date.now() / 1000)) {
      const row = rowOf(plugin, webhookId)
      if (!row) return []
      const out: AcceptableSecret[] = [{ key: 'current', secret: decryptNamespacedSecret(dataDir, 'webhook', row.secretRef) }]
      if (!row.previousSecretRef) return out
      const until = seconds(row.previousExpiresAt)
      if (until !== null && until > now) {
        out.push({ key: 'previous', secret: decryptNamespacedSecret(dataDir, 'webhook', row.previousSecretRef) })
        return out
      }
      // The window has closed. Cleared here rather than left to be filtered out
      // on every future request: a ciphertext that will never be accepted again
      // is a stored credential with no purpose, and leaving it makes
      // `previousValidUntil` read as an overlap that is still running.
      db.update(pluginWebhooks).set({ previousSecretRef: null, previousExpiresAt: null }).where(eq(pluginWebhooks.id, row.id)).run()
      return out
    },

    reveal(plugin, webhookId) {
      const row = ensureRow(plugin, webhookId)
      return decryptNamespacedSecret(dataDir, 'webhook', row.secretRef)
    },

    rotate(plugin, webhookId, opts) {
      const row = ensureRow(plugin, webhookId)
      const requested = opts?.graceSec ?? WEBHOOK_ROTATION_GRACE_SEC
      if (!Number.isFinite(requested) || requested < 0) {
        throw new EnkakuError('E_BAD_REQUEST', `webhook rotate: graceSec must be a non-negative number of seconds (got ${String(requested)})`)
      }
      const graceSec = Math.min(Math.trunc(requested), WEBHOOK_ROTATION_MAX_GRACE_SEC)
      const secret = generateSecret()
      const now = new Date()
      // The OLD current becomes the one previous. Whatever previous was there
      // is dropped in the same statement — that is the "at most one" invariant,
      // and it is enforced by the shape of the row rather than by a sweep.
      const previousExpiresAt = graceSec > 0 ? new Date(now.getTime() + graceSec * 1000) : null
      db.update(pluginWebhooks)
        .set({
          secretRef: encryptNamespacedSecret(dataDir, 'webhook', secret),
          previousSecretRef: graceSec > 0 ? row.secretRef : null,
          previousExpiresAt,
          rotatedAt: now,
        })
        .where(eq(pluginWebhooks.id, row.id))
        .run()
      return { secret, previousValidUntil: seconds(previousExpiresAt) }
    },

    recordDelivery(plugin, webhookId, key) {
      const row = rowOf(plugin, webhookId)
      if (!row) return
      db.update(pluginWebhooks)
        .set({ deliveries: row.deliveries + 1, lastDeliveryAt: new Date(), lastAcceptedKey: key })
        .where(eq(pluginWebhooks.id, row.id))
        .run()
    },

    recordRefusal(plugin, webhookId) {
      const row = rowOf(plugin, webhookId)
      if (!row) return
      db.update(pluginWebhooks).set({ refusals: row.refusals + 1 }).where(eq(pluginWebhooks.id, row.id)).run()
    },

    forget(plugin) {
      const rows = db.select({ id: pluginWebhooks.id }).from(pluginWebhooks).where(eq(pluginWebhooks.plugin, plugin)).all()
      if (rows.length === 0) return 0
      db.delete(pluginWebhooks).where(eq(pluginWebhooks.plugin, plugin)).run()
      return rows.length
    },
  }
}
