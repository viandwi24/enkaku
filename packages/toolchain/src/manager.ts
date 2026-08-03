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
import { isRealSha256, type DeviceArtifact, type HealthResult, type ToolManifestEntry, type ToolVersion } from './types'

/** An install catalogue row — implemented by the core over the tool_installs table. */
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
  /** Set the active version (tx: clear every active flag, then set one). */
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
   * Drain the old adb activity → kill-server (the single call site, in the
   * core) → commit() (write pointer and DB) → start-server on the new binary
   * → resume.
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
  /** Wired by the core: drain/kill/start around an adb version swap (plan 02 §4.11). */
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
  /** Tool ids with an install or operation in flight (guards E_TOOL_IN_USE). */
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
    if (!tool) throw new ToolchainError('E_TOOL_NOT_FOUND', `unknown tool: ${toolId}`)
    return tool
  }

  private mustGetVersion(tool: ToolManifestEntry, version: string): ToolVersion {
    const v = tool.versions.find((x) => x.version === version)
    if (!v) throw new ToolchainError('E_VERSION_NOT_IN_MANIFEST', `${tool.id}@${version} is not in the manifest`)
    return v
  }

  /** The ONLY legitimate way to obtain a tool's binary path (spec §7.8). */
  async resolveToolPath(toolId: string): Promise<string> {
    const envKey = `ENKAKU_${toolId.toUpperCase().replace(/-/g, '_')}_PATH`
    const override = process.env[envKey]
    if (override) {
      this.opts.onLog?.('warn', `using the ${envKey} env override for ${toolId} (dev/test only)`)
      return override
    }
    const ptr = await this.pointers.read(toolId)
    if (!ptr) throw new ToolchainError('E_TOOL_NOT_PROVISIONED', `tool ${toolId} is not provisioned yet`)
    return join(this.paths.toolsDir, toolId, ptr.version, entrypointRelPath(toolId, this.platform))
  }

  async activeVersion(toolId: string): Promise<string | null> {
    return (await this.pointers.read(toolId))?.version ?? null
  }

  /**
   * The manifest's on-device expectation (plan 41 §3.2, §4.1) for the
   * currently active version of `toolId` — `null` when the tool is unknown,
   * not yet provisioned, or the manifest simply has no `deviceArtifact`
   * recorded for that version. Callers must treat `null` as "skip the
   * verification", never as a failure.
   */
  async deviceArtifactExpectation(toolId: string): Promise<DeviceArtifact | null> {
    const tool = this.manifests.getTool(toolId)
    if (!tool) return null
    const version = await this.activeVersion(toolId)
    if (!version) return null
    const v = tool.versions.find((x) => x.version === version)
    return v?.deviceArtifact ?? null
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
        throw new ToolchainError('E_PLATFORM_UNSUPPORTED', `${toolId}@${version} has no artifact for ${this.platform}`)
      }
      if (!isRealSha256(artifact.sha256)) {
        throw new ToolchainError('E_CHECKSUM_MISSING', `${toolId}@${version} has no verified sha256 in the manifest`)
      }
      if (this.opts.store.listByTool(toolId).some((r) => r.version === version)) {
        throw new ToolchainError('E_ALREADY_INSTALLED', `${toolId}@${version} is already installed`)
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
        // 4. record it in the DB (active=false — activation is a separate step)
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
        this.opts.onLog?.('info', `installed: ${toolId}@${version}`)
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
      if (!installed) throw new ToolchainError('E_NOT_INSTALLED', `${toolId}@${version} is not installed`)

      const candidatePath = join(this.paths.toolsDir, toolId, version, entrypointRelPath(toolId, this.platform))
      // The candidate's health check MUST pass before activation (spec §7.8).
      const health =
        toolId === 'adb' ? await checkAdbBinary(candidatePath) : await checkFileHash(candidatePath, installed.sha256)
      if (!health.ok) {
        throw new ToolchainError('E_HEALTH_CHECK_FAILED', `health check failed for ${toolId}@${version}: ${health.detail}`)
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
        throw new ToolchainError('E_DELETE_ACTIVE', `${toolId}@${version} is active — move the active pointer first`)
      }
      if (this.inFlight.has(toolId)) {
        throw new ToolchainError('E_TOOL_IN_USE', `${toolId} is busy with another operation`)
      }
      const installed = this.opts.store.listByTool(toolId).find((r) => r.version === version)
      if (!installed) throw new ToolchainError('E_NOT_INSTALLED', `${toolId}@${version} is not installed`)
      rmSync(this.paths.versionDir(toolId, version), { recursive: true, force: true })
      this.opts.store.delete(toolId, version)
      this.opts.emit?.({ kind: 'changed', toolId, change: 'deleted' })
      this.opts.onLog?.('info', `deleted: ${toolId}@${version}`)
    })
  }

  async check(toolId: string): Promise<HealthResult> {
    const tool = this.mustGetTool(toolId)
    const ptr = await this.pointers.read(toolId)
    if (!ptr) throw new ToolchainError('E_TOOL_NOT_PROVISIONED', `tool ${toolId} is not provisioned yet`)
    const path = join(this.paths.toolsDir, toolId, ptr.version, entrypointRelPath(toolId, this.platform))
    const rec = this.opts.store.listByTool(tool.id).find((r) => r.version === ptr.version)
    const health = toolId === 'adb' ? await checkAdbBinary(path) : await checkFileHash(path, rec?.sha256 ?? null)
    this.healthCache.set(toolId, health)
    return health
  }

  /**
   * Reconcile DB ⇄ disk (plan 02 §3.3): a DB row with no folder is removed;
   * a valid folder with no row is adopted (the pre-baked mechanism); a pointer with
   * folder → clear.
   */
  async reconcile(): Promise<void> {
    const { readdirSync, existsSync } = await import('node:fs')
    for (const rec of this.opts.store.list()) {
      const entry = join(this.paths.versionDir(rec.toolId, rec.version), entrypointRelPath(rec.toolId, this.platform))
      if (!existsSync(entry)) {
        this.opts.onLog?.('warn', `reconcile: ${rec.toolId}@${rec.version} is in the DB but not on disk — row removed`)
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
          sha256: null, // this hashes only the entrypoint, not the artifact — do not claim otherwise
          installedAt: nowSec(),
        })
        this.opts.onLog?.('info', `reconcile: adopt pre-baked ${tool.id}@${name}`)
      }
      // the pointer names a version that does not exist → clear it
      const ptr = await this.pointers.read(tool.id)
      if (ptr && !existsSync(join(dir, ptr.version, entrypointRelPath(tool.id, this.platform)))) {
        this.opts.onLog?.('warn', `reconcile: pointer ${tool.id}→${ptr.version} has no folder — cleared`)
        this.pointers.clear(tool.id)
        this.opts.store.setActive(tool.id, null)
      }
      // bring the DB's active flag in line with the pointer
      const ptr2 = await this.pointers.read(tool.id)
      this.opts.store.setActive(tool.id, ptr2?.version ?? null)
    }
  }

  /**
   * First-run auto-provision (plan 02 §4.10): make sure required tools are
   * installed and active. Version choice: the latest knownGood for this
   * platform, falling back to the latest with an artifact for it.
   */
  async ensureRequiredTools(ids: string[]): Promise<void> {
    for (const toolId of ids) {
      const tool = this.mustGetTool(toolId)
      const ptr = await this.pointers.read(toolId)
      if (ptr) {
        const health = await this.check(toolId).catch(() => null)
        if (health?.ok) continue
        this.opts.onLog?.('warn', `required tool ${toolId} is active but failed its health check — re-provisioning`)
      }
      const candidates = tool.versions.filter((v) => {
        const a = this.artifactFor(v)
        return a !== null && isRealSha256(a.sha256)
      })
      const pick = candidates.find((v) => v.knownGood) ?? candidates[0]
      if (!pick) {
        throw new ToolchainError('E_VERSION_NOT_IN_MANIFEST', `no installable version for the required tool ${toolId}`)
      }
      const already = this.opts.store.listByTool(toolId).some((r) => r.version === pick.version)
      if (!already) await this.install(toolId, pick.version, { internal: true })
      await this.activate(toolId, pick.version, { internal: true })
    }
  }
}
