import type { AgentToControl } from '@enkaku/protocol'
import type { SessionManager } from '@enkaku/session'

/**
 * Agent-side handlers for the correlated clipboard requests (plan 38 §4.5) —
 * the cloud parity for `packages/core/src/server/ws-handlers.ts`'s local
 * `clipboard.get`/`clipboard.set` cases. Both ride the SAME `SessionManager`
 * the agent already builds for video (`hosts.ts`'s `sessions`): a device's
 * `DeviceSession.clipboard` is scrcpy's real GET_CLIPBOARD/SET_CLIPBOARD round
 * trip when the control socket exists, or the adb fallback shim otherwise
 * (`@enkaku/session`'s `createSession`) — nothing clipboard-specific differs
 * for a cloud device, exactly like `shell.ts`'s reuse of the same `AdbClient`.
 */
export interface ClipboardHost {
  getRequest(msg: { id: string; payload: { deviceId: string; copyKey?: 'none' | 'copy' | 'cut' } }): Promise<void>
  setRequest(msg: { id: string; payload: { deviceId: string; text: string; paste?: boolean } }): Promise<void>
}

function errorReply(err: unknown): { code: string; message: string } {
  return {
    code: err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string' ? (err as { code: string }).code : 'E_CLIPBOARD_UNAVAILABLE',
    message: err instanceof Error ? err.message : String(err),
  }
}

export function createClipboardHost(deps: {
  sessions: SessionManager
  send: (msg: AgentToControl) => void
}): ClipboardHost {
  return {
    async getRequest(msg) {
      const { deviceId } = msg.payload
      const reply = (payload: unknown) => deps.send({ type: 'clipboard.get.reply', id: msg.id, payload } as AgentToControl)
      const session = deps.sessions.get(deviceId)
      if (!session) {
        reply({ ok: false, error: { code: 'device_not_ready', message: `no active session for device ${deviceId}` } })
        return
      }
      if (!session.clipboard) {
        reply({ ok: false, error: { code: 'E_CLIPBOARD_UNAVAILABLE', message: 'this session cannot access the clipboard' } })
        return
      }
      try {
        const text = await session.clipboard.get()
        reply({ ok: true, text })
      } catch (err) {
        reply({ ok: false, error: errorReply(err) })
      }
    },

    async setRequest(msg) {
      const { deviceId, text, paste } = msg.payload
      const reply = (payload: unknown) => deps.send({ type: 'clipboard.set.reply', id: msg.id, payload } as AgentToControl)
      const session = deps.sessions.get(deviceId)
      if (!session) {
        reply({ ok: false, error: { code: 'device_not_ready', message: `no active session for device ${deviceId}` } })
        return
      }
      if (!session.clipboard) {
        reply({ ok: false, error: { code: 'E_CLIPBOARD_UNAVAILABLE', message: 'this session cannot access the clipboard' } })
        return
      }
      try {
        await session.clipboard.set(text, { paste: paste ?? false })
        reply({ ok: true })
      } catch (err) {
        reply({ ok: false, error: errorReply(err) })
      }
    },
  }
}
