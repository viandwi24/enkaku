# Plan 111 — M76 : A plugin's UI is React, with no ceiling

> Status: implemented — written 2026-08-17 after the owner rejected the sandboxed-iframe ceiling, and built the same day. (The word is `implemented`, not `complete`: `scripts/check-plan-status.sh` recognises `implemented`/`partial`/`draft`, and a plan inventing a fourth word reads to that guard as unshipped — which this one did, giving a false red on a plan whose `Ships:` artefact exists.) **Landed:** 111.0 (probe — all three hypotheses proved, with identity checks in both dev and the static export), 111.1 (`packages/ui` extracted: 28 components + `cn`, 176 Studio files rewritten to import it, tier B deleted), 111.4 (`react` in the manifest, `frame` out, `apiVersion` checked at verify), 111.5 (folded into 111.1/111.4 — there was nothing left to delete separately), 111.6 (`enkaku init` scaffolds React, `enkaku dev` pushes a package), 111.2 (`plugin-host.ts` — blob shims, identity verified in a real Chromium), 111.3 (`ReactView.tsx`, the error boundary, Q2's passthrough params, retry), 111.8 (docs), 111.9 (a plugin compiles its own stylesheet — §9 Q1, decided during the build and inserted as a step; `@enkaku/ui/theme.css` is now the ONE definition of the tokens, read by Studio and by every plugin's own Tailwind), 111.7 (Proxy Manager rebuilt on tier C with three tabs, and the host's `<link>` injection that 111.9 handed over), 111.10 (the §3.3 behaviour layer actually extracted — `api`/`useAction`/`coreBase`/the three state panels/`ConfirmDialog`/the formatters/`z`/`PluginViewProps`, 115 Studio files rewritten onto them, and Proxy Manager's hand-written copies deleted; added after 111.7 found the promise unkept).
>
> Three corrections the build made to this document: (1) §9 Q1 and Q2 were open questions and are now decided in place, with Q1 growing a step of its own — the tempting answer (add `@source '../../plugins'` to Studio's CSS) reaches only packs living in this repo, so it would have let 111.7 pass while no third-party `.enkaku` could. (2) `PluginSurfaceShapeSchema` **required** `actions`, so 111.6's scaffold was emitting a project that could not publish at all; it now defaults to `{}`, which is right on the merits — a tier-C view calls `fetch` directly (§3.4), so a complete React plugin declares none. (3) The farm's UI major is a constant in `@enkaku/protocol`, not read from `packages/ui/package.json`: that package is `private` at `0.0.1`, so deriving from it would force every plugin to declare `apiVersion: 0` and leave no way to signal a break before 1.0 — and the core cannot read a workspace file at runtime from a `--compile` binary anyway.
>
> **What 111.7 — the first real pack on the tier — proved wrong, in the order it hurt:**
>
> **All eight are now addressed** — 1, 3, 4 and 6 by step **111.10** (see §5 and the rewritten §3.3), the rest by the text below them. Kept as written, rather than edited into agreement, because what a first real consumer hit and in what order is the useful record.
>
> 1. **§3.3's list of what `@enkaku/ui` carries is wrong.** It promises `PageHeader`, `EmptyState`/`ErrorState`/`LoadingRows`, `ConfirmDialog`, `useAction`, `api()` and `formatFieldValue` "beyond the 28 components". 111.1 shipped **the 28 components and `cn`, and nothing else** — `src/index.ts` is 28 `export *` lines plus that helper. So the first tier-C pack wrote its own `farm()` (about thirty lines, no schema library) and its own three state panels (about forty). Neither is a hardship and both are honest demonstrations of §3.4's "ordinary `fetch`", but the sentence in §3.3 describes a package that does not exist and would send an author looking for imports that are not there. Either extract those pieces too or delete the claim; do not leave it as written.
> 2. **The embedded-pack format carried no `ui/`, and Proxy Manager is an embedded pack.** `scripts/build-packs.ts` emitted one `.mjs` per pack and `seedEmbeddedPacks` called `runtime.stage({ bundle })` — true for as long as every shipped pack was tier A. Left alone, every fresh install of the release binary would have staged a `proxy-manager` whose `react` view 404s on its module: a named error panel, put there by the release itself, on a pack the operator never installed. **Fixed in this step** — `packs/index.json` gains a `ui` array, `EmbeddedPack` gains `ui`, `gen-embedded-entry.ts` embeds each asset with `with { type: 'file' }`, and `seedEmbeddedPacks` passes them to `stage({ ui })`, which is the same door a `.enkaku` upload already used. `build-packs.ts` calls the SDK's own `buildUiAssets`, not a second implementation. §4.2's file list should have named these three files.
> 3. **Nothing publishes the view props type.** Q2 decided `params`/`setParams`; `PluginViewProps` lives in `packages/studio/src/lib/plugin-host.ts` and is exported to no package a plugin can import, and `enkaku init`'s `enkaku-host.d.ts` declares only `register(viewId, ComponentType)` — no props at all. So this pack **hand-wrote `EnkakuPluginViewProps`**, and nothing checks it against the host's. That is a real drift surface on the one contract §9 Q2 exists to define; the shape belongs in `@enkaku/protocol` (types only, no runtime) or in the scaffold's `.d.ts`.
> 4. **A plugin cannot learn the core's origin, and the plan never noticed.** `fetch('/api/…')` is only correct when Studio is served BY the core; under `bun run dev:studio` the page is on :3001 and the core on :7700, and §3.4 says nothing about it. The answer this pack found and that should become the documented one: **`new URL(import.meta.url).origin`** — the module was served by the core, so its own URL is the core's, in every deployment. Worth putting in the scaffold.
> 5. **`src/ui/` is flat for ENTRIES, which forces a multi-file screen into a subdirectory.** `build-ui.ts` treats every top-level `.tsx` as a build entry (`!f.includes('/')`), so `src/ui/catalogue.tsx` would silently become a second `ui/catalogue.js` in the package rather than a component. A screen of any size therefore keeps its parts under `src/ui/parts/`. Correct behaviour, undocumented consequence — §4.4 and `enkaku init`'s comment should say so.
> 6. **An in-repo tier-C pack needs `lib: ["ES2023", "DOM"]`, not just `jsx: "react-jsx"`.** `enkaku init`'s standalone tsconfig has both; a pack under `plugins/` extends `tsconfig.base.json`, whose `lib` is `["ES2022"]` with `types: ["bun"]`, so `window` and every `e.target.value` fail under `scripts/typecheck.sh`. 111.6 could not have seen this — it only ever generated the standalone shape.
> 7. **The `<link>` dedupe key is (plugin, entry), by 111.9's own contract — so within ONE document a dev rebuild keeps the old stylesheet.** The module URL varies on `?v=<buildVersion>` and re-evaluates; the stylesheet URL deliberately does not, so re-mounting after an `enkaku dev` push re-runs the new JS against the previously linked CSS. Criterion 9's word "reload" is therefore load-bearing for CSS in a way it is not for JS. Implemented as specified — recorded here because the asymmetry is not obvious from either half.
> 8. **Q2's passthrough, judged as a consumer: genuinely pleasant, with one gap.** Two independent URL-backed controls (`tab` and `q`) were written without either knowing the other existed, the "absent means untouched" rule is what made that free, and passing `null` to drop a key is what keeps `&q=` out of the URL when the filter is empty. `setParams`'s stable identity mattered immediately — it went straight into a `useCallback` dependency array. The gap is that the host takes no position at all, which is right, but leaves every plugin to re-derive the same three lines: validate the value against its own enum, fall back to a default, and remember that a URL is something a person can type. That is the correct division; it just wants a sentence in the docs rather than each author discovering it.
>
> Verified in a real browser (Chromium via CDP, against the static export served by a core on :7701, 2026-08-17): the three tabs render and switch; `Tabs`, `Table`, `Dialog`, `Select`, `Badge`, `Input`, `Textarea` and `Skeleton` from `@enkaku/ui` all render as their Studio selves; hooks work in the plugin's own module and in a hook it defines (`useLoader`); the injected `<link>` is `…/ui/index.css` and the plugin's own `bg-[repeating-linear-gradient(…)]` computes to a real gradient while `grid-cols-[max-content_1fr]` computes to `34.89px 415.11px`; switching a tab rewrites the URL and a **full page load** of `…&tab=assignments` lands on Assignments; add, edit, delete and a device-scoped assignment all write through `/data/entry` and re-read; and the console is **empty** across a full load and every interaction — in particular no `Invalid hook call`.
> Depends on: Plan 108 (M73) — the surface manifest, the `.enkaku` package with its `ui/` directory, the asset route, `plugin.data`, and the action executor. This plan replaces plan 108's tier B and keeps its tier A.
> Spec references: §11.3 (the trust model), §11.6 (plugins), §19 (Studio screens)
> Ships: packages/studio/src/lib/plugin-host.ts

---

## 0. Evidence

### 0.1 The decision, and the reasoning behind it

The owner's goal, verbatim: *"tujuannya biar fully developer bisa melakukan apapun sesukanya terhadap ui, tidak terbatas ketentuan, kalau mau bikin tabs, bikin apapun itu misalnya... makanya perlu punya akses seluas mungkin terhadap ui."*

And their model of how a plugin should work: *"dev bisa bikin ui dengan react; dev bisa extend route http api atau websocket; dev bisa build pluginsnya."*

Plan 108 §3.2 refused exactly this ("tier C") on one ground: Studio is a static export served **same-origin** by the core and holds the operator's session, so plugin JS in that page runs with whoever is logged in. The owner was shown the concrete consequence — a plugin installed by an operator, running with an admin's token the moment an admin opens the page, with the audit log naming the admin — and **accepted it**, on reasoning worth recording because it is sound:

> *"plugin juga kan berjalan langsung di servernya, jadi ga ada masalah operatornya siapa."*

A plugin's server half already runs arbitrary code with the core's full OS authority (spec §11.3 — a script bundle is not sandboxed). A plugin author is therefore **already** trusted absolutely. Giving their browser half the operator's session extends that trust to nobody new. Plan 108's refusal was internally inconsistent with the trust model the farm already has, and this plan corrects it.

**The one real consequence, accepted rather than solved:** the audit log records the session that acted, so a plugin's action is attributed to the operator whose browser ran it, not to its author. Written here so it is a known property, not a later surprise.

### 0.2 Confirmed findings — is it even possible?

| # | Finding | Evidence |
|---|---|---|
| **T1** | **Studio pages carry no `Content-Security-Policy` header at all.** Loading a same-origin module at runtime is not blocked by anything. (The strict CSP plan 108 added applies only to `/api/plugins/:name/ui/*` responses under the iframe tier — this plan removes that tier and revisits the header.) | grep over `packages/core/src/server/http.ts`, 2026-08-17 |
| **T2** | Next **15.1**, `output: 'export'`, `reactStrictMode: true`, `transpilePackages: ['@enkaku/protocol']`. Nothing else. | `packages/studio/next.config.ts` |
| **T3** | **Never use `import(expr)` from inside Studio's own source.** Webpack and Turbopack rewrite dynamic imports at build time; a specifier they cannot statically analyse becomes a warning, a context module, or a build failure. The clean path is a DOM-injected `<script type="module">` — the bundler never sees it. | Next bundler behaviour; no existing runtime dynamic import in Studio to copy |
| **T4** | **React 19, one instance.** A plugin that bundles its own React can only render into its own root and can never use a Studio component (those close over the host's React). Hooks across two instances throw `Invalid hook call`. So React MUST be shared, not bundled. | `packages/studio/package.json:30-31` |
| **T5** | **28 components already exist** under `packages/studio/src/components/ui/` — including `tabs.tsx`, the owner's own example — plus `table`, `dialog`, `select`, `command`, `popover`, `sheet`, `dropdown-menu`, `scroll-area`, `slider`, `switch`, `progress`, `tooltip`. There is a real library to expose; none of it needs writing. | `ls packages/studio/src/components/ui/` |
| **T6** | The asset route, the package `ui/` directory, its entry allowlist, and the content-addressed asset store **already exist** from plan 108 step 108.10. Only the renderer changes. | `packages/core/src/api/plugins.ts:275`; `packages/core/src/plugins/asset-store.ts` |
| **T7** | `AuthGate` wraps every route and only renders `AppShell` once a session exists — so there is exactly one place where a host API can be published before any plugin code runs. | `packages/studio/src/app/layout.tsx` |

### 0.3 Hypotheses

| # | Hypothesis | Probe |
|---|---|---|
| **H1** | A DOM-injected `<script type="module">` pointing at `/api/plugins/:name/ui/index.js` loads and executes in a statically-exported Next page, and the bundler does not interfere. | Inject one against the existing asset route and confirm it registers. **Do this before writing anything else — the whole plan rests on it.** |
| **H2** | An import map inserted at runtime, immediately before the plugin's script tag, correctly resolves the plugin's bare `react` / `@enkaku/ui` specifiers to host-provided shim modules. | A fixture plugin importing both, rendering a Studio `Tabs`. |
| **H3** | A plugin component rendered inside Studio's tree can use hooks and Studio components with no `Invalid hook call`. | H2's fixture, with `useState` inside. |

---

## 1. Goals

1. **A plugin author writes ordinary React** — `import { useState } from 'react'`, their own components, their own layout, tabs, charts, anything. No vocabulary, no ceiling.
2. **They can use Studio's own components**, so a plugin screen is indistinguishable from a built-in one unless the author chooses otherwise.
3. **They build with ordinary tools** — the scaffold configures the externals; `enkaku publish` ships the result.
4. **`enkaku dev` iterates a UI**, including its assets. Plan 108 §9 Q3 left this broken; a React tier is unusable without it.
5. **Tier A survives** for what it is genuinely good at: a table or a form with no build step at all.
6. **Tier B is removed**, not left as a third path.

## 2. Non-goals

- **Isolation of any kind.** §0.1 — plugin UI code runs with the operator's session, deliberately. This plan must not grow a half-sandbox that provides neither safety nor freedom.
- **A stable public component API.** Studio's `ui/` components are internal and will change. §3.5 says how that is handled honestly rather than by freezing them.
- **Server-side plugin routes.** That is the owner's second point and remains plan 109.
- **Plugin-authored changes to Studio's chrome** — the sidebar, the shell, other screens. A plugin owns its own view and nothing outside it.

## 3. Context and design decisions

### 3.1 Loading: a DOM script tag, never `import()`

T3 is the load-bearing constraint. Studio injects:

```html
<script type="module" src="/api/plugins/<name>/ui/<entry>"></script>
```

into the document at view-mount time. The bundler is not involved, so nothing is rewritten, and the existing asset route (T6) already serves it with a correct content type.

The module does not export — it **registers**:

```ts
window.__enkaku__.register('accounts', AccountsView)
```

Registration rather than a module export, because a script tag has no return value; the host waits on a promise keyed by `(plugin, viewId)` that the registry resolves.

**One load per plugin per page.** A second view from the same plugin reuses the already-executed module. A plugin reload (dev slot rebuild) needs a cache-busting query and a fresh registration — the registry keys on `(plugin, version, viewId)` so a rebuild cannot serve a stale component.

### 3.2 Sharing React: an import map, inserted before the first plugin script

T4 makes sharing mandatory. Two mechanisms were considered:

| | globals (`window.__enkaku__.react`) | **import map** |
|---|---|---|
| Author writes | `const { useState } = window.__enkaku__.react` | `import { useState } from 'react'` |
| Build config | externals mapped to globals | ESM externals, nothing else |
| Feels like | a plugin API | ordinary React |

**Chosen: an import map.** The whole point of this plan is that an author writes ordinary React; making them reach through a global would undercut it at the first line of every file.

Studio inserts, once, before the first plugin script tag:

```html
<script type="importmap">
{ "imports": { "react": "/…/react-shim.js", "react/jsx-runtime": "…", "react-dom": "…", "@enkaku/ui": "…" } }
</script>
```

The shims are tiny same-origin modules Studio serves, each re-exporting the host's live instance. **Ordering is the hazard**: an import map must exist before any module resolution it affects. Inserting it before the first plugin script satisfies that, and it is inserted exactly once, guarded.

### 3.3 The components move to `packages/ui`, imported by Studio *and* by plugins

An earlier draft made this a "types plus a re-export list" package. That was hand-waving, and the owner called it: a hand-maintained mirror of Studio's components is **guaranteed to drift** from the components it describes.

The real answer is to extract them. Measured before deciding, so the cost is known rather than guessed:

| | |
|---|---|
| Studio files importing `@/components/ui/` | **161** — a mechanical rename, one script |
| What those 28 components depend on | `react`, `radix-ui`, `class-variance-authority`, `lucide-react`, each other — and exactly **one** Studio-internal thing: `cn` from `@/lib/utils`, a three-line helper that moves with them |

So the dependency surface is clean npm plus one helper. `packages/ui` holds the components; Studio imports it, and so does a plugin.

**Two problems, and only one of them is solved by moving files** — worth separating, because conflating them is what produced the vague draft:

- **Build time.** A plugin author writes `import { Tabs } from '@enkaku/ui'` and TypeScript resolves real types from a real package. This is what the extraction buys, and there is no other honest way to get it.
- **Runtime.** The plugin must receive the **host's live instance**, not a second copy — T4. That is decided entirely by the import map and the shim (§3.2), and would be identical whether the components lived here or stayed in Studio. The plugin's build marks `@enkaku/ui` external; the shim re-exports what Studio already bundled.

Two constraints this must respect, both already established in the repo:

- **The two TypeScripts do not merge** (`CLAUDE.md`). `packages/studio` is deliberately standalone on TypeScript 5 with a tsconfig that does not extend the base, because Next needs the TS 5 compiler API. So `packages/ui` lives under the **root** TypeScript and Studio consumes it through `transpilePackages` — the same crossing `@enkaku/protocol` already makes every day. Not a new exception.
- **Tailwind must scan it.** The components are styled with Tailwind v4 classes; if Studio's stylesheet does not treat `packages/ui` as a source, every component renders **unstyled**. One `@source` directive in Studio's CSS, and the same preset is what a plugin needs to write new classes of its own (Q1).

Beyond the 28 components, the package carries the pieces that make a plugin screen **behave** like a Studio screen rather than merely look like one. An author who wants none of it writes plain HTML and their own CSS — that is the point of the tier.

> **This paragraph was false when 111.1 shipped, and is now true — but not with the list it originally named.** 111.1 shipped the 28 components and `cn`; none of the seven promised pieces existed, and 111.7 found out the way an author would, by hand-writing a `farm()` fetch helper (~30 lines) and its own loading/empty/error panels (~40). The extraction was done as its own pass, starting from Studio's actual screens rather than from the list above. **Six of the seven were extracted; one — `PageHeader` — was refused on the merits**, and three things nobody had listed turned out to matter more, one of them load-bearing. What follows is what is actually in the package.

**Extracted, one copy, Studio rewritten onto it:**

| What | Where it was | Studio call sites |
|---|---|---|
| `EmptyState`, `ErrorState`, `LoadingRows` | `studio/src/components/states.tsx` | 49 files |
| `ConfirmDialog` | `studio/src/components/ConfirmDialog.tsx` | 19 files |
| `api()`, `useAction()`, `describeApiError`, `issuesFromError`, `BadResponseError`, `ApiError` | `studio/src/lib/actions.ts` | 79 files |
| `relativeTime`, `duration`, `fileSize`, `formatFieldValue`, `formatTokens`, `formatUsd` | `studio/src/lib/format.ts` | 51 files |
| **`coreBase()` / `setCoreBase()`** | `studio/src/lib/ws.ts` | 23 files (re-exported from `@/lib/ws`, so those are unchanged) |
| **`z`** — Zod itself, one re-exported name | — | — |
| **`PluginViewProps`, `PluginViewParams`, `SetPluginViewParams`** | `studio/src/lib/plugin-host.ts` → now `@enkaku/protocol`, re-exported here | — |

`coreBase()` is the piece the original list missed and the one that decides whether `api()` is genuinely shared. Studio could answer "where is the core" privately — `NEXT_PUBLIC_ENKAKU_CORE_URL`, else `location.origin` — and 111.7, unable to reach either, answered it with `new URL(import.meta.url).origin`.

**Both answers are right, and the resolution is that only one of them has to run.** `@enkaku/ui` is in `UI_EXTERNALS`, so a plugin importing `coreBase` (or `api`, which calls it) executes **Studio's live copy** through the import map — the same mechanism that gives it Studio's React. Studio's answer is therefore the plugin's answer, and it is correct in both deployments: served by the core, `location.origin` is the core; under `bun run dev:studio`, the env variable is `http://localhost:7700` while the page is on :3001, which is exactly where the plugin's own module came from. *(Verified in the emitted chunk: Next substitutes the variable inside the transpiled package, so `envBase()` compiles to `return "http://localhost:7700"`.)*

Two consequences worth writing down:

- **`credentials: 'include'` moved into `api()`.** That dev split is cross-origin, and the default `same-origin` policy sends no cookie — every plugin read would 401 on a farm the operator is plainly logged into. 111.7 hit this and set it in its own `farm()`; it belongs in the shared helper, and it is a no-op same-origin. The core already answers loopback origins with `Access-Control-Allow-Credentials: true`.
- **`import.meta.url` is deliberately NOT a rung inside `coreBase()`**, though it stays the documented answer for a plugin that declines `@enkaku/ui` and fetches for itself (the scaffold says so). It would never run — a plugin gets Studio's copy — and *(measured, Next 15.5 / SWC)* an `import.meta.url` inside a `transpilePackages` package compiles to a literal `file:///Users/…/core-base.ts`: a dead branch that bakes the maintainer's absolute path into a shipped bundle.

`z` is here for the same reason. `api()` takes a schema as a required argument (plan 72 §3.3), so a plugin that cannot reach Zod cannot use `api()` at all — and reaching it through its own `package.json` bundles a second copy, since `zod` is not in `UI_EXTERNALS`. One re-exported name makes the host's copy free.

**Refused, and why. An honest smaller list beats a restored promise:**

- **`PageHeader`.** It is Studio's chrome, not a component. `app/plugins/view/page.tsx` **already renders one** above every plugin view, titled from the manifest's own `title`/`description`, and it is `sticky top-0 z-10` positioned against the shell's scroll container. A plugin drawing a second one produces two stacked sticky bars — and §2 already lists Studio's chrome as a non-goal for plugins. Exporting it would have advertised a bug.
- **`PaginatedTable`.** Genuinely repeated (13 Studio screens) and genuinely tempting, but its `Page<T>` is the core's own keyset envelope from plan 30 — `items`/`nextCursor`/`total` — which Studio's list routes return and a plugin's routes are under no obligation to. Sharing it publishes an internal pagination contract as a plugin API, and loosening `total` to make a plugin fit would weaken it for the 13 screens that rely on it. Left in Studio; a candidate for a later pass with a deliberate plugin-facing shape.
- **`useLoader`** (the load/reload/unmount-safe hook 111.7 wrote) and **`StatusDot`.** Neither has a canonical Studio version to share — Studio's screens each roll their own loader, and `StatusBadge` knows the farm's job and device vocabularies. Extracting either would have meant *inventing* an API and calling it an extraction. They stay in the pack that wrote them.

**The proof, which is the same pack that found the gap.** Proxy Manager now imports `api`, `z`, `EmptyState`, `ErrorState`, `LoadingRows`, `relativeTime` and `PluginViewProps` from `@enkaku/ui`. What it deleted, exactly:

- `parts/api.ts` — `CORE_ORIGIN`'s `import.meta.url` block (9 lines), `farm()` (10), `errorMessage()` (7) and `when()` (4). **30 lines**, which is precisely the "~30 lines" 111.7 reported writing. Its six hand-written wire `interface`s became six Zod schemas of about the same length, so the file is the same size and now **validates** what it reads instead of casting it.
- `parts/bits.tsx` — `LoadingRows`, `EmptyPanel` and `ErrorPanel`, **34 lines**, against 111.7's reported "~40". Three of its five exports; `useLoader` and `StatusDot` are all that is left, and both are refusals above rather than oversights.
- `src/enkaku-host.d.ts` — the hand-copied `EnkakuPluginViewProps`, **25 lines**, replaced by one `import type`.

**Total file size is flat** (44.1K → 44.2K across the pack's seven UI files), and that is worth stating rather than dressing up: 89 lines of infrastructure came out, and comments recording what moved and why went in. The wins are that the code is gone, that its empty and failed states are now drawn by the same components the jobs list draws, and that the props type can no longer drift. Its honesty copy — the hazard-striped banner and the standing notes that nothing here contacts a proxy — is untouched, and `index.test.ts` still asserts it.

### 3.4 Data and actions: ordinary `fetch`, plus what already exists

With no sandbox there is no bridge. A plugin's React calls `fetch` directly with the operator's session, exactly as Studio does. `@enkaku/ui` re-exports Studio's own `api()` helper so a plugin gets Zod-validated responses and the same error handling for free.

The declared data sources and actions from plan 108 do **not** go away — `/api/plugins/:name/data/*` and `POST /:name/action/:actionId` are useful whether the caller is a declared table or a hand-written component, and the action executor is still the only path that resolves a `ScriptRef` server-side and audits as `plugin.action`. A React view is free to call them or to ignore them.

### 3.5 Version coupling, stated rather than frozen

Sharing Studio's live components means a plugin built against today's `Table` breaks if `Table`'s props change. Freezing them would freeze Studio.

So: `@enkaku/ui` carries a **major version**, the plugin declares which one it was built against (`surface.ui.apiVersion`), and **verify refuses a mismatch** with a message naming both. That is the same shape `runtime.sdk` already has for scripts (plan 98) — a known, checked incompatibility rather than a runtime explosion in the operator's face.

### 3.6 Tier A stays, tier B goes

**Tier A stays.** Proxy Manager proved it: a catalogue with working CRUD, forms, validation, confirmations and toasts, with zero build step, zero npm install, zero bundler. Requiring a frontend project for one table would be worse.

**Tier B goes.** Once React with full access exists, nobody would choose a sandboxed iframe that cannot even `fetch`. 00-overview §4.3 forbids keeping a weaker parallel path "for one release". `FrameView.tsx`, `frame-rpc.ts`, `ViewSpecSchema.frame` and the iframe CSP are removed in the same change that lands tier C — not deprecated.

This deletes code written earlier the same day. That is the correct outcome of a decision made after seeing it, and the cost of keeping it — three tiers, two of which overlap — is higher than the cost of removing it.

---

## 4. Technical design

### 4.1 The manifest

```ts
surface: {
  nav: [{ id, label, icon, view }],
  views: {
    accounts: { title, description?, react: { entry: 'index.js', apiVersion: 1 } },   // tier C
    simple:   { title, data: {...}, table: {...} },                                    // tier A, unchanged
  },
  actions: { … },                                                                      // unchanged, usable by both
}
```

`react` and `table` are mutually exclusive; `data` remains legal beside either (plan 108 §9 Q4's correction stands — a React view may declare a source and read it through the same route).

### 4.2 Files

```
packages/ui/                               NEW — the 28 components + `cn`, moved out of Studio. Root TS.
packages/studio/**                         161 import sites renamed to `@enkaku/ui`; transpilePackages + @source
packages/studio/src/lib/plugin-host.ts     NEW — the registry, the import map, script injection, load-once
packages/studio/src/lib/plugin-shims/      STRUCK — see below; the shims are built at runtime, so there are no files
packages/studio/src/components/plugin-view/ReactView.tsx   NEW — mounts a registered component
packages/studio/src/components/plugin-view/FrameView.tsx   DELETE
packages/studio/src/components/plugin-view/frame-rpc.ts    DELETE
packages/protocol/src/plugin-surface.ts    + `react`, − `frame`
packages/core/src/plugins/verify-child*.ts + apiVersion check, − frame validation
packages/sdk/src/cli/{init,dev,publish}.ts scaffold a React project; `dev` pushes a PACKAGE, not a bundle
packages/core/src/api/plugins.ts           dev-slot assets; the `/ui/*` CSP revisited (no longer an iframe)
plugins/proxy-manager/                     rebuilt on tier C — see §4.3
```

**Two corrections 111.2 made to this section, both from building it:**

- **There is no `plugin-shims/` directory.** The shims are `blob:` modules generated at runtime, because `@enkaku/ui` has **125** exports (counted at runtime, not estimated) and ESM cannot re-export a namespace dynamically — a file on disk would have to *enumerate* every name, which is codegen plus a guard against drift. A body built from `Object.keys(ns)` cannot drift by construction. The one cost of a blob, an unreadable URL in stack traces, is bought back with `//# sourceURL=enkaku:shim/react`; a deliberate throw from inside a shim reports `at enkaku:shim/react:3:16`, verified in a real browser.
- **The script URL must carry `?v=<version>`, which this plan never said.** Criterion 8 depends on it and `cache-control` cannot deliver it: the browser's module map is **per-document and keyed on URL**, so re-injecting the same URL after a dev rebuild hands back the already-evaluated old module no matter what the response headers say. A dev slot must therefore vary that string on every rebuild — a constant `"dev"` defeats both the registry key and the query, and fails silently by showing yesterday's component. (It does vary: a dev slot's `buildVersion` is `` `${declaredVersion}+dev.${n}` `` with `n` incremented on every push. The internal `assetKey` deliberately does *not*, and never reaches Studio.)

And one from 111.3, which is the same browser rule biting from the other side: **a module map entry caches failure, not just success.** Once a URL has failed to fetch or parse in a document, every later import of that exact URL is answered from the cached failure with no network request. So a Retry button cannot work by forgetting the module and re-injecting the same script — it would re-report the old error instantly, a control that looks live and refuses, which `docs/design.md`'s quality floor forbids. Retry therefore appends `&retry=<n>`: a different URL is a different module map entry, and no `forget()` on the host is needed at all.

### 4.3 Which pack gets rebuilt, and why proxy-manager

**Proxy Manager**, not TikTok Accounts.

TikTok Accounts is a table over scanned KV — precisely what tier A is for, and rebuilding it in React would prove nothing except that React can draw a table. Proxy Manager is where the owner's own goal bites: it wants **tabs** (catalogue / assignments / logs), a form that is more than a flat schema, and eventually live output. Rebuilding it is a real comparison, and it leaves one pack on each tier so the two can be judged side by side.

### 4.4 `enkaku dev` must push a package

Plan 108 §9 Q3: `dev.ts` posts `{ name, bundle }`, and only `POST /api/plugins` accepts an archive, so a dev slot never carries `ui/`. A React tier is unusable without a rebuild loop, so this stops being a known gap and becomes a step: `enkaku dev` builds the UI too, posts a package, and the dev slot stores its assets the way an activated version does.

---

## 5. Implementation steps

**111.0 — Probe H1/H2/H3 first.** A throwaway module served from the existing asset route, injected as a script tag, registering a component that uses `useState` and a Studio `Tabs`. **If the import map or the shared React does not work, stop and report** — every step below assumes all three.

**111.1 — Extract `packages/ui`.** Move the 28 components and `cn`; move their npm dependencies; rename Studio's 161 import sites in one scripted pass; add `@enkaku/ui` to `transpilePackages` and to Tailwind's `@source`; add it to `scripts/typecheck.sh` (which enumerates paths explicitly — a new package is invisible to it otherwise, as `proxy-manager` just proved). **Studio must render byte-identically afterwards** — this step changes where code lives and nothing else, and is verified on that basis before anything is built on top of it.

**111.2 — `plugin-host.ts`.** Registry keyed on `(plugin, version, viewId)`, import-map insertion (once, guarded, before the first script), script injection, load-once per plugin, error surfacing when a module throws or never registers.

**111.3 — `ReactView.tsx`** and the page routing to it, with all three states (loading the module, module failed, view registered).

**111.4 — Manifest + verify.** `react` in, `frame` out, `apiVersion` checked at verify.

**111.5 — Remove tier B.** `FrameView`, `frame-rpc`, the schema member, the iframe CSP, and their tests.

**111.6 — `enkaku init` scaffolds a React plugin**; `enkaku dev` pushes a package (§4.4).

**111.9 — A plugin compiles its own stylesheet** (§9 Q1). **LANDED.** `@enkaku/ui` exports `theme.css`; `enkaku publish`/`enkaku dev` run Tailwind over `src/ui/` emitting utilities **without preflight**; the package carries `ui/<name>.css`; the host injects a `<link>` beside the script. Ordered before 111.7, which is the first pack that needs a class Studio never used.

> **Correction, found in the browser after 111.9 shipped: preflight was not the only way a plugin's stylesheet reaches Studio's own layout, and the guarantee was one channel short.**
>
> 111.9 guarded two channels and proved both — no preflight in the plugin's output, and no re-emitted theme variables. A third was missed: **cascade-layer ordering.** The scaffold wrote `@import 'tailwindcss/utilities.css' layer(utilities)`, putting the plugin's utilities in the **same layer as Studio's**. Layers of the same name merge, and within a layer document order breaks ties — the plugin's `<link>` is injected *after* Studio's stylesheet, so the plugin wins every collision at equal specificity.
>
> Observed live on `proxy-manager@0.3.0` at 1426 px: the plugin's sheet emitted `.flex{display:flex}` because its own markup uses `flex`. That beat Studio's `.lg\:hidden{display:none}` on `AppShell`'s mobile header, which stopped hiding — a second Enkaku top bar appeared inside the content area on a desktop screen. **The plugin's stylesheet never mentioned `lg:hidden` at all**; it only had to define one utility Studio also uses. Every guard 111.9 built still passed, because the sheet contained no preflight marker and no `:root` block.
>
> Fixed by declaring the order in Studio's `globals.css`, before the Tailwind import (a bare `@layer` statement is one of the few rules CSS permits ahead of `@import`):
>
> ```css
> @layer theme, base, components, plugin, utilities;
> ```
>
> and compiling a plugin's sheet into `layer(plugin)`. Naming `plugin` *before* `utilities` makes the host win every tie regardless of injection order, while a plugin's own classes — the arbitrary values Studio never generated, which are the entire reason the sheet exists — collide with nothing and are unaffected. A plugin can no longer override a Studio utility, which is the right answer: the host owns the page.
>
> The general lesson, and the reason this is written at length: **"the plugin's CSS must not restyle Studio" is an absence claim, and 111.9 tested two of its three channels.** A plugin needs no malice and no unusual CSS to break the host — sharing one ordinary utility name is sufficient.

What the build settled, beyond what §9 Q1 already decided:

- **The v4 syntax, verified against the installed Tailwind (4.3.3), not assumed.** The plugin's stylesheet is three imports: `@import 'tailwindcss/theme.css' theme(reference);`, `@import 'tailwindcss/utilities.css' layer(utilities);`, `@import '@enkaku/ui/theme.css' theme(reference);`. `@reference` is the wrong tool here — it makes an *entire* stylesheet reference-only, which would emit nothing at all.
- **`theme(reference)` is stronger than "does not emit".** *(measured)* it compiles `bg-surface` to `background-color: var(--color-surface, oklch(0.209 0.004 245))` — a var against Studio's live token, with the build-time value as a fallback. So the default Tailwind palette is referenced too: Studio emits only the tokens it *uses* (no `--color-purple-500` anywhere in its 103 KB output), and referencing both themes is the one arrangement where a plugin can neither override a host token nor end up with an unresolved one.
- **`@custom-variant hover-none` moved with the tokens**, judged on the merits: it names a device capability, not a `WallTile` detail, and an unknown variant compiles to nothing with no error — exactly the silent failure this step exists to kill. It emits no CSS, so sharing it costs nothing.
- **A convention, not a manifest field:** `ui/<entry-basename>.css` beside `ui/<entry-basename>.js`, from `src/ui/<entry>.css` beside `src/ui/<entry>.tsx`. `packages/protocol` is untouched. A `.css` under a *different* name stays a verbatim static asset — but one that imports Tailwind under a different name is **refused**, rather than shipped as raw source.
- **The compiler is the project's.** `@enkaku/sdk` gains no Tailwind dependency (it is bundled into every plugin); `enkaku init` puts `@tailwindcss/cli` + `tailwindcss` in the *scaffolded project's* devDependencies and `build-ui.ts` walks up to `node_modules/.bin/tailwindcss`. The repo root gains both as devDependencies so in-repo plugins (111.7) and the SDK's own tests have one.
- **Proven, not asserted.** Byte-identical Studio CSS before/after the extraction; a negative control (import removed) loses 35 KB and every Enkaku token; and a live computed-style check in a real browser against the built export served on :7700 — with Studio's sheet the plugin's `bg-surface` computes to `oklch(0.209 0.004 245)` and `grid-cols-[200px_1fr]` works, and with the plugin's sheet *alone* the page keeps the UA's own `body` margin of 8px and `p` margin of 16px, which is preflight's absence measured rather than grepped.

**The contract 111.2's host must implement:** for a view whose `react.entry` is `<E>.js`, inject `<link rel="stylesheet" href="/api/plugins/<name>/ui/<E>.css">` **before** the `<script type="module">` for `<E>.js`, deduplicated on the same (plugin, entry) key the module load already uses — one `<link>` per entry, not per view, so two views sharing an entry link it once. The CSS is **optional**: a plugin with no stylesheet answers 404 (`ui_asset_not_found`), which is expected and harmless — set `link.onerror = () => link.remove()` so a missing stylesheet leaves no dead node. Never remove the `<link>` on unmount: utilities are idempotent by construction, and a re-mount would re-fetch. The asset route already serves `.css` as `text/css; charset=utf-8` with `no-store`, so an `enkaku dev` rebuild picks up new CSS with no cache-busting.

**111.7 — Rebuild Proxy Manager on tier C** with tabs, proving the goal against a real pack. **LANDED.** Three tabs — Catalogue (the tier-A screen's job, done in React), Assignments (every device joined to the one device-scoped key it may hold, through `GET /:name/data/scan`), Runs (this pack's own jobs). No `data`, no `table`, no `actions`: the view calls `fetch` directly (§3.4), writing through `PUT/DELETE /api/plugins/proxy-manager/data/entry`, which is the operator-facing `plugin.data` door and audits every write. `tab` and `q` live in the URL through Q2's passthrough. Two classes Studio has never compiled (`bg-[repeating-linear-gradient(…)]`, `grid-cols-[max-content_1fr]`) exercise 111.9 with a real pack rather than a fixture, and both were chosen to fail VISIBLY if the stylesheet never arrives.

The honesty copy (criterion 12) had to move rather than survive in place: the old test read `view.empty.hint`, and a tier-C view has no declared empty state. The seven sentences now live in `plugins/proxy-manager/src/shared.ts` — a dependency-free module BOTH halves import, because `record.ts` pulls in `zod` and `@enkaku/sdk` and importing it from the browser entry would inline both — and `index.test.ts` asserts that the manifest uses those exact constants, that the React sources name every one of them, and that neither half hard-codes a duplicate. That is a stronger guard than the one it replaces. The drift guard moved the same way: tier A got it free by deriving its form and its columns from one Zod object, so the React half funnels every write through `writeProxy` and every read through `readProxy`, and the test **runs both** and parses the result against `ProxyRecordSchema`.

Also landed here, as 111.9's handover: `plugin-host.ts` injects the `<link>` — `injectStylesheet` on the DOM seam, `stylesheetPathFor` deriving `index.css` from `index.js`, one link per (plugin, entry), never removed on unmount, and `realDom` taking the node back out on error so a plugin with no stylesheet leaves nothing behind. That last behaviour is tested against a real document: *(measured, happy-dom 15.11.7)* `disableCSSFileLoading` turns the append into a synchronous `error`, and `handleDisabledFileLoadingAsSuccess` into a synchronous `load`, so both branches are reachable with no network and no faked event.

**111.10 — Close the §3.3 promise** (added after 111.7, which is what found it open). **LANDED.** `@enkaku/ui` gains the behaviour layer §3.3 described: `states.tsx`, `ConfirmDialog`, `lib/actions.ts` (`api`, `useAction`, `describeApiError`, `issuesFromError`, `BadResponseError`), `lib/format.ts` and a new `lib/core-base.ts`, plus `z` and the view-props types. 115 Studio files were rewritten onto them in one scripted pass (specifier swap, then a `[^{}]*`-scoped merge of the duplicate `@enkaku/ui` import each swap produced), Studio's own copies deleted, `@/lib/ws` reduced to a re-export of `coreBase`, and Proxy Manager's hand-written `farm()`, three panels and copied props type deleted with them. §3.3 above records what was refused and why. Two follow-ups closed with it: `PluginViewProps` now lives in `@enkaku/protocol` and is imported by `plugin-host.ts`, `@enkaku/ui`, the scaffold and the pack, so drift is a compile error; and `new URL(import.meta.url).origin` is a rung inside `coreBase()` rather than something each pack rediscovers. The third — an in-repo tier-C pack needing `jsx: react-jsx` and `lib: […, "DOM"]` — was already closed by 111.7: `plugins/proxy-manager/tsconfig.json` sets both over `tsconfig.base.json`, which is the right place for it, since loosening the base would hand `window` to every Bun-side package in the workspace.

**Verified, 2026-08-17:**

- **A negative control on the stylesheet, rooted where the real build roots it.** Compiling `globals.css` with the Tailwind CLI from `packages/studio` (Tailwind's detection base under `@tailwindcss/postcss`) emits 1143 class names with `@source '../../../ui/src'` and **801** without it. All 40 classes the two moved components use are present in the real build, and two of them — `size-9` and `h-14` — exist **only** because of that `@source`, which is the proof the moved files are now scanned from their new home and not by accident from their old one. (A first attempt rooted at the repo root showed **zero** difference, because Tailwind's automatic detection reaches the whole monorepo from there — the wrong control, recorded so it is not repeated.)
- **Computed styles in a real browser**, against Studio's dev server on :3001 and against a throwaway core on :7702 serving the static export. Studio's own `EmptyState` on `/schedules` and the *plugin's* `EmptyState` on the Proxy Manager screen compute identically: `border-style: dashed`, `border-radius: 9.6px`, `padding: 48px 24px`, `text-align: center`, and a 36×36 `grid`/`place-items:center` icon chip on `oklch(0.159 0.004 245)`. `ErrorState` was exercised on `/device?id=does-not-exist` — `border-led-danger/40`, `bg-led-danger/5`, and the server's own message, which is `api()` + `describeApiError` end to end and cross-origin (:3001 → :7700).
- **The plugin half, end to end on :7702.** The import-map shim exposes **143** names, `api`/`useAction`/`coreBase`/`z`/`EmptyState`/`ErrorState`/`LoadingRows`/`ConfirmDialog`/`relativeTime`/`formatFieldValue` among them; `coreBase()` **called through the shim** returns `http://localhost:7702`; a `PUT` through the shared `api()` writes a record and the Catalogue tab reads it back through its Zod schema, showing "1m ago" from the shared `relativeTime` where the pack used to print an absolute `toLocaleString()`. All three tabs render, a full page load of `&tab=assignments` still lands on Assignments, the plugin's own `repeating-linear-gradient` still resolves, and the console is **empty**. The throwaway core and its data dir were deleted afterwards.
- **The plugin bundle got smaller in the way that matters.** `buildUiAssets` emits `ui/index.js` at 16.6 KB importing exactly `react`, `react/jsx-runtime` and `@enkaku/ui` — **no Zod**, because `z` comes from the host. A pack that had reached for its own `zod` to use `api()` would have carried roughly 50 KB more.

**111.8 — Docs.** `docs/spec.md` §11.6/§19, `docs/design.md`'s "Plugin views" section (which currently states the one-resolver rule as if it were the only path), `packages/sdk/README.md`, and plan 108's §3.2 amended to record that its tier B was removed and why.

---

## 6. Acceptance criteria

1. A plugin ships a React module; its component renders inside Studio's own tree, with working hooks.
2. That component imports and renders a Studio `Tabs` — the owner's own example — and it looks native.
3. A plugin may instead render plain HTML with its own CSS and use nothing from Studio.
4. A plugin's `fetch` reaches the farm with the operator's session, and `api()` from `@enkaku/ui` validates responses.
5. A plugin built against a different `apiVersion` is refused **at verify**, naming both versions — never at render.
6. A module that throws, or never registers its view, renders a named error rather than a blank page.
7. Two views from one plugin load the module once.
8. A dev-slot rebuild serves the new component, never a cached old one.
9. `enkaku dev` iterates a React UI end to end — edit, save, reload, see the change.
10. Tier A still works, unchanged; TikTok Accounts is untouched by this plan.
11. `FrameView`, `frame-rpc`, and `ViewSpecSchema.frame` are gone, with no compatibility alias.
12. Proxy Manager runs on tier C with tabs, and its honesty copy about unbuilt behaviour survives the rewrite.
13. Typecheck clean; tests scoped per `CLAUDE.md`'s no-full-suite rule.

## 7. Test plan

Scoped runs only (`CLAUDE.md`). Unit: the registry's keying and load-once; import-map insertion happens once and before any plugin script; `apiVersion` refusal at verify. Component: `ReactView`'s three states; a fixture plugin using hooks and a Studio component. Manual: `enkaku dev` on the rebuilt Proxy Manager, edit a tab label, reload, see it.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| H1/H2/H3 fail and the mechanism does not work at all. | 111.0 probes all three before any other line is written. |
| Studio's internal components change and break shipped plugins. | §3.5's checked `apiVersion`. It converts a silent break into a refused activation. |
| A plugin's UI crashes and takes the page with it. | An error boundary around the mounted component; the rest of Studio keeps rendering. Note this is containment of a *mistake*, not of malice — §2. |
| Removing tier B loses work done the same day. | Accepted (§3.6). Three tiers with two overlapping is the worse outcome. |
| Plugins start reaching into Studio internals beyond `@enkaku/ui`. | Nothing prevents it — same-origin, no sandbox. The package is the *documented* surface; anything else is the author's own risk and is stated as such. |

## 9. Open questions

**Q1 — How does a plugin write NEW Tailwind classes? DECIDED: the plugin compiles its own stylesheet, against a theme `@enkaku/ui` ships.**

The first half was always settled and shipped with 111.1: Studio's stylesheet `@source`s `packages/ui`, or the extracted components render unstyled. The open half was a plugin's *own* classes — its markup renders in Studio's document, so it inherits every class Studio compiled, but a class Studio never uses was never generated.

The tempting answer is to add `@source '../../../../plugins'` to Studio's CSS. **It is disqualified, and by the exact thing this plan is for.** It only reaches packs living in this repo; a third-party `.enkaku` an operator uploads is never scanned, so its classes are never generated. Taking it would let 111.7 — an in-repo pack — pass while no real plugin can, which is worse than not building it, because the passing pack reads as proof.

So: `enkaku publish` runs Tailwind over the plugin's `src/ui/`, emits `ui/<name>.css` into the `.enkaku`, and the host injects a `<link>` beside the script tag. `@enkaku/ui` exports a `theme.css` the plugin's stylesheet imports, so both sides resolve `--color-surface` and friends from **one** definition rather than a fork that drifts.

Two things this must get right, both of which fail visibly if missed:

- **The plugin's stylesheet must not carry preflight.** Tailwind's reset is global; injecting a second copy into Studio's document restyles *Studio*, not just the plugin. The plugin compiles utilities only — Studio already supplies preflight.
- **An injected stylesheet is global, and stays after the view unmounts.** Utilities are safe by construction (the same class compiles to the same rule from the same theme, so two plugins agreeing on `bg-surface` is a no-op). Hand-written custom CSS is not, and the tier's answer to that is the tier's answer to everything else: no sandbox, the author's own risk, stated rather than prevented (§2, and the last row of §8).

This is unbuilt — `build-ui.ts` handles no CSS today — so it is step 111.9 below, and 111.7 depends on it.

**Q2 — Should a plugin be able to register a route, not just a view? DECIDED: a passthrough param.**
A tabbed screen wants its own URL per tab so a reload lands where you were, and today a view is one query param. The alternative — the plugin owning a path segment — needs a router change and a new top-level route, and the static export makes real segments expensive. The host passes the unclaimed part of the query through to the mounted component and takes no position on what it means; a plugin that wants tab state in the URL reads and writes it itself.
