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
 * Output (gitignored): packages/core/packs/<id>.mjs + index.json
 * Usage:  bun scripts/build-packs.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

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
const PACK_ENTRIES = ['plugins/networking/src/index.ts', 'plugins/tiktok-automation-pack/src/index.ts']

export interface PackIndexEntry {
  name: string
  version: string
  /** Filename inside packs/, e.g. `networking.mjs`. */
  file: string
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
  index.push({ name: def.id, version: def.version, file })
  console.log(`  ${def.id}@${def.version} → packs/${file} (${(code.length / 1024).toFixed(0)} KB, ${def.scripts.length} script(s))`)
}

writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
console.log(`built ${index.length} pack(s) into ${relative(root, outDir)}`)
