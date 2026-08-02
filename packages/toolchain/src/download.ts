import { rmSync } from 'node:fs'
import { ToolchainError } from './errors'
import type { ToolArtifact } from './types'

export interface DownloadProgress {
  toolId: string
  version: string
  phase: 'download' | 'verify' | 'extract'
  bytesReceived: number
  totalBytes: number | null
}

export interface DownloadOptions {
  artifact: ToolArtifact
  dest: string
  toolId: string
  version: string
  /** Di-throttle max 1 event / 200ms. */
  onProgress?: (p: DownloadProgress) => void
  signal?: AbortSignal
  /** Idle timeout in ms (no bytes arriving) — defaults to 60_000. */
  idleTimeoutMs?: number
}

/**
 * Streaming download with sha256 in a single pass (hashed per chunk as it
 * the .part file is written — no second read). A mismatch deletes the file and throws
 * E_CHECKSUM_MISMATCH. Retries once automatically, and only on network errors.
 */
export async function downloadVerified(opts: DownloadOptions): Promise<{ sha256: string }> {
  try {
    return await attempt(opts)
  } catch (err) {
    if (err instanceof ToolchainError && err.code !== 'E_DOWNLOAD_FAILED' && err.code !== 'E_DOWNLOAD_STALLED') {
      throw err
    }
    // network error → retry 1×
    return attempt(opts)
  }
}

async function attempt(opts: DownloadOptions): Promise<{ sha256: string }> {
  const { artifact, dest, toolId, version, onProgress } = opts
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000
  const hasher = new Bun.CryptoHasher('sha256')
  let received = 0
  let lastEmit = 0
  const total = artifact.sizeBytes > 0 ? artifact.sizeBytes : null

  const emit = (force = false) => {
    const now = Date.now()
    if (!force && now - lastEmit < 200) return
    lastEmit = now
    onProgress?.({ toolId, version, phase: 'download', bytesReceived: received, totalBytes: totalFromHeader ?? total })
  }

  let totalFromHeader: number | null = null
  let res: Response
  try {
    res = await fetch(artifact.url, { signal: opts.signal })
  } catch (err) {
    throw new ToolchainError('E_DOWNLOAD_FAILED', `fetch failed for ${artifact.url}: ${String(err)}`, err)
  }
  if (!res.ok || !res.body) {
    throw new ToolchainError('E_DOWNLOAD_FAILED', `fetch ${artifact.url} → HTTP ${res.status}`)
  }
  const contentLength = res.headers.get('content-length')
  if (contentLength) {
    const n = Number.parseInt(contentLength, 10)
    if (!Number.isNaN(n)) totalFromHeader = n
  }

  const writer = Bun.file(dest).writer()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  try {
    const reader = res.body.getReader()
    for (;;) {
      const race = await Promise.race([
        reader.read(),
        new Promise<'stalled'>((resolve) => {
          idleTimer = setTimeout(() => resolve('stalled'), idleTimeoutMs)
        }),
      ])
      if (idleTimer) clearTimeout(idleTimer)
      if (race === 'stalled') {
        await reader.cancel().catch(() => {})
        throw new ToolchainError('E_DOWNLOAD_STALLED', `download ${artifact.url} macet > ${idleTimeoutMs}ms`)
      }
      const { done, value } = race
      if (done) break
      hasher.update(value)
      writer.write(value)
      received += value.length
      emit()
    }
    await writer.end()
    emit(true)
  } catch (err) {
    await Promise.resolve(writer.end()).catch(() => {})
    rmSync(dest, { force: true })
    if (err instanceof ToolchainError) throw err
    throw new ToolchainError('E_DOWNLOAD_FAILED', `stream failed for ${artifact.url}: ${String(err)}`, err)
  }

  onProgress?.({ toolId, version, phase: 'verify', bytesReceived: received, totalBytes: totalFromHeader ?? total })
  const actual = hasher.digest('hex')
  if (actual !== artifact.sha256) {
    rmSync(dest, { force: true })
    throw new ToolchainError(
      'E_CHECKSUM_MISMATCH',
      `sha256 mismatch for ${artifact.url}: expected ${artifact.sha256}, actual ${actual}`,
    )
  }
  return { sha256: actual }
}
