import { centerOf, matchSelector, supportsElementActions, UiautomatorDumpInspector } from '@enkaku/drivers'
import { resolveKeyCode, type Inspector, type KeyCode, type Point, type Selector, type UiNode } from '@enkaku/protocol'
import type { DeviceSession } from '../session/session'
import { EnkakuError } from '../util/errors'
import type { DeviceCall } from './ipc'

export interface TimingSettings {
  /** Jitter durasi tekan (ms). */
  tapJitterMs: [number, number]
  /** Jeda acak sebelum aksi (ms). */
  betweenActionMs: [number, number]
  /** Offset acak koordinat (px). */
  coordJitterPx: number
}

export const DEFAULT_TIMING: TimingSettings = {
  tapJitterMs: [40, 120],
  betweenActionMs: [300, 900],
  coordJitterPx: 2,
}

const randBetween = (lo: number, hi: number): number => lo + Math.random() * Math.max(0, hi - lo)

/**
 * Eksekusi device.call dari child (plan 05 §4.6). Semua aksi lewat
 * DeviceSession (InputSink + Inspector) → per-device queue Plan 01, jadi
 * script tidak pernah menyentuh adb langsung.
 *
 * Timing realism (spec §9.3): jitter jeda antar-aksi + offset koordinat,
 * supaya test menempuh jalur app yang sebenarnya.
 */
export function createDeviceExecutor(deps: { session: DeviceSession; timing?: TimingSettings }) {
  const timing = deps.timing ?? DEFAULT_TIMING
  // Inspector milik session (ui-server / uiautomator-dump). Kalau session
  // dibuat tanpa inspector (mode kontrol manual), pakai engine dump ad-hoc.
  const inspector: Inspector = deps.session.inspector ?? new UiautomatorDumpInspector(deps.session.transport)

  const jitterPoint = (p: Point): Point => ({
    x: Math.round(p.x + (Math.random() * 2 - 1) * timing.coordJitterPx),
    y: Math.round(p.y + (Math.random() * 2 - 1) * timing.coordJitterPx),
  })

  const pause = () => Bun.sleep(randBetween(timing.betweenActionMs[0], timing.betweenActionMs[1]))

  async function resolveTarget(sel: Selector): Promise<Point> {
    if ('point' in sel) return sel.point
    const node = await inspector.find(sel)
    if (!node) throw new EnkakuError('ELEMENT_NOT_FOUND', `elemen tidak ditemukan: ${JSON.stringify(sel)}`)
    return centerOf(node.bounds)
  }

  /** Selector terakhir yang di-tap — target implisit untuk `type`. */
  let lastTarget: Selector | null = null

  return async function execute(call: DeviceCall): Promise<unknown> {
    switch (call.method) {
      case 'tap': {
        await pause()
        lastTarget = 'point' in call.args.target ? null : call.args.target
        const point = jitterPoint(await resolveTarget(call.args.target))
        await deps.session.input.tap(point)
        return undefined
      }
      case 'swipe': {
        await pause()
        await deps.session.input.swipe(jitterPoint(call.args.from), jitterPoint(call.args.to), call.args.ms)
        return undefined
      }
      case 'type': {
        await pause()
        // Engine dengan aksi elemen (ui-server) memakai setText pada elemen
        // yang sedang fokus — jauh lebih reliable, termasuk di WebView.
        if (supportsElementActions(inspector) && lastTarget) {
          await inspector.setText(lastTarget, call.args.text)
          return undefined
        }
        await deps.session.input.text(call.args.text)
        return undefined
      }
      case 'key': {
        await pause()
        await deps.session.input.key(resolveKeyCode(call.args.code as KeyCode))
        return undefined
      }
      case 'find': {
        return inspector.find(call.args.sel)
      }
      case 'waitFor': {
        // Loop polling di parent — satu call = satu semantik, pacing terpusat.
        // Interval mengikuti engine aktif: ui-server murah (~80ms), dump mahal.
        const interval = Math.min(call.args.intervalMs, deps.session.inspectorPollIntervalMs)
        const deadline = Date.now() + call.args.timeout
        for (;;) {
          const node = await inspector.find(call.args.sel).catch(() => null)
          if (node) return node
          if (Date.now() >= deadline) {
            throw new EnkakuError(
              'WAITFOR_TIMEOUT',
              `menunggu ${JSON.stringify(call.args.sel)} melewati ${call.args.timeout}ms`,
            )
          }
          await Bun.sleep(interval)
        }
      }
      case 'screenshot': {
        const png = await inspector.screenshot()
        return Buffer.from(png).toString('base64')
      }
      case 'app.launch': {
        const cmd = call.args.activity
          ? `am start -n ${call.args.pkg}/${call.args.activity}`
          : `monkey -p ${call.args.pkg} -c android.intent.category.LAUNCHER 1`
        await deps.session.transport.exec(cmd)
        return undefined
      }
      case 'app.forceStop': {
        await deps.session.transport.exec(`am force-stop ${call.args.pkg}`)
        return undefined
      }
    }
  }
}

export { matchSelector }
