# Plan 204 — MVP wave 0 : Design tokens, fonts, icons, and re-skinned primitives

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: nothing (wave 0, `docs/plans/200-mvp-program.md` §4). Plan 201 (housekeeping) owns MVP 13 Part B's two dead tokens; this plan rewrites the file they live in, so whichever plan lands second finds the rows already gone (§3.9).
> Spec references: `docs/spec.md` has no tokens section (the spec is rewritten by plan 202). The design of record is `docs/mvp/design_handoff_enkaku_openpf/README.md`, sections "Design Tokens", "Typography", "Spacing", "Radii", "Shadows", "Assets" (quoted verbatim in §4.1), as corrected by `docs/mvp/15-ui-migration.md` §0 (the Tokens bullet), §1 (the Icons and Fonts rows), §3 step 1. External facts: plan 200 §5 rows R6 (Phosphor) and R7 (Geist).
> Ships: packages/ui/src/tokens.test.ts

---

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The handoff palette exists in `packages/ui/src/palette.css` under three selectors with the handoff's exact hex values | 36 colour tokens (§4.2); light values under `:root`, dark values under both `:root:not([data-theme="light"])` inside `@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]` | `bun run --cwd packages/ui test src/tokens.test.ts` → every `describe('palette.css')` test passes | [ ] |
| G2 | Every handoff token is a Tailwind v4 utility name | `packages/ui/src/theme.css` has `--color-<name>: var(--<name>)` for all 36 names inside `@theme inline`, plus the 10 radii, 8 shadows, 10 text sizes, 2 animations and 2 font names of §4.3 | same command as G1 → every `describe('theme.css')` test passes; `rg -n ":root|@layer" packages/ui/src/theme.css` → empty (a `theme(reference)` import refuses anything but `@theme` blocks, §3.4) | [ ] |
| G3 | Geist and Geist Mono are self-hosted in the static export | `@fontsource-variable/geist@5.3.0` and `@fontsource-variable/geist-mono@5.3.0` in `packages/studio/package.json`; woff2 files in `out/` | `bun run build:studio`, then §7.1 GREP-FONT-FILES → lists at least `geist-latin-wght-normal.<hash>.woff2` and `geist-mono-latin-wght-normal.<hash>.woff2`, GREP-FONT-LEFTOVERS → empty, GREP-FONTS → empty | [ ] |
| G4 | The handoff's icon set is exported from `@enkaku/ui` as Phosphor components | 53 `ph-*` names in the handoff README, each exported as `<PascalCase>Icon` from `packages/ui/src/icons.ts`; `@phosphor-icons/react@2.1.10` in `packages/ui/package.json` and `packages/studio/package.json` | `bun run --cwd packages/ui test src/icons.test.ts` → passes (the test derives the 53 names from the handoff README itself) | [ ] |
| G5 | The 41 plugin icon ids render Phosphor components, ids unchanged | `ICON_NAMES` unchanged (41 entries); `PLUGIN_ICONS: Record<IconName, Icon>` | `bun run --cwd packages/studio test src/lib/plugin-icons.test.ts` → passes; `bun test packages/protocol/src/plugin-surface.test.ts` → passes; `rg -n "lucide" packages/protocol/src packages/studio/src/lib/plugin-icons.ts --glob '!**/*.test.ts'` → empty | [ ] |
| G6 | `@enkaku/ui` no longer depends on lucide or next-themes | 0 imports, 0 dependency entries | §7.1 GREP-LUCIDE-UI → empty | [ ] |
| G7 | The primitives the brief names are re-skinned to the handoff measurements | the class strings of §4.6, asserted by name | `bun run --cwd packages/ui test src/components/skin.test.tsx` → passes | [ ] |
| G8 | No re-skinned primitive uses a `dark:` variant or a shadcn token name | 0 matches | §7.1 GREP-DARK → empty; §7.1 GREP-SHADCN → empty | [ ] |
| G9 | The three primitives the handoff needs and `@enkaku/ui` lacked exist | `checkbox.tsx`, `status-dot.tsx`, `avatar.tsx` exported from the barrel | `bun run --cwd packages/ui test src/index.test.ts` → passes (the REQUIRED list gains `Checkbox`, `StatusDot`, `Avatar`, `resolveTheme`, `useResolvedTheme`, `DevicesIcon`) | [ ] |
| G10 | The one primitive with zero importers is deleted | `scroll-area.tsx` | `test ! -e packages/ui/src/components/scroll-area.tsx` → exit 0; §7.1 GREP-SCROLL → empty | [ ] |
| G11 | Theme resolution follows the handoff: an explicit `data-theme` wins, otherwise the system preference | `resolveTheme()` in `packages/ui/src/lib/theme.ts` | `bun run --cwd packages/ui test src/lib/theme.test.ts` → passes | [ ] |
| G12 | `docs/design.md`'s token, typography, spacing, radii and shadow sections are the handoff's | the text of §4.9 replaces lines 1–89 | §7.1 GREP-DESIGN-HEAD → empty | [ ] |
| G13 | The workspace typechecks | 0 errors | `bun run typecheck` → every package `OK` | [ ] |
| G14 | The prototype token block (§4.3 block D) is deleted | 0 `oklch(` values left in `theme.css` | `rg -n "oklch\(" packages/ui/src/theme.css` → empty | owner (§9 Q1) |

## 1. Goals

1. `@enkaku/ui` publishes the handoff's palette once, in both themes, and Tailwind v4 utilities exist for every token (`bg-panel`, `text-faint`, `border-line-2`, `rounded-card`, `shadow-popover`, `font-mono`, `animate-enkaku-pulse`), so that plans 213–220 build screens against names rather than values.
2. Studio ships Geist and Geist Mono from its own static export. Nothing is fetched from Google Fonts at runtime (MVP 15 §1, Fonts row; plan 200 R7).
3. Studio and `@enkaku/ui` draw icons from `@phosphor-icons/react` 2.1.10 (plan 200 R6). The plugin icon allowlist keeps its 41 ids and renders Phosphor components (MVP 15 §1, Icons row).
4. The primitives the handoff uses (button, icon button, input, checkbox, switch, tabs and chips, pill tabs, popover, sheet, tooltip, table header, status dot, task chip, avatar chip) are re-skinned to the handoff's measurements with their prop vocabulary unchanged, so the 247 files that import `@enkaku/ui` today keep typechecking.
5. `docs/design.md` describes the handoff's tokens, type scale, spacing, radii, shadows, icons and theme rule, and says which sections are still the prototype's.
6. A test proves the palette against the handoff's own table, so a drifted hex fails CI rather than a review.

## 2. Non-goals

| Not done here | Done by |
|---|---|
| Any Studio page, the shell, `AppShell.tsx`, the theme toggle and its `enkaku-theme` persistence, `color-scheme`, the body background | plan 213 (shell and status bar) |
| Deleting the prototype `--color-*` vocabulary (`--color-surface`, `--color-fg-muted`, `--color-led-*`, the retained shadcn names) that 168 Studio files and 14 plugin files still use | the last wave-3 plan to delete an importer, gated on §9 Q1; the plugin half on §9 Q2 |
| Removing `lucide-react` from `packages/studio/package.json` (106 Studio files still import it after this plan) | plans 213–219 delete the pages; plan 220 (`components/agent`, `components/ai-elements`) removes the last importer and the dependency |
| Migrating `plugins/proxy-manager` and `plugins/mikrotik-routing` views to the handoff tokens and bumping them (CLAUDE.md's seeding rule) | §9 Q2, a plan to be numbered |
| Deleting primitives the handoff never draws but the old Studio still imports (`Card`, `Collapsible`, `HoverCard`, `ButtonGroup`, `Command`, `InputGroup`, `Slider`, `Select`, `Progress`, `Separator`, `Textarea`) | the plan that deletes the last importer, listed in §10.2 |
| The device picker (`packages/ui/src/components/device-picker.tsx`) beyond swapping its two icons | plan 216 (action dialogs and the DevicePicker) |
| Tailwind plugins, a `dark:` custom variant, a second icon weight | never (the tokens carry the theme; Phosphor regular is the only weight the handoff uses) |
| Spec text | plan 202 |

## 3. Context and design decisions

### 3.1 What exists today

- `packages/ui/src/theme.css:43-110` is one `@theme` block of OKLCH values (`--color-bg`, `--color-surface`, `--color-surface-2`, `--color-surface-3`, `--color-line`, `--color-line-strong`, `--color-fg`, `--color-fg-muted`, `--color-fg-subtle`, `--color-accent`, `--color-accent-strong`, `--color-accent-fg`, `--color-led-ok`, `--color-led-active`, `--color-led-warn`, `--color-led-danger`, `--color-led-off`, `--font-sans`, `--font-mono`, `--radius-card`), and `theme.css:118-149` a second block bridging shadcn names (`--color-background` … `--color-ring`, `--radius`, `--radius-sm/md/lg/xl`). Line 106 reads `--font-sans: var(--font-outfit), ui-sans-serif, system-ui, sans-serif;` and line 107 `--font-mono: var(--font-plex-mono), ui-monospace, SFMono-Regular, monospace;`. Dark only: `packages/studio/src/app/globals.css:55-57` sets `html { color-scheme: dark; }`.
- Fonts load through `next/font/google`: `packages/studio/src/app/fonts.ts:1` `import { IBM_Plex_Mono, Outfit } from 'next/font/google'`, applied at `packages/studio/src/app/layout.tsx:14` `<html lang="en" className={`${outfit.variable} ${plexMono.variable}`}>`. The built export today carries 10 hashed woff2 files under `packages/studio/out/_next/static/media/`.
- Icons are lucide: 117 files import `lucide-react` (10 in `packages/ui/src/components`, 106 across `packages/studio/src`, plus `packages/studio/src/lib/plugin-icons.ts`). `packages/ui/package.json:19` and `packages/studio/package.json:22` both declare `"lucide-react": "^1.28.0"`. No plugin imports it (`plugins/proxy-manager/src/ui/parts/failover-chip.tsx:16` records why: it is not in `UI_EXTERNALS`, `packages/sdk/src/cli/build-ui.ts:110`).
- The plugin icon allowlist: `packages/protocol/src/plugin-surface.ts:95-138` `export const ICON_NAMES = [ 'users', … 'alert-triangle' ] as const` (41 ids), `:140-142` `IconNameSchema` with the error text `not one of the ${ICON_NAMES.length} allowed lucide names`. `packages/studio/src/lib/plugin-icons.ts:60-102` is `PLUGIN_ICONS: Record<IconName, LucideIcon>`; its only consumer is `packages/studio/src/components/layout/AppShell.tsx:694` `const Icon = pluginIcon(item.icon)` rendered at `:709` `<Icon className="size-4 shrink-0" aria-hidden />`.
- `@enkaku/ui` components use shadcn token names (`bg-primary`, `border-input`, `text-muted-foreground`, `bg-background` …) and `dark:` variants in 9 files (`tabs.tsx`, `input-group.tsx`, `switch.tsx`, `badge.tsx`, `button.tsx`, `dropdown-menu.tsx`, `select.tsx`, `textarea.tsx`, `input.tsx`). `packages/ui/src/components/sonner.tsx:10` imports `useTheme` from `next-themes`, the package's only use of it. `packages/ui/components.json:14` says `"iconLibrary": "lucide"`.
- Old-token blast radius, measured 2026-09-03 (files, not occurrences): `text-fg`/`bg-fg` 168 Studio files and 14 plugin files; `text-fg-muted` 143 + 14; `bg-surface` 116 + 1; `led-danger` 90 + 7; `led-warn` 69 + 10; `surface-2` 68 + 1; `accent` 50 + 1 (and 9 `@enkaku/ui` files); `line` 48 + 1; `led-ok` 33 + 5. The shadcn names outside `packages/ui`: 12 Studio files (`components/bulk/OutcomeSummary.tsx`, `components/schema-form/plan.ts`, `components/BulkPrepDialog.tsx`, `components/agent/Chat.tsx`, `components/ai-elements/{reasoning,prompt-input,conversation,message}.tsx`, `components/guest-agent/AgentPanel.tsx`, and three tests) and 9 plugin files (7 in `plugins/proxy-manager/src/ui/parts/`, 2 in `plugins/mikrotik-routing/src/ui/parts/`).
- Every `@enkaku/ui` export has at least one importer outside the package except `ScrollArea`/`ScrollBar` (`packages/ui/src/components/scroll-area.tsx`, barrel line `packages/ui/src/index.ts:41`). Counted with a multi-line-aware scan of `import { … } from '@enkaku/ui'` over `packages/studio/src`, `plugins`, `examples`, `packages/sdk/src`: `Button` 138 files, `Select` 36, `Switch` 28, `Badge` 27, `Tabs` 10, `Sheet` 3, `Slider` 1, `Card` 1 (`plugins/mikrotik-routing/src/ui/parts/settings.tsx`), `HoverCard` 1 and `ButtonGroup` 1 (both `components/ai-elements`), `Command` 2 (`components/agent/ModelCombobox.tsx`, `components/ai-elements/prompt-input.tsx`), `InputGroup` 2.
- Prop usage that constrains the re-skin (Studio plus plugins): `Button` `variant="outline"` 233 files, `ghost` 145, `secondary` 36, `destructive` 9, `link` 0; `size="sm"` 347, `icon-sm` 14, `icon` 8, `xs`/`icon-xs`/`lg`/`icon-lg` 0. `<Switch size="sm">` in exactly 4 files (`components/device-popup/DevicePopup.tsx:1425`, `components/workflow/ParamsEditor.tsx:119`, `components/InspectorPanel.tsx:817`, `components/device/ClipboardButton.tsx:123`). `<TabsList variant="line">` in 2 plugin files (`plugins/proxy-manager/src/ui/index.tsx:130`, `plugins/mikrotik-routing/src/ui/index.tsx:53`).
- Two compilers read `theme.css`: Studio (`globals.css:36` `@import '@enkaku/ui/theme.css';`) and every plugin stylesheet (`plugins/proxy-manager/src/ui/index.css:46` `@import '@enkaku/ui/theme.css' theme(reference);`, the `enkaku init` scaffold at `packages/sdk/src/cli/init.ts:427`, and `packages/sdk/src/cli/build-ui.test.ts:57-60` `SCAFFOLD_CSS`). `build-ui.test.ts:154` asserts `expect(theme).toContain('--color-surface:')` and `:64` renders `bg-surface text-fg-muted rounded-card`.
- Tests: the root `bunfig.toml` excludes `packages/ui/**` and `packages/studio/**` from a root `bun test`, so this package's tests run as `bun run --cwd packages/ui test <path>` (the `test` script is `bun test --isolate`, and `packages/ui/bunfig.toml` preloads `happydom.ts`). `packages/ui/src/index.test.ts:20-57` keeps a REQUIRED export list. `packages/studio/src/design-rules.test.ts:47-48` scans `packages/ui/src` too and refuses a hex literal in any `.ts`/`.tsx` (`.css` is never scanned, `:84-93`).

### 3.2 The handoff decides the values; MVP 15 decides the mechanism

MVP 15 §0 fixes "the full light and dark palette on `:root` and `:root[data-theme="dark"]`, Geist and Geist Mono, Phosphor regular icons, radii 16/18/14/12/10/9/8/7/5/999, six named shadows, two animations only". MVP 15 §1 resolves Icons ("Phosphor. The plugin allowlist is remapped to Phosphor names in `@enkaku/protocol`, keeping the same ids so bundled plugins do not change") and Fonts ("Geist, self-hosted in the static export"). MVP 15 §3 step 1 is this plan: "`packages/ui/src/theme.css` is replaced by the handoff's token table (light and dark, Tailwind v4 `@theme` mapping). Geist self-hosted, Phosphor icons, the shadows and radii scale. `@enkaku/ui` primitives are re-skinned to the handoff (buttons, inputs, checkbox, switch, tabs, chips, popover, sheet, tooltip); anything the handoff does not use is deleted."

One correction to MVP 15 §1's wording: the allowlist is remapped in Studio's `plugin-icons.ts`, not in `@enkaku/protocol`, because the protocol package holds only the ids (`ICON_NAMES`) and never a component; the ids do not change, which is what the sentence is protecting.

### 3.3 Two themes: explicit attribute wins, the system preference is the default

The handoff toggles `data-theme` on `<html>` and persists it under `localStorage` `enkaku-theme` (README, Interactions table, last row). It says nothing about a page with no stored choice. This plan fixes the rule the brief asked for: an explicit `data-theme="light"` or `data-theme="dark"` wins; with no attribute the page follows `prefers-color-scheme`. In CSS that is three selectors (§4.2): `:root` carries light, `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` carries dark for the system default, and `:root[data-theme="dark"]` carries dark for the explicit choice. In code it is `resolveTheme()` (§4.5), which the Toaster uses and plan 213's toggle will reuse. Setting the attribute is plan 213's job; this plan never writes `data-theme`.

### 3.4 Why the palette and the utility mapping are two files (measured)

Tailwind 4.3.3 refuses a plain rule in a file imported with `theme(reference)`. Compiled on 2026-09-03 with `compile()` from `node_modules/tailwindcss/dist/lib.js` against a file holding both a `:root { --panel: … }` block and a `@theme` block, imported the way every plugin imports `@enkaku/ui/theme.css`:

```
error: Files imported with `@import "…" theme(reference)` must only contain `@theme` blocks.
Use `@reference "…";` instead.
```

So the raw values cannot live in `theme.css` without breaking every plugin build, the `enkaku init` scaffold and `build-ui.test.ts`. They live in `packages/ui/src/palette.css` (plain `:root` rules, imported by Studio's `globals.css` only, exported as `@enkaku/ui/palette.css`), and `theme.css` stays `@theme`-only. The same measurement confirmed the mechanism `theme.css` uses: `@theme inline { --color-panel: var(--panel); }` compiles `bg-panel` to `background-color: var(--panel)` under both a full import and a `theme(reference)` import, `bg-panel/50` to a `color-mix()` of `var(--panel)`, a `@keyframes` inside a `@theme` block travels through `theme(reference)`, and `--shadow-bulk-pill: 0 10px 24px var(--accent-a3)` compiles to a `--tw-shadow` referencing `var(--accent-a3)`. A plugin therefore emits no `:root` block and no value at all: its utilities resolve against whatever Studio's document declares, which is exactly the "one definition, two compilers" property `theme.css:1-18` was written to keep.

### 3.5 The prototype vocabulary stays until its screens go (§9 Q1)

The brief asked for every pre-handoff token to be deleted here. Doing that in wave 0 unstyles the old Studio (168 files) and the two plugin views (14 files) on the `mvp` branch until wave 3 replaces them, and MVP 16 §5 item 5 needs that Studio working after wave 2 ("Ship an internal alpha to the owner's farm after wave 2. Core and automation are testable through the old Studio plus the new activity list"). Deleting the tokens also empties every bundled plugin UI the moment `build:packs` runs, and CLAUDE.md's seeding rule means a rebuilt pack at an unchanged version never reaches a farm that already has it, so the fix is not "rebuild the pack" either. That contradiction is a human decision, so it is §9 Q1, and this plan is written so everything else executes either way:

- The handoff tokens are authoritative. Where an old name collides with a handoff name (`--color-accent`, `--color-line`, `--color-muted`, `--color-border`, `--radius-card`), the old definition is deleted now and the handoff value wins. On the old Studio this turns the accent green and the hairlines light; it stays legible, and it is the prototype, not the product.
- The old names that do not collide move verbatim into one fenced block at the end of `theme.css` (§4.3 block D), headed by the plan numbers that delete their importers. It is not a compatibility path for anyone outside this repository: nothing published reads it, and `docs/mvp/README.md` "Approach" guard 4 is satisfied by naming the removal owner in §10.2.
- Shadcn bridge names with zero users outside `packages/ui` after the re-skin are deleted now (§10.1); the eight that the old Studio or a plugin still uses (`--color-foreground`, `--color-card`, `--color-popover`, `--color-primary`, `--color-muted-foreground`, `--color-destructive`, `--color-input`, `--color-ring`, plus `--radius-sm/md/lg/xl`) go into block D.

If Q1 is answered "delete now", step 204.14 deletes block D and G14 closes; otherwise G14 stays `owner` and the plan's status is `implemented (software)`.

### 3.6 The re-skin keeps every prop name

247 files import `@enkaku/ui`, and `bun run typecheck` must stay clean (plan 200 §2.3). So a re-skin changes class strings and default values, never a variant or size name that has a caller: `Button` keeps `default | destructive | outline | secondary | ghost | link` and `default | sm | icon | icon-sm | icon-lg` (the four unused sizes `xs`, `icon-xs`, `lg` are deleted; `icon-lg` is redefined as the 34×34 shortcut-rail button); `TabsList` keeps `default | line` and gains `compact | pill`; `Badge` keeps its six variants and gains `warn`. The one removed prop, `Switch`'s `size`, has four call sites, all edited in step 204.9 (the handoff draws one switch). New shapes the handoff needs and the library lacks are new files: `Checkbox`, `StatusDot`, `Avatar`.

### 3.7 Icons: Phosphor's `*Icon` names, and a namespace a plugin can reach

`@phosphor-icons/react@2.1.10` (verified from the published tarball on 2026-09-03) exports every icon twice: the plain name is marked `@deprecated Use DevicesIcon`, the `<Name>Icon` form is current, and the component type is `Icon` (`dist/lib/types.d.ts:10`, a `ForwardRefExoticComponent<IconProps>` taking `size`, `weight`, `color`, `mirrored` plus `svg` props). This plan uses the `*Icon` form everywhere, which also keeps `packages/ui/src/index.ts`'s flat barrel collision-free (`TableIcon` beside `Table`, `ListIcon` beside `List`). Two of the 41 allowlist ids have no Phosphor namesake and are mapped by meaning: `activity` → `PulseIcon`, `boxes` → `StackIcon` (Phosphor has no `Activity` and no `Cubes`; both absences verified against the tarball's `dist/csr/` directory). Plugins reach icons through `@enkaku/ui` (external at runtime, `UI_EXTERNALS`), never by depending on Phosphor themselves, which would bundle a second 3 MB copy into every pack.

### 3.8 Fonts: fontsource, normal weight only

`@fontsource-variable/geist@5.3.0` declares `font-family: 'Geist Variable'` at `font-weight: 100 900` (five subset files in `wght.css`, ten in `index.css` because the latter adds italics); `@fontsource-variable/geist-mono@5.3.0` declares `'Geist Mono Variable'` (six subset files in `wght.css`). Both verified from the published tarballs on 2026-09-03; the package `exports` map serves `./*.css`. The handoff uses Geist 400/500/600/700 and Geist Mono 400/500, no italic, so Studio imports `wght.css` from each, not `index.css`. Next.js copies a CSS `url()` asset into `_next/static/media/<basename>.<hash>.woff2`, which is what G3 greps for.

### 3.9 Coordination with plan 201

MVP 13 Part B lists `--color-destructive-foreground` (`theme.css:138`) and `--radius-card` (`theme.css:109`) as dead, and Part C item 2 assigns them to the housekeeping plan. `--radius-card` is not dead: `packages/sdk/src/cli/init.ts:426`, `packages/sdk/src/cli/build-ui.test.ts:64` and `plugins/proxy-manager/src/ui/index.css:45` name `rounded-card`. This plan rewrites the file, deletes `--color-destructive-foreground`, and redefines `--radius-card` as the handoff's 14 px card radius. If plan 201 has already removed the two lines, the executor finds them gone and reports it under discrepancies; nothing else depends on the order.

## 4. Technical design

### 4.1 The handoff, verbatim

From `docs/mvp/design_handoff_enkaku_openpf/README.md` (the quotes keep the handoff's own punctuation).

Design Tokens (lines 486–511):

> Declared on `:root`, overridden under `:root[data-theme="dark"]`.
>
> | Token | Light | Dark |
> |---|---|---|
> | `--bg` | `#f1f1f2` | `#0c0c0e` |
> | `--panel` | `#ffffff` | `#16161a` |
> | `--panel-2` | `#fbfbfc` | `#1a1a1f` |
> | `--panel-a` | `#ffffffee` | `#16161aee` |
> | `--muted` | `#f6f6f7` | `#202027` |
> | `--muted-2` | `#f4f4f5` | `#1d1d23` |
> | `--hover` | `#fafafa` | `#1e1e25` |
> | `--line` / `--line-2` | `#f0f0f1` / `#eeeef0` | `#26262d` / `#26262d` |
> | `--border` / `--border-2` / `--border-3` | `#e8e8ea` / `#e4e4e7` / `#d4d4d8` | `#2a2a32` / `#32323b` / `#3c3c46` |
> | `--text` / `--text-2` / `--text-3` | `#18181b` / `#3f3f46` / `#52525b` | `#f4f4f5` / `#d4d4d8` / `#b0b0b8` |
> | `--dim` / `--faint` / `--faint-2` | `#71717a` / `#a1a1aa` / `#c4c4c8` | `#8e8e98` / `#71717a` / `#55555f` |
> | `--accent` / `--accent-2` | `#16803c` / `#12652f` | `#4ade80` / `#86efac` |
> | `--accent-soft` / `--on-accent` | `#ecf6ef` / `#ffffff` | `#16281d` / `#08130c` |
> | `--accent-a1` / `-a2` / `-a3` | `#16803c14` / `1f` / `40` | `#4ade8014` / `1f` / `40` |
> | `--ok` | `#16a34a` | `#4ade80` |
> | `--warn` / `--warn-2` / `--warn-soft` | `#b45309` / `#d97706` / `#fef6e7` | `#fbbf24` / `#f59e0b` / `#2a2110` |
> | `--danger` / `--danger-soft` | `#dc2626` / `#fdeceb` | `#f87171` / `#2b1616` |
> | `--avatar-bg` / `--avatar-fg` | `#fde8ea` / `#b4405a` | `#34212a` / `#f0a3b4` |
> | `--tooltip-bg` / `--tooltip-fg` | `#18181b` / `#fafafa` | `#f4f4f5` / `#18181b` |
> | `--scrim` | `#18181b33` | `#00000080` |

Typography, Spacing, Radii, Shadows (lines 513–525):

> **Typography** — `Geist` (400/500/600/700) for UI, `Geist Mono` (400/500) for serials, endpoints, paths, versions, script names, timestamps and numeric readouts. Scale: 19px/600 settings section titles, 16px/600 sheet titles, 15px/600 page and job titles, 14px/600 device name in Device Control, 13px/500-600 row titles and buttons, 12.5px body and controls, 11.5px meta, 11px column labels and hints, 10.5px badges, 10px tooltips and frame captions.
>
> **Spacing** — 10px shell gap and padding; 12–14px panel padding; 6/8/10/12/14px gaps.
> **Radii** — 16px page panels, 18px floating window and cast, 14px cards/sheets/status bar, 12px inner cards, 10px buttons and rows, 9px settings inputs and nav items, 8px small buttons, 7px compact chips, 5px checkboxes, 999px pills.
> **Shadows** — `0 1px 3px #00000014` (active pill), `0 8px 24px #00000014` (cast), `0 10px 24px var(--accent-a3)` (bulk pill), `0 16px 40px #0000001f` (popovers), `0 20px 50px #00000024` (console/menus), `0 30px 80px #00000033` (Device Control).

Assets (lines 527–533):

> - **Fonts**: Geist + Geist Mono from Google Fonts.
> - **Icons**: Phosphor Icons web font, regular weight (`@phosphor-icons/web@2.1.1`), used by class name (e.g. `ph ph-devices`). Every icon in this doc is a Phosphor regular name.
> - **No bitmap assets.** Every phone screen (cards, cast, snapshot, frames, artifact thumbnails) is a placeholder: a flat surface or a 135° striped gradient. Replace these with the real scrcpy/cast surface, real screenshots and real artifact thumbnails.

Animations (line 464): "`enkakuPulse` (2.6s status dot) and `enkakuSpin` (0.9s rescan)". Their keyframes, from the prototype `Enkaku Device List.dc.html`: `@keyframes enkakuPulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }` and `@keyframes enkakuSpin { to { transform: rotate(360deg) } }`.

The two `--accent-a*` abbreviations expand to `#16803c14 / #16803c1f / #16803c40` (light) and `#4ade8014 / #4ade801f / #4ade8040` (dark).

### 4.2 `packages/ui/src/palette.css` (new file, complete)

```css
/*
 * `@enkaku/ui/palette.css`: the handoff's colour values, and the ONLY file
 * in the workspace that states one (docs/mvp/design_handoff_enkaku_openpf/
 * README.md "Design Tokens"; plan 204 §4.2).
 *
 * Plain `:root` rules, on purpose, and imported by Studio's globals.css ONLY.
 * A plugin's stylesheet imports `theme.css` with `theme(reference)`, and
 * Tailwind refuses a plain rule in such a file (plan 204 §3.4), so the values
 * live here and the utility names live there. A plugin never re-declares a
 * value: `bg-panel` compiles to `var(--panel)` and resolves against whatever
 * this file put on Studio's document.
 *
 * Three selectors (plan 204 §3.3): `:root` is light; the media block is dark
 * for a page with no explicit choice; `[data-theme="dark"]` is dark for an
 * explicit choice. `[data-theme="light"]` therefore beats a dark system
 * preference, and nothing here writes the attribute (plan 213's toggle does).
 */
:root {
  --bg: #f1f1f2;
  --panel: #ffffff;
  --panel-2: #fbfbfc;
  --panel-a: #ffffffee;
  --muted: #f6f6f7;
  --muted-2: #f4f4f5;
  --hover: #fafafa;
  --line: #f0f0f1;
  --line-2: #eeeef0;
  --border: #e8e8ea;
  --border-2: #e4e4e7;
  --border-3: #d4d4d8;
  --text: #18181b;
  --text-2: #3f3f46;
  --text-3: #52525b;
  --dim: #71717a;
  --faint: #a1a1aa;
  --faint-2: #c4c4c8;
  --accent: #16803c;
  --accent-2: #12652f;
  --accent-soft: #ecf6ef;
  --on-accent: #ffffff;
  --accent-a1: #16803c14;
  --accent-a2: #16803c1f;
  --accent-a3: #16803c40;
  --ok: #16a34a;
  --warn: #b45309;
  --warn-2: #d97706;
  --warn-soft: #fef6e7;
  --danger: #dc2626;
  --danger-soft: #fdeceb;
  --avatar-bg: #fde8ea;
  --avatar-fg: #b4405a;
  --tooltip-bg: #18181b;
  --tooltip-fg: #fafafa;
  --scrim: #18181b33;

  /* Theme-independent. The families are the ones @fontsource-variable/geist
     and @fontsource-variable/geist-mono declare (plan 204 §3.8). */
  --font-ui: 'Geist Variable', ui-sans-serif, system-ui, sans-serif;
  --font-code: 'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0c0c0e;
    --panel: #16161a;
    --panel-2: #1a1a1f;
    --panel-a: #16161aee;
    --muted: #202027;
    --muted-2: #1d1d23;
    --hover: #1e1e25;
    --line: #26262d;
    --line-2: #26262d;
    --border: #2a2a32;
    --border-2: #32323b;
    --border-3: #3c3c46;
    --text: #f4f4f5;
    --text-2: #d4d4d8;
    --text-3: #b0b0b8;
    --dim: #8e8e98;
    --faint: #71717a;
    --faint-2: #55555f;
    --accent: #4ade80;
    --accent-2: #86efac;
    --accent-soft: #16281d;
    --on-accent: #08130c;
    --accent-a1: #4ade8014;
    --accent-a2: #4ade801f;
    --accent-a3: #4ade8040;
    --ok: #4ade80;
    --warn: #fbbf24;
    --warn-2: #f59e0b;
    --warn-soft: #2a2110;
    --danger: #f87171;
    --danger-soft: #2b1616;
    --avatar-bg: #34212a;
    --avatar-fg: #f0a3b4;
    --tooltip-bg: #f4f4f5;
    --tooltip-fg: #18181b;
    --scrim: #00000080;
  }
}

:root[data-theme="dark"] {
  --bg: #0c0c0e;
  --panel: #16161a;
  --panel-2: #1a1a1f;
  --panel-a: #16161aee;
  --muted: #202027;
  --muted-2: #1d1d23;
  --hover: #1e1e25;
  --line: #26262d;
  --line-2: #26262d;
  --border: #2a2a32;
  --border-2: #32323b;
  --border-3: #3c3c46;
  --text: #f4f4f5;
  --text-2: #d4d4d8;
  --text-3: #b0b0b8;
  --dim: #8e8e98;
  --faint: #71717a;
  --faint-2: #55555f;
  --accent: #4ade80;
  --accent-2: #86efac;
  --accent-soft: #16281d;
  --on-accent: #08130c;
  --accent-a1: #4ade8014;
  --accent-a2: #4ade801f;
  --accent-a3: #4ade8040;
  --ok: #4ade80;
  --warn: #fbbf24;
  --warn-2: #f59e0b;
  --warn-soft: #2a2110;
  --danger: #f87171;
  --danger-soft: #2b1616;
  --avatar-bg: #34212a;
  --avatar-fg: #f0a3b4;
  --tooltip-bg: #f4f4f5;
  --tooltip-fg: #18181b;
  --scrim: #00000080;
}
```

The two dark blocks are byte-identical lists on purpose: the tokens test (§4.8) asserts they agree, so a value edited in one and not the other fails.

### 4.3 `packages/ui/src/theme.css` (rewritten, complete)

Four blocks. A, B and C are the handoff; D is the prototype vocabulary retained under §3.5. Nothing else may appear in this file: no `:root`, no `@layer`, no `@import` (§3.4; `build-ui.test.ts:159-160` already asserts the layer half).

```css
/*
 * `@enkaku/ui/theme.css`: the design-token VOCABULARY, the Tailwind v4
 * utility names, and nothing that states a colour (plan 204 §4.3).
 *
 * Two compilers read this file (plan 111 §9 Q1). Studio's stylesheet imports
 * it after `palette.css`; a plugin's own stylesheet imports it with
 * `theme(reference)` and emits nothing. Tailwind refuses a plain rule in a
 * `theme(reference)` import, which is why the VALUES are in `palette.css` and
 * this file holds only `@theme` blocks and one `@custom-variant` (plan 204
 * §3.4, measured). `@theme inline` makes `bg-panel` compile to
 * `background-color: var(--panel)`, so a plugin's utilities resolve against
 * Studio's live palette and can never repaint the farm with a frozen copy.
 */

/* A coarse pointer (touch) reports `hover: none`; a hover-revealed control
   needs a permanently visible fallback there (plan 48 §3.3 rule 2). A device
   capability, not a component, so it is vocabulary both compilers share. */
@custom-variant hover-none (@media (hover: none));

/* ---- A. Values that need no palette: radii, type scale, animations ---- */
@theme {
  /* Radii (handoff "Radii"): 16 page panels, 18 floating window and cast,
     14 cards/sheets/status bar, 12 inner cards, 10 buttons and rows,
     9 settings inputs and nav items, 8 small buttons, 7 compact chips,
     5 checkboxes, 999 pills. */
  --radius-panel: 16px;
  --radius-window: 18px;
  --radius-card: 14px;
  --radius-inner: 12px;
  --radius-button: 10px;
  --radius-input: 9px;
  --radius-small: 8px;
  --radius-chip: 7px;
  --radius-check: 5px;
  --radius-pill: 999px;

  /* Type scale (handoff "Typography"), one name per step. */
  --text-section: 19px;
  --text-sheet: 16px;
  --text-title: 15px;
  --text-name: 14px;
  --text-row: 13px;
  --text-body: 12.5px;
  --text-meta: 11.5px;
  --text-label: 11px;
  --text-badge: 10.5px;
  --text-tip: 10px;

  /* The only two animations the handoff allows (README "Interactions"). */
  --animate-enkaku-pulse: enkaku-pulse 2.6s ease-in-out infinite;
  --animate-enkaku-spin: enkaku-spin 0.9s linear infinite;
  @keyframes enkaku-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  @keyframes enkaku-spin {
    to { transform: rotate(360deg); }
  }
}

/* ---- B. Colours, fonts and shadows: names over palette.css's values ---- */
@theme inline {
  --color-bg: var(--bg);
  --color-panel: var(--panel);
  --color-panel-2: var(--panel-2);
  --color-panel-a: var(--panel-a);
  --color-muted: var(--muted);
  --color-muted-2: var(--muted-2);
  --color-hover: var(--hover);
  --color-line: var(--line);
  --color-line-2: var(--line-2);
  --color-border: var(--border);
  --color-border-2: var(--border-2);
  --color-border-3: var(--border-3);
  --color-text: var(--text);
  --color-text-2: var(--text-2);
  --color-text-3: var(--text-3);
  --color-dim: var(--dim);
  --color-faint: var(--faint);
  --color-faint-2: var(--faint-2);
  --color-accent: var(--accent);
  --color-accent-2: var(--accent-2);
  --color-accent-soft: var(--accent-soft);
  --color-on-accent: var(--on-accent);
  --color-accent-a1: var(--accent-a1);
  --color-accent-a2: var(--accent-a2);
  --color-accent-a3: var(--accent-a3);
  --color-ok: var(--ok);
  --color-warn: var(--warn);
  --color-warn-2: var(--warn-2);
  --color-warn-soft: var(--warn-soft);
  --color-danger: var(--danger);
  --color-danger-soft: var(--danger-soft);
  --color-avatar-bg: var(--avatar-bg);
  --color-avatar-fg: var(--avatar-fg);
  --color-tooltip-bg: var(--tooltip-bg);
  --color-tooltip-fg: var(--tooltip-fg);
  --color-scrim: var(--scrim);

  --font-sans: var(--font-ui);
  --font-mono: var(--font-code);

  /* Shadows (handoff "Shadows"), plus the two the table and the card dot draw. */
  --shadow-active-pill: 0 1px 3px #00000014;
  --shadow-cast: 0 8px 24px #00000014;
  --shadow-bulk-pill: 0 10px 24px var(--accent-a3);
  --shadow-popover: 0 16px 40px #0000001f;
  --shadow-menu: 0 20px 50px #00000024;
  --shadow-window: 0 30px 80px #00000033;
  --shadow-selected-row: inset 2px 0 0 var(--accent);
  --shadow-dot-ring: 0 0 0 3px var(--panel-a);
}

/* ---- C. (reserved: nothing; the section letter keeps §4.3's numbering stable) ---- */

/* ---- D. Prototype vocabulary, retained until its importers are deleted ----
 *
 * NOT part of the design. These are the v0.1.32 Studio's token names, kept
 * verbatim so the old screens and the two plugin views keep rendering on the
 * `mvp` branch until wave 3 replaces them (plan 204 §3.5, §9 Q1). A NEW
 * screen must never name one of these. Deleted by: the last of plans 213–220
 * to delete an importer (Studio), and the plugin-view migration plan
 * (plan 204 §9 Q2). Old names that collide with a handoff name
 * (`--color-accent`, `--color-line`, `--color-muted`, `--color-border`,
 * `--radius-card`) are already gone; the handoff value wins.
 */
@theme {
  --color-bg: oklch(0.185 0.012 245);
  --color-surface: oklch(0.209 0.004 245);
  --color-surface-2: oklch(0.159 0.004 245);
  --color-surface-3: oklch(0.27 0.006 245);
  --color-line-strong: oklch(0.341 0.002 245);
  --color-fg: oklch(0.961 0.002 245);
  --color-fg-muted: oklch(0.64 0.004 245);
  --color-fg-subtle: oklch(0.52 0.004 245);
  --color-accent-strong: oklch(0.82 0.14 250.5);
  --color-accent-fg: oklch(0.16 0.02 245);
  --color-led-ok: oklch(0.800 0.182 221.7);
  --color-led-active: oklch(0.72 0.13 250.5);
  --color-led-warn: oklch(0.88 0.17 108);
  --color-led-danger: oklch(0.691 0.199 23.9);
  --color-led-off: oklch(0.46 0.006 245);

  --color-foreground: var(--color-fg);
  --color-card: var(--color-surface);
  --color-popover: var(--color-surface-2);
  --color-primary: var(--accent);
  --color-muted-foreground: var(--color-fg-muted);
  --color-destructive: var(--color-led-danger);
  --color-input: var(--color-line-strong);
  --color-ring: var(--accent);

  --radius-sm: 0.3rem;
  --radius-md: 0.45rem;
  --radius-lg: 0.6rem;
  --radius-xl: 0.85rem;
}
```

Block D's `--color-bg` shadows block B's `--color-bg` (a later `@theme` declaration wins). That is deliberate for the prototype: Studio's `globals.css` body still paints `var(--color-bg)` (the dark graphite) until plan 213 moves the body onto `var(--bg)`, and the old Studio must stay dark, not turn light with a dark sidebar. When block D goes, `bg-bg` becomes the handoff value with no further edit. The tokens test asserts block B's line exists; it does not assert which wins.

Token → utility mapping (the names a screen writes):

| Palette token | `@theme` name | Utilities |
|---|---|---|
| `--bg` | `--color-bg` | `bg-bg` |
| `--panel`, `--panel-2`, `--panel-a` | `--color-panel`, `--color-panel-2`, `--color-panel-a` | `bg-panel`, `bg-panel-2`, `bg-panel-a`, `from-panel-a` |
| `--muted`, `--muted-2`, `--hover` | `--color-muted`, `--color-muted-2`, `--color-hover` | `bg-muted`, `bg-muted-2`, `hover:bg-hover`, `border-muted-2` |
| `--line`, `--line-2` | `--color-line`, `--color-line-2` | `border-line`, `border-line-2`, `bg-line-2` |
| `--border`, `--border-2`, `--border-3` | `--color-border`, `--color-border-2`, `--color-border-3` | `border-border`, `border-border-2`, `border-border-3`, `bg-border-3` |
| `--text`, `--text-2`, `--text-3` | `--color-text`, `--color-text-2`, `--color-text-3` | `text-text`, `text-text-2`, `text-text-3` |
| `--dim`, `--faint`, `--faint-2` | `--color-dim`, `--color-faint`, `--color-faint-2` | `text-dim`, `text-faint`, `text-faint-2`, `bg-faint-2` |
| `--accent`, `--accent-2`, `--accent-soft`, `--on-accent` | `--color-accent`, `--color-accent-2`, `--color-accent-soft`, `--color-on-accent` | `bg-accent`, `text-accent`, `border-accent`, `hover:bg-accent-2`, `bg-accent-soft`, `text-on-accent` |
| `--accent-a1`, `--accent-a2`, `--accent-a3` | `--color-accent-a1`, `-a2`, `-a3` | `bg-accent-a1` (marquee fill), `bg-accent-a2` (node bounds), `shadow-bulk-pill` |
| `--ok`, `--warn`, `--warn-2`, `--warn-soft` | `--color-ok`, `--color-warn`, `--color-warn-2`, `--color-warn-soft` | `bg-ok`, `text-warn`, `bg-warn-2`, `bg-warn-soft` |
| `--danger`, `--danger-soft` | `--color-danger`, `--color-danger-soft` | `text-danger`, `bg-danger`, `bg-danger-soft` |
| `--avatar-bg`, `--avatar-fg` | `--color-avatar-bg`, `--color-avatar-fg` | `bg-avatar-bg`, `text-avatar-fg` |
| `--tooltip-bg`, `--tooltip-fg` | `--color-tooltip-bg`, `--color-tooltip-fg` | `bg-tooltip-bg`, `text-tooltip-fg`, `fill-tooltip-bg` |
| `--scrim` | `--color-scrim` | `bg-scrim` |
| `--font-ui`, `--font-code` | `--font-sans`, `--font-mono` | `font-sans`, `font-mono` |
| (static) | `--radius-panel` … `--radius-pill` | `rounded-panel`, `rounded-window`, `rounded-card`, `rounded-inner`, `rounded-button`, `rounded-input`, `rounded-small`, `rounded-chip`, `rounded-check`, `rounded-pill` |
| (static) | `--text-section` … `--text-tip` | `text-section`, `text-sheet`, `text-title`, `text-name`, `text-row`, `text-body`, `text-meta`, `text-label`, `text-badge`, `text-tip` |
| (static and `var()`) | `--shadow-active-pill`, `--shadow-cast`, `--shadow-bulk-pill`, `--shadow-popover`, `--shadow-menu`, `--shadow-window`, `--shadow-selected-row`, `--shadow-dot-ring` | `shadow-active-pill`, `shadow-cast`, `shadow-bulk-pill`, `shadow-popover`, `shadow-menu`, `shadow-window`, `shadow-selected-row`, `shadow-dot-ring` |
| (static) | `--animate-enkaku-pulse`, `--animate-enkaku-spin` | `animate-enkaku-pulse`, `animate-enkaku-spin` |

`text-text` is what the handoff's own name produces and is kept rather than renamed to `text-fg`: `--color-fg` is a prototype name in block D with a different (dark) value, and giving the handoff's text colour that name would paint the old Studio's text in the handoff's near-black on its dark surfaces.

Deleted from the old `theme.css` (proofs in §10.1): `--color-accent` (old blue) and `--color-line` (old value) in favour of the handoff names; `--font-sans`/`--font-mono` referencing `--font-outfit`/`--font-plex-mono`; the old `--radius-card: 0.5rem`; the shadcn names `--color-background`, `--color-card-foreground`, `--color-popover-foreground`, `--color-primary-foreground`, `--color-secondary`, `--color-secondary-foreground`, `--color-muted`, `--color-accent-foreground`, `--color-destructive-foreground`, `--color-border`, `--radius`.

### 4.4 Studio's stylesheet and fonts

`packages/studio/src/app/globals.css`: insert one line before the existing theme import (line 36, `@import '@enkaku/ui/theme.css';`):

```css
@import '@enkaku/ui/palette.css';
@import '@enkaku/ui/theme.css';
```

Nothing else in that file changes in this plan. `html { color-scheme: dark; }` (line 56), the body's `var(--color-bg)`/`var(--color-fg)` (lines 66–69) and the `.status-rail`/`.rack-label`/`.readout` classes stay: they are the prototype's page and go with plan 213. `body { font-family: var(--font-sans); }` (line 70) now resolves to Geist through block B.

`packages/ui/package.json` `exports` gains `"./palette.css": "./src/palette.css"` beside the existing `"./theme.css": "./src/theme.css"`.

`packages/studio/src/app/layout.tsx` becomes:

```tsx
import type { ReactNode } from 'react'
import { Toaster, TooltipProvider } from '@enkaku/ui'
import { AuthGate } from '@/components/layout/AuthGate'
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/geist-mono/wght.css'
import './globals.css'

export const metadata = {
  title: 'Enkaku Studio',
  description: 'Android device farm — remote control and automation',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TooltipProvider delayDuration={200}>
          {/* Every route is gated behind the core's own auth state (plan 09
              §4.14) — `AuthGate` renders `/login` or `/setup` standalone when
              unauthenticated, and only wraps `children` in `AppShell` once
              there is a session (or local mode's implicit admin). */}
          <AuthGate>{children}</AuthGate>
        </TooltipProvider>
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  )
}
```

The two font imports precede `./globals.css` so the `@font-face` rules are in the document before the first rule that names the family. `packages/studio/src/app/fonts.ts` is deleted.

### 4.5 Icons and theme resolution in `@enkaku/ui`

`packages/ui/src/icons.ts` (new, complete). The first group is every `ph-*` name in the handoff README (53), the second is what the primitives themselves draw:

```ts
/**
 * The icon set (plan 204 §4.5). Phosphor regular, `@phosphor-icons/react`
 * 2.1.10 (plan 200 R6), re-exported under the package's current `*Icon`
 * names so a plugin reaches them through `@enkaku/ui` (external at runtime)
 * instead of bundling its own copy of Phosphor.
 *
 * Group 1 is every `ph-*` name the design handoff uses, in the README's
 * alphabetical order; `icons.test.ts` derives that list from the README
 * itself, so a name added to the design and not here fails a test.
 */
export type { Icon, IconProps } from '@phosphor-icons/react'

export {
  ArrowsClockwiseIcon,
  BellIcon,
  BroadcastIcon,
  BroomIcon,
  CameraIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CheckIcon,
  CircleIcon,
  ClipboardIcon,
  ClockCounterClockwiseIcon,
  CodeIcon,
  DevicesIcon,
  DotOutlineIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FileIcon,
  FileCodeIcon,
  FilePlusIcon,
  FilmSlateIcon,
  FilmStripIcon,
  FlowArrowIcon,
  FolderSimpleIcon,
  FunnelIcon,
  GearIcon,
  ImageIcon,
  ImagesIcon,
  LightningIcon,
  ListDashesIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  PackageIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlugsIcon,
  PlusIcon,
  PowerIcon,
  PuzzlePieceIcon,
  RowsIcon,
  SignInIcon,
  SignOutIcon,
  SpeakerHighIcon,
  SpeakerLowIcon,
  SpeakerSlashIcon,
  SquareIcon,
  SquaresFourIcon,
  SunIcon,
  TerminalIcon,
  TerminalWindowIcon,
  TrashIcon,
  TrayArrowDownIcon,
  UploadSimpleIcon,
  XIcon,
} from '@phosphor-icons/react'

/** Group 2: drawn by the primitives, not named by the handoff. */
export {
  CaretRightIcon,
  CaretUpIcon,
  CaretUpDownIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  InfoIcon,
  TrayIcon,
  WarningIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
```

`packages/ui/src/index.ts` gains, after the `export * from './components/tooltip'` line: `export * from './components/checkbox'`, `export * from './components/status-dot'`, `export * from './components/avatar'`, and after `export * from './lib/device-name'`: `export * from './lib/theme'` and `export * from './icons'`. The `scroll-area` line is removed.

`packages/ui/src/lib/theme.ts` (new, complete):

```ts
import { useSyncExternalStore } from 'react'

/**
 * Which palette the document is showing (plan 204 §3.3). An explicit
 * `data-theme` on `<html>` wins; with no attribute the page follows
 * `prefers-color-scheme`, which is exactly the rule `palette.css`'s three
 * selectors implement. Nothing here WRITES the attribute: the toggle and its
 * `enkaku-theme` persistence are plan 213's.
 */
export type ResolvedTheme = 'light' | 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function resolveTheme(root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): ResolvedTheme {
  const explicit = root?.getAttribute('data-theme')
  if (explicit === 'dark' || explicit === 'light') return explicit
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
  media?.addEventListener('change', onChange)
  return () => {
    observer.disconnect()
    media?.removeEventListener('change', onChange)
  }
}

/** The resolved theme as React state; re-renders when the attribute or the system preference changes. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, () => resolveTheme(), () => 'light')
}
```

`packages/ui/src/components/sonner.tsx` (rewritten, complete):

```tsx
'use client'

import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { CheckCircleIcon, CircleNotchIcon, InfoIcon, WarningIcon, XCircleIcon } from '../icons'
import { useResolvedTheme } from '../lib/theme'

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useResolvedTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CheckCircleIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <WarningIcon className="size-4" />,
        error: <XCircleIcon className="size-4" />,
        loading: <CircleNotchIcon className="size-4 animate-enkaku-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--panel)',
          '--normal-text': 'var(--text)',
          '--normal-border': 'var(--border-2)',
          '--border-radius': '10px',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
```

`packages/studio/src/lib/plugin-icons.ts` (rewritten, complete; ids unchanged):

```ts
import {
  ArrowsClockwiseIcon,
  BellIcon,
  CheckIcon,
  CloudIcon,
  CubeIcon,
  DatabaseIcon,
  DownloadIcon,
  FileTextIcon,
  FolderIcon,
  FunnelIcon,
  GaugeIcon,
  GearIcon,
  GlobeIcon,
  HardDrivesIcon,
  InfoIcon,
  KeyIcon,
  LightningIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  NetworkIcon,
  PauseIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  PulseIcon,
  PuzzlePieceIcon,
  ShareNetworkIcon,
  ShieldIcon,
  StackIcon,
  StackSimpleIcon,
  TableIcon,
  TagIcon,
  TerminalIcon,
  UploadIcon,
  UsersIcon,
  WarningIcon,
  WrenchIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react'
import type { IconName } from '@enkaku/protocol'

/**
 * The allowlist of `ICON_NAMES` (`@enkaku/protocol`'s `plugin-surface.ts`)
 * mapped onto the real components (plan 108 §5 step 108.8; Phosphor since
 * plan 204 §3.7, ids unchanged so a bundled plugin's manifest still parses).
 *
 * A plugin names an icon; Studio draws it. The name is a KEY into this map
 * and nothing else — a plugin never supplies markup, a URL, or an SVG, so
 * there is no path by which a manifest could put arbitrary content in the
 * operator's sidebar.
 *
 * Typed as the exhaustive `Record<IconName, Icon>` on purpose: adding a
 * name to the protocol's allowlist without mapping it here fails `typecheck`
 * rather than shipping a blank square. Two ids have no Phosphor namesake
 * and are mapped by meaning: `activity` → Pulse, `boxes` → Stack.
 */
export const PLUGIN_ICONS: Record<IconName, Icon> = {
  users: UsersIcon,
  database: DatabaseIcon,
  network: NetworkIcon,
  globe: GlobeIcon,
  shield: ShieldIcon,
  activity: PulseIcon,
  box: CubeIcon,
  boxes: StackIcon,
  layers: StackSimpleIcon,
  list: ListIcon,
  table: TableIcon,
  settings: GearIcon,
  wrench: WrenchIcon,
  plug: PlugIcon,
  puzzle: PuzzlePieceIcon,
  key: KeyIcon,
  lock: LockIcon,
  server: HardDrivesIcon,
  cloud: CloudIcon,
  terminal: TerminalIcon,
  'file-text': FileTextIcon,
  folder: FolderIcon,
  search: MagnifyingGlassIcon,
  filter: FunnelIcon,
  zap: LightningIcon,
  gauge: GaugeIcon,
  bell: BellIcon,
  tag: TagIcon,
  link: LinkIcon,
  share: ShareNetworkIcon,
  download: DownloadIcon,
  upload: UploadIcon,
  play: PlayIcon,
  pause: PauseIcon,
  'refresh-cw': ArrowsClockwiseIcon,
  plus: PlusIcon,
  minus: MinusIcon,
  check: CheckIcon,
  x: XIcon,
  info: InfoIcon,
  'alert-triangle': WarningIcon,
}

/** What an unknown or missing name draws — the same mark the static Plugins nav entry uses. */
export const FALLBACK_PLUGIN_ICON: Icon = PuzzlePieceIcon

/**
 * A `Map` rather than an index into `PLUGIN_ICONS`: the name arriving here
 * came off the wire, so it is a `string`, and looking it up needs either a
 * cast (forbidden) or a lookup structure that already accepts one.
 */
const BY_NAME = new Map<string, Icon>(Object.entries(PLUGIN_ICONS))

/**
 * Resolves a wire-supplied icon name. Unknown or absent falls back rather
 * than throwing: a core newer than this Studio build can legitimately name an
 * icon that did not exist when this bundle was compiled, and losing the
 * operator's whole sidebar over a picture is the wrong trade.
 */
export function pluginIcon(name: string | null | undefined): Icon {
  if (!name) return FALLBACK_PLUGIN_ICON
  return BY_NAME.get(name) ?? FALLBACK_PLUGIN_ICON
}
```

Id → Phosphor table, for the record (every component name verified against the 2.1.10 tarball's `dist/csr/`):

| id | Phosphor | id | Phosphor | id | Phosphor |
|---|---|---|---|---|---|
| users | UsersIcon | key | KeyIcon | bell | BellIcon |
| database | DatabaseIcon | lock | LockIcon | tag | TagIcon |
| network | NetworkIcon | server | HardDrivesIcon | link | LinkIcon |
| globe | GlobeIcon | cloud | CloudIcon | share | ShareNetworkIcon |
| shield | ShieldIcon | terminal | TerminalIcon | download | DownloadIcon |
| activity | PulseIcon | file-text | FileTextIcon | upload | UploadIcon |
| box | CubeIcon | folder | FolderIcon | play | PlayIcon |
| boxes | StackIcon | search | MagnifyingGlassIcon | pause | PauseIcon |
| layers | StackSimpleIcon | filter | FunnelIcon | refresh-cw | ArrowsClockwiseIcon |
| list | ListIcon | zap | LightningIcon | plus | PlusIcon |
| table | TableIcon | gauge | GaugeIcon | minus | MinusIcon |
| settings | GearIcon | check | CheckIcon | x | XIcon |
| wrench | WrenchIcon | info | InfoIcon | alert-triangle | WarningIcon |
| plug | PlugIcon | puzzle | PuzzlePieceIcon | | |

`AppShell.tsx:694-709` needs no edit: it calls `pluginIcon()` and renders `<Icon className="size-4 shrink-0" aria-hidden />`, and a Phosphor `Icon` accepts both props. `AppShell`'s own static `NAV` entries keep lucide until plan 213 deletes the file.

`packages/protocol/src/plugin-surface.ts`: the comment at lines 88–94 becomes "The icons a nav entry may name, as stable kebab-case ids. Studio maps each id to a Phosphor component (`packages/studio/src/lib/plugin-icons.ts`); the ids predate that mapping and never change with the icon library. Closed on purpose: …" (the rest of the paragraph unchanged), and line 141's message becomes `` `unknown icon "${String(issue.input)}": not one of the ${ICON_NAMES.length} allowed icon names` ``. `ICON_NAMES` itself is untouched.

### 4.6 The re-skinned primitives

Rules for every file in `packages/ui/src/components`:

1. No `dark:` variant anywhere (G8): the palette switches, the class does not.
2. No shadcn name (G8). Rewrite by this table, in every component §4.6 does not spell out (dialog, alert-dialog, dropdown-menu, select, command, combobox, hover-card, collapsible, slider, input-group, button-group, card, progress):

| Old class | New class | | Old class | New class |
|---|---|---|---|---|
| `bg-background` | `bg-panel` | | `bg-popover` | `bg-panel` |
| `text-foreground` | `text-text` | | `text-popover-foreground` | `text-text` |
| `text-muted-foreground` | `text-faint` | | `bg-card` | `bg-panel` |
| `bg-muted` | `bg-muted` (same name, handoff value) | | `text-card-foreground` | `text-text` |
| `border-input` | `border-border-2` | | `bg-secondary` | `bg-muted` |
| `bg-input/30`, `bg-input/50`, `bg-input/80` | delete | | `text-secondary-foreground` | `text-text` |
| `ring-ring`, `ring-ring/50` | `ring-accent/40` | | `bg-destructive`, `bg-destructive/…` | `bg-danger-soft` |
| `border-ring` | `border-accent` | | `text-destructive` | `text-danger` |
| `bg-primary` | `bg-accent` | | `border-destructive`, `ring-destructive/…` | `border-danger`, `ring-danger/30` |
| `text-primary-foreground` | `text-on-accent` | | `bg-accent` (shadcn's hover surface) | `bg-muted-2` |
| `text-primary` | `text-accent` | | `text-accent-foreground` | `text-text` |
| `bg-border` | `bg-line-2` | | `ring-offset-background` | delete |
| `rounded-xs` | `rounded-check` | | `rounded-md` | `rounded-button` |
| `rounded-sm` | `rounded-small` | | `rounded-lg` | `rounded-inner` |
| `rounded-xl` | `rounded-card` | | `shadow-xs`, `shadow-sm` | delete |
| `shadow-md` | `shadow-popover` | | `shadow-lg`, `shadow-xl`, `shadow-2xl` | `shadow-menu` |
| `text-base` | `text-body` | | `text-sm` | `text-row` |
| `text-xs` | `text-meta` | | `text-white` | `text-on-accent` |

`bg-accent` needs care: shadcn used that name for a hover surface (`skeleton.tsx:4-8` already warns), and the handoff's `bg-accent` is the green fill. In a re-skinned component `bg-accent` may only appear where the handoff paints accent green (a primary button, a checked checkbox, an active switch, a progress fill).

3. Icons come from `../icons` (never `@phosphor-icons/react` directly, so the barrel stays the one place the set is listed): `XIcon` for close buttons (`dialog.tsx:112`, `sheet.tsx:79`), `MagnifyingGlassIcon` for search (`command.tsx:72`, `device-picker.tsx:204`), `CheckIcon` for check marks (`dropdown-menu.tsx:103`, `select.tsx:122`, `combobox.tsx:185`, `device-picker.tsx`), `CaretRightIcon` (`dropdown-menu.tsx:220`), `CaretDownIcon`/`CaretUpIcon` (`select.tsx:47,156,174`), `CaretUpDownIcon` (`combobox.tsx:145`), `CircleIcon` (`dropdown-menu.tsx:138`, radio item), `CircleNotchIcon` (spinner), `TrayIcon` and `WarningIcon` (states).
4. Every measurement below is the handoff's; a value the handoff does not give is named as this plan's choice in the same row.

Props and CSS (exact class strings; `cn()` joins them):

**Button** (`button.tsx`): props unchanged except the four deleted sizes and one new `active?: boolean` (renders `data-active`; the handoff's "active (menu open or filter applied) = accent-soft / accent" state for icon buttons).

| | Classes |
|---|---|
| base | `inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-button text-row font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-accent-soft data-[active=true]:text-accent [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4` |
| `variant=default` (primary: "New script", "Create", "Install plugin") | `bg-accent text-on-accent hover:bg-accent-2` |
| `variant=outline` (bordered: "Add to farm", "Disable / Activate") | `border border-border-2 bg-muted text-text hover:bg-muted-2` |
| `variant=secondary` ("Reload all" on `var(--muted)`) | `bg-muted text-text hover:bg-muted-2` |
| `variant=ghost` (icon buttons: idle faint, hover muted-2) | `text-faint hover:bg-muted-2 hover:text-text` |
| `variant=destructive` (the handoff paints danger only as text; this plan's choice is a soft fill so a filled red never appears) | `bg-danger-soft text-danger hover:bg-danger/15` |
| `variant=link` (the workflow card's "Run" link) | `text-accent underline-offset-4 hover:underline` |
| `size=default` (padding 8px 13px, 13px, radius 10) | `h-[34px] px-[13px]` |
| `size=sm` (small buttons: 26 px tall, radius 8, 12 px text; the pager and the filter chips) | `h-[26px] rounded-small px-[10px] text-[12px]` |
| `size=icon` (32×32, radius 10) | `size-8` |
| `size=icon-sm` (26×26, radius 8) | `size-[26px] rounded-small` |
| `size=icon-lg` (34×34, radius 10, the shortcut rail) | `size-[34px]` |

Deleted sizes: `xs`, `icon-xs`, `lg` (zero callers, §3.1).

**Input** (`input.tsx`): props gain `mono?: boolean` (paths and addresses: `font-mono`) and `variant?: 'default' | 'search'`.

| | Classes |
|---|---|
| base | `h-[34px] w-full min-w-0 rounded-input border border-border-2 bg-panel-2 px-3 text-body text-text outline-none transition-colors placeholder:text-faint focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger file:border-0 file:bg-transparent file:text-row file:font-medium` |
| `variant=search` (the toolbar search popover and the page search fields, on `var(--muted)`, radius 10) | `border-transparent bg-muted rounded-button` |
| `mono` | `font-mono` |

The handoff's input is `padding: 9px 12px` at 12.5 px: 9 + 9 + 16 line height is 34, so the height is fixed rather than padded, matching the button.

**Textarea** (`textarea.tsx`): same base as Input with `min-h-16 py-2 field-sizing-content` in place of the fixed height.

**Checkbox** (`checkbox.tsx`, new): `Checkbox.Root` from `radix-ui` (present in the umbrella 1.6.7, `node_modules/radix-ui/dist/index.d.ts:11-12`). Props: `React.ComponentProps<typeof CheckboxPrimitive.Root>`; `data-slot="checkbox"`. Root: `peer size-4 shrink-0 rounded-check border-[1.5px] border-border-3 bg-panel outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-on-accent`. Indicator: `flex items-center justify-center text-current` containing `<CheckIcon weight="bold" className="size-3" />` (the handoff's "white `ph-check`"; bold is this plan's choice so a 12 px glyph survives inside 16 px).

**Switch** (`switch.tsx`): the `size` prop is deleted (§3.6). Root: `peer inline-flex h-[19px] w-[34px] shrink-0 items-center rounded-pill p-[2px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent data-[state=unchecked]:bg-border-3`. Thumb: `pointer-events-none block size-[15px] rounded-pill bg-panel transition-transform data-[state=checked]:translate-x-[15px] data-[state=unchecked]:translate-x-0`. (34 − 15 − 2·2 = 15.)

**Tabs** (`tabs.tsx`): `TabsList` `variant` becomes `'default' | 'compact' | 'pill' | 'line'`; `line` renders exactly as `default` (two plugin views name it, §3.1; they are re-authored under §9 Q2). The `after:` underline classes are deleted.

| | Classes |
|---|---|
| `TabsList` base | `group/tabs-list inline-flex w-fit items-center gap-1` |
| `TabsList variant=pill` (the cluster tab container: padding 4, `var(--muted)`, 999, gap 4, scrolls) | `max-w-full overflow-x-auto rounded-pill bg-muted p-1` |
| `TabsTrigger` base | `inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-dim transition-colors outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-accent-soft data-[state=active]:text-accent [&_svg:not([class*='size-'])]:size-4` |
| `default`/`line` (tabs: 7px 12px, radius 9, 13px) | `group-data-[variant=default]/tabs-list:rounded-input group-data-[variant=default]/tabs-list:px-3 group-data-[variant=default]/tabs-list:py-[7px] group-data-[variant=default]/tabs-list:text-row` (and the same four with `line`) |
| `compact` (chips: 4px 10px, radius 7, 12px) | `group-data-[variant=compact]/tabs-list:rounded-chip group-data-[variant=compact]/tabs-list:px-[10px] group-data-[variant=compact]/tabs-list:py-1 group-data-[variant=compact]/tabs-list:text-[12px]` |
| `pill` (7px 14px, 999, 12.5px; active = panel + `0 1px 3px #00000014` + 600) | `group-data-[variant=pill]/tabs-list:rounded-pill group-data-[variant=pill]/tabs-list:px-[14px] group-data-[variant=pill]/tabs-list:py-[7px] group-data-[variant=pill]/tabs-list:text-body group-data-[variant=pill]/tabs-list:data-[state=active]:bg-panel group-data-[variant=pill]/tabs-list:data-[state=active]:font-semibold group-data-[variant=pill]/tabs-list:data-[state=active]:text-text group-data-[variant=pill]/tabs-list:data-[state=active]:shadow-active-pill` |

`Tabs` and `TabsContent` keep their current classes.

**Badge** (`badge.tsx`): the handoff's task chip, status pill and state badge are one component. Variants gain `warn`.

| | Classes |
|---|---|
| base | `inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-pill px-[9px] py-[3px] text-meta font-medium [&>svg]:pointer-events-none [&>svg]:size-3` |
| `default` (script running: accent-soft / accent) | `bg-accent-soft text-accent` |
| `warn` (system action: warn-soft / warn) | `bg-warn-soft text-warn` |
| `secondary` (queued: muted-2 / dim) | `bg-muted-2 text-dim` |
| `destructive` | `bg-danger-soft text-danger` |
| `outline` (the version chip: `var(--muted)`, radius 6) | `rounded-[6px] bg-muted text-text-2` |
| `ghost` (idle: plain `faint-2` text, no pill) | `bg-transparent px-0 py-0 text-faint-2` |
| `link` | `bg-transparent px-0 py-0 text-accent underline-offset-2 hover:underline` |

**Popover** (`popover.tsx`): `PopoverContent`: `z-50 w-72 rounded-card border border-border-2 bg-panel p-3 text-text shadow-popover outline-none` plus the existing `data-[state]`/`data-[side]` animation classes unchanged. The handoff gives popovers `0 16px 40px #0000001f`; their radius is not stated, and 14 px (cards, the bulk menu) is this plan's choice.

**Sheet** (`sheet.tsx`): `SheetOverlay`: `fixed inset-0 z-50 bg-scrim` plus the existing fade classes. `SheetContent` base: `fixed z-50 flex flex-col gap-4 bg-panel transition ease-in-out` plus the existing animate/duration classes; `side="right"`: `inset-y-0 right-0 h-full w-[452px] max-w-full border-l border-border` plus the existing slide classes (the `sm:max-w-sm` cap is deleted; 452 is the handoff's width). `left` mirrors it with `border-r`; `top`/`bottom` keep their current inset classes with `border-border`. Close button: `absolute top-4 right-4 rounded-small text-faint transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none` with `<XIcon className="size-4" />`. `SheetTitle`: `text-sheet font-semibold text-text`. `SheetDescription`: `text-body text-dim`.

**Tooltip** (`tooltip.tsx`): `TooltipContent`: `z-50 w-fit rounded-small bg-tooltip-bg px-2 py-[5px] text-tip text-tooltip-fg text-balance` plus the existing animation classes; arrow: `z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-tooltip-bg fill-tooltip-bg`. The handoff gives the colours, radius 8 and 10 px text; the 5×8 padding is this plan's choice.

**Table** (`table.tsx`): `TableHeader`: `sticky top-0 z-10 bg-panel-2 [&_tr]:border-b [&_tr]:border-line`; `TableHead`: `h-[38px] px-2 text-left align-middle text-label font-medium whitespace-nowrap text-faint [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]`; `TableRow`: `border-b border-muted-2 transition-colors hover:bg-hover data-[state=selected]:bg-accent-soft data-[state=selected]:shadow-selected-row`; `TableCell`: `p-2 align-middle text-body wrap-anywhere [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]` (the wrap reasoning comment at `table.tsx:81-108` stays); `TableFooter`: `border-t border-line bg-panel-2 font-medium`; `TableCaption`: `mt-4 text-meta text-faint`; `Table` keeps `w-full caption-bottom text-row`.

**StatusDot** (`status-dot.tsx`, new):

```ts
export type StatusDotState = 'free' | 'controlled' | 'job' | 'offline' | 'unauthorized'
export function StatusDot(props: { state: StatusDotState; ring?: boolean; pulse?: boolean; className?: string; title?: string }): JSX.Element
```

Renders `<span data-slot="status-dot" data-state={state} role="img" aria-label={title ?? state} title={title}>`; classes: base `inline-block shrink-0 rounded-pill`; `ring` false: `size-2` (the table's 8 px dot); `ring` true: `size-[9px] shadow-dot-ring` (the card's 9 px dot with the 3 px `panel-a` ring); `pulse`: `animate-enkaku-pulse` (the status bar's 7 px "System OK" dot passes `className="size-[7px]"`). State colours are the handoff's five: `free` `bg-ok`, `controlled` `bg-warn-2`, `job` `bg-danger`, `offline` `bg-faint-2`, `unauthorized` `bg-warn`. The handoff says "disconnected"; the name here is `offline`, plan 200 §2.4's word for the stored state.

**Avatar** (`avatar.tsx`, new): `export function Avatar({ initials, className, ...props }: React.ComponentProps<'span'> & { initials: string })` rendering `<span data-slot="avatar" className={cn('inline-flex size-[30px] shrink-0 select-none items-center justify-center rounded-pill bg-avatar-bg text-label font-semibold text-avatar-fg', className)}>{initials}</span>`. No radix.

Smaller re-skins: `Skeleton` `animate-pulse rounded-inner bg-muted-2`; `Spinner` renders `<CircleNotchIcon role="status" aria-label="Loading" className={cn('size-4 animate-enkaku-spin', className)} />`; `Separator` `shrink-0 bg-line-2 …` (orientation classes unchanged); `Label` `flex items-center gap-2 text-body font-semibold leading-none text-text select-none …` (disabled classes unchanged); `Progress` root `relative h-[6px] w-full overflow-hidden rounded-pill bg-muted-2`, indicator `h-full w-full flex-1 bg-accent transition-all`; `Card` `flex flex-col gap-6 rounded-card border border-line-2 bg-panel py-6 text-text` (no shadow), `CardTitle` `text-row font-semibold leading-none`, `CardDescription` `text-meta text-dim`; `EmptyState` wrapper `rounded-card border border-dashed border-border-3 px-6 py-12 text-center`, icon circle `mx-auto mb-3 grid size-9 place-items-center rounded-pill bg-muted text-faint` with `<TrayIcon className="size-4" aria-hidden />`, title `text-row font-medium text-text`, description `mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-faint`; `ErrorState` wrapper `rounded-card border border-danger/30 bg-danger-soft px-4 py-4`, icon `<WarningIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />`, title `text-row font-medium text-text`, message `mt-0.5 break-words text-[12px] text-text-3`; `LoadingRows` skeleton class `h-14 w-full rounded-inner`; `ConfirmDialog` description `text-row leading-relaxed text-dim`, destructive action `bg-danger-soft text-danger hover:bg-danger/15`.

`Dialog`/`AlertDialog` content: `rounded-window border border-border-2 bg-panel shadow-window` in place of `rounded-lg border bg-background … shadow-lg`; overlay `bg-scrim`; titles `text-title font-semibold text-text`; descriptions `text-body text-dim`. `DropdownMenuContent`, `SelectContent`, `CommandDialog` panels: `rounded-card border border-border-2 bg-panel p-1 text-text shadow-menu`; their items: `rounded-button px-[10px] py-[9px] text-row … focus:bg-muted data-[highlighted]:bg-muted` (the handoff's action rows: 9px 10px, radius 10, 13px, hover `var(--muted)`), with `data-[variant=destructive]:text-danger` where the component has a destructive variant. `SelectTrigger` takes the Input base classes. `device-picker.tsx` and `device-name.tsx` change only their icon imports (plan 216 rebuilds the picker).

### 4.7 Verifying the fonts in the export

After `bun run build:studio`:

```bash
ls packages/studio/out/_next/static/media | grep -i geist
```

expected: at least `geist-latin-wght-normal.<hash>.woff2` and `geist-mono-latin-wght-normal.<hash>.woff2` (eleven files in all: five Geist subsets, six Geist Mono subsets). And no Outfit or Plex file survives: `ls packages/studio/out/_next/static/media | wc -l` equals the Geist count, because `next/font` no longer emits anything.

### 4.8 Tests

`packages/ui/src/tokens.test.ts` (new; the artefact this plan ships). Pure file parsing, no DOM:

```ts
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const palette = readFileSync(join(import.meta.dir, 'palette.css'), 'utf8')
const theme = readFileSync(join(import.meta.dir, 'theme.css'), 'utf8')

/** The handoff's table (docs/mvp/design_handoff_enkaku_openpf/README.md "Design Tokens"), transcribed once. */
const TOKENS: Record<string, [light: string, dark: string]> = {
  bg: ['#f1f1f2', '#0c0c0e'],
  panel: ['#ffffff', '#16161a'],
  'panel-2': ['#fbfbfc', '#1a1a1f'],
  'panel-a': ['#ffffffee', '#16161aee'],
  muted: ['#f6f6f7', '#202027'],
  'muted-2': ['#f4f4f5', '#1d1d23'],
  hover: ['#fafafa', '#1e1e25'],
  line: ['#f0f0f1', '#26262d'],
  'line-2': ['#eeeef0', '#26262d'],
  border: ['#e8e8ea', '#2a2a32'],
  'border-2': ['#e4e4e7', '#32323b'],
  'border-3': ['#d4d4d8', '#3c3c46'],
  text: ['#18181b', '#f4f4f5'],
  'text-2': ['#3f3f46', '#d4d4d8'],
  'text-3': ['#52525b', '#b0b0b8'],
  dim: ['#71717a', '#8e8e98'],
  faint: ['#a1a1aa', '#71717a'],
  'faint-2': ['#c4c4c8', '#55555f'],
  accent: ['#16803c', '#4ade80'],
  'accent-2': ['#12652f', '#86efac'],
  'accent-soft': ['#ecf6ef', '#16281d'],
  'on-accent': ['#ffffff', '#08130c'],
  'accent-a1': ['#16803c14', '#4ade8014'],
  'accent-a2': ['#16803c1f', '#4ade801f'],
  'accent-a3': ['#16803c40', '#4ade8040'],
  ok: ['#16a34a', '#4ade80'],
  warn: ['#b45309', '#fbbf24'],
  'warn-2': ['#d97706', '#f59e0b'],
  'warn-soft': ['#fef6e7', '#2a2110'],
  danger: ['#dc2626', '#f87171'],
  'danger-soft': ['#fdeceb', '#2b1616'],
  'avatar-bg': ['#fde8ea', '#34212a'],
  'avatar-fg': ['#b4405a', '#f0a3b4'],
  'tooltip-bg': ['#18181b', '#f4f4f5'],
  'tooltip-fg': ['#fafafa', '#18181b'],
  scrim: ['#18181b33', '#00000080'],
}
const NAMES = Object.keys(TOKENS)

/** The body of the first `<selector> {` block, matching braces so a nested block is one unit. */
function block(css: string, selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`selector not found: ${selector}`)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error(`unbalanced block: ${selector}`)
}

const light = block(palette, ':root {')
const systemDark = block(block(palette, '@media (prefers-color-scheme: dark)'), ':root:not([data-theme="light"])')
const explicitDark = block(palette, ':root[data-theme="dark"]')

describe('palette.css (plan 204 §4.2)', () => {
  test('holds exactly the 36 handoff tokens', () => {
    expect(NAMES.length).toBe(36)
    const declared = [...light.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]).filter((n) => !n.startsWith('font-'))
    expect(declared.sort()).toEqual([...NAMES].sort())
  })
  for (const name of NAMES) {
    const [l, d] = TOKENS[name]!
    test(`--${name} is ${l} in light and ${d} in both dark selectors`, () => {
      expect(light).toContain(`--${name}: ${l};`)
      expect(systemDark).toContain(`--${name}: ${d};`)
      expect(explicitDark).toContain(`--${name}: ${d};`)
    })
  }
  test('the two dark blocks are identical', () => {
    expect(systemDark.trim().replace(/\s+/g, ' ')).toBe(explicitDark.trim().replace(/\s+/g, ' '))
  })
  test('declares the two font stacks', () => {
    expect(light).toContain("--font-ui: 'Geist Variable',")
    expect(light).toContain("--font-code: 'Geist Mono Variable',")
  })
  test('is plain rules only, so it never reaches a plugin build', () => {
    expect(palette).not.toContain('@theme')
    expect(palette).not.toContain('@import')
  })
})

describe('theme.css (plan 204 §4.3)', () => {
  const inline = block(theme, '@theme inline')
  for (const name of NAMES) {
    test(`maps --color-${name} onto var(--${name})`, () => {
      expect(inline).toContain(`--color-${name}: var(--${name});`)
    })
  }
  test('maps the fonts', () => {
    expect(inline).toContain('--font-sans: var(--font-ui);')
    expect(inline).toContain('--font-mono: var(--font-code);')
  })
  test.each([
    ['panel', '16px'], ['window', '18px'], ['card', '14px'], ['inner', '12px'], ['button', '10px'],
    ['input', '9px'], ['small', '8px'], ['chip', '7px'], ['check', '5px'], ['pill', '999px'],
  ])('radius %s is %s', (name, px) => {
    expect(theme).toContain(`--radius-${name}: ${px};`)
  })
  test.each([
    ['active-pill', '0 1px 3px #00000014'], ['cast', '0 8px 24px #00000014'], ['bulk-pill', '0 10px 24px var(--accent-a3)'],
    ['popover', '0 16px 40px #0000001f'], ['menu', '0 20px 50px #00000024'], ['window', '0 30px 80px #00000033'],
    ['selected-row', 'inset 2px 0 0 var(--accent)'], ['dot-ring', '0 0 0 3px var(--panel-a)'],
  ])('shadow %s is %s', (name, value) => {
    expect(inline).toContain(`--shadow-${name}: ${value};`)
  })
  test.each([
    ['section', '19px'], ['sheet', '16px'], ['title', '15px'], ['name', '14px'], ['row', '13px'],
    ['body', '12.5px'], ['meta', '11.5px'], ['label', '11px'], ['badge', '10.5px'], ['tip', '10px'],
  ])('text size %s is %s', (name, px) => {
    expect(theme).toContain(`--text-${name}: ${px};`)
  })
  test('declares the two animations and nothing else animates', () => {
    expect(theme).toContain('--animate-enkaku-pulse: enkaku-pulse 2.6s ease-in-out infinite;')
    expect(theme).toContain('--animate-enkaku-spin: enkaku-spin 0.9s linear infinite;')
    expect((theme.match(/@keyframes/g) ?? []).length).toBe(2)
  })
  test('is @theme blocks and one custom variant only, so theme(reference) accepts it', () => {
    expect(theme).toContain('@custom-variant hover-none (@media (hover: none));')
    expect(theme).not.toMatch(/^\s*:root/m)
    expect(theme).not.toContain('@layer')
    expect(theme).not.toContain('@import')
  })
})
```

`packages/ui/src/icons.test.ts` (new): reads `docs/mvp/design_handoff_enkaku_openpf/README.md` (path `join(import.meta.dir, '../../../docs/mvp/design_handoff_enkaku_openpf/README.md')`), collects `new Set(readme.match(/ph-[a-z-]+/g))`, asserts the set's size is 53, converts each to PascalCase plus `Icon` (`'arrows-clockwise'` → `ArrowsClockwiseIcon`, `'x'` → `XIcon`), and asserts `typeof icons[name] === 'object' && 'render' in icons[name]` (a `forwardRef` component) for every one, importing `* as icons from './icons'`. A second test asserts the group-2 nine names exist. A third asserts `Object.keys(icons).length` equals 62 (53 + 9), so an icon cannot be added without being listed.

`packages/ui/src/lib/theme.test.ts` (new): with happy-dom (the package preload), `resolveTheme()` returns `'light'` with no attribute (happy-dom's `matchMedia('(prefers-color-scheme: dark)').matches` is `false`), `'dark'` after `document.documentElement.setAttribute('data-theme', 'dark')`, `'light'` after `'light'`, and ignores an unknown value (`'blue'` → `'light'`); `resolveTheme(null)` with a stubbed `window.matchMedia` returning `{ matches: true }` returns `'dark'` (explicit attribute absent, system dark). Restore the attribute and the stub in `afterEach`.

`packages/ui/src/components/skin.test.tsx` (new): renders through `@testing-library/react` and asserts class names, not computed styles (happy-dom does not resolve custom properties). One `test` per row:

| Render | Assert `className` contains |
|---|---|
| `<Button>Go</Button>` | `rounded-button`, `h-[34px]`, `bg-accent`, `text-on-accent` |
| `<Button variant="outline" size="sm">` | `rounded-small`, `h-[26px]`, `bg-muted`, `border-border-2` |
| `<Button variant="ghost" size="icon" active>` | `size-8`, `data-[active=true]:bg-accent-soft`; attribute `data-active="true"` |
| `<Input />` | `rounded-input`, `bg-panel-2`, `border-border-2`, `text-body` |
| `<Input variant="search" mono />` | `bg-muted`, `rounded-button`, `font-mono` |
| `<Checkbox checked />` | `size-4`, `rounded-check`, `border-[1.5px]`, `border-border-3`, `data-[state=checked]:bg-accent`; the indicator's `svg` is in the document |
| `<Switch checked />` | `h-[19px]`, `w-[34px]`, `rounded-pill`, `data-[state=checked]:bg-accent`; the thumb has `size-[15px]` and `data-[state=checked]:translate-x-[15px]` |
| `<Tabs defaultValue="a"><TabsList variant="pill"><TabsTrigger value="a">A</TabsTrigger></TabsList></Tabs>` | list: `rounded-pill`, `bg-muted`, `p-1`; trigger: `group-data-[variant=pill]/tabs-list:rounded-pill`, `data-[state=active]:bg-accent-soft` |
| same with `variant="compact"` | trigger contains `group-data-[variant=compact]/tabs-list:rounded-chip` |
| `<Badge variant="warn">` | `rounded-pill`, `px-[9px]`, `py-[3px]`, `text-meta`, `bg-warn-soft`, `text-warn` |
| `<Badge variant="ghost">` | `text-faint-2`, not `bg-warn-soft` |
| `<StatusDot state="job" />` | `size-2`, `bg-danger`, `rounded-pill`; not `shadow-dot-ring` |
| `<StatusDot state="free" ring pulse />` | `size-[9px]`, `shadow-dot-ring`, `bg-ok`, `animate-enkaku-pulse` |
| `<Avatar initials="RZ" />` | `size-[30px]`, `rounded-pill`, `bg-avatar-bg`, `text-avatar-fg`; text content `RZ` |
| `<TooltipProvider><Tooltip open><TooltipTrigger>t</TooltipTrigger><TooltipContent>tip</TooltipContent></Tooltip></TooltipProvider>` | the element with text `tip` has `bg-tooltip-bg`, `text-tooltip-fg`, `rounded-small`, `text-tip` |
| `<Table><TableHeader><TableRow><TableHead>H</TableHead></TableRow></TableHeader></Table>` | `th`: `h-[38px]`, `text-label`, `text-faint`; `thead`: `bg-panel-2` |
| one `it` per re-skinned file | `readFileSync` of every file in `components/` contains no `dark:` and none of the shadcn names of G8 (the same regex as G8) |

Existing tests that change: `packages/ui/src/index.test.ts` REQUIRED gains `'Checkbox'`, `'StatusDot'`, `'Avatar'`, `'resolveTheme'`, `'useResolvedTheme'`, `'DevicesIcon'`. `packages/studio/src/lib/plugin-icons.test.ts` is unchanged in text and must still pass. `packages/sdk/src/cli/build-ui.test.ts`: line 64 `bg-surface text-fg-muted rounded-card` → `bg-panel text-faint rounded-card`; line 121 `expect(css).not.toContain('--color-surface:')` → `'--color-panel:'`; line 124 `expect(css).toContain('var(--color-surface,')` → `expect(css).toContain('var(--panel)')`; line 154 `expect(theme).toContain('--color-surface:')` → `'--color-panel:'`; line 166 `expect(globals).not.toContain('--color-surface:')` → `not.toContain('--panel:')` (the values are imported, never inlined) and a new line `expect(globals).toContain("@import '@enkaku/ui/palette.css';")`.

### 4.9 `docs/design.md`, the replacement text

Lines 1–89 of the current file (from `# Design system — Enkaku Studio` through the `.rack-label` paragraph that ends the Typography section) are replaced by the text below. Line 91 `## Screen patterns` and everything after it are kept, with one paragraph inserted directly under that heading (given at the end). The quoted handoff lines keep their punctuation.

~~~~markdown
# Design system — Enkaku Studio

This document records Studio's visual decisions and the reasoning behind them, so a screen can be built without guesswork and a change of style has somewhere to be argued before it spreads across many files.

> **The design of record is the handoff** in `docs/mvp/design_handoff_enkaku_openpf/` (`README.md` plus the `Enkaku Device List.dc.html` prototype), as corrected by `docs/mvp/15-ui-migration.md` §0.1 and §1. Plan 204 (MVP wave 0) landed its tokens, type scale, spacing, radii, shadows, fonts and icons; the sections below through "Theme" describe that. The "Screen patterns" section and everything after it still describe the v0.1.32 prototype and are replaced screen by screen by plans 213–219 (150 for Agents).

## Direction

Desktop-first, 1280–1600 px wide, usable down to 960 px; no mobile layout was designed. Two themes, light and dark, from one palette. Saturated colour is for status and the one accent: a green dot, an amber dot, a red dot, and the accent on the control that acts. Animations are two, and only two: `enkakuPulse` (2.6 s, the health dot) and `enkakuSpin` (0.9 s, a rescan). No page transitions.

## Tokens

The values live in `packages/ui/src/palette.css` and the names in `packages/ui/src/theme.css`. Two files because two compilers read them (plan 204 §3.4): Studio's `globals.css` imports both and puts the values on the document; a plugin's own stylesheet imports only `theme.css`, with `theme(reference)`, which Tailwind refuses for a file holding a plain rule. `theme.css` maps every name with `@theme inline`, so `bg-panel` compiles to `background-color: var(--panel)` in Studio and in a plugin alike, and a plugin can never repaint the farm with a copy of the palette frozen on the day it was built.

Three selectors carry the palette: `:root` (light), `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` (dark by system preference), and `:root[data-theme="dark"]` (dark by choice). An explicit `data-theme` wins; with none, the page follows the system. `packages/ui/src/tokens.test.ts` asserts every value below under every selector.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#f1f1f2` | `#0c0c0e` |
| `--panel` | `#ffffff` | `#16161a` |
| `--panel-2` | `#fbfbfc` | `#1a1a1f` |
| `--panel-a` | `#ffffffee` | `#16161aee` |
| `--muted` | `#f6f6f7` | `#202027` |
| `--muted-2` | `#f4f4f5` | `#1d1d23` |
| `--hover` | `#fafafa` | `#1e1e25` |
| `--line` / `--line-2` | `#f0f0f1` / `#eeeef0` | `#26262d` / `#26262d` |
| `--border` / `--border-2` / `--border-3` | `#e8e8ea` / `#e4e4e7` / `#d4d4d8` | `#2a2a32` / `#32323b` / `#3c3c46` |
| `--text` / `--text-2` / `--text-3` | `#18181b` / `#3f3f46` / `#52525b` | `#f4f4f5` / `#d4d4d8` / `#b0b0b8` |
| `--dim` / `--faint` / `--faint-2` | `#71717a` / `#a1a1aa` / `#c4c4c8` | `#8e8e98` / `#71717a` / `#55555f` |
| `--accent` / `--accent-2` | `#16803c` / `#12652f` | `#4ade80` / `#86efac` |
| `--accent-soft` / `--on-accent` | `#ecf6ef` / `#ffffff` | `#16281d` / `#08130c` |
| `--accent-a1` / `-a2` / `-a3` | `#16803c14` / `1f` / `40` | `#4ade8014` / `1f` / `40` |
| `--ok` | `#16a34a` | `#4ade80` |
| `--warn` / `--warn-2` / `--warn-soft` | `#b45309` / `#d97706` / `#fef6e7` | `#fbbf24` / `#f59e0b` / `#2a2110` |
| `--danger` / `--danger-soft` | `#dc2626` / `#fdeceb` | `#f87171` / `#2b1616` |
| `--avatar-bg` / `--avatar-fg` | `#fde8ea` / `#b4405a` | `#34212a` / `#f0a3b4` |
| `--tooltip-bg` / `--tooltip-fg` | `#18181b` / `#fafafa` | `#f4f4f5` / `#18181b` |
| `--scrim` | `#18181b33` | `#00000080` |

What the names mean: `--bg` is the page behind the panels; `--panel` is every panel, the rail, the status bar, a popover; `--panel-2` is a recessed surface (a table header, an input); `--panel-a` is the panel at 93% alpha, for a scrim over a screen; `--muted` and `--muted-2` are fills for chips, pill containers and hover rows; `--hover` is a hovered table row; `--line`/`--line-2` are hairlines inside a panel and `--border`/`-2`/`-3` are borders of increasing weight; `--text`/`-2`/`-3` are body text steps and `--dim`/`--faint`/`--faint-2` are the secondary steps; `--accent` is the one interactive colour, `--accent-2` its hover, `--accent-soft` its tint, `--on-accent` the text on it, and `--accent-a1/2/3` its alphas (marquee fill, node bounds, the bulk pill's shadow); `--ok`, `--warn`, `--warn-2`, `--danger` are status, with `-soft` tints; `--avatar-*` is the avatar chip; `--tooltip-*` is the dark tooltip; `--scrim` dims a sheet's backdrop.

### Writing colour classes

Tailwind v4 generates the utilities from `theme.css`: `bg-panel`, `bg-panel-2`, `text-text`, `text-faint`, `border-line-2`, `border-border-3`, `bg-accent-soft`, `text-on-accent`, `bg-scrim`, `fill-tooltip-bg`, with opacity modifiers (`bg-danger/15`). `text-text` is the body text colour; it reads oddly and is kept because it is the handoff's own name.

**Do not write `bg-[--color-panel]`.** That is Tailwind v3 syntax and produces nothing in v4. **Do not write `dark:`.** The palette switches; a class never does. **Do not state a hex in a component.** `packages/studio/src/design-rules.test.ts` fails a `.ts`/`.tsx` file that contains one.

The names `bg-surface`, `text-fg-muted`, `text-led-ok` and the shadcn names (`bg-primary`, `text-muted-foreground`) are the prototype's vocabulary, retained in `theme.css`'s last block only until the screens that use them are deleted (plan 204 §3.5). A new screen never names one.

## Typography

Geist and Geist Mono, self-hosted through `@fontsource-variable/geist` and `@fontsource-variable/geist-mono` (imported once in `packages/studio/src/app/layout.tsx`, `wght.css` of each, normal weight only), never from Google Fonts: the core serves Studio on LANs that may have no internet, and on at least one farm every request rides the guest agent's SOCKS5 tunnel, where an external fetch hangs rather than degrading. `font-sans` is Geist, `font-mono` is Geist Mono.

From the handoff, verbatim: **Typography** — `Geist` (400/500/600/700) for UI, `Geist Mono` (400/500) for serials, endpoints, paths, versions, script names, timestamps and numeric readouts. Scale: 19px/600 settings section titles, 16px/600 sheet titles, 15px/600 page and job titles, 14px/600 device name in Device Control, 13px/500-600 row titles and buttons, 12.5px body and controls, 11.5px meta, 11px column labels and hints, 10.5px badges, 10px tooltips and frame captions.

The scale has one utility per step: `text-section` (19), `text-sheet` (16), `text-title` (15), `text-name` (14), `text-row` (13), `text-body` (12.5), `text-meta` (11.5), `text-label` (11), `text-badge` (10.5), `text-tip` (10). A measurement (a serial, an endpoint, a duration, a count) is always `font-mono`.

## Spacing

From the handoff, verbatim: **Spacing** — 10px shell gap and padding; 12–14px panel padding; 6/8/10/12/14px gaps.

## Radii

From the handoff, verbatim: **Radii** — 16px page panels, 18px floating window and cast, 14px cards/sheets/status bar, 12px inner cards, 10px buttons and rows, 9px settings inputs and nav items, 8px small buttons, 7px compact chips, 5px checkboxes, 999px pills.

Utilities: `rounded-panel` (16), `rounded-window` (18), `rounded-card` (14), `rounded-inner` (12), `rounded-button` (10), `rounded-input` (9), `rounded-small` (8), `rounded-chip` (7), `rounded-check` (5), `rounded-pill` (999).

## Shadows

From the handoff, verbatim: **Shadows** — `0 1px 3px #00000014` (active pill), `0 8px 24px #00000014` (cast), `0 10px 24px var(--accent-a3)` (bulk pill), `0 16px 40px #0000001f` (popovers), `0 20px 50px #00000024` (console/menus), `0 30px 80px #00000033` (Device Control).

Utilities: `shadow-active-pill`, `shadow-cast`, `shadow-bulk-pill`, `shadow-popover`, `shadow-menu`, `shadow-window`, plus two the components draw: `shadow-selected-row` (`inset 2px 0 0 var(--accent)`, the selected table row) and `shadow-dot-ring` (`0 0 0 3px var(--panel-a)`, the card's status dot). The console the handoff shadowed was removed by MVP 15 §0.1.4; the value stays for menus.

## Icons

Phosphor, regular weight, from `@phosphor-icons/react` 2.1.10, under the package's `*Icon` names (`DevicesIcon`, `ArrowsClockwiseIcon`). Studio imports them from `@phosphor-icons/react`; `@enkaku/ui` re-exports the handoff's set from `packages/ui/src/icons.ts`, and a plugin takes them from `@enkaku/ui` so it never bundles its own copy. The plugin nav allowlist (`ICON_NAMES`, 41 ids) is unchanged; `packages/studio/src/lib/plugin-icons.ts` maps each id to a Phosphor component.

## Theme

`resolveTheme()` from `@enkaku/ui` answers `'light' | 'dark'` by the same rule as the palette's selectors: an explicit `data-theme` on `<html>`, else the system preference. `useResolvedTheme()` is the same as React state, re-rendering when either changes. The toggle that writes the attribute and persists it under `localStorage` `enkaku-theme` is the shell's (plan 213).

## Primitives

`@enkaku/ui`'s components carry the handoff's measurements (plan 204 §4.6): a button is 34 px tall with a 10 px radius (`sm` is 26 px with 8 px; `icon` is 32×32; `icon-lg` is the 34×34 rail button); an input is 34 px, 9 px radius, on `panel-2` with a `border-2` border; a checkbox is 16×16, 5 px, a 1.5 px `border-3` border, accent when checked; a switch is 34×19 with a 15 px knob; tabs are 7px 12px at 9 px, compact chips 4px 10px at 7 px, and pill tabs sit in a 999 px `muted` container; a popover carries `shadow-popover`; a sheet is 452 px on the right behind `bg-scrim`; a tooltip is `tooltip-bg`/`tooltip-fg` at 8 px and 10 px text; a table header is 38 px on `panel-2` with 11 px `faint` labels; `StatusDot` is 8 px, or 9 px with a 3 px `panel-a` ring on a card; `Badge` is the task chip (3px 9px, 999 px, 11.5 px; `default` accent, `warn`, `secondary` muted, `ghost` plain); `Avatar` is the 30 px initials chip.
~~~~

The paragraph inserted directly under the retained `## Screen patterns` heading:

~~~~markdown
> **Prototype section.** Everything from here on describes the v0.1.32 Studio (`AppShell`, `PageHeader`, the status rail, the device popup, `TargetPicker`, the operation tray). It is replaced screen by screen by plans 213 (shell), 214 (Devices), 215 (Device Control), 216 (action dialogs), 217 (Scripts and Workflows), 218 (Jobs), 219 (Plugins and Settings) and 150 (Agents), each of which rewrites the bullets it owns and deletes the rest.
~~~~

### 4.10 Other documentation edits

- `CLAUDE.md:89` becomes: "- Tailwind v4 colour classes: write `bg-panel` and `text-faint`, never `bg-[--color-panel]`. The v3 bracket form compiles to nothing in v4 and fails silently. Never `dark:`; the palette switches, the class does not. See `docs/design.md`."
- `packages/ui/README.md:61-99` ("Where the styling lives"): the first paragraph becomes "**The design tokens live here**: the values in `src/palette.css` (exported as `@enkaku/ui/palette.css`, imported by Studio only) and the utility names in `src/theme.css` (exported as `@enkaku/ui/theme.css`, imported by Studio and by every plugin stylesheet with `theme(reference)`). Tailwind refuses a plain rule in a `theme(reference)` import, which is why the two are separate files (plan 204 §3.4)." The bullet "`bg-surface` compiles to `var(--color-surface, <build-time value>)`" becomes "`bg-panel` compiles to `var(--panel)` (the mapping is `@theme inline`), so Studio's live value is the only value there is". Lines 100–127 ("Adding a component from shadcn") are deleted entirely and replaced by one paragraph headed `## Adding a component`: "Components are hand-written against `docs/design.md` and `theme.css`'s names; there is no shadcn configuration to resync from (`components.json` was deleted by plan 204, because a resync would undo the handoff's skin). Import icons from `../icons`, never from `@phosphor-icons/react` directly, so the barrel stays the one list of the set. Export the new file from `src/index.ts`; `index.test.ts`'s REQUIRED list is where a plugin-facing name is pinned."
- `packages/sdk/README.md:710-711`: replace `bg-surface` with `bg-panel` and the token list "`bg-surface`, `text-fg-muted`, `text-led-ok`, `rounded-card`, and the `hover-none:` variant" with "`bg-panel`, `text-faint`, `text-ok`, `rounded-card`, and the `hover-none:` variant".
- `packages/sdk/src/cli/init.ts:330` `text-sm text-fg-muted` → `text-body text-faint`; `:426` comment `bg-surface, text-fg-muted, text-led-ok, rounded-card` → `bg-panel, text-faint, text-ok, rounded-card`; the comment at `:407-410` keeps its meaning with `bg-panel` in place of `bg-surface`.

## 5. Implementation steps

Every step: read the named files first (plan 200 §2.2), match on content, quote the line in your notes. Work on the `mvp` branch; commits `feat(mvp-204): …` / `chore(mvp-204): …`.

### 204.1 Dependencies

- Files changed: `packages/ui/package.json`, `packages/studio/package.json`, `bun.lock`.
- Commands, in this order, from the repo root:
  ```bash
  bun add --cwd packages/ui @phosphor-icons/react@2.1.10
  bun add --cwd packages/studio @phosphor-icons/react@2.1.10 @fontsource-variable/geist@5.3.0 @fontsource-variable/geist-mono@5.3.0
  bun remove --cwd packages/ui lucide-react next-themes
  ```
  Then add `"./palette.css": "./src/palette.css"` to `packages/ui/package.json`'s `exports` (beside `"./theme.css"`).
- Files deleted: none.
- Test file: none (dependency step).
- Verifiable result: `rg -n '"@phosphor-icons/react": "2.1.10"' packages/ui/package.json packages/studio/package.json` → 2 lines; `rg -n '"@fontsource-variable/geist(-mono)?": "5.3.0"' packages/studio/package.json` → 2 lines; `rg -n "lucide-react|next-themes" packages/ui/package.json` → empty.
- Do not: remove `lucide-react` from `packages/studio/package.json` (106 files still import it; §2); do not pin with `^` (plan 200 R6/R7 are exact versions and the plugin bundler externals reason about one version).

### 204.2 Palette, theme, Studio import, tokens test

- Files created: `packages/ui/src/palette.css` (§4.2 verbatim), `packages/ui/src/tokens.test.ts` (§4.8 verbatim).
- Files changed: `packages/ui/src/theme.css` (replace the whole file with §4.3), `packages/studio/src/app/globals.css` (insert the palette import before line 36, §4.4).
- Files deleted: none.
- Test file: `packages/ui/src/tokens.test.ts`.
- Verifiable result: `bun run --cwd packages/ui test src/tokens.test.ts` → all pass; `rg -n "oklch\(" packages/ui/src/theme.css | wc -l` → 15 (block D, all of them); `rg -n "font-outfit|font-plex-mono|destructive-foreground|radius-card: 0.5rem" packages/ui/src/theme.css` → empty.
- Do not: put a `:root` rule, an `@import` or an `@layer` in `theme.css` (§3.4 breaks every plugin build); do not "fix" block D's `--color-bg` shadowing block B's (§4.3 explains it); do not touch `globals.css`'s body, `color-scheme`, or `.status-rail` (plan 213).

### 204.3 Fonts

- Files changed: `packages/studio/src/app/layout.tsx` (§4.4 verbatim).
- Files deleted: `packages/studio/src/app/fonts.ts`.
- Test file: none in this step (the export check is the test).
- Verifiable result: `bun run build:studio` succeeds (stop any `next dev` on :3001 first; `scripts/build-studio.sh` refuses otherwise); `ls packages/studio/out/_next/static/media | grep -ci geist` ≥ 2; `rg -n "next/font|fonts.googleapis|Outfit|Plex" packages/studio/src packages/ui/src` → empty.
- Do not: import `index.css` from either fontsource package (that ships the italics the handoff never uses); do not add a `<link>` to Google Fonts; do not keep `fonts.ts` "for later".

### 204.4 Icons

- Files created: `packages/ui/src/icons.ts` (§4.5 verbatim), `packages/ui/src/icons.test.ts` (§4.8).
- Files changed: `packages/ui/src/index.ts` (add the `./icons`, `./lib/theme`, `./components/checkbox`, `./components/status-dot`, `./components/avatar` lines; remove `./components/scroll-area`; the three component files are created in 204.6, so typecheck is green only after that step), `packages/studio/src/lib/plugin-icons.ts` (§4.5 verbatim), `packages/protocol/src/plugin-surface.ts` (the comment at lines 88–94 and the message at line 141, §4.5).
- Files deleted: none.
- Test files: `packages/ui/src/icons.test.ts`, `packages/studio/src/lib/plugin-icons.test.ts` (unchanged text), `packages/protocol/src/plugin-surface.test.ts` (unchanged).
- Verifiable result: `bun run --cwd packages/ui test src/icons.test.ts` → pass (53 handoff names, 9 primitive names, 62 exports); `bun run --cwd packages/studio test src/lib/plugin-icons.test.ts` → pass; `bun test packages/protocol/src/plugin-surface.test.ts` → pass; `rg -n "lucide" packages/protocol/src packages/studio/src/lib/plugin-icons.ts --glob '!**/*.test.ts'` → empty.
- Do not: change any entry of `ICON_NAMES` (a bundled plugin's manifest names them); do not use the deprecated plain Phosphor names (`Devices`); do not edit `AppShell.tsx` (plan 213 deletes it; its `pluginIcon` call already compiles against a Phosphor `Icon`).

### 204.5 Theme resolution and the Toaster

- Files created: `packages/ui/src/lib/theme.ts` (§4.5 verbatim), `packages/ui/src/lib/theme.test.ts` (§4.8).
- Files changed: `packages/ui/src/components/sonner.tsx` (§4.5 verbatim).
- Files deleted: none.
- Test file: `packages/ui/src/lib/theme.test.ts`.
- Verifiable result: `bun run --cwd packages/ui test src/lib/theme.test.ts` → pass; `rg -n "next-themes" packages/ui` → empty.
- Do not: read or write `localStorage` here (the `enkaku-theme` key is plan 213's); do not set `data-theme` anywhere.

### 204.6 Re-skin the named primitives, add the three new ones

- Files created: `packages/ui/src/components/checkbox.tsx`, `packages/ui/src/components/status-dot.tsx`, `packages/ui/src/components/avatar.tsx` (§4.6).
- Files changed, each to its §4.6 row: `button.tsx`, `input.tsx`, `textarea.tsx`, `switch.tsx`, `tabs.tsx`, `badge.tsx`, `popover.tsx`, `sheet.tsx`, `tooltip.tsx`, `table.tsx`, `skeleton.tsx`, `spinner.tsx`, `separator.tsx`, `label.tsx`, `progress.tsx`, `card.tsx`, `states.tsx`, `confirm-dialog.tsx`.
- Files deleted: none.
- Test file: `packages/ui/src/components/skin.test.tsx` (created in 204.10; run after it exists).
- Verifiable result: after 204.10, `bun run --cwd packages/ui test src/components/skin.test.tsx` → pass; `rg -n "\bdark:" packages/ui/src` → empty.
- Do not: rename a variant or size that has a caller (§3.6; `bun run typecheck` is the proof); do not keep `Switch`'s `size` prop; do not keep `Button`'s `xs`, `icon-xs`, `lg`; do not paint `bg-accent` anywhere the handoff does not paint green (§4.6 rule 2).

### 204.7 Re-skin the remaining components by the mapping table

- Files changed: `alert-dialog.tsx`, `dialog.tsx`, `dropdown-menu.tsx`, `select.tsx`, `command.tsx`, `combobox.tsx`, `hover-card.tsx`, `collapsible.tsx`, `slider.tsx`, `input-group.tsx`, `button-group.tsx`, `device-picker.tsx` (icons only), `device-name.tsx` (no change expected; verify it names no shadcn token).
- Files deleted: none.
- Test files: the package's existing `dialog.test.tsx`, `combobox.test.tsx`, `command-scroll.test.tsx`, `input-group.test.tsx`, `device-picker.test.tsx`, `table.test.tsx`, `device-name.test.tsx`.
- Verifiable result: `bun run --cwd packages/ui test src/components/` → pass (this is the directory the step touched; it is not the Studio suite); the G8 grep → empty.
- Do not: rewrite `device-picker.tsx`'s prototype-token classes (`text-fg-subtle` at line 204 and its siblings); plan 216 rebuilds it and block D keeps it rendering; only its two lucide imports change.

### 204.8 Delete what nothing imports

- Files deleted: `packages/ui/src/components/scroll-area.tsx`, `packages/ui/components.json`.
- Files changed: `packages/ui/src/index.ts` (the `scroll-area` line, done in 204.4), `packages/ui/README.md` (§4.10).
- Test file: `packages/ui/src/index.test.ts` (REQUIRED list, §4.8).
- Verifiable result: G10's command → empty; `bun run --cwd packages/ui test src/index.test.ts` → pass.
- Do not: delete `Card`, `Collapsible`, `HoverCard`, `ButtonGroup`, `Command`, `InputGroup`, `Slider`, `Select`, `Progress`, `Separator`, `Textarea`; every one has an importer (§3.1) and its deletion is owed by a later plan (§10.2).

### 204.9 The four `Switch size="sm"` call sites

- Files changed: `packages/studio/src/components/device-popup/DevicePopup.tsx:1425`, `packages/studio/src/components/workflow/ParamsEditor.tsx:119`, `packages/studio/src/components/InspectorPanel.tsx:817`, `packages/studio/src/components/device/ClipboardButton.tsx:123`: delete the `size="sm"` attribute and nothing else on those lines.
- Files deleted: none.
- Test file: none (a prop removal; `bun run typecheck` is the check).
- Verifiable result: `rg -n "<Switch[^>]*size=" packages plugins` → empty; `bun run typecheck` → `studio OK`.
- Do not: restyle anything else in those four files (§2).

### 204.10 The skin test

- Files created: `packages/ui/src/components/skin.test.tsx` (§4.8 table, one test per row).
- Files changed: `packages/ui/src/index.test.ts` (REQUIRED additions).
- Test file: itself.
- Verifiable result: `bun run --cwd packages/ui test src/components/skin.test.tsx` → pass; `bun run --cwd packages/ui test src/index.test.ts` → pass.
- Do not: assert computed styles (happy-dom does not resolve custom properties; the assertion is on class names by design).

### 204.11 SDK scaffold, its test, the READMEs, CLAUDE.md

- Files changed: `packages/sdk/src/cli/build-ui.test.ts` (the five line edits in §4.8), `packages/sdk/src/cli/init.ts` (§4.10), `packages/sdk/README.md` (§4.10), `packages/ui/README.md` (§4.10), `CLAUDE.md:89` (§4.10).
- Files deleted: none.
- Test file: `packages/sdk/src/cli/build-ui.test.ts`.
- Verifiable result: `bun test packages/sdk/src/cli/build-ui.test.ts` → pass (it compiles a scaffolded stylesheet with the real Tailwind against the real `theme.css`, so this is also the proof that a plugin build still works after §4.3); `rg -n "bg-surface|text-fg-muted" packages/sdk/src/cli/init.ts packages/sdk/README.md CLAUDE.md` → empty.
- Do not: touch `plugins/proxy-manager/src/ui/index.css` (a plugin edit needs a version bump and belongs to §9 Q2; its comment naming `bg-surface` is a comment).

### 204.12 `docs/design.md`

- Files changed: `docs/design.md`: replace lines 1–89 with §4.9's first block; insert §4.9's second block directly under `## Screen patterns`.
- Files deleted: none.
- Test file: none.
- Verifiable result: G12's command → empty; `rg -n "^## " docs/design.md` lists, in order, `Direction`, `Tokens`, `Typography`, `Spacing`, `Radii`, `Shadows`, `Icons`, `Theme`, `Primitives`, `Screen patterns`, then the unchanged headings.
- Do not: edit anything below the inserted paragraph (plans 213–220 own it); do not paraphrase the verbatim handoff sentences.

### 204.13 Final verification

- Commands, one at a time, never concurrently: `bun run typecheck`; each §7 test command; each §10.1 proof; `ps -Ao pid=,command= | grep -i "[o]penpf"` → nothing but your shell.
- Update the `> Status:` line and write §11; `bash scripts/check-plan-status.sh` passes.

### 204.14 Delete block D (only if §9 Q1 is answered "delete now")

- Files changed: `packages/ui/src/theme.css` (delete block D and its header comment).
- Verifiable result: `rg -n "oklch\(" packages/ui/src/theme.css` → empty; G14 closes.
- If Q1 is not answered, skip this step, leave G14 as `owner`, and report it under "Open questions hit". Do not run it on your own judgement.

## 6. Acceptance criteria

1. G1–G13 checked; G14 checked or recorded as `owner` with §9 Q1 quoted.
2. `bun run typecheck` prints `OK` for every package including `studio`, `proxy-manager` and `mikrotik-routing` (the two plugin views keep compiling against `TabsList variant="line"` and the retained prototype names).
3. Every §7 command passes, run one at a time.
4. Every §10.1 proof prints nothing.
5. The built export carries Geist and no Outfit or Plex file (§4.7).
6. No file under `packages/studio/src` other than `app/layout.tsx`, `app/globals.css`, `lib/plugin-icons.ts` and the four files of 204.9 has changed (`git diff --stat mvp -- packages/studio/src` lists exactly those seven).
7. `packages/core/packs/` was not rebuilt and no plugin version moved (`git diff --stat -- plugins` is empty).

## 7. Test plan

Scoped commands, each on its own, never two at once (CLAUDE.md, plan 200 §2.3). The root `bunfig.toml` excludes `packages/ui` and `packages/studio` from a root invocation, so those two run through their package scripts, which append the path to `bun test --isolate`:

```bash
bun run --cwd packages/ui test src/tokens.test.ts
bun run --cwd packages/ui test src/icons.test.ts
bun run --cwd packages/ui test src/lib/theme.test.ts
bun run --cwd packages/ui test src/components/skin.test.tsx
bun run --cwd packages/ui test src/index.test.ts
bun run --cwd packages/ui test src/components/            # the directory 204.6 and 204.7 touched: its 8 existing tests plus skin.test.tsx
bun run --cwd packages/studio test src/lib/plugin-icons.test.ts
bun run --cwd packages/studio test src/design-rules.test.ts   # scans packages/ui/src too: no hex in a .ts/.tsx, no bracket colour form
bun test packages/protocol/src/plugin-surface.test.ts
bun test packages/sdk/src/cli/build-ui.test.ts                # compiles a plugin stylesheet against the real theme.css
```

Never `bun test`, never `bun run --cwd packages/studio test`, never `bun run --cwd packages/ui test` without a path.

### 7.1 Named greps

The tables in §0 and §10 name these; every one must print nothing (or exactly what its line says). They are fenced here because a regex alternation cannot be written inside a Markdown table cell without escaping the pipe, and an escaped pipe means a literal `|` to `rg`.

```bash
# GREP-FONTS
rg -n -e "next/font" -e "fonts.googleapis" -e "outfit" -e "plexMono" -e "font-outfit" -e "font-plex-mono" -e "Outfit" -e "Plex" packages/studio/src packages/ui/src
# GREP-FONT-FILES (after `bun run build:studio`): at least the two latin files
find packages/studio/out/_next/static/media -iname 'geist*.woff2'
# GREP-FONT-LEFTOVERS: nothing that is not Geist
find packages/studio/out/_next/static/media -type f -not -iname 'geist*.woff2'
# GREP-LUCIDE-UI
rg -n -e "lucide-react" -e "next-themes" packages/ui
# GREP-DARK
rg -n "\bdark:" packages/ui/src
# GREP-SHADCN: no shadcn token name in a component
rg -n "(bg|text|border|ring|fill|placeholder|selection)-(background|foreground|primary|primary-foreground|secondary|secondary-foreground|popover|popover-foreground|card|card-foreground|muted-foreground|destructive|input|ring)\b" packages/ui/src/components
# GREP-SCROLL
rg -n -e "ScrollArea" -e "scroll-area" packages plugins examples
# GREP-COMPONENTS-JSON
rg -n -e "components.json" -e "shadcn@latest" packages/ui
# GREP-DESIGN-HEAD: the part of docs/design.md above "## Screen patterns" holds nothing of the prototype
sed -n '1,/^## Screen patterns/p' docs/design.md > "${TMPDIR:-/tmp}/plan134-design-head.md" && rg -n -e "Outfit" -e "IBM Plex" -e "oklch" -e "refs/ui" -e "instrument panel" "${TMPDIR:-/tmp}/plan134-design-head.md"
# GREP-OLD-ACCENT
rg -n "color-(accent|line): oklch" packages/ui/src/theme.css
# GREP-OLD-FONT-VARS
rg -n "var\(--font-(outfit|plex-mono)\)" packages
# GREP-SHADCN-DEAD-USES: the deleted bridge names have no user anywhere
rg -n "(bg|text|border|ring)-(background|card-foreground|popover-foreground|primary-foreground|secondary|secondary-foreground|accent-foreground)\b" packages plugins
# GREP-SHADCN-DEAD-DEFS: and no definition
rg -n "^\s*--(color-background|color-card-foreground|color-popover-foreground|color-primary-foreground|color-secondary|color-secondary-foreground|color-accent-foreground|color-destructive-foreground|radius):" packages/ui/src/theme.css
# GREP-BUTTON-SIZES
rg -n 'size="(xs|icon-xs|lg)"' packages/studio/src packages/ui/src plugins
# GREP-VOCAB (plan 200 §2.4, this plan's new files)
rg -n -i -e "lease" -e "cluster" -e "holder" -e "assist" -e "co-control" -e "wall\b" packages/ui/src/palette.css packages/ui/src/theme.css packages/ui/src/icons.ts packages/ui/src/lib/theme.ts packages/ui/src/components/checkbox.tsx packages/ui/src/components/status-dot.tsx packages/ui/src/components/avatar.tsx
```

Manual smoke (no device):

```bash
bun run build:studio
ls packages/studio/out/_next/static/media | grep -i geist            # ≥ 2 lines
ls packages/studio/out/_next/static/media | grep -iv geist           # empty
bun run dev            # core on :7700, in one terminal
bun run dev:studio     # :3001, in another
```

In the browser at `http://localhost:3001`: open DevTools, run `getComputedStyle(document.documentElement).getPropertyValue('--panel')` → `#ffffff` (or `#16161a` on a dark-preference OS); run `document.documentElement.dataset.theme = 'dark'` → the same expression returns `#16161a`, and a toast (trigger any action) renders on a dark panel; `document.documentElement.dataset.theme = 'light'` → `#ffffff` regardless of the OS preference; `getComputedStyle(document.body).fontFamily` starts with `"Geist Variable"`. The old Studio's chrome stays dark graphite with green accents; that is expected until plan 213 (§3.5). Stop both processes; `ps -Ao pid=,command= | grep -i "[o]penpf"` → nothing.

Device-gated tests: none in this plan.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A plugin build breaks because `theme.css` gained a non-`@theme` rule | `tokens.test.ts` refuses `:root`, `@layer`, `@import` in `theme.css`; `build-ui.test.ts` compiles a real scaffold against it. |
| The old Studio looks wrong on the `mvp` branch (light primitives on dark chrome when the OS is light; green accent; light hairlines) | Expected and bounded: block D keeps every old name resolving; plan 213 moves the page onto the palette; §9 Q1 decides whether the prototype should instead be left unstyled. |
| A hex literal in `palette.css` trips `design-rules.test.ts` | It scans `.ts`/`.tsx` only (`design-rules.test.ts:33`); no new `.ts` file in this plan contains a hex. |
| Next.js does not copy the fontsource woff2 files | G3's `ls` is the check; if it fails, the fallback is `next/font/local` pointing at the same package files, and that is recorded as a discrepancy, not silently switched to Google Fonts. |
| Phosphor's `*Icon` names are removed in a later major | The version is pinned exactly; a bump is a plan 200 §5 row change with a review. |
| `useSyncExternalStore` server snapshot mismatch during static export | The server snapshot is `'light'`, matching `:root`'s default; the client corrects on hydration, and the Toaster is the only consumer. |
| `TabsList variant="line"` keeps a name the handoff has no shape for | Two plugin callers only; §9 Q2's plan renames them and deletes the variant. |
| Deleting `--radius-sm/md/lg/xl` would nudge 127 prototype files | They are kept in block D; Tailwind's own defaults take over only when block D goes. |

## 9. Open questions

1. **Q1, the prototype vocabulary (block D).** Delete it in this plan, as the brief asked, leaving the old Studio and both plugin views unstyled on `mvp` until wave 3 and contradicting MVP 16 §5 item 5's post-wave-2 alpha through the old Studio; or keep it as §4.3 block D until the last wave-3 plan and the plugin migration delete its importers. The plan is written for the second; step 204.14 executes the first on a "delete now" answer. Decider: CTO.
2. **Q2, the plugin views.** `plugins/proxy-manager/src/ui/` (7 files) and `plugins/mikrotik-routing/src/ui/` (5 files) name the prototype tokens and `TabsList variant="line"`. No plan in plan 200 §4 owns re-authoring them to the handoff tokens, and CLAUDE.md's seeding rule means each needs a version bump when it happens. Which plan, and whether it lands before or after wave 3's gate (plan 200 §6 runs the union of §10 greps at a gate, and block D's removal cannot pass that gate while these files exist). Decider: CTO.
3. **Q3, the `destructive` button.** The handoff paints danger only as text (the Forget and Remove rows). This plan chose a soft fill (`bg-danger-soft text-danger`) so no filled red button exists. If a filled red confirm is wanted for `ConfirmDialog`'s delete action, say so and step 204.6's row changes to `bg-danger text-on-accent`. Decider: CEO (a design call).

## 10. Removed

### 10.1 Removed by this plan

| What | Where it was | Proof |
|---|---|---|
| `next/font/google` fonts (Outfit, IBM Plex Mono) | `packages/studio/src/app/fonts.ts`, `layout.tsx:4,14` | `test ! -e packages/studio/src/app/fonts.ts` → exit 0; §7.1 GREP-FONTS → empty |
| `lucide-react` in `@enkaku/ui` | `packages/ui/package.json:19`, 10 component files | §7.1 GREP-LUCIDE-UI → empty (covers both) |
| `next-themes` | `packages/ui/package.json:20`, `sonner.tsx:10` | §7.1 GREP-LUCIDE-UI → empty |
| `ScrollArea`, `ScrollBar` | `packages/ui/src/components/scroll-area.tsx`, `index.ts:41` | `test ! -e packages/ui/src/components/scroll-area.tsx` → exit 0; §7.1 GREP-SCROLL → empty |
| `components.json` (shadcn resync config) | `packages/ui/components.json` | `test ! -e packages/ui/components.json` → exit 0; §7.1 GREP-COMPONENTS-JSON → empty |
| `--color-destructive-foreground` (MVP 13 B.2) | `packages/ui/src/theme.css:138` | `rg -n "destructive-foreground" packages plugins` → empty |
| `--radius-card: 0.5rem` (MVP 13 B.2; the name is reused at 14 px) | `theme.css:109` | `rg -n "radius-card: 0.5rem" packages` → empty |
| The old `--color-accent` (blue) and `--color-line` | `theme.css:82,70` | §7.1 GREP-OLD-ACCENT → empty |
| The old `--font-sans`/`--font-mono` referencing next/font variables | `theme.css:106-107` | §7.1 GREP-OLD-FONT-VARS → empty |
| Shadcn names with no user outside `packages/ui`: `--color-background`, `--color-card-foreground`, `--color-popover-foreground`, `--color-primary-foreground`, `--color-secondary`, `--color-secondary-foreground`, `--color-muted` (old), `--color-accent-foreground`, `--color-border` (old), `--radius` | `theme.css:119-144` | §7.1 GREP-SHADCN-DEAD-USES → empty; §7.1 GREP-SHADCN-DEAD-DEFS → empty |
| `dark:` variants in `@enkaku/ui` | 9 component files (§3.1) | §7.1 GREP-DARK → empty |
| `Switch` `size` prop | `switch.tsx:10-13`, four Studio call sites | `rg -n "<Switch[^>]*size=" packages plugins` → empty |
| `Button` sizes `xs`, `icon-xs`, `lg` | `button.tsx:25,27,29` | §7.1 GREP-BUTTON-SIZES → empty |
| "lucide" wording in the protocol | `plugin-surface.ts:88-89,141` | `rg -n "lucide" packages/protocol/src --glob '!**/*.test.ts'` → empty |
| `docs/design.md` prototype token sections (Outfit, Plex, OKLCH, `refs/ui`) | `docs/design.md:1-89` | §7.1 GREP-DESIGN-HEAD → empty |
| Vocabulary check for this plan's new files (plan 200 §2.4) | `palette.css`, `theme.css`, `icons.ts`, `lib/theme.ts`, `checkbox.tsx`, `status-dot.tsx`, `avatar.tsx` | §7.1 GREP-VOCAB → empty |

### 10.2 Deletions this plan owes to a later one (not proofs; owners)

| What | Last importer today | Deleted by |
|---|---|---|
| `theme.css` block D (prototype `--color-*`, retained shadcn names, `--radius-sm/md/lg/xl`) | 168 Studio files, 12 plugin files | the last of plans 213–220 to delete an importer, plus §9 Q2's plugin plan; or step 204.14 on §9 Q1 |
| `lucide-react` in `packages/studio/package.json` | 106 Studio files, `AppShell.tsx` among them | plan 220 (last: `components/agent`, `components/ai-elements`) |
| `Card` | `plugins/mikrotik-routing/src/ui/parts/settings.tsx` | §9 Q2's plugin plan |
| `HoverCard`, `ButtonGroup`, `InputGroupTextarea` | `components/ai-elements/{prompt-input,message}.tsx` | plan 220 |
| `Command*` | `components/agent/ModelCombobox.tsx`, `components/ai-elements/prompt-input.tsx` (and `combobox.tsx` internally, which stays) | plan 220 |
| `Slider`, `InputGroup*` | `components/schema-form/controls/{ChanceControl,NumberField}.tsx` | plan 219 (the schema form's Settings caller) |
| `Collapsible*` | 7 Studio files | the last of plans 214–219 |
| `Select*` | 36 files | the last of plans 214–219 |
| `TabsList variant="line"` | 2 plugin views | §9 Q2's plugin plan |
| `Progress`, `Separator`, `Textarea` | 8, 1 (internal `button-group.tsx`), 16 files | reviewed by plan 219; the handoff draws a progress bar and needs a textarea for the Adb command dialog, so these may stay |

## 11. Handoff report

- **Checklist**:
- **Commits**:
- **Typecheck**:
- **Tests run**:
- **Removed, proven**:
- **Discrepancies between plan and code**:
- **Observed, not done**:
- **Open questions hit**:
- **Processes**:
