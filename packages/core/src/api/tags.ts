import { Hono } from 'hono'
import type { Db } from '../db'
import { tagCounts } from '../registry/device-tags'

/**
 * `GET /api/tags` (plan 19 §4.3) — every tag in use, with a count, so the
 * picker and the editor can suggest reuse instead of letting tags rot into
 * near-duplicates (plan 19 §3.4, §8 risk table).
 */
export function createTagRoutes(deps: { db: Db }): Hono {
  const app = new Hono()

  app.get('/', (c) => c.json({ tags: tagCounts(deps.db) }))

  return app
}
