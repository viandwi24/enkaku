# Plan 127 — M92 : Every page refresh re-downloads every plugin's UI, and it does not have to

> Status: implemented — steps 127.1–127.4 all land, 2026-08-26, opened the same day from a field report. **Measured on the real built assets: a cold load of the plugin UI goes 159,158 → 46,939 bytes (3.4x) with compression, and a refresh goes 159,158 → 0 bytes** because the assets are now cacheable at URLs that were already version-unique. The two reasons the old `no-store` gave for itself were both re-examined: the `enkaku dev` hot-reload argument does not hold (a dev slot's `buildVersion` increments per rebuild — `dev-slots.ts:127` — so every rebuild is a URL the cache has never seen), and the permission-revocation argument is now a stated trade rather than an unexamined default (what is cached is plugin CODE, never farm data, and `private` keeps it out of every shared cache).
> Depends on: plan 111 (M76, the plugin React UI and `plugin-host.ts`), plan 108 (M73, the asset route), plan 126 (M91, which fixed the JSON payloads and found the rest of the weight).
> Spec references: §19 (Plugins), the plugin asset route.
> Ships: packages/core/src/api/plugins.ts

The owner, on a remote farm: *"Every time the page is refreshed it is very heavy. The plugin list and the sidebar take a long time to inject. **On local it looks fine, because local is not limited by internet speed and bandwidth.**"*

That last sentence is the whole diagnosis. Plan 126 removed megabytes of JSON. What is left is **159 KB of plugin UI assets re-downloaded on every single page load, uncompressed, at URLs the browser is explicitly forbidden to cache** — invisible on loopback, and the dominant cost over a real link.

---

## 0. Evidence

### 0.1 The header

`packages/core/src/api/plugins.ts:440-457`, `GET /:name/ui/:path{.+}`:

```ts
headers: {
  'content-type': asset.contentType,
  'content-length': String(asset.bytes),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}
```

`no-store` is the strongest possible instruction: **never write this to any cache, not even for the back button.** Every refresh re-fetches every byte.

### 0.2 The bytes, measured

Built UI assets in `packages/core/packs/`:

| Asset | Size |
|---|---|
| `proxy-manager-ui/index.js` | 90,701 B |
| `proxy-manager-ui/index.css` | 13,744 B |
| `mikrotik-routing-ui/index.js` | 54,713 B |
| **Total per page load** | **159,158 B** |

And there is **no HTTP compression anywhere in the core** (`grep -rnE "compress|gzip|brotli|deflate" packages/core/src/server/` returns nothing). JavaScript and CSS are the most compressible content there is — typically 3–5× — so this is roughly 159 KB where ~40 KB would do, and 0 KB is what it should be on a refresh.

### 0.3 The URL is ALREADY versioned — so `no-store` is not even buying safety

`packages/studio/src/lib/plugin-host.ts:712`:

```ts
return `${assetUrl(request.pluginName, request.entry)}?v=${encodeURIComponent(request.version)}${retry}`
```

The script URL already carries `?v=<version>`. Its own doc comment at `:94` calls it "the cache-busting version query". **A URL that is already unique per plugin version can never serve stale bytes**, so forbidding the browser to cache it buys nothing at all and costs 145 KB of JavaScript on every navigation.

This is the shape of finding plan 126 §0.2 already recorded once in a different place: a payload nobody wanted, sent because a default was never revisited.

### 0.4 …except the stylesheet, which is NOT versioned

`plugin-host.ts:701`:

```ts
const href = assetUrl(request.pluginName, stylesheetPathFor(request.entry))
```

No `?v=`. So the CSS URL is **not** unique per version, and caching it immutably as-is would serve a stale stylesheet after an operator activates a new version — the exact bug §0.3 says cannot happen for the JS. The asymmetry is real and must be fixed before the header changes, not after.

### 0.5 Why this is the refresh cost and plan 126 was not

Plan 126 removed a ~37.9 MB list payload and the sidebar's repeated fetches of it — enormous, and necessary. But it did not touch asset delivery, and asset delivery is what "the sidebar takes a long time to inject" describes: `plugin-host.ts` injects one `<script type="module">` and one `<link rel="stylesheet">` per (plugin, version, entry), and each is a full uncached download before the plugin's nav or view can render.

On loopback, 159 KB is a few milliseconds. On a farm reached over the internet it is the page.

## 1. Goals

1. A page refresh re-downloads **zero bytes** of plugin UI for a plugin whose active version has not changed.
2. Activating a new plugin version still takes effect immediately, with no stale asset — for the stylesheet as much as the script.
3. First load (cold cache) transfers text assets compressed.
4. Nothing about plugin isolation, verification or the pack format changes.

## 2. Non-goals

- **Bundling plugin UI into Studio's own build.** Plugins are published independently and activate at runtime; that is the whole design (plan 111).
- **A service worker or an offline mode.** Out of proportion.
- **Shrinking the plugin bundles themselves.** 90 KB for a React UI is ordinary. Compression and caching address the delivery, which is where the waste is.
- **Changing the asset URL shape** beyond adding the version query the script URL already has.

## 3. Context and design decisions

### 3.1 `immutable`, not a revalidation

Two ways to stop re-downloading: a strong `ETag` with revalidation (one round trip per asset, zero bytes) or `immutable` (zero round trips, zero bytes). Because §0.3's URL is already version-unique, `immutable` is not merely faster, it is *correct*: the bytes at that exact URL genuinely never change. A revalidation would be a round trip per asset per refresh, on a high-latency link, to learn something the URL already guarantees.

### 3.2 `private`, because the route is authenticated

The route sits behind `requirePermission('script.view')`. `public` would let a shared proxy cache an authenticated response and hand it to another user. `private, max-age=31536000, immutable` lets the operator's own browser keep it and forbids anything in between.

### 3.3 The stylesheet gets the same version query, first

§0.4's asymmetry has to close before the header changes, or the fix trades a bandwidth bug for a correctness bug. `request.version` is already in scope at `plugin-host.ts:701` — the same value the script URL uses one function below.

**Order matters**: version the stylesheet, then relax the header. A worker doing these in the other order ships stale-CSS-after-activate.

### 3.4 Compression is separate, and worth doing anyway

Caching fixes the refresh; compression fixes the *first* load and every JSON response the farm sends. They are independent wins and should not be tangled: if compression breaks something, it must be revertible without giving back the cache fix.

Scope it to text content types and leave binary alone. Note that Bun/Hono may offer this at the server level rather than per-route — prefer the server-level option, because a per-route compressor is one more thing a new route can forget (plan 126 §3.1's rule).

### 3.5 What has to keep working

The retry path. `plugin-host.ts:708-712` appends an extra query parameter on a real retry, deliberately keeping the first, common URL clean. An immutable cache must not make a retry re-serve the failed response from cache — check that the retry's URL is genuinely distinct, and say so.

## 4. Implementation steps

**127.1 — version the stylesheet** (`packages/studio/src/lib/plugin-host.ts:701`). Same `?v=<version>` the script already carries. A test that two versions of one plugin produce two distinct hrefs.

**127.2 — the header** (`packages/core/src/api/plugins.ts:440-457`). `no-store` → `private, max-age=31536000, immutable`. Keep `nosniff` and `referrer-policy` exactly as they are. A test asserting the header, and one asserting the retry URL still differs from the first.

**127.3 — compression** for text responses, server-level if the framework offers it. Measure the transferred size of `index.js` before and after and record the number.

**127.4 — measure the refresh**, the number the owner actually feels: total transferred bytes on a page reload with two plugins active, before and after. This is the acceptance criterion; everything above is a means to it.

## 5. Acceptance criteria

1. A second page load of the same Studio page transfers **zero** bytes for a plugin UI asset whose version has not changed.
2. Activating a new plugin version serves the new script **and the new stylesheet** on the next load, with no manual cache clear.
3. The asset response is compressed on a cold load, and the transferred size is recorded in this plan.
4. `nosniff` and `referrer-policy` are unchanged; the response is `private`, never `public`.
5. A failed asset load can still be retried without the cache re-serving the failure.
6. `bun run typecheck` passes; scoped tests pass for every directory touched.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Stale CSS after activating a new version** — the one real hazard | §3.3: version the stylesheet FIRST, in its own step, with its own test |
| A shared proxy caches an authenticated asset | §3.2: `private`, asserted by a test |
| A one-year `max-age` on a URL that turns out not to be unique | The version query makes it unique; criterion 2 tests the activate path end to end |
| Compression breaks a binary asset | §3.4: text content types only, and a separate step so it reverts alone |
| A retry re-serves the cached failure | §3.5 + criterion 5 |

## 7. Open questions

1. **Should the asset route carry the version in the PATH** (`/:name/:version/ui/:path`) rather than as a query? Cleaner semantically, and it would let a farm keep two versions warm in cache across a rollback. It is also a wire change to a route `plugin-host` and `enkaku dev` both build URLs for, so it is deliberately not done here.
2. **Should compression be farm-wide?** §3.4 leans yes, and plan 126 §9 Q2 already raised it for the JSON routes. Doing it once at the server is better than twice at two routes.


---

## 8. Notes recorded during execution

**Measured, all three numbers:**

| | before | after |
|---|---|---|
| Cold load, plugin UI, transferred | 159,158 B | **46,939 B** (3.4x) |
| `proxy-manager/index.js` | 90,701 B | 28,054 B (3.2x) |
| `proxy-manager/index.css` | 13,744 B | 3,058 B (4.5x) |
| `mikrotik-routing/index.js` | 54,713 B | 15,827 B (3.5x) |
| **Refresh, unchanged version** | **159,158 B** | **0 B** |

**The old header's own comment gave two reasons. One was wrong.**

`plugins-ui.test.ts`'s comment claimed `no-store` "is what makes an `enkaku dev` rebuild serve the NEW component (plan 111 criterion 8)". Checked rather than trusted: `dev-slots.ts:127` mints `buildVersion` as `${declaredVersion}+dev.${n}` with `n` incrementing per rebuild, and `plugin-host.ts` puts that value in `?v=`. **Hot reload never depended on the header at all** — every rebuild already produced a URL no cache had seen. The comment has been rewritten in place rather than deleted, so the record shows what was believed and why it changed.

The second reason — that a cached asset could still be served to an operator who has since lost `script.view` — is true and is accepted, in writing: the cached bytes are plugin code, not device or job data; revoking a permission does not make bytes that browser already fetched and executed secret again; and `private` keeps them out of every shared cache. The measured cost of the alternative was the whole page on a remote farm.

**Compression is mounted globally, and three Hono behaviours are why that is safe** (all verified in its source, not assumed): it deletes `Content-Length` after compressing — which matters because the asset route sets that header explicitly; its content-type filter excludes `text/event-stream` **by name**, so the agent chat's SSE is untouched; and it skips already-encoded responses, `HEAD`, `206`, `no-transform` and every non-compressible type, so screenshots and artifacts pass through byte-for-byte. Four tests pin exactly those properties, because each is a way a global compressor could quietly break something far from this file.

**Not done:** §7 Q1 — moving the version from the query into the path (`/:name/:version/ui/:path`). Still worth doing, still a wire change to a route both `plugin-host` and `enkaku dev` build URLs for, and no longer urgent now that the query achieves the same caching.
