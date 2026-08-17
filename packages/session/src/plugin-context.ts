import type { FarmApi, PluginContext, PluginKv, PluginStorage } from '@enkaku/sdk'
import type { z } from 'zod'
import { createKvApiFor } from './runner/kv-client'
import type { KvCall } from './runner/ipc'

/**
 * Plan 109 (M74), step 109.1 — **the ONE `PluginContext` builder**, shared by
 * every entry point (§3.1). Each host supplies primitive PORTS (emit one log
 * line, make one KV round trip, invoke one capability); this function owns
 * the object's shape, its scoping rules and its coded refusals. Two hosts
 * that assemble their own contexts agree today and disagree in three months
 * — acceptance criterion 2 exists to make that impossible, so there is
 * exactly one assembler and it is this one.
 *
 * **Why it lives in `@enkaku/session` and not in `@enkaku/sdk`** (plan 109
 * §4.8 puts `plugin-context.ts` under `packages/core`, which cannot work):
 * the two hosts are the job CHILD process — `runner/child-entry.ts`, in this
 * package — and the CORE. `packages/core` depends on `@enkaku/session`;
 * `@enkaku/session` must never depend on `@enkaku/core`, so a builder in
 * core is unreachable from the child and criterion 2 could only have been met
 * by writing it twice. `@enkaku/sdk` cannot host it either: `ctx.storage`'s
 * client (`createKvApiFor`) and the `KvCall` wire shape it speaks both live
 * in this package, and moving them would split a Zod schema from the type it
 * generates. So this package is the one place both hosts can reach that
 * already owns the pieces. `packages/core/src/plugins/plugin-context.ts` is
 * the core's port bindings and its single door onto this function; it is not
 * a second builder.
 *
 * @see packages/sdk/src/runtime.ts for the author-facing types.
 */

/** Which store one KV round trip is addressed to. Resolved by the host's port, never by a plugin. */
export type PluginStorageTarget =
  /** Farm-wide (`kv_entries.scope_id = ''`). */
  | { kind: 'global' }
  /** The context's own device, if it has one — a job's device in a script handler; nothing in an HTTP handler. */
  | { kind: 'ambient-device' }
  /** A device named by the caller. */
  | { kind: 'device'; deviceId: string }

/**
 * What a host must supply. Deliberately three primitive functions and
 * nothing else: **no `Db`, no `KvStore`, no capability registry is passed in,
 * so none can be reachable from the context** (criterion 11 by construction —
 * this function has nothing to leak, rather than remembering not to).
 */
export interface PluginContextPorts {
  /** One log line. The child sends an IPC `log` message; the core writes to the plugin's runtime logger. */
  emitLog(level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>): void
  /**
   * One KV round trip. The child sends `kv.call` over IPC; the core applies it
   * to the store directly — via the SAME `applyKvCall` translation that
   * services the child's message, so both ends are one implementation.
   * Rejects with a coded error (`E_NO_DEVICE_SCOPE`, `E_FOREIGN_DEVICE_SCOPE`,
   * `E_DEVICE_NOT_FOUND`, `E_KV_UNAVAILABLE`) rather than resolving a wrong
   * scope.
   */
  kv(target: PluginStorageTarget, call: KvCall): Promise<unknown>
  /**
   * One farm capability invocation, already gated by the broker (step 109.3).
   * Rejects with the refusal's own code; `E_FARM_UNAVAILABLE` when the host
   * has not wired a broker at all.
   */
  farm(id: string, input: unknown): Promise<unknown>
}

export function buildPluginContext(ports: PluginContextPorts): PluginContext {
  // `createKvApiFor` is plan 79's own client, reused verbatim — the schema
  // check on `get`, the `E_KV_SCHEMA_MISMATCH` error that names the key, the
  // option forwarding: one implementation, both hosts. The explicit `PluginKv`
  // annotations are a free drift guard: if the client's shape and the SDK's
  // `KvApi` ever diverge, this file stops compiling.
  //
  // `createKvApiFor`'s `request` parameter is generic (`<T>(call) => Promise<T>`) because its
  // internal callers name the shape they expect. A port that answers `unknown` cannot prove `T`,
  // and nothing bridges that gap without an assertion — `child-entry.ts`'s own `kvRequest`
  // already resolves it the same way (`resolve as (v: unknown) => void`). The assertion is
  // confined to this one line and weakens nothing: `get` still validates against the CALLER's own
  // schema inside `createKvApiFor`, and every other op's shape comes from the store rather than
  // from anything a plugin supplied.
  const requestFor =
    (target: PluginStorageTarget) =>
    <T>(call: KvCall): Promise<T> =>
      ports.kv(target, call) as Promise<T>

  const global: PluginKv = createKvApiFor('global', requestFor({ kind: 'global' }))
  const device: PluginKv = createKvApiFor('device', requestFor({ kind: 'ambient-device' }))

  const storage: PluginStorage = {
    global,
    device,
    forDevice(deviceId: string): PluginKv {
      const kv: PluginKv = createKvApiFor('device', requestFor({ kind: 'device', deviceId }))
      return kv
    },
  }

  const farm: FarmApi = {
    callRaw(id: string, input?: unknown): Promise<unknown> {
      return ports.farm(id, input)
    },
    async call<T>(id: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
      const raw = await ports.farm(id, input)
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        // The same discipline `ctx.storage.get` already applies to a stored
        // value: the farm's output schema can change under a plugin published
        // months ago, and the caller's own expectation is what decides.
        throw Object.assign(new Error(`farm.call("${id}"): the output does not match the given schema — ${parsed.error.message}`), {
          code: 'E_FARM_SCHEMA_MISMATCH',
        })
      }
      return parsed.data
    },
  }

  return {
    storage,
    log: {
      debug: (msg, fields) => ports.emitLog('debug', msg, fields),
      info: (msg, fields) => ports.emitLog('info', msg, fields),
      warn: (msg, fields) => ports.emitLog('warn', msg, fields),
      error: (msg, fields) => ports.emitLog('error', msg, fields),
    },
    farm,
  }
}

/**
 * The JOB CHILD's half of `buildPluginContext` (plan 109 §3.1's `script` row).
 * Every port is an IPC round trip the caller supplies, so this function is a
 * plain, directly-testable unit rather than something that only runs inside a
 * spawned process — the same reasoning `createKvApiFor` and
 * `createJobsApiFor` are already written to.
 *
 * `child-entry.ts` calls exactly this, and so does the test proving criterion
 * 2, so the "script handler" side of that proof is the real code path and not
 * a re-creation of it.
 */
export interface ChildPluginContextDeps {
  /** This job's device (`devices.id`) — the ONLY device scope a script may reach (plan 108 §3.1 G4). */
  deviceId: string
  /** `child-entry.ts`'s `kvRequest`. The scope travels inside the call; the parent resolves it against the job's own device. */
  kvRequest(call: KvCall): Promise<unknown>
  /** `child-entry.ts`'s `farmRequest`. */
  farmRequest(id: string, input: unknown): Promise<unknown>
  /** `child-entry.ts`'s `log` — one IPC `log` message per line. */
  emitLog(level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>): void
}

export function createChildPluginContext(deps: ChildPluginContextDeps): PluginContext {
  return buildPluginContext({
    emitLog: deps.emitLog,
    kv(target, call) {
      // `ambient-device` and `forDevice(own)` are the same request: the parent
      // resolves `scope: 'device'` against the job's own device row and never
      // reads a device id from the child, so this refusal is a clear error
      // rather than the only thing standing between a script and another
      // device's data.
      if (target.kind === 'device' && target.deviceId !== deps.deviceId) {
        return Promise.reject(foreignDeviceScopeError(target.deviceId, deps.deviceId))
      }
      return deps.kvRequest(call)
    },
    farm: deps.farmRequest,
  })
}

/** Thrown by a host's `kv` port. Kept here so both hosts refuse identically. */
export function noDeviceScopeError(): Error & { code: string } {
  return Object.assign(
    new Error('ctx.storage.device: this context is not bound to a device — name one with ctx.storage.forDevice(deviceId)'),
    { code: 'E_NO_DEVICE_SCOPE' },
  )
}

/** Thrown by the CHILD's `kv` port: a script may only ever reach its own device's scope (plan 108 §3.1 G4). */
export function foreignDeviceScopeError(wanted: string, own: string): Error & { code: string } {
  return Object.assign(
    new Error(`ctx.storage.forDevice("${wanted}"): a script may only reach its own device's scope (${own})`),
    { code: 'E_FOREIGN_DEVICE_SCOPE' },
  )
}
