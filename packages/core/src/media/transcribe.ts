import { accessSync, constants as fsConstants, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { z } from 'zod'
import { checkWhisperCli, currentPlatformKey, isRealSha256, pickPlatformKey, type HealthResult, type ToolManifestEntry } from '@enkaku/toolchain'
import {
  WHISPER_MODEL_NAMES,
  type FarmSettings,
  type MediaTranscribeCheckOutput,
  type MediaTranscribeInput,
  type MediaTranscribeOutput,
  type MediaTranscribeStatusOutput,
  type TranscribeCheckStep,
  type TranscribeSegment,
  type WhisperCliSource,
  type WhisperModelEntry,
  type WhisperModelName,
} from '@enkaku/protocol'
import type { Db } from '../db'
import { artifacts } from '../db/schema'
import { eq } from 'drizzle-orm'
import { EnkakuError } from '../util/errors'

/**
 * `media.transcribe` / `.transcribe.status` (plan 317) and `.transcribe.check`
 * (plan 318) — local whisper.cpp transcription of an already-extracted WAV
 * artifact. No ffmpeg anywhere in this path (`media/probe.ts`'s own comment
 * explains the licensing reason): the browser extracts the audio and uploads
 * a 16 kHz mono PCM WAV; this service only ever reads that file and hands it
 * to `whisper-cli`.
 *
 * Which whisper-cli (plan 318), first match wins:
 *   1. `farm_settings.ai.whisperCliPath` — an operator's own build, e.g.
 *      Homebrew's. When set it must be an executable file; otherwise
 *      transcription is unavailable and says so by the setting's name. It is
 *      never silently skipped in favour of 2 or 3.
 *   2. `ENKAKU_WHISPER_CPP_PATH`.
 *   3. The managed `whisper-cpp` tool.
 * Which model: `farm_settings.ai.whisperModel` → tool `whisper-model-<name>`
 * (which itself honours `ENKAKU_WHISPER_MODEL_<NAME>_PATH`).
 */

const WHISPER_CPP_TOOL_ID = 'whisper-cpp'
const WHISPER_CPP_ENV = 'ENKAKU_WHISPER_CPP_PATH'
/** Where the setting lives in Studio — named in every refusal a bad path causes. */
const SETTING_NAME = 'the whisper-cli path (Settings → AI)'

export const whisperModelToolId = (name: WhisperModelName): string => `whisper-model-${name}`
const envKeyFor = (toolId: string): string => `ENKAKU_${toolId.toUpperCase().replace(/-/g, '_')}_PATH`

/** How long a transcription may run before the child process is killed — under the capability's own 30-minute deadline, so the service is the one that actually stops the process rather than leaving it running after `invoke` has already given up on the promise. */
export const TRANSCRIBE_TIMEOUT_MS = 25 * 60_000
/** The doctor's one-second transcription. Generous for `medium` on a CPU-only host, and still inside `media.transcribe.check`'s 120-second deadline after the help run and the model hash. */
export const CHECK_TRANSCRIBE_TIMEOUT_MS = 90_000

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

/** A PCM 16-bit mono WAV of silence — the doctor's input (plan 318). 44-byte header, then zeroed samples. */
export function silentWav(seconds = 1, sampleRate = 16_000): Uint8Array {
  const dataBytes = Math.round(seconds * sampleRate) * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buf)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return new Uint8Array(buf)
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
  /** The toolchain's own health check — sha256 for a model file (plan 318's doctor). */
  check(toolId: string): Promise<HealthResult>
  manifests: { getTool(id: string): ToolManifestEntry | null }
}

export interface TranscribeSpawnResult {
  exited: Promise<number>
  kill(): void
  stderr: ReadableStream<Uint8Array> | null
}

export type TranscribeSettings = Pick<FarmSettings['ai'], 'whisperCliPath' | 'whisperModel'>

export interface TranscribeServiceDeps {
  db: Db
  dataDir: string
  toolchain: TranscribeToolchainPort
  /** `farm_settings.ai`, read fresh on every call. Defaults to no CLI path and the `small` model (plan 317's behaviour). */
  settings?: () => TranscribeSettings
  /** Injectable so a test controls the env overrides this service reports. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Injectable so a test proves the argv without spawning whisper-cli. Defaults to a real `Bun.spawn`. */
  spawn?: (cmd: string[]) => TranscribeSpawnResult
  /** `whisper-cli --help` — injectable for the same reason. Defaults to `@enkaku/toolchain`'s `checkWhisperCli`. */
  checkCli?: (path: string) => Promise<HealthResult>
  timeoutMs?: number
  checkTimeoutMs?: number
}

export interface TranscribeService {
  status(): Promise<MediaTranscribeStatusOutput>
  transcribe(input: MediaTranscribeInput): Promise<MediaTranscribeOutput>
  check(): Promise<MediaTranscribeCheckOutput>
}

interface CliResolution {
  path: string | null
  source: WhisperCliSource
  /** Why the CLI cannot be used; null when it can. */
  detail: string | null
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

/** An existing regular file this process may execute. */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
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

/** `resolveToolPath` already honours `ENKAKU_<TOOL_ID>_PATH` before ever looking at the active pointer — so a dev override works with nothing provisioned. Only when there is none of that does this attempt to install+activate the manifest's pinned version. */
async function resolveOrProvision(toolchain: TranscribeToolchainPort, toolId: string): Promise<string> {
  try {
    return await toolchain.resolveToolPath(toolId)
  } catch {
    await ensureProvisioned(toolchain, toolId)
    return await toolchain.resolveToolPath(toolId)
  }
}

function unavailableReason(toolId: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  const fix =
    toolId === WHISPER_CPP_TOOL_ID
      ? `set ${SETTING_NAME} to a local whisper-cli (for example Homebrew's whisper-cpp), or ${WHISPER_CPP_ENV}`
      : `install it in Settings → AI, or set ${envKeyFor(toolId)}`
  return `${toolId} is not provisioned (${detail}) — ${fix}`
}

const MB = 1024 * 1024
const megabytes = (bytes: number): string => `${Math.round(bytes / MB)} MB`

export function createTranscribeService(deps: TranscribeServiceDeps): TranscribeService {
  const spawn = deps.spawn ?? realSpawn
  const checkCli = deps.checkCli ?? ((path: string) => checkWhisperCli(path))
  const timeoutMs = deps.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS
  const checkTimeoutMs = deps.checkTimeoutMs ?? CHECK_TRANSCRIBE_TIMEOUT_MS
  const settings = deps.settings ?? ((): TranscribeSettings => ({ whisperCliPath: '', whisperModel: 'small' }))
  const env = (): Record<string, string | undefined> => deps.env ?? process.env

  async function readyPath(toolId: string): Promise<string | null> {
    try {
      return await deps.toolchain.resolveToolPath(toolId)
    } catch {
      return null
    }
  }

  /** The manifest pins a verified artifact for this host — i.e. there is something to download at all. */
  function hasPinnedBuild(toolId: string): boolean {
    const version = deps.toolchain.manifests.getTool(toolId)?.versions[0]
    if (!version) return false
    const key = pickPlatformKey(Object.keys(version.platforms), currentPlatformKey())
    const artifact = key ? version.platforms[key as keyof typeof version.platforms] : undefined
    return artifact !== undefined && isRealSha256(artifact.sha256)
  }

  async function resolveCli(): Promise<CliResolution> {
    const settingPath = settings().whisperCliPath.trim()
    if (settingPath) {
      return isExecutableFile(settingPath)
        ? { path: settingPath, source: 'setting', detail: null }
        : { path: settingPath, source: 'setting', detail: `${SETTING_NAME} is ${settingPath}, which is not an executable file on this machine` }
    }
    const envPath = env()[WHISPER_CPP_ENV]
    if (envPath) {
      return isExecutableFile(envPath)
        ? { path: envPath, source: 'env', detail: null }
        : { path: envPath, source: 'env', detail: `${WHISPER_CPP_ENV} is ${envPath}, which is not an executable file on this machine` }
    }
    if ((await deps.toolchain.activeVersion(WHISPER_CPP_TOOL_ID)) !== null) {
      const managed = await readyPath(WHISPER_CPP_TOOL_ID)
      if (managed !== null) return { path: managed, source: 'managed', detail: null }
    }
    const fix = hasPinnedBuild(WHISPER_CPP_TOOL_ID)
      ? `install whisper.cpp, or set ${SETTING_NAME}`
      : `whisper.cpp has no pinned build for this host yet — install it yourself (for example \`brew install whisper-cpp\`) and set ${SETTING_NAME}`
    return { path: null, source: 'missing', detail: `No whisper-cli found: ${fix}.` }
  }

  async function listModels(selectedId: string): Promise<WhisperModelEntry[]> {
    const out: WhisperModelEntry[] = []
    for (const name of WHISPER_MODEL_NAMES) {
      const id = whisperModelToolId(name)
      const artifact = deps.toolchain.manifests.getTool(id)?.versions[0]?.platforms['*']
      const installed = Boolean(env()[envKeyFor(id)]) || (await deps.toolchain.activeVersion(id)) !== null
      out.push({ id, name, sizeBytes: artifact?.sizeBytes ?? 0, installed, active: id === selectedId })
    }
    return out
  }

  /*
    Provisioning started by `status()` runs in the background, one at a time: a whisper model is 30-540 MB, and a
    status check with a 10-second deadline that waited for it timed out on its very first call while the download
    carried on unseen (measured on the dev farm, 2026-09-14). The last failure is kept so the next status can say it.
    Only what the farm needs NOW is ever fetched — the CLI when none resolved, and the SELECTED model (plan 318),
    never every model in the manifest.
  */
  let provisioning: Promise<void> | null = null
  let lastProvisionError: string | null = null

  function provisionInBackground(toolIds: string[]): void {
    if (provisioning || toolIds.length === 0) return
    lastProvisionError = null
    provisioning = (async () => {
      for (const toolId of toolIds) {
        if ((await readyPath(toolId)) !== null) continue
        try {
          await ensureProvisioned(deps.toolchain, toolId)
        } catch (err) {
          lastProvisionError ??= unavailableReason(toolId, err)
        }
      }
    })().finally(() => {
      provisioning = null
    })
  }

  async function resolvePaths(): Promise<{ cliPath: string; modelPath: string }> {
    const cli = await resolveCli()
    let cliPath: string
    if (cli.path !== null && cli.detail === null) {
      cliPath = cli.path
    } else if (cli.source === 'missing') {
      try {
        cliPath = await resolveOrProvision(deps.toolchain, WHISPER_CPP_TOOL_ID)
      } catch (err) {
        throw new EnkakuError('E_TRANSCRIBE_UNAVAILABLE', unavailableReason(WHISPER_CPP_TOOL_ID, err), err)
      }
    } else {
      throw new EnkakuError('E_TRANSCRIBE_UNAVAILABLE', cli.detail ?? 'whisper-cli is not usable')
    }
    const modelId = whisperModelToolId(settings().whisperModel)
    let modelPath: string
    try {
      modelPath = await resolveOrProvision(deps.toolchain, modelId)
    } catch (err) {
      throw new EnkakuError('E_TRANSCRIBE_UNAVAILABLE', unavailableReason(modelId, err), err)
    }
    return { cliPath, modelPath }
  }

  /** One whisper-cli run over `wavPath`, into a fresh temp dir. The caller owns nothing on disk afterwards. */
  async function runWhisper(cliPath: string, modelPath: string, wavPath: string, language: string, killAfterMs: number): Promise<ParsedWhisperOutput> {
    const workDir = mkdtempSync(join(tmpdir(), 'enkaku-transcribe-'))
    const outBase = join(workDir, 'out')
    try {
      const cmd = [cliPath, '-m', modelPath, '-f', wavPath, '-l', language, '-oj', '-of', outBase, '-np']
      const proc = spawn(cmd)
      const stderrTail = readStreamTail(proc.stderr, STDERR_TAIL_BYTES)
      const timer = setTimeout(() => proc.kill(), killAfterMs)
      let exitCode: number
      try {
        exitCode = await proc.exited
      } finally {
        clearTimeout(timer)
      }
      if (exitCode !== 0) {
        const tail = (await stderrTail).trim()
        throw new EnkakuError('E_TRANSCRIBE_FAILED', `whisper-cli exited ${exitCode}${tail ? `: ${tail}` : ''}`)
      }
      let json: unknown
      try {
        json = JSON.parse(readFileSync(`${outBase}.json`, 'utf8'))
      } catch (err) {
        throw new EnkakuError('E_TRANSCRIBE_FAILED', `whisper-cli produced no readable JSON output: ${String(err)}`)
      }
      return parseWhisperJson(json)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  return {
    async status() {
      const cli = await resolveCli()
      const modelName = settings().whisperModel
      const modelId = whisperModelToolId(modelName)
      const modelPath = await readyPath(modelId)
      const models = await listModels(modelId)
      const cliReady = cli.path !== null && cli.detail === null
      const base = { cli, modelId, models }

      if (cliReady && modelPath !== null) return { available: true, model: modelPath, reason: null, ...base, provisioning: provisioning !== null }

      // What cannot be downloaded is said at once, not after a pretend download: a path the operator gave that does
      // not run, or no whisper-cli and no pinned build to fetch. The selected model still downloads meanwhile.
      if (!cliReady && (cli.source !== 'missing' || !hasPinnedBuild(WHISPER_CPP_TOOL_ID))) {
        if (modelPath === null) provisionInBackground([modelId])
        return { available: false, model: null, reason: cli.detail, ...base, provisioning: provisioning !== null }
      }

      if (lastProvisionError !== null && !provisioning) {
        const reason = lastProvisionError
        // The next status tries again, so a fixed manifest or a restored network recovers without a restart.
        lastProvisionError = null
        return { available: false, model: null, reason, ...base, provisioning: false }
      }
      provisionInBackground([...(cliReady ? [] : [WHISPER_CPP_TOOL_ID]), ...(modelPath === null ? [modelId] : [])])
      const size = models.find((m) => m.id === modelId)?.sizeBytes ?? 0
      const missing = !cliReady ? 'whisper.cpp' : `the Whisper ${modelName} model (${megabytes(size)})`
      return {
        available: false,
        model: null,
        reason: `Downloading ${missing} for the first time — check again in a minute.`,
        ...base,
        provisioning: provisioning !== null,
      }
    },

    async transcribe(input) {
      const absPath = resolveArtifactPath(deps, input.artifactId)
      const file = Bun.file(absPath)
      if (!(await file.exists())) throw new EnkakuError('artifact_not_found', 'the artifact file is no longer on disk')
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (!isWav(bytes)) throw new EnkakuError('E_BAD_INPUT', 'send a 16 kHz mono WAV')

      const { cliPath, modelPath } = await resolvePaths()
      const parsed = await runWhisper(cliPath, modelPath, absPath, input.language, timeoutMs)
      const speech = isSpeech(parsed.fullText)
      return {
        text: speech ? parsed.fullText : '',
        language: parsed.language,
        speech,
        durationMs: parsed.durationMs,
        segments: parsed.segments,
      }
    },

    /**
     * The doctor (plan 318). Every step runs or says why it was skipped; it never provisions anything — a check that
     * started a 540 MB download would not be a check.
     */
    async check() {
      const steps: TranscribeCheckStep[] = []
      const skip = (id: string, title: string, why: string) => steps.push({ id, title, status: 'skip', detail: why })

      const cli = await resolveCli()
      const cliFound = cli.path !== null && cli.detail === null
      const SOURCE: Record<WhisperCliSource, string> = { setting: 'from Settings', env: `from ${WHISPER_CPP_ENV}`, managed: 'installed by Enkaku', missing: 'missing' }
      steps.push({ id: 'cli-found', title: 'whisper-cli found', status: cliFound ? 'ok' : 'fail', detail: cliFound ? `${SOURCE[cli.source]}: ${cli.path}` : (cli.detail ?? 'not found') })

      let cliRuns = false
      if (cliFound && cli.path !== null) {
        const health = await checkCli(cli.path)
        cliRuns = health.ok
        steps.push({ id: 'cli-runs', title: 'whisper-cli runs', status: health.ok ? 'ok' : 'fail', detail: health.detail })
      } else {
        skip('cli-runs', 'whisper-cli runs', 'Skipped: no whisper-cli to run.')
      }

      const modelName = settings().whisperModel
      const modelId = whisperModelToolId(modelName)
      const modelTitle = `Model installed (${modelName})`
      let modelPath: string | null = null
      const modelEnv = env()[envKeyFor(modelId)]
      if (modelEnv) {
        const exists = await Bun.file(modelEnv).exists()
        if (exists) modelPath = modelEnv
        steps.push({ id: 'model', title: modelTitle, status: exists ? 'ok' : 'fail', detail: exists ? `from ${envKeyFor(modelId)}: ${modelEnv} (not hashed)` : `${envKeyFor(modelId)} is ${modelEnv}, which does not exist` })
      } else if ((await deps.toolchain.activeVersion(modelId)) === null) {
        steps.push({ id: 'model', title: modelTitle, status: 'fail', detail: `The ${modelName} model is not installed.` })
      } else {
        const health = await deps.toolchain.check(modelId).catch((err: unknown): HealthResult => ({ ok: false, checkedAt: 0, detail: err instanceof Error ? err.message : String(err) }))
        if (health.ok) modelPath = await readyPath(modelId)
        steps.push({ id: 'model', title: modelTitle, status: health.ok ? 'ok' : 'fail', detail: health.detail })
      }

      const TRANSCRIBE_TITLE = 'Transcribes 1 s of silence'
      if (!cliRuns || cli.path === null || modelPath === null) {
        skip('transcribe', TRANSCRIBE_TITLE, 'Skipped: needs a working whisper-cli and an installed model.')
        skip('timing', 'Timing', 'Skipped: nothing was transcribed.')
      } else {
        const workDir = mkdtempSync(join(tmpdir(), 'enkaku-transcribe-check-'))
        try {
          const wavPath = join(workDir, 'silence.wav')
          writeFileSync(wavPath, silentWav(1))
          const started = performance.now()
          try {
            const parsed = await runWhisper(cli.path, modelPath, wavPath, 'en', checkTimeoutMs)
            const elapsedMs = Math.round(performance.now() - started)
            const heard = isSpeech(parsed.fullText) ? `heard "${parsed.fullText.slice(0, 60)}" in silence, which is odd but not a failure` : 'no speech, as expected'
            steps.push({ id: 'transcribe', title: TRANSCRIBE_TITLE, status: 'ok', detail: `exit 0, ${heard}` })
            steps.push({ id: 'timing', title: 'Timing', status: 'ok', detail: `${elapsedMs} ms for 1 s of audio with the ${modelName} model, including model load` })
          } catch (err) {
            const elapsedMs = Math.round(performance.now() - started)
            const message = err instanceof Error ? err.message : String(err)
            steps.push({ id: 'transcribe', title: TRANSCRIBE_TITLE, status: 'fail', detail: elapsedMs >= checkTimeoutMs ? `killed after ${Math.round(checkTimeoutMs / 1000)} s: ${message}` : message })
            skip('timing', 'Timing', 'Skipped: the transcription failed.')
          }
        } finally {
          rmSync(workDir, { recursive: true, force: true })
        }
      }

      return { ok: steps.every((s) => s.status !== 'fail'), steps }
    },
  }
}
