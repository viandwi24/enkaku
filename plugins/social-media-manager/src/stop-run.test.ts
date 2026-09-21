import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { partlyStopped, setSessionStopped, stoppedNewestFrom, type Group, type WarmupRow } from './ui/shared'
import { STOP_PREFIX, stopKey, stoppedRunOf } from './session-control'
import { runsFromPlan } from './warmup-rows'

/*
  The owner's production farm, 2026-09-21. A Stop pressed at 11:41 on a warm-up over 73 phones wrote
  `stopped: true` onto the first 90 of the run's 219 rows, in key order, and got no further: phase 0
  stopped for every phone, phase 1 for 17 of 73, phase 2 for none. The loop `await`ed each write with
  nothing around it, so the first write that failed abandoned every row after it. Thirty-nine connected
  phones sat idle while the page offered "Start", and phases 1 and 2 were due to go out on their own.

  These tests run the real `setSessionStopped` against a fake farm, because the thing being guarded is
  the ORDER and the resilience of its requests.
*/

const G = 'g-1'
const R = 'r-1'

/** Two phones, three phases: six rows, in the key order the farm lists them. */
function rows(): { key: string; value: WarmupRow }[] {
  const out: { key: string; value: WarmupRow }[] = []
  for (let phase = 0; phase < 3; phase++) {
    const made = runsFromPlan({
      groupId: G,
      runId: R,
      startedAt: 1_800_000_000,
      phase,
      sequence: 'jobs',
      assignments: ['d1', 'd2'].map((deviceId) => ({
        deviceId,
        platform: 'tiktok',
        styleId: 'tt-a',
        styleTitle: 'For You',
        note: null,
        steps: [{ activityId: `a-${phase}-${deviceId}`, title: 'Scroll', script: 'tiktok/auto-scroll@latest', params: {}, atSec: 0 }],
      })),
    }) as unknown as WarmupRow[]
    for (const row of made) out.push({ key: `warmup:${G}:${R}:${phase}:${row.deviceId}`, value: row })
  }
  return out
}

const group = { version: 1, id: G, kind: 'warmup', stopped: false } as unknown as Group

/** A fake farm: serves the rows, records every write in order, and fails the ones it is told to. */
function farm(opts: { failWrites?: readonly string[] } = {}) {
  const log: string[] = []
  const store = rows()
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (method === 'GET' && url.pathname.endsWith('/data')) {
      const prefix = url.searchParams.get('prefix') ?? ''
      return json({ items: store.filter((row) => row.key.startsWith(prefix)), nextCursor: null })
    }
    if (method === 'PUT') {
      const key = (JSON.parse(String(init?.body)) as { key: string }).key
      log.push(`PUT ${key}`)
      if (opts.failWrites?.includes(key)) return json({ error: { code: 'E_INTERNAL', message: 'write refused' } }, 500)
      return json({})
    }
    if (method === 'DELETE') {
      log.push(`DELETE ${url.searchParams.get('key')}`)
      return json({})
    }
    return json({})
  }
  return { log, fake, keys: store.map((row) => row.key) }
}

let real: typeof fetch
beforeEach(() => {
  real = globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = real
})

describe('Stop', () => {
  test('writes the run\'s marker BEFORE it touches any row', async () => {
    const f = farm()
    globalThis.fetch = f.fake as typeof fetch
    await setSessionStopped(group, 'stop', R)
    // The marker is the stop; everything after it is tidying up.
    expect(f.log[0]).toBe(`PUT ${stopKey(G, R)}`)
    expect(f.log.filter((line) => line.startsWith('PUT warmup:')).length).toBe(6)
  })

  test('a row that cannot be written does not abandon the rows after it', async () => {
    // The third row fails — the production run stopped at exactly that kind of break.
    const f = farm({ failWrites: [`warmup:${G}:${R}:1:d1`] })
    globalThis.fetch = f.fake as typeof fetch
    const done = await setSessionStopped(group, 'stop', R)
    expect(done.failed).toBe(1)
    // Every row was ASKED to be written, including the three after the failure.
    expect(f.log.filter((line) => line.startsWith('PUT warmup:')).length).toBe(6)
  })

  test('the marker is written even when every row fails', async () => {
    const f = farm()
    const all = farm({ failWrites: f.keys })
    globalThis.fetch = all.fake as typeof fetch
    const done = await setSessionStopped(group, 'stop', R)
    expect(done.failed).toBe(6)
    // Nothing more goes out for this run, whatever happened to the rows.
    expect(all.log[0]).toBe(`PUT ${stopKey(G, R)}`)
  })
})

describe('Start', () => {
  test('takes the marker off LAST, after every row was re-timed', async () => {
    const f = farm()
    globalThis.fetch = f.fake as typeof fetch
    const done = await setSessionStopped(group, 'start', R)
    expect(done.failed).toBe(0)
    expect(f.log[f.log.length - 1]).toBe(`DELETE ${stopKey(G, R)}`)
  })

  test('leaves the run STOPPED when a row could not be re-timed', async () => {
    // Lifting the marker now would send that row out on its old schedule. Stopped is the safe way to fail.
    const f = farm({ failWrites: [`warmup:${G}:${R}:2:d2`] })
    globalThis.fetch = f.fake as typeof fetch
    const done = await setSessionStopped(group, 'start', R)
    expect(done.failed).toBe(1)
    expect(f.log.some((line) => line.startsWith('DELETE'))).toBe(false)
  })
})

describe('what the page reads', () => {
  const stored = rows().map((row) => row.value)

  test('a marker alone is enough to call the newest run stopped', () => {
    // No row carries the flag — only the marker says so. The router obeys the marker; so does the page.
    expect(stoppedNewestFrom(stored, new Set([`${G}:${R}`])).has(G)).toBe(true)
    expect(stoppedNewestFrom(stored, new Set()).has(G)).toBe(false)
  })

  test('the production state is recognised as PARTLY stopped', () => {
    // The first rows in key order flagged, the rest not, and no marker: exactly what 11:41 left behind.
    const half = stored.map((row, i) => ({ ...row, stopped: i < 3 }))
    expect(partlyStopped(half, new Set())).toBe(true)
    // With the marker on, the whole run is stopped whatever the rows say.
    expect(partlyStopped(half, new Set([`${G}:${R}`]))).toBe(false)
    // Every row flagged is a whole stop, not a partial one.
    expect(partlyStopped(stored.map((row) => ({ ...row, stopped: true })), new Set())).toBe(false)
  })
})

describe('the marker key', () => {
  test('names its run, and nothing else is taken for one', () => {
    expect(stopKey(G, R)).toBe(`${STOP_PREFIX}${G}:${R}`)
    expect(stoppedRunOf(stopKey(G, R))).toBe(`${G}:${R}`)
    expect(stoppedRunOf(`warmup:${G}:${R}:0:d1`)).toBe(null)
  })
})
