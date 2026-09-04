import { Hono } from 'hono'
import { StorageUsageResponseSchema, type StorageUsageKind } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import type { Db } from '../db'
import { storageUsage } from '../db/schema'
import { typedJson } from './typed-json'

/**
 * `GET /api/storage/usage` — reads the cache `retention/storage-usage.ts`
 * writes; performs no filesystem access and no aggregate query of its own.
 * No permission gate beyond authentication, matching `GET /api/settings`
 * (both are farm-descriptive reads, not device or job actions).
 */
export function createStorageRoutes(db: Db): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.get('/usage', (c) => {
    const rows = db.select().from(storageUsage).all()
    const kinds = rows.map((r) => ({
      kind: r.kind as StorageUsageKind,
      bytes: r.bytes,
      rows: r.rows,
      computedAt: r.computedAt ? Math.floor(r.computedAt.getTime() / 1000) : 0,
    }))
    const totalBytes = kinds.reduce((sum, r) => sum + r.bytes, 0)
    return typedJson(c, StorageUsageResponseSchema, { kinds, totalBytes })
  })

  return app
}
