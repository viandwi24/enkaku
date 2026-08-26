import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { UiAsset } from './enkaku-package'

/**
 * Builds a plugin's React half (plan 111 §4.4, §5 step 111.6) into the `ui/`
 * payload of a `.enkaku` package.
 *
 * ## The convention
 *
 * A `ui/` directory **beside the plugin entry** — `src/ui/` for the scaffold's
 * `src/index.ts`. Every top-level `.tsx`/`.ts`/`.jsx` file in it is a build
 * ENTRY and becomes `ui/<name>.js` in the package, which is exactly what a
 * view's `react.entry` names. A `.css` file **named after an entry** —
 * `index.css` beside `index.tsx` — is that entry's stylesheet and is compiled
 * by Tailwind into `ui/<name>.css` (see "The stylesheet" below). Anything else
 * under it (an image, a font, a nested component file's *non-source* siblings)
 * is copied verbatim; nested `.tsx`/`.ts`/`.jsx` files are NOT copied, because
 * the bundler has already inlined them into the entry that imports them and
 * shipping the source as well would spend an author's `maxUiBytes` on bytes no
 * browser loads.
 *
 * A convention rather than a config key because there is nothing to decide:
 * the farm's package format fixes the destination (`ui/`), the manifest fixes
 * the entry name, and a project with no `ui/` directory publishes exactly as
 * it did before this step.
 *
 * ## Why this shells out to `bun build` instead of calling `Bun.build`
 *
 * **This is the `jsxDEV` trap, and it is the reason this file exists.**
 * Without the production JSX transform, Bun emits
 * `import { jsxDEV } from "react/jsx-dev-runtime"`. Studio's static export is
 * a PRODUCTION React build, which has no `jsxDEV` export at all, so the
 * plugin's module throws `jsxDEV is not a function` the moment it renders —
 * and, being a render-time throw, it takes the page down as a blank screen
 * rather than as a named error.
 *
 * *(measured, Bun 1.3.14)* — `Bun.build({ production: true })` is **not
 * available**: the option is ignored by the JS API, and a `tsconfig.json`
 * carrying `"jsx": "react-jsx"` beside the entry is ignored too. The ONLY
 * thing that flips the transform is the CLI's `--production` flag. So the
 * build runs as a genuine `bun build` subprocess, and
 * `assertProductionJsx` below re-reads the output and refuses anything still
 * naming `react/jsx-dev-runtime` — a belt-and-braces check, because the
 * failure it prevents is invisible until an operator opens the screen.
 *
 * ## Externals
 *
 * React must be the HOST's instance, never a second copy (plan 111 §3.2/T4):
 * two Reacts in one page throw `Invalid hook call`, and a plugin component
 * bundling its own could never render a Studio component. Studio resolves
 * these five specifiers through a runtime import map, so the plugin's build
 * leaves them unresolved.
 *
 * ## The stylesheet (plan 111 §9 Q1, step 111.9)
 *
 * A plugin's markup renders in Studio's own document, so it inherits every
 * Tailwind class Studio happened to compile — and **a class Studio never uses
 * was never generated**. The author's own `flex-col-reverse` is simply absent,
 * with no error anywhere. So a plugin that writes classes of its own has to
 * ship its own compiled stylesheet.
 *
 * The rejected alternative was `@source '../../plugins'` in Studio's CSS: it
 * reaches only packs living in this repo and never a `.enkaku` an operator
 * uploads, which would make an in-repo pack pass while no real plugin can
 * (§9 Q1).
 *
 * **The compiler is the author's, not the SDK's.** `@enkaku/sdk` is published
 * and gets bundled into every plugin's own build; a CSS compiler has no
 * business inside it. `enkaku init` puts `@tailwindcss/cli` and `tailwindcss`
 * in the *scaffolded project's* devDependencies and this file spawns that
 * project's local `node_modules/.bin/tailwindcss`. A project with no
 * stylesheet never needs either.
 *
 * **Two things the emitted CSS must not contain**, both of which break Studio
 * rather than the plugin, and both of which are asserted below:
 *
 * 1. **Preflight.** Tailwind's reset is global. A second copy injected into
 *    Studio's document restyles every screen, not the plugin's corner. So the
 *    stylesheet imports `tailwindcss/utilities`, never `tailwindcss`.
 * 2. **Theme variables.** Studio already puts `--color-surface` on `:root`. A
 *    plugin re-emitting it would win the cascade — its `<link>` is injected
 *    after Studio's — and repaint the whole farm with whatever the palette
 *    looked like on the day that plugin was built. So the theme is imported
 *    `theme(reference)`.
 *
 * *(measured, Tailwind 4.3.3)* `theme(reference)` does not merely suppress the
 * `:root` block — it compiles `bg-surface` to
 * `background-color: var(--color-surface, oklch(0.209 0.004 245))`. Studio's
 * live value wins wherever Studio defines the token, and the build-time value
 * survives as a fallback for a token Studio never emitted (`bg-purple-500`, say
 * — Studio emits only the tokens it uses). That is why the theme is referenced
 * on BOTH imports, Tailwind's default palette included: it is the one
 * arrangement where a plugin can never override a host token and can never end
 * up with an unresolved one either.
 */

/**
 * Exactly the specifiers Studio's import map provides. Adding one here that
 * the map does not serve would fail at load with an unresolved bare specifier.
 *
 * `@enkaku/host` was added by plan 129 step 129.7 and its absence was a real
 * blocker, not a tidy-up: the bundler tries to RESOLVE every non-external
 * import, and `@enkaku/host` is never published as a package, so the first
 * plugin to import it failed the whole `build:packs` run with `Could not
 * resolve: "@enkaku/host"`. Steps 129.5 and 129.6 did not catch it because
 * neither built a plugin UI that imports it — the shim table and the
 * component were both correct on their own.
 */
export const UI_EXTERNALS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', '@enkaku/ui', '@enkaku/host'] as const

/** Files that are build INPUT — bundled into an entry, never shipped as-is. */
const SOURCE_EXT = /\.(tsx|ts|jsx)$/

/** The `ui/` source directory for a plugin entry: `src/index.ts` → `src/ui`. */
export function uiSourceDir(entry: string): string {
  return join(dirname(entry), 'ui')
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // A dotfile is never part of a published UI, and `node_modules` under a
    // source directory is somebody's mistake rather than an asset.
    if (name.startsWith('.') || name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, base, out)
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

/**
 * The check that turns the `jsxDEV` landmine into a refused publish. Cheap
 * (a substring scan of the author's own output) and worth it: every other
 * symptom of getting this wrong appears only in a browser, at render time,
 * as a blank page.
 */
function assertProductionJsx(path: string, text: string): void {
  if (text.includes('react/jsx-dev-runtime')) {
    throw new Error(
      `the built UI module "${path}" imports react/jsx-dev-runtime — that is the DEVELOPMENT JSX transform, and Studio ships a production React with no jsxDEV export, so the view would render as a blank page. This is a bug in the CLI's own build flags, not in your code; please report it.`,
    )
  }
}

/**
 * Two declarations from Tailwind's preflight that nothing else emits — the
 * `html` rule's `-webkit-text-size-adjust` and the universal box-sizing reset.
 * Either one in a plugin's stylesheet means the author imported `tailwindcss`
 * whole, and the resulting `<link>` would restyle Studio.
 */
const PREFLIGHT_MARKERS = ['-webkit-text-size-adjust', 'box-sizing:border-box', 'box-sizing: border-box']

/** The marker of a Tailwind ENTRY stylesheet, as opposed to a partial or a hand-written file: it pulls the framework in by name. */
const TAILWIND_ENTRY = /@import\s+['"]tailwindcss/

function assertNoPreflight(path: string, text: string): void {
  const found = PREFLIGHT_MARKERS.find((m) => text.includes(m))
  if (found === undefined) return
  throw new Error(
    `the compiled stylesheet "${path}" contains Tailwind's preflight (matched "${found}") — that reset is GLOBAL, and Studio injects this file into its own document, so shipping it would restyle every other screen in the farm rather than just this plugin's view. Studio already supplies preflight. Import utilities only:\n\n  @import 'tailwindcss/theme.css' theme(reference);\n  @import 'tailwindcss/utilities.css' layer(utilities);\n  @import '@enkaku/ui/theme.css' theme(reference);\n`,
  )
}

/**
 * The project's own Tailwind binary, found by walking up from the `ui/`
 * directory — which is what makes a workspace plugin (binary hoisted to the
 * repo root) work as well as a standalone one. `null` when the project has not
 * installed `@tailwindcss/cli`, which is only an error if it also ships a
 * stylesheet.
 */
function findTailwindCli(from: string): string | null {
  let dir = resolve(from)
  for (;;) {
    for (const name of ['tailwindcss', 'tailwindcss.cmd', 'tailwindcss.exe']) {
      const candidate = join(dir, 'node_modules', '.bin', name)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Compiles `<uiDir>/<name>.css` for every build entry that has one, into
 * package-relative `<name>.css`. Empty when no entry has a stylesheet — CSS is
 * optional by design: a plugin drawn entirely with `@enkaku/ui` components
 * needs none, because Studio already generated those classes from
 * `@source '../../../ui/src'`.
 *
 * Tailwind's automatic source detection is left alone rather than pinned with
 * an `@source`: *(measured, Tailwind 4.3.3)* it roots at the nearest
 * `package.json` above the input stylesheet and never climbs past it, so a
 * plugin inside a monorepo scans its own project and not the whole tree.
 */
async function buildUiStylesheets(uiDir: string, entries: string[], tmp: string): Promise<UiAsset[]> {
  const sheets = entries.map((e) => e.replace(SOURCE_EXT, '')).filter((name) => existsSync(join(uiDir, `${name}.css`)))
  if (sheets.length === 0) return []

  const projectDir = dirname(uiDir)
  const cli = findTailwindCli(uiDir)
  if (!cli) {
    throw new Error(
      `${join(uiDir, `${sheets[0]}.css`)} is a plugin stylesheet, but this project has no Tailwind compiler installed — the SDK deliberately does not carry one (it would be bundled into every plugin). Add it to the project:\n\n  bun add -d @tailwindcss/cli tailwindcss\n`,
    )
  }

  const outDir = join(tmp, 'ui-css')
  const assets: UiAsset[] = []
  for (const name of sheets) {
    const out = join(outDir, `${name}.css`)
    const proc = Bun.spawn([cli, '--input', join(uiDir, `${name}.css`), '--output', out, '--minify'], { cwd: projectDir, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    if (exitCode !== 0 || !existsSync(out)) {
      throw new Error(`compiling the plugin stylesheet ${name}.css failed:\n${(stderr || stdout).trim()}`)
    }
    const data = new Uint8Array(await Bun.file(out).arrayBuffer())
    assertNoPreflight(`${name}.css`, new TextDecoder().decode(data))
    assets.push({ path: `${name}.css`, data })
  }
  return assets
}

/**
 * Builds `<dirname(entry)>/ui` into package-relative `ui/` assets. `[]` — never
 * a throw — when the project has no `ui/` directory at all, which is what keeps
 * a script-only plugin publishing exactly as it did before.
 */
export async function buildUiAssets(entry: string, tmp: string): Promise<UiAsset[]> {
  const uiDir = uiSourceDir(entry)
  if (!existsSync(uiDir) || !statSync(uiDir).isDirectory()) return []

  const files = walk(uiDir)
  const entries = files.filter((f) => !f.includes('/') && SOURCE_EXT.test(f) && !f.endsWith('.d.ts'))
  const assets: UiAsset[] = []

  if (entries.length > 0) {
    const outDir = join(tmp, 'ui-out')
    const args = [
      'build',
      ...entries.map((f) => join(uiDir, f)),
      '--outdir',
      outDir,
      '--format',
      'esm',
      '--target',
      'browser',
      // The whole reason this is a subprocess — see the module comment.
      '--production',
      ...UI_EXTERNALS.flatMap((e) => ['--external', e]),
    ]
    const proc = Bun.spawn([process.execPath, ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    if (exitCode !== 0) {
      throw new Error(`building the plugin UI failed:\n${(stderr || stdout).trim()}`)
    }
    for (const built of walk(outDir)) {
      const file = Bun.file(join(outDir, built))
      const data = new Uint8Array(await file.arrayBuffer())
      if (built.endsWith('.js') || built.endsWith('.mjs')) assertProductionJsx(built, new TextDecoder().decode(data))
      assets.push({ path: built, data })
    }
  }

  // The stylesheets, AFTER the module build, so a Tailwind-compiled
  // `index.css` replaces one Bun happened to emit from an `import './index.css'`
  // inside the component — that copy is the author's raw source, inlined by a
  // bundler that knows nothing about Tailwind.
  for (const sheet of await buildUiStylesheets(uiDir, entries, tmp)) {
    const clash = assets.findIndex((a) => a.path === sheet.path)
    if (clash === -1) assets.push(sheet)
    else assets[clash] = sheet
  }

  // Static files ride along unchanged. `emitted` guards the one collision that
  // can happen — a hand-written `index.js` beside an `index.tsx`, or the
  // stylesheet source beside the stylesheet just compiled from it — by letting
  // the BUILT file win, since that is the one the manifest names.
  const emitted = new Set(assets.map((a) => a.path))
  for (const file of files) {
    if (SOURCE_EXT.test(file) || emitted.has(file)) continue
    const data = new Uint8Array(await Bun.file(join(uiDir, file)).arrayBuffer())
    // A `.css` that was NOT compiled is a plain static file and ships as one —
    // unless it is a Tailwind entry, in which case it is a stylesheet the
    // convention did not pick up, and shipping the uncompiled source would give
    // an author a `<link>` full of `@import` directives no browser can follow.
    if (file.endsWith('.css') && TAILWIND_ENTRY.test(new TextDecoder().decode(data))) {
      throw new Error(
        `${join(uiDir, file)} imports Tailwind, so it is a stylesheet to COMPILE — but nothing compiled it, and it would have shipped as raw source. A stylesheet is named after the entry it belongs to: rename it to match one of ${entries.join(', ') || '(no build entry in this ui/ directory)'} — e.g. index.tsx takes index.css.`,
      )
    }
    assets.push({ path: file, data })
  }

  return assets
}
