import { describe, expect, test } from 'bun:test'
import { DEVICE_CALL_ARGS } from '@enkaku/protocol'

/**
 * The device API a script calls is spelled out in THREE places, and nothing
 * made them agree:
 *
 * 1. `packages/sdk/src/types.ts` — `DeviceApi`, what an author's editor checks
 *    against;
 * 2. `packages/session/src/device-executor.ts` — the `switch` that actually
 *    performs the call on a device;
 * 3. `packages/session/src/runner/child-entry.ts` — the `deviceApi` object the
 *    script literally holds, which forwards over IPC.
 *
 * A method present in 1 and 2 but missing from 3 typechecks, publishes,
 * verifies, and then throws `ctx.device.<name> is not a function` on the
 * device. **This happened**: `tapNorm`, `swipeNorm`, `longPress` and `gesture`
 * (plan 94 step 94.2) were declared and implemented and never forwarded, so
 * every recording containing a point tap — `packages/sdk/src/define-recording.ts`
 * calls `device.tapNorm` for exactly that — failed on its first replay. Found
 * on 2026-08-27 by `plugins/youtube-automation-pack`'s first run against real
 * hardware, not by any test.
 *
 * `child-entry.ts` cannot be imported here: it runs `process.on(...)` and
 * `send()` at module scope, as a child process entry point. So the guard reads
 * its SOURCE, the same discipline `packages/core/src/tools/adb-server-control.test.ts`
 * uses for `adb kill-server` — and the same one this file's subject already
 * documents in its own comment about `app.launch`'s dropped `url`: "A field
 * list spelled out in three places will drift; this is the one that decides."
 */

const SOURCE = await Bun.file(new URL('./child-entry.ts', import.meta.url)).text()

/**
 * Every verb the WIRE accepts. Read from `DEVICE_CALL_ARGS` rather than
 * hand-listed, so a verb added to the protocol tomorrow joins this test without
 * anyone remembering to.
 */
const WIRE_METHODS = Object.keys(DEVICE_CALL_ARGS)

/**
 * Verbs the bridge deliberately does not expose to a script, each with the
 * reason it is absent. A method may only be skipped by being named here — the
 * point of the test is that "missing" has to be a decision, not an oversight.
 */
const NOT_FOR_SCRIPTS: Record<string, string> = {}

describe('child-entry deviceApi forwards every device verb the wire accepts', () => {
  test('the wire itself declares the four replay verbs, so the bridge must too', () => {
    // Guards the guard: if these were dropped from the protocol, the loop below
    // would pass by having nothing to check.
    for (const method of ['tapNorm', 'swipeNorm', 'longPress', 'gesture']) {
      expect(WIRE_METHODS).toContain(method)
    }
  })

  for (const method of WIRE_METHODS) {
    const skip = NOT_FOR_SCRIPTS[method]
    test(`${method} is forwarded${skip ? ' — or explicitly excluded' : ''}`, () => {
      if (skip) {
        expect(SOURCE).not.toContain(`method: '${method}'`)
        return
      }
      // The literal the bridge sends. Matching on this rather than on the
      // property name catches the subtler drift: a method defined on the object
      // but forwarding under the wrong verb.
      expect(SOURCE).toContain(`method: '${method}'`)
    })
  }
})

describe('the four replay verbs carry the arguments their schemas require', () => {
  /**
   * `app.launch`'s `url` was declared on the interface and on the wire and
   * dropped by this bridge — the script asked Chrome to open a page, the
   * executor got a bare launch, and the run failed on a page that had never
   * been navigated. Same class of defect one level down: a verb forwarded with
   * the wrong field name is a runtime Zod rejection, not a compile error.
   */
  const REQUIRED: Record<string, readonly string[]> = {
    tapNorm: ['pos'],
    swipeNorm: ['from', 'to', 'ms'],
    longPress: ['target', 'ms'],
    gesture: ['samples'],
  }

  for (const [method, fields] of Object.entries(REQUIRED)) {
    test(`${method} forwards ${fields.join(', ')}`, () => {
      const line = SOURCE.split('\n').find((l) => l.includes(`method: '${method}'`))
      expect(line).toBeDefined()
      for (const field of fields) expect(line).toContain(field)
    })
  }

  test("tapNorm's optional holdMs is forwarded only when present, never as undefined", () => {
    // The schema is `.optional()`; sending `holdMs: undefined` through
    // `JSON.stringify` drops the key anyway, but the conditional spread is what
    // the rest of this file uses and what keeps the intent legible.
    const line = SOURCE.split('\n').find((l) => l.includes("method: 'tapNorm'"))
    expect(line).toContain('opts?.holdMs !== undefined')
  })
})
