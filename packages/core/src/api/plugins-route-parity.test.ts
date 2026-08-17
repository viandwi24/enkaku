import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Plan 108 (M73) §0.2, §5 step 108.12, criterion 19 — **the route-parity
 * guard**.
 *
 * The owner's standing rule for this pass was *"jangan sampai ada plot hole,
 * atau ada fiturnya di server atau core tapi kok di ui ga ada"*. §0.2 found
 * four routes that had shipped with no way to reach them from Studio at all
 * (`POST /api/plugins` — a plugin could only arrive by CLI; `POST
 * /:name/disable`; `DELETE /dev/:name`; and `?deleteKv=1` on the remove
 * route). None of them were bugs in the sense a test could catch: every one
 * worked exactly as written, was covered by its own core test, and was simply
 * unreachable by the person the farm is for.
 *
 * So this reads the ROUTER'S OWN SOURCE rather than a hand-kept list —
 * the same "read the source and fail on a gap" shape
 * `components/layout/AppShell.test.tsx`'s orphan check uses for top-level
 * pages — and fails when a route is registered with no call site anywhere in
 * `packages/studio/src`. Adding a route to `api/plugins.ts` and no caller to
 * Studio breaks this test; that is the whole point of it.
 *
 * **Why it lives in `packages/core`.** It asserts across a package boundary,
 * but it does so by reading files: no DOM, no React, no Studio import. A bare
 * `bun test` from the repo root runs `packages/core` and deliberately does not
 * run `packages/studio` (see CLAUDE.md), so a guard placed in Studio would be
 * the one test most likely to be skipped by whoever is only running the core
 * suite while adding a core route.
 */

const ROUTER = join(import.meta.dir, 'plugins.ts')
/** `import.meta.dir` is `packages/core/src/api` — three levels up is `packages`. */
const STUDIO_SRC = join(import.meta.dir, '..', '..', '..', 'studio', 'src')
/** Every route in this file is mounted here (`server/http.ts`: `app.route('/api/plugins', deps.pluginRoutes)`). */
const MOUNT = '/api/plugins'

/**
 * A route may be absent from Studio only through a named entry here, with a
 * written reason — the discipline `AppShell.test.tsx`'s `NOT_IN_NAV_BY_DESIGN`
 * established. The key is `METHOD ` plus the path EXACTLY as it is registered
 * in `api/plugins.ts`, so an entry is grep-able against the line it excuses.
 *
 * "Not operator-facing" is the only admissible reason. "Nobody has built the
 * UI yet" is not one — that is the gap this file exists to fail on.
 */
const NOT_IN_STUDIO_BY_DESIGN: Record<string, string> = {
  'PUT /:name/data/entry':
    'A screen never writes an entry directly. §3.7 is that a view mutates only through a DECLARED `kv.set` action, which goes to `POST /:name/action/:actionId` and is evaluated server-side against the surface that was verified. A second, ad-hoc writer in Studio would be exactly the undeclared write path that design forbids. The route completes the `plugin.data` surface (§4.5) for a CLI or a script driving the farm over HTTP.',
  'DELETE /:name/data/entry':
    'The delete half of the same pair, refused from Studio for the same reason: a view deletes through a declared `kv.delete` action. The one bulk delete an operator does need — dropping a plugin\'s whole namespace on remove — is `DELETE /:name/:version?deleteKv=1`, which P4 made reachable in step 108.9.',
  'GET /:name/:version':
    'One plugin version row by name and version. `GET /` already returns every row of every version (`runtime.list`), and `app/plugins/page.tsx` renders the whole table from that single read, so Studio has no request that this route would answer better. It stays for `curl` and for the CLI\'s post-publish check.',
  'POST /:id/verify':
    'Verification is not a separate step in any browser flow: `POST /` verifies in the same call unless `stageOnly` is set, and Reload re-verifies a live plugin (both wired in step 108.9). This route is the companion of `enkaku publish --stage-only`, documented in `packages/sdk/src/cli/publish.ts` for a pipeline that wants to stage and verify as two jobs.',
  'POST /dev':
    'A dev slot is pushed by `enkaku dev` from the author\'s machine (`packages/sdk/src/cli/dev.ts`), because it carries a bundle built from local source Studio cannot see. Studio owns the other two thirds of the dev-slot lifecycle — `GET /dev` lists them (`app/device/page.tsx`, `RunScriptDialog`) and `DELETE /dev/:name` drops them (P3, step 108.9).',
}

type Route = { method: string; path: string; shape: string; key: string }
type CallSite = { method: string; shape: string; file: string; raw: string }

/**
 * Comments are stripped before anything is matched, on BOTH sides. This file
 * is full of prose naming routes (`POST /api/plugins/:name/action/:actionId`
 * appears in `frame-rpc.ts`'s own doc table), and a comment is not a call
 * site — counting one would let a route be "covered" by a sentence about it.
 *
 * The line-comment alternative deliberately does not fire after a `:`, so a
 * `http://` inside a string is left alone.
 *
 * ONE pass with an alternation, not two passes — and that is load-bearing.
 * `api/plugins.ts` has a `//` comment containing the literal `` `GET
 * /:name/ui/*` ``. A block-comment pass run FIRST reads that `/*` as an
 * OPENING delimiter and swallows everything down to the next CLOSING one
 * anywhere below it — which silently deleted five route registrations the
 * moment a doc comment was added further down the file. Leftmost-match
 * alternation cannot do that: the `//` starts before the `/*` it contains, so
 * the line-comment branch claims the whole line first.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (_m, before?: string) => before ?? ' ')
}

/**
 * A path → a comparable shape: every parameter collapses to `:x`, and a
 * catch-all (`:path{.+}`) collapses to `**`. Matching on the SHAPE rather than
 * on a literal string is what lets Studio build its URLs the way it actually
 * does — `` `/api/plugins/${encodeURIComponent(plugin)}/data/scan` `` — without
 * this guard needing to evaluate a template literal.
 */
function shapeRoute(path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (!segment.startsWith(':')) return segment
      const brace = segment.indexOf('{')
      if (brace >= 0) {
        const pattern = segment.slice(brace + 1, segment.lastIndexOf('}'))
        if (pattern.includes('.+') || pattern.includes('.*')) return '**'
      }
      return ':x'
    })
  return [MOUNT, ...segments].join('/')
}

/**
 * Every `app.get|post|put|delete|patch('<path>'` in the router's source.
 *
 * Textual on purpose. Two route groups — the five `/:name/data/*` routes and
 * `POST /:name/action/:actionId` — are registered inside `if (deps.data)` /
 * `if (deps.actions)` blocks, behind optional dependency bags, because the
 * `daemon.ts` wiring line is deferred. They are real routes with real Studio
 * call sites, and a guard that constructed a router and enumerated its
 * matcher would see them only when it happened to pass those bags. Reading the
 * file sees them unconditionally, which is the answer that cannot rot.
 */
function registeredRoutes(): Route[] {
  const src = stripComments(readFileSync(ROUTER, 'utf8'))
  const routes: Route[] = []
  for (const m of src.matchAll(/\bapp\.(get|post|put|delete|patch)\(\s*'([^']*)'/g)) {
    const method = m[1]!.toUpperCase()
    const path = m[2]!
    routes.push({ method, path, shape: shapeRoute(path), key: `${method} ${path}` })
  }
  return routes
}

function studioFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) studioFiles(full, out)
    // A test's fetch mock is not a way in. Excluded deliberately: every one of
    // §0.2's four gaps had a passing core test, and a route "covered" by a
    // Studio mock of itself would reproduce that failure exactly.
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Every `/api/plugins...` URL Studio actually builds, with the method it sends. */
function studioCallSites(): CallSite[] {
  const calls: CallSite[] = []
  for (const file of studioFiles(STUDIO_SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const m of src.matchAll(/\/api\/plugins(?:\/(?:\$\{[^}]*\}|[A-Za-z0-9_.%$-]+))*/g)) {
      const raw = m[0]!
      // The method sits in the options object AFTER the url — `api(url, Schema,
      // { method: 'POST' })`. Look no further than the next `/api/` occurrence,
      // so one call's `method:` is never read as the previous call's. No
      // `method:` at all means `api()`'s own default, which is GET.
      const after = src.slice(m.index! + raw.length, m.index! + raw.length + 400)
      const nextUrl = after.indexOf('/api/')
      const window = nextUrl >= 0 ? after.slice(0, nextUrl) : after
      const method = window.match(/method:\s*'([A-Z]+)'/)?.[1] ?? 'GET'
      const shape = [
        MOUNT,
        ...raw
          .slice(MOUNT.length)
          .split('/')
          .filter(Boolean)
          .map((segment) => (segment.includes('${') ? ':x' : segment)),
      ].join('/')
      calls.push({ method, shape, file: file.slice(STUDIO_SRC.length + 1), raw })
    }
  }
  return calls
}

/**
 * A route shape against a call shape. A call's `:x` is an unknown value and
 * matches only a route PARAMETER — never a literal — because Studio writing
 * `` `/api/plugins/${name}/${version}` `` must not be read as a call to
 * `DELETE /dev/:name`.
 */
function matchesShape(route: string, call: string): boolean {
  const r = route.split('/')
  const c = call.split('/')
  for (let i = 0; i < r.length; i++) {
    if (r[i] === '**') return c.length > i
    if (i >= c.length) return false
    if (r[i] === ':x') continue
    if (r[i] !== c[i]) return false
  }
  return r.length === c.length
}

/**
 * Assign each call site to the FIRST route that matches it, in registration
 * order — which is how Hono resolves a request, and therefore the only
 * assignment that says anything true. Without it, `GET /:name/:version` (the
 * most generic pattern in the file) would silently absorb the `GET
 * /:name/data` call site that never reaches it, and this guard would report a
 * route as covered on the strength of a request that lands somewhere else.
 */
function claimedRouteKeys(routes: Route[], calls: CallSite[]): Set<string> {
  const claimed = new Set<string>()
  for (const call of calls) {
    const first = routes.find((r) => r.method === call.method && matchesShape(r.shape, call.shape))
    if (first) claimed.add(first.key)
  }
  return claimed
}

describe('every /api/plugins route has a way in from Studio (plan 108 step 108.12)', () => {
  const routes = registeredRoutes()
  const calls = studioCallSites()

  test('the extractor is not vacuous — it sees the conditionally registered routes too', () => {
    // If the regex ever stops matching, every assertion below passes for the
    // wrong reason. These are the routes most likely to be missed: two live
    // inside `if (deps.data)` / `if (deps.actions)`, and one carries a Hono
    // path pattern (`:path{.+}`).
    const keys = routes.map((r) => r.key)
    expect(keys).toContain('GET /:name/data/scan')
    expect(keys).toContain('PUT /:name/data/entry')
    expect(keys).toContain('POST /:name/action/:actionId')
    expect(keys).toContain('GET /:name/ui/:path{.+}')
    expect(routes.length).toBeGreaterThanOrEqual(20)
    expect(calls.length).toBeGreaterThanOrEqual(15)
  })

  test('no registered route is unreachable from packages/studio/src', () => {
    const claimed = claimedRouteKeys(routes, calls)
    const unreachable = routes
      .filter((r) => !claimed.has(r.key))
      .map((r) => r.key)
      .filter((key) => !(key in NOT_IN_STUDIO_BY_DESIGN))
    expect(unreachable).toEqual([])
  })

  test('every opt-out names a route that still exists, and gives a real reason', () => {
    // A stale opt-out is worse than none: it is a written promise that a gap
    // was considered, covering a route that has since been renamed.
    const keys = new Set(routes.map((r) => r.key))
    for (const [key, reason] of Object.entries(NOT_IN_STUDIO_BY_DESIGN)) {
      expect({ key, exists: keys.has(key) }).toEqual({ key, exists: true })
      expect(reason.length).toBeGreaterThan(40)
    }
  })

  test('no opt-out excuses a route Studio does in fact call', () => {
    // The reverse rot: a route gains a caller, and the entry excusing it stays
    // behind as a false statement about how the product works.
    const claimed = claimedRouteKeys(routes, calls)
    const excusedButCalled = Object.keys(NOT_IN_STUDIO_BY_DESIGN).filter((key) => claimed.has(key))
    expect(excusedButCalled).toEqual([])
  })

  test('every /api/plugins URL Studio builds resolves to a registered route', () => {
    // Parity in the other direction — a Studio call to a route that was
    // renamed or removed is a 404 nobody sees until an operator clicks it.
    const dangling = calls
      .filter((call) => !routes.some((r) => r.method === call.method && matchesShape(r.shape, call.shape)))
      .map((call) => `${call.method} ${call.raw} (${call.file})`)
    expect(dangling).toEqual([])
  })
})
