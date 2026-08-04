package dev.enkaku.guestagent.route

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import dev.enkaku.guestagent.R
import java.io.File
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * The enforcing route: a `VpnService` whose TUN traffic is forwarded to a SOCKS5 upstream by
 * `hev-socks5-tunnel`.
 *
 * This is the rung `settings put global http_proxy` can never reach. That setting is advisory —
 * an app is free to ignore it. Traffic entering a TUN is not, which is the whole reason this app
 * exists.
 *
 * Not exported: only this app's own control channel starts it, so unlike [BootstrapActivity] it has
 * no reason to be reachable from `adb shell am`.
 */
class RouteVpnService : VpnService() {

  /**
   * Every route operation runs here, never on the main thread.
   *
   * `onStartCommand` is called on the main thread, and both halves of this service block: the
   * native `TProxyStopService()` call, a `join()` of up to [STOP_TIMEOUT_MS] on the tunnel thread,
   * `establish()`, and writing the config file. Doing that inline froze the whole process — the
   * device showed "isn't responding", and `BootstrapActivity` rendered a blank white screen because
   * it shares this main thread, which in turn meant the host's bootstrap never handed over a token
   * and the agent stayed `unreachable` however many times Repair was pressed.
   *
   * Single-threaded on purpose: it also serialises start against stop, so a fast off/on cannot
   * interleave two teardowns.
   */
  private val ops = Executors.newSingleThreadExecutor { r ->
    Thread(r, "enkaku-route-ops").apply { isDaemon = true }
  }

  private val tun = AtomicReference<ParcelFileDescriptor?>(null)
  private val worker = AtomicReference<Thread?>(null)
  private val configFile = AtomicReference<File?>(null)

  /**
   * The upstream this route is CURRENTLY dialled against, credentials included — in memory only,
   * never persisted, never sent back over the control channel (plan 51 §4.2). Its sole reader is
   * [EgressProbe]'s tunnelled leg, which needs the exact same host/port/credentials
   * `hev-socks5-tunnel` was handed so it measures the identical connection rather than a
   * lookalike. Lifetime matches the route's own config file (also cleartext, also deleted in
   * [teardown]) — this is no wider an exposure than what already exists on disk while a route is
   * up.
   */
  private val currentUpstreamRef = AtomicReference<Socks5Upstream?>(null)

  override fun onCreate() {
    super.onCreate()
    active.set(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        // Off the main thread — see [ops]. stopSelf() waits for the teardown it belongs to.
        ops.execute {
          runCatching { teardown() }.onFailure { Log.e(TAG, "teardown failed", it) }
          stopSelf()
        }
        return START_NOT_STICKY
      }
      ACTION_HOLD -> {
        // Plan 54 §5.2 — the dead-man's switch's own path in, but reachable by anything else that
        // wants to hold rather than tear down. `handleFailure` decides whether this device's own
        // `failClosed` policy actually wants a hold or a legacy tear-down.
        val reason = intent.getStringExtra(EXTRA_REASON) ?: "held"
        ops.execute { handleFailure(reason) }
        return START_NOT_STICKY
      }
      else -> {
        val upstream = intent?.toUpstream()
        if (upstream == null) {
          RouteState.markError("missing or malformed upstream")
          stopSelf()
          return START_NOT_STICKY
        }
        // startForeground must happen promptly on the main thread or the system kills us; only the
        // slow work below is handed off.
        startInForeground()
        ops.execute {
          runCatching { start(upstream) }
            .onFailure {
              Log.e(TAG, "route start failed", it)
              // Plan 54 §3.1: a start() that fails AFTER establish() already handed us a live TUN
              // must not tear that TUN down — `handleFailure` holds it closed instead when the
              // route's own `failClosed` policy says so, and only falls through to a real
              // teardown when nothing was ever established (nothing to leak from) or the policy
              // explicitly opted out.
              handleFailure(it.message ?: it.javaClass.simpleName)
            }
        }
      }
    }
    // Never restarted by the system on its own: a route belongs to a lease, and the host reapplies
    // it deliberately. Coming back by itself would resurrect a route whose lease has ended.
    return START_NOT_STICKY
  }

  override fun onRevoke() {
    // The user, or another VPN app taking over, revoked us. Android has already torn the TUN down
    // by the time this callback runs — there is nothing left to hold closed, unlike every OTHER
    // failure path this service handles (plan 54 §3.1) — so this stays a real teardown regardless
    // of `failClosed`.
    Log.w(TAG, "VPN consent revoked")
    RouteState.markDown("revoked")
    ops.execute {
      runCatching { teardown() }
      stopSelf()
    }
    super.onRevoke()
  }

  override fun onDestroy() {
    // Best-effort and non-blocking: the process may be going away regardless, and blocking here
    // would ANR just as surely as blocking in onStartCommand did.
    ops.execute { runCatching { teardown() } }
    ops.shutdown()
    // Only clear if WE are still the registered instance — a fast stop/start could already have
    // installed a fresh one by the time this runs, and this must not disown that one.
    active.compareAndSet(this, null)
    super.onDestroy()
  }

  private fun start(upstream: Socks5Upstream) {
    // `tun.get() != null` on its own (worker null) is exactly a HELD route: forwarding already
    // stopped, but the TUN is still open and never got closed. A restore (the host resending
    // `route.start` per plan 54 §4.2) must tear that down properly before establishing a fresh
    // one — reusing `worker.get() != null` alone would miss it and leak the old descriptor.
    if (worker.get() != null || tun.get() != null) {
      Log.i(TAG, "route already up or held; replacing it")
      teardown()
    }

    // Resolve the upstream BEFORE establish(), and hand hev an IP rather than a name.
    //
    // Once the VPN is up the system resolver points at the tunnel's own mapped DNS
    // (Socks5Config.MAPPED_DNS_IPV4), so a hostname here becomes a chicken-and-egg: hev would ask
    // the tunnel to resolve the address of the very proxy the tunnel needs in order to work. It
    // fails every time, every session dies at "socks5 client resolve", and the device reports the
    // route as up while nothing can connect. Diagnosed exactly that way — 206 of 206 sessions.
    val resolved = runCatching { InetAddress.getByName(upstream.host).hostAddress }.getOrNull()
    if (resolved == null) {
      RouteState.markDown("cannot resolve ${upstream.host}")
      Log.e(TAG, "failed to resolve ${upstream.host} before establishing the tunnel")
      stopSelf()
      return
    }
    val dialled = upstream.copy(host = resolved)

    val descriptor =
      Builder()
        .setSession("Enkaku route")
        .setMtu(Socks5Config.MTU)
        .addAddress(Socks5Config.TUN_IPV4, Socks5Config.TUN_PREFIX_LENGTH)
        // Default route: everything goes through the tunnel. That is the point of this engine.
        .addRoute("0.0.0.0", 0)
        // The tunnel's own resolver, not a real one — see Socks5Config.MAPPED_DNS_IPV4 for why
        // a real resolver breaks browsing through a TCP-only SOCKS5 proxy.
        .addDnsServer(Socks5Config.MAPPED_DNS_IPV4)
        // Exclude ourselves, or our own upstream connection would re-enter the TUN.
        .addDisallowedApplication(packageName)
        .establish()

    if (descriptor == null) {
      // establish() returns null when the app is not prepared or consent was revoked. The host
      // pre-grants this with `appops set <pkg> ACTIVATE_VPN allow`; a null here means that step
      // was skipped or did not take effect on this Android version.
      RouteState.markDown("not prepared — is the ACTIVATE_VPN app-op granted?")
      Log.e(TAG, "establish() returned null")
      stopSelf()
      return
    }
    tun.set(descriptor)

    val config = Socks5Config.write(filesDir, dialled)
    configFile.set(config)

    val thread =
      Thread({
          try {
            // Blocks until TProxyStopService(). The fd is duplicated natively; we still own ours.
            Tun2Socks.TProxyStartService(config.absolutePath, descriptor.fd)
          } catch (t: Throwable) {
            Log.e(TAG, "tunnel stopped unexpectedly", t)
            // Plan 54 §3.1: the TUN (`tun`) is untouched here on purpose — closing it on a dead
            // worker thread is exactly the leak this plan exists to close. `handleFailure` decides
            // hold-vs-teardown from this route's own `failClosed` policy.
            handleFailure(t.message ?: t.javaClass.simpleName)
          }
        },
        "enkaku-tun2socks",
      )
    worker.set(thread)
    thread.start()
    RouteState.markUp("${upstream.host}:${upstream.port}") {
      runCatching { Tun2Socks.TProxyGetStats() }.getOrNull()
    }
    // `dialled` (resolved IP, real credentials) — NOT the original `upstream` — matches exactly
    // what was handed to hev-socks5-tunnel above, so EgressProbe's tunnelled leg measures the
    // identical connection rather than a lookalike that resolves the hostname differently. Also
    // the one place `handleFailure`/`failClosed()` read this route's fail-closed policy from.
    currentUpstreamRef.set(dialled)
    Log.i(TAG, "route up via ${upstream.host}:${upstream.port}")
  }

  /**
   * The one decision point for hold-vs-tear-down on ANY failure while a route is (or was) up
   * (plan 54 §3.1, §4.2) — the dead-man's switch, a dead tunnel thread, and a `start()` that fails
   * after `establish()` already handed us a live TUN all funnel through here, so `failClosed` is
   * read and applied identically everywhere instead of each call site guessing its own answer.
   */
  private fun handleFailure(reason: String) {
    if (tun.get() == null) {
      // Nothing was ever established — no TUN, no capture, nothing that could leak. Fail-closed
      // only means something once a route was actually up (the state table in plan 54 §4.1 starts
      // from `up`), so this is a plain down, same as before this plan.
      RouteState.markDown(reason)
      stopSelf()
      return
    }
    if (currentUpstreamRef.get()?.failClosed != false) {
      // The default, and the safe one: leave the TUN exactly as it is (still `0.0.0.0/0 → tun0`)
      // and only stop forwarding. No teardown work happens here, so this is safe to run inline off
      // any thread — see `RouteState.markHeld`'s doc comment for what this promises.
      worker.set(null)
      RouteState.markHeld(reason)
      Log.w(TAG, "route held closed: $reason")
    } else {
      // failClosed explicitly false: preserve the pre-plan-54 tear-down behaviour for an operator
      // debugging by hand (plan 54 §4.2). Routed through `ops` so it serialises against a
      // concurrent start()/teardown() the same way every other route mutation does.
      Log.w(TAG, "route torn down (failClosed=false): $reason")
      ops.execute {
        runCatching { teardown(reason) }
        stopSelf()
      }
    }
  }

  private fun teardown(reason: String? = null) {
    worker.getAndSet(null)?.let {
      runCatching { Tun2Socks.TProxyStopService() }
      it.join(STOP_TIMEOUT_MS)
    }
    runCatching { tun.getAndSet(null)?.close() }
    // The config holds the upstream password, so it does not outlive the route.
    configFile.getAndSet(null)?.delete()
    currentUpstreamRef.set(null)
    RouteState.markDown(reason)
  }

  /**
   * Protects a socket so its traffic leaves on the underlying network instead of re-entering our
   * own TUN. Exposed for the control channel's egress probe, which must be measured from outside
   * the tunnel to mean anything.
   */
  fun protectOutbound(socket: Socket): Boolean = protect(socket)

  private fun startInForeground() {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Device farm route", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Active while farm traffic is routed through a test proxy."
        setShowBadge(false)
      },
    )
    val notification: Notification =
      Notification.Builder(this, CHANNEL_ID)
        .setContentTitle("Enkaku route active")
        .setContentText("Traffic is routed through a test proxy.")
        .setSmallIcon(R.mipmap.ic_launcher)
        .setOngoing(true)
        .build()

    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun Intent.toUpstream(): Socks5Upstream? {
    val host = getStringExtra(EXTRA_HOST) ?: return null
    val port = getIntExtra(EXTRA_PORT, -1).takeIf { it in 1..65535 } ?: return null
    return Socks5Upstream(
      host = host,
      port = port,
      username = getStringExtra(EXTRA_USERNAME),
      password = getStringExtra(EXTRA_PASSWORD),
      udpMode = getStringExtra(EXTRA_UDP_MODE) ?: "udp",
      // Default true (fail-closed) if the extra is ever missing — the safe reading when in doubt,
      // matching `Socks5Upstream.failClosed`'s own default (plan 54 §4.2).
      failClosed = getBooleanExtra(EXTRA_FAIL_CLOSED, true),
    )
  }

  companion object {
    private const val TAG = "EnkakuGuestAgent"
    private const val CHANNEL_ID = "enkaku-route"
    private const val NOTIFICATION_ID = 2
    private const val STOP_TIMEOUT_MS = 3_000L

    const val ACTION_STOP = "dev.enkaku.guestagent.ROUTE_STOP"
    const val ACTION_HOLD = "dev.enkaku.guestagent.ROUTE_HOLD"
    const val EXTRA_HOST = "host"
    const val EXTRA_PORT = "port"
    const val EXTRA_USERNAME = "username"
    const val EXTRA_PASSWORD = "password"
    const val EXTRA_UDP_MODE = "udpMode"
    const val EXTRA_FAIL_CLOSED = "failClosed"
    const val EXTRA_REASON = "reason"

    fun start(context: Context, upstream: Socks5Upstream) {
      val intent =
        Intent(context, RouteVpnService::class.java)
          .putExtra(EXTRA_HOST, upstream.host)
          .putExtra(EXTRA_PORT, upstream.port)
          .putExtra(EXTRA_USERNAME, upstream.username)
          .putExtra(EXTRA_PASSWORD, upstream.password)
          .putExtra(EXTRA_UDP_MODE, upstream.udpMode)
          .putExtra(EXTRA_FAIL_CLOSED, upstream.failClosed)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      context.startService(Intent(context, RouteVpnService::class.java).setAction(ACTION_STOP))
    }

    /**
     * Plan 54 §3.1, §5.2 — the dead-man's switch's own entry point, and anything else that wants
     * "hold closed" rather than "tear down". Routed through the SAME `handleFailure` decision
     * point every other failure path uses, so `failClosed=false` is honoured here too instead of
     * this call site silently always holding.
     */
    fun hold(context: Context, reason: String) {
      context.startService(Intent(context, RouteVpnService::class.java).setAction(ACTION_HOLD).putExtra(EXTRA_REASON, reason))
    }

    /**
     * Whether the currently active route should fail closed rather than tear down on the next
     * failure (plan 54 §4.2) — read off the upstream the active route was actually started with.
     * Defaults true (the safe reading) when there is no active route to ask, since every caller of
     * this only consults it while a route is meant to be up.
     */
    fun failClosed(): Boolean = active.get()?.currentUpstreamRef?.get()?.failClosed != false

    /**
     * Whether the VPN consent has already been granted, so the host can tell "not pre-granted"
     * apart from "upstream unreachable" instead of reporting one failure for both.
     */
    fun isPrepared(context: Context): Boolean = prepare(context) == null

    /** The currently running instance, or null when no route is up. Set in [onCreate], cleared in [onDestroy]. */
    private val active = AtomicReference<RouteVpnService?>(null)

    fun activeInstance(): RouteVpnService? = active.get()

    /** See [currentUpstreamRef]'s doc comment — null when no route is currently up. */
    fun currentUpstream(): Socks5Upstream? = active.get()?.currentUpstreamRef?.get()

    /**
     * Runs [block] on the active instance's own single-thread [ops] executor — serialising a
     * probe against a concurrent start()/teardown() the same way every other route operation
     * already is — or directly on the calling thread when no route is up (there is no [ops]
     * executor to reuse then, and the caller — [dev.enkaku.guestagent.control.ControlService]'s
     * own worker pool — is already off the main thread; plan 51 §4.2's "never the main thread"
     * rule is satisfied either way).
     */
    fun <T> submitProbe(budgetMs: Long, block: () -> T): T {
      val instance = active.get() ?: return block()
      return instance.ops.submit(Callable { block() }).get(budgetMs, TimeUnit.MILLISECONDS)
    }
  }
}
