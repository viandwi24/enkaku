import { describe, expect, test } from 'bun:test'
import { RecordingDocSchema, type RecordingDoc } from '@enkaku/protocol'
import { defineRecording } from '@enkaku/sdk'
import { collectParamNames, emitDetachedScript, emitRecordingEntry, paramsJsonSchemaFor, paramsSchemaFor } from './compile'

/**
 * `compile.ts` (plan 94 §4.7, §5 step 94.5) — the two emitters `POST
 * /api/recordings/:slug/publish` and `.../detach` depend on. Every fixture
 * below is a full, `RecordingDocSchema`-valid document (never a partial
 * object cast) — the same "Zod at every boundary" discipline the rest of
 * this codebase holds to, and it doubles as proof the emitters' OWN output
 * (`emitRecordingEntry`'s embedded JSON) round-trips through the schema
 * that will read it back.
 */

function baseDoc(overrides: Partial<RecordingDoc> = {}): RecordingDoc {
  return RecordingDocSchema.parse({
    schema: 1,
    name: 'checkout-flow',
    version: '1.0.0',
    description: 'Taps through checkout',
    recordedAt: 1_700_000_000,
    recordedOn: { stableId: 'abc123', model: 'moto g06 power', width: 1080, height: 2400 },
    speed: 1,
    maxGapMs: 15_000,
    cleanup: 'force-stop',
    packages: ['com.example.app'],
    steps: [
      { kind: 'tap', gapMs: 400, target: { kind: 'point', pos: { x: 0.5, y: 0.3 } }, holdMs: 80 },
      {
        kind: 'tap',
        gapMs: 250,
        target: { kind: 'selector', selector: { id: 'com.example.app:id/follow_button' }, fallback: { x: 0.6, y: 0.4 } },
        candidate: { selector: { id: 'com.example.app:id/follow_button' }, count: 1, anchorAgeMs: 120, anchorStepsSince: 0, anchorPackage: 'com.example.app' },
      },
      { kind: 'longPress', gapMs: 900, target: { kind: 'point', pos: { x: 0.2, y: 0.8 } }, holdMs: 600 },
      {
        kind: 'gesture',
        gapMs: 300,
        samples: [
          { x: 0.1, y: 0.1, atMs: 0 },
          { x: 0.2, y: 0.2, atMs: 16 },
          { x: 0.3, y: 0.35, atMs: 32 },
        ],
      },
      { kind: 'swipe', gapMs: 150, from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, durationMs: 220 },
      { kind: 'key', gapMs: 100, keycode: 4 },
      { kind: 'text', gapMs: 500, value: 'hunter2' },
      { kind: 'text', gapMs: 200, value: { param: 'caption' } },
    ],
    ...overrides,
  })
}

describe('emitRecordingEntry (plan 94 §4.7)', () => {
  test('is deterministic — the same document compiles to byte-identical text', () => {
    const doc = baseDoc()
    expect(emitRecordingEntry(doc)).toBe(emitRecordingEntry(doc))
    // Re-parsing (as a fresh `write` → `read` → `.parse()` round trip would) does not change the output either.
    const reparsed = RecordingDocSchema.parse(JSON.parse(JSON.stringify(doc)))
    expect(emitRecordingEntry(reparsed)).toBe(emitRecordingEntry(doc))
  })

  test('names the source file and the escape hatch, and imports only @enkaku/sdk', () => {
    const src = emitRecordingEntry(baseDoc())
    expect(src).toContain('/recordings/checkout-flow.recording.json')
    expect(src).toContain('use "Detach" to take ownership')
    expect(src).toContain("import { definePlugin, defineRecording } from '@enkaku/sdk'")
    expect(src).toContain('export default definePlugin(')
  })

  /** Plan 110 §3.4 — the entry is a one-member plugin whose id is the reserved `recordings` owner, whose version is the recording's own, and whose single member is the recording. */
  test('wraps the recording as the only member of the synthetic `recordings` plugin (plan 110 §3.4)', () => {
    const src = emitRecordingEntry(baseDoc({ version: '2.3.4' }))
    expect(src).toContain("id: 'recordings',")
    expect(src).toContain("version: '2.3.4',")
    expect(src).toContain('scripts: [')
    expect(src).toContain('defineRecording(')
  })

  test('embeds the document verbatim — defineRecording accepts the emitted call\'s argument unchanged', () => {
    const doc = baseDoc()
    const src = emitRecordingEntry(doc)
    // Extract the JSON blob between the one `defineRecording(` call and the `),` that closes it.
    const start = src.indexOf('defineRecording(') + 'defineRecording('.length
    const jsonText = src.slice(start, src.lastIndexOf('),\n  ],'))
    const embedded = JSON.parse(jsonText)
    expect(embedded).toEqual(doc)
    // And it is a real, runnable ScriptDefinition — the whole point of F18.
    const def = defineRecording(embedded)
    expect(def.id).toBe('checkout-flow')
    expect(def.version).toBe('1.0.0')
  })

  test('never bundles or imports anything outside @enkaku/sdk (F11 — no new bundling surface)', () => {
    const src = emitRecordingEntry(baseDoc())
    const importLines = src.split('\n').filter((l) => l.trim().startsWith('import '))
    expect(importLines).toEqual(["import { definePlugin, defineRecording } from '@enkaku/sdk'"])
  })
})

describe('collectParamNames / paramsSchemaFor / paramsJsonSchemaFor (plan 94 §4.2)', () => {
  test('collects every distinct {param} reference, sorted, deduplicated', () => {
    const doc = baseDoc({
      steps: [
        { kind: 'text', gapMs: 0, value: { param: 'zeta' } },
        { kind: 'text', gapMs: 0, value: { param: 'alpha' } },
        { kind: 'text', gapMs: 0, value: { param: 'alpha' } },
      ],
    })
    expect(collectParamNames(doc)).toEqual(['alpha', 'zeta'])
  })

  test('a recording with no {param} references declares an empty params object', () => {
    const doc = baseDoc({ steps: [{ kind: 'key', gapMs: 0, keycode: 3 }] })
    expect(collectParamNames(doc)).toEqual([])
    const parsed = paramsSchemaFor(doc).safeParse({})
    expect(parsed.success).toBe(true)
  })

  test('every {param} name becomes a required z.string() field', () => {
    const doc = baseDoc()
    const schema = paramsSchemaFor(doc)
    expect(schema.safeParse({ caption: 'hello' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ caption: 42 }).success).toBe(false)
  })

  test('paramsJsonSchemaFor produces a JSON Schema object naming the same field', () => {
    const doc = baseDoc()
    const jsonSchema = paramsJsonSchemaFor(doc) as { type: string; properties: Record<string, unknown>; required: string[] }
    expect(jsonSchema.type).toBe('object')
    expect(Object.keys(jsonSchema.properties)).toEqual(['caption'])
    expect(jsonSchema.required).toEqual(['caption'])
  })
})

describe('emitDetachedScript (plan 94 §4.7, criterion 4)', () => {
  test('emits a one-member plugin — no defineRecording, no interpreter loop (plan 110 §4.2)', () => {
    const src = emitDetachedScript(baseDoc())
    expect(src).toContain("import { definePlugin } from '@enkaku/sdk'")
    expect(src).not.toContain('defineRecording')
    expect(src).not.toContain('defineScript')
    expect(src).toContain('export default definePlugin({')
    // The `enkaku init` shape: the recording's name as the plugin id, one member `main`.
    expect(src).toContain("id: 'checkout-flow',")
    expect(src).toContain("id: 'main',")
  })

  /** A recording name may hold `.`/`_`; a plugin id may not — detach is where the two shapes meet. */
  test('turns a dotted or underscored recording name into a usable plugin id', () => {
    const src = emitDetachedScript(baseDoc({ name: 'checkout.v2_final' }))
    expect(src).toContain("id: 'checkout-v2-final',")
    expect(src).toContain("title: 'checkout.v2_final',")
  })

  test('expands every step as its own literal, ordered await — one line per action, readable top to bottom (F12)', () => {
    const src = emitDetachedScript(baseDoc())
    // point tap
    expect(src).toContain('await device.tapNorm({ x: 0.5, y: 0.3 }, { holdMs: 80 })')
    // promoted-selector tap
    expect(src).toContain("await device.tap({ id: 'com.example.app:id/follow_button' })")
    // long press on a raw point
    expect(src).toContain('await device.tapNorm({ x: 0.2, y: 0.8 }, { holdMs: 600 })')
    // sampled gesture, verbatim
    expect(src).toContain('await device.gesture([{ x: 0.1, y: 0.1, atMs: 0 }, { x: 0.2, y: 0.2, atMs: 16 }, { x: 0.3, y: 0.35, atMs: 32 }])')
    // swipe
    expect(src).toContain('await device.swipeNorm({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.2 }, 220)')
    // key
    expect(src).toContain('await device.key(4)')
    // literal text, verbatim — this is the whole point of the privacy note (94.5 brief)
    expect(src).toContain("await device.type('hunter2')")
    // parameterised text
    expect(src).toContain('await device.type(ctx.params.caption)')
    // step comments, in order
    expect(src).toContain('// step 1/8: tap')
    expect(src).toContain('// step 8/8: text')
  })

  test('flags a literal typed string in a header comment, so it is visible without reading every line', () => {
    const withLiteral = emitDetachedScript(baseDoc())
    expect(withLiteral).toContain('Contains at least one literal typed string')
    const withoutLiteral = emitDetachedScript(baseDoc({ steps: [{ kind: 'text', gapMs: 0, value: { param: 'x' } }] }))
    expect(withoutLiteral).not.toContain('Contains at least one literal typed string')
  })

  test('bakes speed and maxGapMs into literal sleep() calls — no runtime dependency on the recording document', () => {
    const doc = baseDoc({ speed: 2 })
    const src = emitDetachedScript(doc)
    // step 1's recorded gapMs was 400 at speed 1; at speed 2, effective gap is 800.
    expect(src).toContain('await sleep(800)')
  })

  test('clamps an emitted sleep to maxGapMs, exactly like the interpreter', () => {
    const doc = baseDoc({ maxGapMs: 100, steps: [{ kind: 'key', gapMs: 5_000, keycode: 3 }] })
    expect(emitDetachedScript(doc)).toContain('await sleep(100)')
  })

  test('emits finish() force-stopping the declared packages when cleanup is force-stop', () => {
    const src = emitDetachedScript(baseDoc({ packages: ['com.example.app', 'com.example.other'] }))
    expect(src).toContain('async finish(ctx) {')
    expect(src).toContain("await ctx.device.app.forceStop('com.example.app')")
    expect(src).toContain("await ctx.device.app.forceStop('com.example.other')")
  })

  test('omits finish() entirely when cleanup is none', () => {
    const src = emitDetachedScript(baseDoc({ cleanup: 'none' }))
    expect(src).not.toContain('async finish(ctx)')
  })

  test('declares the same params object shape as the recording (params round-trips)', () => {
    const src = emitDetachedScript(baseDoc())
    expect(src).toContain('params: z.object({ caption: z.string() }),')
    expect(src).toContain("import { z } from 'zod'")
  })

  test('declares an empty params object and skips the zod import when there is nothing to parameterise', () => {
    const src = emitDetachedScript(baseDoc({ steps: [{ kind: 'key', gapMs: 0, keycode: 3 }] }))
    expect(src).toContain('params: z.object({}),')
    expect(src).not.toContain("import { z } from 'zod'")
  })

  test('is deterministic, same as the recording emitter', () => {
    const doc = baseDoc()
    expect(emitDetachedScript(doc)).toBe(emitDetachedScript(doc))
  })

  test('escapes a single quote in a recorded literal string safely', () => {
    const doc = baseDoc({ steps: [{ kind: 'text', gapMs: 0, value: "it's a test" }] })
    const src = emitDetachedScript(doc)
    expect(src).toContain("await device.type('it\\'s a test')")
  })
})
