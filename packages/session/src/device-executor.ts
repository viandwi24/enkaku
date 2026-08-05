import { shellQuote } from '@enkaku/adb'
import { buildGesturePath, supportsElementActions, UiautomatorDumpInspector } from '@enkaku/drivers'
import {
  centerOf,
  matchSelector,
  resolveKeyCode,
  TimingSettingsSchema,
  type Inspector,
  type KeyCode,
  type Point,
  type Selector,
  type TimingSettings,
  type UiNode,
} from '@enkaku/protocol'
import { SessionError } from './errors'
import type { DeviceCall } from './runner/ipc'
import type { DeviceSession } from './session'
import type { TransferPort } from './types'

export type { TimingSettings }

/**
 * The canonical Timing defaults (spec §9.3, plan 40 §4.3) — parsed from
 * `TimingSettingsSchema` itself rather than duplicated here, so a field this
 * plan adds (or a future one) can never drift between the schema's own
 * default and what a caller with no timing settings of its own gets.
 */
export const DEFAULT_TIMING: TimingSettings = TimingSettingsSchema.parse({})

const randBetween = (lo: number, hi: number): number => lo + Math.random() * Math.max(0, hi - lo)

type Direction = 'up' | 'down' | 'left' | 'right'
type Easing = 'linear' | 'easeOutQuad' | 'easeInOutCubic'

/**
 * `fling` strength → geometry (plan 40 §3.4, §4.4). `easeOutQuad` ends fast
 * (§3.3) — that release velocity is what makes a fling actually coast, so
 * every strength uses it; only the distance and duration (and therefore the
 * speed) scale with `strength`. Distance is a fraction of the relevant
 * viewport axis (open question §9.2: not yet calibrated per device density).
 */
const FLING_PROFILE: Record<'soft' | 'normal' | 'hard', { distanceFraction: number; durationMs: number }> = {
  soft: { distanceFraction: 0.22, durationMs: 240 },
  normal: { distanceFraction: 0.35, durationMs: 170 },
  hard: { distanceFraction: 0.5, durationMs: 110 },
}

/** `scroll` geometry (plan 40 §3.4, §4.4): a controlled drag that ends at low
 * velocity (`easeInOutCubic` "ends slow", §3.3) and stops where it is put. */
const SCROLL_DEFAULT_FRACTION = 0.6
const SCROLL_DURATION_MS = 400

/**
 * Two points for a directional drag, symmetric around an explicit or
 * centred anchor, clamped to the viewport (plan 40 §4.4). `direction` names
 * where the CONTENT should appear to move — `down` means "scroll down the
 * list", i.e. reveal content further down — so the actual swipe runs the
 * opposite way: dragging the finger UP is what scrolls a list DOWN.
 */
function directionalSwipe(
  direction: Direction,
  distance: number,
  frame: { width: number; height: number },
  anchor?: Point,
): { from: Point; to: Point } {
  const cx = frame.width / 2
  const cy = frame.height / 2
  const half = distance / 2
  const maxY = Math.max(0, frame.height - 1)
  const maxX = Math.max(0, frame.width - 1)
  switch (direction) {
    case 'down': {
      const from = anchor ?? { x: cx, y: Math.min(maxY, cy + half) }
      return { from, to: { x: from.x, y: Math.max(0, from.y - distance) } }
    }
    case 'up': {
      const from = anchor ?? { x: cx, y: Math.max(0, cy - half) }
      return { from, to: { x: from.x, y: Math.min(maxY, from.y + distance) } }
    }
    case 'right': {
      const from = anchor ?? { x: Math.min(maxX, cx + half), y: cy }
      return { from, to: { x: Math.max(0, from.x - distance), y: from.y } }
    }
    case 'left': {
      const from = anchor ?? { x: Math.max(0, cx - half), y: cy }
      return { from, to: { x: Math.min(maxX, from.x + distance), y: from.y } }
    }
  }
}

/**
 * Executes device.call from the child (plan 05 §4.6). Every action goes
 * through DeviceSession (InputSink + Inspector) and therefore the Plan 01
 * per-device queue, so scripts never touch adb directly.
 *
 * Timing realism (spec §9.3): jittered pauses between actions plus coordinate offsets,
 * so tests exercise the real application path.
 */
export function createDeviceExecutor(deps: {
  session: DeviceSession
  timing?: TimingSettings
  /**
   * Fired every time `app.launch` runs (plan 37 §3.4, §4.4) — the runner uses
   * this to build the `declared` crash policy's fallback target set (the
   * packages a script actually launched, when it declared none of its own
   * via `ScriptDefinition.reset.packages`). Optional: manual-control sessions
   * and any executor that does not care about crash attribution simply never
   * pass it.
   */
  onAppLaunch?: (pkg: string) => void
  /** `ctx.device.install`/`push`/`pull` (plan 39 §4.6) — undefined for a host that has not wired file transfer (the manual-control path never needs it). */
  transfer?: TransferPort
}) {
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

  /**
   * Curved-gesture dispatch shared by `swipe`, `scroll`, and `fling` (plan 40
   * §4.4): `profile: 'instant'` (or an engine with no `gesture` method —
   * `AdbInput`, already reported once at session creation, §3.6) skips
   * straight to a plain linear swipe, byte-for-byte the pre-plan-40 call.
   */
  async function runSwipe(from: Point, to: Point, ms: number, opts?: { curvature?: number; easing?: Easing }): Promise<void> {
    if (timing.profile !== 'instant' && deps.session.input.gesture) {
      const samples = buildGesturePath({
        from,
        to,
        durationMs: ms,
        curvature: opts?.curvature ?? timing.gestureCurvature,
        ...(opts?.easing ? { easing: opts.easing } : {}),
        sampleIntervalMs: timing.gestureSampleIntervalMs,
      })
      await deps.session.input.gesture(samples)
      return
    }
    await deps.session.input.swipe(from, to, ms)
  }

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
        const from = jitterPoint(call.args.from)
        const to = jitterPoint(call.args.to)
        await runSwipe(from, to, call.args.ms, { curvature: call.args.curvature, easing: call.args.easing })
        return undefined
      }
      case 'scroll': {
        await pause()
        const frame = deps.session.frameSize
        const vertical = call.args.direction === 'up' || call.args.direction === 'down'
        const axis = vertical ? frame.height : frame.width
        const distance = call.args.distance ?? Math.round(axis * SCROLL_DEFAULT_FRACTION)
        const anchor = call.args.from ? jitterPoint(call.args.from) : undefined
        const { from, to } = directionalSwipe(call.args.direction, distance, frame, anchor)
        await runSwipe(from, to, SCROLL_DURATION_MS, { easing: 'easeInOutCubic' })
        return undefined
      }
      case 'fling': {
        await pause()
        const frame = deps.session.frameSize
        const profile = FLING_PROFILE[call.args.strength ?? 'normal']
        const vertical = call.args.direction === 'up' || call.args.direction === 'down'
        const axis = vertical ? frame.height : frame.width
        const distance = Math.round(axis * profile.distanceFraction)
        const { from, to } = directionalSwipe(call.args.direction, distance, frame)
        await runSwipe(from, to, profile.durationMs, { easing: 'easeOutQuad' })
        return undefined
      }
      case 'type': {
        await pause()
        const instant = call.args.instant ?? timing.profile === 'instant'
        // `instant` — including the pre-plan-40 default of always-instant
        // when the caller supplies no timing settings at all — reproduces
        // the pre-plan-40 order exactly: setText when the inspector supports
        // element actions and something has been tapped, else bulk text.
        if (instant) {
          if (supportsElementActions(inspector) && lastTarget) {
            await inspector.setText(lastTarget, call.args.text)
            return undefined
          }
          await deps.session.input.text(call.args.text)
          return undefined
        }
        // `natural`: per-character delivery, so autocomplete, debounced
        // validation, and per-keystroke listeners actually run — `setText`
        // is skipped even when available, because it delivers the whole
        // string in one call too (spec §9.3, plan 40 §3.2).
        if (deps.session.input.typeText) {
          await deps.session.input.typeText(call.args.text, { perCharMs: call.args.perCharMs ?? timing.perCharMs })
          return undefined
        }
        // No per-character path on this engine — bulk delivery rather than
        // pretending, mirroring the gesture degrade above.
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
      case 'dump': {
        // The same tree the Inspect panel shows (plan 60 §3.2) — `Inspector`
        // has always had this method; nothing but the script ever asked for
        // it. The four-shape selector grammar cannot reach a node that has a
        // resource id and no text, and ordinary TypeScript over the tree can.
        return inspector.dump()
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
        // `pkg`/`activity` arrive from the child over IPC (plan 34 §3.4):
        // validated by a regex in `ipc.ts` as belt, `shellQuote` here as
        // braces — the quoting is what actually guarantees a value like
        // `com.x; touch /data/local/tmp/pwned` cannot run a second command.
        const cmd = call.args.activity
          ? `am start -n ${shellQuote(`${call.args.pkg}/${call.args.activity}`)}`
          : `monkey -p ${shellQuote(call.args.pkg)} -c android.intent.category.LAUNCHER 1`
        await deps.session.transport.exec(cmd, { profile: 'appLifecycle' })
        deps.onAppLaunch?.(call.args.pkg)
        return undefined
      }
      case 'app.forceStop': {
        await deps.session.transport.exec(`am force-stop ${shellQuote(call.args.pkg)}`, { profile: 'appLifecycle' })
        return undefined
      }
      case 'clipboard.get': {
        if (!deps.session.clipboard) {
          throw Object.assign(new Error('this session cannot access the clipboard'), { code: 'E_CLIPBOARD_UNAVAILABLE' })
        }
        return deps.session.clipboard.get()
      }
      case 'clipboard.set': {
        if (!deps.session.clipboard) {
          throw Object.assign(new Error('this session cannot access the clipboard'), { code: 'E_CLIPBOARD_UNAVAILABLE' })
        }
        await deps.session.clipboard.set(call.args.text, { paste: call.args.paste })
        return undefined
      }
      case 'install': {
        if (!deps.transfer) {
          throw Object.assign(new Error('file transfer is not available on this host'), { code: 'E_TRANSFER_UNAVAILABLE' })
        }
        return deps.transfer.install(deps.session.deviceId, call.args)
      }
      case 'push': {
        if (!deps.transfer) {
          throw Object.assign(new Error('file transfer is not available on this host'), { code: 'E_TRANSFER_UNAVAILABLE' })
        }
        await deps.transfer.push(deps.session.deviceId, call.args)
        return undefined
      }
      case 'pull': {
        if (!deps.transfer) {
          throw Object.assign(new Error('file transfer is not available on this host'), { code: 'E_TRANSFER_UNAVAILABLE' })
        }
        return deps.transfer.pull(deps.session.deviceId, call.args)
      }
    }
  }
}

export { matchSelector }
