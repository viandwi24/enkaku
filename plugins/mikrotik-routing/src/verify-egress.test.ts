import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import type { ScriptContext } from '@enkaku/sdk'
import verifyEgressScript from './verify-egress'
import { ASSIGNMENT_KEY, writeAssignment, type StoredAssignment } from './shared'

/**
 * `verify-egress`'s own wiring (plan 122 §4.8, step 122.10) — that it reads
 * the device-scoped `assignment` note, calls the pure decision logic
 * correctly, and always writes back the fresh reading. The extraction and
 * decision logic themselves are exhaustively covered in
 * `service/network-probe.test.ts`; the browser-navigation mechanics in
 * `service/browser-probe.test.ts`. This file only proves the glue.
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

describe('verify-egress — the glue', () => {
  test('no path assigned — publicIp reported, matches null, and the observation is still saved', async () => {
    const { ctx, store } = fakeCtx({ pages: [node('103.186.169.250')], stored: {} })
    const result = await verifyEgressScript.run(ctx as unknown as ScriptContext<Record<string, never>>)
    expect(result).toEqual({ publicIp: '103.186.169.250', expectedPath: '', matches: null })
    const saved = store.get(ASSIGNMENT_KEY) as Record<string, unknown>
    expect(saved.lastPublicIp).toBe('103.186.169.250')
    expect(saved.lastVerifiedAt).toBeGreaterThan(0)
  })

  test('a path is assigned but never verified before — first observation, matches null', async () => {
    const { ctx } = fakeCtx({ pages: [node('103.186.169.250')], stored: { pathId: 'via-modem1' } })
    const result = await verifyEgressScript.run(ctx as unknown as ScriptContext<Record<string, never>>)
    expect(result).toEqual({ publicIp: '103.186.169.250', expectedPath: 'via-modem1', matches: null })
  })

  test('a matching reading reports matches:true and never warns', async () => {
    const { ctx, warnings } = fakeCtx({ pages: [node('103.186.169.250')], stored: { pathId: 'via-modem1', lastPublicIp: '103.186.169.250' } })
    const result = await verifyEgressScript.run(ctx as unknown as ScriptContext<Record<string, never>>)
    expect(result).toEqual({ publicIp: '103.186.169.250', expectedPath: 'via-modem1', matches: true })
    expect(warnings).toHaveLength(0)
  })

  test('a mismatch reports matches:false, warns, and still overwrites the stored baseline with the fresh reading', async () => {
    const { ctx, store, warnings } = fakeCtx({ pages: [node('9.9.9.9')], stored: { pathId: 'via-modem1', lastPublicIp: '103.186.169.250' } })
    const result = await verifyEgressScript.run(ctx as unknown as ScriptContext<Record<string, never>>)
    expect(result).toEqual({ publicIp: '9.9.9.9', expectedPath: 'via-modem1', matches: false })
    expect(warnings).toHaveLength(1)
    const saved = store.get(ASSIGNMENT_KEY) as Record<string, unknown>
    expect(saved.lastPublicIp).toBe('9.9.9.9')
  })

  // The "never fabricates a result" path (throwing E_PUBLIC_IP_NOT_FOUND rather than returning a
  // made-up publicIp) is NOT exercised here: the script hardcodes a 45s budget for the real browser
  // probe, and driving that path to its deadline would make this test itself take 45s. The underlying
  // behaviour it depends on — `browseAndExtract` returning `null` once its budget runs out with
  // nothing found — IS exercised, cheaply (a 5ms budget), in `service/browser-probe.test.ts`.
})
