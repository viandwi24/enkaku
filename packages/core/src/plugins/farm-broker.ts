import { FarmCallSchema, type FarmRunnerDeps } from '@enkaku/session'
import type { AuditLogger } from '../auth/audit'
import type { Role } from '../auth/service'
import { createCapabilityContext, type CapabilityActor, type CapabilityContextDeps } from '../capability/context'
import { invoke } from '../capability/invoke'
import type { CapabilityRegistry } from '../capability/registry'
import { EnkakuError } from '../util/errors'
import { createLogger, type Logger } from '../util/logger'
import type { PluginRuntime } from './runtime'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.3 — **the capability broker.**
 * The one door between `ctx.farm` and the farm's own capabilities, for both
 * hosts: a plugin's long-lived `service` running in the core process, and a
 * plugin member script running in a job child.
 *
 * ## What this is, and what it is emphatically not
 *
 * It is **not** a sandbox, and the word is not used for it (plan 109 §2, §3.2;
 * `docs/spec.md` §11.3 keeps the same discipline for job isolation). A plugin
 * runs inside the core's own process with the core's own OS authority: it can
 * `import('node:fs')`, open the farm's SQLite file directly, or call
 * `process.exit()`. Nothing here prevents any of that, and a comment implying
 * otherwise would be a lie an operator might act on.
 *
 * What it narrows is exactly one thing: **what a plugin reaches THROUGH `ctx`**.
 * That is worth building anyway, for two reasons that have nothing to do with
 * containment:
 *
 * 1. **A declared list is a readable one.** `service.permissions` is shown at
 *    install (plan 109 §4.1, criterion 20). A gate that actually refuses what
 *    the list omits is what makes the list mean something, rather than being
 *    decorative text beside a plugin that quietly calls whatever it likes.
 * 2. **Answerability.** Every call through this door lands in the audit log
 *    under the `plugin:<name>` principal, so "what has this plugin done to my
 *    farm" is one query. A plugin that reaches around `ctx` leaves no such
 *    trail — which is the honest argument for keeping `ctx` the pleasant path.
 *
 * ## The order of the two checks, and why the first one must come first
 *
 * ```
 *   ctx.farm.call(id, input)
 *     │
 *     ├─ 1. is `id` in this plugin's MANIFEST?   ── no ─→ E_FARM_UNDECLARED, audited, invoke() never entered
 *     ├─ 2. does `id` exist in the registry?     ── no ─→ E_FARM_UNKNOWN_CAPABILITY, audited, likewise
 *     └─ 3. invoke(cap, ctx-bound-to-plugin:<name>, input)
 *              └─ the REAL ACL, the real device grant, the real lease, the real deadline, the real audit row
 * ```
 *
 * Criterion 10's load-bearing half is that step 1 happens **before** `invoke()`
 * is called — not called-then-rolled-back, not called-and-discarded. An
 * undeclared `device.app.clear` must not clear an app and then be reported as
 * refused. `farm-broker.test.ts` proves it with a capability that records
 * whether its handler ran, and with the audit log as an independent second
 * witness: `invoke()` writes exactly one `capability.invoke` row on *every*
 * path it takes, including its own `E_BAD_INPUT`, so the absence of that row
 * is proof the function was never entered.
 *
 * Step 1 is also upstream of `invoke`'s own input parse, deliberately: an
 * undeclared capability called with garbage input is refused as UNDECLARED,
 * because the manifest is the more useful thing to be told about.
 *
 * ## Known gap, reported rather than left to be discovered
 *
 * **A plugin being iterated in a DEV SLOT (`enkaku dev`) has no `ctx.farm`
 * until it has been published once.** Both accessors this reads —
 * `plugins.active(name)` and `plugins.service(name)` — answer for the ACTIVE
 * row only; a dev slot shadows the active row for tier-B assets (plan 111
 * §4.4) but not for the service declaration. So a dev-slot script's farm call
 * is refused `E_FARM_NO_PLUGIN`, which is honest but abrupt. This is inherited
 * from step 109.2, whose host does not load a dev slot's service either, and
 * closing it means deciding what a dev slot's declared permissions mean — an
 * unpublished manifest nobody consented to at install. Left for whichever step
 * takes that decision with the owner, rather than half-answered here.
 */

/** The audit action every broker-level refusal is recorded under. */
const BROKER_AUDIT_ACTION = 'plugin.capability'

/**
 * The principal a plugin's capability calls are made and audited under (plan
 * 109 §4.3). Deliberately prefixed rather than bare: `audit_log.user_id` also
 * carries human user ids and agent ids, and `plugin:` is what makes "every row
 * this plugin is responsible for" a single, unambiguous query.
 */
export const PLUGIN_PRINCIPAL_PREFIX = 'plugin:'

export function pluginPrincipalId(pluginName: string): string {
  return `${PLUGIN_PRINCIPAL_PREFIX}${pluginName}`
}

/** The inverse, for a reader of the audit log. `null` for any other principal. */
export function pluginNameFromPrincipal(principal: string): string | null {
  return principal.startsWith(PLUGIN_PRINCIPAL_PREFIX) ? principal.slice(PLUGIN_PRINCIPAL_PREFIX.length) : null
}

/**
 * The two `PluginRuntime` accessors the broker reads, and nothing else — it
 * never writes a plugin row. Narrowed structurally so a test supplies two
 * functions rather than a whole registry.
 */
export type BrokerPlugins = Pick<PluginRuntime, 'active' | 'service'>

export interface FarmBrokerCall {
  /** The plugin's own id (`definePlugin({ id })`), which is also `plugins.name` and its KV namespace. */
  pluginId: string
  /** A capability id — `device.list`, `job.enqueue`. */
  capability: string
  input?: unknown
  /**
   * Which half of the plugin called. Recorded on a refusal so an operator can
   * tell "the service did this on a timer" from "a job the operator started
   * did this" — two very different things to be looking at.
   */
  via: 'service' | 'script'
  /** The job the call came from, when `via === 'script'`. */
  jobId?: string
  /** The job's own device, when `via === 'script'`. NOT the capability's target — that is `input.deviceId`, and `invoke` records it separately. */
  jobDeviceId?: string
}

export interface FarmBrokerDeps {
  registry: CapabilityRegistry
  contextDeps: CapabilityContextDeps
  plugins: BrokerPlugins
  /**
   * Optional only so a test can assert the broker's refusals without a
   * database behind them. **`daemon.ts` always wires it** — a farm that
   * silently stopped recording plugin capability calls would be the exact
   * failure this step exists to prevent.
   */
  audit?: AuditLogger
  /**
   * `plugins.created_by` → that user's role, resolved **live on every call**
   * (the discipline plan 67 §3.4 established for an agent run: demoting a
   * publisher narrows their plugin immediately, not at the next reload).
   *
   * Absent, or answering `null`, means `'operator'` — the narrower of the two
   * roles. A host that has not wired this can therefore never hand a plugin
   * admin authority by omission, and a plugin whose publisher has since been
   * deleted degrades to the narrower answer rather than keeping the wider one.
   *
   * **Why the publisher and not a fixed role.** A fixed `'operator'` would put
   * `device.files`, `device.shell` and `fs`-wide writes permanently out of
   * reach of every plugin on every farm, with no way to grant them short of
   * editing this file — and an operator-published plugin would silently fail
   * at a call its manifest declared. Deriving from the publisher keeps plan
   * 65 §3.5's rule ("never wider than its owner's own set") true for plugins
   * too, and it is the rule the risk table in plan 109 §8 already assumes:
   * *"a declared permission the operator does not hold is refused at call time
   * regardless of the manifest"*.
   *
   * Stated plainly, because it is the uncomfortable half: on a farm whose
   * plugins were published by an admin, this hands those plugins admin
   * authority over the capability surface. That is a real widening, and it is
   * still narrower than the truth of in-process loading — a plugin with the
   * core's process already has the database file.
   */
  roleOf?(userId: string | null): Role | null
  log?: Logger
}

export interface FarmBroker {
  /**
   * Run one capability on a plugin's behalf. Resolves with the capability's
   * output; rejects with a coded `EnkakuError` for every refusal, whether it
   * came from this broker (`E_FARM_*`) or from `invoke()` itself
   * (`E_FORBIDDEN`, `E_NO_GRANT`, `E_NEEDS_LEASE`, `E_DEVICE_OFFLINE`,
   * `E_BAD_INPUT`, `E_DEADLINE`, or a handler's own coded error).
   */
  call(call: FarmBrokerCall): Promise<unknown>
  /** The principal and role this plugin's calls run under, resolved the same way `call` resolves it. Exported for tests and for anything that wants to show an operator what a plugin invokes as. */
  actorFor(pluginName: string): CapabilityActor
}

export function createFarmBroker(deps: FarmBrokerDeps): FarmBroker {
  const log = deps.log ?? createLogger('plugin.broker')

  function actorFor(pluginName: string): CapabilityActor {
    const publisher = deps.plugins.active(pluginName)?.createdBy ?? null
    return { id: pluginPrincipalId(pluginName), role: deps.roleOf?.(publisher) ?? 'operator' }
  }

  return {
    actorFor,

    async call(c: FarmBrokerCall): Promise<unknown> {
      const startedAt = Date.now()
      const principal = pluginPrincipalId(c.pluginId)

      /**
       * A refusal this broker made ITSELF, i.e. one that never reached
       * `invoke()`. It gets its own audit action for a reason worth stating:
       * a refusal is the more interesting row of the two. An accepted call is
       * a plugin doing what its manifest says it does; a refusal is a plugin
       * reaching for something its manifest does not mention, which is either
       * a bug the author has not noticed or a change nobody consented to at
       * install time. Giving it its own action makes "show me every plugin
       * that tried something undeclared" one query instead of a scan of every
       * `capability.invoke` refusal on the farm.
       *
       * `declared` is recorded verbatim rather than left to be looked up
       * later: a manifest changes on reload, and the row should say what the
       * plugin had declared *at the moment it was refused*.
       *
       * The input is never recorded — the same rule `kv.set` and
       * `command.run` already state, and for the same reason: a capability
       * input can carry a secret.
       */
      const refuse = (code: string, message: string, extra?: Record<string, unknown>): never => {
        deps.audit?.record({
          userId: principal,
          action: BROKER_AUDIT_ACTION,
          ...(c.capability ? { target: c.capability } : {}),
          meta: {
            plugin: c.pluginId,
            capability: c.capability,
            outcome: 'refused',
            code,
            via: c.via,
            jobId: c.jobId ?? null,
            jobDeviceId: c.jobDeviceId ?? null,
            durationMs: Date.now() - startedAt,
            ...extra,
          },
        })
        log.warn(`plugin "${c.pluginId}": ${message}`)
        throw new EnkakuError(code, message)
      }

      // The call comes from plugin code, so it is external input and is parsed
      // rather than trusted — even though the script side already crossed
      // `FarmCallSchema` once on the IPC boundary. The service side has no IPC
      // boundary at all, so this is that side's ONLY parse.
      const parsed = FarmCallSchema.safeParse({ capability: c.capability, input: c.input })
      if (!parsed.success) {
        return refuse(
          'E_BAD_INPUT',
          `ctx.farm.call(...): ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
        )
      }
      const { capability, input } = parsed.data

      // 1a. Is this even a plugin? The job child resolves its namespace as
      // `pluginId ?? scriptId ?? jobId` for `kv.call`, where a standalone
      // script legitimately gets a namespace of its own — but there is nothing
      // for a standalone script to have declared, so `job-runner.ts` refuses
      // that case before it reaches here and this is the backstop for every
      // other caller.
      const row = deps.plugins.active(c.pluginId)
      if (!row) {
        return refuse(
          'E_FARM_NO_PLUGIN',
          `ctx.farm.call("${capability}"): there is no active plugin named "${c.pluginId}", so there is no manifest to check this call against`,
        )
      }

      // 1b. The manifest gate — BEFORE invoke(), which is criterion 10's whole point.
      const declaration = deps.plugins.service(c.pluginId)
      if (!declaration) {
        return refuse(
          'E_FARM_UNDECLARED',
          `ctx.farm.call("${capability}"): plugin "${c.pluginId}@${row.version}" declares no service, so it has declared no farm capabilities — ` +
            `add service: defineService({ permissions: ['${capability}'], … }) and republish`,
          { declared: [] },
        )
      }
      const declared = [...declaration.permissions]
      if (!declared.includes(capability)) {
        return refuse(
          'E_FARM_UNDECLARED',
          `ctx.farm.call("${capability}"): plugin "${c.pluginId}@${row.version}" did not declare it. ` +
            `Its manifest declares ${declared.length > 0 ? declared.map((d) => `"${d}"`).join(', ') : '(nothing)'} — ` +
            `the list is exhaustive on purpose: it is what an operator consented to at install`,
          { declared },
        )
      }

      // 2. Declared, but does it exist? A typo that survives the manifest
      // (because the manifest is where it was typed) lands here.
      const cap = deps.registry.get(capability)
      if (!cap) {
        return refuse(
          'E_FARM_UNKNOWN_CAPABILITY',
          `ctx.farm.call("${capability}"): plugin "${c.pluginId}@${row.version}" declared it, but this farm has no such capability — ` +
            `check the id against GET /api/v1/cap`,
          { declared },
        )
      }

      // 3. The real door. `invoke` re-checks EVERYTHING against the real ACL
      // under the plugin principal — permission, device grant, lease,
      // readiness, deadline — and writes the one audit row this accepted call
      // gets (criterion 10: exactly one). The broker deliberately does not
      // write a second `plugin.capability` row beside it: `capability.invoke`
      // already carries the plugin (`userId`), the capability (`target`) and
      // the outcome, and plan 63's acceptance #7 — *every* capability
      // invocation is in the log under one action — would be broken by a
      // plugin path that opted out of it.
      const actor = actorFor(c.pluginId)
      const ctx = createCapabilityContext(deps.contextDeps, actor)
      const result = await invoke(cap, ctx, input, deps.audit ? { audit: deps.audit } : undefined)
      if (result.ok) return result.output
      throw new EnkakuError(
        result.error.code,
        `ctx.farm.call("${capability}") was refused for plugin "${c.pluginId}" (as ${actor.id}, role ${actor.role}): ${result.error.message}`,
      )
    },
  }
}

/**
 * The parent side of a job child's `farm.call` (plan 109 §4.3) — the same
 * shape `createKvRunnerPort`/`createJobsRunnerPort` already have, and the
 * reason `FarmRunnerDeps` is declared in `@enkaku/session` rather than here:
 * that package cannot import the capability registry, so it names a port and
 * the core fills it in.
 *
 * There is nothing to decide here. A script's `ctx.farm` and a service's
 * `ctx.farm` reach the SAME broker, are checked against the same manifest, and
 * are audited under the same principal — the only difference is `via`, which
 * exists so the row says which half of the plugin was running.
 */
export function createFarmRunnerPort(broker: FarmBroker): FarmRunnerDeps {
  return {
    call(ctx, call) {
      return broker.call({
        pluginId: ctx.pluginId,
        capability: call.capability,
        ...(call.input !== undefined ? { input: call.input } : {}),
        via: 'script',
        jobId: ctx.jobId,
        jobDeviceId: ctx.deviceId,
      })
    },
  }
}
