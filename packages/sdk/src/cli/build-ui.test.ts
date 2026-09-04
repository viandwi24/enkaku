import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildUiAssets } from './build-ui'

/**
 * Plan 111 §9 Q1, step 111.9 — a plugin compiles its own stylesheet.
 *
 * **Why these assertions are worth a real compile rather than a stub.** Both
 * failures this step exists to prevent are invisible on the plugin's own
 * screen and global everywhere else: a preflight reset in the plugin's
 * stylesheet restyles all of Studio, and a re-emitted `--color-surface` wins
 * the cascade (the plugin's `<link>` is injected last) and repaints the whole
 * farm with a frozen palette. A stubbed compiler would prove the wiring and
 * none of that.
 *
 * The fixtures therefore live INSIDE the repo, not in `/tmp`: `buildUiAssets`
 * finds the compiler by walking up to a `node_modules/.bin/tailwindcss`, which
 * is exactly how a plugin in this workspace (or any plugin whose project
 * installed `@tailwindcss/cli`) finds its own. `@tailwindcss/cli` and
 * `tailwindcss` are root devDependencies for that reason — the SDK's own
 * package.json deliberately has neither.
 */

const FIXTURE_ROOT = join(import.meta.dir, '.test-fixtures-ui')
const THEME_CSS = fileURLToPath(new URL('../../../ui/src/theme.css', import.meta.url))
mkdirSync(FIXTURE_ROOT, { recursive: true })

const dirs: string[] = []
const tmps: string[] = []

/** A plugin project with a `ui/` directory: `<dir>/src/index.ts` is the entry, `<dir>/src/ui/` its UI. */
function project(files: Record<string, string>): { entry: string; tmp: string } {
  const dir = mkdtempSync(join(FIXTURE_ROOT, 'fx-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src', 'ui'), { recursive: true })
  // A `package.json` is not decoration: Tailwind's automatic source detection
  // roots at the nearest one above the input stylesheet, so without it the
  // scan would climb into the rest of this repo.
  writeFileSync(join(dir, 'package.json'), '{"name":"fx","private":true}\n')
  writeFileSync(join(dir, 'src', 'index.ts'), 'export default {}\n')
  // What `bun install` would have produced from the scaffold's
  // `devDependencies: { '@enkaku/ui': '*' }`. `tailwindcss` itself is a root
  // devDependency and resolves by walking up, exactly as it would for a plugin
  // living in this workspace.
  mkdirSync(join(dir, 'node_modules', '@enkaku'), { recursive: true })
  symlinkSync(dirname(THEME_CSS).replace(/\/src$/, ''), join(dir, 'node_modules', '@enkaku', 'ui'), 'dir')
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, 'src', 'ui', rel), content)
  const tmp = mkdtempSync(join(tmpdir(), 'enkaku-ui-'))
  tmps.push(tmp)
  return { entry: join(dir, 'src', 'index.ts'), tmp }
}

/** What `enkaku init` writes, and what every assertion below is really about. */
const SCAFFOLD_CSS = `@import 'tailwindcss/theme.css' theme(reference);
@import 'tailwindcss/utilities.css' layer(utilities);
@import '@enkaku/ui/theme.css' theme(reference);
`

const VIEW_TSX = `export function View() {
  return (
    <div className="bg-panel text-faint rounded-card p-6 grid-cols-[200px_1fr]">
      <button className="opacity-0 hover-none:opacity-100">b</button>
    </div>
  )
}
`

function textOf(assets: Array<{ path: string; data: Uint8Array }>, path: string): string {
  const asset = assets.find((a) => a.path === path)
  if (!asset) throw new Error(`no asset "${path}" — got ${assets.map((a) => a.path).join(', ') || '(none)'}`)
  return new TextDecoder().decode(asset.data)
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true })
})

describe('a plugin ships its own compiled stylesheet (plan 111 §9 Q1, step 111.9)', () => {
  test('src/ui/index.css becomes ui/index.css, carrying the classes Studio never generated', async () => {
    const { entry, tmp } = project({ 'index.tsx': VIEW_TSX, 'index.css': SCAFFOLD_CSS })
    const assets = await buildUiAssets(entry, tmp)

    expect(assets.map((a) => a.path).sort()).toEqual(['index.css', 'index.js'])
    const css = textOf(assets, 'index.css')

    // The author's own class — the whole reason the step exists. Studio has no
    // 200px/1fr grid anywhere, so nothing would have generated this.
    expect(css).toContain('grid-template-columns:200px 1fr')
    // A `hover-none:` variant compiles, which is only true because
    // `@custom-variant hover-none` travelled with the theme instead of staying
    // in Studio's globals.css. An unknown variant emits nothing and says nothing.
    expect(css).toContain('@media (hover:none)')
    expect(css).toContain('.hover-none\\:opacity-100')
  }, 60000)

  test('the emitted CSS carries NO preflight — that reset is global and would restyle Studio', async () => {
    const { entry, tmp } = project({ 'index.tsx': VIEW_TSX, 'index.css': SCAFFOLD_CSS })
    const css = textOf(await buildUiAssets(entry, tmp), 'index.css')

    // Preflight's two most distinctive declarations (`tailwindcss/preflight.css`).
    expect(css).not.toContain('-webkit-text-size-adjust')
    expect(css).not.toContain('box-sizing:border-box')
    expect(css).not.toContain('@layer base')
  }, 60000)

  test('the emitted CSS re-declares NO theme variable — Studio owns :root, and the plugin loads after it', async () => {
    const { entry, tmp } = project({ 'index.tsx': VIEW_TSX, 'index.css': SCAFFOLD_CSS })
    const css = textOf(await buildUiAssets(entry, tmp), 'index.css')

    // Not `--color-surface: <value>` anywhere — only `var(--color-surface, …)`,
    // so Studio's live token wins and the build-time value is a fallback for a
    // token Studio never emitted.
    expect(css).not.toContain('--color-panel:')
    expect(css).not.toContain('--spacing:')
    expect(css).not.toContain(':root')
    expect(css).toContain('var(--panel)')
    expect(css).toContain('var(--spacing,')
  }, 60000)

  test('no stylesheet is not an error — a plugin drawn only from @enkaku/ui needs none', async () => {
    const { entry, tmp } = project({ 'index.tsx': VIEW_TSX })
    const assets = await buildUiAssets(entry, tmp)
    expect(assets.map((a) => a.path)).toEqual(['index.js'])
  }, 60000)

  test('a .css that is not named after an entry is a plain static file and still rides along verbatim', async () => {
    const { entry, tmp } = project({ 'index.tsx': VIEW_TSX, 'extra.css': '.plugin { color: red }' })
    const assets = await buildUiAssets(entry, tmp)
    expect(assets.map((a) => a.path).sort()).toEqual(['extra.css', 'index.js'])
    expect(textOf(assets, 'extra.css')).toBe('.plugin { color: red }')
  }, 60000)

  test('a Tailwind stylesheet under the WRONG name is refused, not shipped as raw source', async () => {
    const { entry, tmp } = project({ 'index.tsx': VIEW_TSX, 'styles.css': SCAFFOLD_CSS })
    await expect(buildUiAssets(entry, tmp)).rejects.toThrow(/styles\.css imports Tailwind[\s\S]*index\.tsx takes index\.css/)
  }, 60000)
})

describe('the theme is defined once and read by both compilers (plan 111 §3.3)', () => {
  test('@enkaku/ui exports theme.css, and it holds tokens and vocabulary only', async () => {
    const pkg = (await Bun.file(fileURLToPath(new URL('../../../ui/package.json', import.meta.url))).json()) as { exports: Record<string, string> }
    expect(pkg.exports['./theme.css']).toBe('./src/theme.css')
    expect(existsSync(THEME_CSS)).toBe(true)

    const theme = await Bun.file(THEME_CSS).text()
    expect(theme).toContain('--color-panel:')
    expect(theme).toContain('@custom-variant hover-none')
    // Studio's own page styling stays in Studio: a plugin importing this file
    // with `theme(reference)` must not be able to pick up a base reset or a
    // `.status-rail` through it.
    expect(theme).not.toContain('@layer base')
    expect(theme).not.toContain('@layer components')
  })

  test("Studio's globals.css imports that same file rather than holding a second copy", async () => {
    const globals = await Bun.file(fileURLToPath(new URL('../../../studio/src/app/globals.css', import.meta.url))).text()
    expect(globals).toContain("@import '@enkaku/ui/theme.css';")
    expect(globals).toContain("@import '@enkaku/ui/palette.css';")
    // The tokens must exist in exactly one place. If a value reappears here,
    // Studio and every published plugin have started drifting apart.
    expect(globals).not.toContain('--panel:')
    expect(globals).toContain('@layer base')
  })
})
