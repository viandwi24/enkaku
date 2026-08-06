import { desc, eq } from 'drizzle-orm'
import { ConnectorKindSchema, ConnectorSchema, type Connector, type ConnectorKind, type ConnectorTestResult, type ConnectorUpdateInput, type ConnectorWriteInput } from '@enkaku/protocol'
import type { Db } from '../db'
import { connectors, type ConnectorRow } from '../db/schema'
import { decryptNamespacedSecret, encryptNamespacedSecret, secretHint } from '../secrets/store'
import { EnkakuError } from '../util/errors'
import { testProviderConnection } from './provider'

/**
 * CRUD for `connectors` (plan 65 §3.6, §4.4, §5.5) — the write-only
 * credential rule lives entirely here: `rowToConnector` NEVER reads
 * `row.credential`, only `row.credentialHint`/`row.credential !== null`.
 * `resolve()` is the one function that ever decrypts, and its result must
 * never be persisted, logged, or returned from an HTTP handler — the exact
 * same shape `network/credential-store.ts`'s `resolve()` already takes.
 */

export interface ConnectorStoreDeps {
  db: Db
  dataDir: string
  /**
   * `ENKAKU_ANTHROPIC_API_KEY`/`ENKAKU_OPENROUTER_API_KEY` fallback (§3.6,
   * criterion 5; plan 75 §4.4 adds the OpenRouter variable) — a function,
   * not a value, so tests can point it at a fake env without a module
   * reload. Kind-aware: an `anthropic` connector never falls back to the
   * OpenRouter key or vice versa.
   */
  envApiKey?: (kind: ConnectorKind) => string | undefined
  /** Injectable transport for `test()` — never hits the network when a fake is supplied (the same seam `AnthropicAdapterDeps` exposes). */
  fetch?: typeof fetch
}

function toSeconds(d: Date | null): number {
  return d ? Math.floor(d.getTime() / 1000) : 0
}

function rowToConnector(row: ConnectorRow): Connector {
  return ConnectorSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    configured: row.credential !== null,
    hint: row.credentialHint,
    status: row.status ?? 'unknown',
    statusMessage: row.statusMessage,
    checkedAt: row.checkedAt ? toSeconds(row.checkedAt) : null,
    createdAt: toSeconds(row.createdAt),
  })
}

export function createConnectorStore(deps: ConnectorStoreDeps) {
  const { db, dataDir } = deps
  const envApiKey = deps.envApiKey ?? ((kind: ConnectorKind) => (kind === 'openrouter' ? process.env.ENKAKU_OPENROUTER_API_KEY : process.env.ENKAKU_ANTHROPIC_API_KEY))

  function list(): Connector[] {
    return db.select().from(connectors).orderBy(desc(connectors.createdAt), desc(connectors.id)).all().map(rowToConnector)
  }

  function get(id: string): Connector | null {
    const row = db.select().from(connectors).where(eq(connectors.id, id)).get()
    return row ? rowToConnector(row) : null
  }

  function mustGet(id: string): ConnectorRow {
    const row = db.select().from(connectors).where(eq(connectors.id, id)).get()
    if (!row) throw new EnkakuError('connector_not_found', `no such connector: ${id}`)
    return row
  }

  function findByName(name: string): ConnectorRow | null {
    return db.select().from(connectors).where(eq(connectors.name, name)).get() ?? null
  }

  function create(input: ConnectorWriteInput): Connector {
    if (findByName(input.name)) throw new EnkakuError('E_CONNECTOR_NAME_TAKEN', `a connector named "${input.name}" already exists`)
    const row: ConnectorRow = {
      id: crypto.randomUUID(),
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl ?? null,
      credential: input.credential ? encryptNamespacedSecret(dataDir, 'connector', input.credential) : null,
      credentialHint: input.credential ? secretHint(input.credential) : null,
      status: 'unknown',
      statusMessage: null,
      checkedAt: null,
      createdAt: new Date(),
    }
    db.insert(connectors).values(row).run()
    return rowToConnector(row)
  }

  function update(id: string, input: ConnectorUpdateInput): Connector {
    mustGet(id)
    const patch: Partial<ConnectorRow> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl
    if (input.credential !== undefined) {
      patch.credential = encryptNamespacedSecret(dataDir, 'connector', input.credential)
      patch.credentialHint = secretHint(input.credential)
      // A freshly-replaced credential's status is unknown again until "Test connection" is run —
      // showing a stale "ok" against a secret that was just swapped would be actively misleading.
      patch.status = 'unknown'
      patch.statusMessage = null
      patch.checkedAt = null
    }
    if (Object.keys(patch).length > 0) db.update(connectors).set(patch).where(eq(connectors.id, id)).run()
    return rowToConnector(mustGet(id))
  }

  function remove(id: string): void {
    mustGet(id)
    db.delete(connectors).where(eq(connectors.id, id)).run()
  }

  /**
   * A run's own auth failure marks the connector `unauthenticated` (plan 66
   * §3.8: "auth | stop; mark the connector unauthenticated (Plan 65 §4.5)")
   * — the same status/statusMessage/checkedAt `test()` already writes, so a
   * failed run and a failed "Test connection" click both land an operator
   * on the same signal instead of two differently-worded ones.
   */
  function markUnauthenticated(id: string, message: string): void {
    mustGet(id)
    db.update(connectors).set({ status: 'unauthenticated', statusMessage: message, checkedAt: new Date() }).where(eq(connectors.id, id)).run()
  }

  /**
   * The ONE function that ever decrypts a connector's credential (mirrors
   * `network/credential-store.ts`'s `resolve()`). Falls back to
   * `ENKAKU_ANTHROPIC_API_KEY`/`ENKAKU_OPENROUTER_API_KEY` (by the
   * connector's own kind) when it has no stored credential (§3.6, criterion
   * 5; plan 75 §4.4) — a stored credential always wins over the env var.
   */
  function resolveApiKey(id: string): string | null {
    const row = mustGet(id)
    if (row.credential) return decryptNamespacedSecret(dataDir, 'connector', row.credential)
    return envApiKey(ConnectorKindSchema.parse(row.kind)) ?? null
  }

  /** `POST /connectors/:id/test` (§4.5) — one cheap authenticated call, stored and returned. */
  async function test(id: string): Promise<ConnectorTestResult> {
    const row = mustGet(id)
    const apiKey = resolveApiKey(id)
    if (!apiKey) {
      const envVar = row.kind === 'openrouter' ? 'ENKAKU_OPENROUTER_API_KEY' : 'ENKAKU_ANTHROPIC_API_KEY'
      const result: ConnectorTestResult = { status: 'unauthenticated', message: `no stored credential and ${envVar} is not set` }
      db.update(connectors).set({ status: result.status, statusMessage: result.message, checkedAt: new Date() }).where(eq(connectors.id, id)).run()
      return result
    }
    const result = await testProviderConnection(ConnectorKindSchema.parse(row.kind), { apiKey, baseUrl: row.baseUrl, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
    db.update(connectors).set({ status: result.status, statusMessage: result.message, checkedAt: new Date() }).where(eq(connectors.id, id)).run()
    return result
  }

  return { list, get, create, update, remove, resolveApiKey, test, markUnauthenticated }
}

export type ConnectorStore = ReturnType<typeof createConnectorStore>
