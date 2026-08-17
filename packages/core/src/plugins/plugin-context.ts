import { buildPluginContext, foreignDeviceScopeError, noDeviceScopeError, type PluginStorageTarget } from '@enkaku/session'
import type { PluginContext } from '@enkaku/sdk'
import { applyKvCall } from '../kv/runner-port'
import type { KvScope, KvStore } from '../kv/store'
import { createLogger } from '../util/logger'
import { EnkakuError } from '../util/errors'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.1. **The core's single door
 * onto the one `PluginContext` builder.**
 *
 * There is no second builder here: this file binds the core's own ports —
 * the KV store, the core logger, the capability broker — and hands them to
 * `@enkaku/session`'s `buildPluginContext`, which is the same function the
 * job child calls (see that file's header for why it lives there and not
 * here, which is where plan 109 §4.8 put it). So `ctx.storage`, `ctx.log` and
 * `ctx.farm` are not "equivalent" across a script handler and an HTTP
 * handler; they are assembled by one function and, for storage, applied to
 * the store by one function (`applyKvCall`).
 *
 * **Criterion 11 is true by construction, not by care.** The context is
 * closed over what it needs and never handed a capability it could re-expose:
 *
 * - the ports this file builds are three plain functions; nothing else
 *   reaches `buildPluginContext`, so there is nothing for it to leak;
 * - `resolveStableId` is a **function**, not a `Db` — this file never holds a
 *   database handle at all;
 * - the `KvStore` is captured in a closure inside a port and is never a
 *   property of any object the context exposes;
 * - `farm` is one `(id, input)` function, never the capability registry.
 *
 * The test asserts that over the returned object's own shape, transitively.
 */

export interface PluginContextDeps {
  /**
   * The plugin's id. It is the KV namespace (plan 79 §3.2 — every member of
   * one plugin shares one namespace) and the log subsystem. Resolved by the
   * host from the installed manifest; **never supplied by plugin code**,
   * which is what stops a plugin reading a neighbour's storage.
   */
  pluginId: string
  store: KvStore
  /**
   * `devices.id` → `stableId`, or `null` when there is no such device
   * (CLAUDE.md, plan 79 §3.3: a KV value is keyed on the stable identity, not
   * on a row that changes on re-enrol). A function rather than a `Db`, so
   * this module — and therefore the context — never holds a database handle.
   */
  resolveStableId(deviceId: string): string | null
  /**
   * The device this context is bound to, when it has one. An event handler
   * for a single device may set it; an HTTP handler has none, and
   * `ctx.storage.device` then refuses with `E_NO_DEVICE_SCOPE` rather than
   * silently reading the farm-wide scope.
   */
  deviceId?: string
  /**
   * The capability broker (plan 109 §4.3, step 109.3, `farm-broker.ts`).
   * Already gated by the time it reaches here: it checks the manifest's
   * declared permissions BEFORE `invoke()`, then lets `invoke()` check the
   * real ACL under a `plugin:<name>` principal, and audits the call.
   *
   * Optional, and fail-closed when absent — `E_FARM_UNAVAILABLE`, never a
   * silent success. `daemon.ts` always wires it; a test that does not is
   * saying "this context has no farm", which is a real answer rather than an
   * unfinished one.
   */
  farm?: (id: string, input: unknown) => Promise<unknown>
  /**
   * One log line. Defaults to the core logger under `plugin.<id>`; step
   * 109.8 replaces it with the per-plugin ring + rotated file + `plugin.log`
   * broadcast, and nothing about the context changes when it does.
   */
  emitLog?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void
  /**
   * Stamps an error the core is about to reject one of this plugin's ports
   * with (plan 109 §4.2's Rejections row, step 109.2 — tier 2 of the
   * attribution in `runtime-host.ts`).
   *
   * It exists because §4.2's stated mechanism does not work on this runtime:
   * `AsyncLocalStorage` is not readable inside `process.on('unhandledRejection')`
   * in Bun, and `async_hooks.createHook` is a no-op there, so there is no
   * async-context tag to read. A stamp on the ERROR OBJECT survives arbitrary
   * `.then()` hops — a floating `void ctx.storage.forDevice(x).get(...)` is
   * still attributable to the plugin that floated it.
   *
   * Absent (every test, and the script child, which is a separate process and
   * has no such problem) ⇒ errors are unstamped and the host falls back to its
   * remaining tiers or reports the rejection as unattributed.
   */
  tagError?: (err: unknown) => unknown
}

export function createPluginContext(deps: PluginContextDeps): PluginContext {
  const { pluginId, store, resolveStableId } = deps
  const logger = createLogger(`plugin.${pluginId}`)
  const emitLog =
    deps.emitLog ??
    ((level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => logger[level](msg, fields))

  /** Turns a target into a `KvScope`, or throws the same coded error the child throws. */
  const scopeFor = (target: PluginStorageTarget): KvScope => {
    if (target.kind === 'global') return { kind: 'global' }
    const deviceId = target.kind === 'device' ? target.deviceId : deps.deviceId
    if (deviceId === undefined) throw noDeviceScopeError()
    const stableId = resolveStableId(deviceId)
    if (!stableId) throw new EnkakuError('E_DEVICE_NOT_FOUND', `no such device: ${deviceId}`)
    return { kind: 'device', stableId }
  }

  const tag = deps.tagError ?? ((err: unknown) => err)

  return buildPluginContext({
    emitLog,
    kv(target, call) {
      try {
        // `applyKvCall` is the SAME translation that services the job child's
        // `kv.call` IPC message (`kv/runner-port.ts`). `updatedByJobId` is
        // null here and that is honest: a runtime handler is not a job, and
        // recording a fabricated id on the row would make the store lie about
        // who last wrote a value.
        return Promise.resolve(applyKvCall(store, scopeFor(target), pluginId, call))
      } catch (err) {
        return Promise.reject(tag(err))
      }
    },
    farm(id, input) {
      if (!deps.farm) {
        return Promise.reject(
          tag(
            Object.assign(new Error(`ctx.farm.call("${id}"): the capability broker is not available on this host`), {
              code: 'E_FARM_UNAVAILABLE',
            }),
          ),
        )
      }
      // The broker's own refusals (`E_FARM_UNDECLARED`, `E_FORBIDDEN`, …) are
      // stamped too — they are the ones a plugin is most likely to float.
      return deps.farm(id, input).catch((err: unknown) => {
        throw tag(err)
      })
    },
  })
}

/**
 * Exported for the same reason `foreignDeviceScopeError` is: the two hosts
 * must refuse identically, and a test proving criterion 2 needs to name the
 * codes it expects from both.
 */
export { noDeviceScopeError, foreignDeviceScopeError }
