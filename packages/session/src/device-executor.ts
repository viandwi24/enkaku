import { shellQuote } from '@enkaku/adb'
import { buildGesturePath, supportsElementActions, UiautomatorDumpInspector } from '@enkaku/drivers'
import {
  centerOf,
  matchSelector,
  resolveKeyCode,
  TimingSettingsSchema,
  type FindOutcome,
  type GestureSample,
  type Inspector,
  type InputSink,
  type KeyCode,
  type NormGestureSample,
  type NormPoint,
  type Point,
  type Selector,
  type TimingSettings,
  type UiNode,
} from '@enkaku/protocol'
import { SessionError } from './errors'
import type { InputSource } from './input-arbiter'
import type { DeviceCall } from './runner/ipc'
import type { DeviceSession } from './session'
import { resolveTextRoute } from './text-input'
import type { TransferPort } from './types'

/**
 * Plan 91 §3.3, §4.1 — every executor whose caller has not yet been given a
 * real identity to attribute (every call site predating this plan) is
 * attributed generically as a `job`. `runner/job-runner.ts` passes the real
 * job id (step 91.1's own requirement); a future capability/agent-call site
 * threading its own identity through simply passes `source` itself.
 */
const DEFAULT_INPUT_SOURCE: InputSource = { kind: 'job', id: 'device-executor', userId: null }

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
  /**
   * Timing realism (spec §9.3). Accepts a plain, already-resolved value
   * (every caller before plan 94) OR a getter (plan 94 §4.5, §5 step 94.2,
   * F10) — resolved FRESH ON EVERY DEVICE CALL, not once when this executor
   * is built. This is the fix for a defect this repo has shipped repeatedly
   * (most recently a co-control queue budget read once and never again): a
   * value captured at construction cannot respond to a farm/device setting
   * an operator changes while a script is still mid-run — `job-runner.ts`
   * already re-resolves `deps.timing()` once per ATTEMPT (a real freshness
   * improvement over "captured at daemon start"), but a single attempt can
   * run for the whole of a long script, and everything it does was still
   * pinned to whatever the setting was the instant that attempt began. A
   * getter closes that last gap: pass the accessor itself (not the result of
   * calling it) and every `tap`/`swipe`/`gesture`/… during this attempt sees
   * whatever is current right now.
   */
  timing?: TimingSettings | (() => TimingSettings)
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
  /**
   * Plan 91 §3.3, §4.1 — WHO is issuing these calls, for the arbiter's
   * attribution and non-preemptive priority (§3.3). `runner/job-runner.ts`
   * passes `{ kind: 'job', id: job.id, userId: null }`; a caller that does
   * not pass one gets `DEFAULT_INPUT_SOURCE` (a generic `job` attribution) —
   * every pre-plan-91 call site keeps working unchanged.
   */
  source?: InputSource
}) {
  /**
   * Resolved freshly on every call to the returned `execute` function below
   * (plan 94 §4.5, F10) — see `deps.timing`'s own doc comment for why a
   * plain captured value is the bug this fixes.
   */
  const resolveTiming = (): TimingSettings => {
    const t = deps.timing
    return typeof t === 'function' ? t() : (t ?? DEFAULT_TIMING)
  }
  // The session's own inspector (ui-server / uiautomator-dump). When a session
  // is created without one (manual control mode), fall back to an ad-hoc dump engine.
  const inspector: Inspector = deps.session.inspector ?? new UiautomatorDumpInspector(deps.session.transport)
  // Plan 91 §3.1, §3.3, §4.1 — fixes F6/H1: every pointer/key/text write goes
  // through the arbiter's lanes rather than the raw `session.input` sink, so
  // this job's actions never interleave with a concurrently assisting
  // human's. Lazy and memoised: built on first actual use, not at executor
  // construction — a `DeviceSession` fixture that never sends input (most of
  // this package's own tests: `app.launch`, `dump`, `find`, `push`, ...) must
  // not be required to supply a working `arbiter` just because SOME executor
  // call touches input.
  let cachedSink: InputSink | null = null
  const sink = (): InputSink => (cachedSink ??= deps.session.arbiter.for(deps.source ?? DEFAULT_INPUT_SOURCE))

  const jitterPoint = (p: Point, timing: TimingSettings): Point => ({
    x: Math.round(p.x + (Math.random() * 2 - 1) * timing.coordJitterPx),
    y: Math.round(p.y + (Math.random() * 2 - 1) * timing.coordJitterPx),
  })

  const pause = (timing: TimingSettings) => Bun.sleep(randBetween(timing.betweenActionMs[0], timing.betweenActionMs[1]))

  /**
   * Normalised 0..1 → device pixels, using the LATEST frame dimensions
   * (rotation) — plan 94 §3.3, §4.4's coordinate-space rule (see
   * `@enkaku/sdk`'s `DeviceApi` doc comment for the full argument). A
   * near-duplicate of `packages/core/src/server/ws-handlers.ts`'s own
   * `mapNormToDevice`, kept local rather than shared: `@enkaku/session`
   * cannot depend on `@enkaku/core` (core depends on session, never the
   * reverse — the same constraint `device-args.ts`'s header comment already
   * documents for `DEVICE_CALL_ARGS`), so the one function both need has no
   * common home below both packages that is worth a new export for four
   * lines of arithmetic.
   */
  const mapNormToDevice = (pos: NormPoint, frame: { width: number; height: number }): Point => {
    const clamp = (v: number, max: number) => Math.min(Math.max(0, v), Math.max(0, max))
    return {
      x: clamp(Math.round(pos.x * frame.width), frame.width - 1),
      y: clamp(Math.round(pos.y * frame.height), frame.height - 1),
    }
  }

  async function resolveTarget(sel: Selector): Promise<Point> {
    if ('point' in sel) return sel.point
    const node = await inspector.find(sel)
    if (!node) throw new SessionError('element_not_found', `element not found: ${JSON.stringify(sel)}`)
    return centerOf(node.bounds)
  }

  /**
   * Plan 74 §3.4, §4.3 — the executor is where `FindOutcome` is produced:
   * `inspector.findDetailed` when the engine has it (ui-server, the dump
   * bridge), else a plain fallback built from `find()` that can only ever
   * report `ok`/`not-found` — an engine with no richer signal (e.g. Appium)
   * still gets an honest, if less specific, outcome rather than an error.
   */
  async function findOutcome(sel: Selector): Promise<FindOutcome> {
    if (inspector.findDetailed) return inspector.findDetailed(sel)
    const node = await inspector.find(sel)
    return node ? { ok: true, node } : { ok: false, reason: 'not-found', matches: 0 }
  }

  /** The last selector tapped — the implicit target for `type`. */
  let lastTarget: Selector | null = null

  /**
   * Curved-gesture dispatch shared by `swipe`, `scroll`, and `fling` (plan 40
   * §4.4): `profile: 'instant'` (or an engine with no `gesture` method —
   * `AdbInput`, already reported once at session creation, §3.6) skips
   * straight to a plain linear swipe, byte-for-byte the pre-plan-40 call.
   */
  async function runSwipe(
    from: Point,
    to: Point,
    ms: number,
    timing: TimingSettings,
    opts?: { curvature?: number; easing?: Easing },
  ): Promise<void> {
    const s = sink()
    if (timing.profile !== 'instant' && s.gesture) {
      const samples = buildGesturePath({
        from,
        to,
        durationMs: ms,
        curvature: opts?.curvature ?? timing.gestureCurvature,
        ...(opts?.easing ? { easing: opts.easing } : {}),
        sampleIntervalMs: timing.gestureSampleIntervalMs,
      })
      await s.gesture(samples)
      return
    }
    await s.swipe(from, to, ms)
  }

  return async function execute(call: DeviceCall): Promise<unknown> {
    // Resolved ONCE per call, not once per executor (plan 94 §4.5, F10) —
    // see `deps.timing`'s own doc comment above `createDeviceExecutor`. A
    // single call is one action; using one snapshot for its whole duration
    // is a feature (an in-flight tap never straddles two different settings),
    // not a regression of the freshness this fixes.
    const timing = resolveTiming()
    switch (call.method) {
      case 'tap': {
        await pause(timing)
        lastTarget = 'point' in call.args.target ? null : call.args.target
        const point = jitterPoint(await resolveTarget(call.args.target), timing)
        // tapJitterMs (spec §9.3, §17): the hold duration is sampled per tap
        // from a range, not fixed — test realism, not evasion. The engine
        // does the actual sampling (so it can stay deterministic under an
        // injected rng); this just hands down the configured range.
        await sink().tap(point, { holdMs: timing.tapJitterMs })
        return undefined
      }
      case 'tapNorm': {
        // The replay's own verb (plan 94 §3.4, §4.4, F6, F7) — `call.args.pos`
        // is NORMALISED 0..1 (see `@enkaku/protocol`'s `TapNormArgsSchema`
        // doc comment for the coordinate-space rule this exists to satisfy).
        // Mapped to THIS run's device pixels here, then jittered exactly like
        // a plain `tap`, so a replayed recording still moves around by
        // `coordJitterPx` on every repetition (§3.6: "this is what stops 200
        // repetitions hitting one identical pixel").
        await pause(timing)
        lastTarget = null
        const point = jitterPoint(mapNormToDevice(call.args.pos, deps.session.frameSize), timing)
        // `holdMs`, when the recorded step measured one, is EXACT — not a
        // range to sample from (§3.4: "faithful" replay fidelity for a tap's
        // recorded hold duration). Omitted falls back to the device's own
        // `tapJitterMs` range, identical to plain `tap`.
        const holdMs = call.args.holdMs
        await sink().tap(point, { holdMs: holdMs !== undefined ? [holdMs, holdMs] : timing.tapJitterMs })
        return undefined
      }
      case 'longPress': {
        // plan 94 §3.4, §4.4 (F4) — a PROMOTED selector's long-press, device-
        // pixel like plain `tap` (never a raw recorded point — `tapNorm`
        // above is that verb). `tap` keeps its device-configured
        // `tapJitterMs` RANGE; this one names `ms` and jitters around it —
        // recentring `tapJitterMs`'s own width on `ms` rather than sampling
        // `tapJitterMs` itself, which would ignore the caller's `ms` entirely.
        await pause(timing)
        lastTarget = 'point' in call.args.target ? null : call.args.target
        const point = jitterPoint(await resolveTarget(call.args.target), timing)
        const halfWidth = Math.max(0, timing.tapJitterMs[1] - timing.tapJitterMs[0]) / 2
        const holdRange: [number, number] = [Math.max(0, call.args.ms - halfWidth), call.args.ms + halfWidth]
        await sink().tap(point, { holdMs: holdRange })
        return undefined
      }
      case 'gesture': {
        // Plays a recorded pointer trace SAMPLE-FOR-SAMPLE (plan 94 §3.4,
        // §4.4, F3, F6, F7) — never collapsed to a start point, an end point
        // and a synthesised interpolation. `call.args.samples` are
        // NORMALISED 0..1 (same coordinate-space rule as `tapNorm`); mapped
        // to device pixels here, `atMs` carried through untouched (it is
        // already relative to the gesture's own start, not a wall-clock
        // timestamp — `@enkaku/protocol`'s `NormGestureSampleSchema`).
        await pause(timing)
        const frame = deps.session.frameSize
        const samples: GestureSample[] = call.args.samples.map((s: NormGestureSample) => {
          const p = mapNormToDevice(s, frame)
          return { x: p.x, y: p.y, atMs: s.atMs }
        })
        const s = sink()
        if (!s.gesture) {
          // Named per §4.4's own doc comment on `DeviceApi.gesture` — an
          // engine with no curved-gesture support (`AdbInput`) cannot honour
          // a sampled trace at all; degrading to a two-point swipe here would
          // silently throw away the recording's whole reason to exist (F3).
          throw Object.assign(new Error('this input engine cannot replay a sampled gesture trace'), {
            code: 'E_GESTURE_UNSUPPORTED',
          })
        }
        await s.gesture(samples)
        return undefined
      }
      case 'swipeNorm': {
        // plan 94 §3.4, §4.4 (F6, F7) — the two-point drag fallback
        // `LiveView` already emits for a swipe too fast to sample, replayed
        // as a straight line over `call.args.ms` (never curved — there were
        // no intermediate samples to curve through). Normalised, same rule
        // as `tapNorm`/`gesture` above.
        await pause(timing)
        const frame = deps.session.frameSize
        const from = jitterPoint(mapNormToDevice(call.args.from, frame), timing)
        const to = jitterPoint(mapNormToDevice(call.args.to, frame), timing)
        await sink().swipe(from, to, call.args.ms)
        return undefined
      }
      case 'swipe': {
        await pause(timing)
        const from = jitterPoint(call.args.from, timing)
        const to = jitterPoint(call.args.to, timing)
        await runSwipe(from, to, call.args.ms, timing, { curvature: call.args.curvature, easing: call.args.easing })
        return undefined
      }
      case 'scroll': {
        await pause(timing)
        const frame = deps.session.frameSize
        const vertical = call.args.direction === 'up' || call.args.direction === 'down'
        const axis = vertical ? frame.height : frame.width
        const distance = call.args.distance ?? Math.round(axis * SCROLL_DEFAULT_FRACTION)
        const anchor = call.args.from ? jitterPoint(call.args.from, timing) : undefined
        const { from, to } = directionalSwipe(call.args.direction, distance, frame, anchor)
        await runSwipe(from, to, SCROLL_DURATION_MS, timing, { easing: 'easeInOutCubic' })
        return undefined
      }
      case 'fling': {
        await pause(timing)
        const frame = deps.session.frameSize
        const profile = FLING_PROFILE[call.args.strength ?? 'normal']
        const vertical = call.args.direction === 'up' || call.args.direction === 'down'
        const axis = vertical ? frame.height : frame.width
        const distance = Math.round(axis * profile.distanceFraction)
        const { from, to } = directionalSwipe(call.args.direction, distance, frame)
        await runSwipe(from, to, profile.durationMs, timing, { easing: 'easeOutQuad' })
        return undefined
      }
      case 'type': {
        await pause(timing)
        const instant = call.args.instant ?? timing.profile === 'instant'
        // `instant` — including the pre-plan-40 default of always-instant
        // when the caller supplies no timing settings at all — reproduces
        // the pre-plan-40 order exactly: setText when the inspector supports
        // element actions and something has been tapped, else bulk text.
        //
        // `inspector.setText` is a mechanism outside the three-rung text ladder (plan 90
        // §3.3): ui-server's element-scoped `set_text` is already unicode-clean (F26) and is
        // tried first whenever a selector-based tap makes it applicable, before the ladder is
        // ever consulted — unchanged from before this plan.
        if (instant && supportsElementActions(inspector) && lastTarget) {
          await inspector.setText(lastTarget, call.args.text)
          return { via: 'ui-server-set-text', clobberedClipboard: false }
        }

        // Plan 90 §3.3, §4.5, §5 step 90.5: everything below reaches a bulk `InputSink.text()` or
        // `.typeText()` call, which is exactly where F25's bug lived — a CJK/emoji string reached
        // `AdbInput.text()` and died inside it as `INPUT_TEXT_UNSUPPORTED`. `resolveTextRoute`
        // decides ONCE, up front, whether this string can be carried at all before any engine is
        // touched, and by which rung.
        //
        // Plan 125 §3.8, §8, §5 step 125.8 — the guest-agent IME bootstrap no
        // longer blocks the first video frame, so a script can now reach this
        // line while it is still in flight. This await is what keeps the
        // contract §8's risk row demands: "a job that needs text input awaits
        // the session's `ready`, which still gates on the same work
        // completing". Without it a `type()` issued milliseconds after
        // `acquire` would read `imeCurrent: false`, silently drop to rung 2,
        // and the operator would see a real behaviour change from a change
        // that was only supposed to move WHEN the work happens.
        //
        // Costs nothing once the setup has completed (a resolved promise), and
        // starts it on demand when no frame ever arrived to trigger it. `?.()`
        // for the fixture sessions that carry no such method (see
        // `DeviceSession.whenTextInputReady`).
        await deps.session.whenTextInputReady?.()

        const decision = resolveTextRoute({
          text: call.args.text,
          agentCapabilities: deps.session.textInput.agentCapabilities,
          imeCurrent: deps.session.textInput.imeCurrent,
          hasScrcpyControl: deps.session.inputEngineId !== 'adb-input',
          prefer: deps.session.textInput.mode,
        })
        if (decision.unmet) {
          throw Object.assign(new Error(decision.unmet.message), { code: decision.unmet.code })
        }

        const perCharMs = instant ? undefined : (call.args.perCharMs ?? timing.perCharMs)

        if (decision.rung === 'agent-ime') {
          const result = await deps.session.textInput.commitViaAgent(call.args.text, perCharMs)
          return { via: decision.rung, committed: result.committed, clobberedClipboard: false }
        }
        // 'scrcpy-text' / 'adb-ascii': the instant/natural delivery CHOICE below is about
        // mechanics (typeText vs bulk text) — unrelated to which rung the ladder picked, which
        // only decided WHETHER this call is reached at all. (A third rung, clipboard paste, was
        // designed alongside these two and removed as architecturally unreachable —
        // docs/plans/96-m61-hotfixes.md §96.7, §96.8.)
        const textSink = sink()
        if (!instant && textSink.typeText) {
          // `natural`: per-character delivery, so autocomplete, debounced
          // validation, and per-keystroke listeners actually run — `setText`
          // is skipped even when available, because it delivers the whole
          // string in one call too (spec §9.3, plan 40 §3.2).
          await textSink.typeText(call.args.text, { perCharMs: perCharMs ?? timing.perCharMs })
          return { via: decision.rung, clobberedClipboard: false }
        }
        // No per-character path on this engine — bulk delivery rather than
        // pretending, mirroring the gesture degrade above.
        await textSink.text(call.args.text)
        return { via: decision.rung, clobberedClipboard: false }
      }
      case 'key': {
        await pause(timing)
        await sink().key(resolveKeyCode(call.args.code as KeyCode))
        return undefined
      }
      case 'find': {
        // Returns the FULL FindOutcome (plan 74 §4.3) — the child's own
        // `find()` narrows it to `node | null`, `findDetailed()` returns it
        // whole, and `job-runner.ts` inspects the very same value to log a
        // refusal, so a script using plain `find()` is still diagnosable.
        return findOutcome(call.args.sel)
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
        // Plan 74 §3.5, §4.3 — carries the LAST outcome into the timeout
        // error, so "every match was refused as rejected-oversized" reports
        // as that, not a bare timeout (criterion 9).
        let last: FindOutcome = { ok: false, reason: 'not-found', matches: 0 }
        for (;;) {
          const outcome = await findOutcome(call.args.sel).catch((): FindOutcome => ({ ok: false, reason: 'not-found', matches: 0 }))
          if (outcome.ok) return outcome.node
          last = outcome
          if (Date.now() >= deadline) {
            throw new SessionError(
              'waitfor_timeout',
              `waiting for ${JSON.stringify(call.args.sel)} exceeded ${call.args.timeout}ms (last: ${last.reason}, ${last.matches} matches)`,
              { reason: last.reason, matches: last.matches },
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
        // A URL wins over an activity: the caller asked for a specific page, not a specific screen.
        const cmd = call.args.url
          ? `am start -a android.intent.action.VIEW -d ${shellQuote(call.args.url)} ${shellQuote(call.args.pkg)}`
          : call.args.activity
            ? `am start -n ${shellQuote(`${call.args.pkg}/${call.args.activity}`)}`
            : `monkey -p ${shellQuote(call.args.pkg)} -c android.intent.category.LAUNCHER 1`
        await deps.session.transport.exec(cmd, { profile: 'appLifecycle' })
        deps.onAppLaunch?.(call.args.pkg)
        return undefined
      }
      case 'app.forceStop': {
        await deps.session.transport.exec(`am force-stop ${shellQuote(call.args.pkg)}`, { profile: 'appLifecycle' })
        if (call.args.clearRecents) {
          // One shell round trip, not one per task: read the switcher, keep only the lines naming
          // THIS package, pull each task id out of `Task{<hex> #<id>`, and remove those. `am stack
          // remove` is what actually drops the card — `force-stop` above never does.
          //
          // Failure is swallowed on purpose. A leftover card is untidy; a `finish()` that throws
          // over one is worse, and this runs where a job is already ending.
          const pkg = shellQuote(call.args.pkg)
          const cmd =
            `for t in $(dumpsys activity recents | grep -F ${pkg} | grep -oE 'Task\{[0-9a-f]+ #[0-9]+' ` +
            `| grep -oE '[0-9]+$'); do am stack remove $t >/dev/null 2>&1; done`
          await deps.session.transport.exec(cmd, { profile: 'appLifecycle' }).catch(() => undefined)
        }
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
        // The result (plan 90 §4.6) — including `mediaScan` — reaches the
        // script itself, not just the database: a script that pushes a
        // photo can tell whether the media library was actually told.
        return deps.transfer.push(deps.session.deviceId, call.args)
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
