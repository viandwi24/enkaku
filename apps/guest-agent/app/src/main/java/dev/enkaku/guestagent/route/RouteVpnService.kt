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
import java.util.concurrent.Executors
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
              RouteState.markDown(it.message ?: it.javaClass.simpleName)
              stopSelf()
            }
        }
      }
    }
    // Never restarted by the system on its own: a route belongs to a lease, and the host reapplies
    // it deliberately. Coming back by itself would resurrect a route whose lease has ended.
    return START_NOT_STICKY
  }

  override fun onRevoke() {
    // The user, or another VPN app taking over, revoked us. Tear down rather than linger in a state
    // where status would claim a route that no longer carries traffic.
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
    super.onDestroy()
  }

  private fun start(upstream: Socks5Upstream) {
    if (worker.get() != null) {
      Log.i(TAG, "route already up; replacing it")
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
            RouteState.markDown(t.message ?: t.javaClass.simpleName)
            Log.e(TAG, "tunnel stopped unexpectedly", t)
          }
        },
        "enkaku-tun2socks",
      )
    worker.set(thread)
    thread.start()
    RouteState.markUp("${upstream.host}:${upstream.port}") {
      runCatching { Tun2Socks.TProxyGetStats() }.getOrNull()
    }
    Log.i(TAG, "route up via ${upstream.host}:${upstream.port}")
  }

  private fun teardown() {
    worker.getAndSet(null)?.let {
      runCatching { Tun2Socks.TProxyStopService() }
      it.join(STOP_TIMEOUT_MS)
    }
    runCatching { tun.getAndSet(null)?.close() }
    // The config holds the upstream password, so it does not outlive the route.
    configFile.getAndSet(null)?.delete()
    RouteState.markDown(null)
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
    )
  }

  companion object {
    private const val TAG = "EnkakuGuestAgent"
    private const val CHANNEL_ID = "enkaku-route"
    private const val NOTIFICATION_ID = 2
    private const val STOP_TIMEOUT_MS = 3_000L

    const val ACTION_STOP = "dev.enkaku.guestagent.ROUTE_STOP"
    const val EXTRA_HOST = "host"
    const val EXTRA_PORT = "port"
    const val EXTRA_USERNAME = "username"
    const val EXTRA_PASSWORD = "password"
    const val EXTRA_UDP_MODE = "udpMode"

    fun start(context: Context, upstream: Socks5Upstream) {
      val intent =
        Intent(context, RouteVpnService::class.java)
          .putExtra(EXTRA_HOST, upstream.host)
          .putExtra(EXTRA_PORT, upstream.port)
          .putExtra(EXTRA_USERNAME, upstream.username)
          .putExtra(EXTRA_PASSWORD, upstream.password)
          .putExtra(EXTRA_UDP_MODE, upstream.udpMode)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      context.startService(Intent(context, RouteVpnService::class.java).setAction(ACTION_STOP))
    }

    /**
     * Whether the VPN consent has already been granted, so the host can tell "not pre-granted"
     * apart from "upstream unreachable" instead of reporting one failure for both.
     */
    fun isPrepared(context: Context): Boolean = prepare(context) == null
  }
}
