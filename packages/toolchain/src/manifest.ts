import { join } from 'node:path'
import bundled from '../manifest/enkaku-tools.json'
import { ToolchainError } from './errors'
import { moveFile } from './fs-safe'
import { ToolsManifestSchema, type ToolManifestEntry, type ToolsManifest } from './types'

export interface ManifestStoreOptions {
  /** app-data dir; cache remote ditulis ke <dataDir>/manifest.cache.json */
  dataDir: string
  /** Remote manifest URL (ENKAKU_TOOLS_MANIFEST_URL) — optional. */
  remoteUrl?: string
  onWarn?: (msg: string) => void
}

/**
 * Sumber manifest (spec §7.3 source abstraction): bundled default →
 * a refreshed remote cache wins when it is valid.
 */
export class ManifestStore {
  private current: ToolsManifest

  constructor(private opts: ManifestStoreOptions) {
    this.current = ToolsManifestSchema.parse(bundled)
  }

  private get cachePath(): string {
    return join(this.opts.dataDir, 'manifest.cache.json')
  }

  /** Load the remote cache at boot when present and valid; ignore it if corrupt. */
  async loadCache(): Promise<void> {
    try {
      const file = Bun.file(this.cachePath)
      if (!(await file.exists())) return
      const parsed = ToolsManifestSchema.safeParse(await file.json())
      if (parsed.success) {
        this.current = parsed.data
      } else {
        this.opts.onWarn?.('manifest.cache.json korup — pakai bundled')
      }
    } catch {
      this.opts.onWarn?.('manifest.cache.json is unreadable — falling back to the bundled manifest')
    }
  }

  /**
   * Refresh: fetch remoteUrl → validate → write the cache. With no URL → reload
   * bundled one. A parse or fetch failure raises E_MANIFEST_FETCH_FAILED and leaves the old cache intact.
   */
  async refresh(): Promise<ToolsManifest> {
    const url = this.opts.remoteUrl
    if (!url) {
      this.current = ToolsManifestSchema.parse(bundled)
      return this.current
    }
    let json: unknown
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      json = await res.json()
    } catch (err) {
      throw new ToolchainError('E_MANIFEST_FETCH_FAILED', `failed to fetch the manifest from ${url}: ${String(err)}`, err)
    }
    const parsed = ToolsManifestSchema.safeParse(json)
    if (!parsed.success) {
      throw new ToolchainError('E_MANIFEST_FETCH_FAILED', `the manifest from ${url} failed schema validation`)
    }
    const tmp = `${this.cachePath}.tmp`
    await Bun.write(tmp, JSON.stringify(parsed.data, null, 2))
    await moveFile(tmp, this.cachePath, { onWarn: this.opts.onWarn })
    this.current = parsed.data
    return this.current
  }

  manifest(): ToolsManifest {
    return this.current
  }

  getTool(id: string): ToolManifestEntry | null {
    return this.current.tools.find((t) => t.id === id) ?? null
  }

  /**
   * For locked tools (swappable:false): pick the version whose
   * compatibleCoreRange covers the running core version. An invalid range or
   * placeholders (TODO-*) never count as a match.
   */
  resolveLockedVersion(toolId: string, coreVersion: string): string | null {
    const tool = this.getTool(toolId)
    if (!tool) return null
    for (const v of tool.versions) {
      if (!v.compatibleCoreRange) continue
      try {
        if (Bun.semver.satisfies(coreVersion, v.compatibleCoreRange)) return v.version
      } catch {
        // range placeholder/invalid → skip
      }
    }
    return null
  }
}
