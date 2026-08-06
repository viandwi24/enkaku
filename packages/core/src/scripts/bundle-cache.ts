import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptRow } from '../db/schema'

/**
 * Materialises the bundle from the `scripts.bundle` column into a file so the
 * child process can `import()` it. Content-addressed by the FULL sha256 of
 * the bundle text ALONE (plan 82 §4.5) — not `(id, version, hash-prefix)` as
 * before this plan. That distinction matters once a plugin exists: twenty
 * `scripts` rows sharing one plugin bundle all carry byte-identical
 * `bundle` columns, so keying on the id (which differs per row) used to
 * write twenty identical ~700 KB files for one plugin publish. Keying on
 * the content hash alone collapses that to one file, and a standalone
 * script — one row, one hash — behaves exactly as before: same file,
 * different name.
 */
export async function materializeBundle(dataDir: string, script: ScriptRow): Promise<string> {
  return materializeBundleText(dataDir, script.bundle)
}

/** The content-addressing primitive `materializeBundle` and a dev slot's build both use — the same file for the same bytes, published or not (plan 82 §4.5's "the child import path is identical for dev and published"). */
export async function materializeBundleText(dataDir: string, bundle: string): Promise<string> {
  const dir = join(dataDir, 'cache', 'bundles')
  mkdirSync(dir, { recursive: true })
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(bundle)
  const digest = hasher.digest('hex')
  const path = join(dir, `${digest}.mjs`)
  const file = Bun.file(path)
  if (!(await file.exists())) {
    await Bun.write(path, bundle)
  }
  return path
}
