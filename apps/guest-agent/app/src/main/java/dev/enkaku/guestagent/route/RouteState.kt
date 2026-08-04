package dev.enkaku.guestagent.route

import java.util.concurrent.atomic.AtomicReference

/**
 * What the route is actually doing, readable without holding a reference to the service.
 *
 * This exists so `route.status` answers from observation rather than from whatever the host last
 * asked for. The two diverge in ways that matter — the user revokes VPN consent from Settings, the
 * tunnel thread dies, another VPN app takes over — and a farm that cannot see the difference will
 * happily run a whole test suite through the wrong egress and report success.
 *
 * Plan 54 §4.1 replaces a plain up/down boolean with three states, because two of them used to
 * collapse into the same lie: a route whose forwarding died used to report `up: false` exactly the
 * same way a route that was never configured did — and the host could not tell "this device is
 * about to leak on its real address" from "nothing is happening here at all".
 */
enum class RouteLifecycleState {
  /** TUN established, forwarding running — the route is actually carrying traffic. */
  UP,

  /**
   * TUN still established (`0.0.0.0/0 → tun0`), forwarding stopped on purpose. Packets keep
   * entering the TUN and go nowhere — this is fail-closed, not a bug. See
   * `RouteVpnService.handleFailure()` for who reaches this state and why.
   */
  HELD,

  /** No TUN. Only reached by an explicit `route.stop`, the operator removing the route, or VPN
   * consent being revoked out from under us — never by a failure while a route was up. */
  DOWN,
}

object RouteState {
  private val state = AtomicReference(RouteLifecycleState.DOWN)
  private val upstream = AtomicReference<String?>(null)
  private val error = AtomicReference<String?>(null)
  private val statsProvider = AtomicReference<(() -> LongArray?)?>(null)

  fun markUp(description: String, stats: () -> LongArray?) {
    upstream.set(description)
    statsProvider.set(stats)
    error.set(null)
    state.set(RouteLifecycleState.UP)
  }

  /**
   * Forwarding stopped, TUN left established (plan 54 §3.1, §4.1) — `reason` is the plain-language
   * account of why (a dead-man's-switch timeout, a dead tunnel thread, a start failure after the
   * TUN was already up). `upstream` is deliberately NOT cleared: the host still wants to know what
   * this route was pointed at while it waits to come back.
   */
  fun markHeld(reason: String) {
    state.set(RouteLifecycleState.HELD)
    statsProvider.set(null)
    error.set(reason)
  }

  fun markDown(reason: String?) {
    state.set(RouteLifecycleState.DOWN)
    statsProvider.set(null)
    upstream.set(null)
    reason?.let { error.set(it) }
  }

  fun markError(reason: String) {
    error.set(reason)
  }

  fun current(): RouteLifecycleState = state.get()

  /** True only in [RouteLifecycleState.UP] — a held route is deliberately NOT "up" (plan 54 §4.3: it must never read as healthy). */
  fun isUp(): Boolean = state.get() == RouteLifecycleState.UP

  fun isHeld(): Boolean = state.get() == RouteLifecycleState.HELD

  /** Host and port only — never the credentials, which must not leave the device in any form. */
  fun describeUpstream(): String? = upstream.get()

  fun lastError(): String? = error.get()

  fun stats(): List<Long>? = statsProvider.get()?.invoke()?.toList()
}
