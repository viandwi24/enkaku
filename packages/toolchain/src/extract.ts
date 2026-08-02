import { chmodSync, mkdirSync, renameSync, statSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { unzipSync } from 'fflate'
import { ToolchainError } from './errors'

/**
 * Extracts zips with fflate (pure JS — self-contained, no `unzip`
 * system tar). Entries with path traversal are rejected. fflate does not carry unix
 * modes → a blanket chmod 0755 on POSIX (tool folders are small; deterministic).
 */
export async function extractZip(srcZip: string, destDir: string): Promise<void> {
  const data = new Uint8Array(await Bun.file(srcZip).arrayBuffer())
  const entries = unzipSync(data)
  for (const [name, content] of Object.entries(entries)) {
    const normalized = normalize(name)
    if (normalized.startsWith('..') || isAbsolute(normalized)) {
      throw new ToolchainError('E_EXTRACT_UNSAFE_PATH', `unsafe zip entry: ${name}`)
    }
    const target = join(destDir, normalized)
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    await Bun.write(target, content)
  }
  if (process.platform !== 'win32') chmodTreeExec(destDir)
}

function chmodTreeExec(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) {
      chmodTreeExec(p)
    } else {
      chmodSync(p, 0o755)
    }
  }
}

/** Raw artifact (jar/apk): move it into destDir under its canonical name. */
export function placeRaw(srcFile: string, destDir: string, canonicalName: string): void {
  mkdirSync(destDir, { recursive: true })
  renameSync(srcFile, join(destDir, canonicalName))
}
