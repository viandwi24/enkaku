import { chmodSync, mkdirSync, renameSync, statSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { unzipSync } from 'fflate'
import { ToolchainError } from './errors'

/**
 * Extract zip pakai fflate (JS murni — self-contained, tanpa `unzip`
 * sistem). Entry ber-path traversal ditolak. fflate tidak membawa unix
 * mode → blanket chmod 0755 di POSIX (folder tool kecil; deterministik).
 */
export async function extractZip(srcZip: string, destDir: string): Promise<void> {
  const data = new Uint8Array(await Bun.file(srcZip).arrayBuffer())
  const entries = unzipSync(data)
  for (const [name, content] of Object.entries(entries)) {
    const normalized = normalize(name)
    if (normalized.startsWith('..') || isAbsolute(normalized)) {
      throw new ToolchainError('E_EXTRACT_UNSAFE_PATH', `entry zip tidak aman: ${name}`)
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

/** Raw artifact (jar/apk): pindahkan ke destDir dengan nama kanonik. */
export function placeRaw(srcFile: string, destDir: string, canonicalName: string): void {
  mkdirSync(destDir, { recursive: true })
  renameSync(srcFile, join(destDir, canonicalName))
}
