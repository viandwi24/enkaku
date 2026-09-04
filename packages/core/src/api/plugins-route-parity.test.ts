import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_HTTP_METHODS, pluginSocketPath } from '@enkaku/protocol'

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
/**
 * Plan 109 §4.6, step 109.6 — `/:name/http/*` is a plugin's OWN API surface,
 * and its caller is structurally outside `packages/studio/src`.
 *
 * This is the one shape of "absent from Studio" that is genuinely not-operator-
 * facing rather than not-built-yet, and the difference is worth being precise
 * about, because this file exists to refuse the second excuse. Studio cannot
 * call these routes: it does not know a plugin's handler ids, has no request to
 * make of them, and would have to invent one. Their caller is the plugin's own
 * tier-C React view (plan 111), which ships INSIDE the plugin package and
 * reaches the farm through `@enkaku/ui`'s `api()` from `plugins/<name>/ui/`.
 *
 * What is NOT excused, and is covered by real call sites: `GET /:name/query/:id`
 * (Studio's `{ kind: 'handler' }` data source calls it —
 * `components/plugin-view/data.ts`) and `POST /:name/runtime/restart` (the
 * Restart on the failed-service error state — `components/plugin-view/ViewRenderer.tsx`).
 */
const PLUGIN_HTTP_REASON =
  'A `ctx.onRequest` handler is the plugin`s own HTTP surface (plan 109 §4.6, step 109.6), and Studio structurally cannot call it: the ' +
  'handler ids are invented by the plugin at run time and Studio has no request to make of them. Its caller is the plugin`s own tier-C ' +
  'React view, which lives inside the plugin package (plugins/<name>/ui/) and is therefore outside packages/studio/src by construction. ' +
  'The two service routes Studio DOES call — GET /:name/query/:queryId and POST /:name/runtime/restart — are not excused here and have ' +
  'real call sites in components/plugin-view/.'

/**
 * Routes with no Studio caller RIGHT NOW that are not meant to stay that way.
 *
 * This is deliberately a separate list from `NOT_IN_STUDIO_BY_DESIGN`: putting
 * a gap in there would record a decision nobody made, and the next reader
 * would believe it. An entry here is an admission with an owner attached, and
 * the test below refuses one that names no plan.
 */
const UNREACHABLE_PENDING: Record<string, string> = {}

const NOT_IN_STUDIO_BY_DESIGN: Record<string, string> = {
  ...Object.fromEntries(PLUGIN_HTTP_METHODS.map((method) => [`${method} /:name/http/:path{.+}`, PLUGIN_HTTP_REASON])),
  'POST /:name/webhook/:webhookId':
    'An inbound webhook (plan 109 §3.7, step 109.7) is the one route in this router whose caller is, by construction, NOT a farm client: it is a third-party system with no session, no cookie and no role, authorised solely by an HMAC signature over the body it sent. Studio is a farm client; it holds an operator session and nothing to sign with, so a call from it would be a request the route exists to refuse. This is the strongest form of "not operator-facing" this file admits — stronger than the `/http/*` entry above, which Studio merely cannot address — and it is not a stand-in for a missing UI: the operator-facing half of webhooks (see the URL, rotate the secret) is `ctx.webhooks` today, reached from a plugin`s own screen, with the farm-level panel in step 109.12.',
  'PUT /:name/data/entry':
    'A screen never writes an entry directly. §3.7 is that a view mutates only through a DECLARED `kv.set` action, which goes to `POST /:name/action/:actionId` and is evaluated server-side against the surface that was verified. A second, ad-hoc writer in Studio would be exactly the undeclared write path that design forbids. The route completes the `plugin.data` surface (§4.5) for a CLI or a script driving the farm over HTTP.',
  'DELETE /:name/data/entry':
    'The delete half of the same pair, refused from Studio for the same reason: a view deletes through a declared `kv.delete` action. The one bulk delete an operator does need — dropping a plugin\'s whole namespace on remove — is `DELETE /:name/:version?deleteKv=1`, which P4 made reachable in step 108.9.',
  // `GET /:name/:version` was excused here until plan 126 step 126.2, on the
  // reasoning that `GET /` already returned every row of every version so Studio
  // had no request this route would answer better. That reasoning was exactly
  // backwards, and the owner felt it: the only reason the LIST carried a
  // manifest, a declared surface and a service declaration on every one of a
  // farm's twenty-plus version rows was that the detail page read them off it.
  // Studio now calls this route for the one version an operator opened
  // (`app/plugins/detail/page.tsx`, and `ResetPluginAction` for the handler it
  // is about to run), which is what let the list shed all three. The entry is
  // deleted rather than reworded — the route has a caller.
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
 * appears in prose above `POST /:name/action/:actionId` itself), and a comment is not a call
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
  return routesFromSource(stripComments(readFileSync(ROUTER, 'utf8')))
}

/** The extractor, over arbitrary source — so its own control can feed it a two-line router and check what comes back. */
function registeredFrom(raw: string): Route[] {
  return routesFromSource(stripComments(raw))
}

function routesFromSource(src: string): Route[] {
  const routes: Route[] = []
  for (const m of src.matchAll(/\bapp\.(get|post|put|delete|patch)\(\s*'([^']*)'/g)) {
    const method = m[1]!.toUpperCase()
    const path = m[2]!
    routes.push({ method, path, shape: shapeRoute(path), key: `${method} ${path}` })
  }
  /**
   * `app.on([methods], path, …)` — Hono's multi-method form, which step 109.6
   * uses for `/:name/http/*` because the methods a plugin handler answers are
   * the HANDLER's declaration, checked after the lookup, not five separate
   * routes.
   *
   * Extended here rather than worked around, because the alternative is the
   * exact failure this file exists to prevent: a route family the extractor
   * cannot see is a route family that can never be reported unreachable, and
   * the guard would have gone quietly vacuous for a fifth of the plugin
   * surface. `PLUGIN_HTTP_METHODS` is READ from the protocol package rather
   * than re-listed, so a sixth method cannot appear in the router and be
   * invisible here.
   */
  for (const m of src.matchAll(/\bapp\.on\(\s*(\[[^\]]*\])\s*,\s*'([^']*)'/g)) {
    const methodsSrc = m[1]!
    const methods = methodsSrc.includes('PLUGIN_HTTP_METHODS')
      ? [...PLUGIN_HTTP_METHODS]
      : [...methodsSrc.matchAll(/'([A-Z]+)'/g)].map((x) => x[1]!)
    const path = m[2]!
    for (const method of methods) routes.push({ method, path, shape: shapeRoute(path), key: `${method} ${path}` })
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
      /**
       * A URL that ENDS IN A SLASH is a prefix the caller appends to, not a
       * complete address — `lib/plugin-host.ts` builds
       * `` `${base}/api/plugins/${name}/ui/` `` and concatenates each asset path
       * onto it. The segment regex above stops at the trailing slash (there is
       * no non-empty segment after it), so without this the call shaped as
       * `/api/plugins/:x/ui` — which does not match `GET /:name/ui/:path{.+}`
       * (its `**` requires at least one more segment) and DOES match the
       * catch-all `GET /:name/:version` two registrations later.
       *
       * The consequence was both halves of a false report at once: `/ui/**`
       * read as unreachable when Studio plainly reaches it, and
       * `GET /:name/:version` read as "excused but in fact called" when nothing
       * calls it. Treating a trailing slash as `**` is what the source actually
       * means.
       */
      const isPrefix = src[m.index! + raw.length] === '/'
      const shape = [
        MOUNT,
        ...raw
          .slice(MOUNT.length)
          .split('/')
          .filter(Boolean)
          .map((segment) => (segment.includes('${') ? ':x' : segment)),
        ...(isPrefix ? ['**'] : []),
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
    // Step 109.6's three families. The `app.on` pair is the one most likely to
    // be missed: it is registered through a DIFFERENT Hono call than every
    // other route in the file, and before this test knew about `app.on` it saw
    // none of the five.
    expect(keys).toContain('GET /:name/query/:queryId')
    expect(keys).toContain('POST /:name/runtime/restart')
    for (const method of PLUGIN_HTTP_METHODS) expect(keys).toContain(`${method} /:name/http/:path{.+}`)
    // Step 109.7's inbound webhook. Registered inside a NESTED `if` (the
    // service bag, then its optional webhook bag), which is one level deeper
    // than anything the extractor had seen before — and an extractor that
    // stopped at the first block would report it as unregistered, i.e. as a
    // silent pass.
    expect(keys).toContain('POST /:name/webhook/:webhookId')
    expect(routes.length).toBeGreaterThanOrEqual(20)
    expect(calls.length).toBeGreaterThanOrEqual(15)
  })

  /**
   * The `app.on` extractor's own control. Without it the loop above could stop
   * matching and every `app.on` route would silently become "not registered",
   * which reads as a pass on every assertion in this file — the vacuous-pass
   * shape plan 109 §9 Q15 records.
   */
  test('the app.on extractor reads the METHOD LIST from the protocol package, not from a copy', () => {
    const onRoutes = routes.filter((r) => r.path === '/:name/http/:path{.+}')
    expect(onRoutes.map((r) => r.method).sort()).toEqual([...PLUGIN_HTTP_METHODS].sort())
    // Control: a hand-written literal array is read too, so the branch that is
    // NOT taken by today's router still works if somebody writes one.
    expect(registeredFrom(`app.on(['GET', 'HEAD'], '/x/y', h)`).map((r) => r.key)).toEqual(['GET /x/y', 'HEAD /x/y'])
  })

  /**
   * The WS family (`ctx.onSocket`, plan 109 §4.6) is NOT in this router and
   * cannot be: a WebSocket upgrade needs the raw `Request` and the `Bun.serve`
   * instance, which a Hono handler does not have, so it is wired in
   * `daemon.ts`'s own `fetch`. That puts it outside everything above.
   *
   * Left uncovered it would be exactly the hole this file exists to fail on, so
   * what is asserted instead is the two facts that keep it honest: the path
   * comes from `@enkaku/protocol` (never a literal in the core), and the core
   * really does branch on it.
   */
  test('the plugin WebSocket family is wired in daemon.ts, against the protocol`s own path', () => {
    const daemon = readFileSync(join(import.meta.dir, '..', 'daemon.ts'), 'utf8')
    expect(daemon).toContain('parsePluginSocketPath')
    expect(daemon).toContain('pluginSocketRouter.open')
    expect(daemon).toContain('pluginSocketRouter.message')
    expect(daemon).toContain('pluginSocketRouter.close')
    // Control: the protocol's builder and matcher agree, so "daemon uses the
    // matcher" means the address a client would build actually resolves.
    const path = pluginSocketPath('demo', 'feed')
    expect(path).toBe('/api/plugins/demo/socket/feed')
    // …and this router registers no `/socket/` route of its own, so there is
    // exactly one place a plugin socket is addressed. Comments stripped: the
    // prose above `PluginRoutesDeps.service` says the word, and a sentence
    // about a route is not a route.
    expect(stripComments(readFileSync(ROUTER, 'utf8'))).not.toContain('/socket/')
  })

  test('no registered route is unreachable from packages/studio/src', () => {
    const claimed = claimedRouteKeys(routes, calls)
    const unreachable = routes
      .filter((r) => !claimed.has(r.key))
      .map((r) => r.key)
      .filter((key) => !(key in NOT_IN_STUDIO_BY_DESIGN))
      .filter((key) => !(key in UNREACHABLE_PENDING))
    expect(unreachable).toEqual([])
  })

  test('every pending gap names a route that still exists, and an owning plan', () => {
    // The point of the list is that it shrinks. An entry whose route is gone,
    // or whose reason names no owner, is a gap nobody is carrying.
    const keys = new Set(routes.map((r) => r.key))
    for (const [key, reason] of Object.entries(UNREACHABLE_PENDING)) {
      expect({ key, exists: keys.has(key) }).toEqual({ key, exists: true })
      expect(reason).toMatch(/plan \d+/)
    }
    // A gap that has since been closed must be REMOVED from the list, not left
    // as a standing excuse for a route Studio now calls.
    const claimed = claimedRouteKeys(routes, calls)
    expect(Object.keys(UNREACHABLE_PENDING).filter((k) => claimed.has(k))).toEqual([])
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
