import { z } from 'zod'
import type { ActionSpec, Binding, PluginActionResult } from '@enkaku/protocol'
import { canUseDevice, type Permission } from '../auth/acl'
import type { AuditLogger } from '../auth/audit'
import type { Role } from '../auth/service'
import { createBatch, type BatchDispatchDeps } from '../groups/dispatch'
import { devices } from '../db/schema'
import type { KvScope, KvStore } from '../kv/store'
import type { ScriptRegistry } from '../scripts/registry'
import type { JobService } from '../services/job-service'
import { EnkakuError } from '../util/errors'
import { evaluateBinding, evaluateBindingAsString, type BindingScope } from './binding'
import type { PluginRuntime } from './runtime'
import { resolvePluginSurface } from './surface-registry'

/**
 * Runs one DECLARED action from a plugin's verified surface (plan 108 §4.5,
 * §5 step 108.5).
 *
 * **Why this exists at all** — plan §4.5's three reasons, each otherwise a
 * hole in the browser:
 *
 * 1. A `batch` needs a concrete `scripts.id` while a `job` takes a reference
 *    (G7: `POST /api/jobs` accepts `scriptRef`, `POST /api/batches` does not).
 *    Resolving `tiktok/list-accounts@latest` in Studio would be a second copy
 *    of `ScriptRegistry.resolve` — including its `@latest`-means-the-ACTIVE-
 *    version rule and its `script_is_dev` refusal — living in a bundle that
 *    ships separately from the one it must agree with.
 * 2. The binding evaluation must be IDENTICAL to what was verified. It is the
 *    same `binding.ts` the surface was checked against, called once, here.
 * 3. The audit entry should name the plugin and the action, not merely "a job
 *    was created". `plugin.action` is that row.
 *
 * **What it can and cannot reach.** Every kind dispatches through a function
 * the farm already has — `JobService.enqueue`, `groups/dispatch.ts`'s
 * `createBatch`, `KvStore` — never SQL of its own. So a plugin action is
 * bounded by exactly the same gates the equivalent hand-made request is:
 * `canUseDevice`, `validateScriptForRun`, the params schema, the runtime
 * ceiling, the KV quotas. The KV namespace is FORCED to the plugin's own name
 * here for the same reason the `/:name/data/*` routes force it from the path
 * (§3.7): there is no field in the vocabulary to name another one, and no
 * value a browser can send that reaches one.
 */

/** Who is running the action. `null` is a non-interactive caller — no ownership or role gate, the same convention `stopBatch` uses. */
export type PluginActionActor = { id: string; role: Role } | null

export interface PluginActionDeps {
  runtime: PluginRuntime
  audit: AuditLogger
  /** Resolves a declared `ScriptRef` — the SAME registry `POST /api/jobs` and `POST /api/batches` resolve through. */
  registry: ScriptRegistry
  /** Namespace is never taken from this dep — always the plugin name (§3.7). */
  kv: KvStore
  jobService: Pick<JobService, 'enqueue'>
  /**
   * Built PER ACTING USER, because two of `createBatch`'s dependencies are
   * per-request and the rest are not: `validateScript` needs the caller's role
   * (plan 93 §3.12's `JobExecutor.requires` gate) and `assertDeviceAllowed`
   * needs their identity (`canUseDevice`). A factory rather than a fixed bag
   * keeps this file from re-implementing either check — the host builds the
   * exact same closure `api/batches.ts` builds for `POST /api/batches`, so a
   * batch dispatched from a plugin screen and one dispatched from the batches
   * page cannot be gated differently.
   */
  batch: (actor: PluginActionActor) => BatchDispatchDeps
  /**
   * `canUseDevice`'s device half (plan 34 §3.5, §4.4) — the SAME lookup every
   * other ownership check in the farm shares. A `job` action needs nothing
   * here (`JobService.enqueue` runs the check itself, given `actor`); a
   * `batch` does, because `createBatch`'s equivalent gate is a dependency it
   * has to be GIVEN. Composed with whatever `batch()` already supplies rather
   * than replacing it, so a host that wires its own `assertDeviceAllowed`
   * keeps it and gets this as well. Omitted (a test harness, or a host with
   * no auth wired) means no ownership restriction — the same default every
   * other optional ACL dependency in this codebase has.
   */
  getDeviceOwner?: (deviceId: string) => { ownerId: string | null } | null
}

export interface PluginActionInput {
  plugin: string
  actionId: string
  /** Verbatim from the browser — never assumed well-shaped; see `BindingScope`. */
  row?: unknown
  form?: unknown
  deviceIds?: string[]
  actor: PluginActionActor
}

export interface PluginActionExecutor {
  /** The declared action, or a coded refusal (`plugin_not_found` / `action_not_found`). Used by the route to derive the permission BEFORE executing. */
  lookup(plugin: string, actionId: string): ActionSpec
  execute(input: PluginActionInput): PluginActionResult
}

/**
 * The permission ONE action needs (plan 108 §3.7's table) — derived from the
 * action, never hardcoded per route, so a surface that adds a `kv.set` button
 * to a view cannot pick up `job.run`'s gate by accident.
 *
 * A `form` is gated by whatever its `then` resolves to, recursively: the
 * dialog itself grants nothing, and the only thing that actually happens is
 * the `then`.
 */
export function actionPermission(action: ActionSpec): Permission {
  switch (action.kind) {
    case 'job':
    case 'batch':
      return 'job.run'
    case 'kv.set':
    case 'kv.delete':
      return 'plugin.data'
    case 'form':
      return actionPermission(action.then)
  }
}

/**
 * The two sub-objects a rendered row carries alongside its own fields — the
 * shape `data/scan` produces and `ViewRenderer` flattens (plan §4.3's own
 * `$device.label` / `$entry.updatedAt` columns). Parsed rather than read
 * directly off `input.row`, because the row crossed a wire: a caller could
 * send `$device: 42`, and `$device.stableId` is what a device-scoped `kv.set`
 * writes against.
 *
 * A plain `z.object` STRIPS the row's own fields rather than refusing them —
 * intended: this parse exists only to lift `$device`/`$entry` out safely, and
 * `scope.row` keeps the whole row for `$row` paths.
 */
const RowDeviceSchema = z
  .object({
    id: z.string().optional(),
    stableId: z.string().optional(),
    label: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    groupId: z.string().nullable().optional(),
    /** The short human-facing number (plan 89 §3.1). `null` for a device with no reservation — a real state, never an error. */
    number: z.number().int().nullable().optional(),
  })
  .nullable()
  .optional()

const RowEntrySchema = z
  .object({
    key: z.string().optional(),
    version: z.number().optional(),
    updatedAt: z.number().optional(),
  })
  .nullable()
  .optional()

/**
 * `$device` and `$entry` are parsed SEPARATELY, and both are `.nullable()`.
 *
 * Both details are the same shipped bug, found on the very first row a fresh
 * farm renders. A device that has never been synced has no kv entry, so
 * `kv.scan`'s `includeMissing` row carries `$entry: null` — and an
 * `.optional()` object refuses `null`. Parsed as ONE envelope, that single
 * failure took `$device` down with it, and the action then reported
 * "the row carries no `$device.id`": the wrong field, on a row that carried it
 * perfectly well. The only row a first-run demo has is the only row that could
 * not be acted on.
 *
 * Parsing them apart means a malformed half can never blind the other, and
 * `.nullable()` means "this row has no entry" is data rather than a defect.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function scopeFrom(input: PluginActionInput): BindingScope {
  const row = input.row
  const raw = isPlainObject(row) ? row : {}
  const device = RowDeviceSchema.safeParse(raw.$device)
  const entry = RowEntrySchema.safeParse(raw.$entry)
  return {
    row,
    form: input.form,
    device: device.success ? (device.data ?? null) : null,
    entry: entry.success ? (entry.data ?? null) : null,
  }
}

function paramsOf(binding: Binding | undefined, scope: BindingScope): unknown {
  return binding === undefined ? undefined : evaluateBinding(binding, scope)
}

function badRequest(plugin: string, actionId: string, detail: string): EnkakuError {
  return new EnkakuError('E_BAD_REQUEST', `action "${plugin}/${actionId}": ${detail}`)
}

export function createPluginActionExecutor(deps: PluginActionDeps): PluginActionExecutor {
  const { runtime, audit, registry, kv, jobService } = deps

  const lookup = (plugin: string, actionId: string): ActionSpec => {
    // The SAME precedence `surface-registry.ts` applies to a nav entry and a
    // view — a dev slot shadows the published plugin entirely, so a button
    // drawn from the dev build's surface runs the dev build's action.
    const resolved = resolvePluginSurface(runtime, plugin)
    if (!resolved) {
      throw new EnkakuError('plugin_not_found', `no active plugin or dev slot named "${plugin}" declares a screen`)
    }
    if (!Object.hasOwn(resolved.surface.actions, actionId)) {
      throw new EnkakuError('action_not_found', `plugin "${plugin}" declares no action "${actionId}"`)
    }
    const action = resolved.surface.actions[actionId]
    if (!action) throw new EnkakuError('action_not_found', `plugin "${plugin}" declares no action "${actionId}"`)
    return action
  }

  /** The device a `device: 'row'` job runs on — the row's own device, never a caller-chosen one. */
  const rowDeviceId = (input: PluginActionInput, scope: BindingScope): string => {
    const id = scope.device?.id
    if (typeof id !== 'string' || id.length === 0) {
      throw badRequest(input.plugin, input.actionId, 'declares `device: "row"` but the row carries no `$device.id`')
    }
    return id
  }

  const pickedDeviceId = (input: PluginActionInput): string => {
    const ids = input.deviceIds ?? []
    const id = ids.length === 1 ? ids[0] : undefined
    if (id === undefined) {
      throw badRequest(input.plugin, input.actionId, `declares \`device: "picker"\` and needs exactly one deviceId, got ${ids.length}`)
    }
    return id
  }

  const kvScopeFor = (input: PluginActionInput, action: { scope: 'global' | 'device' }, scope: BindingScope): KvScope => {
    if (action.scope === 'global') return { kind: 'global' }
    const stableId = scope.device?.stableId
    if (typeof stableId !== 'string' || stableId.length === 0) {
      throw badRequest(input.plugin, input.actionId, 'writes a device-scoped key but the row carries no `$device.stableId`')
    }
    return { kind: 'device', stableId }
  }

  /**
   * `target: 'all'` — every enrolled device. A plain id listing, not batch
   * SQL: `createBatch` still resolves each one, reports the unusable ones as
   * skipped, and writes every row.
   */
  const allDeviceIds = (batchDeps: BatchDispatchDeps): string[] =>
    batchDeps.db
      .select({ id: devices.id })
      .from(devices)
      .all()
      .map((r) => r.id)

  const run = (action: ActionSpec, input: PluginActionInput, scope: BindingScope): { result: PluginActionResult; target: string } => {
    switch (action.kind) {
      case 'job': {
        // `allowDev: true` — a click on a plugin's own screen IS the "explicit
        // ad-hoc run" `ScriptRegistry.resolve`'s own `script_is_dev` message
        // names as the one thing a dev build may be reached by. The REFERENCE
        // is what the surface declared and what is passed through here; the
        // registry pins it to a concrete row, exactly as `POST /api/jobs`
        // does with its own `scriptRef`.
        const entry = registry.resolve(action.script, { allowDev: true })
        const deviceId = action.device === 'row' ? rowDeviceId(input, scope) : pickedDeviceId(input)
        const job = jobService.enqueue({
          scriptId: entry.id,
          deviceId,
          params: paramsOf(action.params, scope),
          actor: input.actor,
        })
        return { result: { kind: 'job', jobId: job.jobId, deviceId, scriptId: entry.id }, target: deviceId }
      }

      case 'batch': {
        // No `allowDev` — plan 82 §3.5's rule, stated by the registry's own
        // refusal message: "dev scripts run only via an explicit ad-hoc run or
        // trigger, never a schedule or a batch". A dev plugin's batch action
        // therefore reports `script_is_dev` at click time rather than
        // silently dispatching the published build behind the dev screen.
        const entry = registry.resolve(action.script)
        const base = deps.batch(input.actor)
        // An operator targeting a device they do not own refuses the WHOLE
        // batch before a row is written — `createBatch`'s own contract for
        // this hook, and the same answer `POST /api/batches` gives.
        const batchDeps: BatchDispatchDeps = {
          ...base,
          assertDeviceAllowed: (deviceId) => {
            base.assertDeviceAllowed?.(deviceId)
            const actor = input.actor
            const owner = deps.getDeviceOwner?.(deviceId)
            if (actor && owner && !canUseDevice(actor, owner)) {
              throw new EnkakuError('auth.forbidden', 'this device belongs to another user')
            }
          },
        }
        const chosen = input.deviceIds ?? []
        const deviceIds = action.target === 'all' ? allDeviceIds(batchDeps) : chosen
        if (deviceIds.length === 0) {
          throw new EnkakuError(
            'E_NO_TARGETS',
            action.target === 'all'
              ? `action "${input.plugin}/${input.actionId}" targets every device, and this farm has none enrolled`
              : `action "${input.plugin}/${input.actionId}" needs at least one device (target: "${action.target}")`,
          )
        }
        const { batch, jobs } = createBatch(batchDeps, {
          // Concrete, resolved HERE — never the ref (`CreateBatchBody` has no
          // `scriptRef` member, G7).
          scriptId: entry.id,
          params: paramsOf(action.params, scope),
          target: { deviceIds },
          concurrency: 0,
          order: 'as-listed',
          createdBy: input.actor?.id ?? null,
        })
        return {
          result: { kind: 'batch', batchId: batch.id, scriptId: entry.id, jobCount: jobs.length },
          target: `${batch.id} (${jobs.length} device${jobs.length === 1 ? '' : 's'})`,
        }
      }

      case 'kv.set': {
        const kvScope = kvScopeFor(input, action, scope)
        const key = evaluateBindingAsString(action.key, scope)
        if (!key) throw badRequest(input.plugin, input.actionId, 'its `key` binding did not resolve to a non-empty string')
        // The namespace is `input.plugin` and can be nothing else — §3.7.
        kv.set(kvScope, input.plugin, key, evaluateBinding(action.value, scope), { secret: action.secret })
        const stableId = kvScope.kind === 'device' ? kvScope.stableId : null
        return { result: { kind: 'kv.set', scope: action.scope, stableId, key }, target: `${input.plugin}:${key}` }
      }

      case 'kv.delete': {
        const kvScope = kvScopeFor(input, action, scope)
        const key = evaluateBindingAsString(action.key, scope)
        if (!key) throw badRequest(input.plugin, input.actionId, 'its `key` binding did not resolve to a non-empty string')
        const deleted = kv.delete(kvScope, input.plugin, key)
        const stableId = kvScope.kind === 'device' ? kvScope.stableId : null
        return { result: { kind: 'kv.delete', scope: action.scope, stableId, key, deleted }, target: `${input.plugin}:${key}` }
      }

      case 'form':
        // The dialog itself does nothing; `$form.*` is already in `scope`
        // (the browser sent what it collected), so this is simply the `then`.
        // Recursive rather than special-cased per kind — the same shape
        // `ActionSpecSchema`'s own `z.lazy` has.
        return run(action.then, input, scope)
    }
  }

  return {
    lookup,

    execute(input) {
      const action = lookup(input.plugin, input.actionId)
      const scope = scopeFrom(input)
      const { result, target } = run(action, input, scope)
      // ONE row per execution (criterion 15), naming all three things. A
      // `batch` also produces `createBatch`'s own `job.run` row — that one
      // says a batch was dispatched; this one says which plugin screen asked
      // for it, which is the question the other cannot answer.
      audit.record({
        userId: input.actor?.id ?? null,
        action: 'plugin.action',
        target: `${input.plugin}/${input.actionId}`,
        meta: { plugin: input.plugin, actionId: input.actionId, kind: result.kind, target },
      })
      return result
    },
  }
}
