package dev.enkaku.guestagent.route

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * What the route is actually doing, readable without holding a reference to the service.
 *
 * This exists so `route.status` answers from observation rather than from whatever the host last
 * asked for. The two diverge in ways that matter — the user revokes VPN consent from Settings, the
 * tunnel thread dies, another VPN app takes over — and a farm that cannot see the difference will
 * happily run a whole test suite through the wrong egress and report success.
 */
object RouteState {
  private val up = AtomicBoolean(false)
  private val upstream = AtomicReference<String?>(null)
  private val error = AtomicReference<String?>(null)
  private val statsProvider = AtomicReference<(() -> LongArray?)?>(null)

  fun markUp(description: String, stats: () -> LongArray?) {
    upstream.set(description)
    statsProvider.set(stats)
    error.set(null)
    up.set(true)
  }

  fun markDown(reason: String?) {
    up.set(false)
    statsProvider.set(null)
    upstream.set(null)
    reason?.let { error.set(it) }
  }

  fun markError(reason: String) {
    error.set(reason)
  }

  fun isUp(): Boolean = up.get()

  /** Host and port only — never the credentials, which must not leave the device in any form. */
  fun describeUpstream(): String? = upstream.get()

  fun lastError(): String? = error.get()

  fun stats(): List<Long>? = statsProvider.get()?.invoke()?.toList()
}
