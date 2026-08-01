import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptRow } from '../db/schema'

/**
 * Materialisasi bundle dari kolom `scripts.bundle` ke file supaya child
 * process bisa `import()`. Content-addressed per (id, version) + hash isi,
 * jadi publish baru otomatis memakai file baru.
 */
export async function materializeBundle(dataDir: string, script: ScriptRow): Promise<string> {
  const dir = join(dataDir, 'cache', 'bundles')
  mkdirSync(dir, { recursive: true })
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(script.bundle)
  const digest = hasher.digest('hex').slice(0, 12)
  const path = join(dir, `${script.id}-${script.version}-${digest}.mjs`)
  const file = Bun.file(path)
  if (!(await file.exists())) {
    await Bun.write(path, script.bundle)
  }
  return path
}
