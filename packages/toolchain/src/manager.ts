import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { downloadVerified } from './download'
import { entrypointRelPath } from './entrypoints'
import { ToolchainError } from './errors'
import { extractZip, placeRaw } from './extract'
import { checkAdbBinary, checkFileHash } from './health'
import { ManifestStore } from './manifest'
import { ActivePointerStore, createPaths, ensureLayout, type ToolchainPaths } from './paths'
import { currentPlatformKey, pickPlatformKey } from './platform'
import { isRealSha256, type HealthResult, type ToolManifestEntry, type ToolVersion } from './types'

/** Baris katalog install — diimplement core di atas tabel tool_installs. */
export interface ToolInstallRecord {
  id: string
  toolId: string
  version: string
  active: boolean
  sha256: string | null
  installedAt: number | null
}

export interface ToolInstallStore {
  list(): ToolInstallRecord[]
  listByTool(toolId: string): ToolInstallRecord[]
  insert(rec: ToolInstallRecord): void
  delete(toolId: string, version: string): void
  /** Set versi aktif (tx: semua active=false, lalu satu true). */
  setActive(toolId: string, version: string | null): void
}

export type ToolchainEvent =
  | {
      kind: 'install-progress'
      toolId: string
      version: string
      phase: 'download' | 'verify' | 'extract' | 'done' | 'error'
      bytesReceived?: number
      totalBytes?: number | null
      percent?: number | null
      error?: { code: string; message: string }
    }
  | { kind: 'changed'; toolId: string; change: 'installed' | 'activated' | 'deleted' | 'manifest-refreshed' }

export interface AdbSwapHook {
  /**
   * Drain aktivitas adb lama → kill-server (call site tunggal, di core) →
   * commit() (tulis pointer+DB) → start-server binary baru → resume.
   */
  swap(oldBinaryPath: string | null, newBinaryPath: string, commit: () => Promise<void>): Promise<void>
}

export interface ToolchainManagerOptions {
  dataDir: string
  coreVersion: string
  store: ToolInstallStore
  emit?: (ev: ToolchainEvent) => void
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
  remoteManifestUrl?: string
  /** Di-wire core: drain/kill/start saat swap versi adb (plan 02 §4.11). */
  adbSwapHook?: AdbSwapHook
}

export interface ToolStatusEntry {
  id: string
  displayName: string
  swappable: boolean
  managedByCore: boolean
  activeVersion: string | null
  installed: Array<{ version: string; active: boolean; sha256: string | null; installedAt: number | null }>
  available: Array<{
    version: string
    knownGood: boolean
    installable: boolean
    compatibleCoreRange?: string
    compatibleWithThisCore?: boolean
  }>
  health: HealthResult | null
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

export class ToolchainManager {
  readonly manifests: ManifestStore
  private paths: ToolchainPaths
  private pointers: ActivePointerStore
  private platform = currentPlatformKey()
  private healthCache = new Map<string, HealthResult>()
  /** Mutex per-toolId: operasi tool diserialisasi per tool. */
  private locks = new Map<string, Promise<unknown>>()
  /** toolId yang sedang install/operasi in-flight (guard E_TOOL_IN_USE). */
  private inFlight = new Set<string>()

  constructor(private opts: ToolchainManagerOptions) {
    this.paths = createPaths(opts.dataDir)
    this.pointers = new ActivePointerStore(this.paths, (m) => opts.onLog?.('warn', m))
    this.manifests = new ManifestStore({
      dataDir: opts.dataDir,
      remoteUrl: opts.remoteManifestUrl,
      onWarn: (m) => opts.onLog?.('warn', m),
    })
  }

  async init(): Promise<void> {
    ensureLayout(this.paths)
    await this.manifests.loadCache()
    await this.reconcile()
  }

  private withLock<T>(toolId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(toolId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this.locks.set(
      toolId,
      next.catch(() => {}),
    )
    return next
  }

  private mustGetTool(toolId: string): ToolManifestEntry {
    const tool = this.manifests.getTool(toolId)
    if (!tool) throw new ToolchainError('E_TOOL_NOT_FOUND', `tool tidak dikenal: ${toolId}`)
    return tool
  }

  private mustGetVersion(tool: ToolManifestEntry, version: string): ToolVersion {
    const v = tool.versions.find((x) => x.version === version)
    if (!v) throw new ToolchainError('E_VERSION_NOT_IN_MANIFEST', `${tool.id}@${version} tidak ada di manifest`)
    return v
  }

  /** SATU-SATUNYA jalan sah mendapatkan path binary tool (spec §7.8). */
  async resolveToolPath(toolId: string): Promise<string> {
    const envKey = `ENKAKU_${toolId.toUpperCase().replace(/-/g, '_')}_PATH`
    const override = process.env[envKey]
    if (override) {
      this.opts.onLog?.('warn', `pakai override env ${envKey} untuk ${toolId} (dev/test only)`)
      return override
    }
    const ptr = await this.pointers.read(toolId)
    if (!ptr) throw new ToolchainError('E_TOOL_NOT_PROVISIONED', `tool ${toolId} belum ter-provision`)
    return join(this.paths.toolsDir, toolId, ptr.version, entrypointRelPath(toolId, this.platform))
  }

  async activeVersion(toolId: string): Promise<string | null> {
    return (await this.pointers.read(toolId))?.version ?? null
  }

  /** Bentuk response GET /api/tools (plan 02 §4.8). */
  async list(): Promise<ToolStatusEntry[]> {
    const out: ToolStatusEntry[] = []
    for (const tool of this.manifests.manifest().tools) {
      const installed = this.opts.store.listByTool(tool.id)
      const ptr = await this.pointers.read(tool.id)
      out.push({
        id: tool.id,
        displayName: tool.displayName,
        swappable: tool.swappable,
        managedByCore: !tool.swappable,
        activeVersion: ptr?.version ?? null,
        installed: installed.map((r) => ({
          version: r.version,
          active: r.version === ptr?.version,
          sha256: r.sha256,
          installedAt: r.installedAt,
        })),
        available: tool.versions
          .filter((v) => pickPlatformKey(Object.keys(v.platforms), this.platform) !== null)
          .map((v) => ({
            version: v.version,
            knownGood: v.knownGood ?? false,
            installable: tool.swappable && this.artifactFor(v) !== null && isRealSha256(this.artifactFor(v)!.sha256),
            ...(v.compatibleCoreRange
              ? {
                  compatibleCoreRange: v.compatibleCoreRange,
                  compatibleWithThisCore:
                    this.manifests.resolveLockedVersion(tool.id, this.opts.coreVersion) === v.version,
                }
              : {}),
          })),
        health: this.healthCache.get(tool.id) ?? null,
      })
    }
    return out
  }

  private artifactFor(v: ToolVersion) {
    const key = pickPlatformKey(Object.keys(v.platforms), this.platform)
    if (!key) return null
    return v.platforms[key] ?? null
  }

  async install(toolId: string, version: string, opts: { internal?: boolean } = {}): Promise<void> {
    return this.withLock(toolId, async () => {
      const tool = this.mustGetTool(toolId)
      if (!tool.swappable && !opts.internal) {
        throw new ToolchainError(
          'E_NOT_SWAPPABLE',
          `${toolId} is managed by core; its version is pinned to the core release (spec §7.6)`,
        )
      }
      const v = this.mustGetVersion(tool, version)
      const artifact = this.artifactFor(v)
      if (!artifact) {
        throw new ToolchainError('E_PLATFORM_UNSUPPORTED', `${toolId}@${version} tidak punya artifact untuk ${this.platform}`)
      }
      if (!isRealSha256(artifact.sha256)) {
        throw new ToolchainError('E_CHECKSUM_MISSING', `${toolId}@${version} belum punya sha256 terverifikasi di manifest`)
      }
      if (this.opts.store.listByTool(toolId).some((r) => r.version === version)) {
        throw new ToolchainError('E_ALREADY_INSTALLED', `${toolId}@${version} sudah terpasang`)
      }

      this.inFlight.add(toolId)
      const emit = this.opts.emit
      const partPath = join(this.paths.stagingDir, `${toolId}-${version}.part`)
      const stageDir = join(this.paths.stagingDir, `${toolId}-${version}`)
      try {
        // 1. download + sha256 (streaming, progress ter-throttle)
        await downloadVerified({
          artifact,
          dest: partPath,
          toolId,
          version,
          onProgress: (p) =>
            emit?.({
              kind: 'install-progress',
              toolId,
              version,
              phase: p.phase,
              bytesReceived: p.bytesReceived,
              totalBytes: p.totalBytes,
              percent: p.totalBytes ? Math.min(100, Math.round((p.bytesReceived / p.totalBytes) * 100)) : null,
            }),
        })
        // 2. extract ke staging
        emit?.({ kind: 'install-progress', toolId, version, phase: 'extract' })
        rmSync(stageDir, { recursive: true, force: true })
        mkdirSync(stageDir, { recursive: true })
        if (tool.format === 'zip') {
          await extractZip(partPath, stageDir)
          rmSync(partPath, { force: true })
        } else {
          placeRaw(partPath, stageDir, entrypointRelPath(toolId, this.platform))
        }
        // 3. rename atomik ke folder final
        const finalDir = this.paths.versionDir(toolId, version)
        mkdirSync(this.paths.toolDir(toolId), { recursive: true })
        rmSync(finalDir, { recursive: true, force: true })
        renameSync(stageDir, finalDir)
        // 4. catat DB (active=false — activate terpisah)
        this.opts.store.insert({
          id: crypto.randomUUID(),
          toolId,
          version,
          active: false,
          sha256: artifact.sha256,
          installedAt: nowSec(),
        })
        emit?.({ kind: 'install-progress', toolId, version, phase: 'done', percent: 100 })
        emit?.({ kind: 'changed', toolId, change: 'installed' })
        this.opts.onLog?.('info', `terpasang: ${toolId}@${version}`)
      } catch (err) {
        rmSync(partPath, { force: true })
        rmSync(stageDir, { recursive: true, force: true })
        const e = err instanceof ToolchainError ? err : new ToolchainError('E_DOWNLOAD_FAILED', String(err), err)
        emit?.({
          kind: 'install-progress',
          toolId,
          version,
          phase: 'error',
          error: { code: e.code, message: e.message },
        })
        throw e
      } finally {
        this.inFlight.delete(toolId)
      }
    })
  }

  async activate(toolId: string, version: string, opts: { internal?: boolean } = {}): Promise<void> {
    return this.withLock(toolId, async () => {
      const tool = this.mustGetTool(toolId)
      if (!tool.swappable && !opts.internal) {
        throw new ToolchainError(
          'E_NOT_SWAPPABLE',
          `${toolId} is managed by core; its version is pinned to the core release (spec §7.6)`,
        )
      }
      const installed = this.opts.store.listByTool(toolId).find((r) => r.version === version)
      if (!installed) throw new ToolchainError('E_NOT_INSTALLED', `${toolId}@${version} belum terpasang`)

      const candidatePath = join(this.paths.toolsDir, toolId, version, entrypointRelPath(toolId, this.platform))
      // Health check kandidat WAJIB lulus sebelum activate (spec §7.8).
      const health =
        toolId === 'adb' ? await checkAdbBinary(candidatePath) : await checkFileHash(candidatePath, installed.sha256)
      if (!health.ok) {
        throw new ToolchainError('E_HEALTH_CHECK_FAILED', `health check ${toolId}@${version} gagal: ${health.detail}`)
      }

      const commit = async () => {
        await this.pointers.write(toolId, {
          version,
          sha256: installed.sha256 ?? '',
          activatedAt: nowSec(),
        })
        this.opts.store.setActive(toolId, version)
        this.pointers.invalidate(toolId)
        await this.pointers.read(toolId)
      }

      const currentPtr = await this.pointers.read(toolId)
      if (toolId === 'adb' && this.opts.adbSwapHook && currentPtr && currentPtr.version !== version) {
        const oldPath = join(this.paths.toolsDir, toolId, currentPtr.version, entrypointRelPath(toolId, this.platform))
        await this.opts.adbSwapHook.swap(oldPath, candidatePath, commit)
      } else {
        await commit()
      }
      this.healthCache.set(toolId, health)
      this.opts.emit?.({ kind: 'changed', toolId, change: 'activated' })
      this.opts.onLog?.('info', `aktif: ${toolId}@${version}`)
    })
  }

  async remove(toolId: string, version: string): Promise<void> {
    return this.withLock(toolId, async () => {
      this.mustGetTool(toolId)
      const ptr = await this.pointers.read(toolId)
      if (ptr?.version === version) {
        throw new ToolchainError('E_DELETE_ACTIVE', `${toolId}@${version} sedang aktif — pindahkan active dulu`)
      }
      if (this.inFlight.has(toolId)) {
        throw new ToolchainError('E_TOOL_IN_USE', `${toolId} sedang dipakai operasi lain`)
      }
      const installed = this.opts.store.listByTool(toolId).find((r) => r.version === version)
      if (!installed) throw new ToolchainError('E_NOT_INSTALLED', `${toolId}@${version} tidak terpasang`)
      rmSync(this.paths.versionDir(toolId, version), { recursive: true, force: true })
      this.opts.store.delete(toolId, version)
      this.opts.emit?.({ kind: 'changed', toolId, change: 'deleted' })
      this.opts.onLog?.('info', `dihapus: ${toolId}@${version}`)
    })
  }

  async check(toolId: string): Promise<HealthResult> {
    const tool = this.mustGetTool(toolId)
    const ptr = await this.pointers.read(toolId)
    if (!ptr) throw new ToolchainError('E_TOOL_NOT_PROVISIONED', `tool ${toolId} belum ter-provision`)
    const path = join(this.paths.toolsDir, toolId, ptr.version, entrypointRelPath(toolId, this.platform))
    const rec = this.opts.store.listByTool(tool.id).find((r) => r.version === ptr.version)
    const health = toolId === 'adb' ? await checkAdbBinary(path) : await checkFileHash(path, rec?.sha256 ?? null)
    this.healthCache.set(toolId, health)
    return health
  }

  /**
   * Reconcile DB ⇄ disk (plan 02 §3.3): baris DB tanpa folder → hapus;
   * folder valid tanpa baris → adopt (mekanisme pre-baked); pointer tanpa
   * folder → clear.
   */
  async reconcile(): Promise<void> {
    const { readdirSync, existsSync } = await import('node:fs')
    for (const rec of this.opts.store.list()) {
      const entry = join(this.paths.versionDir(rec.toolId, rec.version), entrypointRelPath(rec.toolId, this.platform))
      if (!existsSync(entry)) {
        this.opts.onLog?.('warn', `reconcile: ${rec.toolId}@${rec.version} ada di DB tapi tidak di disk — baris dihapus`)
        this.opts.store.delete(rec.toolId, rec.version)
      }
    }
    for (const tool of this.manifests.manifest().tools) {
      const dir = this.paths.toolDir(tool.id)
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (name === 'active.json' || name.startsWith('.')) continue
        const entry = join(dir, name, entrypointRelPath(tool.id, this.platform))
        if (!existsSync(entry)) continue
        if (this.opts.store.listByTool(tool.id).some((r) => r.version === name)) continue
        this.opts.store.insert({
          id: crypto.randomUUID(),
          toolId: tool.id,
          version: name,
          active: false,
          sha256: null, // hash entrypoint saja bukan hash artifact — jangan diklaim
          installedAt: nowSec(),
        })
        this.opts.onLog?.('info', `reconcile: adopt pre-baked ${tool.id}@${name}`)
      }
      // pointer menunjuk versi yang tidak ada → clear
      const ptr = await this.pointers.read(tool.id)
      if (ptr && !existsSync(join(dir, ptr.version, entrypointRelPath(tool.id, this.platform)))) {
        this.opts.onLog?.('warn', `reconcile: pointer ${tool.id}→${ptr.version} tanpa folder — di-clear`)
        this.pointers.clear(tool.id)
        this.opts.store.setActive(tool.id, null)
      }
      // sinkronkan flag active DB dengan pointer
      const ptr2 = await this.pointers.read(tool.id)
      this.opts.store.setActive(tool.id, ptr2?.version ?? null)
    }
  }

  /**
   * First-run auto-provision (plan 02 §4.10): pastikan tool wajib
   * terpasang + aktif. Versi dipilih: latest knownGood untuk platform ini,
   * fallback latest yang punya artifact platform ini.
   */
  async ensureRequiredTools(ids: string[]): Promise<void> {
    for (const toolId of ids) {
      const tool = this.mustGetTool(toolId)
      const ptr = await this.pointers.read(toolId)
      if (ptr) {
        const health = await this.check(toolId).catch(() => null)
        if (health?.ok) continue
        this.opts.onLog?.('warn', `tool wajib ${toolId} aktif tapi health gagal — re-provision`)
      }
      const candidates = tool.versions.filter((v) => {
        const a = this.artifactFor(v)
        return a !== null && isRealSha256(a.sha256)
      })
      const pick = candidates.find((v) => v.knownGood) ?? candidates[0]
      if (!pick) {
        throw new ToolchainError('E_VERSION_NOT_IN_MANIFEST', `tidak ada versi installable untuk tool wajib ${toolId}`)
      }
      const already = this.opts.store.listByTool(toolId).some((r) => r.version === pick.version)
      if (!already) await this.install(toolId, pick.version, { internal: true })
      await this.activate(toolId, pick.version, { internal: true })
    }
  }
}
