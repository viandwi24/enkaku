#!/usr/bin/env bun
/**
 * check-design-tokens.ts — plan 204 (MVP wave 0) §12 amendment.
 *
 * `@enkaku/ui` and Studio have zero tests (plan 200 §8.3, 2026-09-03). Plan
 * 204's own §4.8 originally specified five `*.test.ts(x)` files
 * (`packages/ui/src/tokens.test.ts`, `icons.test.ts`, `lib/theme.test.ts`,
 * `components/skin.test.tsx`, and edits to `index.test.ts`) plus reliance on
 * `packages/studio/src/lib/plugin-icons.test.ts` and
 * `packages/studio/src/design-rules.test.ts`. The §12 amendment overrides all
 * of that: this script performs the same checks — with plain assertions and
 * a non-zero exit on failure — reading files and importing modules directly,
 * never rendering anything and never importing a DOM. It is this plan's
 * `Ships:` artefact.
 *
 * What it checks, in order:
 *   1. `packages/ui/src/palette.css` — the handoff's 36 tokens, exact hex,
 *      under all three selectors (`:root`, the system-dark media block, and
 *      `:root[data-theme="dark"]`), and that the two dark blocks agree.
 *   2. `packages/ui/src/theme.css` — every token mapped through `@theme
 *      inline`, the font mapping, the 10 radii, 8 shadows, 10 text sizes, the
 *      2 animations (and exactly 2 `@keyframes`), and that the file holds
 *      only `@theme` blocks and one `@custom-variant` (no bare `:root`, no
 *      `@layer`, no `@import` — required for a plugin's `theme(reference)`
 *      import to compile it at all, plan 204 §3.4).
 *   3. `packages/ui/src/icons.ts` — the 53 `ph-*` names the design handoff
 *      README uses (derived from the README itself, so a name added to the
 *      design and not here fails this script) plus the 9 primitive-only
 *      names, all 62 actually exported as components.
 *   4. `packages/ui/src/index.ts` — the barrel keeps the plugin-facing
 *      surface `index.test.ts`'s REQUIRED list pinned, plus this plan's
 *      additions (G9): `Checkbox`, `StatusDot`, `Avatar`, `resolveTheme`,
 *      `useResolvedTheme`, `DevicesIcon`.
 *   5. The plugin icon allowlist (`packages/studio/src/lib/plugin-icons.ts`)
 *      — every `ICON_NAMES` id resolves to a real component, and an unknown,
 *      empty, absent, or prototype-key name falls back rather than throwing
 *      (the same behaviour `plugin-icons.test.ts` asserted).
 *   6. `resolveTheme()` (`packages/ui/src/lib/theme.ts`) — an explicit
 *      `data-theme` wins over the system preference, an unknown value falls
 *      back to light, and with no attribute the system preference decides.
 *      Plain function mocks (a fake `getAttribute`, a stubbed
 *      `window.matchMedia`), never a DOM library.
 *   7. Design rules across `packages/ui/src`: no `dark:` variant, no shadcn
 *      bridge-name utility class, no Tailwind v3 bracket colour form
 *      (`[--color-…]`), no hex colour literal in a `.ts`/`.tsx` file.
 *   8. The two removed-file proofs: `scroll-area.tsx` is gone and nothing
 *      under `packages`, `plugins`, `examples` still names `ScrollArea`.
 *
 * Usage: bun run scripts/check-design-tokens.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const UI_SRC = join(ROOT, 'packages/ui/src')
const PALETTE_PATH = join(UI_SRC, 'palette.css')
const THEME_PATH = join(UI_SRC, 'theme.css')
const ICONS_PATH = join(UI_SRC, 'icons.ts')
const README_PATH = join(ROOT, 'docs/mvp/design_handoff_enkaku_openpf/README.md')

let failures = 0
function fail(message: string): void {
  failures++
  console.error(`FAIL: ${message}`)
}
function ok(message: string): void {
  console.log(`  ok  ${message}`)
}

// ---------------------------------------------------------------------------
// 1 & 2. palette.css and theme.css
// ---------------------------------------------------------------------------

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

function checkPaletteAndTheme(): void {
  console.log('\n== palette.css & theme.css (G1, G2, G14) ==')
  if (!existsSync(PALETTE_PATH)) return fail(`missing ${relative(ROOT, PALETTE_PATH)}`)
  if (!existsSync(THEME_PATH)) return fail(`missing ${relative(ROOT, THEME_PATH)}`)
  const palette = readFileSync(PALETTE_PATH, 'utf8')
  const theme = readFileSync(THEME_PATH, 'utf8')

  if (NAMES.length !== 36) fail(`internal: expected 36 handoff tokens, transcribed ${NAMES.length}`)

  let light: string, systemDark: string, explicitDark: string
  try {
    light = block(palette, ':root {')
    systemDark = block(block(palette, '@media (prefers-color-scheme: dark)'), ':root:not([data-theme="light"])')
    explicitDark = block(palette, ':root[data-theme="dark"]')
  } catch (e) {
    fail(`palette.css: ${(e as Error).message}`)
    return
  }

  const declared = [...light.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]!).filter((n) => !n.startsWith('font-'))
  if (JSON.stringify([...declared].sort()) !== JSON.stringify([...NAMES].sort())) {
    fail(`palette.css :root does not declare exactly the 36 handoff tokens (got ${declared.length}: ${declared.sort().join(', ')})`)
  } else {
    ok('palette.css :root declares exactly the 36 handoff tokens')
  }

  let mismatches = 0
  for (const name of NAMES) {
    const [l, d] = TOKENS[name]!
    if (!light.includes(`--${name}: ${l};`)) {
      fail(`palette.css :root --${name} is not ${l}`)
      mismatches++
    }
    if (!systemDark.includes(`--${name}: ${d};`)) {
      fail(`palette.css system-dark block --${name} is not ${d}`)
      mismatches++
    }
    if (!explicitDark.includes(`--${name}: ${d};`)) {
      fail(`palette.css [data-theme="dark"] --${name} is not ${d}`)
      mismatches++
    }
  }
  if (mismatches === 0) ok('all 36 tokens match the handoff table in light and both dark selectors')

  if (systemDark.trim().replace(/\s+/g, ' ') !== explicitDark.trim().replace(/\s+/g, ' ')) {
    fail('palette.css: the system-dark and explicit-dark blocks are not byte-identical')
  } else {
    ok('the two dark blocks agree')
  }

  if (!light.includes("--font-ui: 'Geist Variable',")) fail("palette.css: missing --font-ui: 'Geist Variable'")
  if (!light.includes("--font-code: 'Geist Mono Variable',")) fail("palette.css: missing --font-code: 'Geist Mono Variable'")
  if (palette.includes('@theme')) fail('palette.css contains @theme — it must be plain rules only (plan 204 §3.4)')
  if (palette.includes('@import')) fail('palette.css contains @import')
  if (!palette.includes('@theme') && !palette.includes('@import')) ok('palette.css is plain rules only')

  // theme.css
  let inline: string
  try {
    // Anchored on the brace, not just the phrase: this file's own header
    // comment says "`@theme inline` makes `bg-panel` compile to..." before
    // the real block, and a bare phrase match would grab block A instead.
    inline = block(theme, '@theme inline {')
  } catch (e) {
    fail(`theme.css: ${(e as Error).message}`)
    return
  }
  let colorMapMismatches = 0
  for (const name of NAMES) {
    if (!inline.includes(`--color-${name}: var(--${name});`)) {
      fail(`theme.css @theme inline does not map --color-${name} onto var(--${name})`)
      colorMapMismatches++
    }
  }
  if (colorMapMismatches === 0) ok('theme.css maps all 36 --color-* names onto palette.css values')

  if (!inline.includes('--font-sans: var(--font-ui);')) fail('theme.css: missing --font-sans: var(--font-ui)')
  if (!inline.includes('--font-mono: var(--font-code);')) fail('theme.css: missing --font-mono: var(--font-code)')

  const RADII: Array<[string, string]> = [
    ['panel', '16px'], ['window', '18px'], ['card', '14px'], ['inner', '12px'], ['button', '10px'],
    ['input', '9px'], ['small', '8px'], ['chip', '7px'], ['check', '5px'], ['pill', '999px'],
  ]
  let radiusMismatches = 0
  for (const [name, px] of RADII) {
    if (!theme.includes(`--radius-${name}: ${px};`)) {
      fail(`theme.css: missing --radius-${name}: ${px}`)
      radiusMismatches++
    }
  }
  if (radiusMismatches === 0) ok('all 10 radii are present')

  const SHADOWS: Array<[string, string]> = [
    ['active-pill', '0 1px 3px #00000014'], ['cast', '0 8px 24px #00000014'], ['bulk-pill', '0 10px 24px var(--accent-a3)'],
    ['popover', '0 16px 40px #0000001f'], ['menu', '0 20px 50px #00000024'], ['window', '0 30px 80px #00000033'],
    ['selected-row', 'inset 2px 0 0 var(--accent)'], ['dot-ring', '0 0 0 3px var(--panel-a)'],
  ]
  let shadowMismatches = 0
  for (const [name, value] of SHADOWS) {
    if (!inline.includes(`--shadow-${name}: ${value};`)) {
      fail(`theme.css: missing --shadow-${name}: ${value}`)
      shadowMismatches++
    }
  }
  if (shadowMismatches === 0) ok('all 8 shadows are present')

  const TEXT_SIZES: Array<[string, string]> = [
    ['section', '19px'], ['sheet', '16px'], ['title', '15px'], ['name', '14px'], ['row', '13px'],
    ['body', '12.5px'], ['meta', '11.5px'], ['label', '11px'], ['badge', '10.5px'], ['tip', '10px'],
  ]
  let textMismatches = 0
  for (const [name, px] of TEXT_SIZES) {
    if (!theme.includes(`--text-${name}: ${px};`)) {
      fail(`theme.css: missing --text-${name}: ${px}`)
      textMismatches++
    }
  }
  if (textMismatches === 0) ok('all 10 type-scale steps are present')

  if (!theme.includes('--animate-enkaku-pulse: enkaku-pulse 2.6s ease-in-out infinite;')) fail('theme.css: missing --animate-enkaku-pulse')
  if (!theme.includes('--animate-enkaku-spin: enkaku-spin 0.9s linear infinite;')) fail('theme.css: missing --animate-enkaku-spin')
  const keyframeCount = (theme.match(/@keyframes/g) ?? []).length
  if (keyframeCount !== 2) fail(`theme.css: expected exactly 2 @keyframes, found ${keyframeCount}`)
  else ok('exactly 2 animations, 2 @keyframes')

  if (!theme.includes('@custom-variant hover-none (@media (hover: none));')) fail('theme.css: missing @custom-variant hover-none')
  if (/^\s*:root/m.test(theme)) fail('theme.css contains a bare :root rule — breaks a plugin\'s theme(reference) import (plan 204 §3.4)')
  if (theme.includes('@layer')) fail('theme.css contains @layer — breaks a plugin\'s theme(reference) import')
  if (theme.includes('@import')) fail('theme.css contains @import — breaks a plugin\'s theme(reference) import')
  if (!/^\s*:root/m.test(theme) && !theme.includes('@layer') && !theme.includes('@import')) {
    ok('theme.css is @theme blocks and one @custom-variant only')
  }

  // G14 / block D: the prototype vocabulary, still present pending owner
  // decision on §9 Q1 — this script does not decide it, only reports.
  const oklchCount = (theme.match(/oklch\(/g) ?? []).length
  console.log(`  note  theme.css still carries ${oklchCount} oklch(...) prototype values (block D, plan 204 §3.5/§9 Q1 — not a failure)`)
}

// ---------------------------------------------------------------------------
// 3. icons.ts
// ---------------------------------------------------------------------------

/** `'ph-arrows-clockwise'` → `'ArrowsClockwiseIcon'` — the `ph-` prefix names the Phosphor family, not part of the component name. */
function toPascalIconName(kebab: string): string {
  const withoutPrefix = kebab.replace(/^ph-/, '')
  return withoutPrefix.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('') + 'Icon'
}

const GROUP_2 = ['CaretRightIcon', 'CaretUpIcon', 'CaretUpDownIcon', 'CheckCircleIcon', 'CircleNotchIcon', 'InfoIcon', 'TrayIcon', 'WarningIcon', 'XCircleIcon']
/**
 * Group 3 (plan 213 §3.4): names added after the handoff was drawn, for a
 * screen the handoff itself does not draw. `RobotIcon` is the Agents rail
 * entry; `ClockIcon` is the Schedules tab (MVP 15 §0.1.1, plan 217 §4.12 —
 * the §12 amendment there anticipates exactly this widening). This script's
 * own count check below is updated alongside it — plan 213 found this check
 * asserts an EXACT total (53 + 9), not merely presence as its own §3.4
 * assumed, so adding a name here requires widening the total by the same
 * amount or this script fails on the addition it was meant to tolerate.
 */
const GROUP_3 = [
  'ArrowsLeftRightIcon',
  'ClockIcon',
  // The Devices toolbar's overflow button. The handoff's own glyph is the
  // horizontal `DotsThreeIcon` (group 1); every other overflow control in the
  // product is the vertical kebab, so the toolbar matches them.
  'DotsThreeVerticalIcon',
  'CopyIcon',
  'DeviceMobileIcon',
  'ExportIcon',
  'PauseIcon',
  'RobotIcon',
  // Plan 220 (Agents page) — the agent subsystem's own lucide-react replacements.
  'ArrowCounterClockwiseIcon',
  'ArrowDownIcon',
  'ArrowSquareOutIcon',
  'BrainIcon',
  'EyeSlashIcon',
  'FloppyDiskIcon',
  'ImageBrokenIcon',
  'PaperPlaneRightIcon',
  'PaperclipIcon',
  'RocketIcon',
]

async function checkIcons(): Promise<void> {
  console.log('\n== icons.ts (G4) ==')
  if (!existsSync(README_PATH)) return fail(`missing ${relative(ROOT, README_PATH)}`)
  if (!existsSync(ICONS_PATH)) return fail(`missing ${relative(ROOT, ICONS_PATH)}`)

  const readme = readFileSync(README_PATH, 'utf8')
  const handoffNames = [...new Set(readme.match(/ph-[a-z-]+/g) ?? [])]
  if (handoffNames.length !== 53) fail(`design handoff README: expected 53 distinct ph-* names, found ${handoffNames.length}`)
  else ok('the design handoff README names exactly 53 ph-* icons')

  const expected = [...handoffNames.map(toPascalIconName), ...GROUP_2, ...GROUP_3].sort()

  let icons: Record<string, unknown>
  try {
    icons = (await import(ICONS_PATH)) as Record<string, unknown>
  } catch (e) {
    fail(`icons.ts failed to import: ${(e as Error).message}`)
    return
  }

  let missing = 0
  for (const name of expected) {
    const value = icons[name]
    const isComponent = typeof value === 'function' || (typeof value === 'object' && value !== null && 'render' in (value as object))
    if (!isComponent) {
      fail(`icons.ts does not export a component named ${name}`)
      missing++
    }
  }
  if (missing === 0) ok(`all ${expected.length} expected icon names (53 handoff + 9 primitive + ${GROUP_3.length} group 3) are exported as components`)

  const exportedIconNames = Object.keys(icons).filter((k) => k.endsWith('Icon') && k !== 'IconProps')
  const expectedTotal = 62 + GROUP_3.length
  if (exportedIconNames.length !== expectedTotal) {
    fail(`icons.ts: expected exactly ${expectedTotal} icon exports (53 + 9 + ${GROUP_3.length} group 3), found ${exportedIconNames.length}`)
  } else {
    ok(`icons.ts exports exactly ${expectedTotal} icon components — nothing extra`)
  }
}

// ---------------------------------------------------------------------------
// 4. index.ts barrel (G9)
// ---------------------------------------------------------------------------

/** `index.test.ts`'s REQUIRED list, plus this plan's G9 additions. */
const REQUIRED_BARREL = [
  'EmptyState', 'ErrorState', 'LoadingRows', 'ConfirmDialog',
  // `setCoreBase` was in plan 204's required list and was deleted by plan 201
  // as a zero-reference export in the same round. Both were right alone; only
  // the combination demanded an export that correctly no longer exists.
  // Removed at the R1/R3 gate (plan 200 §8.5).
  'api', 'useAction', 'coreBase', 'describeApiError', 'issuesFromError', 'BadResponseError', 'z',
  'relativeTime', 'duration', 'fileSize', 'formatFieldValue', 'formatTokens', 'formatUsd', 'cn',
  'formatDeviceName', 'deviceSearchTerms', 'matchesDeviceQuery', 'DeviceName', 'Combobox',
  // plan 204 G9
  'Checkbox', 'StatusDot', 'Avatar', 'resolveTheme', 'useResolvedTheme', 'DevicesIcon',
]

async function checkBarrel(): Promise<void> {
  console.log('\n== index.ts barrel (G9) ==')
  const indexPath = join(UI_SRC, 'index.ts')
  if (!existsSync(indexPath)) return fail(`missing ${relative(ROOT, indexPath)}`)
  let ui: Record<string, unknown>
  try {
    ui = (await import(indexPath)) as Record<string, unknown>
  } catch (e) {
    fail(`index.ts failed to import: ${(e as Error).message}`)
    return
  }
  let missing = 0
  for (const name of REQUIRED_BARREL) {
    if (!(name in ui) || ui[name] === undefined) {
      fail(`@enkaku/ui barrel does not export \`${name}\``)
      missing++
    }
  }
  if (missing === 0) ok(`all ${REQUIRED_BARREL.length} required barrel exports are present`)
}

// ---------------------------------------------------------------------------
// 5. Plugin icon allowlist (G5)
// ---------------------------------------------------------------------------

async function checkPluginIcons(): Promise<void> {
  console.log('\n== plugin icon allowlist (G5) ==')
  const pluginIconsPath = join(ROOT, 'packages/studio/src/lib/plugin-icons.ts')
  const protocolPath = join(ROOT, 'packages/protocol/src/plugin-surface.ts')
  if (!existsSync(pluginIconsPath)) return fail(`missing ${relative(ROOT, pluginIconsPath)}`)

  let mod: { PLUGIN_ICONS: Record<string, unknown>; FALLBACK_PLUGIN_ICON: unknown; pluginIcon(name: string | null | undefined): unknown }
  let protocolMod: { ICON_NAMES: readonly string[] }
  try {
    mod = (await import(pluginIconsPath)) as typeof mod
    protocolMod = (await import(protocolPath)) as typeof protocolMod
  } catch (e) {
    fail(`plugin-icons.ts / plugin-surface.ts failed to import: ${(e as Error).message}`)
    return
  }

  const { PLUGIN_ICONS, FALLBACK_PLUGIN_ICON, pluginIcon } = mod
  const { ICON_NAMES } = protocolMod

  const missing = ICON_NAMES.filter((name) => !PLUGIN_ICONS[name])
  if (missing.length > 0) fail(`plugin-icons.ts: ICON_NAMES not mapped: ${missing.join(', ')}`)
  else ok(`all ${ICON_NAMES.length} ICON_NAMES ids resolve to a component`)

  let wrong = 0
  for (const name of ICON_NAMES) {
    if (pluginIcon(name) !== PLUGIN_ICONS[name]) {
      fail(`plugin-icons.ts: pluginIcon(${JSON.stringify(name)}) does not match PLUGIN_ICONS`)
      wrong++
    }
  }
  if (wrong === 0) ok('pluginIcon() resolves every id to its mapped component')

  const fallbackCases: Array<string | null | undefined> = ['not-a-real-icon', '', undefined, null, 'constructor', '__proto__']
  let fallbackFailures = 0
  for (const c of fallbackCases) {
    if (pluginIcon(c) !== FALLBACK_PLUGIN_ICON) {
      fail(`plugin-icons.ts: pluginIcon(${JSON.stringify(c)}) did not fall back`)
      fallbackFailures++
    }
  }
  if (fallbackFailures === 0) ok('unknown, empty, absent, and prototype-key names all fall back')
}

// ---------------------------------------------------------------------------
// 5b. resolveTheme() logic (G11) — plain function mocks, no DOM library
// ---------------------------------------------------------------------------

/** Minimal stand-in for the one method `resolveTheme()` reads off `root`. */
function fakeElement(dataTheme: string | null): HTMLElement {
  return { getAttribute: (name: string) => (name === 'data-theme' ? dataTheme : null) } as unknown as HTMLElement
}

async function checkThemeResolution(): Promise<void> {
  console.log('\n== resolveTheme() (G11) ==')
  const themePath = join(UI_SRC, 'lib/theme.ts')
  if (!existsSync(themePath)) return fail(`missing ${relative(ROOT, themePath)}`)

  let mod: { resolveTheme(root?: HTMLElement | null): string }
  try {
    mod = (await import(themePath)) as typeof mod
  } catch (e) {
    fail(`lib/theme.ts failed to import: ${(e as Error).message}`)
    return
  }
  const { resolveTheme } = mod

  let problems = 0
  if (resolveTheme(fakeElement('dark')) !== 'dark') {
    fail('resolveTheme(): explicit data-theme="dark" did not resolve to "dark"')
    problems++
  }
  if (resolveTheme(fakeElement('light')) !== 'light') {
    fail('resolveTheme(): explicit data-theme="light" did not resolve to "light"')
    problems++
  }
  // No `window` global here (a script, not a browser) — no attribute and no
  // matchMedia falls through to the documented 'light' default.
  if (resolveTheme(fakeElement(null)) !== 'light') {
    fail('resolveTheme(): no attribute and no window.matchMedia did not fall back to "light"')
    problems++
  }
  if (resolveTheme(fakeElement('blue')) !== 'light') {
    fail('resolveTheme(): an unknown data-theme value did not fall back to "light"')
    problems++
  }
  if (resolveTheme(null) !== 'light') {
    fail('resolveTheme(null): with no root and no window.matchMedia should be "light"')
    problems++
  }

  // The explicit attribute must win even when the system reports dark —
  // stub `window.matchMedia` (a plain function mock, not a DOM library) to
  // prove the precedence, then restore it.
  const original = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { matchMedia: (_q: string) => ({ matches: true }) }
  try {
    if (resolveTheme(fakeElement('light')) !== 'light') {
      fail('resolveTheme(): explicit data-theme="light" lost to a dark system preference')
      problems++
    }
    if (resolveTheme(fakeElement(null)) !== 'dark') {
      fail('resolveTheme(): with no attribute, a dark system preference did not resolve to "dark"')
      problems++
    }
  } finally {
    if (original === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = original
  }

  if (problems === 0) ok('an explicit data-theme wins; with none, the system preference decides; unknown values fall back to light')
}

// ---------------------------------------------------------------------------
// 6. Design rules across packages/ui/src (G6, G8)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next'])

function collectFiles(dir: string, predicate: (name: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...collectFiles(full, predicate))
    else if (predicate(entry)) out.push(full)
  }
  return out
}

const SHADCN_PATTERN = /(bg|text|border|ring|fill|placeholder|selection)-(background|foreground|primary|primary-foreground|secondary|secondary-foreground|popover|popover-foreground|card|card-foreground|muted-foreground|destructive|input|ring)\b/

function checkDesignRules(): void {
  console.log('\n== design rules across packages/ui/src (G6, G8) ==')
  const sourceFiles = collectFiles(UI_SRC, (n) => /\.tsx?$/.test(n) && !n.endsWith('.test.ts') && !n.endsWith('.test.tsx'))
  const cssFiles = collectFiles(UI_SRC, (n) => n.endsWith('.css'))

  let darkOffenders = 0
  for (const f of sourceFiles) {
    if (/\bdark:/.test(readFileSync(f, 'utf8'))) {
      fail(`dark: variant found in ${relative(ROOT, f)}`)
      darkOffenders++
    }
  }
  if (darkOffenders === 0) ok('no dark: variant anywhere in packages/ui/src')

  let bracketOffenders = 0
  for (const f of sourceFiles) {
    if (/\[--color-/.test(readFileSync(f, 'utf8'))) {
      fail(`Tailwind v3 bracket colour form found in ${relative(ROOT, f)}`)
      bracketOffenders++
    }
  }
  if (bracketOffenders === 0) ok('no Tailwind v3 bracket colour form ([--color-...]) in packages/ui/src')

  let hexOffenders = 0
  for (const f of sourceFiles) {
    if (/#[0-9a-fA-F]{3,8}\b/.test(readFileSync(f, 'utf8'))) {
      fail(`hex colour literal found in ${relative(ROOT, f)}`)
      hexOffenders++
    }
  }
  if (hexOffenders === 0) ok('no hex colour literal in any packages/ui/src .ts/.tsx file')

  const componentFiles = collectFiles(join(UI_SRC, 'components'), (n) => /\.tsx?$/.test(n))
  let shadcnOffenders = 0
  for (const f of componentFiles) {
    if (SHADCN_PATTERN.test(readFileSync(f, 'utf8'))) {
      fail(`shadcn bridge-name utility class found in ${relative(ROOT, f)}`)
      shadcnOffenders++
    }
  }
  if (shadcnOffenders === 0) ok('no shadcn bridge-name utility class in packages/ui/src/components')

  void cssFiles // .css is never scanned for hex/dark:/bracket-form — palette.css legitimately holds hex values.
}

// ---------------------------------------------------------------------------
// 7. Removed files (G10)
// ---------------------------------------------------------------------------

function checkRemoved(): void {
  console.log('\n== removed files (G10) ==')
  const scrollAreaPath = join(UI_SRC, 'components/scroll-area.tsx')
  if (existsSync(scrollAreaPath)) fail(`${relative(ROOT, scrollAreaPath)} still exists — it has zero importers (plan 204 G10)`)
  else ok('scroll-area.tsx is gone')

  const componentsJsonPath = join(ROOT, 'packages/ui/components.json')
  if (existsSync(componentsJsonPath)) fail(`${relative(ROOT, componentsJsonPath)} still exists — the shadcn resync config is deleted (plan 204)`)
  else ok('the shadcn resync config is gone')

  const roots = ['packages', 'plugins', 'examples']
  let scrollOffenders = 0
  for (const r of roots) {
    const dir = join(ROOT, r)
    if (!existsSync(dir)) continue
    const files = collectFiles(dir, (n) => /\.tsx?$/.test(n))
    for (const f of files) {
      if (/ScrollArea|scroll-area/.test(readFileSync(f, 'utf8'))) {
        fail(`ScrollArea/scroll-area referenced in ${relative(ROOT, f)}`)
        scrollOffenders++
      }
    }
  }
  if (scrollOffenders === 0) ok('nothing under packages, plugins, examples names ScrollArea')
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  checkPaletteAndTheme()
  await checkIcons()
  await checkBarrel()
  await checkPluginIcons()
  await checkThemeResolution()
  checkDesignRules()
  checkRemoved()

  console.log('')
  if (failures > 0) {
    console.error(`design tokens FAILED — ${failures} problem(s) above.`)
    process.exit(1)
  }
  console.log('design tokens ok')
  process.exit(0)
}

if (import.meta.main) main()
