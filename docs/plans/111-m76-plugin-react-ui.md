# Plan 111 — M76 : A plugin's UI is React, with no ceiling

> Status: draft — written 2026-08-17 after the owner rejected the sandboxed-iframe ceiling. Nothing implemented.
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

Beyond the 28 components, the package also carries the pieces that make a plugin screen behave like a Studio screen rather than merely look like one: `PageHeader`, `EmptyState`/`ErrorState`/`LoadingRows`, `ConfirmDialog`, `useAction`, `api()`, and `formatFieldValue`. An author who wants none of it writes plain HTML and their own CSS — that is the point of the tier.

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
packages/studio/src/lib/plugin-shims/      NEW — the same-origin shim modules the import map points at
packages/studio/src/components/plugin-view/ReactView.tsx   NEW — mounts a registered component
packages/studio/src/components/plugin-view/FrameView.tsx   DELETE
packages/studio/src/components/plugin-view/frame-rpc.ts    DELETE
packages/protocol/src/plugin-surface.ts    + `react`, − `frame`
packages/core/src/plugins/verify-child*.ts + apiVersion check, − frame validation
packages/sdk/src/cli/{init,dev,publish}.ts scaffold a React project; `dev` pushes a PACKAGE, not a bundle
packages/core/src/api/plugins.ts           dev-slot assets; the `/ui/*` CSP revisited (no longer an iframe)
plugins/proxy-manager/                     rebuilt on tier C — see §4.3
```

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

**111.7 — Rebuild Proxy Manager on tier C** with tabs, proving the goal against a real pack.

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

**Q1 — How does a plugin write NEW Tailwind classes? ANSWERED in part by §3.3.**
Studio's stylesheet must already `@source` `packages/ui`, or the extracted components render unstyled — that half is settled and is part of 111.1. The open half is a plugin's *own* classes: its markup renders in Studio's document, so it inherits every class Studio compiled, but a class Studio never uses was never generated. Options: ship a Tailwind preset in `@enkaku/ui` so a plugin compiles its own stylesheet against the same tokens, or expose the tokens as CSS custom properties and let plugins write plain CSS. **Recommendation: the preset** — "write ordinary React" implies writing ordinary Tailwind in this codebase's idiom. Decide before 111.7, which is the first pack that will hit it.

**Q2 — Should a plugin be able to register a route, not just a view?**
A tabbed screen wants its own URL per tab so a reload lands where you were. Today a view is one query param. Deep-linking within a plugin view means either the plugin owning a path segment or a passthrough param it interprets itself. **Recommendation: a passthrough param** — it needs no router change and no new top-level route, and the static export makes real segments expensive.
