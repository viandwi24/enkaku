import { desc, eq } from 'drizzle-orm'
import { WebhookEndpointSchema, type WebhookEndpoint, type WebhookEndpointUpdateInput, type WebhookEndpointWriteInput } from '@enkaku/protocol'
import type { Db } from '../db'
import { webhookEndpoints, type WebhookEndpointRow } from '../db/schema'
import { decryptNamespacedSecret, encryptNamespacedSecret } from '../secrets/store'
import { EnkakuError } from '../util/errors'

/**
 * CRUD for `webhook_endpoints` (plan 68 §3.4, §4.1) — farm-level and
 * admin-managed. The write-only secret rule mirrors `connector-store.ts`
 * exactly: `rowToEndpoint` never reads `row.secretRef`, only whether it is
 * null (`configured`). `resolveSecret`/`resolveSecretFromRow` are the only
 * functions that ever decrypt, using the SAME namespaced mechanism
 * `connectors.credential` already uses (`../secrets/store.ts`, namespace
 * `'webhook'`) — not a third secret mechanism.
 */

export interface WebhookStoreDeps {
  db: Db
  dataDir: string
}

function toSeconds(d: Date | null): number | null {
  return d ? Math.floor(d.getTime() / 1000) : null
}

function rowToEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
  return WebhookEndpointSchema.parse({
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled ?? true,
    configured: row.secretRef !== null,
    lastStatus: row.lastStatus,
    lastAttemptAt: toSeconds(row.lastAttemptAt),
    failureCount: row.failureCount,
    createdAt: toSeconds(row.createdAt) ?? 0,
  })
}

export function createWebhookStore(deps: WebhookStoreDeps) {
  const { db, dataDir } = deps

  function list(): WebhookEndpoint[] {
    return db.select().from(webhookEndpoints).orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id)).all().map(rowToEndpoint)
  }

  function get(id: string): WebhookEndpoint | null {
    const row = db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).get()
    return row ? rowToEndpoint(row) : null
  }

  function mustGetRow(id: string): WebhookEndpointRow {
    const row = db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).get()
    if (!row) throw new EnkakuError('webhook_not_found', `no such webhook endpoint: ${id}`)
    return row
  }

  /** `notify.send`'s `channels` names an endpoint by NAME, never a raw URL — the delivery path's only entry point. */
  function getRowByName(name: string): WebhookEndpointRow | null {
    return db.select().from(webhookEndpoints).where(eq(webhookEndpoints.name, name)).get() ?? null
  }

  function create(input: WebhookEndpointWriteInput): WebhookEndpoint {
    if (getRowByName(input.name)) throw new EnkakuError('E_WEBHOOK_NAME_TAKEN', `a webhook endpoint named "${input.name}" already exists`)
    const row: WebhookEndpointRow = {
      id: crypto.randomUUID(),
      name: input.name,
      url: input.url,
      secretRef: input.secret ? encryptNamespacedSecret(dataDir, 'webhook', input.secret) : null,
      enabled: input.enabled ?? true,
      lastStatus: null,
      lastAttemptAt: null,
      failureCount: 0,
      createdAt: new Date(),
    }
    db.insert(webhookEndpoints).values(row).run()
    return rowToEndpoint(row)
  }

  function update(id: string, input: WebhookEndpointUpdateInput): WebhookEndpoint {
    mustGetRow(id)
    const patch: Partial<WebhookEndpointRow> = {}
    if (input.url !== undefined) patch.url = input.url
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (input.secret !== undefined) patch.secretRef = encryptNamespacedSecret(dataDir, 'webhook', input.secret)
    if (Object.keys(patch).length > 0) db.update(webhookEndpoints).set(patch).where(eq(webhookEndpoints.id, id)).run()
    return get(id)!
  }

  function remove(id: string): void {
    mustGetRow(id)
    db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).run()
  }

  /** The ONE function (besides `resolveSecretFromRow`) that ever decrypts a stored secret. */
  function resolveSecret(id: string): string | null {
    const row = mustGetRow(id)
    return resolveSecretFromRow(row)
  }

  /** Same decrypt, given an already-fetched row — avoids a second DB read in the delivery hot path (`notify/service.ts`). */
  function resolveSecretFromRow(row: WebhookEndpointRow): string | null {
    return row.secretRef ? decryptNamespacedSecret(dataDir, 'webhook', row.secretRef) : null
  }

  /** Rolling delivery health (plan 68 §4.1, criterion 11) — a success resets `failureCount` to 0; a failure increments it. */
  function recordDeliveryResult(id: string, status: 'ok' | 'failed'): void {
    const row = db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)).get()
    if (!row) return
    db.update(webhookEndpoints)
      .set({
        lastStatus: status,
        lastAttemptAt: new Date(),
        failureCount: status === 'ok' ? 0 : row.failureCount + 1,
      })
      .where(eq(webhookEndpoints.id, id))
      .run()
  }

  return { list, get, mustGetRow, getRowByName, create, update, remove, resolveSecret, resolveSecretFromRow, recordDeliveryResult }
}

export type WebhookStore = ReturnType<typeof createWebhookStore>
