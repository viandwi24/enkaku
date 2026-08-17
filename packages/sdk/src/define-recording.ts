import { z } from 'zod'
import type { RecordingDoc, RecordingStep, RecordingTarget } from '@enkaku/protocol'
import { RecordingDocSchema } from '@enkaku/protocol'
import type { DeviceApi, ScriptContext, ScriptDefinition, ScriptLogger } from './types'

/**
 * The replay interpreter for a recording document (plan 94 §3.1, §4.3, step
 * 94.1). `defineRecording` is a THIN wrapper, matching the SDK's own
 * constitutional constraint (F18: "all orchestration belongs to the core's
 * runner, so a script published with an older SDK keeps working on a newer
 * core") — it validates `doc`, derives `id`/`version`/`params`/`reset`/`timing`
 * from it, and returns an ordinary frozen `ScriptDefinition`, indistinguishable
 * from one a human typed by hand (plan 94 acceptance criterion 2: "no code path
 * anywhere that special-cases it").
 *
 * ---
 *
 * **Two findings step 94.1 surfaced here, both resolved by step 94.2 —
 * `RecordingDevice`/`RecordingScriptDefinition`, the local workarounds that
 * used to live in this file, are gone; everything below now uses the
 * canonical `DeviceApi`/`ScriptDefinition` from `./types.ts` directly:**
 *
 * 1. **Coordinate-space mismatch beyond what §4.4 originally named.** §4.4's
 *    `gesture`/`longPress` were the two new `DeviceApi` verbs step 94.2 was
 *    told to add — but a recorded tap's `point` target and a `swipe` step's
 *    `from`/`to` are ALSO stored normalised (`RecordingTargetSchema`, F2,
 *    acceptance criterion 1), and the EXISTING `tap`/`swipe` take device-pixel
 *    coordinates. Step 94.2's resolution: `DeviceApi` gained `tapNorm`/
 *    `swipeNorm` alongside `gesture`/`longPress`, with the full
 *    coordinate-space rule written as a doc comment directly above
 *    `DeviceApi` itself (`./types.ts`) — the "next reader cannot miss it"
 *    version of this file's old finding-1 comment. `dispatchTarget` below
 *    uses them.
 * 2. **`ScriptDefinition.timing` (§4.5, F10)** now exists on the canonical
 *    type (`./types.ts`) — `defineRecording` sets it exactly as before
 *    (`{ betweenActionMs: [0, 0] }`, §3.6's composition table); nothing about
 *    this file's OWN logic needed to change, only its imports.
 */

const SLEEP = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Injectable for tests (matches the `deps.sleep` pattern already used by `agent/harness/run.ts` and `notify/service.ts`) — never part of the generated call site, which always reads `defineRecording({ ... })` (plan 94 §3.1). */
export interface DefineRecordingDeps {
  sleep?: (ms: number) => Promise<void>
}

/** `Record<string, string>` — the shape every `{ param }` reference becomes (§4.2): every field is a `z.string()`, so a recording never has a non-string parameter. */
type RecordingParams = Record<string, string>

function collectParamNames(doc: RecordingDoc): string[] {
  const names = new Set<string>()
  for (const step of doc.steps) {
    if (step.kind === 'text' && typeof step.value === 'object') names.add(step.value.param)
  }
  return [...names].sort()
}

async function dispatchTarget(device: DeviceApi, target: RecordingTarget, holdMs: number | undefined): Promise<void> {
  if (target.kind === 'selector') {
    if (holdMs === undefined) await device.tap(target.selector)
    else await device.longPress(target.selector, holdMs)
    return
  }
  await device.tapNorm(target.pos, holdMs === undefined ? undefined : { holdMs })
}

function logStep(log: ScriptLogger, index: number, total: number, kind: string): void {
  log.debug(`step ${index + 1}/${total}: ${kind}`)
}

function textFor(step: Extract<RecordingStep, { kind: 'text' }>, params: RecordingParams): string {
  return typeof step.value === 'string' ? step.value : (params[step.value.param] ?? '')
}

/**
 * Validates `doc`, derives `id`/`version`/`params`/`reset`/`timing` from it
 * (plan 94 §4.3), and returns an ordinary frozen `ScriptDefinition`, so it is
 * indistinguishable from one an operator wrote (acceptance criterion 2). No
 * timeouts, no retries, no orchestration here — F18.
 *
 * Plan 110 §4.2 removed `defineScript`, which this used to hand `def` to for
 * its validate-fold-freeze. Nothing is lost by the removal: every check that
 * call made is already made, HARDER, by `RecordingDocSchema` above — `name`
 * is `min(1).regex(...)` and `version` is a semver regex — and the derived
 * definition declares no `timeout`/`retries`/`runtime` at all, so the runtime
 * fold was a guaranteed no-op. The freeze is the only part that did anything,
 * and it is kept verbatim.
 */
export function defineRecording(doc: RecordingDoc, deps: DefineRecordingDeps = {}): ScriptDefinition<z.ZodTypeAny> {
  const parsed = RecordingDocSchema.parse(doc)
  const sleep = deps.sleep ?? SLEEP
  const paramNames = collectParamNames(parsed)
  const paramsSchema: z.ZodTypeAny = z.object(Object.fromEntries(paramNames.map((name) => [name, z.string()])))

  async function run(ctx: ScriptContext<RecordingParams>): Promise<undefined> {
    const device = ctx.device
    const steps = parsed.steps
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      if (!step) continue
      const gapMs = Math.min(Math.round(step.gapMs * parsed.speed), parsed.maxGapMs)
      if (gapMs > 0) await sleep(gapMs)
      logStep(ctx.log, i, steps.length, step.kind)
      switch (step.kind) {
        case 'tap':
        case 'longPress':
          await dispatchTarget(device, step.target, step.holdMs)
          break
        case 'gesture':
          await device.gesture(step.samples)
          break
        case 'swipe':
          await device.swipeNorm(step.from, step.to, step.durationMs)
          break
        case 'key':
          await device.key(step.keycode)
          break
        case 'text':
          await device.type(textFor(step, ctx.params))
          break
      }
    }
    return undefined
  }

  async function finish(ctx: ScriptContext<RecordingParams>): Promise<void> {
    // Stateless and idempotent by construction (F19): force-stop is already a
    // no-op the second time, and this reads nothing but `parsed`.
    if (parsed.cleanup !== 'force-stop') return
    for (const pkg of parsed.packages) {
      await ctx.device.app.forceStop(pkg)
    }
  }

  const def: ScriptDefinition<z.ZodTypeAny> = {
    id: parsed.name,
    version: parsed.version,
    params: paramsSchema,
    run,
    finish,
    reset: { packages: parsed.packages },
    // §3.6's composition table: the recording supplies its own gaps, so the
    // farm's synthetic betweenActionMs pause is suppressed. Every other
    // timing field (coordJitterPx, tapJitterMs, perCharMs) is left unset —
    // unset means "inherit the device's own settings", which is what §3.6
    // calls for.
    timing: { betweenActionMs: [0, 0] },
  }

  return Object.freeze(def)
}
