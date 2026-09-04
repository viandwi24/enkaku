/**
 * Where the farm is, answered the same way from Studio's bundle and from a
 * plugin's (plan 111 §3.3, §3.4; 111.7's finding 4).
 *
 * Studio used to answer this privately, in `packages/studio/src/lib/ws.ts`:
 * the `NEXT_PUBLIC_ENKAKU_CORE_URL` build variable, else `location.origin`.
 * That is correct for Studio and unavailable to a plugin, which is a separate
 * bundle with no access to Studio's build-time configuration — so the first
 * tier-C pack derived its own origin from `new URL(import.meta.url).origin`
 * and wrote its own `fetch` helper around it.
 *
 * This is now the ONE definition: `lib/ws.ts` re-exports it rather than
 * keeping a copy, and a plugin gets it through the import map.
 *
 * ## The order
 *
 * 1. **`NEXT_PUBLIC_ENKAKU_CORE_URL`** — the only rung that can be right when
 *    the page and the core are on different origins, which is exactly
 *    `bun run dev:studio` (page on :3001, core on :7700).
 * 2. **`location.origin`** — Studio served by the core, the normal
 *    deployment.
 * 3. **`http://localhost:7700`** — no DOM at all (a unit test, SSR), the
 *    default dev port.
 *
 * Every rung is normalised without its trailing slash, so a caller can always
 * write `` `${coreBase()}/api/…` ``.
 *
 * ## Why `import.meta.url` is NOT a rung here, though it is the right answer
 * ## for a plugin that does its own fetching
 *
 * A plugin's module is served BY the core, so `new URL(import.meta.url).origin`
 * is the core's origin in every deployment — 111.7 found that and it is
 * correct. It does not belong *in this file*, for two measured reasons:
 *
 * - **It would never run.** `@enkaku/ui` is in `UI_EXTERNALS`, so a plugin
 *   importing `coreBase` gets STUDIO's live copy through the import map, not
 *   a copy of its own. In Studio's bundle the module's URL is Studio's page,
 *   which rungs 2 and 3 already answer better.
 * - **Next inlines it, badly.** *(measured, Next 15.5 / SWC, 2026-08-17)* an
 *   `import.meta.url` inside a `transpilePackages` package compiles to a
 *   literal `"file:///Users/…/packages/ui/src/lib/core-base.ts"` — the
 *   maintainer's absolute path, baked into a shipped bundle, and a `file:`
 *   protocol the rung would have to discard anyway. A dead branch that leaks
 *   a home directory is worse than no branch.
 *
 * An author writing a plugin that does not use `@enkaku/ui` at all still
 * wants that expression, and `enkaku init`'s scaffold says so in the file
 * where they would need it. Bun (which builds a plugin's UI) leaves
 * `import.meta.url` alone, so it resolves to the served URL there.
 */

/**
 * `NEXT_PUBLIC_ENKAKU_CORE_URL`, read as a bare member expression inside a
 * `try` rather than behind a `typeof process` guard. Both details matter:
 *
 * - **Bare member expression** — Next substitutes `process.env.NEXT_PUBLIC_*`
 *   textually at build time and only matches that exact shape. Destructuring
 *   it, or reaching it through a variable, gets no substitution and this rung
 *   silently stops working under `bun run dev:studio`. *(verified in the
 *   emitted chunk: this function's body compiles to
 *   `return "http://localhost:7700"`.)*
 * - **`try`, not `typeof`** — a `typeof process !== 'undefined'` guard is
 *   evaluated at RUNTIME in a browser bundle that has no `process`, and it
 *   would short-circuit past the value the bundler had already inlined.
 *   Catching the `ReferenceError` keeps the substituted literal reachable and
 *   still costs nothing where `process` is genuinely absent.
 *
 * The local `declare` below is the third detail, and it is not cosmetic. This
 * package is compiled by whoever imports it, and a plugin author's tsconfig is
 * a browser config with no node or bun types — so `process` is an unresolved
 * name there and `@enkaku/ui` fails to typecheck inside THEIR project while
 * this repo's own `typecheck.sh` stays green (the workspace config does carry
 * bun types, which hides it). `enkaku init`'s scaffold test compiles a real
 * generated project with its own tsconfig and caught exactly that. Declaring
 * the one member this file touches keeps the package self-contained instead of
 * pushing `@types/node` onto every author who wants a Studio component.
 */
declare const process: { env: Record<string, string | undefined> }

function envBase(): string | undefined {
  try {
    return process.env.NEXT_PUBLIC_ENKAKU_CORE_URL
  } catch {
    return undefined
  }
}

export function coreBase(): string {
  const env = envBase()
  if (env) return env.replace(/\/$/, '')
  // `"null"` is the OPAQUE origin, not a missing one: a `file:` document, a
  // sandboxed iframe, `data:` — and `happy-dom`'s default document, which is
  // why nearly fifty of Studio's component tests used to mock `coreBase`
  // rather than let it produce `null/api/devices`. It is never a usable base,
  // so it falls through to the dev default like no DOM at all.
  if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') return location.origin
  return 'http://localhost:7700'
}
