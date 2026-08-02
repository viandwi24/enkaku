import { centerOf, matchSelector, supportsElementActions, UiautomatorDumpInspector } from '@enkaku/drivers'
import { resolveKeyCode, type Inspector, type KeyCode, type Point, type Selector, type UiNode } from '@enkaku/protocol'
import { SessionError } from './errors'
import type { DeviceCall } from './runner/ipc'
import type { DeviceSession } from './session'

export interface TimingSettings {
  /** Jitter on how long a press is held (ms). */
  tapJitterMs: [number, number]
  /** A random pause before the action (ms). */
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
 * Executes device.call from the child (plan 05 §4.6). Every action goes
 * through DeviceSession (InputSink + Inspector) and therefore the Plan 01
 * per-device queue, so scripts never touch adb directly.
 *
 * Timing realism (spec §9.3): jittered pauses between actions plus coordinate offsets,
 * so tests exercise the real application path.
 */
export function createDeviceExecutor(deps: { session: DeviceSession; timing?: TimingSettings }) {
  const timing = deps.timing ?? DEFAULT_TIMING
  // The session's own inspector (ui-server / uiautomator-dump). When a session
  // is created without one (manual control mode), fall back to an ad-hoc dump engine.
  const inspector: Inspector = deps.session.inspector ?? new UiautomatorDumpInspector(deps.session.transport)

  const jitterPoint = (p: Point): Point => ({
    x: Math.round(p.x + (Math.random() * 2 - 1) * timing.coordJitterPx),
    y: Math.round(p.y + (Math.random() * 2 - 1) * timing.coordJitterPx),
  })

  const pause = () => Bun.sleep(randBetween(timing.betweenActionMs[0], timing.betweenActionMs[1]))

  async function resolveTarget(sel: Selector): Promise<Point> {
    if ('point' in sel) return sel.point
    const node = await inspector.find(sel)
    if (!node) throw new SessionError('element_not_found', `element not found: ${JSON.stringify(sel)}`)
    return centerOf(node.bounds)
  }

  /** The last selector tapped — the implicit target for `type`. */
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
        // Engines with element actions (ui-server) use setText on the focused
        // element — far more reliable, WebViews included.
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
        // The polling loop lives in the parent — one call, one meaning, pacing in
        // one place. The interval follows the active engine: ui-server is cheap
        // (~80ms), a dump is expensive.
        const interval = Math.min(call.args.intervalMs, deps.session.inspectorPollIntervalMs)
        const deadline = Date.now() + call.args.timeout
        for (;;) {
          const node = await inspector.find(call.args.sel).catch(() => null)
          if (node) return node
          if (Date.now() >= deadline) {
            throw new SessionError(
              'waitfor_timeout',
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
        await deps.session.transport.exec(cmd, { profile: 'appLifecycle' })
        return undefined
      }
      case 'app.forceStop': {
        await deps.session.transport.exec(`am force-stop ${call.args.pkg}`, { profile: 'appLifecycle' })
        return undefined
      }
    }
  }
}

export { matchSelector }
