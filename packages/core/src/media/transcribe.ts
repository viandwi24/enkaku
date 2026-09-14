import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { z } from 'zod'
import type { ToolManifestEntry } from '@enkaku/toolchain'
import type { MediaTranscribeInput, MediaTranscribeOutput, MediaTranscribeStatusOutput, TranscribeSegment } from '@enkaku/protocol'
import type { Db } from '../db'
import { artifacts } from '../db/schema'
import { eq } from 'drizzle-orm'
import { EnkakuError } from '../util/errors'

/**
 * `media.transcribe` / `.transcribe.status` (plan 317) — local whisper.cpp
 * transcription of an already-extracted WAV artifact. No ffmpeg anywhere in
 * this path (`media/probe.ts`'s own comment explains the licensing reason):
 * the browser extracts the audio and uploads a 16 kHz mono PCM WAV; this
 * service only ever reads that file and hands it to `whisper-cli`.
 */

const WHISPER_CPP_TOOL_ID = 'whisper-cpp'
const WHISPER_MODEL_TOOL_ID = 'whisper-model-small'

/** How long a transcription may run before the child process is killed — under the capability's own 30-minute deadline, so the service is the one that actually stops the process rather than leaving it running after `invoke` has already given up on the promise. */
export const TRANSCRIBE_TIMEOUT_MS = 25 * 60_000

// ---------------------------------------------------------------------------
// Pure helpers — exported and unit-tested directly (plan 317's testing scope).
// ---------------------------------------------------------------------------

/** A RIFF/WAVE container, read from its own first 12 bytes — never from a filename or declared content type. */
export function isWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const ascii = (offset: number, len: number): string => {
    let s = ''
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i] ?? 0)
    return s
  }
  return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE'
}

/**
 * Markers whisper.cpp emits for audio it heard nothing speakable in —
 * bracketed/parenthesised annotations ('[BLANK_AUDIO]', '(music)', '[Music]')
 * and the musical note glyph. `isSpeech` strips them and treats whatever
 * text is left (after trimming stray punctuation) as the actual signal.
 */
const NON_SPEECH_PATTERN = /\[[^\]]*\]|\([^)]*\)|[♪*]/g

export function isSpeech(text: string): boolean {
  const stripped = text
    .replace(NON_SPEECH_PATTERN, ' ')
    .replace(/[.,!?…\-–—\s]+/g, ' ')
    .trim()
  return stripped.length > 0
}

/**
 * whisper.cpp's `-oj` JSON output shape (examples/cli/cli.cpp's `output_json`,
 * whisper.cpp v1.9.x) — `result.language` is the detected/used language,
 * `transcription[].offsets.{from,to}` are already MILLISECONDS (the writer
 * multiplies its internal centiseconds by 10), and `.text` is one segment's
 * text. Anything that fails this loose shape parses to an empty result
 * rather than throwing — a malformed or truncated JSON file must not crash
 * the capability after whisper has already spent CPU on the audio.
 */
const WhisperJsonSchema = z.object({
  result: z.object({ language: z.string() }).optional(),
  transcription: z
    .array(
      z.object({
        offsets: z.object({ from: z.number(), to: z.number() }),
        text: z.string(),
      }),
    )
    .optional(),
})

export interface ParsedWhisperOutput {
  fullText: string
  language: string | null
  durationMs: number | null
  segments: TranscribeSegment[]
}

export function parseWhisperJson(json: unknown): ParsedWhisperOutput {
  const parsed = WhisperJsonSchema.safeParse(json)
  if (!parsed.success) return { fullText: '', language: null, durationMs: null, segments: [] }
  const segments: TranscribeSegment[] = (parsed.data.transcription ?? []).map((t) => ({
    startMs: Math.max(0, Math.round(t.offsets.from)),
    endMs: Math.max(0, Math.round(t.offsets.to)),
    text: t.text.trim(),
  }))
  const fullText = segments
    .map((s) => s.text)
    .filter((t) => t.length > 0)
    .join(' ')
    .trim()
  const durationMs = segments.length > 0 ? segments[segments.length - 1]!.endMs : null
  return { fullText, language: parsed.data.result?.language ?? null, durationMs, segments }
}

// ---------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------

/** The narrow slice of `ToolchainManager` this service needs — a real instance satisfies it, and a test hands a fake. */
export interface TranscribeToolchainPort {
  resolveToolPath(toolId: string): Promise<string>
  activeVersion(toolId: string): Promise<string | null>
  install(toolId: string, version: string, opts?: { internal?: boolean }): Promise<void>
  activate(toolId: string, version: string, opts?: { internal?: boolean }): Promise<void>
  manifests: { getTool(id: string): ToolManifestEntry | null }
}

export interface TranscribeSpawnResult {
  exited: Promise<number>
  kill(): void
  stderr: ReadableStream<Uint8Array> | null
}

export interface TranscribeServiceDeps {
  db: Db
  dataDir: string
  toolchain: TranscribeToolchainPort
  /** Injectable so a test proves the argv without spawning whisper-cli. Defaults to a real `Bun.spawn`. */
  spawn?: (cmd: string[]) => TranscribeSpawnResult
  timeoutMs?: number
}

export interface TranscribeService {
  status(): Promise<MediaTranscribeStatusOutput>
  transcribe(input: MediaTranscribeInput): Promise<MediaTranscribeOutput>
}

const STDERR_TAIL_BYTES = 4096

function realSpawn(cmd: string[]): TranscribeSpawnResult {
  const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'pipe' })
  return { exited: proc.exited, kill: () => proc.kill(), stderr: proc.stderr as ReadableStream<Uint8Array> | null }
}

async function readStreamTail(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!stream) return ''
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  const total = Buffer.concat(chunks)
  return total.subarray(Math.max(0, total.length - maxBytes)).toString('utf8')
}

/** Resolves the artifact's absolute path the same way `api/artifacts.ts`'s `GET /:id/content` does — dataDir-relative, traversal-safe. */
function resolveArtifactPath(deps: TranscribeServiceDeps, artifactId: string): string {
  const row = deps.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).get()
  if (!row) throw new EnkakuError('artifact_not_found', `no such artifact: ${artifactId}`)
  const rel = normalize(row.path)
  if (rel.startsWith('..')) throw new EnkakuError('artifact_not_found', 'invalid artifact path')
  return join(deps.dataDir, rel)
}

/** Installs and activates the manifest's own (only) version of `toolId`, unless it is already active. Never called for a tool the caller resolved through an env override — `resolveToolPath` already returned before this runs. */
async function ensureProvisioned(toolchain: TranscribeToolchainPort, toolId: string): Promise<void> {
  const active = await toolchain.activeVersion(toolId)
  if (active) return
  const tool = toolchain.manifests.getTool(toolId)
  const version = tool?.versions[0]?.version
  if (!version) throw new EnkakuError('E_TRANSCRIBE_UNAVAILABLE', `${toolId} is not in the toolchain manifest`)
  try {
    await toolchain.install(toolId, version, { internal: true })
  } catch (err) {
    if (!(err instanceof Error) || (err as { code?: string }).code !== 'E_ALREADY_INSTALLED') throw err
  }
  await toolchain.activate(toolId, version, { internal: true })
}

/** `resolveToolPath` already honours `ENKAKU_<TOOL_ID>_PATH` before ever looking at the active pointer — so a dev override works with nothing provisioned. Only when there is none of that does this attempt to install+activate the manifest's pinned version, which fails cleanly (`E_CHECKSUM_MISSING`) until the whisper-cpp workflow has pinned a real sha256. */
async function resolveOrProvision(toolchain: TranscribeToolchainPort, toolId: string): Promise<string> {
  try {
    return await toolchain.resolveToolPath(toolId)
  } catch {
    await ensureProvisioned(toolchain, toolId)
    return await toolchain.resolveToolPath(toolId)
  }
}

function unavailableReason(toolId: string, err: unknown): string {
  const envVar = `ENKAKU_${toolId.toUpperCase().replace(/-/g, '_')}_PATH`
  const detail = err instanceof Error ? err.message : String(err)
  return `${toolId} is not provisioned (${detail}) — set ${envVar} for a dev override, or provision it on the Tools page once the toolchain manifest has a real sha256`
}

export function createTranscribeService(deps: TranscribeServiceDeps): TranscribeService {
  const spawn = deps.spawn ?? realSpawn
  const timeoutMs = deps.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS

  async function resolvePaths(): Promise<{ cliPath: string; modelPath: string }> {
    let cliPath: string
    try {
      cliPath = await resolveOrProvision(deps.toolchain, WHISPER_CPP_TOOL_ID)
    } catch (err) {
      throw new EnkakuError('E_TRANSCRIBE_UNAVAILABLE', unavailableReason(WHISPER_CPP_TOOL_ID, err), err)
    }
    let modelPath: string
    try {
      modelPath = await resolveOrProvision(deps.toolchain, WHISPER_MODEL_TOOL_ID)
    } catch (err) {
      throw new EnkakuError('E_TRANSCRIBE_UNAVAILABLE', unavailableReason(WHISPER_MODEL_TOOL_ID, err), err)
    }
    return { cliPath, modelPath }
  }

  /*
    Provisioning started by `status()` runs in the background, one at a time: the whisper model is 190 MB, and a
    status check with a 10-second deadline that waited for it timed out on its very first call while the download
    carried on unseen (measured on the dev farm, 2026-09-14). The last failure is kept so the next status can say it.
  */
  let provisioning: Promise<void> | null = null
  let lastProvisionError: string | null = null

  async function readyPath(toolId: string): Promise<string | null> {
    try {
      return await deps.toolchain.resolveToolPath(toolId)
    } catch {
      return null
    }
  }

  function provisionInBackground(): void {
    if (provisioning) return
    lastProvisionError = null
    provisioning = (async () => {
      for (const toolId of [WHISPER_CPP_TOOL_ID, WHISPER_MODEL_TOOL_ID]) {
        if ((await readyPath(toolId)) !== null) continue
        try {
          await ensureProvisioned(deps.toolchain, toolId)
        } catch (err) {
          lastProvisionError = unavailableReason(toolId, err)
          return
        }
      }
    })().finally(() => {
      provisioning = null
    })
  }

  return {
    async status() {
      const cliPath = await readyPath(WHISPER_CPP_TOOL_ID)
      const modelPath = await readyPath(WHISPER_MODEL_TOOL_ID)
      if (cliPath !== null && modelPath !== null) return { available: true, model: modelPath, reason: null }
      if (lastProvisionError !== null && !provisioning) {
        const reason = lastProvisionError
        // The next status tries again, so a fixed manifest or a restored network recovers without a restart.
        lastProvisionError = null
        return { available: false, model: null, reason }
      }
      provisionInBackground()
      const missing = cliPath === null ? 'whisper.cpp' : 'the Whisper model (190 MB)'
      return { available: false, model: null, reason: `Downloading ${missing} for the first time — check again in a minute.` }
    },

    async transcribe(input) {
      const absPath = resolveArtifactPath(deps, input.artifactId)
      const file = Bun.file(absPath)
      if (!(await file.exists())) throw new EnkakuError('artifact_not_found', 'the artifact file is no longer on disk')
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (!isWav(bytes)) throw new EnkakuError('E_BAD_INPUT', 'send a 16 kHz mono WAV')

      const { cliPath, modelPath } = await resolvePaths()

      const workDir = mkdtempSync(join(tmpdir(), 'enkaku-transcribe-'))
      const outBase = join(workDir, 'out')
      try {
        const cmd = [cliPath, '-m', modelPath, '-f', absPath, '-l', input.language, '-oj', '-of', outBase, '-np']
        const proc = spawn(cmd)
        const stderrTail = readStreamTail(proc.stderr, STDERR_TAIL_BYTES)
        const timer = setTimeout(() => proc.kill(), timeoutMs)
        let exitCode: number
        try {
          exitCode = await proc.exited
        } finally {
          clearTimeout(timer)
        }
        if (exitCode !== 0) {
          const tail = await stderrTail
          throw new EnkakuError('E_TRANSCRIBE_FAILED', `whisper-cli exited ${exitCode}${tail ? `: ${tail}` : ''}`)
        }
        const jsonPath = `${outBase}.json`
        let json: unknown
        try {
          json = JSON.parse(readFileSync(jsonPath, 'utf8'))
        } catch (err) {
          throw new EnkakuError('E_TRANSCRIBE_FAILED', `whisper-cli produced no readable JSON output: ${String(err)}`)
        }
        const parsed = parseWhisperJson(json)
        const speech = isSpeech(parsed.fullText)
        return {
          text: speech ? parsed.fullText : '',
          language: parsed.language,
          speech,
          durationMs: parsed.durationMs,
          segments: parsed.segments,
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    },
  }
}
