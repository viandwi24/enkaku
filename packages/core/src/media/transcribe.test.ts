import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { createTranscribeService, isSpeech, isWav, parseWhisperJson, type TranscribeSpawnResult, type TranscribeToolchainPort } from './transcribe'

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

/** A toolchain that never has anything provisioned and always fails to install (mirrors the real manager's `E_CHECKSUM_MISSING` for `whisper-cpp` until the workflow pins a real sha256). */
function unavailableToolchain(): TranscribeToolchainPort {
  return {
    async resolveToolPath() {
      throw new EnkakuError('E_TOOL_NOT_PROVISIONED', 'not provisioned')
    },
    async activeVersion() {
      return null
    },
    async install() {
      throw new EnkakuError('E_CHECKSUM_MISSING', 'no verified sha256 in the manifest')
    },
    async activate() {},
    manifests: { getTool: () => ({ id: 'whisper-cpp', displayName: 'x', swappable: false, format: 'zip', versions: [{ version: '1', releasedAt: 'unknown', platforms: {} }] }) },
  }
}

describe('createTranscribeService — refusals (plan 317)', () => {
  test('E_BAD_INPUT when the artifact is not a WAV', async () => {
    const { db, dataDir } = setUp()
    writeFileSync(join(dataDir, 'not-a-wav.bin'), Buffer.from([1, 2, 3, 4]))
    insertArtifact(db, 'a1', 'not-a-wav.bin')
    const service = createTranscribeService({ db, dataDir, toolchain: unavailableToolchain() })
    await expect(service.transcribe({ artifactId: 'a1', language: 'auto' })).rejects.toMatchObject({ code: 'E_BAD_INPUT' })
  })

  test('artifact_not_found for an unknown id', async () => {
    const { db, dataDir } = setUp()
    const service = createTranscribeService({ db, dataDir, toolchain: unavailableToolchain() })
    await expect(service.transcribe({ artifactId: 'ghost', language: 'auto' })).rejects.toMatchObject({ code: 'artifact_not_found' })
  })

  test('E_TRANSCRIBE_UNAVAILABLE when whisper-cpp is not provisioned and cannot be', async () => {
    const { db, dataDir } = setUp()
    const wav = new Uint8Array(44)
    wav.set([0x52, 0x49, 0x46, 0x46], 0)
    wav.set([0x57, 0x41, 0x56, 0x45], 8)
    writeFileSync(join(dataDir, 'audio.wav'), wav)
    insertArtifact(db, 'a2', 'audio.wav')
    const service = createTranscribeService({ db, dataDir, toolchain: unavailableToolchain() })
    await expect(service.transcribe({ artifactId: 'a2', language: 'auto' })).rejects.toMatchObject({ code: 'E_TRANSCRIBE_UNAVAILABLE' })
  })

  test('status() reports unavailable with a reason naming the env override', async () => {
    const { db, dataDir } = setUp()
    const service = createTranscribeService({ db, dataDir, toolchain: unavailableToolchain() })
    const status = await service.status()
    expect(status.available).toBe(false)
    expect(status.reason).toContain('ENKAKU_WHISPER_CPP_PATH')
  })
})

describe('createTranscribeService — a successful run (plan 317, fake toolchain + fake spawn)', () => {
  function readyToolchain(): TranscribeToolchainPort {
    return {
      async resolveToolPath(toolId: string) {
        return `/fake/${toolId}`
      },
      async activeVersion() {
        return '1'
      },
      async install() {},
      async activate() {},
      manifests: { getTool: () => null },
    }
  }

  test('parses whisper-cli\'s JSON output file and reports speech', async () => {
    const { db, dataDir } = setUp()
    const wav = new Uint8Array(44)
    wav.set([0x52, 0x49, 0x46, 0x46], 0)
    wav.set([0x57, 0x41, 0x56, 0x45], 8)
    writeFileSync(join(dataDir, 'audio.wav'), wav)
    insertArtifact(db, 'a3', 'audio.wav')

    const fakeSpawn = (cmd: string[]): TranscribeSpawnResult => {
      const ofIndex = cmd.indexOf('-of')
      const outBase = cmd[ofIndex + 1]!
      writeFileSync(
        `${outBase}.json`,
        JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 900 }, text: ' Hello there.' }] }),
      )
      return { exited: Promise.resolve(0), kill: () => {}, stderr: null }
    }

    const service = createTranscribeService({ db, dataDir, toolchain: readyToolchain(), spawn: fakeSpawn })
    const result = await service.transcribe({ artifactId: 'a3', language: 'auto' })
    expect(result.text).toBe('Hello there.')
    expect(result.language).toBe('en')
    expect(result.speech).toBe(true)
    expect(result.durationMs).toBe(900)
    expect(result.segments).toEqual([{ startMs: 0, endMs: 900, text: 'Hello there.' }])
  })

  test('a non-speech-only result reports speech: false and text: \'\'', async () => {
    const { db, dataDir } = setUp()
    const wav = new Uint8Array(44)
    wav.set([0x52, 0x49, 0x46, 0x46], 0)
    wav.set([0x57, 0x41, 0x56, 0x45], 8)
    writeFileSync(join(dataDir, 'silent.wav'), wav)
    insertArtifact(db, 'a4', 'silent.wav')

    const fakeSpawn = (cmd: string[]): TranscribeSpawnResult => {
      const ofIndex = cmd.indexOf('-of')
      const outBase = cmd[ofIndex + 1]!
      writeFileSync(`${outBase}.json`, JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 500 }, text: ' [BLANK_AUDIO]' }] }))
      return { exited: Promise.resolve(0), kill: () => {}, stderr: null }
    }

    const service = createTranscribeService({ db, dataDir, toolchain: readyToolchain(), spawn: fakeSpawn })
    const result = await service.transcribe({ artifactId: 'a4', language: 'auto' })
    expect(result.speech).toBe(false)
    expect(result.text).toBe('')
  })

  test('a non-zero exit is reported as E_TRANSCRIBE_FAILED', async () => {
    const { db, dataDir } = setUp()
    const wav = new Uint8Array(44)
    wav.set([0x52, 0x49, 0x46, 0x46], 0)
    wav.set([0x57, 0x41, 0x56, 0x45], 8)
    writeFileSync(join(dataDir, 'fail.wav'), wav)
    insertArtifact(db, 'a5', 'fail.wav')

    const fakeSpawn = (): TranscribeSpawnResult => ({ exited: Promise.resolve(1), kill: () => {}, stderr: null })
    const service = createTranscribeService({ db, dataDir, toolchain: readyToolchain(), spawn: fakeSpawn })
    await expect(service.transcribe({ artifactId: 'a5', language: 'auto' })).rejects.toMatchObject({ code: 'E_TRANSCRIBE_FAILED' })
  })
})
