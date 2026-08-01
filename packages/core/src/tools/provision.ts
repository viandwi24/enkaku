import type { ToolchainEvent, ToolchainManager } from '@enkaku/toolchain'
import type { ServerMessage } from '@enkaku/protocol'
import type { Logger } from '../util/logger'
import type { WsHub } from '../server/ws'

/** Map event toolchain → message protocol WS. */
export function toolchainEventToMessage(ev: ToolchainEvent): ServerMessage {
  if (ev.kind === 'changed') {
    return { type: 'tool.changed', payload: { toolId: ev.toolId, change: ev.change } }
  }
  return {
    type: 'tool.install.progress',
    payload: {
      toolId: ev.toolId,
      version: ev.version,
      phase: ev.phase,
      ...(ev.bytesReceived !== undefined ? { bytesReceived: ev.bytesReceived } : {}),
      ...(ev.totalBytes !== undefined ? { totalBytes: ev.totalBytes } : {}),
      ...(ev.percent !== undefined ? { percent: ev.percent } : {}),
      ...(ev.error ? { error: ev.error } : {}),
    },
  }
}

/**
 * First-run auto-provision (plan 02 §4.10). Dipanggil SETELAH HTTP/WS naik
 * supaya client bisa melihat progress. Gagal → core tetap hidup (retry via
 * POST /api/tools/:id/install atau restart); promise reject supaya caller
 * tahu subsistem adb tidak bisa start.
 */
export async function provisionRequiredTools(opts: {
  manager: ToolchainManager
  hub: WsHub
  log: Logger
  required: string[]
}): Promise<void> {
  const { manager, hub, log, required } = opts
  hub.broadcast({ type: 'tool.provision.progress', payload: { step: 'start' } })
  try {
    await manager.ensureRequiredTools(required)
    hub.broadcast({ type: 'tool.provision.progress', payload: { step: 'done' } })
    log.info(`provision done (${required.join(', ')})`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'E_INTERNAL'
    hub.broadcast({
      type: 'tool.provision.progress',
      payload: { step: 'error', error: { code, message } },
    })
    log.error(`provision gagal: ${message}`)
    throw err
  }
}
