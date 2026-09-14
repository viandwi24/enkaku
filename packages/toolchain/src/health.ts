import type { HealthResult } from './types'

const nowSec = (): number => Math.floor(Date.now() / 1000)

/**
 * Health check per tool (plan 02 §4.9):
 * - adb: spawn `<path> version`, expect exit 0 and stdout containing
 *   'Android Debug Bridge' (a 10-second timeout).
 * - file-based (jar/apk, `format: 'raw'`): the file exists and its sha256 matches the record.
 * - extracted (`format: 'zip'`): the entrypoint exists and is not empty — the
 *   ARCHIVE's sha256 was verified at download, and the extracted file has a
 *   different hash by construction.
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

/** Lines whisper.cpp's ggml backends print before anything the CLI itself says (`load_backend: ...`, `ggml_metal_...`, `whisper_init...`). */
const WHISPER_NOISE = /^(load_backend|ggml_|whisper_|register_backend|system_info)/

/**
 * Plan 318 — whisper-cli: spawn `<path> --help` (10-second timeout), expect
 * exit 0 and output that mentions `usage` or `whisper`. The help text goes to
 * STDERR, after a screenful of backend initialisation on a Metal build
 * (measured on Homebrew's whisper-cpp, 2026-09-14: the `usage:` line is line
 * 46), so both streams are read and the detail is the `usage:` line when
 * there is one, else the first line that is not backend noise.
 */
export async function checkWhisperCli(path: string, timeoutMs = 10_000): Promise<HealthResult> {
  try {
    const proc = Bun.spawn([path, '--help'], { stdout: 'pipe', stderr: 'pipe' })
    let timer: ReturnType<typeof setTimeout> | undefined
    // Raced, not awaited in full: killing the process does not close pipes a CHILD it spawned still holds, so waiting
    // for the output to finish after a timeout could outlast the timeout by as long as that child lives.
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        proc.kill()
        resolve('timeout')
      }, timeoutMs)
    })
    const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    const outcome = await Promise.race([finished, timedOut])
    clearTimeout(timer)
    if (outcome === 'timeout') return { ok: false, checkedAt: nowSec(), detail: `timed out after ${Math.max(1, Math.round(timeoutMs / 1000))} s` }
    const [stdout, stderr, exit] = outcome
    const output = `${stdout}\n${stderr}`
    const lines = output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const usage = lines.find((l) => /^usage/i.test(l))
    const meaningful = usage ?? lines.find((l) => !WHISPER_NOISE.test(l)) ?? ''
    if (exit === 0 && /usage|whisper/i.test(output)) {
      return { ok: true, checkedAt: nowSec(), detail: meaningful || 'whisper-cli runs' }
    }
    return { ok: false, checkedAt: nowSec(), detail: `exit ${exit}: ${(meaningful || output.trim()).slice(0, 200)}` }
  } catch (err) {
    return { ok: false, checkedAt: nowSec(), detail: String(err) }
  }
}

/**
 * A `zip` tool's entrypoint was EXTRACTED, so its hash is not the archive's.
 *
 * `checkFileHash` compares the recorded sha256 — which is the archive's,
 * verified at download by `downloadVerified` — against whatever file the
 * entrypoint names. For a `raw` tool those are the same file and the check is
 * exactly right. For a `zip` tool they never are, and the check fails every
 * time.
 *
 * It never showed because `adb` was the only `zip` tool and it is
 * special-cased by id (it runs `adb version`, a stronger check anyway). The
 * second one — `cmdline-tools`, 2026-09-06 — failed its health check the
 * moment it was installed, with a sha256 mismatch that was arithmetically
 * certain rather than a sign of anything wrong.
 *
 * The archive's integrity is already established before extraction. What is
 * left to check here is that extraction produced the file we expect.
 */
export async function checkExtractedEntrypoint(path: string): Promise<HealthResult> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) {
      return { ok: false, checkedAt: nowSec(), detail: `entrypoint missing after extraction: ${path}` }
    }
    const size = file.size
    if (size === 0) {
      return { ok: false, checkedAt: nowSec(), detail: `entrypoint is empty: ${path}` }
    }
    return { ok: true, checkedAt: nowSec(), detail: `extracted (${size} bytes); the archive's sha256 was verified on download` }
  } catch (err) {
    return { ok: false, checkedAt: nowSec(), detail: String(err) }
  }
}

export async function checkFileHash(path: string, expectedSha256: string | null): Promise<HealthResult> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) {
      return { ok: false, checkedAt: nowSec(), detail: `file missing: ${path}` }
    }
    if (!expectedSha256) {
      return { ok: true, checkedAt: nowSec(), detail: 'file present (no hash on record)' }
    }
    // Streamed: a Whisper medium model is 540 MB, and reading it whole to hash it doubled the core's memory for the length of a check.
    const hasher = new Bun.CryptoHasher('sha256')
    for await (const chunk of file.stream()) hasher.update(chunk)
    const actual = hasher.digest('hex')
    return actual === expectedSha256
      ? { ok: true, checkedAt: nowSec(), detail: 'sha256 matches' }
      : { ok: false, checkedAt: nowSec(), detail: `sha256 mismatch (actual ${actual.slice(0, 12)}…)` }
  } catch (err) {
    return { ok: false, checkedAt: nowSec(), detail: String(err) }
  }
}
