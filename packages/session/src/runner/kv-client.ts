import type { z } from 'zod'
import type { KvCall, KvScopeKind } from './ipc'

export interface KvListItem {
  key: string
  value: unknown
  secret: boolean
  hint: string | null
  version: number
  expiresAt: number | null
  updatedAt: number
}

export interface KvListResult {
  items: KvListItem[]
  nextCursor: string | null
}

export interface KvSetResult {
  version: number
}

export interface KvApiClient {
  get<T>(key: string, schema: z.ZodType<T>): Promise<T | null>
  getRaw(key: string): Promise<unknown>
  set(key: string, value: unknown, opts?: { secret?: boolean; ttlSec?: number }): Promise<KvSetResult>
  setIfVersion(key: string, value: unknown, expectedVersion: number, opts?: { secret?: boolean; ttlSec?: number }): Promise<KvSetResult | null>
  increment(key: string, by?: number): Promise<number>
  delete(key: string, opts?: { ifVersion?: number }): Promise<boolean>
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<KvListResult>
}

/**
 * One `KvApi` bound to a scope (plan 79 §4.4) — `request` is the caller's own `kv.call` →
 * `kv.result` round trip (`child-entry.ts`'s `kvRequest`), injected so this module is a plain,
 * directly-testable function rather than something that only runs inside a spawned child process.
 * The schema check lives HERE, not in the store (§3.6): the store returns whatever JSON an older
 * script version wrote, and it is this boundary's job to validate it against the CALLER's own
 * schema before handing it back — throwing an error that NAMES the key (criterion 11), never a
 * silently mis-shaped object.
 */
export function createKvApiFor(scope: KvScopeKind, request: <T>(call: KvCall) => Promise<T>): KvApiClient {
  return {
    async get(key, schema) {
      const raw = await request<unknown>({ op: 'get', scope, key })
      if (raw === null || raw === undefined) return null
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        throw Object.assign(
          new Error(`kv.get("${key}"): the stored value does not match the given schema — ${parsed.error.message}`),
          { code: 'E_KV_SCHEMA_MISMATCH' },
        )
      }
      return parsed.data
    },

    getRaw(key) {
      return request<unknown>({ op: 'get', scope, key })
    },

    set(key, value, opts) {
      return request<KvSetResult>({
        op: 'set',
        scope,
        key,
        value,
        ...(opts?.secret !== undefined ? { secret: opts.secret } : {}),
        ...(opts?.ttlSec !== undefined ? { ttlSec: opts.ttlSec } : {}),
      })
    },

    setIfVersion(key, value, expectedVersion, opts) {
      return request<KvSetResult | null>({
        op: 'setIfVersion',
        scope,
        key,
        value,
        expectedVersion,
        ...(opts?.secret !== undefined ? { secret: opts.secret } : {}),
        ...(opts?.ttlSec !== undefined ? { ttlSec: opts.ttlSec } : {}),
      })
    },

    increment(key, by) {
      return request<number>({ op: 'increment', scope, key, ...(by !== undefined ? { by } : {}) })
    },

    delete(key, opts) {
      return request<boolean>({ op: 'delete', scope, key, ...(opts?.ifVersion !== undefined ? { ifVersion: opts.ifVersion } : {}) })
    },

    list(opts) {
      return request<KvListResult>({
        op: 'list',
        scope,
        ...(opts?.prefix !== undefined ? { prefix: opts.prefix } : {}),
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts?.cursor !== undefined ? { cursor: opts.cursor } : {}),
      })
    },
  }
}
