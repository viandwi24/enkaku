import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { HealthResult, ToolManifestEntry } from '@enkaku/toolchain'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import {
  createTranscribeService,
  isSpeech,
  isWav,
  parseWhisperJson,
  silentWav,
  type TranscribeSettings,
  type TranscribeSpawnResult,
  type TranscribeToolchainPort,
} from './transcribe'

describe('isWav (plan 317)', () => {
  test('a real RIFF/WAVE header is recognised', () => {
    const bytes = new Uint8Array(44)
    bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
    bytes.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
    expect(isWav(bytes)).toBe(true)
  })

  test('a PNG (or anything else) is not a WAV', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    expect(isWav(png)).toBe(false)
  })

  test('too short to hold a header', () => {
    expect(isWav(new Uint8Array([0x52, 0x49]))).toBe(false)
  })
})

describe('silentWav (plan 318)', () => {
  test('one second at 16 kHz mono 16-bit: a WAV header plus 32,000 zero bytes', () => {
    const wav = silentWav(1)
    expect(isWav(wav)).toBe(true)
    expect(wav.length).toBe(44 + 32_000)
    const view = new DataView(wav.buffer)
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(wav.subarray(44).every((b) => b === 0)).toBe(true)
  })
})

describe('isSpeech (plan 317)', () => {
  test('ordinary text is speech', () => {
    expect(isSpeech('hello, this is a real caption')).toBe(true)
  })

  test('[BLANK_AUDIO] alone is not speech', () => {
    expect(isSpeech('[BLANK_AUDIO]')).toBe(false)
  })

  test('(music) alone is not speech', () => {
    expect(isSpeech('(music)')).toBe(false)
  })

  test('the musical note glyph alone is not speech', () => {
    expect(isSpeech('♪ ♪ ♪')).toBe(false)
  })

  test('empty text is not speech', () => {
    expect(isSpeech('')).toBe(false)
  })

  test('a marker beside real words is still speech', () => {
    expect(isSpeech('[BLANK_AUDIO] hello there')).toBe(true)
  })
})

describe('parseWhisperJson (plan 317)', () => {
  test('the real whisper.cpp -oj shape (examples/cli/cli.cpp output_json)', () => {
    const json = {
      result: { language: 'en' },
      transcription: [
        { offsets: { from: 0, to: 1500 }, text: ' Hello' },
        { offsets: { from: 1500, to: 3200 }, text: ' world.' },
      ],
    }
    const parsed = parseWhisperJson(json)
    expect(parsed.fullText).toBe('Hello world.')
    expect(parsed.language).toBe('en')
    expect(parsed.durationMs).toBe(3200)
    expect(parsed.segments).toEqual([
      { startMs: 0, endMs: 1500, text: 'Hello' },
      { startMs: 1500, endMs: 3200, text: 'world.' },
    ])
  })

  test('malformed input degrades to an empty result, never throws', () => {
    expect(parseWhisperJson(null)).toEqual({ fullText: '', language: null, durationMs: null, segments: [] })
    expect(parseWhisperJson({ garbage: true })).toEqual({ fullText: '', language: null, durationMs: null, segments: [] })
  })
})

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-transcribe-test-'))
  return { db: opened.db as Db, dataDir }
}

function insertArtifact(db: Db, id: string, relPath: string) {
  db.insert(artifacts)
    .values({ id, runId: null, deviceId: null, kind: 'file', label: 'test', path: relPath, sizeBytes: 0, createdAt: new Date(), pinned: false, mimeType: null, width: null, height: null, durationMs: null })
    .run()
}

function writeWav(dataDir: string, name: string) {
  const wav = new Uint8Array(44)
  wav.set([0x52, 0x49, 0x46, 0x46], 0)
  wav.set([0x57, 0x41, 0x56, 0x45], 8)
  writeFileSync(join(dataDir, name), wav)
}

/** An executable file standing in for a local whisper-cli — never run: `checkCli` and `spawn` are faked. */
function fakeExecutable(dir: string): string {
  const path = join(dir, 'whisper-cli')
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

/** The manifest as far as this service reads it: `whisper-cpp` with no pinned build (plan 317's TODO-verify), and four models with real-looking hashes. */
function manifestTool(id: string): ToolManifestEntry | null {
  if (id === 'whisper-cpp') return { id, displayName: 'x', swappable: true, format: 'zip', versions: [{ version: '1.9.4', releasedAt: 'unknown', platforms: {} }] }
  const size: Record<string, number> = { 'whisper-model-tiny': 32152673, 'whisper-model-base': 59707625, 'whisper-model-small': 190085487, 'whisper-model-medium': 539212467 }
  const sizeBytes = size[id]
  if (sizeBytes === undefined) return null
  return { id, displayName: id, swappable: true, format: 'raw', versions: [{ version: '1', releasedAt: '2026-09-14', platforms: { '*': { url: 'https://example.invalid', sha256: 'a'.repeat(64), sizeBytes } } }] }
}

interface FakeToolchainOpts {
  /** Tool ids with an active version, resolving to `/fake/<id>`. */
  active?: string[]
  health?: HealthResult
}

/** A toolchain where only `active` tools are provisioned and every install is refused (mirrors the real manager's `E_CHECKSUM_MISSING` for `whisper-cpp`). */
function fakeToolchain(opts: FakeToolchainOpts = {}): TranscribeToolchainPort & { installs: string[] } {
  const active = new Set(opts.active ?? [])
  const installs: string[] = []
  return {
    installs,
    async resolveToolPath(toolId: string) {
      if (!active.has(toolId)) throw new EnkakuError('E_TOOL_NOT_PROVISIONED', 'not provisioned')
      return `/fake/${toolId}`
    },
    async activeVersion(toolId: string) {
      return active.has(toolId) ? '1' : null
    },
    async install(toolId: string) {
      installs.push(toolId)
      throw new EnkakuError('E_CHECKSUM_MISSING', 'no verified sha256 in the manifest')
    },
    async activate() {},
    async check() {
      return opts.health ?? { ok: true, checkedAt: 0, detail: 'sha256 matches' }
    },
    manifests: { getTool: manifestTool },
  }
}

const noSettings = (): TranscribeSettings => ({ whisperCliPath: '', whisperModel: 'small' })

describe('createTranscribeService — refusals (plan 317)', () => {
  test('E_BAD_INPUT when the artifact is not a WAV', async () => {
    const { db, dataDir } = setUp()
    writeFileSync(join(dataDir, 'not-a-wav.bin'), Buffer.from([1, 2, 3, 4]))
    insertArtifact(db, 'a1', 'not-a-wav.bin')
    const service = createTranscribeService({ db, dataDir, toolchain: fakeToolchain(), env: {} })
    await expect(service.transcribe({ artifactId: 'a1', language: 'auto' })).rejects.toMatchObject({ code: 'E_BAD_INPUT' })
  })

  test('artifact_not_found for an unknown id', async () => {
    const { db, dataDir } = setUp()
    const service = createTranscribeService({ db, dataDir, toolchain: fakeToolchain(), env: {} })
    await expect(service.transcribe({ artifactId: 'ghost', language: 'auto' })).rejects.toMatchObject({ code: 'artifact_not_found' })
  })

  test('E_TRANSCRIBE_UNAVAILABLE when whisper-cpp is not provisioned and cannot be', async () => {
    const { db, dataDir } = setUp()
    writeWav(dataDir, 'audio.wav')
    insertArtifact(db, 'a2', 'audio.wav')
    const service = createTranscribeService({ db, dataDir, toolchain: fakeToolchain(), env: {} })
    await expect(service.transcribe({ artifactId: 'a2', language: 'auto' })).rejects.toMatchObject({ code: 'E_TRANSCRIBE_UNAVAILABLE' })
  })

  test('status() with no whisper-cli and no pinned build says what to do at once, instead of pretending to download', async () => {
    const { db, dataDir } = setUp()
    const service = createTranscribeService({ db, dataDir, toolchain: fakeToolchain(), env: {}, settings: noSettings })
    const status = await service.status()
    expect(status.available).toBe(false)
    expect(status.cli).toMatchObject({ path: null, source: 'missing' })
    expect(status.reason).toContain('brew install whisper-cpp')
    expect(status.reason).not.toContain('Downloading')
  })
})

describe('createTranscribeService — resolution and status (plan 318)', () => {
  test('the settings path wins, and a path that is not executable is refused by the setting\'s name, never skipped', async () => {
    const { db, dataDir } = setUp()
    writeWav(dataDir, 'audio.wav')
    insertArtifact(db, 'b1', 'audio.wav')
    const settings = (): TranscribeSettings => ({ whisperCliPath: join(dataDir, 'no-such-cli'), whisperModel: 'small' })
    // A managed CLI IS available — the bad setting must still win over it.
    const toolchain = fakeToolchain({ active: ['whisper-cpp', 'whisper-model-small'] })
    const service = createTranscribeService({ db, dataDir, toolchain, env: {}, settings })
    const status = await service.status()
    expect(status.available).toBe(false)
    expect(status.cli.source).toBe('setting')
    expect(status.reason).toContain('Settings → AI')
    await expect(service.transcribe({ artifactId: 'b1', language: 'auto' })).rejects.toMatchObject({ code: 'E_TRANSCRIBE_UNAVAILABLE' })
  })

  test('env override, then managed tool, in that order', async () => {
    const { db, dataDir } = setUp()
    const exe = fakeExecutable(dataDir)
    const toolchain = fakeToolchain({ active: ['whisper-cpp', 'whisper-model-small'] })
    const viaEnv = await createTranscribeService({ db, dataDir, toolchain, env: { ENKAKU_WHISPER_CPP_PATH: exe }, settings: noSettings }).status()
    expect(viaEnv.cli).toEqual({ path: exe, source: 'env', detail: null })
    expect(viaEnv.available).toBe(true)
    const managed = await createTranscribeService({ db, dataDir, toolchain, env: {}, settings: noSettings }).status()
    expect(managed.cli).toEqual({ path: '/fake/whisper-cpp', source: 'managed', detail: null })
    expect(managed.model).toBe('/fake/whisper-model-small')
  })

  test('the model list: four entries, sizes from the manifest, the selected one active', async () => {
    const { db, dataDir } = setUp()
    const exe = fakeExecutable(dataDir)
    const toolchain = fakeToolchain({ active: ['whisper-model-tiny', 'whisper-model-small'] })
    const service = createTranscribeService({ db, dataDir, toolchain, env: {}, settings: () => ({ whisperCliPath: exe, whisperModel: 'tiny' }) })
    const status = await service.status()
    expect(status.available).toBe(true)
    expect(status.modelId).toBe('whisper-model-tiny')
    expect(status.models).toEqual([
      { id: 'whisper-model-tiny', name: 'tiny', sizeBytes: 32152673, installed: true, active: true },
      { id: 'whisper-model-base', name: 'base', sizeBytes: 59707625, installed: false, active: false },
      { id: 'whisper-model-small', name: 'small', sizeBytes: 190085487, installed: true, active: false },
      { id: 'whisper-model-medium', name: 'medium', sizeBytes: 539212467, installed: false, active: false },
    ])
  })

  test('status() never waits for a download: it provisions only the SELECTED model in the background, then reports why it failed', async () => {
    const { db, dataDir } = setUp()
    const exe = fakeExecutable(dataDir)
    const toolchain = fakeToolchain()
    const service = createTranscribeService({ db, dataDir, toolchain, env: {}, settings: () => ({ whisperCliPath: exe, whisperModel: 'base' }) })
    const first = await service.status()
    expect(first.available).toBe(false)
    expect(first.reason).toContain('Downloading the Whisper base model')
    expect(first.provisioning).toBe(true)
    // The background attempt (a refused install in this fake) settles on its own; the next status names the failure.
    await Bun.sleep(20)
    const second = await service.status()
    expect(second.available).toBe(false)
    expect(second.provisioning).toBe(false)
    expect(second.reason).toContain('ENKAKU_WHISPER_MODEL_BASE_PATH')
    expect(toolchain.installs).toEqual(['whisper-model-base'])
  })
})

describe('createTranscribeService — a successful run (plan 317, fake toolchain + fake spawn)', () => {
  const ready = () => fakeToolchain({ active: ['whisper-cpp', 'whisper-model-small'] })

  test('parses whisper-cli\'s JSON output file and reports speech', async () => {
    const { db, dataDir } = setUp()
    writeWav(dataDir, 'audio.wav')
    insertArtifact(db, 'a3', 'audio.wav')

    const fakeSpawn = (cmd: string[]): TranscribeSpawnResult => {
      const outBase = cmd[cmd.indexOf('-of') + 1]!
      writeFileSync(
        `${outBase}.json`,
        JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 900 }, text: ' Hello there.' }] }),
      )
      return { exited: Promise.resolve(0), kill: () => {}, stderr: null }
    }

    const service = createTranscribeService({ db, dataDir, toolchain: ready(), env: {}, spawn: fakeSpawn })
    const result = await service.transcribe({ artifactId: 'a3', language: 'auto' })
    expect(result.text).toBe('Hello there.')
    expect(result.language).toBe('en')
    expect(result.speech).toBe(true)
    expect(result.durationMs).toBe(900)
    expect(result.segments).toEqual([{ startMs: 0, endMs: 900, text: 'Hello there.' }])
  })

  test('a non-speech-only result reports speech: false and text: \'\'', async () => {
    const { db, dataDir } = setUp()
    writeWav(dataDir, 'silent.wav')
    insertArtifact(db, 'a4', 'silent.wav')

    const fakeSpawn = (cmd: string[]): TranscribeSpawnResult => {
      const outBase = cmd[cmd.indexOf('-of') + 1]!
      writeFileSync(`${outBase}.json`, JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 500 }, text: ' [BLANK_AUDIO]' }] }))
      return { exited: Promise.resolve(0), kill: () => {}, stderr: null }
    }

    const service = createTranscribeService({ db, dataDir, toolchain: ready(), env: {}, spawn: fakeSpawn })
    const result = await service.transcribe({ artifactId: 'a4', language: 'auto' })
    expect(result.speech).toBe(false)
    expect(result.text).toBe('')
  })

  test('a non-zero exit is reported as E_TRANSCRIBE_FAILED', async () => {
    const { db, dataDir } = setUp()
    writeWav(dataDir, 'fail.wav')
    insertArtifact(db, 'a5', 'fail.wav')

    const fakeSpawn = (): TranscribeSpawnResult => ({ exited: Promise.resolve(1), kill: () => {}, stderr: null })
    const service = createTranscribeService({ db, dataDir, toolchain: ready(), env: {}, spawn: fakeSpawn })
    await expect(service.transcribe({ artifactId: 'a5', language: 'auto' })).rejects.toMatchObject({ code: 'E_TRANSCRIBE_FAILED' })
  })

  test('the model comes from the setting', async () => {
    const { db, dataDir } = setUp()
    writeWav(dataDir, 'audio.wav')
    insertArtifact(db, 'a6', 'audio.wav')
    let argv: string[] = []
    const fakeSpawn = (cmd: string[]): TranscribeSpawnResult => {
      argv = cmd
      writeFileSync(`${cmd[cmd.indexOf('-of') + 1]!}.json`, JSON.stringify({ transcription: [] }))
      return { exited: Promise.resolve(0), kill: () => {}, stderr: null }
    }
    const toolchain = fakeToolchain({ active: ['whisper-cpp', 'whisper-model-medium'] })
    const service = createTranscribeService({ db, dataDir, toolchain, env: {}, spawn: fakeSpawn, settings: () => ({ whisperCliPath: '', whisperModel: 'medium' }) })
    await service.transcribe({ artifactId: 'a6', language: 'id' })
    expect(argv.slice(0, 3)).toEqual(['/fake/whisper-cpp', '-m', '/fake/whisper-model-medium'])
    expect(argv).toContain('id')
  })
})

describe('createTranscribeService — check() (plan 318)', () => {
  test('every step passes on a working setup, and the run transcribes a real generated WAV', async () => {
    const { db, dataDir } = setUp()
    const exe = fakeExecutable(dataDir)
    let sawWav = false
    const fakeSpawn = (cmd: string[]): TranscribeSpawnResult => {
      const wavPath = cmd[cmd.indexOf('-f') + 1]!
      sawWav = existsSync(wavPath) && isWav(new Uint8Array(readFileSync(wavPath)))
      writeFileSync(`${cmd[cmd.indexOf('-of') + 1]!}.json`, JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 1000 }, text: ' [BLANK_AUDIO]' }] }))
      return { exited: Promise.resolve(0), kill: () => {}, stderr: null }
    }
    const service = createTranscribeService({
      db,
      dataDir,
      toolchain: fakeToolchain({ active: ['whisper-model-small'] }),
      env: {},
      spawn: fakeSpawn,
      checkCli: async () => ({ ok: true, checkedAt: 0, detail: 'usage: whisper-cli [options] file0 file1 ...' }),
      settings: () => ({ whisperCliPath: exe, whisperModel: 'small' }),
    })
    const result = await service.check()
    expect(result.steps.map((s) => [s.id, s.status])).toEqual([
      ['cli-found', 'ok'],
      ['cli-runs', 'ok'],
      ['model', 'ok'],
      ['transcribe', 'ok'],
      ['timing', 'ok'],
    ])
    expect(result.ok).toBe(true)
    expect(sawWav).toBe(true)
    expect(result.steps[0]?.detail).toContain(exe)
    expect(result.steps[3]?.detail).toContain('no speech')
  })

  test('no whisper-cli: the first step fails, the dependent ones are skipped, and nothing is downloaded', async () => {
    const { db, dataDir } = setUp()
    const toolchain = fakeToolchain()
    const service = createTranscribeService({ db, dataDir, toolchain, env: {}, settings: noSettings })
    const result = await service.check()
    expect(result.ok).toBe(false)
    expect(result.steps.map((s) => [s.id, s.status])).toEqual([
      ['cli-found', 'fail'],
      ['cli-runs', 'skip'],
      ['model', 'fail'],
      ['transcribe', 'skip'],
      ['timing', 'skip'],
    ])
    expect(toolchain.installs).toEqual([])
  })

  test('a model that fails its sha256 fails the model step, and the run is skipped', async () => {
    const { db, dataDir } = setUp()
    const exe = fakeExecutable(dataDir)
    const service = createTranscribeService({
      db,
      dataDir,
      toolchain: fakeToolchain({ active: ['whisper-model-small'], health: { ok: false, checkedAt: 0, detail: 'sha256 mismatch (actual 000000000000…)' } }),
      env: {},
      checkCli: async () => ({ ok: true, checkedAt: 0, detail: 'usage' }),
      settings: () => ({ whisperCliPath: exe, whisperModel: 'small' }),
    })
    const result = await service.check()
    expect(result.steps.find((s) => s.id === 'model')).toMatchObject({ status: 'fail', detail: 'sha256 mismatch (actual 000000000000…)' })
    expect(result.steps.find((s) => s.id === 'transcribe')?.status).toBe('skip')
  })
})
