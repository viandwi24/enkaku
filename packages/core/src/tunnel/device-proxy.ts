import type { FrameMeta, Point } from '@enkaku/protocol'
import type { DeviceSession } from '@enkaku/session'
import { EnkakuError } from '../util/errors'
import type { TunnelRouter } from './router'

/**
 * Sesi device milik agent, dibungkus agar **berbentuk sama** dengan
 * `DeviceSession` lokal (plan 12 §4.4). Dengan begitu handler WS tidak perlu
 * bercabang "lokal atau remote" di setiap tempat.
 *
 * Input dikirim sebagai koordinat pixel: pemetaan dari 0..1 tetap dilakukan
 * control plane memakai dimensi frame terakhir, persis seperti mode lokal.
 */
export interface RemoteSession extends Pick<DeviceSession, 'deviceId' | 'frameSize'> {
  input: {
    tap(p: Point): Promise<void>
    swipe(from: Point, to: Point, ms: number): Promise<void>
    key(code: number): Promise<void>
    text(s: string): Promise<void>
  }
  displayEngineId: string
  inputEngineId: string
  inspectorEngineId: string
  videoConfig: null
  close(): Promise<void>
  /** Dipanggil router saat agent mengabarkan sesi siap. */
  applyStarted(info: { codec: 'png' | 'h264'; width: number; height: number }): void
  onFrame(cb: (chunk: Uint8Array, meta: FrameMeta) => void): () => void
  codec: 'png' | 'h264'
}

export function createDeviceProxy(deps: { router: TunnelRouter; deviceId: string }): RemoteSession {
  const subscribers = new Set<(chunk: Uint8Array, meta: FrameMeta) => void>()
  let seq = 0
  let unsubscribeVideo: (() => void) | null = null

  const forward = (action: unknown) => {
    const ok = deps.router.sendToDevice(deps.deviceId, {
      type: 'input.forward',
      payload: { deviceId: deps.deviceId, action },
    } as never)
    if (!ok) throw new EnkakuError('agent_offline', 'agent pemilik device sedang tidak terhubung')
  }

  const proxy: RemoteSession = {
    deviceId: deps.deviceId,
    frameSize: { width: 0, height: 0 },
    codec: 'png',
    displayEngineId: 'remote',
    inputEngineId: 'remote',
    inspectorEngineId: 'remote',
    videoConfig: null,

    input: {
      async tap(p) {
        forward({ kind: 'tap', point: p })
      },
      async swipe(from, to, ms) {
        forward({ kind: 'swipe', from, to, durationMs: ms })
      },
      async key(code) {
        forward({ kind: 'key', keycode: code })
      },
      async text(s) {
        forward({ kind: 'text', text: s })
      },
    },

    applyStarted(info) {
      proxy.codec = info.codec
      proxy.frameSize = { width: info.width, height: info.height }
    },

    onFrame(cb) {
      subscribers.add(cb)
      // Channel video dibuka sekali, dibagi ke semua pelanggan.
      unsubscribeVideo ??= deps.router.subscribeVideo(deps.deviceId, (payload) => {
        const meta: FrameMeta = {
          width: proxy.frameSize.width,
          height: proxy.frameSize.height,
          codec: proxy.codec,
          seq: seq++,
          capturedAt: Date.now(),
        }
        for (const sub of subscribers) sub(payload, meta)
      })
      return () => {
        subscribers.delete(cb)
        if (subscribers.size === 0) {
          unsubscribeVideo?.()
          unsubscribeVideo = null
        }
      }
    },

    async close() {
      unsubscribeVideo?.()
      unsubscribeVideo = null
      subscribers.clear()
      deps.router.sendToDevice(deps.deviceId, {
        type: 'session.stop',
        payload: { deviceId: deps.deviceId },
      } as never)
    },
  }

  return proxy
}
