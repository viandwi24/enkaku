/**
 * `@enkaku/ui` — Studio's component library, extracted so that a plugin can
 * import the same components Studio itself renders (plan 111 §3.3).
 *
 * **One flat entry point, deliberately.** A plugin author writes
 * `import { Tabs, Button } from '@enkaku/ui'` and nothing else; there are no
 * subpath exports, so no import path here can become a compatibility surface
 * we did not intend to keep. `package.json` declares exactly one export (`.`),
 * and this file is it.
 *
 * **These components are not frozen.** They are Studio's own, they change when
 * Studio changes, and plan 111 §3.5 handles that with a checked
 * `surface.ui.apiVersion` rather than by pretending otherwise.
 *
 * The per-file `export *` is the whole surface by construction: adding a
 * component is one line here, and no name can be silently dropped from the
 * package while its file still exports it. The modules have no colliding
 * export names (checked at extraction time, and re-checked whenever one is
 * added), which is what makes the flat re-export safe.
 */

export * from './components/alert-dialog'
export * from './components/avatar'
export * from './components/badge'
export * from './components/button'
export * from './components/button-group'
export * from './components/card'
export * from './components/checkbox'
export * from './components/collapsible'
export * from './components/combobox'
export * from './components/confirm-dialog'
export * from './components/command'
export * from './components/device-name'
export * from './components/device-picker'
export * from './components/dialog'
export * from './components/dropdown-menu'
export * from './components/hover-card'
export * from './components/input'
export * from './components/input-group'
export * from './components/label'
export * from './components/popover'
export * from './components/progress'
export * from './components/select'
export * from './components/separator'
export * from './components/sheet'
export * from './components/skeleton'
export * from './components/slider'
export * from './components/sonner'
export * from './components/spinner'
export * from './components/states'
export * from './components/status-dot'
export * from './components/switch'
export * from './components/table'
export * from './components/tabs'
export * from './components/textarea'
export * from './components/tooltip'

/**
 * `cn` — the one Studio-internal helper the components depended on, moved with
 * them (plan 111 §3.3). Exported because every component here takes a
 * `className` and merging Tailwind classes correctly is not something a caller
 * should re-derive.
 */
export { cn } from './lib/utils'

/**
 * ## Beyond the components: the behaviour layer
 *
 * §3.3 promised these and 111.1 did not ship them, so the first tier-C pack
 * hand-wrote a `fetch` helper and its own three state panels. They are here
 * now, and they are Studio's own — the SAME modules Studio's screens import,
 * not a parallel set:
 *
 * - `coreBase` — where the farm is. The one question Studio
 *   could answer privately and a plugin could not (111.7's finding 4).
 * - `api` — a `fetch` with the farm's error envelope unwrapped and the
 *   response validated against a Zod schema, plus `describeApiError`,
 *   `issuesFromError`, `BadResponseError` and the `ApiError` shape.
 * - `useAction` — pending state and a toast per action key.
 * - `relativeTime`, `duration`, `fileSize`, `formatFieldValue`,
 *   `formatTokens`, `formatUsd` — so a time on a plugin's screen reads the
 *   way every other time in the farm reads.
 *
 * What is deliberately NOT here, and why, is recorded in plan 111 §3.3:
 * `PageHeader` (the host already draws one above every plugin view — a second
 * sticky bar is a bug, and §2 forbids a plugin touching Studio's chrome) and
 * `PaginatedTable` (its envelope is the core's own keyset contract from plan
 * 30, which a plugin's routes are under no obligation to return).
 */
export * from './lib/actions'
export * from './lib/core-base'
export * from './lib/format'

/**
 * Naming a device, and finding one (plan 124 §4.1, §1 goals 1–3).
 *
 * `formatDeviceName` / `<DeviceName>` are the ONLY way any surface — Studio's
 * or a plugin's — composes `#7 Galaxy A15`, and `matchesDeviceQuery` is the
 * only definition of what a device search box matches. They are here rather
 * than in `packages/studio/src/lib` for the reason that governs this whole
 * package: a plugin can reach `@enkaku/ui` and nothing else, and the Mikrotik
 * and Proxy Manager tabs name devices too.
 */
export * from './lib/device-name'

/**
 * Which palette the document is showing, and the icon set (plan 204 §4.5,
 * §4.5). `resolveTheme`/`useResolvedTheme` are the same rule `palette.css`'s
 * three selectors implement in CSS; the icons are Phosphor's `*Icon` names
 * re-exported so a plugin reaches them through `@enkaku/ui` rather than
 * bundling its own copy.
 */
export * from './lib/theme'
export * from './icons'

/**
 * `z` — Zod itself, re-exported as one name.
 *
 * `api()` takes a schema as a REQUIRED argument (plan 72 §3.3), so a plugin
 * that cannot reach Zod cannot use `api()` at all — and reaching it through
 * its own `package.json` would bundle a SECOND copy of Zod into every plugin,
 * because `zod` is not in `UI_EXTERNALS` and never should be for a plugin
 * that genuinely wants its own. This is the host's copy, the same one `api()`
 * validates with, and it costs a plugin nothing: `@enkaku/ui` is external at
 * runtime, so `import { z } from '@enkaku/ui'` resolves to what Studio has
 * already loaded.
 *
 * One name, not `export *`: Zod's own barrel is hundreds of exports and would
 * turn every one of them into part of this package's surface.
 */
export { z } from 'zod'

/**
 * The props Studio hands a plugin's view component (plan 111 §9 Q2). Defined
 * in `@enkaku/protocol` — types only, no React, no runtime — and re-exported
 * here because `@enkaku/ui` is what a React plugin already depends on, while
 * `@enkaku/protocol` may not be installed in its project at all.
 *
 * `packages/studio/src/lib/plugin-host.ts` imports the same three names, so
 * there is exactly one definition and an author's `enkaku-host.d.ts` cannot
 * drift from the host: it fails to compile instead.
 */
export type { PluginViewParams, PluginViewProps, SetPluginViewParams } from '@enkaku/protocol'
