import { describe, expect, test } from 'bun:test'
import type { Transport } from '@enkaku/protocol'
import { UiautomatorDumpInspector } from './uiautomator-dump'

/**
 * `UiautomatorDumpInspector.findDetailed` (plan 74 §3.4, §4.3) — a
 * DELIBERATELY separate implementation from `find()`, not a refactor of it:
 * `find()` must keep returning the first depth-first match regardless of how
 * many nodes matched, so a script bundle published before this plan runs
 * unchanged (criterion 10). `findDetailed()` additionally counts matches via
 * the shared `countMatches`, so it CAN report `ambiguous` for the very same
 * selector `find()` happily resolves to its first hit.
 */

const XML_ONE_MATCH = `<?xml version='1.0'?><hierarchy><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" bounds="[0,0][1080,1920]" clickable="false" enabled="true" focused="false"><node index="0" text="OK" resource-id="com.example:id/ok" class="android.widget.Button" package="com.example" bounds="[10,10][100,60]" clickable="true" enabled="true" focused="false"></node></node></hierarchy>`

const XML_TWO_MATCHES = `<?xml version='1.0'?><hierarchy><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" bounds="[0,0][1080,1920]" clickable="false" enabled="true" focused="false"><node index="0" text="Next" resource-id="com.example:id/next" class="android.widget.Button" package="com.example" bounds="[10,10][100,60]" clickable="true" enabled="true" focused="false"></node><node index="1" text="Next" resource-id="com.example:id/next2" class="android.widget.Button" package="com.example" bounds="[10,80][100,130]" clickable="true" enabled="true" focused="false"></node></node></hierarchy>`

const XML_NO_MATCH = `<?xml version='1.0'?><hierarchy><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" bounds="[0,0][1080,1920]" clickable="false" enabled="true" focused="false"></node></hierarchy>`

function fakeTransport(xml: string): Transport {
  return {
    id: 'fake',
    serial: 'fake-serial',
    stableId: 'fake-stable',
    connect: async () => {},
    disconnect: async () => {},
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    execOut: async () => new TextEncoder().encode(xml),
  }
}

describe('UiautomatorDumpInspector.findDetailed (plan 74 §3.4, §4.3)', () => {
  test('no match: { ok: false, reason: "not-found", matches: 0 }', async () => {
    const inspector = new UiautomatorDumpInspector(fakeTransport(XML_NO_MATCH))
    expect(await inspector.findDetailed({ id: 'ok' })).toEqual({ ok: false, reason: 'not-found', matches: 0 })
  })

  test('exactly one match: { ok: true, node }', async () => {
    const inspector = new UiautomatorDumpInspector(fakeTransport(XML_ONE_MATCH))
    const outcome = await inspector.findDetailed({ id: 'ok' })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.node.resourceId).toBe('com.example:id/ok')
  })

  test('two matches: { ok: false, reason: "ambiguous", matches: 2 } — even though find() would happily return the first', async () => {
    const inspector = new UiautomatorDumpInspector(fakeTransport(XML_TWO_MATCHES))
    const outcome = await inspector.findDetailed({ text: 'Next' })
    expect(outcome).toEqual({ ok: false, reason: 'ambiguous', matches: 2 })

    // criterion 10 — find() itself is UNCHANGED: an ambiguous selector still
    // resolves to the first depth-first match, exactly as before this plan.
    const found = await inspector.find({ text: 'Next' })
    expect(found?.resourceId).toBe('com.example:id/next')
  })

  test('{ point } bypasses the tree entirely, same as find()', async () => {
    const inspector = new UiautomatorDumpInspector(fakeTransport(XML_NO_MATCH))
    const outcome = await inspector.findDetailed({ point: { x: 5, y: 6 } })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.node.className).toBe('synthetic-point')
  })
})

describe('UiautomatorDumpInspector.lastDump (plan 208 §4.6, "the cheap cache")', () => {
  test('null before the first dump', () => {
    const inspector = new UiautomatorDumpInspector(fakeTransport(XML_NO_MATCH))
    expect(inspector.lastDump()).toBeNull()
  })

  test('dump() records lastDump on success', async () => {
    const inspector = new UiautomatorDumpInspector(fakeTransport(XML_ONE_MATCH))
    const before = Date.now()
    const root = await inspector.dump()
    const last = inspector.lastDump()
    expect(last).not.toBeNull()
    expect(last!.root).toEqual(root)
    expect(last!.at).toBeGreaterThanOrEqual(before)
  })
})

/**
 * `/dev/tty` working once must not make its later output trusted.
 *
 * The `else` branch this pins used to return whatever came back as soon as
 * the tty path had succeeded even once — so a device that later printed an
 * error, or nothing, handed that straight to the XML parser and surfaced as
 * "the XML dump has no <hierarchy> element": the symptom named, the phone's
 * own sentence lost (owner, 2026-09-05).
 */
test('a device whose /dev/tty dump stops returning XML falls back to the file path instead of returning junk', async () => {
  const calls: string[] = []
  let ttyCall = 0
  const transport = {
    exec: async (cmd: string) => {
      calls.push(cmd)
      return { stdout: '', stderr: '', exitCode: 0 }
    },
    execOut: async (cmd: string) => {
      calls.push(cmd)
      if (cmd.includes('/dev/tty')) {
        ttyCall += 1
        // First call: a real dump. Second: the phone has stopped cooperating.
        return new TextEncoder().encode(ttyCall === 1 ? XML_ONE_MATCH : 'ERROR: something went wrong')
      }
      return new TextEncoder().encode(XML_ONE_MATCH)
    },
  } as never

  const inspector = new UiautomatorDumpInspector(transport)
  await inspector.dump()
  expect(calls.filter((c) => c.includes('cat '))).toHaveLength(0)

  await inspector.dump()
  // The second dump must have gone through the file, not returned the error.
  expect(calls.filter((c) => c.includes('cat '))).toHaveLength(1)
})
