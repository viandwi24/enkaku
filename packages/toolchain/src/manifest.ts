import { join } from 'node:path'
import bundled from '../manifest/enkaku-tools.json'
import { ToolchainError } from './errors'
import { ToolsManifestSchema, type ToolManifestEntry, type ToolsManifest } from './types'

export interface ManifestStoreOptions {
  /** app-data dir; cache remote ditulis ke <dataDir>/manifest.cache.json */
  dataDir: string
  /** URL manifest remote (ENKAKU_TOOLS_MANIFEST_URL) — opsional. */
  remoteUrl?: string
  onWarn?: (msg: string) => void
}

/**
 * Sumber manifest (spec §7.3 source abstraction): bundled default →
 * cache remote hasil refresh (kalau valid) menang.
 */
export class ManifestStore {
  private current: ToolsManifest

  constructor(private opts: ManifestStoreOptions) {
    this.current = ToolsManifestSchema.parse(bundled)
  }

  private get cachePath(): string {
    return join(this.opts.dataDir, 'manifest.cache.json')
  }

  /** Load cache remote saat boot (kalau ada & valid); korup → abaikan. */
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
      this.opts.onWarn?.('manifest.cache.json tidak terbaca — pakai bundled')
    }
  }

  /**
   * Refresh: fetch remoteUrl → validasi → tulis cache. Tanpa URL → reload
   * bundled. Gagal parse/fetch → E_MANIFEST_FETCH_FAILED, cache lama utuh.
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
      throw new ToolchainError('E_MANIFEST_FETCH_FAILED', `gagal fetch manifest dari ${url}: ${String(err)}`, err)
    }
    const parsed = ToolsManifestSchema.safeParse(json)
    if (!parsed.success) {
      throw new ToolchainError('E_MANIFEST_FETCH_FAILED', `manifest dari ${url} gagal validasi schema`)
    }
    const tmp = `${this.cachePath}.tmp`
    await Bun.write(tmp, JSON.stringify(parsed.data, null, 2))
    const { renameSync } = await import('node:fs')
    renameSync(tmp, this.cachePath)
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
   * Untuk tool locked (swappable:false): pilih versi yang
   * compatibleCoreRange-nya memuat versi core berjalan. Range invalid /
   * placeholder (TODO-*) dianggap tidak cocok.
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
