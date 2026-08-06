import { EnkakuError } from '../util/errors'
import type { TunnelRegistry } from './registry'
import type { TunnelRouter } from './router'

/** The shape every correlated node reply/push has in common — narrower than
 * a specific `NodeToControl` member so `TunnelRpc` does not need to know
 * about every message type that will ever use it (plan 26/28 reuse this
 * unchanged, per plan 25 §5.1's "blocks" note). */
export interface TunnelRpcMessage {
  type: string
  id?: string
  payload: unknown
}

/**
 * The correlated request/response layer the tunnel was missing (plan 25
 * §3.2, §4.1): `TunnelRouter.sendToDevice` is fire-and-forget, but a one-shot
 * command has a result. Built once, generically, on the envelope's `id`.
 */
export interface TunnelRpc {
  /** Rejects `E_NODE_OFFLINE` if the device is unroutable, `E_NODE_TIMEOUT` after `timeoutMs` (default 20s). */
  request<T>(deviceId: string, type: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T>
  /** Resolve a pending request from an inbound node reply. Returns whether it matched something pending. */
  handleReply(msg: TunnelRpcMessage): boolean
  /**
   * Registers a one-shot watcher for an out-of-band PUSH keyed by an
   * application-chosen id — `shell.stream.ended` (plan 25 §4.2) is not a
   * reply to any pending request (nothing "asked" for it; it can arrive at
   * any time), so it is correlated by the stream's own id instead. Returns
   * an unsubscribe function.
   */
  watch(deviceId: string, id: string, cb: (payload: unknown) => void): () => void
  /** Deliver an inbound push to whoever is watching that id. Returns whether it matched. */
  dispatch(id: string, payload: unknown): boolean
  /** Reject everything outstanding for a node that just dropped — pending requests AND active watchers (plan 25 §6.3, §6.4). */
  failAllForNode(nodeId: string, reason: string): void
}

const DEFAULT_TIMEOUT_MS = 20_000

interface PendingRequest {
  nodeId: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Watcher {
  nodeId: string
  cb: (payload: unknown) => void
}

export function createTunnelRpc(deps: { router: TunnelRouter; registry: TunnelRegistry }): TunnelRpc {
  const pending = new Map<string, PendingRequest>()
  const watchers = new Map<string, Watcher>()

  return {
    request<T>(deviceId: string, type: string, payload: unknown, opts?: { timeoutMs?: number }) {
      return new Promise<T>((resolve, reject) => {
        const conn = deps.registry.forDevice(deviceId)
        if (!conn) {
          reject(new EnkakuError('E_NODE_OFFLINE', `no node is online for device ${deviceId}`))
          return
        }
        const id = crypto.randomUUID()
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(new EnkakuError('E_NODE_TIMEOUT', `node ${conn.nodeId} did not reply to ${type} within ${timeoutMs}ms`))
          }
        }, timeoutMs)
        // Never let a timer alone keep the process alive (relevant in tests
        // and short-lived scripts; harmless in the long-running daemon).
        if (typeof timer.unref === 'function') timer.unref()
        pending.set(id, { nodeId: conn.nodeId, resolve: resolve as (v: unknown) => void, reject, timer })
        const ok = deps.router.sendToDevice(deviceId, { type, id, payload } as never)
        if (!ok) {
          clearTimeout(timer)
          pending.delete(id)
          reject(new EnkakuError('E_NODE_OFFLINE', `no node is online for device ${deviceId}`))
        }
      })
    },

    handleReply(msg) {
      if (!msg.id) return false
      const entry = pending.get(msg.id)
      if (!entry) return false
      pending.delete(msg.id)
      clearTimeout(entry.timer)
      entry.resolve(msg.payload)
      return true
    },

    watch(deviceId, id, cb) {
      const conn = deps.registry.forDevice(deviceId)
      watchers.set(id, { nodeId: conn?.nodeId ?? '', cb })
      return () => {
        const w = watchers.get(id)
        if (w && w.cb === cb) watchers.delete(id)
      }
    },

    dispatch(id, payload) {
      const w = watchers.get(id)
      if (!w) return false
      watchers.delete(id)
      w.cb(payload)
      return true
    },

    failAllForNode(nodeId, reason) {
      for (const [id, entry] of [...pending]) {
        if (entry.nodeId !== nodeId) continue
        pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(new EnkakuError('E_NODE_OFFLINE', reason))
      }
      for (const [id, watcher] of [...watchers]) {
        if (watcher.nodeId !== nodeId) continue
        watchers.delete(id)
        watcher.cb({ reason: 'node_offline' })
      }
    },
  }
}
