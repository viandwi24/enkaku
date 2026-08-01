import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ActivePointerSchema, type ActivePointer } from './types'

export interface ToolchainPaths {
  toolsDir: string
  stagingDir: string
  toolDir(toolId: string): string
  versionDir(toolId: string, version: string): string
  pointerPath(toolId: string): string
}

export function createPaths(dataDir: string): ToolchainPaths {
  const toolsDir = join(dataDir, 'tools')
  const stagingDir = join(toolsDir, '.staging')
  return {
    toolsDir,
    stagingDir,
    toolDir: (toolId) => join(toolsDir, toolId),
    versionDir: (toolId, version) => join(toolsDir, toolId, version),
    pointerPath: (toolId) => join(toolsDir, toolId, 'active.json'),
  }
}

/** Buat layout + bersihkan .staging (sisa crash) saat boot. */
export function ensureLayout(paths: ToolchainPaths): void {
  mkdirSync(paths.toolsDir, { recursive: true })
  rmSync(paths.stagingDir, { recursive: true, force: true })
  mkdirSync(paths.stagingDir, { recursive: true })
}

/**
 * Pointer versi aktif = file active.json (bukan symlink — Windows butuh
 * privilege untuk symlink; plan 02 §3.2). Tulis temp+rename (atomik),
 * cache in-memory + invalidate saat write/clear.
 */
export class ActivePointerStore {
  private cache = new Map<string, ActivePointer | null>()

  constructor(
    private paths: ToolchainPaths,
    private onWarn?: (msg: string) => void,
  ) {}

  async read(toolId: string): Promise<ActivePointer | null> {
    if (this.cache.has(toolId)) return this.cache.get(toolId) ?? null
    let ptr: ActivePointer | null = null
    try {
      const file = Bun.file(this.paths.pointerPath(toolId))
      if (await file.exists()) {
        const parsed = ActivePointerSchema.safeParse(await file.json())
        if (parsed.success) ptr = parsed.data
        else this.onWarn?.(`active.json ${toolId} korup — dianggap tidak ada pointer`)
      }
    } catch {
      this.onWarn?.(`active.json ${toolId} tidak terbaca — dianggap tidak ada pointer`)
    }
    this.cache.set(toolId, ptr)
    return ptr
  }

  async write(toolId: string, ptr: ActivePointer): Promise<void> {
    mkdirSync(this.paths.toolDir(toolId), { recursive: true })
    const dest = this.paths.pointerPath(toolId)
    const tmp = `${dest}.tmp`
    await Bun.write(tmp, JSON.stringify(ActivePointerSchema.parse(ptr), null, 2))
    renameSync(tmp, dest)
    this.cache.set(toolId, ptr)
  }

  clear(toolId: string): void {
    rmSync(this.paths.pointerPath(toolId), { force: true })
    this.cache.set(toolId, null)
  }

  invalidate(toolId?: string): void {
    if (toolId) this.cache.delete(toolId)
    else this.cache.clear()
  }
}
