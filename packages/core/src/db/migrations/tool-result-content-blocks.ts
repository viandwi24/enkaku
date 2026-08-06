import { eq } from 'drizzle-orm'
import type { Logger } from '../../util/logger'
import type { Db } from '../index'
import { agentMessages, migrationMarkers } from '../schema'

/**
 * `agent_messages.content`'s stored `tool_result` block (plan 70 §3.2, §4.1):
 * every pre-existing row's `content: string` becomes `content: [{type:
 * 'text', text: <the string>}]` — the same shape `AgentContentBlockSchema`
 * now requires everywhere else, and the exact conversion `run.ts:389` used
 * to skip when it serialised a screenshot's base64 straight into that
 * string (the defect this plan exists to fix).
 *
 * Lossless: the text itself is never altered, only wrapped. Idempotent and
 * guarded by a `migration_markers` row — the plan 22.0 pattern plans 62 and
 * 68 also used — so a repeated boot, or a row that is already migrated,
 * never touches it twice (criterion 5).
 */
export const MARKER_ID = 'tool-result-content-blocks-70'

export interface ToolResultContentMigrationReport {
  ranAt: string
  totalMessages: number
  convertedBlocks: number
}

interface LegacyStringToolResult {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
}

function isLegacyStringToolResult(block: unknown): block is LegacyStringToolResult {
  if (!block || typeof block !== 'object') return false
  const b = block as { type?: unknown; content?: unknown }
  return b.type === 'tool_result' && typeof b.content === 'string'
}

export function migrateToolResultContentBlocks(db: Db, deps: { log: Logger }): ToolResultContentMigrationReport | null {
  const marker = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).get()
  if (marker) return null

  const rows = db.select().from(agentMessages).all()
  let convertedBlocks = 0

  for (const row of rows) {
    const content = row.content
    if (!Array.isArray(content)) continue // defensive — every row's content is an array by schema

    let changed = false
    const migrated = content.map((block: unknown) => {
      if (!isLegacyStringToolResult(block)) return block
      changed = true
      convertedBlocks++
      return {
        type: 'tool_result' as const,
        toolUseId: block.toolUseId,
        content: [{ type: 'text' as const, text: block.content }],
        ...(block.isError !== undefined ? { isError: block.isError } : {}),
      }
    })

    if (changed) {
      db.update(agentMessages).set({ content: migrated }).where(eq(agentMessages.id, row.id)).run()
    }
  }

  if (rows.length > 0) {
    deps.log.info(`tool-result-content-blocks: migrated ${convertedBlocks} legacy tool_result block(s) across ${rows.length} pre-existing message(s)`)
  }

  db.insert(migrationMarkers).values({ id: MARKER_ID, appliedAt: new Date() }).run()

  return { ranAt: new Date().toISOString(), totalMessages: rows.length, convertedBlocks }
}
