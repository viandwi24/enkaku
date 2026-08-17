import type { ServerMessage } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.5 — **the farm-event tap.**
 *
 * A plugin declares which farm events it wants (`defineService({ events })`),
 * registers handlers with `ctx.onEvent`, and hears them. That is the whole
 * feature. Everything interesting here is about what it must NOT be able to
 * do, which is acceptance criterion 12:
 *
 * > An event handler cannot veto, delay, or modify an event: a handler that
 * > throws or hangs changes **nothing** about the broadcast.
 *
 * ## Why this is a separate file from the host
 *
 * Two different jobs, and mixing them is how the "delay" clause gets lost.
 * This module owns **routing and detachment**: which subscriptions match a
 * message, and *when* they run. `runtime-host.ts` owns **containment**: the
 * deadline, the try/catch, the error budget. The host passes `deliver`, so
 * every event delivery goes through the same `invoke` funnel as every other
 * entry into plugin code — there is deliberately no second door.
 *
 * ## "Cannot delay" is the clause that decides the implementation
 *
 * "Cannot veto" and "cannot modify" are free: the tap runs after
 * `WsHub.broadcast` has already written the message to every client, and its
 * return value is discarded. "Cannot delay" is the one that would be quietly
 * broken by the obvious implementation. Three ways it could break, and what
 * stops each:
 *
 * | how a handler could delay a broadcast | what stops it |
 * |---|---|
 * | the tap `await`s the handlers | `observe` returns `void` and `WsHub` never awaits an observer |
 * | the tap calls the handler inline, and the handler does work before its first `await` | `schedule` — dispatch is deferred to a fresh macrotask, so *no* part of a handler runs inside the broadcast's frame |
 * | the handler blocks the event loop synchronously (`while (true) {}`) | **nothing.** In-process cannot fix it, and plan 109 §3.2 says so out loud rather than implying a guarantee it does not have |
 *
 * The default `schedule` is `setTimeout(fn, 0)` and not `queueMicrotask`: a
 * microtask still runs in the same tick, before the broadcaster's own
 * continuation resumes, so a handler's synchronous prefix would still land in
 * front of core work. A macrotask puts every byte of plugin code behind the
 * event loop's current turn.
 *
 * One `schedule` per broadcast, not per subscription: the handlers a single
 * event fans out to are already independent of each other (each is separately
 * raced against its own deadline inside `invoke`), and a timer per plugin per
 * event would be real churn on a high-rate type like `job.progress`.
 */

export interface PluginEventSubscription {
  pluginId: string
  /** A `ServerMessage` type — the core's own vocabulary, never a plugin-facing alias (R2, §9 Q1). */
  type: string
  handler: (event: ServerMessage, signal: AbortSignal) => void | Promise<void>
  /** Per-handler deadline override, clamped by the host. */
  timeoutMs?: number
}

interface Registration extends PluginEventSubscription {
  /**
   * Flipped by `unsubscribe`/`clear`. Checked again at DISPATCH time, not
   * only at `observe` time: a plugin unloaded in the gap between the
   * broadcast and the scheduled dispatch must not be handed an event its
   * disposers have already torn the state down for.
   */
  alive: boolean
}

export interface PluginEventRouterDeps {
  /**
   * Deliver one event to one subscription. Supplied by the host, which routes
   * it through `invoke` — so the deadline, the `try`/`catch` and the error
   * budget are the same ones every other entry into plugin code gets.
   * Fire-and-forget: whatever it returns is not awaited here, by contract.
   */
  deliver(sub: PluginEventSubscription, event: ServerMessage): void
  /**
   * How dispatch is detached from the broadcast's own frame. Defaults to a
   * macrotask (see the header). Injectable so a test can prove the DELAY
   * claim in both directions — an inline `schedule` is the negative control
   * that shows the timing harness can see a delay when one exists.
   */
  schedule?: (fn: () => void) => void
  log: Logger
}

export interface PluginEventRouter {
  /** Register one handler. Returns the function that removes it. */
  subscribe(sub: PluginEventSubscription): () => void
  /** Remove every subscription belonging to one plugin (called on unload). */
  clear(pluginId: string): void
  /**
   * **The tap.** Synchronous, `void`, and never throws — `WsHub.broadcast`
   * calls this with a message it has already delivered to every client.
   */
  observe(event: ServerMessage): void
  /** The event types one plugin is subscribed to, in registration order. */
  subscriptionsOf(pluginId: string): string[]
  /** Every type with at least one live subscriber. Observability only. */
  activeTypes(): string[]
}

export function createPluginEventRouter(deps: PluginEventRouterDeps): PluginEventRouter {
  const schedule = deps.schedule ?? ((fn: () => void) => void setTimeout(fn, 0))
  const byType = new Map<string, Registration[]>()

  function remove(reg: Registration): void {
    if (!reg.alive) return
    reg.alive = false
    const list = byType.get(reg.type)
    if (!list) return
    const next = list.filter((r) => r !== reg)
    if (next.length === 0) byType.delete(reg.type)
    else byType.set(reg.type, next)
  }

  return {
    subscribe(sub) {
      const reg: Registration = { ...sub, alive: true }
      const list = byType.get(sub.type)
      if (list) list.push(reg)
      else byType.set(sub.type, [reg])
      return () => remove(reg)
    },

    clear(pluginId) {
      for (const list of [...byType.values()]) {
        for (const reg of list) {
          if (reg.pluginId === pluginId) remove(reg)
        }
      }
    },

    observe(event) {
      // The cheap exit first: on a farm with no subscribing plugin this is one
      // `Map.get` on a message the core was broadcasting anyway.
      const list = byType.get(event.type)
      if (!list || list.length === 0) return
      // Snapshot, so a `subscribe` during dispatch cannot grow what this event
      // fans out to. Liveness is re-checked below, so a REMOVAL still takes
      // effect — the two are not symmetric on purpose.
      const targets = [...list]
      schedule(() => {
        for (const reg of targets) {
          if (!reg.alive) continue
          try {
            deps.deliver(reg, event)
          } catch (err) {
            // `deliver` funnels through `invoke`, which does not throw
            // synchronously — but a tap that can be broken by its own callback
            // is not a tap. One failed delivery never stops the next.
            deps.log.warn(
              `plugin "${reg.pluginId}": dispatching ${event.type} failed before it reached the handler — ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      })
    },

    subscriptionsOf(pluginId) {
      const types: string[] = []
      for (const list of byType.values()) {
        for (const reg of list) {
          if (reg.pluginId === pluginId && reg.alive) types.push(reg.type)
        }
      }
      return types
    },

    activeTypes: () => [...byType.keys()],
  }
}
