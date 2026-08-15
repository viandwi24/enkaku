import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Spawns the REAL `child-entry.ts` against a crafted bundle and captures its
 * first IPC message (`ready` or `result`) — proving the plugin-bundle
 * selection mechanism (plan 82 §3.2, §3.10) actually works at the child
 * process boundary, the same boundary a real job runs through.
 *
 * This is deliberately NOT exercised through `@enkaku/session`'s
 * `job-runner.ts`/`isolation.ts` orchestration (out of bounds for this
 * change — see the plan's own report): it spawns the child directly, the
 * same way `plugins/verify-child.ts` (`packages/core`) spawns its own
 * throwaway child, and passes `ENKAKU_SCRIPT_EXPORT_ID` the same way
 * `isolation.ts`'s existing `SpawnRequest.env` would carry it once a caller
 * populates it — nothing about `child-entry.ts`'s OWN contract changed to
 * make this test possible.
 */

const ENTRY = fileURLToPath(new URL('./child-entry.ts', import.meta.url))

const dirs: string[] = []
function writeBundle(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-child-entry-test-'))
  dirs.push(dir)
  const path = join(dir, 'bundle.mjs')
  Bun.write(path, source)
  return path
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface FirstMessage {
  t: string
  [k: string]: unknown
}

/** Spawns the child, resolves with the FIRST IPC message it sends, then kills it. */
function firstMessage(bundlePath: string, env: Record<string, string> = {}): Promise<FirstMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('timed out waiting for the child\'s first IPC message'))
    }, 10_000)
    const proc = Bun.spawn([process.execPath, ENTRY, bundlePath], {
      ipc(message) {
        clearTimeout(timer)
        resolve(message as FirstMessage)
        proc.kill()
      },
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, ...env },
    })
  })
}

const STANDALONE_BUNDLE = `
export default {
  id: 'checkout',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => 'ok',
  reset: { packages: ['com.example.app'] },
}
`

const PLUGIN_BUNDLE = `
export default {
  id: 'tiktok',
  version: '1.0.0',
  reset: { packages: ['com.zhiliaoapp.musically'] },
  scripts: [
    { id: 'login', version: '1.0.0', params: { parse: (v) => v }, run: async () => 'login-ok', reset: { packages: ['com.zhiliaoapp.musically.extra'] }, runtime: { maxConcurrent: 1 } },
    { id: 'warmup', version: '1.0.0', params: { parse: (v) => v }, run: async () => 'warmup-ok' },
  ],
}
`

describe('child-entry.ts — standalone bundle (criterion 27, backward compatibility)', () => {
  test('a pre-plan-82 bundle (no scripts array) reports ready exactly as before, ignoring the env var', async () => {
    const path = writeBundle(STANDALONE_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'login' })
    expect(msg.t).toBe('ready')
    expect(msg.scriptId).toBe('checkout')
    expect(msg.reset).toEqual({ packages: ['com.example.app'] })
  })

  test('a bundle declaring no `runtime` reports none — `ready.runtime` is absent, not an empty object', async () => {
    const path = writeBundle(STANDALONE_BUNDLE)
    const msg = await firstMessage(path, {})
    expect(msg.t).toBe('ready')
    expect('runtime' in msg).toBe(false)
  })
})

const RUNTIME_BUNDLE = `
export default {
  id: 'checkout',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => 'ok',
  runtime: { timeoutMs: 45_000, retries: 2, maxRssBytes: 128 * 1024 * 1024 },
}
`

describe('child-entry.ts — ready.runtime (plan 98 §3.1, §4.7, §5 step 98.4)', () => {
  test("the bundle's own declared runtime envelope reaches `ready` intact", async () => {
    const path = writeBundle(RUNTIME_BUNDLE)
    const msg = await firstMessage(path, {})
    expect(msg.t).toBe('ready')
    expect(msg.runtime).toEqual({ timeoutMs: 45_000, retries: 2, maxRssBytes: 128 * 1024 * 1024 })
  })
})

describe('child-entry.ts — plugin bundle (plan 82 §3.2)', () => {
  test('selects the right member by ENKAKU_SCRIPT_EXPORT_ID (criterion 3, at the child boundary)', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'login' })
    expect(msg.t).toBe('ready')
    expect(msg.scriptId).toBe('login')
  })

  test('selecting a different member picks a DIFFERENT script out of the SAME bundle', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'warmup' })
    expect(msg.scriptId).toBe('warmup')
  })

  test('the plugin\'s own reset.packages merges with the selected member\'s (criterion 5)', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'login' })
    expect(msg.reset).toEqual({ packages: ['com.zhiliaoapp.musically', 'com.zhiliaoapp.musically.extra'] })
  })

  test('a member with no reset of its own still gets the plugin\'s', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'warmup' })
    expect(msg.reset).toEqual({ packages: ['com.zhiliaoapp.musically'] })
  })

  test("a member's own runtime is reported, independent of its siblings (plan 98 §3.1, §5 step 98.4)", async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const loginMsg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'login' })
    expect(loginMsg.runtime).toEqual({ maxConcurrent: 1 })
    const warmupMsg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'warmup' })
    expect('runtime' in warmupMsg).toBe(false)
  })

  test('no ENKAKU_SCRIPT_EXPORT_ID against a plugin bundle fails cleanly (BAD_BUNDLE), never runs the wrong thing', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, {})
    expect(msg.t).toBe('result')
    expect(msg.ok).toBe(false)
    expect((msg.error as { code: string }).code).toBe('BAD_BUNDLE')
  })

  test('an ENKAKU_SCRIPT_EXPORT_ID naming a script the plugin does not have fails cleanly', async () => {
    const path = writeBundle(PLUGIN_BUNDLE)
    const msg = await firstMessage(path, { ENKAKU_SCRIPT_EXPORT_ID: 'does-not-exist' })
    expect(msg.t).toBe('result')
    expect(msg.ok).toBe(false)
  })
})

/**
 * Plan 98 §3.5, §4.7, H1 — step 98.2, "measure before limiting". Unlike
 * every test above (which never sends `init` and so never runs `runScript`
 * at all), this one drives the REAL child through a full attempt: spawns the
 * real `child-entry.ts`, waits for `ready`, sends a REAL `init` (with
 * `rssSampleMs`), and asserts the child reports a REAL
 * `process.memoryUsage.rss()` reading over IPC before it settles — the exact
 * mechanism `job-runner.ts`'s peak accumulator depends on, exercised at the
 * actual process boundary rather than through the fake isolation harness
 * `job-runner.test.ts` uses. No memory LIMIT is involved anywhere here —
 * that is step 98.3.
 */
describe('child-entry.ts — self-reported RSS (plan 98 §3.5, §4.7, H1)', () => {
  const SLEEPER_BUNDLE = `
export default {
  id: 'sleeper',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => {
    await new Promise((r) => setTimeout(r, 60))
    return 'ok'
  },
}
`

  test('a real run reports a real, positive rss sample over IPC before it settles', async () => {
    const path = writeBundle(SLEEPER_BUNDLE)
    const rssMessage = await new Promise<FirstMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('timed out waiting for an rss message'))
      }, 10_000)
      const proc = Bun.spawn([process.execPath, ENTRY, path], {
        ipc(raw) {
          const msg = raw as FirstMessage
          if (msg.t === 'ready') {
            // A short sample interval so the test does not need to wait 10s
            // for the periodic tick — the CHILD's own immediate first sample
            // (sent the instant `runScript` starts, regardless of cadence)
            // is what this test actually proves exists; a short interval
            // just keeps the test fast if that immediate sample is ever lost.
            proc.send({
              t: 'init',
              mode: 'full',
              job: { id: 'job-1', attempt: 1, deviceId: 'dev-1' },
              params: {},
              rssSampleMs: 200,
              maxResultBytes: 65_536,
            })
          }
          if (msg.t === 'rss') {
            clearTimeout(timer)
            resolve(msg)
            proc.kill()
          }
        },
        stdout: 'ignore',
        stderr: 'ignore',
      })
    })
    expect(rssMessage.t).toBe('rss')
    expect(typeof rssMessage.bytes).toBe('number')
    // A real Bun process importing a bundle and running an event loop is
    // never anywhere near 0 bytes of resident memory.
    expect(rssMessage.bytes as number).toBeGreaterThan(1_000_000)
  })

  test('the immediate first sample arrives well before the sample interval — a job shorter than the interval still gets one', async () => {
    const path = writeBundle(SLEEPER_BUNDLE)
    const start = Date.now()
    const rssMessage = await new Promise<FirstMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('timed out waiting for an rss message'))
      }, 10_000)
      const proc = Bun.spawn([process.execPath, ENTRY, path], {
        ipc(raw) {
          const msg = raw as FirstMessage
          if (msg.t === 'ready') {
            // A LONG interval — if the child only sampled on the tick, this
            // test would time out; it must not depend on the tick at all.
            proc.send({
              t: 'init',
              mode: 'full',
              job: { id: 'job-1', attempt: 1, deviceId: 'dev-1' },
              params: {},
              rssSampleMs: 60_000,
              maxResultBytes: 65_536,
            })
          }
          if (msg.t === 'rss') {
            clearTimeout(timer)
            resolve(msg)
            proc.kill()
          }
        },
        stdout: 'ignore',
        stderr: 'ignore',
      })
    })
    expect(rssMessage.t).toBe('rss')
    expect(Date.now() - start).toBeLessThan(5_000)
  })
})

/**
 * Plan 97 §3.3, §3.4, §3.8, H2, step 97.3 — the runtime: measure, then
 * check, then store. Drives the REAL child through a full attempt (ready →
 * init → result), the same way the RSS suite above does, and reads the
 * `result` message's own `outcome` — proving the behaviour at the actual
 * process boundary rather than through a fake isolation harness.
 */
describe('child-entry.ts — result outcome (plan 97 §3.3, §3.4, §3.8, H2)', () => {
  /** Spawns the child, sends a real `init` once `ready` arrives, resolves with the `result` message. */
  function runToResult(bundlePath: string, opts: { maxResultBytes?: number; params?: unknown } = {}): Promise<FirstMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('timed out waiting for a result message'))
      }, 10_000)
      const proc = Bun.spawn([process.execPath, ENTRY, bundlePath], {
        ipc(raw) {
          const msg = raw as FirstMessage
          if (msg.t === 'ready') {
            proc.send({
              t: 'init',
              mode: 'full',
              job: { id: 'job-1', attempt: 1, deviceId: 'dev-1' },
              params: opts.params ?? {},
              rssSampleMs: 60_000,
              maxResultBytes: opts.maxResultBytes ?? 65_536,
            })
          }
          if (msg.t === 'result') {
            clearTimeout(timer)
            resolve(msg)
            proc.kill()
          }
        },
        stdout: 'ignore',
        stderr: 'ignore',
      })
    })
  }

  test('a script with no `result` declared settles undeclared — byte-identical to today plus the new outcome field (criterion 1)', async () => {
    const path = writeBundle(`
export default {
  id: 'no-result-schema',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => ({ videos: 5 }),
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(true)
    expect(msg.value).toEqual({ videos: 5 })
    expect(msg.outcome).toMatchObject({ status: 'undeclared' })
    expect((msg.outcome as { bytes: number }).bytes).toBeGreaterThan(0)
  })

  test('H2: a circular return value settles invalid with the named message, never a hang — the job settles normally', async () => {
    const path = writeBundle(`
export default {
  id: 'circular',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => {
    const a = {}
    a.self = a
    return a
  },
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(true)
    expect('value' in msg).toBe(false)
    expect(msg.outcome).toMatchObject({ status: 'invalid', bytes: 0 })
    const issues = (msg.outcome as { issues: Array<{ path: string; message: string }> }).issues
    expect(issues[0]?.message).toBe('the result contains a circular reference and could not be stored')
  })

  test('V1/§3.4: an over-cap value settles oversize, sending the verdict without the value', async () => {
    const path = writeBundle(`
export default {
  id: 'huge',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => ({ blob: 'x'.repeat(2000) }),
}
`)
    const msg = await runToResult(path, { maxResultBytes: 1_024 })
    expect(msg.ok).toBe(true)
    expect('value' in msg).toBe(false)
    expect(msg.outcome).toMatchObject({ status: 'oversize' })
    expect((msg.outcome as { bytes: number }).bytes).toBeGreaterThan(1_024)
  })

  test('V3: a __proto__ key at depth settles invalid with the path named, and the value is still sent as inert JSON text', async () => {
    // Built with JSON.parse, not an object literal — `__proto__:` inside a
    // literal is special syntax that sets the prototype instead of creating
    // an own property, which would test nothing (the same reasoning
    // `packages/studio/src/components/schema-form/resolve.test.ts` already
    // documents for the identical hazard one layer up, at a schema's own
    // field names rather than a result's).
    const path = writeBundle(`
export default {
  id: 'dangerous-key',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => JSON.parse('{"nested":{"__proto__":{"hijacked":true}}}'),
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(true)
    expect(msg.outcome).toMatchObject({ status: 'invalid' })
    const issues = (msg.outcome as { issues: Array<{ path: string; message: string }> }).issues
    expect(issues[0]?.path).toBe('nested.__proto__')
    // The value is still stored verbatim (§3.3) — a walker never dereferences
    // it, it is inert text. Checked via the serialised text rather than a
    // deep-equal comparison against an object literal carrying its own
    // `__proto__` key: `{ __proto__: x }` in a LITERAL is special ES syntax
    // that sets the prototype instead of creating an own property — the
    // exact same distinction that makes `run()`'s own `JSON.parse` fixture
    // above the honest way to build the hazard in the first place.
    expect(JSON.stringify(msg.value)).toBe('{"nested":{"__proto__":{"hijacked":true}}}')
  })

  // A hand-rolled `{ safeParse(v) }` object, not a real Zod schema — child-entry.ts's
  // own `BundleDef.result` type only ever calls `.safeParse`, exactly what a real
  // `z.object(...)` provides too (proven separately by `defineScript`'s own runtime
  // check in `sdk/src/define-script.test.ts`); this avoids the tmp-dir bundle needing
  // to resolve `zod` from a directory outside the workspace's own module graph.
  const VIDEOS_SCHEMA = `{
    safeParse: (v) => {
      if (v && typeof v === 'object' && Number.isInteger(v.videos)) return { success: true, data: v }
      return { success: false, error: { issues: [{ path: ['videos'], message: 'expected an integer' }] } }
    },
  }`

  test('a declared result schema that the return value satisfies settles valid', async () => {
    const path = writeBundle(`
export default {
  id: 'declared-valid',
  version: '1.0.0',
  params: { parse: (v) => v },
  result: ${VIDEOS_SCHEMA},
  run: async () => ({ videos: 42 }),
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(true)
    expect(msg.value).toEqual({ videos: 42 })
    expect(msg.outcome).toMatchObject({ status: 'valid' })
  })

  test('a declared result schema the return value does NOT satisfy settles invalid, verdict only — the value is stored verbatim, never coerced (§3.3, F25)', async () => {
    const path = writeBundle(`
export default {
  id: 'declared-invalid',
  version: '1.0.0',
  params: { parse: (v) => v },
  result: ${VIDEOS_SCHEMA},
  run: async () => ({ videos: 'not-a-number', extra: 'kept' }),
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(true)
    // Verbatim — never stripped of the unknown 'extra' key, never coerced.
    expect(msg.value).toEqual({ videos: 'not-a-number', extra: 'kept' })
    expect(msg.outcome).toMatchObject({ status: 'invalid' })
    const issues = (msg.outcome as { issues: Array<{ path: string; message: string }> }).issues
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]?.path).toBe('videos')
  })

  test('the job still settles success even when the result is invalid — output validation is an assertion, never a gate (§3.1)', async () => {
    const path = writeBundle(`
export default {
  id: 'invalid-still-success',
  version: '1.0.0',
  params: { parse: (v) => v },
  result: ${VIDEOS_SCHEMA},
  run: async () => ({ videos: 'nope' }),
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(true) // NOT failed — the device work happened.
    expect('error' in msg).toBe(false)
  })
})

/**
 * Plan 97 §3.5, §4.2, step 97.4 — "a failed run can still say something"
 * (fixes F7/F8). Drives the REAL child through a full attempt exactly like
 * the "result outcome" suite above; this one exercises the FAILURE path.
 */
describe('child-entry.ts — a failed run can still say something (plan 97 §3.5, §4.2, step 97.4)', () => {
  // A hand-rolled `{ safeParse(v) }` object — see the identical const in the
  // "result outcome" describe block above for why (this one is a separate
  // local copy rather than a shared module-level export, since it is only
  // ever spliced verbatim into a template-literal bundle source string).
  const VIDEOS_SCHEMA = `{
    safeParse: (v) => {
      if (v && typeof v === 'object' && Number.isInteger(v.videos)) return { success: true, data: v }
      return { success: false, error: { issues: [{ path: ['videos'], message: 'expected an integer' }] } }
    },
  }`

  function runToResult(bundlePath: string, opts: { maxResultBytes?: number; params?: unknown } = {}): Promise<FirstMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('timed out waiting for a result message'))
      }, 10_000)
      const proc = Bun.spawn([process.execPath, ENTRY, bundlePath], {
        ipc(raw) {
          const msg = raw as FirstMessage
          if (msg.t === 'ready') {
            proc.send({
              t: 'init',
              mode: 'full',
              job: { id: 'job-1', attempt: 1, deviceId: 'dev-1' },
              params: opts.params ?? {},
              rssSampleMs: 60_000,
              maxResultBytes: opts.maxResultBytes ?? 65_536,
            })
          }
          if (msg.t === 'result') {
            clearTimeout(timer)
            resolve(msg)
            proc.kill()
          }
        },
        stdout: 'ignore',
        stderr: 'ignore',
      })
    })
  }

  /** Spawns the child, sends a `finish-only` `init` once `ready` arrives (spec §11.2's fresh-process re-run), resolves with `result`. */
  function runFinishOnlyToResult(bundlePath: string, opts: { maxResultBytes?: number; priorError?: unknown } = {}): Promise<FirstMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('timed out waiting for a result message'))
      }, 10_000)
      const proc = Bun.spawn([process.execPath, ENTRY, bundlePath], {
        ipc(raw) {
          const msg = raw as FirstMessage
          if (msg.t === 'ready') {
            proc.send({
              t: 'init',
              mode: 'finish-only',
              job: { id: 'job-1', attempt: 1, deviceId: 'dev-1' },
              params: {},
              priorError: opts.priorError ?? { code: 'TIMEOUT', message: 'job di-abort (timeout)', phase: 'timeout' },
              rssSampleMs: 60_000,
              maxResultBytes: opts.maxResultBytes ?? 65_536,
            })
          }
          if (msg.t === 'result') {
            clearTimeout(timer)
            resolve(msg)
            proc.kill()
          }
        },
        stdout: 'ignore',
        stderr: 'ignore',
      })
    })
  }

  test('run() throws after doing real work; finish() returns a salvage value — sent as partial, alongside the (unchanged) error', async () => {
    const path = writeBundle(`
export default {
  id: 'salvage',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => { throw new Error('boom after doing real work') },
  finish: async () => ({ videosBeforeFailure: 280 }),
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(false)
    expect(msg.finishRan).toBe(true)
    expect((msg.error as { message: string }).message).toBe('boom after doing real work')
    expect(msg.value).toEqual({ videosBeforeFailure: 280 })
    expect(msg.outcome).toMatchObject({ status: 'partial' })
    // No schema was checked — a `partial` outcome never carries `issues`.
    expect('issues' in (msg.outcome as object)).toBe(false)
  })

  test('the error is byte-identical whether or not finish() salvages a value — 97.4 adds a value, it never changes how the failure is classified/reported', async () => {
    const noSalvage = writeBundle(`
export default {
  id: 'no-salvage',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => { throw new Error('boom after doing real work') },
}
`)
    const withSalvage = writeBundle(`
export default {
  id: 'with-salvage',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => { throw new Error('boom after doing real work') },
  finish: async () => ({ videosBeforeFailure: 280 }),
}
`)
    const [a, b] = await Promise.all([runToResult(noSalvage), runToResult(withSalvage)])
    // `code`/`message`/`phase` only — `stack` legitimately differs (each
    // bundle is written to its OWN tmp dir, so the file path inside the
    // stack trace differs even though nothing about the failure itself does).
    const strip = (e: unknown) => {
      const { code, message, phase } = e as { code: string; message: string; phase: string }
      return { code, message, phase }
    }
    expect(strip(a.error)).toEqual(strip(b.error))
    expect(a.finishRan).toBe(b.finishRan)
  })

  test('finish() returning nothing produces a row identical to today\'s — no value key, no outcome key', async () => {
    const path = writeBundle(`
export default {
  id: 'no-salvage-2',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => { throw new Error('boom') },
  finish: async () => { /* nothing returned */ },
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(false)
    expect('value' in msg).toBe(false)
    expect('outcome' in msg).toBe(false)
  })

  test('a script with no finish() at all is unchanged too — no value key, no outcome key', async () => {
    const path = writeBundle(`
export default {
  id: 'no-finish-at-all',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => { throw new Error('boom') },
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(false)
    expect('value' in msg).toBe(false)
    expect('outcome' in msg).toBe(false)
  })

  test('run()\'s value wins when both exist: run() succeeds, but finish() itself then throws — the job still fails, and the salvage is run()\'s own value, never lost', async () => {
    const path = writeBundle(`
export default {
  id: 'finish-throws-after-success',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => ({ videos: 12 }),
  finish: async () => { throw new Error('finish blew up') },
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(false)
    expect((msg.error as { message: string }).message).toContain('finish blew up')
    expect(msg.value).toEqual({ videos: 12 })
    expect(msg.outcome).toMatchObject({ status: 'partial' })
  })

  test('no schema check ever runs against the salvage, even when the script declared a result schema the salvage would fail (§3.5: "there is no honest lenient schema")', async () => {
    const path = writeBundle(`
export default {
  id: 'salvage-ignores-schema',
  version: '1.0.0',
  params: { parse: (v) => v },
  result: ${VIDEOS_SCHEMA},
  run: async () => { throw new Error('boom') },
  finish: async () => ({ notVideos: 'this would fail the declared schema' }),
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(false)
    expect(msg.value).toEqual({ notVideos: 'this would fail the declared schema' })
    expect(msg.outcome).toMatchObject({ status: 'partial' })
  })

  test('a circular finish() salvage settles invalid, never a hang — the same F10/H2 guard applies to the salvage path too', async () => {
    const path = writeBundle(`
export default {
  id: 'salvage-circular',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => { throw new Error('boom') },
  finish: async () => { const a = {}; a.self = a; return a },
}
`)
    const msg = await runToResult(path)
    expect(msg.ok).toBe(false)
    expect('value' in msg).toBe(false)
    expect(msg.outcome).toMatchObject({ status: 'invalid', bytes: 0 })
  })

  test('an over-cap finish() salvage settles oversize, sending the verdict without the value', async () => {
    const path = writeBundle(`
export default {
  id: 'salvage-oversize',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => { throw new Error('boom') },
  finish: async () => ({ blob: 'x'.repeat(2000) }),
}
`)
    const msg = await runToResult(path, { maxResultBytes: 1_024 })
    expect(msg.ok).toBe(false)
    expect('value' in msg).toBe(false)
    expect(msg.outcome).toMatchObject({ status: 'oversize' })
  })

  test('the finish-only re-attempt path (a fresh process after a timeout kill, spec §11.2) also carries a finish() salvage', async () => {
    const path = writeBundle(`
export default {
  id: 'finish-only-salvage',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => 'unused',
  finish: async () => ({ videosBeforeFailure: 99 }),
}
`)
    const msg = await runFinishOnlyToResult(path)
    expect(msg.ok).toBe(false)
    expect(msg.finishRan).toBe(true)
    expect(msg.value).toEqual({ videosBeforeFailure: 99 })
    expect(msg.outcome).toMatchObject({ status: 'partial' })
  })

  test('a finish-only re-attempt with no salvage returns a row identical to today\'s', async () => {
    const path = writeBundle(`
export default {
  id: 'finish-only-no-salvage',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => 'unused',
  finish: async () => { /* nothing returned */ },
}
`)
    const msg = await runFinishOnlyToResult(path)
    expect(msg.ok).toBe(false)
    expect('value' in msg).toBe(false)
    expect('outcome' in msg).toBe(false)
  })
})

/**
 * Plan 97 §3.7, §4.2, §4.3, H4, §5 step 97.7 — `ctx.progress()`'s child-side
 * coalescing, proven at the REAL process boundary rather than through a
 * fake timer: a script calling `progress()` 10 000 times in a synchronous
 * tight loop must produce at most one `progress` IPC message per
 * `init.progressIntervalMs` tick — the cost of the loop is one assignment
 * per call, never one message per call — and the LAST message received must
 * carry the LAST value the loop set, proving "last value wins" rather than
 * "first value wins" or an arbitrary one.
 */
describe('child-entry.ts — ctx.progress() coalescing (plan 97 §3.7, H4)', () => {
  const TIGHT_LOOP_BUNDLE = `
export default {
  id: 'tight-loop-progress',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async (ctx) => {
    for (let i = 0; i < 10000; i++) ctx.progress({ i })
    // Long enough for a handful of ticks at a short progressIntervalMs, short
    // enough to keep the test fast.
    await new Promise((r) => setTimeout(r, 450))
    return 'ok'
  },
}
`

  test('10 000 synchronous progress() calls in a tight loop produce a SMALL, bounded number of IPC messages, and the last one carries the last value set', async () => {
    const path = writeBundle(TIGHT_LOOP_BUNDLE)
    const progressMessages: FirstMessage[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('timed out waiting for the result message'))
      }, 10_000)
      const proc = Bun.spawn([process.execPath, ENTRY, path], {
        ipc(raw) {
          const msg = raw as FirstMessage
          if (msg.t === 'ready') {
            proc.send({
              t: 'init',
              mode: 'full',
              job: { id: 'job-1', attempt: 1, deviceId: 'dev-1' },
              params: {},
              rssSampleMs: 60_000,
              maxResultBytes: 65_536,
              // A short interval — long enough that 10 000 synchronous calls
              // finish well before the first tick (proving coalescing, not
              // luck), short enough that the 450ms `run()` sleep above spans
              // a handful of ticks.
              progressIntervalMs: 100,
            })
          }
          if (msg.t === 'progress') progressMessages.push(msg)
          if (msg.t === 'result') {
            clearTimeout(timer)
            resolve()
            proc.kill()
          }
        },
        stdout: 'ignore',
        stderr: 'ignore',
      })
    })

    // 10 000 calls into a 450ms run at a 100ms tick: at most ~5 ticks could
    // possibly fire. Nowhere near 10 000 — that is the whole point (an
    // uncoalesced parent would have seen 10 000 messages here).
    expect(progressMessages.length).toBeGreaterThan(0)
    expect(progressMessages.length).toBeLessThan(10)
    // Last value wins: whichever tick(s) fired, the very last progress
    // message must carry the LAST value the loop set (i: 9999) — not the
    // first (i: 0) and not an arbitrary intermediate one.
    expect(progressMessages.at(-1)?.value).toEqual({ i: 9999 })
  })

  test('a script that never calls progress() sends no progress message at all', async () => {
    const path = writeBundle(`
export default {
  id: 'no-progress',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => 'ok',
}
`)
    const progressMessages: FirstMessage[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('timed out waiting for the result message'))
      }, 10_000)
      const proc = Bun.spawn([process.execPath, ENTRY, path], {
        ipc(raw) {
          const msg = raw as FirstMessage
          if (msg.t === 'ready') {
            proc.send({
              t: 'init',
              mode: 'full',
              job: { id: 'job-1', attempt: 1, deviceId: 'dev-1' },
              params: {},
              rssSampleMs: 60_000,
              maxResultBytes: 65_536,
              progressIntervalMs: 100,
            })
          }
          if (msg.t === 'progress') progressMessages.push(msg)
          if (msg.t === 'result') {
            clearTimeout(timer)
            resolve()
            proc.kill()
          }
        },
        stdout: 'ignore',
        stderr: 'ignore',
      })
    })
    expect(progressMessages).toEqual([])
  })
})
