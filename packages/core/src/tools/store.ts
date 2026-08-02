import { and, eq } from 'drizzle-orm'
import type { ToolInstallRecord, ToolInstallStore } from '@enkaku/toolchain'
import type { Db } from '../db'
import { toolInstalls, type ToolInstallRow } from '../db/schema'

const rowToRecord = (r: ToolInstallRow): ToolInstallRecord => ({
  id: r.id,
  toolId: r.toolId,
  version: r.version,
  active: r.active ?? false,
  sha256: r.sha256,
  installedAt: r.installedAt ? Math.floor(r.installedAt.getTime() / 1000) : null,
})

/** ToolInstallStore implemented over the tool_installs table (Drizzle). */
export function createToolInstallStore(db: Db): ToolInstallStore {
  return {
    list() {
      return db.select().from(toolInstalls).all().map(rowToRecord)
    },
    listByTool(toolId) {
      return db.select().from(toolInstalls).where(eq(toolInstalls.toolId, toolId)).all().map(rowToRecord)
    },
    insert(rec) {
      db.insert(toolInstalls)
        .values({
          id: rec.id,
          toolId: rec.toolId,
          version: rec.version,
          active: rec.active,
          sha256: rec.sha256,
          installedAt: rec.installedAt ? new Date(rec.installedAt * 1000) : null,
        })
        .run()
    },
    delete(toolId, version) {
      db.delete(toolInstalls)
        .where(and(eq(toolInstalls.toolId, toolId), eq(toolInstalls.version, version)))
        .run()
    },
    setActive(toolId, version) {
      // Invariant: at most one row with active=true per toolId.
      db.update(toolInstalls).set({ active: false }).where(eq(toolInstalls.toolId, toolId)).run()
      if (version !== null) {
        db.update(toolInstalls)
          .set({ active: true })
          .where(and(eq(toolInstalls.toolId, toolId), eq(toolInstalls.version, version)))
          .run()
      }
    },
  }
}
