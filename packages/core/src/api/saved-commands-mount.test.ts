import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `createSavedCommandRoutes` (`api/saved-commands.ts`, plan 93 §3.10, §4.4,
 * step 93.6) is fully covered by this package's own unit tests
 * (`saved-commands.test.ts`), exercised directly against the Hono app it
 * returns — the store's uniqueness, cap, and owner-or-admin behaviour are
 * all proven there. What that file can never prove on its own is that the
 * route is actually REACHABLE over real HTTP, and today it is NOT:
 * `packages/core/src/server/http.ts` is held by a concurrent worker (plan
 * 94 step 94.5) for the whole of this step, so `HttpDeps` has no
 * `savedCommandRoutes` field to pass one through at all.
 *
 * This is the mirror image of `api/workflows-wiring.test.ts`'s gap (plan 99
 * step 99.6): THERE, `http.ts` already had the optional field and
 * `daemon.ts` was the file a concurrent worker held, so only the
 * daemon-side wiring was missing. HERE, `daemon.ts` is free but `http.ts`
 * is the blocked file — so `daemon.ts` cannot safely construct-and-pass a
 * `savedCommandRoutes` either: doing so before `HttpDeps` declares the
 * field would be a TypeScript excess-property error on the object literal
 * `const app = createApp({ ... })` already is, trading the one
 * pre-existing `packages/core/src/api/jobs.ts(213,49)` typecheck failure
 * this repo is already waiting on an owner to arbitrate for a SECOND one
 * this step would have introduced. So BOTH edits are outstanding, and this
 * file checks for both by reading source text only (`readFileSync`, never
 * an import of either module), so a failing assertion here can never
 * itself cause a typecheck or boot failure — the same "self-detecting, not
 * self-breaking" property `workflows-wiring.test.ts` and
 * `daemon-wiring.test.ts` already establish for a contested production
 * file.
 *
 * The exact edits, verbatim (see this step's own report for the same
 * text):
 *
 * In `packages/core/src/server/http.ts`, inside the `HttpDeps` interface,
 * beside `commandRunRoutes?: Hono<AuthEnv>`:
 *
 *   savedCommandRoutes?: Hono<AuthEnv>
 *
 * and, beside the existing
 * `if (deps.commandRunRoutes) app.route('/api/command-runs', deps.commandRunRoutes)`:
 *
 *   if (deps.savedCommandRoutes) app.route('/api/saved-commands', deps.savedCommandRoutes)
 *
 * In `packages/core/src/daemon.ts`, an import beside the existing
 * `createCommandRunRoutes` one:
 *
 *   import { createSavedCommandRoutes } from './api/saved-commands'
 *
 * and, inside the `const app = createApp({ ... })` call, beside
 * `commandRunRoutes:`:
 *
 *   savedCommandRoutes: createSavedCommandRoutes({
 *     db,
 *     settings: () => settingsStore.get().shell,
 *     roleOf:
 *       authMode === 'local'
 *         ? () => 'admin'
 *         : (userId) => (userId ? (auth.listUsers().find((u) => u.id === userId)?.role ?? 'operator') : 'operator'),
 *     audit,
 *   }),
 */

const httpSource = readFileSync(join(import.meta.dir, '..', 'server', 'http.ts'), 'utf8')
const daemonSource = readFileSync(join(import.meta.dir, '..', 'daemon.ts'), 'utf8')

describe('http.ts / daemon.ts wiring — /api/saved-commands (plan 93 §3.10, §4.4, step 93.6)', () => {
  test('HttpDeps declares an optional savedCommandRoutes field — without it, daemon.ts can never pass one without breaking typecheck', () => {
    expect(httpSource).toContain('savedCommandRoutes?: Hono<AuthEnv>')
  })

  test("createApp's route table mounts /api/saved-commands when the dep is present — without it, every request 404s through the catch-all forever", () => {
    expect(httpSource).toContain("if (deps.savedCommandRoutes) app.route('/api/saved-commands', deps.savedCommandRoutes)")
  })

  test('daemon.ts imports createSavedCommandRoutes from ./api/saved-commands', () => {
    expect(daemonSource).toContain("import { createSavedCommandRoutes } from './api/saved-commands'")
  })

  test("daemon.ts's createApp({...}) call passes a real savedCommandRoutes — not just declared and left uncalled", () => {
    const marker = 'const app = createApp({'
    const start = daemonSource.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const openBrace = start + marker.length - 1
    let depth = 0
    let i = openBrace
    for (; i < daemonSource.length; i++) {
      if (daemonSource[i] === '{') depth++
      else if (daemonSource[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    const call = daemonSource.slice(openBrace, i + 1)
    expect(call).toContain('savedCommandRoutes:')
    expect(call).toContain('createSavedCommandRoutes(')
  })
})
