import type { HealthResult } from './types'

const nowSec = (): number => Math.floor(Date.now() / 1000)

/**
 * Health check per tool (plan 02 §4.9):
 * - adb: spawn `<path> version`, exit 0 + stdout mengandung
 *   'Android Debug Bridge' (timeout 10 detik).
 * - file-based (jar/apk): file ada + sha256 cocok dengan yang tercatat.
 */
export async function checkAdbBinary(path: string): Promise<HealthResult> {
  try {
    const proc = Bun.spawn([path, 'version'], { stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => proc.kill(), 10_000)
    const exit = await proc.exited
    clearTimeout(timeout)
    const stdout = await new Response(proc.stdout).text()
    if (exit === 0 && stdout.includes('Android Debug Bridge')) {
      const firstLine = stdout.split('\n')[0] ?? 'ok'
      return { ok: true, checkedAt: nowSec(), detail: firstLine.trim() }
    }
    return { ok: false, checkedAt: nowSec(), detail: `exit ${exit}: ${stdout.slice(0, 200).trim()}` }
  } catch (err) {
    return { ok: false, checkedAt: nowSec(), detail: String(err) }
  }
}

export async function checkFileHash(path: string, expectedSha256: string | null): Promise<HealthResult> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) {
      return { ok: false, checkedAt: nowSec(), detail: `file tidak ada: ${path}` }
    }
    if (!expectedSha256) {
      return { ok: true, checkedAt: nowSec(), detail: 'file ada (tanpa hash tercatat)' }
    }
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(await file.arrayBuffer())
    const actual = hasher.digest('hex')
    return actual === expectedSha256
      ? { ok: true, checkedAt: nowSec(), detail: 'sha256 cocok' }
      : { ok: false, checkedAt: nowSec(), detail: `sha256 mismatch (actual ${actual.slice(0, 12)}…)` }
  } catch (err) {
    return { ok: false, checkedAt: nowSec(), detail: String(err) }
  }
}
