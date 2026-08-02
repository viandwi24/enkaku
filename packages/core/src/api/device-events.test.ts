import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { deviceEvents } from '../db/schema'
import { createDeviceEventsRoutes } from './device-events'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

/** Seeds `n` input events for a device, `atSec` seconds apart (0 = all in the same second — the collision case). */
function seed(db: Db, deviceId: string, n: number, atSec: number, stream: 'main' | 'input' = 'input') {
  const base = Math.floor(Date.now() / 1000)
  for (let i = 0; i < n; i++) {
    db.insert(deviceEvents)
      .values({
        id: crypto.randomUUID(),
        deviceId,
        stream,
        kind: stream === 'input' ? 'input.tap' : 'device.online',
        actor: null,
        meta: { i },
        at: new Date((base - i * atSec) * 1000),
      })
      .run()
  }
}

describe('GET /api/devices/:id/events keyset pagination', () => {
  test('pages through spread-out rows with no duplicates or gaps', async () => {
    const db = setUp()
    seed(db, 'dev-1', 250, 1) // one per second, strictly ordered
    const app = createDeviceEventsRoutes({ db })

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const url = cursor
        ? `/dev-1/events?stream=input&limit=50&cursor=${encodeURIComponent(cursor)}`
        : '/dev-1/events?stream=input&limit=50'
      const res = await app.request(url)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
      for (const ev of body.items) {
        expect(seen.has(ev.id)).toBe(false) // never a duplicate across pages
        seen.add(ev.id)
      }
      pages++
      if (body.nextCursor === null) break
      cursor = body.nextCursor
      expect(pages).toBeLessThan(20) // guard against an infinite loop on a bug
    }
    expect(seen.size).toBe(250) // never a gap either
  })

  test('same-second ties (a common input-stream burst) page correctly via the id tiebreaker', async () => {
    const db = setUp()
    // 30 rows sharing the exact same second, and a limit that would have cut
    // that second in half under the old `before`-only design.
    seed(db, 'dev-1', 30, 0)
    const app = createDeviceEventsRoutes({ db })

    const seen = new Set<string>()
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const url = cursor
        ? `/dev-1/events?stream=input&limit=10&cursor=${encodeURIComponent(cursor)}`
        : '/dev-1/events?stream=input&limit=10'
      const res = await app.request(url)
      const body = (await res.json()) as { items: Array<{ id: string }>; nextCursor: string | null }
      for (const ev of body.items) {
        expect(seen.has(ev.id)).toBe(false)
        seen.add(ev.id)
      }
      pages++
      if (body.nextCursor === null) break
      cursor = body.nextCursor
      expect(pages).toBeLessThan(10)
    }
    expect(seen.size).toBe(30)
  })

  test('the `kind` filter narrows to a dotted prefix', async () => {
    const db = setUp()
    seed(db, 'dev-1', 5, 1, 'main')
    const app = createDeviceEventsRoutes({ db })
    const res = await app.request('/dev-1/events?stream=main&kind=device.')
    const body = (await res.json()) as { items: Array<{ kind: string }> }
    expect(body.items).toHaveLength(5)
    expect(body.items.every((e) => e.kind.startsWith('device.'))).toBe(true)
  })

  test('rejects a missing or invalid stream', async () => {
    const db = setUp()
    const app = createDeviceEventsRoutes({ db })
    const res = await app.request('/dev-1/events')
    expect(res.status).toBe(400)
    const res2 = await app.request('/dev-1/events?stream=bogus')
    expect(res2.status).toBe(400)
  })

  test('a malformed cursor returns 400, not a silently-ignored one', async () => {
    const db = setUp()
    const app = createDeviceEventsRoutes({ db })
    const res = await app.request('/dev-1/events?stream=main&cursor=not-valid-base64!!!')
    expect(res.status).toBe(400)
  })

  test('returns the envelope plus the legacy `events`/`nextBefore` keys, populated from the same data', async () => {
    const db = setUp()
    seed(db, 'dev-1', 3, 1, 'main')
    const app = createDeviceEventsRoutes({ db })
    const res = await app.request('/dev-1/events?stream=main&limit=2')
    const body = (await res.json()) as {
      items: Array<{ id: string }>
      nextCursor: string | null
      total: number | null
      events: Array<{ id: string }>
      nextBefore: number | null
    }
    expect(body.events).toEqual(body.items)
    expect(body.total).toBeNull()
    expect(body.nextCursor).not.toBeNull()
    expect(typeof body.nextBefore).toBe('number')
  })
})
