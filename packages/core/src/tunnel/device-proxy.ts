import { isH264Keyframe } from '@enkaku/protocol'
import type { FrameMeta, Point } from '@enkaku/protocol'
import type { DeviceSession } from '@enkaku/session'
import { EnkakuError } from '../util/errors'
import type { TunnelRouter } from './router'

/**
 * A session for an agent-owned device, wrapped to have **the same shape** as a
 * local `DeviceSession` (plan 12 §4.4). That way the WS handler never has to
 * branch on "local or remote" in a dozen places.
 *
 * Input is sent as pixel coordinates: the mapping from 0..1 still happens
 * in the control plane using the latest frame dimensions, exactly as local mode does.
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
  videoKeyframe: null
  close(): Promise<void>
  /** Called by the router when an agent reports its session is ready. */
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
    if (!ok) throw new EnkakuError('agent_offline', 'the agent that owns this device is currently disconnected')
  }

  const proxy: RemoteSession = {
    deviceId: deps.deviceId,
    frameSize: { width: 0, height: 0 },
    codec: 'png',
    displayEngineId: 'remote',
    inputEngineId: 'remote',
    inspectorEngineId: 'remote',
    videoConfig: null,
    videoKeyframe: null,

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
      // The video channel is opened once and shared by every subscriber.
      unsubscribeVideo ??= deps.router.subscribeVideo(deps.deviceId, (payload) => {
        const meta: FrameMeta = {
          width: proxy.frameSize.width,
          height: proxy.frameSize.height,
          codec: proxy.codec,
          seq: seq++,
          capturedAt: Date.now(),
          keyframe: proxy.codec === 'png' ? true : isH264Keyframe(payload),
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
