# `@enkaku/ui`

Studio's component library, extracted here (plan 111 §111.1) so that **plugin
React screens and Studio render the same components** — not lookalikes. A plugin
imports `@enkaku/ui` and gets the host's live instances through the import map,
so a `Tabs` inside a plugin is byte-identical to a `Tabs` in Studio.

Consumed by Studio through `transpilePackages`, which is why this is a ROOT-
TypeScript package (CLAUDE.md's "two TypeScripts" rule) rather than one carrying
its own TypeScript 5.

## What is in here besides components

The 28 shadcn components are the bulk of it, but not all of it. Plan 111 §3.3
promised a behaviour layer too — "the pieces that make a plugin screen behave
like a Studio screen rather than merely look like one" — and 111.1 did not ship
it, so the first tier-C pack hand-wrote a `fetch` helper and its own three state
panels. Those pieces are here now, and they are **Studio's own modules moved**,
not copies:

| | |
|---|---|
| `EmptyState`, `ErrorState`, `LoadingRows` | `src/components/states.tsx` — 49 Studio files import them |
| `ConfirmDialog` | `src/components/confirm-dialog.tsx` — 19 Studio files |
| `api`, `useAction`, `describeApiError`, `issuesFromError`, `BadResponseError` | `src/lib/actions.ts` — 79 Studio files |
| `coreBase`, `setCoreBase` | `src/lib/core-base.ts` — re-exported by `@/lib/ws`, so Studio's 23 call sites are unchanged |
| `relativeTime`, `duration`, `fileSize`, `formatFieldValue`, `formatTokens`, `formatUsd` | `src/lib/format.ts` — 51 Studio files |
| `z` | Zod itself, one name, so `api()`'s required schema costs a plugin no bundle |
| `PluginViewProps` and friends | re-exported from `@enkaku/protocol`; the type of a plugin view's props |

**`coreBase()` is the interesting one.** Studio could answer "where is the core"
privately (`NEXT_PUBLIC_ENKAKU_CORE_URL`, else `location.origin`); a plugin
cannot, because it is a separate bundle with no access to Studio's build
configuration — which is why the first tier-C pack derived its own origin from
`new URL(import.meta.url).origin`.

The resolution is that **only Studio's answer ever runs**. `@enkaku/ui` is in
`UI_EXTERNALS`, so a plugin calling `coreBase()` (or `api()`, which calls it)
executes Studio's live copy through the import map, and Studio's answer is
correct for the plugin in both deployments — served by the core, it *is* the
origin; under `bun run dev:studio` the env variable points at :7700, which is
where the plugin's own module came from. `api()` sends
`credentials: 'include'` so that cross-origin case still carries the session.
`src/lib/core-base.ts` records why `import.meta.url` is deliberately not a rung
inside it (it would never run, and Next compiles it to a literal `file://` path
of the maintainer's machine).

Two things Studio has that are deliberately **not** here, recorded so nobody
adds them by reflex:

- **`PageHeader`** stays in `packages/studio/src/components/layout/`. Studio's
  plugin view page already renders one above every plugin's view, from the
  manifest's own `title`/`description`, and it is `sticky top-0` chrome
  positioned against Studio's shell. A plugin rendering a second one is a
  visual bug, and plan 111 §2 lists Studio's chrome as a non-goal for plugins.
- **`PaginatedTable`** stays in Studio. Its `Page<T>` is the core's keyset
  envelope from plan 30 (`items`/`nextCursor`/`total`), which Studio's list
  routes return and a plugin's own routes are under no obligation to. Sharing
  it would publish an internal pagination contract as a plugin API.

## Where the styling lives

**The design tokens live here**, in `src/theme.css`, exported as
`@enkaku/ui/theme.css` (plan 111 step 111.9). Two compilers read that one file:

- **Studio** does `@import '@enkaku/ui/theme.css'` in
  `packages/studio/src/app/globals.css` and **emits** the variables onto the
  document.
- **A plugin's own stylesheet** imports it with `theme(reference)` and emits
  nothing — `bg-surface` compiles to `var(--color-surface, <build-time value>)`,
  so Studio's live token wins and the plugin can never repaint the farm with a
  palette frozen on the day it was built.

That indirection is the whole point: a plugin installed from a `.enkaku` archive
is never scanned by Studio's build, so it has to compile its own utilities — and
a second copy of the tokens would drift the first time the palette moved.
`@custom-variant hover-none` lives in `theme.css` too; it names a device
capability, not a component, and an unknown variant compiles to nothing with no
error at all.

What is NOT here: Studio's `@layer base` reset and its `@layer components`
classes (`.status-rail`, `.rack-label`, `.readout`). Those style Studio's page
rather than name a value a plugin could use, and a plugin importing `theme.css`
must not be able to pick them up.

Studio's `globals.css` also carries

```css
@source '../../../ui/src';
```

which is **load-bearing, not decoration**. Tailwind v4 generates utilities by
scanning source; without that line the classes used only by these components are
never emitted and every component renders unstyled — with no build error and no
warning. A negative control proved it: 151 classes exist only in this package,
and 9 of them survive a Studio build with the `@source` line removed. A plugin
needs no equivalent: Studio has already generated every class these components
use, so a plugin drawn only from `@enkaku/ui` ships no stylesheet at all.

## Adding a component from shadcn

`components.json` lives here rather than in Studio, because this is the library
it manages. Run the CLI from this directory:

```bash
bunx shadcn@latest add <component>
```

Then **two manual steps, both required**:

1. **Rewrite the `@/` imports to relative ones.** shadcn writes
   `import { cn } from "@/lib/utils"`; this package uses `../lib/utils`. Every
   existing component does, and there is deliberately no `paths` entry in
   `tsconfig.json` to make `@/` work.

   That absence is a choice. Studio resolves `@/*` to *its own* `src/`, and
   because Studio compiles this package's source through `transpilePackages`,
   Next resolves aliases with the **application's** tsconfig, not this one. A
   `@/lib/utils` left in here would therefore point at
   `packages/studio/src/lib/utils`, which does not exist. Leaving the path
   unmapped makes that break immediately in `bun run typecheck`, in the package
   you just edited, instead of later in a Studio build far from the cause.

2. **Export it from `src/index.ts`.** The barrel is the only entry point
   (`exports` declares just `"."`), so a component missing from it is invisible
   to both Studio and every plugin.

## Tests

Needs a DOM, so it mirrors Studio exactly: its own `bunfig.toml` preloading
happy-dom, and `packages/ui/**` in the root `bunfig.toml`'s
`pathIgnorePatterns` — a bare `bun test` at the repo root does not run these.

```bash
bun run --cwd packages/ui test
```
