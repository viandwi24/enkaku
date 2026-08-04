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
  openRawCalls = 0
  pmInstall: { output: string; reason: AdbStreamEndReason } = { output: '12345\nSuccess\n', reason: 'closed' }

  async openRaw(_serial: string, _service: string): Promise<RawStream> {
    this.openRawCalls++
    return new FakeSyncPeer(this.fs)
  }

  async exec(_serial: string, cmd: string): Promise<ShellResult> {
    this.execCalls.push(cmd)
    return { stdout: '', stderr: '', exitCode: null }
  }

  async execStream(_serial: string, _cmd: string, opts: AdbStreamOptions): Promise<AdbStreamHandle> {
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
    queueMicrotask(() => {
      if (ended) return
      opts.onData(te.encode(this.pmInstall.output))
      finish(this.pmInstall.reason)
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

describe('TransferService — remote (agent-owned) devices are out of scope for this plan', () => {
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
