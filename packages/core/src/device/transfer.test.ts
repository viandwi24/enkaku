import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdbStreamEndReason, AdbStreamHandle, AdbStreamOptions, RawStream, ShellResult } from '@enkaku/adb'
import { openDb, runMigrations, type Db } from '../db'
import { artifacts, devices } from '../db/schema'
import type { AdbBackend } from './transfer'
import { createTransferService } from './transfer'

const te = new TextEncoder()
const td = new TextDecoder()

function concatAll(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function encodePacket(id: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  out.set(te.encode(id), 0)
  new DataView(out.buffer).setUint32(4, payload.length, true)
  out.set(payload, 8)
  return out
}

function encodeValuePacket(id: string, value: number): Uint8Array {
  const out = new Uint8Array(8)
  out.set(te.encode(id), 0)
  new DataView(out.buffer).setUint32(4, value, true)
  return out
}

interface FakeFile {
  content: Uint8Array
  /** When set, `STAT` reports this instead of `content.length` — models "the file grew after stat" (plan 39 §3.6). */
  statSizeOverride?: number
}

/** A scripted `sync:` peer backed by a tiny virtual filesystem — enough of the real protocol (SEND/DATA/DONE, RECV, STAT) to drive `TransferService` end to end without a device. */
class FakeSyncPeer implements RawStream {
  forceClosed = false
  private buffer: Uint8Array[] = []
  private bufferLen = 0
  private onData: ((c: Uint8Array) => void) | null = null
  private onEnd: ((err?: unknown) => void) | null = null
  private pendingSendPath: string | null = null
  private pendingSendChunks: Uint8Array[] = []

  constructor(private fs: Map<string, FakeFile>) {}

  write(chunk: Uint8Array): void {
    this.buffer.push(chunk)
    this.bufferLen += chunk.length
    this.tryParse()
  }

  private tryParse(): void {
    for (;;) {
      if (this.bufferLen < 8) return
      const all = concatAll(this.buffer)
      const id = td.decode(all.subarray(0, 4))
      const arg = new DataView(all.buffer, all.byteOffset, 8).getUint32(4, true)
      const len = id === 'DONE' ? 0 : arg
      if (all.length < 8 + len) return
      const payload = id === 'DONE' ? all.subarray(4, 8) : all.subarray(8, 8 + len)
      const rest = all.subarray(8 + len)
      this.buffer = rest.length > 0 ? [rest] : []
      this.bufferLen = rest.length
      this.handle(id, payload)
    }
  }

  private handle(id: string, payload: Uint8Array): void {
    if (id === 'SEND') {
      const spec = td.decode(payload)
      const comma = spec.lastIndexOf(',')
      this.pendingSendPath = comma >= 0 ? spec.slice(0, comma) : spec
      this.pendingSendChunks = []
      return
    }
    if (id === 'DATA') {
      this.pendingSendChunks.push(payload)
      return
    }
    if (id === 'DONE') {
      if (this.pendingSendPath) {
        this.fs.set(this.pendingSendPath, { content: concatAll(this.pendingSendChunks) })
        this.pendingSendPath = null
      }
      this.emit(encodePacket('OKAY', new Uint8Array(0)))
      return
    }
    if (id === 'RECV') {
      const path = td.decode(payload)
      const file = this.fs.get(path)
      if (!file) {
        this.emit(encodePacket('FAIL', te.encode('No such file or directory')))
        return
      }
      for (let off = 0; off < file.content.length; off += 64 * 1024) {
        this.emit(encodePacket('DATA', file.content.subarray(off, Math.min(off + 65536, file.content.length))))
      }
      this.emit(encodeValuePacket('DONE', 0))
      return
    }
    if (id === 'STAT') {
      const path = td.decode(payload)
      const file = this.fs.get(path)
      // A STAT reply is fixed-width and carries NO length prefix: `STAT` plus
      // mode, size and mtime, 16 bytes total. Emitting it through
      // `encodePacket` (which prepends a length) makes this fake speak a
      // protocol no device speaks — that mismatch hid a reader bug that hung
      // `statRemote` against real hardware. Keep this byte-exact.
      const out = new Uint8Array(16)
      out.set(te.encode('STAT'), 0)
      const view = new DataView(out.buffer)
      if (file) {
        view.setUint32(4, 0o100644, true)
        view.setUint32(8, file.statSizeOverride ?? file.content.length, true)
        view.setUint32(12, 1700000000, true)
      }
      this.emit(out)
    }
  }

  private emit(frame: Uint8Array): void {
    this.onData?.(frame)
  }

  streamFrom(onData: (chunk: Uint8Array) => void, onEnd: (err?: unknown) => void): void {
    this.onData = onData
    this.onEnd = onEnd
  }

  close(force?: boolean): void {
    if (force) this.forceClosed = true
    this.onEnd?.()
  }
}

class FakeAdbBackend implements AdbBackend {
  fs = new Map<string, FakeFile>()
  execCalls: string[] = []
  /** Every `pm install ...` (or other lane) command actually run — plan 106 §5 step 106.8's own "assert the flags survive the move" requirement reads this. */
  execStreamCalls: string[] = []
  openRawCalls = 0
  pmInstall: { output: string; reason: AdbStreamEndReason } = { output: '12345\nSuccess\n', reason: 'closed' }
  /** Overrides `pmInstall` per command — the `-g`-refused fallback needs the two attempts to answer differently. */
  pmInstallFor: ((cmd: string) => { output: string; reason: AdbStreamEndReason } | null) | null = null
  /** `dumpsys package <pkg>`'s `runtime permissions:` block, as the grant fallback reads it. `null` = an output the parser finds nothing in. */
  runtimePermissions: Record<string, boolean> | null = null
  /** Media-scan exec results (plan 90 §4.6) — defaults model a device where `scan_file` succeeds outright. */
  scanFileResult: ShellResult | 'throw' = { stdout: '', stderr: '', exitCode: 0 }
  scanVolumeResult: ShellResult | 'throw' = { stdout: '', stderr: '', exitCode: 0 }

  async openRaw(_serial: string, _service: string): Promise<RawStream> {
    this.openRawCalls++
    return new FakeSyncPeer(this.fs)
  }

  async exec(_serial: string, cmd: string): Promise<ShellResult> {
    this.execCalls.push(cmd)
    if (cmd.includes('scan_file')) {
      if (this.scanFileResult === 'throw') throw new Error('adb exec failed (scan_file)')
      return this.scanFileResult
    }
    if (cmd.includes('scan_volume')) {
      if (this.scanVolumeResult === 'throw') throw new Error('adb exec failed (scan_volume)')
      return this.scanVolumeResult
    }
    if (cmd.startsWith('dumpsys package') && this.runtimePermissions) {
      const lines = Object.entries(this.runtimePermissions).map(([name, granted]) => `        ${name}: granted=${granted}, flags=[]`)
      return { stdout: ['Packages:', '    runtime permissions:', ...lines, ''].join('\n'), stderr: '', exitCode: 0 }
    }
    if (cmd.startsWith('pm grant') && this.runtimePermissions) {
      for (const name of Object.keys(this.runtimePermissions)) if (cmd.includes(name)) this.runtimePermissions[name] = true
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    return { stdout: '', stderr: '', exitCode: null }
  }

  async execStream(_serial: string, cmd: string, opts: AdbStreamOptions): Promise<AdbStreamHandle> {
    this.execStreamCalls.push(cmd)
    let ended = false
    const finish = (reason: AdbStreamEndReason) => {
      if (ended) return
      ended = true
      opts.onEnd(reason)
    }
    if (opts.signal) {
      if (opts.signal.aborted) queueMicrotask(() => finish('stopped'))
      else opts.signal.addEventListener('abort', () => finish('stopped'), { once: true })
    }
    const answer = this.pmInstallFor?.(cmd) ?? this.pmInstall
    queueMicrotask(() => {
      if (ended) return
      opts.onData(te.encode(answer.output))
      finish(answer.reason)
    })
    return { pid: null, stop: async () => finish('stopped') }
  }
}

interface TestHarness {
  db: Db
  dataDir: string
  backend: FakeAdbBackend
  service: ReturnType<typeof createTransferService>
  addArtifact(opts: { path: string; content: Uint8Array }): string
}

function harness(opts?: { maxPushBytes?: number; maxPullBytes?: number; installTimeoutMs?: number }): TestHarness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-transfer-test-'))
  opened.db.insert(devices).values({ id: 'dev1', stableId: 'stable1', serial: 'SER1', label: 'Test Device' }).run()

  const backend = new FakeAdbBackend()
  const settings = {
    maxPushBytes: opts?.maxPushBytes ?? 536_870_912,
    maxPullBytes: opts?.maxPullBytes ?? 536_870_912,
    installTimeoutMs: opts?.installTimeoutMs ?? 300_000,
  }
  const service = createTransferService({
    db: opened.db,
    dataDir,
    adb: () => backend,
    settings: () => settings,
  })

  return {
    db: opened.db,
    dataDir,
    backend,
    service,
    addArtifact({ path, content }) {
      const abs = join(dataDir, path)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, content)
      const id = crypto.randomUUID()
      opened.db
        .insert(artifacts)
        .values({ id, kind: 'file', label: path, path, sizeBytes: content.length, createdAt: new Date() })
        .run()
      return id
    },
  }
}

let counter = 0
function nextTransferId(): string {
  counter += 1
  return `t${counter}`
}

describe('TransferService.push', () => {
  test('pushes the resolved artifact bytes to the exact remote path', async () => {
    const h = harness()
    const content = new Uint8Array(5000).fill(3)
    const artifactId = h.addArtifact({ path: 'artifacts/f.bin', content })

    await h.service.push('dev1', artifactId, '/data/local/tmp/out.bin', { transferId: nextTransferId() })

    const written = h.backend.fs.get('/data/local/tmp/out.bin')
    expect(written?.content.length).toBe(content.length)
    expect(written?.content[0]).toBe(3)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('reports progress', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/f.bin', content: new Uint8Array(65536 * 2 + 10) })
    const progress: { sent: number; total: number | null } = { sent: 0, total: null }
    await h.service.push('dev1', artifactId, '/data/local/tmp/out.bin', {
      transferId: nextTransferId(),
      onProgress: (sent, total) => {
        progress.sent = sent
        progress.total = total
      },
    })
    expect(progress.sent).toBe(65536 * 2 + 10)
    expect(progress.total).toBe(65536 * 2 + 10)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('refuses an artifact over maxPushBytes before touching the device', async () => {
    const h = harness({ maxPushBytes: 100 })
    const artifactId = h.addArtifact({ path: 'artifacts/big.bin', content: new Uint8Array(200) })
    await expect(
      h.service.push('dev1', artifactId, '/data/local/tmp/out.bin', { transferId: nextTransferId() }),
    ).rejects.toMatchObject({ code: 'E_TRANSFER_TOO_LARGE' })
    expect(h.backend.openRawCalls).toBe(0)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('refuses a non-artifact source: an unknown artifactId (plan 39 §3.5, acceptance #8)', async () => {
    const h = harness()
    await expect(
      h.service.push('dev1', 'not-a-real-artifact-id', '/data/local/tmp/out.bin', { transferId: nextTransferId() }),
    ).rejects.toMatchObject({ code: 'artifact_not_found' })
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('rejects a remotePath containing ".." before opening any device connection', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/f.bin', content: new Uint8Array(10) })
    await expect(
      h.service.push('dev1', artifactId, '/data/local/tmp/../../etc/passwd', { transferId: nextTransferId() }),
    ).rejects.toMatchObject({ code: 'E_BAD_PATH' })
    expect(h.backend.openRawCalls).toBe(0)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('cancelling mid-push aborts and force-closes the stream', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/big.bin', content: new Uint8Array(65536 * 5) })
    const transferId = nextTransferId()
    let cancelled = false
    const promise = h.service.push('dev1', artifactId, '/data/local/tmp/out.bin', {
      transferId,
      onProgress: (sent) => {
        if (sent > 0 && !cancelled) {
          cancelled = true
          h.service.cancel(transferId)
        }
      },
    })
    await expect(promise).rejects.toMatchObject({ code: 'E_ADB_ABORTED' })
    rmSync(h.dataDir, { recursive: true, force: true })
  })
})

describe('TransferService.push — mediaScan (plan 90 §3.4, §4.6)', () => {
  test('auto: a path outside any media root is not scanned, and pays nothing for it (acceptance #21)', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/f.jpg', content: new Uint8Array(10) })

    const result = await h.service.push('dev1', artifactId, '/data/local/tmp/out.bin', { transferId: nextTransferId() })

    expect(result.mediaScan).toEqual({ ran: false, method: null, ms: 0 })
    expect(h.backend.execCalls.some((c) => c.includes('content call'))).toBe(false)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('auto: a path under /sdcard/Pictures is scanned with scan_file, shell-quoted (H3)', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/f.jpg', content: new Uint8Array(10) })

    const result = await h.service.push('dev1', artifactId, '/sdcard/Pictures/f.jpg', { transferId: nextTransferId() })

    expect(result.mediaScan.ran).toBe(true)
    expect(result.mediaScan.method).toBe('scan_file')
    expect(typeof result.mediaScan.ms).toBe('number')
    expect(h.backend.execCalls).toEqual([
      `content call --uri content://media --method scan_file --arg '/sdcard/Pictures/f.jpg'`,
    ])
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('auto: the /storage/emulated/0 spelling of a media root also scans', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/f.mp4', content: new Uint8Array(10) })

    const result = await h.service.push('dev1', artifactId, '/storage/emulated/0/Movies/f.mp4', {
      transferId: nextTransferId(),
    })

    expect(result.mediaScan).toMatchObject({ ran: true, method: 'scan_file' })
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('scan_file failing falls back to scan_volume — the first to exit 0 wins (H3)', async () => {
    const h = harness()
    h.backend.scanFileResult = { stdout: '', stderr: 'no such method', exitCode: 1 }
    const artifactId = h.addArtifact({ path: 'artifacts/f.jpg', content: new Uint8Array(10) })

    const result = await h.service.push('dev1', artifactId, '/sdcard/Pictures/f.jpg', { transferId: nextTransferId() })

    expect(result.mediaScan).toMatchObject({ ran: true, method: 'scan_volume' })
    expect(h.backend.execCalls).toEqual([
      `content call --uri content://media --method scan_file --arg '/sdcard/Pictures/f.jpg'`,
      `content call --uri content://media --method scan_volume --arg external_primary`,
    ])
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('both scan_file and scan_volume failing degrades visibly — never fails the push, and the bytes still landed', async () => {
    const h = harness()
    h.backend.scanFileResult = { stdout: '', stderr: '', exitCode: 1 }
    h.backend.scanVolumeResult = { stdout: '', stderr: '', exitCode: 1 }
    const artifactId = h.addArtifact({ path: 'artifacts/f.jpg', content: new Uint8Array(10).fill(9) })

    const result = await h.service.push('dev1', artifactId, '/sdcard/Pictures/f.jpg', { transferId: nextTransferId() })

    expect(result.mediaScan.ran).toBe(false)
    expect(result.mediaScan.method).toBeNull()
    expect(result.mediaScan.error).toBeDefined()
    expect(h.backend.fs.get('/sdcard/Pictures/f.jpg')?.content.length).toBe(10)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('both scan_file and scan_volume throwing (e.g. the device drops mid-scan) also degrades visibly, never throws', async () => {
    const h = harness()
    h.backend.scanFileResult = 'throw'
    h.backend.scanVolumeResult = 'throw'
    const artifactId = h.addArtifact({ path: 'artifacts/f.jpg', content: new Uint8Array(10) })

    const result = await h.service.push('dev1', artifactId, '/sdcard/Pictures/f.jpg', { transferId: nextTransferId() })

    expect(result.mediaScan).toMatchObject({ ran: false, method: null })
    expect(result.mediaScan.error).toBeDefined()
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test("mediaScan: 'never' issues no scan even under a media root (regression watch §7.4)", async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/f.jpg', content: new Uint8Array(10) })

    const result = await h.service.push('dev1', artifactId, '/sdcard/Pictures/f.jpg', {
      transferId: nextTransferId(),
      mediaScan: 'never',
    })

    expect(result.mediaScan).toEqual({ ran: false, method: null, ms: 0 })
    expect(h.backend.execCalls.some((c) => c.includes('content call'))).toBe(false)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test("mediaScan: 'always' scans even a path outside any media root", async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/f.bin', content: new Uint8Array(10) })

    const result = await h.service.push('dev1', artifactId, '/data/local/tmp/out.bin', {
      transferId: nextTransferId(),
      mediaScan: 'always',
    })

    expect(result.mediaScan).toMatchObject({ ran: true, method: 'scan_file' })
    rmSync(h.dataDir, { recursive: true, force: true })
  })
})

describe('TransferService.pull', () => {
  test('round-trips a remote file into a device-scoped artifact', async () => {
    const h = harness()
    const content = new Uint8Array(70000).map((_, i) => i % 200)
    h.backend.fs.set('/sdcard/report.txt', { content })

    const result = await h.service.pull('dev1', '/sdcard/report.txt', { transferId: nextTransferId() })

    expect(result.bytes).toBe(content.length)
    const row = h.db.select().from(artifacts).all().find((r) => r.id === result.artifactId)
    expect(row).toBeDefined()
    expect(row?.deviceId).toBe('dev1')
    expect(row?.jobId).toBeNull()
    const abs = join(h.dataDir, row!.path)
    const onDisk = readFileSync(abs)
    expect(onDisk.length).toBe(content.length)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('threads opts.jobId onto the registered artifact — plan 93 §3.13, §4.6, F12: without this, a bulk pull\'s files cannot be traced back to the batch that produced them', async () => {
    const h = harness()
    h.backend.fs.set('/sdcard/report.txt', { content: new Uint8Array([1, 2, 3]) })

    const result = await h.service.pull('dev1', '/sdcard/report.txt', { transferId: nextTransferId(), jobId: 'job-abc' })

    const row = h.db.select().from(artifacts).all().find((r) => r.id === result.artifactId)
    expect(row?.jobId).toBe('job-abc')
    expect(row?.deviceId).toBe('dev1')
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('a missing remote path is refused with E_NOT_FOUND', async () => {
    const h = harness()
    await expect(h.service.pull('dev1', '/nope', { transferId: nextTransferId() })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('cap enforcement #1: stat refuses before any bytes move', async () => {
    const h = harness({ maxPullBytes: 1000 })
    h.backend.fs.set('/sdcard/huge.bin', { content: new Uint8Array(2000) })
    await expect(h.service.pull('dev1', '/sdcard/huge.bin', { transferId: nextTransferId() })).rejects.toMatchObject({
      code: 'E_TRANSFER_TOO_LARGE',
    })
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('cap enforcement #2: a file that grew past stat time is aborted mid-stream', async () => {
    const h = harness({ maxPullBytes: 1000 })
    // `stat` reports 500 bytes (under the cap); the peer actually streams 2000 — the growing-file case (plan 39 §3.6).
    h.backend.fs.set('/sdcard/grows.bin', { content: new Uint8Array(2000), statSizeOverride: 500 })
    await expect(h.service.pull('dev1', '/sdcard/grows.bin', { transferId: nextTransferId() })).rejects.toMatchObject({
      code: 'E_ADB_PULL_TOO_LARGE',
    })
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('rejects a remotePath containing metacharacters', async () => {
    const h = harness()
    await expect(
      h.service.pull('dev1', '/sdcard/a;rm -rf /', { transferId: nextTransferId() }),
    ).rejects.toMatchObject({ code: 'E_BAD_PATH' })
    rmSync(h.dataDir, { recursive: true, force: true })
  })
})

describe('TransferService.install', () => {
  test('refuses a non-.apk artifact', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/f.txt', content: new Uint8Array(10) })
    await expect(h.service.install('dev1', artifactId, { transferId: nextTransferId() })).rejects.toMatchObject({
      code: 'E_BAD_REQUEST',
    })
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('succeeds, parses the package when pm install reports one, and stages under /data/local/tmp/enkaku-*.apk', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/app.apk', content: new Uint8Array(1000).fill(1) })
    h.backend.pmInstall = { output: '999\nSuccess: com.example.app\n', reason: 'closed' }

    const result = await h.service.install('dev1', artifactId, { transferId: nextTransferId() })

    expect(result.package).toBe('com.example.app')
    expect(result.output).toContain('Success')
    const stagedPaths = [...h.backend.fs.keys()]
    expect(stagedPaths.length).toBe(1)
    expect(stagedPaths[0]).toMatch(/^\/data\/local\/tmp\/enkaku-.*\.apk$/)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('a failed pm install reports the parsed reason, not a generic error (acceptance #3)', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/app.apk', content: new Uint8Array(10) })
    h.backend.pmInstall = { output: '1\nFailure [INSTALL_FAILED_VERSION_DOWNGRADE]\n', reason: 'closed' }

    await expect(h.service.install('dev1', artifactId, { transferId: nextTransferId() })).rejects.toMatchObject({
      code: 'E_INSTALL_FAILED',
      message: 'INSTALL_FAILED_VERSION_DOWNGRADE',
    })
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('the staged file is deleted in a finally on success (acceptance #4)', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/app.apk', content: new Uint8Array(10) })
    h.backend.pmInstall = { output: 'Success\n', reason: 'closed' }

    await h.service.install('dev1', artifactId, { transferId: nextTransferId() })

    const rmCalls = h.backend.execCalls.filter((c) => c.startsWith('rm -f'))
    expect(rmCalls.length).toBe(1)
    expect(rmCalls[0]).toMatch(/enkaku-.*\.apk/)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('the staged file is deleted in a finally on a failed install (acceptance #4)', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/app.apk', content: new Uint8Array(10) })
    h.backend.pmInstall = { output: 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]', reason: 'closed' }

    await expect(h.service.install('dev1', artifactId, { transferId: nextTransferId() })).rejects.toBeDefined()

    const rmCalls = h.backend.execCalls.filter((c) => c.startsWith('rm -f'))
    expect(rmCalls.length).toBe(1)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('the staged file is deleted in a finally on cancel (acceptance #4, #9)', async () => {
    const h = harness()
    const artifactId = h.addArtifact({ path: 'artifacts/app.apk', content: new Uint8Array(65536 * 4) })
    const transferId = nextTransferId()
    let cancelled = false

    const promise = h.service.install('dev1', artifactId, {
      transferId,
      onProgress: (sent) => {
        if (sent > 0 && !cancelled) {
          cancelled = true
          h.service.cancel(transferId)
        }
      },
    })

    await expect(promise).rejects.toBeDefined()
    const rmCalls = h.backend.execCalls.filter((c) => c.startsWith('rm -f'))
    expect(rmCalls.length).toBe(1)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('refuses an artifact over maxPushBytes before touching the device', async () => {
    const h = harness({ maxPushBytes: 10 })
    const artifactId = h.addArtifact({ path: 'artifacts/app.apk', content: new Uint8Array(20) })
    await expect(h.service.install('dev1', artifactId, { transferId: nextTransferId() })).rejects.toMatchObject({
      code: 'E_TRANSFER_TOO_LARGE',
    })
    expect(h.backend.openRawCalls).toBe(0)
    rmSync(h.dataDir, { recursive: true, force: true })
  })
})

/**
 * Plan 106 §5 step 106.8 — device preparation (`ui-server-component.ts`)
 * routes its APK installs through THIS method instead of one opaque
 * `hostAdb install` call. Same `performInstall` machinery `install()` uses
 * above (the tests deliberately mirror that describe block's own cases), the
 * one difference being the source: a caller-resolved absolute LOCAL path,
 * never a row in the `artifacts` table (a toolchain-managed APK the operator
 * never uploaded).
 */
describe('TransferService.installFromLocalApk (plan 106 §5 step 106.8)', () => {
  function writeLocalApk(h: TestHarness, name: string, content: Uint8Array): string {
    const abs = join(h.dataDir, name)
    writeFileSync(abs, content)
    return abs
  }

  test('-r and -g both apply by default — the flags must survive the move off hostAdb install -r -g', async () => {
    const h = harness()
    const abs = writeLocalApk(h, 'ui-server.apk', new Uint8Array(10))
    h.backend.pmInstall = { output: 'Success\n', reason: 'closed' }

    await h.service.installFromLocalApk('dev1', abs, { transferId: nextTransferId() })

    expect(h.backend.execStreamCalls.length).toBe(1)
    expect(h.backend.execStreamCalls[0]).toContain('pm install -r -g ')
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('reinstall: false / grantPermissions: false drop -r / -g respectively', async () => {
    const h = harness()
    const abs = writeLocalApk(h, 'ui-server.apk', new Uint8Array(10))
    h.backend.pmInstall = { output: 'Success\n', reason: 'closed' }

    await h.service.installFromLocalApk('dev1', abs, { transferId: nextTransferId(), reinstall: false, grantPermissions: false })

    const cmd = h.backend.execStreamCalls[0] ?? ''
    expect(cmd).not.toContain('-r')
    expect(cmd).not.toContain('-g')
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('no row is ever added to the artifacts table — a preparation install never fabricates one for a file the operator never uploaded', async () => {
    const h = harness()
    const abs = writeLocalApk(h, 'ui-server.apk', new Uint8Array(10))
    h.backend.pmInstall = { output: 'Success\n', reason: 'closed' }

    await h.service.installFromLocalApk('dev1', abs, { transferId: nextTransferId() })

    expect(h.db.select().from(artifacts).all().length).toBe(0)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('pm install exiting 0 while printing "Failure [...]" is still recorded as a failure with the verbatim reason — never a false success (the owner\'s own INSTALL_FAILED_VERIFICATION_FAILURE)', async () => {
    const h = harness()
    const abs = writeLocalApk(h, 'ui-server.apk', new Uint8Array(10))
    // `reason: 'closed'` models pm's real behaviour on some builds: the
    // shell command exits cleanly (stream closes normally) while stdout
    // itself carries the failure — `parseInstallOutput` decides from the
    // TEXT, never an exit code, exactly because of this case.
    h.backend.pmInstall = { output: '1\nFailure [INSTALL_FAILED_VERIFICATION_FAILURE]\n', reason: 'closed' }

    await expect(h.service.installFromLocalApk('dev1', abs, { transferId: nextTransferId() })).rejects.toMatchObject({
      code: 'E_INSTALL_FAILED',
      message: 'INSTALL_FAILED_VERIFICATION_FAILURE',
    })
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('the staged file is deleted in a finally on success', async () => {
    const h = harness()
    const abs = writeLocalApk(h, 'ui-server.apk', new Uint8Array(10))
    h.backend.pmInstall = { output: 'Success\n', reason: 'closed' }

    await h.service.installFromLocalApk('dev1', abs, { transferId: nextTransferId() })

    const rmCalls = h.backend.execCalls.filter((c) => c.startsWith('rm -f'))
    expect(rmCalls.length).toBe(1)
    expect(rmCalls[0]).toMatch(/enkaku-.*\.apk/)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('the staged file is deleted in a finally on a failed pm install', async () => {
    const h = harness()
    const abs = writeLocalApk(h, 'ui-server.apk', new Uint8Array(10))
    h.backend.pmInstall = { output: 'Failure [INSTALL_FAILED_VERIFICATION_FAILURE]', reason: 'closed' }

    await expect(h.service.installFromLocalApk('dev1', abs, { transferId: nextTransferId() })).rejects.toBeDefined()

    const rmCalls = h.backend.execCalls.filter((c) => c.startsWith('rm -f'))
    expect(rmCalls.length).toBe(1)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('the staged file is deleted in a finally on cancel — mid-transfer, not just a hard process kill', async () => {
    const h = harness()
    const abs = writeLocalApk(h, 'ui-server.apk', new Uint8Array(65536 * 4))
    const transferId = nextTransferId()
    let cancelled = false

    const promise = h.service.installFromLocalApk('dev1', abs, {
      transferId,
      onProgress: (sent) => {
        if (sent > 0 && !cancelled) {
          cancelled = true
          h.service.cancel(transferId)
        }
      },
    })

    await expect(promise).rejects.toBeDefined()
    const rmCalls = h.backend.execCalls.filter((c) => c.startsWith('rm -f'))
    expect(rmCalls.length).toBe(1)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('refuses an apk over maxPushBytes before touching the device', async () => {
    const h = harness({ maxPushBytes: 5 })
    const abs = writeLocalApk(h, 'ui-server.apk', new Uint8Array(20))
    await expect(h.service.installFromLocalApk('dev1', abs, { transferId: nextTransferId() })).rejects.toMatchObject({
      code: 'E_TRANSFER_TOO_LARGE',
    })
    expect(h.backend.openRawCalls).toBe(0)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('a missing local file is refused with a clear error, never a silent hang', async () => {
    const h = harness()
    await expect(h.service.installFromLocalApk('dev1', join(h.dataDir, 'nope.apk'), { transferId: nextTransferId() })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
    rmSync(h.dataDir, { recursive: true, force: true })
  })
})

describe('TransferService — remote (node-owned) devices are out of scope for this plan', () => {
  test('refuses with a clear, coded error rather than silently misbehaving', async () => {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-transfer-test-'))
    opened.db.insert(devices).values({ id: 'dev1', stableId: 'stable1', serial: 'SER1', label: 'Test' }).run()
    const backend = new FakeAdbBackend()
    const service = createTransferService({
      db: opened.db,
      dataDir,
      adb: () => backend,
      isRemote: () => true,
      settings: () => ({ maxPushBytes: 1e9, maxPullBytes: 1e9, installTimeoutMs: 300_000 }),
    })
    await expect(service.pull('dev1', '/sdcard/x', { transferId: nextTransferId() })).rejects.toMatchObject({
      code: 'E_UNSUPPORTED',
    })
    rmSync(dataDir, { recursive: true, force: true })
  })
})

/**
 * A platform that refuses the `-g` flag itself (a Xiaomi 25128PC17G on
 * HyperOS/Android 16 does, for every install: guest agent and both ui-server
 * APKs). `-g` is a convenience; the permissions it would have granted can be
 * granted by hand afterwards. What must NOT happen is a blind retry of every
 * failed install, or a package installed without its permissions being
 * reported as a success.
 */
describe('TransferService — a device that refuses the -g install flag', () => {
  const G_REJECTION =
    "Exception occurred while executing 'install':\n" +
    'java.lang.SecurityException: You need the android.permission.INSTALL_GRANT_RUNTIME_PERMISSIONS permission to use the ' +
    'PackageManager.INSTALL_GRANT_ALL_REQUESTED_PERMISSIONS flag\n' +
    '\tat com.android.server.pm.PackageInstallerService.createSessionInternal(PackageInstallerService.java:973)'

  function writeLocalApk(h: TestHarness, name: string): string {
    const abs = join(h.dataDir, name)
    writeFileSync(abs, new Uint8Array(10))
    return abs
  }

  test('retries without -g and grants the runtime permissions explicitly, naming what it did', async () => {
    const h = harness()
    const abs = writeLocalApk(h, 'ui-server.apk')
    h.backend.runtimePermissions = { 'android.permission.POST_NOTIFICATIONS': false, 'android.permission.READ_PHONE_STATE': false }
    h.backend.pmInstallFor = (cmd) => (cmd.includes('-g') ? { output: G_REJECTION, reason: 'closed' } : { output: 'Success\n', reason: 'closed' })

    const result = await h.service.installFromLocalApk('dev1', abs, { transferId: nextTransferId(), packageName: 'com.github.uiautomator' })

    expect(h.backend.execStreamCalls[0]).toContain('pm install -r -g ')
    expect(h.backend.execStreamCalls[1]).toContain('pm install -r ')
    expect(h.backend.execStreamCalls[1]).not.toContain('-g')
    expect(h.backend.execCalls.filter((c) => c.startsWith('pm grant'))).toHaveLength(2)
    expect(h.backend.runtimePermissions).toEqual({ 'android.permission.POST_NOTIFICATIONS': true, 'android.permission.READ_PHONE_STATE': true })
    expect(result.output).toContain('refuses the -g install flag')
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('a grant that does not take fails the install — an app without its permissions is never reported as installed-and-fine', async () => {
    const h = harness()
    const abs = writeLocalApk(h, 'ui-server.apk')
    h.backend.runtimePermissions = { 'android.permission.POST_NOTIFICATIONS': false }
    // `pm grant` answers 0 and changes nothing — the readback is what catches it.
    h.backend.exec = async (_serial: string, cmd: string) => {
      h.backend.execCalls.push(cmd)
      if (cmd.startsWith('dumpsys package')) {
        return { stdout: ['Packages:', '    runtime permissions:', '        android.permission.POST_NOTIFICATIONS: granted=false, flags=[]', ''].join('\n'), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    h.backend.pmInstallFor = (cmd) => (cmd.includes('-g') ? { output: G_REJECTION, reason: 'closed' } : { output: 'Success\n', reason: 'closed' })

    await expect(
      h.service.installFromLocalApk('dev1', abs, { transferId: nextTransferId(), packageName: 'com.github.uiautomator' }),
    ).rejects.toThrow(/could not be granted/)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('an ordinary install failure is NOT retried — the fallback is aimed at one specific rejection', async () => {
    const h = harness()
    const abs = writeLocalApk(h, 'ui-server.apk')
    h.backend.pmInstall = { output: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n', reason: 'closed' }

    await expect(h.service.installFromLocalApk('dev1', abs, { transferId: nextTransferId(), packageName: 'x.y' })).rejects.toMatchObject({
      code: 'E_INSTALL_FAILED',
    })
    expect(h.backend.execStreamCalls).toHaveLength(1)
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  test('without a package name the install still lands, and the result SAYS the permissions were not granted', async () => {
    const h = harness()
    const abs = writeLocalApk(h, 'operator-upload.apk')
    h.backend.pmInstallFor = (cmd) => (cmd.includes('-g') ? { output: G_REJECTION, reason: 'closed' } : { output: 'Success\n', reason: 'closed' })

    const result = await h.service.installFromLocalApk('dev1', abs, { transferId: nextTransferId() })

    expect(result.output).toContain('runtime permissions were NOT granted')
    expect(h.backend.execCalls.filter((c) => c.startsWith('pm grant'))).toHaveLength(0)
    rmSync(h.dataDir, { recursive: true, force: true })
  })
})
