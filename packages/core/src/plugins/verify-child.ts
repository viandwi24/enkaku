import { fileURLToPath } from 'node:url'
import {
  checkDeclaredSchema,
  duplicateWebhookIdsMessage,
  PLUGIN_UI_API_VERSION,
  PluginServiceDeclarationSchema,
  handlerViewsWithoutServiceMessage,
  refusedPluginEventTypesMessage,
  unknownPluginEventTypesMessage,
  unsupportedIsolationMessage,
  validatePluginSurface,
  type ActionSpec,
  type PluginServiceDeclaration,
  type PluginSurface,
  type RuntimeEnvelope,
} from '@enkaku/protocol'
import type { VerifyChildMessage } from './verify-child-entry'

/**
 * Stages → verifies → activates (plan 82 §3.7). This is step 2: a
 * throwaway child process — the same isolation a job uses — imports a
 * staged bundle and reports what it declares. The import happens in a
 * CHILD, never in the core's own process, for the same reason
 * `scripts/build.ts` refuses to execute what it bundles: a publish must
 * not be able to run code in the core.
 *
 * Bounded at 15s (§3.7) — a bundle that never returns from module scope is
 * killed, not waited on, and reported as a verification failure rather than
 * hanging the whole stage/verify/activate pipeline (criterion 21).
 */

export interface VerifiedScript {
  id: string
  paramsSchema: unknown
  /**
   * Plan 97 §4.4, §4.7, §5 step 97.2 — already `checkDeclaredSchema`-gated by
   * the child (`verify-child-entry.ts`), mirroring `paramsSchema` above
   * exactly. `null` for a member that declares no `result`. OPTIONAL here
   * (unlike `paramsSchema`) purely so a hand-built `VerifiedScript` fixture
   * written before this field existed — several live outside this file's
   * own ownership list — keeps compiling with no edit of its own; every
   * REAL verify-child report always sets it, never omits it.
   */
  resultSchema?: unknown
  /** Plan 98 §3.1, §5 step 98.4 — already validated by the child (`verify-child-entry.ts`'s own `RuntimeEnvelopeSchema.safeParse`), so this is trusted as typed rather than re-checked here, matching how `paramsSchema` above is trusted once the child's own `checkDeclaredSchema` gate passes. */
  runtime: RuntimeEnvelope | null
  /**
   * Plan 108 §0.2 P8, §5 step 108.3 — the member's own human name and blurb,
   * as the bundle declares them. Optional because most members declare
   * neither, and because a `VerifiedScript` fixture written before this field
   * existed must keep compiling, exactly as `resultSchema` above states.
   */
  title?: string
  description?: string
}

export interface VerifyReport {
  ok: boolean
  pluginId?: string
  version?: string
  title?: string
  description?: string
  scripts: VerifiedScript[]
  /**
   * Plan 108 §3.9, §5 step 108.3 — the PARSED surface (every default
   * applied), present only when the bundle declared one and it passed the
   * independent re-validation in `finalizeReport`. A bundle declaring no
   * surface leaves this `undefined`, and every consumer of a `VerifyReport`
   * behaves exactly as it did before this plan (acceptance criterion 1).
   */
  surface?: PluginSurface
  /**
   * Plan 109 §4.1, §5 step 109.2 — the plugin's SERVICE declaration, parsed
   * and defaulted, present only when the bundle declared one and it passed
   * the independent re-validation in `finalizeReport` (which is also what
   * refuses `isolation: 'process'`, criterion 7). A bundle declaring no
   * service leaves this `undefined` and nothing downstream behaves
   * differently — the runtime host simply never loads it (criterion 1).
   *
   * The `setup` FUNCTION is not here and never will be: it does not cross the
   * verify boundary, and what this report carries is a declaration the parent
   * can decide from. The function is reached by the host importing the same
   * bundle into the core's own process, which is a separate, later decision.
   */
  service?: PluginServiceDeclaration
  resetPackages: string[]
  error?: string
  errorCode?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/

/**
 * How deep a chain of `form` actions may nest through `then`. The vocabulary
 * itself is recursive with no bound of its own (`ActionSpecSchema`'s
 * `z.lazy`), and `maxSurfaceBytes` alone leaves room for a chain deep enough
 * to overflow the stack of the walk below — so the WALK carries its own cap,
 * the same shape `checkDeclaredSchema`'s `MAX_WALK_VISITS` uses for the same
 * reason. Eight is far past any honest form: two ("fill this in, then confirm")
 * is the realistic maximum.
 */
const MAX_ACTION_DEPTH = 8

/** True inside a `bun build --compile` executable — mirrors `@enkaku/session`'s `isolation.ts#isCompiledBinary` (kept as a local copy rather than a cross-package import: that helper is not part of `@enkaku/session`'s public export list, and duplicating two lines is cheaper and safer than widening that package's surface for one caller). */
function isCompiledBinary(): boolean {
  return Bun.main.includes('$bunfs') || Bun.main.includes('~BUN')
}

function failure(error: string, errorCode: string): VerifyReport {
  return { ok: false, error, errorCode, scripts: [], resetPackages: [] }
}

/**
 * Every JSON Schema a surface embeds, through the SAME `checkDeclaredSchema`
 * gate a params schema passes (plan 108 §3.9) — a form action's `schema` (at
 * every depth of a `form → then → form` chain) and every table column's
 * `schema`. A `'group'` finding is the non-consecutive-group WARNING (plan 95
 * §3.5) and is not on its own a refusal, exactly as `verify-child-entry.ts`
 * treats it for a params schema, so the two gates cannot disagree about what
 * a finding means.
 *
 * Returns human-readable strings rather than findings: the caller's only job
 * is to name what is wrong, and the location (`action "sync"`, `view
 * "accounts" column "username"`) is the half a bare finding cannot supply.
 */
function checkSurfaceSchemas(surface: PluginSurface): string[] {
  const errors: string[] = []

  const check = (schema: unknown, where: string): void => {
    if (schema === undefined) return
    for (const finding of checkDeclaredSchema(schema).filter((f) => f.limit !== 'group')) {
      errors.push(`${where}: ${finding.path ? `${finding.path}: ` : ''}${finding.message}`)
    }
  }

  const checkAction = (action: ActionSpec, where: string, depth: number): void => {
    if (action.kind !== 'form') return
    if (depth > MAX_ACTION_DEPTH) {
      errors.push(`${where} nests \`form\` actions more than ${MAX_ACTION_DEPTH} deep`)
      return
    }
    check(action.schema, `${where} form schema`)
    checkAction(action.then, `${where} \`then\``, depth + 1)
  }

  for (const [actionId, action] of Object.entries(surface.actions)) {
    checkAction(action, `action "${actionId}"`, 0)
  }
  for (const [viewId, view] of Object.entries(surface.views)) {
    for (const column of view.table?.columns ?? []) {
      check(column.schema, `view "${viewId}" column "${column.field}"`)
    }
  }
  return errors
}

/**
 * Every React view's declared `@enkaku/ui` major against the one THIS build
 * ships (plan 111 §3.5, §5 step 111.4, acceptance criterion 5).
 *
 * This is the whole reason the check happens at VERIFY and not at render. A
 * component built against a component library that has since changed does not
 * fail loudly in the browser — it throws inside a plugin module that Studio
 * injected as a script tag, and the operator gets a blank panel with no idea
 * whose fault it is (step 111.0 measured exactly that). Refusing here turns it
 * into a named refusal on the plugin row, before the plugin ever activates.
 *
 * Deliberately EXACT equality rather than a supported range, unlike
 * `checkRuntimeMajor`'s `[MIN, CURRENT]` window. A script bundle's `runtime.sdk`
 * spans a range because a script's contract is a small, deliberately stable
 * API the farm can promise across majors; `@enkaku/ui` is explicitly the
 * opposite (plan 111 §2: "a stable public component API" is a non-goal — these
 * are Studio's own components and they change when Studio changes). Claiming a
 * window we do not intend to honour would be the dishonest kind of
 * compatibility. If a window is ever wanted, it becomes a second constant
 * beside `PLUGIN_UI_API_VERSION`, not a silently widened comparison here.
 *
 * A surface with no React view at all produces no errors and costs nothing —
 * a tier-A pack verifies exactly as it did before plan 111.
 */
function checkSurfaceUiApi(surface: PluginSurface): string[] {
  const errors: string[] = []
  for (const [viewId, view] of Object.entries(surface.views)) {
    if (view.react === undefined) continue
    if (view.react.apiVersion === PLUGIN_UI_API_VERSION) continue
    errors.push(
      `view "${viewId}" was built against @enkaku/ui major ${view.react.apiVersion}, and this farm ships major ${PLUGIN_UI_API_VERSION} — rebuild the plugin against @enkaku/ui ${PLUGIN_UI_API_VERSION}, or run a farm that ships major ${view.react.apiVersion}`,
    )
  }
  return errors
}

/** Independent re-validation of what the child reported (§3.7 step 2) — never trusts the SDK's own `definePlugin()` checks alone, since a hand-crafted bundle could bypass them. */
function finalizeReport(msg: VerifyChildMessage, expectedVersion?: string): VerifyReport {
  // A code the CHILD named is carried through rather than flattened: the one
  // surface defect the child can see for itself (a surface that will not
  // serialise, so the parent never receives it) must still reach the operator
  // as `E_PLUGIN_SURFACE_INVALID`, wherever the refusal happened.
  if (!msg.ok) return failure(msg.error, msg.errorCode ?? 'E_PLUGIN_VERIFY_FAILED')

  const seen = new Set<string>()
  for (const s of msg.scripts) {
    if (!ID_SHAPE.test(s.id)) {
      return failure(`script id "${s.id}" does not match ${ID_SHAPE}`, 'E_PLUGIN_BAD_SCRIPT_ID')
    }
    if (seen.has(s.id)) {
      return failure(`duplicate script id "${s.id}" (criterion 22)`, 'E_PLUGIN_DUPLICATE_SCRIPT_ID')
    }
    seen.add(s.id)
  }
  if (expectedVersion !== undefined && msg.version !== expectedVersion) {
    return failure(
      `the bundle declares version "${msg.version}", which does not match the staged version "${expectedVersion}"`,
      'E_PLUGIN_VERSION_MISMATCH',
    )
  }

  // Plan 108 §3.9, §5 step 108.3 — the surface, re-validated HERE and not
  // merely reported by the child, for the same reason the two checks above
  // exist: `definePlugin`'s author-time `validatePluginSurface` runs on the
  // author's own machine, and a hand-crafted bundle need never have called it.
  // A bundle that declares no surface skips all of this and produces exactly
  // the report it produced before this plan (acceptance criterion 1).
  let surface: PluginSurface | undefined
  if (msg.surface !== undefined) {
    const checked = validatePluginSurface(msg.surface)
    if (!checked.ok) return failure(`the plugin's surface is invalid — ${checked.errors.join('; ')}`, 'E_PLUGIN_SURFACE_INVALID')
    const schemaErrors = checkSurfaceSchemas(checked.value)
    if (schemaErrors.length > 0) {
      return failure(`the plugin's surface embeds an unusable JSON Schema — ${schemaErrors.join('; ')}`, 'E_PLUGIN_SURFACE_INVALID')
    }
    // A SEPARATE code from `E_PLUGIN_SURFACE_INVALID` on purpose: the surface
    // above is perfectly well formed, and telling an author their manifest is
    // invalid when the only problem is which component library they built
    // against would send them to look in the wrong place. This is the same
    // distinction `E_RUNTIME_UNSUPPORTED` draws for a script bundle.
    const uiApiErrors = checkSurfaceUiApi(checked.value)
    if (uiApiErrors.length > 0) {
      return failure(`the plugin's UI targets an @enkaku/ui major this farm does not ship — ${uiApiErrors.join('; ')}`, 'E_PLUGIN_UI_UNSUPPORTED')
    }
    surface = checked.value
  }

  // Plan 109 §4.1, §5 step 109.2 — the service declaration, re-validated HERE
  // and not merely reported by the child, on exactly the reasoning the surface
  // block above states: the child's own check runs inside the bundle's own
  // process, and this decides whether that bundle's code is loaded into the
  // CORE's process. The parent does not delegate that.
  let service: PluginServiceDeclaration | undefined
  if (msg.service !== undefined) {
    const parsed = PluginServiceDeclarationSchema.safeParse(msg.service)
    if (!parsed.success) {
      return failure(
        `the plugin's service declaration is invalid — ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
        'E_PLUGIN_SERVICE_INVALID',
      )
    }
    // Criterion 7. A SEPARATE code from `E_PLUGIN_SERVICE_INVALID` on purpose,
    // the same distinction `E_PLUGIN_UI_UNSUPPORTED` draws just above: the
    // declaration is perfectly well formed and the author wrote a value the
    // vocabulary reserves — telling them their manifest is invalid would send
    // them to look for a typo that is not there. What is wrong is the FARM's
    // capability, and the message says so.
    const unsupported = unsupportedIsolationMessage(parsed.data.isolation)
    if (unsupported) return failure(unsupported, 'E_PLUGIN_ISOLATION_UNSUPPORTED')
    // Plan 109 §3.5, step 109.5 — the same schema-accepts / farm-refuses split
    // as `isolation` right above, and for the same reason: the manifest
    // vocabulary must not be pinned to one core build's message list, but THIS
    // build has to say plainly that it will never deliver `device.connected`,
    // rather than accepting the subscription and never firing it.
    const unknownEvents = unknownPluginEventTypesMessage(parsed.data.events)
    if (unknownEvents) return failure(unknownEvents, 'E_PLUGIN_EVENT_UNKNOWN')
    // Step 109.8's own addition to the same accept-then-refuse split. Unlike
    // the check above this one is about a type that IS real: `plugin.log` is a
    // broadcast, so nothing upstream would have caught it — and a plugin
    // subscribed to its own log lines is an unbounded loop inside the core's
    // process with nothing failing for the error budget to see.
    const refusedEvents = refusedPluginEventTypesMessage(parsed.data.events)
    if (refusedEvents) return failure(refusedEvents, 'E_PLUGIN_EVENT_REFUSED')
    // Step 109.7 — two things only the parent can decide about a declared
    // webhook, both refused here rather than at the first delivery.
    const duplicateWebhooks = duplicateWebhookIdsMessage(parsed.data.webhooks)
    if (duplicateWebhooks) return failure(duplicateWebhooks, 'E_PLUGIN_WEBHOOK_INVALID')
    for (const webhook of parsed.data.webhooks) {
      if (webhook.body === undefined || webhook.body === null) continue
      // A declared body schema is author-supplied JSON evaluated by the core on
      // an UNAUTHENTICATED request, so it goes through the same limit walk
      // every other declared schema does — the one that bounds size, depth,
      // width and `$ref` reuse-amplification. `'group'` findings are warnings
      // (`SchemaCheckFinding`'s own note) and do not block.
      const findings = checkDeclaredSchema(webhook.body).filter((f) => f.limit !== 'group')
      if (findings.length > 0) {
        return failure(
          `webhook "${webhook.id}"'s declared body schema is refused — ${findings.map((f) => `${f.path || '(root)'}: ${f.message}`).join('; ')}. ` +
            `It is evaluated by the core on a request nobody had to log in to make, so it is held to the same limits as every other declared schema.`,
          'E_PLUGIN_WEBHOOK_INVALID',
        )
      }
    }
    service = parsed.data
  }

  // Plan 109 step 109.6 — the one cross-check between the two halves above.
  // A view whose `data` is `{ kind: 'handler' }` is answered by `ctx.onQuery`,
  // which is registered by `defineService({ setup })` and exists nowhere else,
  // so a surface that names one without a service could never have rendered.
  //
  // Refused HERE rather than left to fail at render, and the distinction is the
  // whole reason criterion 21's error state stays meaningful: that state says
  // "this plugin's service is down, press Restart", which is true and
  // actionable for an operational outage. Showing it for a plugin that has no
  // service to start would send an operator to press a button that cannot help,
  // for an authoring mistake only the author can fix.
  if (surface) {
    const missing = handlerViewsWithoutServiceMessage(surface, service !== undefined)
    if (missing) return failure(missing, 'E_PLUGIN_HANDLER_NO_SERVICE')
  }

  return {
    ok: true,
    pluginId: msg.pluginId,
    version: msg.version,
    title: msg.title,
    description: msg.description,
    scripts: msg.scripts,
    ...(surface !== undefined ? { surface } : {}),
    ...(service !== undefined ? { service } : {}),
    resetPackages: msg.resetPackages,
  }
}

export interface VerifyPluginBundleOptions {
  timeoutMs?: number
  /** The staged row's own `version` column — the child's reported version must match it (§3.7 step 2). Omit to skip that check (used by tests that only care about shape). */
  expectedVersion?: string
  /** Override for tests — defaults to `verify-child-entry.ts` next to this file. */
  entryPath?: string
}

/** Spawns the bounded verification child and returns its (re-validated) report — never throws; a failure of any kind (bad bundle, timeout, crash) comes back as `{ ok: false, error, errorCode }`, matching §3.8's "assembling the script registry never throws" one level down. */
export async function verifyPluginBundle(bundlePath: string, opts?: VerifyPluginBundleOptions): Promise<VerifyReport> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const entryPath = opts?.entryPath ?? fileURLToPath(new URL('./verify-child-entry.ts', import.meta.url))
  const cmd = isCompiledBinary() ? [process.execPath, '--plugin-verify', bundlePath] : [process.execPath, entryPath, bundlePath]

  return await new Promise<VerifyReport>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>

    const proc = Bun.spawn(cmd, {
      ipc(message) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(finalizeReport(message as VerifyChildMessage, opts?.expectedVersion))
        proc.kill()
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })

    timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill('SIGKILL')
      resolve(failure(`plugin verification exceeded its ${timeoutMs}ms budget`, 'E_PLUGIN_VERIFY_TIMEOUT'))
    }, timeoutMs)

    void proc.exited.then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(failure('the verification child exited without reporting anything', 'E_PLUGIN_VERIFY_CRASHED'))
    })
  })
}
