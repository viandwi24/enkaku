/**
 * Bundle the plugin packs that ship inside the release binary.
 *
 * Each pack is bundled exactly the way `enkaku publish` bundles an author's
 * own plugin (`Bun.build`, every dependency inlined), then imported once to
 * read the `id`/`version` `definePlugin` stamped on it — the same "trust the
 * bundle's own default export, not a filename" rule the CLI follows. The farm
 * still re-verifies whatever it is given in a child process; nothing here is a
 * shortcut around that.
 *
 * ## The `ui/` half (plan 111 step 111.7)
 *
 * An embedded pack used to be one `.mjs` and nothing else, which was true for
 * as long as every shipped pack was tier A. Proxy Manager is tier C now: its
 * screen is `ui/index.js` plus `ui/index.css`, and a staged pack without them
 * has a `react` view whose module 404s — a named error panel on a fresh
 * install, for a pack the release itself put there.
 *
 * So this runs the SDK's own `buildUiAssets` — the same function
 * `enkaku publish` runs, not a second implementation of it — and writes what
 * it produces beside the bundle. `seedEmbeddedPacks` passes them to
 * `runtime.stage({ ui })`, which is the same door the `.enkaku` upload uses.
 * A pack with no `src/ui/` directory produces `[]` and is embedded exactly as
 * it was before.
 *
 * Output (gitignored): packages/core/packs/<id>.mjs, packages/core/packs/<id>-ui/**, index.json
 * Usage:  bun scripts/build-packs.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { buildUiAssets } from '../packages/sdk/src/cli/build-ui'

const root = join(import.meta.dir, '..')
const outDir = join(root, 'packages', 'core', 'packs')

/**
 * The packs that ship in the binary. A pack is only ever added here deliberately.
 *
 * They live under `plugins/`, not `examples/`. The distinction is not tidiness: a pack listed here
 * is embedded in every download and staged on a user's first boot, so it is product — it carries a
 * `package.json`, is typechecked by `scripts/typecheck.sh`, and has its own CI test invocation.
 * `examples/` stayed what it was: scripts an author reads and copies, where a break costs an
 * afternoon rather than a release.
 */
const PACK_ENTRIES = [
  'plugins/networking/src/index.ts',
  'plugins/proxy-manager/src/index.ts',
  'plugins/tiktok-automation-pack/src/index.ts',
  'plugins/mikrotik-routing/src/index.ts',
  'plugins/google-automation-pack/src/index.ts',
  'plugins/youtube-automation-pack/src/index.ts',
]

export interface PackIndexEntry {
  name: string
  version: string
  /** Filename inside packs/, e.g. `networking.mjs`. */
  file: string
  /**
   * The pack's `ui/` payload, if it has one. `path` is the name the package
   * format uses (`index.js`, `index.css`) and is what a view's `react.entry`
   * names; `file` is where the bytes sit under packs/, for the release
   * entrypoint to embed. Absent for a script-only or tier-A pack.
   */
  ui?: { path: string; file: string }[]
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const index: PackIndexEntry[] = []

for (const entry of PACK_ENTRIES) {
  const entryPath = join(root, entry)
  const built = await Bun.build({ entrypoints: [entryPath], target: 'bun' })
  if (!built.success) {
    console.error(`failed to bundle ${entry}:`)
    for (const log of built.logs) console.error(`  ${log}`)
    process.exit(1)
  }
  const output = built.outputs[0]
  if (!output) {
    console.error(`failed to bundle ${entry}: no output`)
    process.exit(1)
  }
  const code = await output.text()

  // Read id/version from the built bundle, never from the filename.
  const mod = (await import(entryPath)) as { default?: { id?: unknown; version?: unknown; scripts?: unknown[] } }
  const def = mod.default
  if (!def || typeof def.id !== 'string' || typeof def.version !== 'string' || !Array.isArray(def.scripts)) {
    console.error(`${entry} does not default-export a definePlugin() result`)
    process.exit(1)
  }

  const file = `${def.id}.mjs`
  writeFileSync(join(outDir, file), code)

  // The same builder `enkaku publish` uses, given a scratch directory it owns.
  // `[]` for a pack with no `src/ui/`, which is every pack but one today.
  const uiAssets = await buildUiAssets(entryPath, join(outDir, `.tmp-${def.id}`))
  const ui: { path: string; file: string }[] = []
  for (const asset of uiAssets) {
    const dest = `${def.id}-ui/${asset.path}`
    mkdirSync(dirname(join(outDir, dest)), { recursive: true })
    writeFileSync(join(outDir, dest), asset.data)
    ui.push({ path: asset.path, file: dest })
  }
  rmSync(join(outDir, `.tmp-${def.id}`), { recursive: true, force: true })

  index.push({ name: def.id, version: def.version, file, ...(ui.length > 0 ? { ui } : {}) })
  const uiNote = ui.length > 0 ? `, ${ui.length} ui asset(s)` : ''
  console.log(`  ${def.id}@${def.version} → packs/${file} (${(code.length / 1024).toFixed(0)} KB, ${def.scripts.length} script(s)${uiNote})`)
}

writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
console.log(`built ${index.length} pack(s) into ${relative(root, outDir)}`)
