import { describe, expect, test } from 'bun:test'
import type { ArtifactApi, DeviceApi, FarmApi, JobsApi, KvApi, PluginStorage, ScriptContext, ScriptLogger } from '@enkaku/sdk'
import { pickCaption, readCaptionsFile, type CaptionSource } from './captions'

/**
 * Reading a captions file (plan 113 §5 step 113.8, §6 criteria 9). `pickCaption` is pure (no `ctx`);
 * `readCaptionsFile` is exercised against a stubbed `ctx.farm.call`, standing in for the two checks
 * `farm-broker.ts` actually performs (plan 113 §0.3 C3–C5).
 */

const unused = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`readCaptionsFile should not touch ctx.${String(prop)} in this test`)
    },
  },
)

/** `behavior.reject` stands in for whatever `ctx.farm.call` itself rejected with; `behavior.resolve` for its (already-validated) resolution — this test never re-implements the broker's own validation, only what `captions.ts` does with either outcome. */
function fakeCtx(behavior: { resolve?: { content: string; contentType: string }; reject?: unknown }): ScriptContext<unknown> {
  const call: FarmApi['call'] = (async () => {
    if (behavior.reject !== undefined) throw behavior.reject
    return behavior.resolve
  }) as FarmApi['call']
  return {
    device: unused as DeviceApi,
    params: undefined,
    artifact: unused as ArtifactApi,
    log: unused as ScriptLogger,
    job: { id: 'job-1', attempt: 1, deviceId: 'device-1' },
    kv: { device: unused as KvApi, global: unused as KvApi },
    storage: unused as PluginStorage,
    farm: { call, callRaw: unused as FarmApi['callRaw'] },
    jobs: unused as JobsApi,
    progress: () => {},
  }
}

describe('readCaptionsFile — the happy path', () => {
  test('splits on newlines, trims, and drops blank lines', async () => {
    const ctx = fakeCtx({ resolve: { content: '  a  \nb\n\n   \nc\n', contentType: 'text/plain' } })
    const source = await readCaptionsFile(ctx, 'captions.txt')
    expect(source).toEqual({ path: 'captions.txt', lines: ['a', 'b', 'c'] })
  })

  test('a file with only blank lines is refused as empty, not returned as a zero-line source', async () => {
    const ctx = fakeCtx({ resolve: { content: '\n   \n\n', contentType: 'text/plain' } })
    await expect(readCaptionsFile(ctx, 'blank.txt')).rejects.toThrow(/no usable lines/)
  })
})

describe('readCaptionsFile — the base64 trap (the plan\'s own status-line correction #2)', () => {
  test('a non-text contentType is refused rather than decoded as a caption', async () => {
    const ctx = fakeCtx({ resolve: { content: 'AAAAB3ZpZGVv', contentType: 'video/mp4' } })
    await expect(readCaptionsFile(ctx, 'video.mp4')).rejects.toThrow(/not plain text/)
  })

  test('application/json is accepted as text (fs.read never base64-encodes it)', async () => {
    const ctx = fakeCtx({ resolve: { content: '{"a":1}\ncaption line\n', contentType: 'application/json' } })
    const source = await readCaptionsFile(ctx, 'x.json')
    expect(source.lines).toContain('caption line')
  })
})

describe('readCaptionsFile — the three refusals rewritten into sentences naming the fix (plan 113 §0.3 C3–C5, §8)', () => {
  test('E_FARM_UNDECLARED points at defineService({ permissions: [\'fs.read\'] }) and republishing', async () => {
    const ctx = fakeCtx({ reject: Object.assign(new Error('undeclared'), { code: 'E_FARM_UNDECLARED' }) })
    let caught: unknown
    try {
      await readCaptionsFile(ctx, 'captions.txt')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('E_FARM_UNDECLARED')
    expect((caught as Error).message).toContain("defineService({ permissions: ['fs.read'] })")
    expect((caught as Error).message).toMatch(/republish/)
  })

  test('E_FARM_NO_PLUGIN points at the dev-slot ordering constraint (publish once, then iterate)', async () => {
    const ctx = fakeCtx({ reject: Object.assign(new Error('no plugin'), { code: 'E_FARM_NO_PLUGIN' }) })
    let caught: unknown
    try {
      await readCaptionsFile(ctx, 'captions.txt')
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string }).code).toBe('E_FARM_NO_PLUGIN')
    expect((caught as Error).message).toContain('dev slot')
    expect((caught as Error).message).toMatch(/publish the pack once/)
  })

  test('E_FORBIDDEN names the missing role permission, not a bare code', async () => {
    const ctx = fakeCtx({ reject: Object.assign(new Error('forbidden'), { code: 'E_FORBIDDEN' }) })
    let caught: unknown
    try {
      await readCaptionsFile(ctx, 'captions.txt')
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string }).code).toBe('E_FORBIDDEN')
    expect((caught as Error).message).toContain('does not hold the "fs.read" permission')
  })

  test('every other rejection is rethrown UNCHANGED — same error, not a rewritten sentence', async () => {
    const original = Object.assign(new Error('out of scope'), { code: 'E_OUT_OF_SCOPE' })
    const ctx = fakeCtx({ reject: original })
    let caught: unknown
    try {
      await readCaptionsFile(ctx, 'captions.txt')
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(original)
  })
})

describe('pickCaption — pure, no ctx, no device', () => {
  const source: CaptionSource = { path: 'captions.txt', lines: ['a', 'b', 'c'] }

  test('"in-order" advances the cursor by one and wraps modulo the line count', () => {
    expect(pickCaption(source, 'in-order', 0)).toEqual({ caption: 'a', nextCursor: 1 })
    expect(pickCaption(source, 'in-order', 1)).toEqual({ caption: 'b', nextCursor: 2 })
    expect(pickCaption(source, 'in-order', 2)).toEqual({ caption: 'c', nextCursor: 0 })
    expect(pickCaption(source, 'in-order', 3)).toEqual({ caption: 'a', nextCursor: 1 }) // a queue that outlives the file starts back over
  })

  test('"in-order" copes with a negative cursor by wrapping into range rather than throwing or indexing negatively', () => {
    expect(pickCaption(source, 'in-order', -1).caption).toBe('c')
  })

  test('"random" always stays within the source\'s own lines', () => {
    for (let i = 0; i < 50; i++) {
      expect(source.lines).toContain(pickCaption(source, 'random', 0).caption)
    }
  })

  test('a single-line source always returns that line, in-order or random', () => {
    const one: CaptionSource = { path: 'x.txt', lines: ['only'] }
    expect(pickCaption(one, 'in-order', 5).caption).toBe('only')
    expect(pickCaption(one, 'random', 0).caption).toBe('only')
  })

  test('an empty source throws rather than returning an empty caption', () => {
    expect(() => pickCaption({ path: 'x.txt', lines: [] }, 'in-order', 0)).toThrow()
  })
})
