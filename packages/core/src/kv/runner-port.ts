import { eq } from 'drizzle-orm'
import type { KvCall } from '@enkaku/session'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { buildSecretRedactor, type KvScope, type KvStore } from './store'

/**
 * The parent-side implementation of `ctx.kv`'s IPC port (plan 79 §4.4, §4.7)
 * — `packages/session/src/runner/job-runner.ts`'s `JobRunnerDeps.kv` is a
 * plain, session-local interface (that package cannot depend on `@enkaku/core`,
 * where the kv store itself lives); this is the concrete object `daemon.ts`
 * hands it. Resolves the device row's `stableId` here, ONCE, per call — a
 * script's `deviceId` is `devices.id` (the row), but a kv value is keyed on
 * `stableId` (CLAUDE.md, plan 79 §3.3): the mapping belongs at this
 * boundary, not inside the store, which never sees a devices.id at all.
 */
export interface KvRunnerPortDeps {
  db: Db
  store: KvStore
}

export interface KvRunnerPort {
  call(ctx: { jobId: string; deviceId: string; namespace: string }, call: KvCall): Promise<unknown>
  redact(ctx: { deviceId: string; namespace: string | undefined }, text: string): string
}

function stableIdFor(db: Db, deviceId: string): string | null {
  const row = db.select({ stableId: devices.stableId }).from(devices).where(eq(devices.id, deviceId)).get()
  return row?.stableId ?? null
}

function resolveScope(db: Db, deviceId: string, kind: 'global' | 'device'): KvScope {
  if (kind === 'global') return { kind: 'global' }
  const stableId = stableIdFor(db, deviceId)
  if (!stableId) throw new EnkakuError('E_DEVICE_NOT_FOUND', `no such device: ${deviceId}`)
  return { kind: 'device', stableId }
}

export function createKvRunnerPort(deps: KvRunnerPortDeps): KvRunnerPort {
  const { db, store } = deps
  return {
    async call(ctx, call) {
      const scope = resolveScope(db, ctx.deviceId, call.scope)
      switch (call.op) {
        case 'get': {
          const entry = store.get(scope, ctx.namespace, call.key)
          return entry ? entry.value : null
        }
        case 'set': {
          const entry = store.set(scope, ctx.namespace, call.key, call.value, {
            secret: call.secret,
            ttlSec: call.ttlSec,
            updatedByJobId: ctx.jobId,
          })
          return { version: entry.version }
        }
        case 'setIfVersion': {
          const entry = store.setIfVersion(scope, ctx.namespace, call.key, call.value, call.expectedVersion, {
            secret: call.secret,
            ttlSec: call.ttlSec,
            updatedByJobId: ctx.jobId,
          })
          return entry ? { version: entry.version } : null
        }
        case 'increment':
          return store.increment(scope, ctx.namespace, call.key, call.by ?? 1)
        case 'delete':
          return store.delete(scope, ctx.namespace, call.key, { ifVersion: call.ifVersion })
        case 'list': {
          const page = store.list(scope, ctx.namespace, { prefix: call.prefix, limit: call.limit ?? 50, cursor: call.cursor ?? null })
          return { items: page.items, nextCursor: page.nextCursor }
        }
        default: {
          const _exhaustive: never = call
          throw new EnkakuError('E_BAD_REQUEST', `unknown kv op: ${JSON.stringify(_exhaustive)}`)
        }
      }
    },

    redact(ctx, text) {
      if (!ctx.namespace) return text
      let stableId: string | null = null
      try {
        stableId = stableIdFor(db, ctx.deviceId)
      } catch {
        return text
      }
      const scopes: KvScope[] = [{ kind: 'global' }, ...(stableId ? [{ kind: 'device', stableId } as KvScope] : [])]
      try {
        return buildSecretRedactor(store, scopes, ctx.namespace)(text)
      } catch {
        // Best-effort (§4.7) — a redaction failure must never crash logging.
        return text
      }
    },
  }
}
