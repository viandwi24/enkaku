import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import type { ScriptContext } from '@enkaku/sdk'
import discoverLanIpScript from './discover-lan-ip'
import { ASSIGNMENT_KEY, writeAssignment, type StoredAssignment } from './shared'

/**
 * `discover-lan-ip`'s own wiring (plan 122 §4.8, step 122.10) — that a
 * `found` reading writes `lanIp`/`lanIpSource: 'probe'` into the device's own
 * `assignment` note, and that `not-found`/`ambiguous` write NOTHING and
 * report why. The extraction logic itself is exhaustively covered in
 * `service/network-probe.test.ts`.
 */

function node(text: string): UiNode {
  return { resourceId: '', text, desc: '', className: '', packageName: '', bounds: { left: 0, top: 0, right: 10, bottom: 10 }, clickable: false, enabled: true, focused: false, index: 0, children: [] }
}

function fakeCtx(opts: { pages: UiNode[]; stored?: Partial<StoredAssignment> }) {
  let i = 0
  const store = new Map<string, unknown>()
  if (opts.stored) store.set(ASSIGNMENT_KEY, writeAssignment({ pathId: '', groupId: '', lanIp: '', lanIpSource: '', leaseKind: '', since: 0, lastVerifiedAt: 0, lastPublicIp: '', ...opts.stored }))
  const warnings: unknown[] = []
  const ctx = {
    device: {
      app: { launch: async () => {} },
      dump: async () => {
        const d = opts.pages[Math.min(i, opts.pages.length - 1)] as UiNode
        i += 1
        return d
      },
      tap: async () => {},
    },
    log: {
      info: () => {},
      warn: (msg: string, fields?: Record<string, unknown>) => warnings.push({ msg, fields }),
      error: () => {},
      debug: () => {},
    },
    storage: {
      device: {
        getRaw: async (key: string) => store.get(key) ?? null,
        set: async (key: string, value: unknown) => {
          store.set(key, value)
          return { version: 1 }
        },
      },
    },
  }
  return { ctx, store, warnings }
}

describe('discover-lan-ip — the glue', () => {
  test('a single private-range candidate is written with lanIpSource: probe', async () => {
    const { ctx, store } = fakeCtx({ pages: [node('192.168.10.221')], stored: { pathId: 'via-modem1' } })
    const result = await discoverLanIpScript.run(ctx as unknown as ScriptContext<Record<string, never>>)
    expect(result).toEqual({ resolved: true, lanIp: '192.168.10.221', reason: null })
    const saved = store.get(ASSIGNMENT_KEY) as Record<string, unknown>
    expect(saved.lanIp).toBe('192.168.10.221')
    expect(saved.lanIpSource).toBe('probe')
    // The rest of the record is preserved, not clobbered.
    expect(saved.pathId).toBe('via-modem1')
  })

  test('an ambiguous page (two distinct private-range candidates) writes nothing and names both', async () => {
    // The first dump shows nothing yet (still polling); the second shows BOTH candidates in one
    // reading — the case a page with two live network adapters produces.
    const { ctx, store, warnings } = fakeCtx({ pages: [node('still loading'), node('192.168.10.221 and 10.0.0.5')], stored: { lanIp: 'stale' } })
    const result = await discoverLanIpScript.run(ctx as unknown as ScriptContext<Record<string, never>>)
    expect(result.resolved).toBe(false)
    expect(result.lanIp).toBeNull()
    expect(result.reason).toContain('192.168.10.221')
    expect(result.reason).toContain('10.0.0.5')
    expect(warnings).toHaveLength(1)
    // The stale value is untouched — an ambiguous reading never overwrites what was there.
    const saved = store.get(ASSIGNMENT_KEY) as Record<string, unknown>
    expect(saved.lanIp).toBe('stale')
  })

  // A page that NEVER shows a private-range address (the not-found/timeout path, `resolved: false,
  // reason: '...within this run's budget'`) is NOT exercised here: the script hardcodes a 45s budget
  // for the real browser probe, and driving that path to its deadline would make this test itself take
  // 45s. The underlying behaviour — `browseAndExtract` returning `null` once its budget runs out with
  // nothing found, and `extractLanIp` itself returning `not-found` for a page with no candidate — IS
  // exercised, cheaply, in `service/browser-probe.test.ts` and `service/network-probe.test.ts`.
})
